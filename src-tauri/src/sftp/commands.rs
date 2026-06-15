use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use tauri::{AppHandle, Emitter, State, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::ssh::manager::SshManager;

use super::transfer_manager::TransferManager;
use super::{
    format_permissions, validate_remote_name, ChmodSummary, SftpEntry, SftpEntryType, SftpError,
    SftpManager, SftpSessionWrapper, TransferDirection, TransferInfo, TransferProgress,
    TransferStatus,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Create a directory and all missing parents (like `mkdir -p`).
async fn mkdir_p(sftp: &russh_sftp::client::SftpSession, path: &str) -> Result<(), SftpError> {
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
                    Ok(attrs) if attrs.file_type() == FileType::Dir => {}
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
        if attrs.file_type() == FileType::Dir {
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
    use_sudo: Option<bool>,
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

    // 3. Request the SFTP subsystem, or (sudo) preflight + exec sudo sftp-server.
    if use_sudo.unwrap_or(false) {
        // Preflight on a throwaway channel: confirm the user actually has
        // *passwordless* sudo before committing the SFTP channel. Without this,
        // a host that prompts for a password leaves the SFTP init blocked until
        // the timeout — russh-sftp does not cancel the pending init when the
        // channel hits EOF — so we'd hang ~30 s instead of failing cleanly.
        // `sudo -n true` exits non-zero immediately when a password is required.
        let mut check = {
            let handle = handle_arc.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| SftpError::ChannelError(e.to_string()))?
        };
        check
            .exec(true, "sudo -n true")
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;
        // Read until the channel closes. NB: the server often sends `Eof`
        // BEFORE the `exit-status` request, so we must NOT break on `Eof` or
        // we'd miss the status and treat a passwordless host as a failure.
        let mut sudo_exit = None;
        while let Some(msg) = check.wait().await {
            match msg {
                russh::ChannelMsg::ExitStatus { exit_status } => sudo_exit = Some(exit_status),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        if sudo_exit != Some(0) {
            return Err(SftpError::PermissionDenied(
                "passwordless sudo is required to browse as root, but it is not configured \
                 for this user"
                    .to_string(),
            ));
        }

        // Passwordless sudo confirmed — exec sudo sftp-server on the real
        // channel. `-n` keeps it non-interactive; the shell loop probes
        // sftp-server on $PATH first (portable `command -v`, not the non-POSIX
        // `which`) then the known per-distro install paths, so this works on
        // Debian/Ubuntu, RHEL/Fedora, Alpine and Arch.
        channel
            .exec(
                true,
                "sudo -n /bin/sh -c 'for p in \"$(command -v sftp-server 2>/dev/null)\" \
                 /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server \
                 /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do \
                 [ -x \"$p\" ] && exec \"$p\"; done; \
                 echo \"sftp-server: not found\" >&2; exit 127'",
            )
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;
    } else {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;
    }

    // 4. Hand the channel's byte-stream to the russh-sftp client (10 s default
    //    init timeout). Do NOT raise this: russh's request_subsystem above
    //    returns *before* the server's accept/reject reply, so on a host
    //    without the SFTP subsystem (e.g. SCP-only) this init is what fails —
    //    a longer timeout just delays the frontend's SFTP→SCP fallback by that
    //    much (a 30 s value broke the SCP-fallback e2e specs).
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

    let sudo = use_sudo.unwrap_or(false);
    tracing::info!(sftp_session_id = %sftp_id, sudo, "SFTP session opened");
    crate::telemetry::capture("sftp_opened", serde_json::json!({ "sudo": sudo }));
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
                FileType::Dir => SftpEntryType::Directory,
                FileType::Symlink => SftpEntryType::Symlink,
                FileType::File => SftpEntryType::File,
                FileType::Other => SftpEntryType::Other,
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
        crate::telemetry::capture(
            "sftp_entry_deleted",
            serde_json::json!({ "is_dir": is_dir }),
        );
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
    let result = sftp
        .rename(&old_path, &new_path)
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()));
    if result.is_ok() {
        crate::telemetry::capture("sftp_entry_renamed", serde_json::json!({}));
    }
    result
}

/// Change the Unix permission bits (chmod) of a remote path via SFTP `setstat`.
///
/// `mode` is the octal permission value as a plain number (e.g. `0o755` = 493).
/// Only the lower 12 bits (permission + setuid/setgid/sticky) are applied; the
/// file-type bits are masked off so the server preserves the entry's type.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path, mode = mode))]
pub async fn sftp_chmod(
    sftp_session_id: String,
    path: String,
    mode: u32,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<(), SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let sftp = sftp_arc.lock().await;
    match apply_chmod_one(&sftp, &path, mode & 0o7777).await {
        Ok(clean) => {
            crate::telemetry::capture(
                "sftp_chmod",
                serde_json::json!({ "false_positive": !clean }),
            );
            Ok(())
        }
        Err(msg) => Err(SftpError::RemoteIoError(msg)),
    }
}

/// Build the `setstat` attributes for a chmod: ONLY the permission bits are
/// set, every other field stays `None`.
///
/// This must NOT use `FileAttributes::default()`: that returns
/// `size: Some(0), uid: Some(0), gid: Some(0), atime: Some(0), mtime: Some(0)`,
/// which the serializer turns into a SETSTAT that asks the server to truncate
/// the file to zero bytes, chown it to root, and reset its timestamps on *every*
/// chmod. `FileAttributes::empty()` leaves all fields `None` so only the
/// permission flag is sent.
fn chmod_attrs(requested: u32) -> FileAttributes {
    FileAttributes {
        permissions: Some(requested),
        ..FileAttributes::empty()
    }
}

/// Whether a post-failure `stat` confirms the chmod actually took effect.
///
/// Some servers apply the chmod but still reply with SSH_FX_FAILURE /
/// SSH_FX_PERMISSION_DENIED. We only trust that as a false positive when the
/// server actually reported the permissions back and they match — if
/// `permissions` is absent we can't confirm anything, so the original error
/// stands (otherwise a chmod-to-`000` would spuriously "match" a missing field).
fn perms_match(current: &FileAttributes, requested: u32) -> bool {
    current.permissions.map(|p| p & 0o7777) == Some(requested)
}

/// Apply `requested` permission bits (already masked to `0o7777`) to a single
/// path via `setstat`.
///
/// Returns `Ok(true)` when the server acknowledged the change, `Ok(false)` when
/// it replied with an error that a follow-up `stat` proved to be a false
/// positive (a known quirk where the server applies the chmod but still returns
/// SSH_FX_PERMISSION_DENIED / SSH_FX_FAILURE), and `Err(message)` for a genuine
/// failure. Both `Ok` variants mean the file now holds the requested mode, so
/// callers must count them equally. The error message is prefixed with the path
/// for recursive summaries.
async fn apply_chmod_one(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    requested: u32,
) -> Result<bool, String> {
    match sftp.set_metadata(path, chmod_attrs(requested)).await {
        Ok(_) => Ok(true),
        Err(e) => match sftp.metadata(path).await {
            Ok(current) if perms_match(&current, requested) => {
                tracing::warn!(
                    error = %e,
                    path = %path,
                    "setstat returned an error but permissions match the request; \
                     treating as success"
                );
                Ok(false)
            }
            _ => Err(format!("{path}: {e}")),
        },
    }
}

/// Recursively chmod a directory and all of its contents.
///
/// Walks the tree iteratively with an explicit stack (no async recursion) so
/// deep hierarchies can't overflow the stack. The walk runs in two phases:
///
///  1. **Enumerate** every target (root + descendants) while the directory
///     execute bits are still intact, so `read_dir` always succeeds. Symlinks
///     are skipped — neither chmod'd nor descended into — to avoid following
///     them out of the subtree or changing their targets.
///  2. **Apply** the new mode children-before-parents (reverse discovery
///     order). Because the whole tree is already known, removing the execute
///     bit from a directory here can no longer make its descendants
///     unreachable.
///
/// The session mutex is acquired *per operation* (each `read_dir`, each
/// `set_metadata`) rather than held for the whole walk, so concurrent SFTP
/// commands on the same session aren't starved. Per-entry failures are
/// collected into the returned [`ChmodSummary`] instead of aborting, and the
/// per-file false-positive handling from [`apply_chmod_one`] applies throughout.
#[tauri::command]
#[instrument(skip(sftp_manager), fields(sftp_session_id = %sftp_session_id, path = %path, mode = mode))]
pub async fn sftp_chmod_recursive(
    sftp_session_id: String,
    path: String,
    mode: u32,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<ChmodSummary, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let requested = mode & 0o7777;
    let mut errors: Vec<String> = Vec::new();

    // ── Phase 1: enumerate the tree (perms still intact, so read_dir works) ──
    // Discovery is pre-order (a parent is recorded before its children); the
    // apply phase walks this list in reverse for a post-order effect.
    let mut targets: Vec<String> = vec![path.clone()];
    let mut stack: Vec<String> = vec![path.clone()];
    while let Some(dir) = stack.pop() {
        let listing = {
            let sftp = sftp_arc.lock().await;
            sftp.read_dir(&dir).await
        };
        let entries = match listing {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("{dir}: {e}"));
                continue;
            }
        };

        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };

            let file_type = entry.metadata().file_type();
            if file_type == FileType::Symlink {
                continue; // never chmod or descend into symlinks
            }

            targets.push(full.clone());
            if file_type == FileType::Dir {
                stack.push(full);
            }
        }
    }

    // ── Phase 2: apply children-before-parents (reverse discovery order) ──
    let mut applied: u32 = 0;
    for target in targets.iter().rev() {
        let outcome = {
            let sftp = sftp_arc.lock().await;
            apply_chmod_one(&sftp, target, requested).await
        };
        match outcome {
            // Both Ok variants mean the file now holds the requested mode — a
            // clean ack (`true`) or a false-positive the follow-up stat
            // confirmed (`false`). Count both, matching the single-file
            // `sftp_chmod` which also treats `Ok(false)` as success; counting
            // only `Ok(true)` would report 0 applied on servers that always
            // reply with an error but apply the change anyway.
            Ok(_) => applied += 1,
            Err(msg) => errors.push(msg),
        }
    }

    crate::telemetry::capture(
        "sftp_chmod_recursive",
        serde_json::json!({ "applied": applied, "errors": errors.len() }),
    );
    Ok(ChmodSummary { applied, errors })
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

/// Preview image handed to the OS drag session. Embedded so we don't depend on
/// a resolvable bundle-resource path at runtime, and handed to the drag API as
/// raw bytes so it never needs to live in the staging directory (where a remote
/// file of the same name could clobber it).
static DRAG_ICON_PNG: &[u8] = include_bytes!("../../icons/32x32.png");

// Hard caps on a single drag-out so a hostile server (e.g. a top-level symlink
// pointing at `/`) cannot coerce the client into mirroring an unbounded tree
// into local temp.
const MAX_DRAGOUT_BYTES: u64 = 8 * 1024 * 1024 * 1024; // 8 GiB total
const MAX_DRAGOUT_ENTRIES: usize = 50_000;
const MAX_DRAGOUT_DEPTH: usize = 64;
/// Staged drag-out trees older than this are swept on the next drag-out. Long
/// enough that the OS has certainly finished copying a dropped selection.
const DRAGOUT_STALE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Outcome of a drag-out: whether the OS drag ended in a drop and how many
/// top-level items were dragged.
#[derive(serde::Serialize)]
pub struct DragOutResult {
    pub dropped: bool,
    pub count: usize,
}

/// Budget shared across one drag-out, enforcing the caps above.
struct StageBudget {
    bytes: u64,
    entries: usize,
}

impl StageBudget {
    fn new() -> Self {
        Self {
            bytes: MAX_DRAGOUT_BYTES,
            entries: MAX_DRAGOUT_ENTRIES,
        }
    }

    fn take_entry(&mut self) -> Result<(), SftpError> {
        self.entries = self.entries.checked_sub(1).ok_or_else(|| {
            SftpError::InvalidPath("drag-out selection has too many files".into())
        })?;
        Ok(())
    }

    fn take_bytes(&mut self, n: u64) -> Result<(), SftpError> {
        self.bytes = self
            .bytes
            .checked_sub(n)
            .ok_or_else(|| SftpError::InvalidPath("drag-out selection is too large".into()))?;
        Ok(())
    }
}

/// Create a directory (and parents) restricted to the current user (0700 on
/// Unix) so secrets staged for a drag-out aren't world-readable in `/tmp`.
async fn create_private_dir(path: &Path) -> Result<(), SftpError> {
    #[cfg(unix)]
    {
        tokio::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))
    }
    #[cfg(not(unix))]
    {
        tokio::fs::create_dir_all(path)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))
    }
}

/// Choose a collision-free local path for a staged top-level entry. Same-named
/// entries from different source dirs are isolated under a hidden `.dupN`
/// subdir. Collisions are detected case-INSENSITIVELY because the staging
/// filesystem often is (macOS APFS, Windows NTFS default) — without this, two
/// remote files differing only in case ("File" vs "file") would map to the same
/// on-disk path and silently merge.
fn staged_path(stage: &Path, used: &mut HashSet<String>, file_name: &str) -> PathBuf {
    let key = |p: &Path| p.to_string_lossy().to_lowercase();
    let mut path = stage.join(file_name);
    let mut n = 1;
    while used.contains(&key(&path)) {
        path = stage.join(format!(".dup{n}")).join(file_name);
        n += 1;
    }
    used.insert(key(&path));
    path
}

/// Best-effort removal of staged drag-out trees left behind by earlier drops
/// (a successful OS drop gives us no completion signal, so we reap on the next
/// drag rather than guessing when the OS finished copying).
async fn sweep_stale_dragout(root: &Path) {
    let Ok(mut rd) = tokio::fs::read_dir(root).await else {
        return;
    };
    let now = SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age > DRAGOUT_STALE_AFTER)
            .unwrap_or(false);
        if stale {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

/// Stream one remote file to a local path. The session lock is held only for
/// the `open()` call; the byte copy runs lock-free (the file handle talks to
/// the SSH channel on its own) so other SFTP ops aren't blocked — mirrors
/// `download_task`.
async fn stage_file(
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_path: &std::path::Path,
) -> Result<(), SftpError> {
    let mut remote_file = {
        let sftp = sftp_arc.lock().await;
        sftp.open(remote_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };

    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    const CHUNK: usize = 32 * 1024; // 32 KB
    let mut buf = vec![0u8; CHUNK];
    loop {
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
    }
    local_file
        .flush()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    remote_file
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    Ok(())
}

/// Recursively stage a remote directory tree under `local_dir`, preserving
/// structure. Walks iteratively (an explicit stack) to avoid boxing async
/// recursion. Symlinks and other special entries are skipped — we only descend
/// real directories and copy regular files, which also guards against symlink
/// loops. Every server-supplied name is validated before it is joined onto a
/// local path (a hostile server must not be able to escape `local_dir`), and
/// the shared `budget` caps total bytes/entries/depth.
async fn stage_dir(
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_dir: &str,
    local_dir: &Path,
    budget: &mut StageBudget,
) -> Result<(), SftpError> {
    let mut stack = vec![(remote_dir.to_string(), local_dir.to_path_buf(), 0usize)];

    while let Some((rdir, ldir, depth)) = stack.pop() {
        if depth > MAX_DRAGOUT_DEPTH {
            return Err(SftpError::InvalidPath(
                "drag-out directory tree is nested too deeply".into(),
            ));
        }

        create_private_dir(&ldir).await?;

        // read_dir already skips "." and ".." entries internally.
        let entries = {
            let sftp = sftp_arc.lock().await;
            sftp.read_dir(&rdir)
                .await
                .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
        };

        for entry in entries {
            let raw = entry.file_name();
            // Reject unsafe server-supplied names ("..", separators, absolute)
            // rather than aborting the whole drag on one bad entry.
            let name = match validate_remote_name(&raw) {
                Ok(n) => n.to_string(),
                Err(_) => continue,
            };
            let rpath = if rdir == "/" {
                format!("/{name}")
            } else {
                format!("{rdir}/{name}")
            };
            let lpath = ldir.join(&name);

            let md = entry.metadata();
            match md.file_type() {
                FileType::Dir => {
                    budget.take_entry()?;
                    stack.push((rpath, lpath, depth + 1));
                }
                FileType::File => {
                    budget.take_entry()?;
                    budget.take_bytes(md.size.unwrap_or(0))?;
                    stage_file(sftp_arc, &rpath, &lpath).await?;
                }
                _ => {} // skip symlinks / specials
            }
        }
    }
    Ok(())
}

/// Stage every selected top-level entry into `stage`, returning the local paths
/// to hand to the OS drag. Top-level entries are classified with `lstat`
/// (`symlink_metadata`) so a symlinked directory can't be followed into an
/// unbounded recursive download; symlinks/specials are skipped.
async fn stage_entries(
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_paths: &[String],
    stage: &Path,
) -> Result<Vec<PathBuf>, SftpError> {
    let mut files = Vec::with_capacity(remote_paths.len());
    let mut used: HashSet<String> = HashSet::new();
    let mut budget = StageBudget::new();

    for remote_path in remote_paths {
        let attrs = {
            let sftp = sftp_arc.lock().await;
            sftp.symlink_metadata(remote_path)
                .await
                .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
        };

        let file_type = attrs.file_type();
        if file_type != FileType::Dir && file_type != FileType::File {
            continue; // skip symlinks / specials at the top level
        }

        let raw = Path::new(remote_path)
            .file_name()
            .ok_or_else(|| {
                SftpError::InvalidPath(format!("cannot derive a file name from {remote_path:?}"))
            })?
            .to_string_lossy()
            .to_string();
        validate_remote_name(&raw)?;

        let local_path = staged_path(stage, &mut used, &raw);
        if let Some(parent) = local_path.parent() {
            create_private_dir(parent).await?;
        }

        if file_type == FileType::Dir {
            stage_dir(sftp_arc, remote_path, &local_path, &mut budget).await?;
        } else {
            budget.take_entry()?;
            budget.take_bytes(attrs.size.unwrap_or(0))?;
            stage_file(sftp_arc, remote_path, &local_path).await?;
        }

        files.push(local_path);
    }

    Ok(files)
}

/// Run the native OS drag on the main thread with already-staged file paths,
/// resolving to `true` if the drag ended in a drop. Mirrors how
/// `tauri-plugin-drag` drives the `drag` crate, but the path list is fixed by
/// the backend (only validated staging paths) rather than accepted from the
/// webview — so a compromised webview can't drag arbitrary local files.
///
/// Platform note: the `drag` crate's GTK backend is X11-oriented and best-effort
/// under Wayland. The `drag` callback (Dropped/Cancel) is the only completion
/// signal we await, so if a platform fails to fire it the command stays pending
/// for that drag; the frontend's re-entrancy guard still recovers on the next
/// attempt and staged files are reaped by `sweep_stale_dragout`.
async fn start_native_drag(
    app: AppHandle,
    window: Window,
    files: Vec<PathBuf>,
) -> Result<bool, SftpError> {
    let icon_bytes = DRAG_ICON_PNG.to_vec();

    tokio::task::spawn_blocking(move || -> Result<bool, SftpError> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<bool, SftpError>>();
        let tx_cb = tx.clone();

        app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            let raw_window = window.gtk_window();
            #[cfg(not(target_os = "linux"))]
            let raw_window = tauri::Result::Ok(window.clone());

            match raw_window {
                Ok(w) => {
                    let started = drag::start_drag(
                        &w,
                        drag::DragItem::Files(files),
                        drag::Image::Raw(icon_bytes),
                        move |result, _cursor| {
                            let _ = tx_cb.send(Ok(matches!(result, drag::DragResult::Dropped)));
                        },
                        drag::Options::default(),
                    );
                    if let Err(e) = started {
                        let _ = tx.send(Err(SftpError::LocalIoError(format!(
                            "could not start drag: {e}"
                        ))));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(SftpError::LocalIoError(format!(
                        "no window handle for drag: {e}"
                    ))));
                }
            }
        })
        .map_err(|e| SftpError::LocalIoError(format!("main-thread dispatch failed: {e}")))?;

        rx.recv()
            .map_err(|e| SftpError::LocalIoError(format!("drag result channel closed: {e}")))?
    })
    .await
    .map_err(|e| SftpError::LocalIoError(format!("drag task failed: {e}")))?
}

/// Stage the selected remote files/folders to a private temp dir and start a
/// native OS drag-out (download to desktop/Finder), resolving once the drag
/// ends. Returns whether it ended in a drop and how many top-level items moved.
///
/// Unlike `sftp_download` (fire-and-forget, streams progress) the OS drag API
/// needs real, fully-written local file handles *before* the drag begins, so
/// this stages every byte first. Directories are copied recursively. Staging
/// runs entirely in the backend and the drag is handed only validated staging
/// paths — the webview never names a path, so it can't drag arbitrary files.
///
/// Cleanup: on cancel the staged tree is removed immediately (nothing was
/// copied out); on a drop we leave it for the OS to finish copying and reap it
/// on a later drag via `sweep_stale_dragout` (the OS gives no copy-complete
/// signal). Failures remove the partial tree before returning.
#[tauri::command]
#[instrument(skip(app, window, sftp_manager), fields(sftp_session_id = %sftp_session_id))]
pub async fn sftp_drag_out(
    app: AppHandle,
    window: Window,
    sftp_session_id: String,
    remote_paths: Vec<String>,
    sftp_manager: State<'_, Arc<SftpManager>>,
) -> Result<DragOutResult, SftpError> {
    let sftp_arc = {
        let session_ref = sftp_manager.get_session(&sftp_session_id)?;
        session_ref.sftp.clone()
    };

    let dragout_root = std::env::temp_dir().join("anyscp-dragout");
    sweep_stale_dragout(&dragout_root).await;

    let stage = dragout_root.join(uuid::Uuid::new_v4().to_string());
    create_private_dir(&stage).await?;

    // Stage everything; on any failure remove the partial tree so a broken drag
    // doesn't leak bytes into temp.
    let files = match stage_entries(&sftp_arc, &remote_paths, &stage).await {
        Ok(files) => files,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&stage).await;
            return Err(e);
        }
    };

    if files.is_empty() {
        let _ = tokio::fs::remove_dir_all(&stage).await;
        return Ok(DragOutResult {
            dropped: false,
            count: 0,
        });
    }

    let count = files.len();
    let dropped = match start_native_drag(app, window, files).await {
        Ok(dropped) => dropped,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&stage).await;
            return Err(e);
        }
    };

    if !dropped {
        // Cancelled — nothing was copied out, so reclaim the space now.
        let _ = tokio::fs::remove_dir_all(&stage).await;
    }

    Ok(DragOutResult { dropped, count })
}

#[allow(clippy::too_many_arguments)]
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

#[allow(clippy::too_many_arguments)]
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

/// Download a remote file to a temp directory, open it in an external editor,
/// watch for saves, and re-upload each time the file is saved. `editor` is the
/// editor to use; when `None`, an installed one is auto-detected.
#[tauri::command]
#[instrument(skip(sftp_manager, app_handle, editor), fields(sftp_session_id = %sftp_session_id, remote_path = %remote_path))]
pub async fn sftp_edit_external(
    sftp_session_id: String,
    remote_path: String,
    editor: Option<crate::editors::EditorConfig>,
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

    // Stage under a per-remote-file subdir so two files sharing a basename
    // (e.g. a/compose.yml and b/compose.yml) don't clobber each other (#76).
    let key = format!("{sftp_session_id}\0{remote_path}");
    let local_path = crate::editors::edit_temp_path(&key, &file_name);
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    }

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

    // 2. Open in the chosen editor (or an auto-detected one). Spawns and returns
    //    immediately; the watcher below handles save-and-re-upload.
    let editor = editor
        .or_else(crate::editors::resolve_default)
        .ok_or_else(|| {
            SftpError::LocalIoError("No editor found. Add one in Settings → Editors.".to_string())
        })?;
    crate::editors::launch(&editor, &local_path).map_err(SftpError::LocalIoError)?;

    crate::telemetry::capture(
        "edit_external",
        serde_json::json!({ "source": "sftp", "editor": editor.name }),
    );

    // 3. Watch for file saves and re-upload on each save
    let sftp_arc_bg = sftp_arc.clone();
    let remote_path_bg = remote_path.clone();
    let local_path_bg = local_path.clone();
    let app_handle_bg = app_handle.clone();
    let sftp_sid = sftp_session_id.clone();

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
                                            OpenFlags::CREATE
                                                | OpenFlags::WRITE
                                                | OpenFlags::TRUNCATE,
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

        // Cleanup: remove the file and prune its now-empty per-edit staging dirs.
        crate::editors::edit_temp_cleanup(&local_path_bg);
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
        .open_with_flags(
            dst,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
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
        if attrs.file_type() == FileType::Dir {
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

    crate::telemetry::capture(
        "sftp_entries_moved",
        serde_json::json!({ "count": source_paths.len() }),
    );
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

        if attrs.file_type() == FileType::Dir {
            copy_dir_remote(&sftp, source, &dest).await?;
        } else {
            copy_file_remote(&sftp, source, &dest).await?;
        }

        new_paths.push(dest);
    }

    crate::telemetry::capture(
        "sftp_entries_copied",
        serde_json::json!({ "count": source_paths.len() }),
    );
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
        crate::telemetry::capture(
            "sftp_upload_enqueued",
            serde_json::json!({ "file_count": file_count }),
        );
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
        crate::telemetry::capture(
            "sftp_download_enqueued",
            serde_json::json!({ "file_count": file_count }),
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chmod_attrs_sets_only_permissions() {
        // Regression guard for the data-loss bug: a chmod SETSTAT must carry the
        // permission bits and NOTHING else. If any of these become Some(_), the
        // server would truncate the file / chown to root / reset timestamps.
        let attrs = chmod_attrs(0o755);
        assert_eq!(attrs.permissions, Some(0o755));
        assert_eq!(
            attrs.size, None,
            "size must be None or the file gets truncated"
        );
        assert_eq!(attrs.uid, None, "uid must be None or the file gets chowned");
        assert_eq!(attrs.gid, None, "gid must be None or the file gets chowned");
        assert_eq!(attrs.user, None);
        assert_eq!(attrs.group, None);
        assert_eq!(
            attrs.atime, None,
            "atime must be None or it gets reset to epoch"
        );
        assert_eq!(
            attrs.mtime, None,
            "mtime must be None or it gets reset to epoch"
        );
    }

    #[test]
    fn chmod_attrs_preserves_special_bits() {
        // setuid/setgid/sticky in the lower 12 bits are passed through verbatim.
        assert_eq!(chmod_attrs(0o4755).permissions, Some(0o4755));
        assert_eq!(chmod_attrs(0o1777).permissions, Some(0o1777));
    }

    #[test]
    fn staged_path_isolates_duplicate_basenames() {
        let stage = Path::new("/tmp/stage");
        let mut used = HashSet::new();

        // First file of a given name lands directly under the stage dir.
        let a = staged_path(stage, &mut used, "report.txt");
        assert_eq!(a, stage.join("report.txt"));

        // A second entry with the same basename is isolated under a hidden
        // `.dupN` subdir so it can't clobber the first on the desktop.
        let b = staged_path(stage, &mut used, "report.txt");
        assert_eq!(b, stage.join(".dup1").join("report.txt"));
        assert_ne!(a, b);

        // A different name is unaffected.
        let c = staged_path(stage, &mut used, "notes.txt");
        assert_eq!(c, stage.join("notes.txt"));

        // Collision detection is case-insensitive (staging FS often is), so a
        // case-only variant is isolated rather than silently merged on APFS/NTFS.
        let d = staged_path(stage, &mut used, "NOTES.TXT");
        assert_eq!(d, stage.join(".dup1").join("NOTES.TXT"));

        // The `.dupN` parent can never collide with a real top-level entry,
        // because real entries are validated single components placed directly
        // under the stage dir.
        assert!(validate_remote_name(".dup1").is_ok());
        assert_ne!(b.parent(), Some(stage));
    }

    #[test]
    fn staged_budget_caps_entries_and_bytes() {
        let mut budget = StageBudget {
            bytes: 100,
            entries: 1,
        };
        assert!(budget.take_entry().is_ok());
        assert!(budget.take_entry().is_err(), "second entry exceeds cap");

        assert!(budget.take_bytes(100).is_ok());
        assert!(budget.take_bytes(1).is_err(), "byte cap exceeded");
    }

    #[test]
    fn perms_match_only_trusts_reported_permissions() {
        let with = |p: Option<u32>| FileAttributes {
            permissions: p,
            ..FileAttributes::empty()
        };

        // Match when the server reports the same lower-12 bits.
        assert!(perms_match(&with(Some(0o755)), 0o755));
        assert!(perms_match(&with(Some(0o4755)), 0o4755));

        // Differing bits do not match.
        assert!(!perms_match(&with(Some(0o644)), 0o755));
        // Type bits above 0o7777 are ignored on the reported side.
        assert!(perms_match(&with(Some(0o100755)), 0o755));

        // The #8 case: a chmod-to-000 must NOT be treated as a false-positive
        // success just because the server omitted the permissions field.
        assert!(!perms_match(&with(None), 0o000));
        assert!(!perms_match(&with(None), 0o755));
    }
}
