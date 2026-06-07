//! Tauri commands exposed to the frontend. These mirror the SFTP command
//! surface 1:1 (same arguments, same return shapes) so the Explorer UI can
//! dispatch to either backend purely on the tab's transport kind.
//!
//! SCP has no native filesystem operations, so listing / mkdir / delete /
//! rename / copy / move are implemented by exec'ing POSIX commands on the
//! same SSH connection (see [`super::exec`]); transfers use the SCP wire
//! protocol (see [`super::transfer`]).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::ssh::manager::SshManager;

use super::transfer_manager::ScpTransferManager;
use super::{
    exec, transfer, ScpEntry, ScpError, ScpManager, ScpSessionWrapper, TransferDirection,
    TransferInfo, TransferProgress, TransferStatus,
};

// ─── Open / Close ────────────────────────────────────────────────────────────

/// Register an "SCP session" over an existing SSH connection.
///
/// Unlike SFTP there is no subsystem to negotiate — SCP just exec's `scp`
/// on demand — so this only validates that the SSH session exists and that
/// the remote has a working `scp` binary, then stores a handle reference.
///
/// Returns a fresh `scp_session_id`.
#[tauri::command]
#[instrument(skip(ssh_manager, scp_manager), fields(ssh_session_id = %session_id))]
pub async fn scp_open(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<String, ScpError> {
    let handle = ssh_manager
        .get_handle(&session_id)
        .map_err(|e| ScpError::SshSessionNotFound(e.to_string()))?;

    // Probe for a usable scp binary up front so we fail fast with a clear
    // message rather than on the first transfer.
    let probe = exec::ssh_exec(handle.clone(), "command -v scp >/dev/null 2>&1; echo $?").await?;
    let code = String::from_utf8_lossy(&probe.0);
    if code.trim() != "0" {
        return Err(ScpError::RemoteError(
            "remote host has no 'scp' binary on PATH".into(),
        ));
    }

    // Detect the remote userland once so listings use the right command. If the
    // probe itself errors, fall back to the universal `ls`-based Posix path
    // rather than Default (Gnu), which would hard-fail on `find -printf`.
    let flavor = exec::detect_flavor(handle.clone())
        .await
        .unwrap_or(super::listing::Flavor::Posix);

    let scp_id = uuid::Uuid::new_v4().to_string();
    scp_manager.insert_session(
        scp_id.clone(),
        ScpSessionWrapper {
            ssh_session_id: session_id,
            ssh_handle: handle,
            flavor,
        },
    );

    tracing::info!(scp_session_id = %scp_id, flavor = %flavor.as_str(), "SCP session opened");
    crate::telemetry::capture(
        "scp_opened",
        serde_json::json!({ "flavor": flavor.as_str() }),
    );
    Ok(scp_id)
}

/// Forget an SCP session. (No remote teardown — SCP is connectionless on top
/// of the shared SSH session, which is closed separately.)
#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_close(
    scp_session_id: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<(), ScpError> {
    scp_manager.remove_session(&scp_session_id);
    tracing::info!(scp_session_id = %scp_session_id, "SCP session closed");
    crate::telemetry::capture("scp_closed", serde_json::json!({}));
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SshHandle =
    Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::handler::SshClientHandler>>>;

/// Resolve the SSH handle behind an SCP session id.
fn handle_for(scp_manager: &Arc<ScpManager>, scp_session_id: &str) -> Result<SshHandle, ScpError> {
    let session = scp_manager.get_session(scp_session_id)?;
    Ok(session.ssh_handle.clone())
}

/// Resolve both the SSH handle and the detected userland flavor.
fn handle_and_flavor(
    scp_manager: &Arc<ScpManager>,
    scp_session_id: &str,
) -> Result<(SshHandle, super::listing::Flavor), ScpError> {
    let session = scp_manager.get_session(scp_session_id)?;
    Ok((session.ssh_handle.clone(), session.flavor))
}

// ─── Directory operations ─────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id, path = %path))]
pub async fn scp_list_dir(
    scp_session_id: String,
    path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<Vec<ScpEntry>, ScpError> {
    let (handle, flavor) = handle_and_flavor(&scp_manager, &scp_session_id)?;
    exec::list_dir(handle, flavor, &path).await
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_home_dir(
    scp_session_id: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<String, ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    exec::home_dir(handle).await
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id, path = %path))]
pub async fn scp_mkdir(
    scp_session_id: String,
    path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<(), ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let result = exec::mkdir_p(handle, &path).await;
    if result.is_ok() {
        crate::telemetry::capture("scp_dir_created", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id, path = %path))]
pub async fn scp_create_file(
    scp_session_id: String,
    path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<(), ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let result = exec::touch(handle, &path).await;
    if result.is_ok() {
        crate::telemetry::capture("scp_file_created", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id, path = %path))]
pub async fn scp_delete(
    scp_session_id: String,
    path: String,
    is_dir: bool,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<(), ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let result = exec::remove(handle, &path, is_dir).await;
    if result.is_ok() {
        crate::telemetry::capture("scp_entry_deleted", serde_json::json!({ "is_dir": is_dir }));
    }
    result
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_rename(
    scp_session_id: String,
    old_path: String,
    new_path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<(), ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let result = exec::rename(handle, &old_path, &new_path).await;
    if result.is_ok() {
        crate::telemetry::capture("scp_entry_renamed", serde_json::json!({}));
    }
    result
}

// ─── Copy / Move ──────────────────────────────────────────────────────────────

/// Join a directory and a (deduplicated) entry name.
fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_move_entries(
    scp_session_id: String,
    source_paths: Vec<String>,
    target_dir: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<Vec<String>, ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let mut new_paths = Vec::with_capacity(source_paths.len());

    for source in &source_paths {
        let name = std::path::Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Prevent moving a directory into itself.
        if target_dir.starts_with(source.as_str()) && source.contains('/') {
            return Err(ScpError::RemoteIoError(format!(
                "Cannot move {source} into itself"
            )));
        }

        let deduped = exec::deduplicate_name(handle.clone(), &target_dir, &name).await?;
        let dest = join_remote(&target_dir, &deduped);
        exec::rename(handle.clone(), source, &dest).await?;
        new_paths.push(dest);
    }

    crate::telemetry::capture(
        "scp_entries_moved",
        serde_json::json!({ "count": source_paths.len() }),
    );
    Ok(new_paths)
}

#[tauri::command]
#[instrument(skip(scp_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_copy_entries(
    scp_session_id: String,
    source_paths: Vec<String>,
    target_dir: String,
    scp_manager: State<'_, Arc<ScpManager>>,
) -> Result<Vec<String>, ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;
    let mut new_paths = Vec::with_capacity(source_paths.len());

    for source in &source_paths {
        let name = std::path::Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let deduped = exec::deduplicate_name(handle.clone(), &target_dir, &name).await?;
        let dest = join_remote(&target_dir, &deduped);
        // `cp -r` handles both files and directories.
        exec::copy(handle.clone(), source, &dest).await?;
        new_paths.push(dest);
    }

    crate::telemetry::capture(
        "scp_entries_copied",
        serde_json::json!({ "count": source_paths.len() }),
    );
    Ok(new_paths)
}

// ─── Direct transfers (legacy single-file, used by edit-in-vscode) ────────────

#[tauri::command]
#[instrument(skip(scp_manager, app_handle), fields(scp_session_id = %scp_session_id))]
pub async fn scp_download(
    scp_session_id: String,
    remote_path: String,
    local_path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
    app_handle: AppHandle,
) -> Result<String, ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    let manager = Arc::clone(&scp_manager);
    manager.insert_transfer(transfer_id.clone(), token.clone());

    let tid = transfer_id.clone();
    let sid = scp_session_id.clone();

    tokio::spawn(async move {
        let file_name = std::path::Path::new(&remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| remote_path.clone());

        let result = transfer::download_file(
            handle,
            &remote_path,
            std::path::Path::new(&local_path),
            &token,
            |_| {},
        )
        .await;

        manager.remove_transfer(&tid);

        let status = match result {
            Ok(()) => TransferStatus::Completed,
            Err(ScpError::TransferCancelled) => TransferStatus::Cancelled,
            Err(e) => TransferStatus::Failed(e.to_string()),
        };
        let _ = app_handle.emit(
            "scp:progress",
            &TransferProgress {
                transfer_id: tid,
                scp_session_id: sid,
                file_name,
                direction: TransferDirection::Download,
                bytes_transferred: 0,
                total_bytes: 0,
                status,
            },
        );
    });

    Ok(transfer_id)
}

#[tauri::command]
#[instrument(skip(scp_manager, app_handle), fields(scp_session_id = %scp_session_id))]
pub async fn scp_upload(
    scp_session_id: String,
    local_path: String,
    remote_path: String,
    scp_manager: State<'_, Arc<ScpManager>>,
    app_handle: AppHandle,
) -> Result<String, ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    let manager = Arc::clone(&scp_manager);
    manager.insert_transfer(transfer_id.clone(), token.clone());

    let tid = transfer_id.clone();
    let sid = scp_session_id.clone();

    tokio::spawn(async move {
        let file_name = std::path::Path::new(&local_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| local_path.clone());

        // Ensure the remote parent dir exists before the sink starts.
        let parent = std::path::Path::new(&remote_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !p.is_empty() && p != "/");
        let result = async {
            if let Some(parent) = parent {
                exec::mkdir_p(handle.clone(), &parent).await?;
            }
            transfer::upload_file(
                handle,
                std::path::Path::new(&local_path),
                &remote_path,
                &token,
                |_| {},
            )
            .await
        }
        .await;

        manager.remove_transfer(&tid);

        let status = match result {
            Ok(()) => TransferStatus::Completed,
            Err(ScpError::TransferCancelled) => TransferStatus::Cancelled,
            Err(e) => TransferStatus::Failed(e.to_string()),
        };
        let _ = app_handle.emit(
            "scp:progress",
            &TransferProgress {
                transfer_id: tid,
                scp_session_id: sid,
                file_name,
                direction: TransferDirection::Upload,
                bytes_transferred: 0,
                total_bytes: 0,
                status,
            },
        );
    });

    Ok(transfer_id)
}

#[tauri::command]
#[instrument(skip(scp_manager, transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn scp_cancel_transfer(
    transfer_id: String,
    scp_manager: State<'_, Arc<ScpManager>>,
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<(), ScpError> {
    if transfer_manager.cancel(&transfer_id).is_ok() {
        return Ok(());
    }
    scp_manager.cancel_transfer(&transfer_id)
}

/// Download a remote file to a temp dir, open it in an external editor, and
/// re-upload on each save. Mirrors `sftp_edit_external` but over SCP.
#[tauri::command]
#[instrument(skip(scp_manager, app_handle, editor), fields(scp_session_id = %scp_session_id, remote_path = %remote_path))]
pub async fn scp_edit_external(
    scp_session_id: String,
    remote_path: String,
    editor: Option<crate::editors::EditorConfig>,
    scp_manager: State<'_, Arc<ScpManager>>,
    app_handle: AppHandle,
) -> Result<(), ScpError> {
    let handle = handle_for(&scp_manager, &scp_session_id)?;

    let file_name = std::path::Path::new(&remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    let temp_dir = std::env::temp_dir().join("anyscp-edit");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
    let local_path = temp_dir.join(&file_name);

    // 1. Download the file.
    let token = CancellationToken::new();
    transfer::download_file(handle.clone(), &remote_path, &local_path, &token, |_| {}).await?;

    // 2. Open in the chosen editor (or an auto-detected one), non-blocking.
    let editor = editor
        .or_else(crate::editors::resolve_default)
        .ok_or_else(|| {
            ScpError::LocalIoError("No editor found. Add one in Settings → Editors.".to_string())
        })?;
    crate::editors::launch(&editor, &local_path).map_err(ScpError::LocalIoError)?;

    crate::telemetry::capture(
        "edit_external",
        serde_json::json!({ "source": "scp", "editor": editor.name }),
    );

    // 3. Watch for saves and re-upload (best-effort, 30-minute window).
    let handle_bg = handle.clone();
    let remote_path_bg = remote_path.clone();
    let local_path_bg = local_path.clone();
    let app_handle_bg = app_handle.clone();
    let sid = scp_session_id.clone();

    tokio::task::spawn_blocking(move || {
        use notify::{Config, Event, EventKind, RecursiveMode, Watcher};
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Event>();
        let mut watcher = notify::RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        )
        .expect("Failed to create file watcher");
        watcher
            .watch(&local_path_bg, RecursiveMode::NonRecursive)
            .expect("Failed to watch file");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);

        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(event) => {
                    let is_write = matches!(
                        event.kind,
                        EventKind::Modify(notify::event::ModifyKind::Data(_))
                            | EventKind::Modify(notify::event::ModifyKind::Any)
                    );
                    if !is_write {
                        continue;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(300));

                    let handle = handle_bg.clone();
                    let remote_path = remote_path_bg.clone();
                    let local_path = local_path_bg.clone();
                    let app_handle = app_handle_bg.clone();
                    let sid = sid.clone();
                    let rt = tokio::runtime::Handle::current();
                    rt.spawn(async move {
                        let token = CancellationToken::new();
                        match transfer::upload_file(handle, &local_path, &remote_path, &token, |_| {})
                            .await
                        {
                            Ok(()) => {
                                tracing::info!(remote_path = %remote_path, "File re-uploaded on save (scp)");
                                let _ = app_handle.emit("scp:file-edited", &sid);
                            }
                            Err(e) => {
                                tracing::error!(error = %e, "Failed to re-upload on save (scp)");
                            }
                        }
                    });
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if std::time::Instant::now() > deadline {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = std::fs::remove_file(&local_path_bg);
    });

    Ok(())
}

// ─── Transfer Manager commands ─────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(transfer_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_enqueue_upload(
    scp_session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<Vec<String>, ScpError> {
    let file_count = local_paths.len();
    let paths: Vec<PathBuf> = local_paths.into_iter().map(PathBuf::from).collect();
    let result = transfer_manager
        .enqueue_upload(scp_session_id, paths, remote_dir)
        .await;
    if result.is_ok() {
        crate::telemetry::capture(
            "scp_upload_enqueued",
            serde_json::json!({ "file_count": file_count }),
        );
    }
    result
}

#[tauri::command]
#[instrument(skip(transfer_manager), fields(scp_session_id = %scp_session_id))]
pub async fn scp_enqueue_download(
    scp_session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<Vec<String>, ScpError> {
    let file_count = remote_paths.len();
    let result = transfer_manager
        .enqueue_download(scp_session_id, remote_paths, PathBuf::from(local_dir))
        .await;
    if result.is_ok() {
        crate::telemetry::capture(
            "scp_download_enqueued",
            serde_json::json!({ "file_count": file_count }),
        );
    }
    result
}

#[tauri::command]
#[instrument(skip(transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn scp_retry_transfer(
    transfer_id: String,
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<String, ScpError> {
    transfer_manager.retry(&transfer_id)?;
    Ok(transfer_id)
}

#[tauri::command]
#[instrument(skip(transfer_manager))]
pub async fn scp_list_transfers(
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<Vec<TransferInfo>, ScpError> {
    Ok(transfer_manager.list_all())
}

#[tauri::command]
#[instrument(skip(transfer_manager))]
pub async fn scp_clear_finished_transfers(
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<(), ScpError> {
    transfer_manager.clear_finished();
    Ok(())
}

#[tauri::command]
#[instrument(skip(transfer_manager), fields(max_concurrent = max_concurrent))]
pub async fn scp_set_concurrency(
    max_concurrent: u32,
    transfer_manager: State<'_, Arc<ScpTransferManager>>,
) -> Result<(), ScpError> {
    if max_concurrent == 0 {
        return Err(ScpError::ProtocolError(
            "max_concurrent must be at least 1".to_string(),
        ));
    }
    transfer_manager.set_max_concurrent(max_concurrent);
    Ok(())
}
