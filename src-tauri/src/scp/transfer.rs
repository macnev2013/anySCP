//! Byte-transfer primitives that drive a remote `scp -t` (sink) or
//! `scp -f` (source) process over a fresh SSH channel, speaking the wire
//! protocol from [`super::wire`].
//!
//! These are the SCP analogue of `russh_sftp`'s file read/write. Directory
//! transfers are handled one level up (in `transfer_manager` / `commands`) by
//! recursing in Rust and calling [`upload_file`] / [`download_file`] per file,
//! which keeps progress accounting and cancellation simple.

use std::path::Path;
use std::sync::Arc;

use russh::client::Handle;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::ssh::handler::SshClientHandler;

use super::wire::{self, ScpMsg};
use super::{shell_quote, ScpError};

const CHUNK_SIZE: usize = 32 * 1024;

/// Default mode applied to uploaded files when the local mode can't be read.
const DEFAULT_FILE_MODE: u32 = 0o644;

/// Upload one local file to `remote_path` via `scp -t`.
///
/// `on_progress` is called with the cumulative byte count after each chunk.
/// The remote parent directory must already exist (callers handle `mkdir -p`).
pub async fn upload_file<F>(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    local_path: &Path,
    remote_path: &str,
    cancel: &CancellationToken,
    on_progress: F,
) -> Result<(), ScpError>
where
    F: FnMut(u64),
{
    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| ScpError::LocalIoError(format!("cannot stat {}: {e}", local_path.display())))?;
    let size = meta.len();
    let mode = local_mode(&meta);

    let name = remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ScpError::ProtocolError(format!("invalid remote path: {remote_path}")))?
        .to_string();

    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| ScpError::LocalIoError(format!("cannot open {}: {e}", local_path.display())))?;

    // Open a channel and start the remote sink. `-t` = "to" (receive).
    let channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| ScpError::ChannelError(e.to_string()))?
    };
    let cmd = format!("scp -t -- {}", shell_quote(remote_path));
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| ScpError::ChannelError(format!("exec scp -t failed: {e}")))?;

    let mut stream = channel.into_stream();

    // Handshake: wait for the sink to signal readiness.
    wire::read_ack(&mut stream).await?;

    // Send the file header, wait for ack.
    wire::write_msg(&mut stream, &ScpMsg::File { mode, size, name }).await?;
    wire::read_ack(&mut stream).await?;

    // Stream the body.
    wire::stream_bytes(
        &mut local_file,
        &mut stream,
        size,
        CHUNK_SIZE,
        || cancel.is_cancelled(),
        on_progress,
    )
    .await?;

    // Trailing \0 = "file complete, status OK", then wait for the sink's ack.
    stream
        .write_all(&[0u8])
        .await
        .map_err(|e| ScpError::RemoteIoError(e.to_string()))?;
    stream
        .flush()
        .await
        .map_err(|e| ScpError::RemoteIoError(e.to_string()))?;
    wire::read_ack(&mut stream).await?;

    // Closing the stream tears down the channel.
    let _ = stream.shutdown().await;
    Ok(())
}

/// Download one remote file (`remote_path`) to `local_path` via `scp -f`.
pub async fn download_file<F>(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    remote_path: &str,
    local_path: &Path,
    cancel: &CancellationToken,
    on_progress: F,
) -> Result<(), ScpError>
where
    F: FnMut(u64),
{
    let channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| ScpError::ChannelError(e.to_string()))?
    };
    // `-f` = "from" (send). `-p` would also send timestamps; we skip it.
    let cmd = format!("scp -f -- {}", shell_quote(remote_path));
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| ScpError::ChannelError(format!("exec scp -f failed: {e}")))?;

    let mut stream = channel.into_stream();

    // Kick off the source by acking.
    wire::write_ack(&mut stream).await?;

    // Read records until we hit the file header. A `-p`-less source may still
    // emit a T record on some servers; skip any T records.
    let (mode, size) = loop {
        match wire::read_msg(&mut stream).await? {
            Some(ScpMsg::Time { .. }) => continue,
            Some(ScpMsg::File { mode, size, .. }) => break (mode, size),
            Some(ScpMsg::Dir { .. }) | Some(ScpMsg::EndDir) => {
                return Err(ScpError::ProtocolError(
                    "expected a file but server sent a directory record".into(),
                ));
            }
            None => {
                return Err(ScpError::RemoteError(format!(
                    "no such file: {remote_path}"
                )));
            }
        }
    };
    let _ = mode; // local file mode is decided by the OS umask; ignore remote mode.

    // Ack the header so the source starts streaming the body.
    wire::write_ack(&mut stream).await?;

    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| ScpError::LocalIoError(format!("cannot create {}: {e}", local_path.display())))?;

    let stream_result = wire::stream_bytes(
        &mut stream,
        &mut local_file,
        size,
        CHUNK_SIZE,
        || cancel.is_cancelled(),
        on_progress,
    )
    .await;

    if let Err(e) = stream_result {
        // Clean up the partial local file before surfacing the error.
        drop(local_file);
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(e);
    }

    local_file
        .flush()
        .await
        .map_err(|e| ScpError::LocalIoError(e.to_string()))?;

    // Read the source's trailing status byte, then ack it.
    wire::read_ack(&mut stream).await?;
    wire::write_ack(&mut stream).await?;

    let _ = stream.shutdown().await;
    Ok(())
}

/// Read the local file mode (Unix permission bits). On non-Unix, returns the
/// default. Symlinks are followed because `metadata` follows them.
#[cfg(unix)]
fn local_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    let m = meta.permissions().mode() & 0o777;
    if m == 0 {
        DEFAULT_FILE_MODE
    } else {
        m
    }
}

#[cfg(not(unix))]
fn local_mode(_meta: &std::fs::Metadata) -> u32 {
    DEFAULT_FILE_MODE
}
