use std::sync::Arc;
use std::path::PathBuf;

use russh_sftp::protocol::OpenFlags;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::ssh::manager::SshManager;

use super::{
    format_permissions, SftpEntry, SftpEntryType, SftpError, SftpManager, SftpSessionWrapper,
    TransferDirection, TransferInfo, TransferProgress, TransferStatus,
};
use super::transfer_manager::TransferManager;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Create a directory and all missing parents (like `mkdir -p`).
async fn mkdir_p(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), SftpError> {
    // Split into segments and create each level
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut current = String::new();

    for seg in segments {
        current = format!("{current}/{seg}");
        // Try to create — ignore "already exists" errors
        match sftp.create_dir(&current).await {
            Ok(()) => {}
            Err(_) => {
                // Check if it already exists as a directory — if so, continue
                match sftp.metadata(&current).await {
                    Ok(attrs) if attrs.file_type() == russh_sftp::protocol::FileType::Dir => {}
                    _ => {
                        return Err(SftpError::RemoteIoError(format!(
                            "failed to create directory: {current}"
                        )));
                    }
                }
            }
        }
    }

    Ok(())
}

/// Recursively delete a directory and all its contents.
async fn delete_dir_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), SftpError> {
    // List all entries in the directory
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if path == "/" {
            format!("/{name}")
        } else {
            format!("{path}/{name}")
        };

        let attrs = entry.metadata();
        if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
            // Recurse into subdirectory
            Box::pin(delete_dir_recursive(sftp, &full_path)).await?;
        } else {
            // Delete file
            sftp.remove_file(&full_path)
                .await
                .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        }
    }

    // Now the directory should be empty — remove it
    sftp.remove_dir(path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))
}

// ─── Open / Close ────────────────────────────────────────────────────────────

/// Open an SFTP subsystem channel on an existing SSH connection.
/// Returns a new `sftp_session_id` that identifies this SFTP session.
#[tauri::command]
#[instrument(skip(ssh_manager, sftp_manager), fields(ssh_session_id = %session_id))]
pub async fn sftp_open(
    session_id: String,
    ssh_manager: State<'_, SshManager>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<String, SftpError> {
    // 1. Obtain the shared Handle from the live SSH session.
    let handle_arc = ssh_manager
        .get_handle(&session_id)
        .map_err(|e| SftpError::SshSessionNotFound(e.to_string()))?;

    // 2. Lock only long enough to open the channel, then release immediately.
    let channel = {
        let handle = handle_arc.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?
    };

    // 3. Request the SFTP subsystem on that channel.
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SftpError::ChannelError(e.to_string()))?;

    // 4. Hand the channel's byte-stream to the russh-sftp client.
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SftpError::ProtocolError(e.to_string()))?;

    // 5. Store and return a fresh ID.
    let sftp_id = uuid::Uuid::new_v4().to_string();
    sftp_manager.insert_session(
        sftp_id.clone(),
        SftpSessionWrapper {
            sftp: Arc::new(tokio::sync::Mutex::new(sftp)),
            ssh_session_id: session_id,
        },
    );

    tracing::info!(sftp_session_id = %sftp_id, "SFTP session opened");
    crate::telemetry::capture("sftp_opened", serde_json::json!({}));
    Ok(sftp_id)
}

/// Close and remove an SFTP session.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_close(
    sftp_session_id: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    // Grab the Arc before removing from the map.
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    sftp_manager.remove_session(&sftp_session_id);

    // Best-effort close — ignore errors (server may have already terminated).
    let sftp = sftp_arc.lock().await;
    let _ = sftp.close().await;

    tracing::info!(sftp_session_id = %sftp_session_id, "SFTP session closed");
    crate::telemetry::capture("sftp_closed", serde_json::json!({}));
    Ok(())
}

// ─── Directory operations ─────────────────────────────────────────────────────

/// List the contents of a remote directory.
/// Returns entries sorted: directories first, then files, alphabetically
/// within each group.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path))]
pub async fn sftp_list_dir(
    sftp_session_id: String,
    path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<Vec<SftpEntry>, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let read_dir = sftp
        .read_dir(&path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    // ReadDir already skips "." and ".." entries internally.
    let mut result: Vec<SftpEntry> = read_dir
        .map(|entry| {
            let name = entry.file_name();
            let full_path = if path == "/" {
                format!("/{name}")
            } else {
                format!("{path}/{name}")
            };

            let attrs = entry.metadata();

            let file_type = attrs.file_type();
            let entry_type = match file_type {
                russh_sftp::protocol::FileType::Dir => SftpEntryType::Directory,
                russh_sftp::protocol::FileType::Symlink => SftpEntryType::Symlink,
                russh_sftp::protocol::FileType::File => SftpEntryType::File,
                russh_sftp::protocol::FileType::Other => SftpEntryType::Other,
            };

            // Use only the lower 12 bits (permission + setuid/setgid/sticky).
            let permissions = attrs.permissions.unwrap_or(0) & 0o7777;
            // mtime is Option<u32> in FileAttributes; widen to u64 for the frontend.
            let modified = attrs.mtime.map(|t| t as u64);
            let is_symlink = entry_type == SftpEntryType::Symlink;

            SftpEntry {
                name,
                path: full_path,
                entry_type,
                size: attrs.size.unwrap_or(0),
                permissions,
                permissions_display: format_permissions(permissions),
                modified,
                is_symlink,
            }
        })
        .collect();

    // Directories first, then alphabetical within each group (case-insensitive).
    result.sort_by(|a, b| {
        let a_dir = a.entry_type == SftpEntryType::Directory;
        let b_dir = b.entry_type == SftpEntryType::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Resolve the remote home directory by canonicalising `.`.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_home_dir(
    sftp_session_id: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<String, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    sftp.canonicalize(".")
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))
}

/// Create a remote directory, including any intermediate directories (mkdir -p).
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path))]
pub async fn sftp_mkdir(
    sftp_session_id: String,
    path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let result = mkdir_p(&sftp, &path).await;
    if result.is_ok() {
        crate::telemetry::capture("sftp_dir_created", serde_json::json!({}));
    }
    result
}

/// Create an empty remote file (touch).
/// If the path contains intermediate directories, they are created automatically.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path))]
pub async fn sftp_create_file(
    sftp_session_id: String,
    path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;

    // Ensure parent directories exist (mkdir -p)
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let parent_str = parent.to_string_lossy();
        if parent_str != "/" && !parent_str.is_empty() {
            mkdir_p(&sftp, &parent_str).await?;
        }
    }

    // Create the file
    let file = sftp
        .open_with_flags(&path, OpenFlags::CREATE | OpenFlags::WRITE)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    drop(file);
    crate::telemetry::capture("sftp_file_created", serde_json::json!({}));
    Ok(())
}

/// Delete a remote file or directory (recursive for non-empty dirs).
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path))]
pub async fn sftp_delete(
    sftp_session_id: String,
    path: String,
    is_dir: bool,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let result = if is_dir {
        delete_dir_recursive(&sftp, &path).await
    } else {
        sftp.remove_file(&path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))
    };
    if result.is_ok() {
        crate::telemetry::capture("sftp_entry_deleted", serde_json::json!({ "is_dir": is_dir }));
    }
    result
}

/// Rename (or move) a remote path.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_rename(
    sftp_session_id: String,
    old_path: String,
    new_path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let result = sftp.rename(&old_path, &new_path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()));
    if result.is_ok() {
        crate::telemetry::capture("sftp_entry_renamed", serde_json::json!({}));
    }
    result
}

// ─── Transfers ───────────────────────────────────────────────────────────────

/// Download a remote file to a local path.
///
/// Spawns a tokio task immediately and returns a `transfer_id` so the caller
/// can track progress via `sftp:progress` events or cancel via
/// `sftp_cancel_transfer`.
#[tauri::command]
#[instrument(skip(sftp_manager, app_handle), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_download(
    sftp_session_id: String,
    remote_path: String,
    local_path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
    app_handle: AppHandle,
) -> Result<String, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();

    // Clone the Arc<SftpManager> — this is 'static and safe to move into the task.
    let manager = Arc::clone(&sftp_manager);
    manager.insert_transfer(transfer_id.clone(), token.clone());

    let tid = transfer_id.clone();
    let sid = sftp_session_id.clone();
    let remote = remote_path.clone();
    let local = local_path.clone();

    tokio::spawn(async move {
        let file_name = std::path::Path::new(&remote)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| remote.clone());

        let result = download_task(
            sftp_arc,
            remote.clone(),
            local.clone(),
            tid.clone(),
            sid.clone(),
            file_name.clone(),
            token.clone(),
            app_handle.clone(),
        )
        .await;

        manager.remove_transfer(&tid);

        let final_status = match result {
            Ok(()) => TransferStatus::Completed,
            Err(SftpError::TransferCancelled) => TransferStatus::Cancelled,
            Err(e) => TransferStatus::Failed(e.to_string()),
        };

        let _ = app_handle.emit(
            "sftp:progress",
            &TransferProgress {
                transfer_id: tid,
                sftp_session_id: sid,
                file_name,
                direction: TransferDirection::Download,
                bytes_transferred: 0,
                total_bytes: 0,
                status: final_status,
            },
        );
    });

    Ok(transfer_id)
}

async fn download_task(
    sftp_arc: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    sftp_session_id: String,
    file_name: String,
    token: CancellationToken,
    app_handle: AppHandle,
) -> Result<(), SftpError> {
    let sftp = sftp_arc.lock().await;

    // Stat first to get the file size for progress reporting.
    let attrs = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    let total_bytes = attrs.size.unwrap_or(0);

    let mut remote_file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    // Release the mutex while doing the actual I/O so other SFTP operations
    // (like listing dirs in a different UI panel) are not blocked.
    drop(sftp);

    let mut local_file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    const CHUNK: usize = 32 * 1024; // 32 KB
    let mut buf = vec![0u8; CHUNK];
    let mut bytes_transferred: u64 = 0;

    loop {
        if token.is_cancelled() {
            // Clean up the partially-written local file.
            let _ = tokio::fs::remove_file(&local_path).await;
            return Err(SftpError::TransferCancelled);
        }

        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        if n == 0 {
            break;
        }

        local_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

        bytes_transferred += n as u64;

        let _ = app_handle.emit(
            "sftp:progress",
            &TransferProgress {
                transfer_id: transfer_id.clone(),
                sftp_session_id: sftp_session_id.clone(),
                file_name: file_name.clone(),
                direction: TransferDirection::Download,
                bytes_transferred,
                total_bytes,
                status: TransferStatus::InProgress,
            },
        );
    }

    // Flush local file to disk.
    local_file
        .flush()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    // Properly close the remote file handle (shutdown sends SSH_FXP_CLOSE).
    remote_file
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    Ok(())
}

/// Upload a local file to a remote path.
///
/// Spawns a tokio task immediately and returns a `transfer_id`.
#[tauri::command]
#[instrument(skip(sftp_manager, app_handle), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_upload(
    sftp_session_id: String,
    local_path: String,
    remote_path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
    app_handle: AppHandle,
) -> Result<String, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();

    let manager = Arc::clone(&sftp_manager);
    manager.insert_transfer(transfer_id.clone(), token.clone());

    let tid = transfer_id.clone();
    let sid = sftp_session_id.clone();
    let remote = remote_path.clone();
    let local = local_path.clone();

    tokio::spawn(async move {
        let file_name = std::path::Path::new(&local)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| local.clone());

        let result = upload_task(
            sftp_arc,
            local.clone(),
            remote.clone(),
            tid.clone(),
            sid.clone(),
            file_name.clone(),
            token.clone(),
            app_handle.clone(),
        )
        .await;

        manager.remove_transfer(&tid);

        let final_status = match result {
            Ok(()) => TransferStatus::Completed,
            Err(SftpError::TransferCancelled) => TransferStatus::Cancelled,
            Err(e) => TransferStatus::Failed(e.to_string()),
        };

        let _ = app_handle.emit(
            "sftp:progress",
            &TransferProgress {
                transfer_id: tid,
                sftp_session_id: sid,
                file_name,
                direction: TransferDirection::Upload,
                bytes_transferred: 0,
                total_bytes: 0,
                status: final_status,
            },
        );
    });

    Ok(transfer_id)
}

async fn upload_task(
    sftp_arc: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    sftp_session_id: String,
    file_name: String,
    token: CancellationToken,
    app_handle: AppHandle,
) -> Result<(), SftpError> {
    let local_meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    let total_bytes = local_meta.len();

    let mut local_file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    let sftp = sftp_arc.lock().await;
    let mut remote_file = sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    // Release the SFTP session lock before doing I/O.
    drop(sftp);

    const CHUNK: usize = 32 * 1024; // 32 KB
    let mut buf = vec![0u8; CHUNK];
    let mut bytes_transferred: u64 = 0;

    loop {
        if token.is_cancelled() {
            // Attempt to remove the partial remote file.
            let sftp = sftp_arc.lock().await;
            let _ = sftp.remove_file(&remote_path).await;
            return Err(SftpError::TransferCancelled);
        }

        let n = local_file
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        if n == 0 {
            break;
        }

        remote_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

        bytes_transferred += n as u64;

        let _ = app_handle.emit(
            "sftp:progress",
            &TransferProgress {
                transfer_id: transfer_id.clone(),
                sftp_session_id: sftp_session_id.clone(),
                file_name: file_name.clone(),
                direction: TransferDirection::Upload,
                bytes_transferred,
                total_bytes,
                status: TransferStatus::InProgress,
            },
        );
    }

    // Flush and close the remote file.
    remote_file
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    Ok(())
}

/// Cancel an in-flight or queued transfer by its `transfer_id`.
///
/// Routes through `TransferManager` first (queue-based transfers), then falls
/// back to the legacy `SftpManager` token for the old sftp_upload / sftp_download
/// commands so backward compatibility is preserved.
#[tauri::command]
#[instrument(skip(sftp_manager, transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn sftp_cancel_transfer(
    transfer_id: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<(), SftpError> {
    // Try the new queue-based manager first.
    if transfer_manager.cancel(&transfer_id).is_ok() {
        return Ok(());
    }
    // Fall back to the legacy token map for sftp_upload / sftp_download.
    sftp_manager.cancel_transfer(&transfer_id)
}

/// Download a remote file to a temp directory, open it in VS Code,
/// watch for saves, and re-upload each time the file is saved.
#[tauri::command]
#[instrument(skip(sftp_manager, app_handle), fields(sftp_session_id = %sftp_session_id, remote_path = %remote_path))]
pub async fn sftp_edit_in_vscode(
    sftp_session_id: String,
    remote_path: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
    app_handle: AppHandle,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    // Extract filename
    let file_name = std::path::Path::new(&remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    // Create temp directory
    let temp_dir = std::env::temp_dir().join("anyscp-edit");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    let local_path = temp_dir.join(&file_name);

    // 1. Download the file
    {
        let sftp = sftp_arc.lock().await;
        let mut remote_file = sftp
            .open(&remote_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

        let mut contents = Vec::new();
        remote_file
            .read_to_end(&mut contents)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

        tokio::fs::write(&local_path, &contents)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    }

    // 2. Open in VS Code (without --wait so it returns immediately)
    tokio::process::Command::new("code")
        .arg(&local_path)
        .spawn()
        .map_err(|e| SftpError::LocalIoError(format!("Failed to open VS Code: {e}. Is 'code' in your PATH?")))?;

    crate::telemetry::capture("edit_in_vscode", serde_json::json!({ "source": "sftp" }));

    // 3. Watch for file saves and re-upload on each save
    let sftp_arc_bg = sftp_arc.clone();
    let remote_path_bg = remote_path.clone();
    let local_path_bg = local_path.clone();
    let app_handle_bg = app_handle.clone();
    let sftp_sid = sftp_session_id.clone();

    tokio::task::spawn_blocking(move || {
        use notify::{Watcher, RecursiveMode, EventKind, Event, Config};
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Event>();

        let mut watcher = notify::RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        ).expect("Failed to create file watcher");

        watcher
            .watch(&local_path_bg, RecursiveMode::NonRecursive)
            .expect("Failed to watch file");

        tracing::info!(
            local_path = %local_path_bg.display(),
            remote_path = %remote_path_bg,
            "Watching for saves..."
        );

        // Watch for 30 minutes max, then stop
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);

        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(event) => {
                    // Only re-upload on actual write/modify events
                    let is_write = matches!(
                        event.kind,
                        EventKind::Modify(notify::event::ModifyKind::Data(_))
                        | EventKind::Modify(notify::event::ModifyKind::Any)
                    );

                    if !is_write {
                        continue;
                    }

                    // Small debounce — editors may write multiple times
                    std::thread::sleep(std::time::Duration::from_millis(300));

                    // Read and re-upload
                    match std::fs::read(&local_path_bg) {
                        Ok(contents) => {
                            let sftp_arc = sftp_arc_bg.clone();
                            let remote_path = remote_path_bg.clone();
                            let app_handle = app_handle_bg.clone();
                            let sid = sftp_sid.clone();

                            // Use a blocking runtime handle to run async upload
                            let rt = tokio::runtime::Handle::current();
                            rt.spawn(async move {
                                let sftp = sftp_arc.lock().await;
                                let result = async {
                                    let mut remote_file = sftp
                                        .open_with_flags(
                                            &remote_path,
                                            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
                                        )
                                        .await?;
                                    remote_file.write_all(&contents).await?;
                                    remote_file.flush().await?;
                                    Ok::<(), russh_sftp::client::error::Error>(())
                                }
                                .await;

                                match result {
                                    Ok(()) => {
                                        tracing::info!(
                                            remote_path = %remote_path,
                                            "File re-uploaded on save"
                                        );
                                        let _ = app_handle.emit("sftp:file-edited", &sid);
                                    }
                                    Err(e) => {
                                        tracing::error!(
                                            error = %e,
                                            "Failed to re-upload on save"
                                        );
                                    }
                                }
                            });
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "Failed to read local file on save");
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Check if past deadline
                    if std::time::Instant::now() > deadline {
                        tracing::info!("File watcher expired after 30 minutes");
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        // Cleanup
        let _ = std::fs::remove_file(&local_path_bg);
    });

    Ok(())
}

// ─── Copy / Move ────────────────────────────────────────────────────────────

/// Find a unique name in `target_dir` for `name`. If `target_dir/name` already
/// exists, appends ` (1)`, ` (2)`, etc. until a free slot is found.
async fn deduplicate_name(
    sftp: &russh_sftp::client::SftpSession,
    target_dir: &str,
    name: &str,
) -> String {
    let base_path = if target_dir == "/" {
        format!("/{name}")
    } else {
        format!("{target_dir}/{name}")
    };

    // Fast path: name is free
    if sftp.metadata(&base_path).await.is_err() {
        return name.to_string();
    }

    // Split name into stem + extension for files (e.g. "photo.jpg" → "photo", ".jpg")
    let (stem, ext) = if let Some(dot_pos) = name.rfind('.') {
        if dot_pos > 0 {
            (&name[..dot_pos], &name[dot_pos..])
        } else {
            (name, "")
        }
    } else {
        (name, "")
    };

    for i in 1u32..1000 {
        let candidate = format!("{stem} ({i}){ext}");
        let candidate_path = if target_dir == "/" {
            format!("/{candidate}")
        } else {
            format!("{target_dir}/{candidate}")
        };
        if sftp.metadata(&candidate_path).await.is_err() {
            return candidate;
        }
    }

    // Fallback — extremely unlikely
    format!("{stem} (copy){ext}")
}

/// Copy a single remote file from `src` to `dst` by streaming through memory.
async fn copy_file_remote(
    sftp: &russh_sftp::client::SftpSession,
    src: &str,
    dst: &str,
) -> Result<(), SftpError> {
    let mut reader = sftp
        .open(src)
        .await
        .map_err(|e| SftpError::RemoteIoError(format!("Cannot open {src}: {e}")))?;

    let mut writer = sftp
        .open_with_flags(dst, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .map_err(|e| SftpError::RemoteIoError(format!("Cannot create {dst}: {e}")))?;

    const CHUNK: usize = 32 * 1024;
    let mut buf = vec![0u8; CHUNK];

    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    }

    writer
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    Ok(())
}

/// Recursively copy a remote directory from `src_dir` to `dst_dir`.
async fn copy_dir_remote(
    sftp: &russh_sftp::client::SftpSession,
    src_dir: &str,
    dst_dir: &str,
) -> Result<(), SftpError> {
    mkdir_p(sftp, dst_dir).await?;

    let entries = sftp
        .read_dir(src_dir)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let src_child = if src_dir == "/" {
            format!("/{name}")
        } else {
            format!("{src_dir}/{name}")
        };
        let dst_child = if dst_dir == "/" {
            format!("/{name}")
        } else {
            format!("{dst_dir}/{name}")
        };

        let attrs = entry.metadata();
        if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
            Box::pin(copy_dir_remote(sftp, &src_child, &dst_child)).await?;
        } else {
            copy_file_remote(sftp, &src_child, &dst_child).await?;
        }
    }

    Ok(())
}

/// Move one or more remote entries to a target directory via rename.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_move_entries(
    sftp_session_id: String,
    source_paths: Vec<String>,
    target_dir: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<Vec<String>, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let mut new_paths = Vec::with_capacity(source_paths.len());

    for source in &source_paths {
        let name = std::path::Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Prevent moving a directory into itself
        let _target_check = if target_dir == "/" {
            format!("/{name}")
        } else {
            format!("{target_dir}/{name}")
        };
        if target_dir.starts_with(source) && source.contains('/') {
            return Err(SftpError::RemoteIoError(format!(
                "Cannot move {source} into itself"
            )));
        }

        let deduped = deduplicate_name(&sftp, &target_dir, &name).await;
        let dest = if target_dir == "/" {
            format!("/{deduped}")
        } else {
            format!("{target_dir}/{deduped}")
        };

        sftp.rename(source, &dest)
            .await
            .map_err(|e| SftpError::RemoteIoError(format!("Move failed: {e}")))?;

        new_paths.push(dest);
    }

    crate::telemetry::capture("sftp_entries_moved", serde_json::json!({ "count": source_paths.len() }));
    Ok(new_paths)
}

/// Copy one or more remote entries to a target directory (read + write).
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_copy_entries(
    sftp_session_id: String,
    source_paths: Vec<String>,
    target_dir: String,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<Vec<String>, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    let mut new_paths = Vec::with_capacity(source_paths.len());

    for source in &source_paths {
        let name = std::path::Path::new(source)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let deduped = deduplicate_name(&sftp, &target_dir, &name).await;
        let dest = if target_dir == "/" {
            format!("/{deduped}")
        } else {
            format!("{target_dir}/{deduped}")
        };

        let attrs = sftp
            .metadata(source)
            .await
            .map_err(|e| SftpError::RemoteIoError(format!("Cannot stat {source}: {e}")))?;

        if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
            copy_dir_remote(&sftp, source, &dest).await?;
        } else {
            copy_file_remote(&sftp, source, &dest).await?;
        }

        new_paths.push(dest);
    }

    crate::telemetry::capture("sftp_entries_copied", serde_json::json!({ "count": source_paths.len() }));
    Ok(new_paths)
}

// ─── Transfer Manager commands ───────────────────────────────────────────────

/// Enqueue one or more local paths for upload to a remote directory.
///
/// Returns a list of `transfer_id`s (one per path). Progress is reported via
/// `sftp:transfer` events. Transfers are executed with a concurrency limit of
/// three by default (configurable via `sftp_set_concurrency`).
#[tauri::command]
#[instrument(skip(transfer_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_enqueue_upload(
    sftp_session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<Vec<String>, SftpError> {
    let file_count = local_paths.len();
    let paths: Vec<PathBuf> = local_paths.into_iter().map(PathBuf::from).collect();
    let result = transfer_manager
        .enqueue_upload(sftp_session_id, paths, remote_dir)
        .await;
    if result.is_ok() {
        crate::telemetry::capture("sftp_upload_enqueued", serde_json::json!({ "file_count": file_count }));
    }
    result
}

/// Enqueue one or more remote paths for download to a local directory.
///
/// Returns a list of `transfer_id`s. Progress via `sftp:transfer` events.
#[tauri::command]
#[instrument(skip(transfer_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_enqueue_download(
    sftp_session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<Vec<String>, SftpError> {
    let file_count = remote_paths.len();
    let result = transfer_manager
        .enqueue_download(sftp_session_id, remote_paths, PathBuf::from(local_dir))
        .await;
    if result.is_ok() {
        crate::telemetry::capture("sftp_download_enqueued", serde_json::json!({ "file_count": file_count }));
    }
    result
}

/// Re-queue a failed or cancelled transfer, resetting its progress counters.
#[tauri::command]
#[instrument(skip(transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn sftp_retry_transfer(
    transfer_id: String,
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<String, SftpError> {
    transfer_manager.retry(&transfer_id)?;
    Ok(transfer_id)
}

/// Return a snapshot of all known transfers (queued, in-progress, and finished).
#[tauri::command]
#[instrument(skip(transfer_manager))]
pub async fn sftp_list_transfers(
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<Vec<TransferInfo>, SftpError> {
    Ok(transfer_manager.list_all())
}

/// Remove all completed, failed, and cancelled transfers from the registry.
#[tauri::command]
#[instrument(skip(transfer_manager))]
pub async fn sftp_clear_finished_transfers(
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<(), SftpError> {
    transfer_manager.clear_finished();
    Ok(())
}

/// Adjust the maximum number of transfers that run concurrently.
///
/// Increasing the limit takes effect immediately for queued jobs. Decreasing
/// it applies to future acquisitions; in-flight transfers are not interrupted.
#[tauri::command]
#[instrument(skip(transfer_manager), fields(max_concurrent = max_concurrent))]
pub async fn sftp_set_concurrency(
    max_concurrent: u32,
    transfer_manager: State<'_, Arc<TransferManager>>,
) -> Result<(), SftpError> {
    if max_concurrent == 0 {
        return Err(SftpError::ProtocolError(
            "max_concurrent must be at least 1".to_string(),
        ));
    }
    transfer_manager.set_max_concurrent(max_concurrent);
    Ok(())
}
