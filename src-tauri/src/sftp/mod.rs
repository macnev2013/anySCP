pub mod commands;
mod connection;
mod file_transfer;
pub mod transfer_manager;

use dashmap::DashMap;
use russh_sftp::client::error::Error as ClientError;
use russh_sftp::protocol::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::ssh::manager::SshManager;
use crate::types::{HostConfig, SshError};

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error("SFTP session not found: {0}")]
    SessionNotFound(String),
    #[error("SSH session not found: {0}")]
    SshSessionNotFound(String),
    #[error("SFTP protocol error: {0}")]
    ProtocolError(String),
    #[error("Remote I/O error: {0}")]
    RemoteIoError(String),
    #[error("Transport error: {0}")]
    TransportError(String),
    #[error("Local I/O error: {0}")]
    LocalIoError(String),
    #[error("Transfer cancelled")]
    TransferCancelled,
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[allow(dead_code)]
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[allow(dead_code)]
    #[error("Path not found: {0}")]
    NotFound(String),
    #[error("Channel error: {0}")]
    ChannelError(String),
}

/// Serialize as `{ kind, message }` — same convention as SshError / DbError.
impl Serialize for SftpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SftpError", 2)?;
        let kind = match self {
            SftpError::SessionNotFound(_) => "session_not_found",
            SftpError::SshSessionNotFound(_) => "ssh_session_not_found",
            SftpError::ProtocolError(_) => "protocol_error",
            SftpError::RemoteIoError(_) => "remote_io_error",
            SftpError::TransportError(_) => "transport_error",
            SftpError::LocalIoError(_) => "local_io_error",
            SftpError::TransferCancelled => "transfer_cancelled",
            SftpError::InvalidPath(_) => "invalid_path",
            SftpError::PermissionDenied(_) => "permission_denied",
            SftpError::NotFound(_) => "not_found",
            SftpError::ChannelError(_) => "channel_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl SftpError {
    pub(crate) fn is_transient(&self) -> bool {
        matches!(self, Self::TransportError(_))
    }
}

impl From<SshError> for SftpError {
    fn from(error: SshError) -> Self {
        match error {
            SshError::ConnectionFailed(message)
            | SshError::ChannelError(message)
            | SshError::IoError(message) => Self::TransportError(message),
            SshError::AuthenticationFailed(message) | SshError::KeyParseError(message) => {
                Self::ProtocolError(message)
            }
            SshError::SessionNotFound(message) => Self::SshSessionNotFound(message),
            SshError::AlreadyDisconnected => {
                Self::TransportError("SSH session already disconnected".to_string())
            }
            SshError::Cancelled => Self::TransferCancelled,
        }
    }
}

pub(crate) fn map_client_error(error: ClientError) -> SftpError {
    match error {
        ClientError::IO(message) => SftpError::TransportError(message),
        ClientError::Timeout => SftpError::TransportError("SFTP request timed out".to_string()),
        ClientError::Status(status)
            if matches!(
                status.status_code,
                StatusCode::NoConnection | StatusCode::ConnectionLost
            ) =>
        {
            SftpError::TransportError(format!("{}: {}", status.status_code, status.error_message))
        }
        other => {
            let message = other.to_string();
            if is_transport_message(&message) {
                SftpError::TransportError(message)
            } else {
                SftpError::RemoteIoError(message)
            }
        }
    }
}

pub(crate) fn map_remote_io(error: std::io::Error) -> SftpError {
    let transient_kind = matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    );
    let message = error.to_string();
    if transient_kind || is_transport_message(&message) {
        SftpError::TransportError(message)
    } else {
        SftpError::RemoteIoError(message)
    }
}

/// `russh-sftp::client::fs::File` currently erases its typed client error and
/// returns `io::ErrorKind::Other`, leaving only the display message. Keep the
/// compatibility match here rather than spreading string checks through the
/// transfer engine.
fn is_transport_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "broken pipe",
        "channel closed",
        "connection aborted",
        "connection lost",
        "connection reset",
        "no connection",
        "not connected",
        "timed out",
        "timeout",
        "unexpected eof",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub entry_type: SftpEntryType,
    pub size: u64,
    /// Raw Unix permission bits (lower 12 bits of the mode word).
    pub permissions: u32,
    /// Human-readable rwxrwxrwx string.
    pub permissions_display: String,
    /// Unix mtime as seconds since epoch, or `None` when the server omits it.
    pub modified: Option<u64>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SftpEntryType {
    File,
    Directory,
    Symlink,
    Other,
}

/// Outcome of a recursive chmod: how many entries were successfully updated and
/// any per-entry failures (collected rather than aborting the whole operation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChmodSummary {
    pub applied: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub file_name: String,
    pub direction: TransferDirection,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub status: TransferStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferDirection {
    Download,
    Upload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferStatus {
    Queued,
    InProgress,
    Paused,
    Completed,
    Failed(String),
    Cancelled,
}

/// Event payload emitted to the frontend on the `sftp:transfer` channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferEvent {
    pub transfer_id: String,
    pub sftp_session_id: String,
    /// Display name — file name for single-file transfers, directory name for dirs.
    pub name: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    /// Populated only when status is `Failed`.
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub resume_supported: bool,
    /// Unix timestamp in milliseconds.
    pub created_at: u64,
}

/// Serialisable snapshot returned by `sftp_list_transfers`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferInfo {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub name: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub resume_supported: bool,
    pub created_at: u64,
}

// ─── Manager ─────────────────────────────────────────────────────────────────

pub struct SftpSessionWrapper {
    pub sftp: Arc<Mutex<russh_sftp::client::SftpSession>>,
    pub ssh_session_id: String,
    pub host_config: HostConfig,
    pub use_sudo: bool,
    pub generation: u64,
    pub reconnect_lock: Arc<Mutex<()>>,
}

pub struct SftpTransferSession {
    pub sftp: Arc<Mutex<russh_sftp::client::SftpSession>>,
    pub generation: u64,
}

pub struct SftpManager {
    sessions: DashMap<String, SftpSessionWrapper>,
    active_transfers: DashMap<String, CancellationToken>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            active_transfers: DashMap::new(),
        }
    }

    pub fn insert_session(&self, id: String, wrapper: SftpSessionWrapper) {
        self.sessions.insert(id, wrapper);
    }

    pub fn get_session(
        &self,
        id: &str,
    ) -> Result<dashmap::mapref::one::Ref<'_, String, SftpSessionWrapper>, SftpError> {
        self.sessions
            .get(id)
            .ok_or_else(|| SftpError::SessionNotFound(id.to_string()))
    }

    pub fn transfer_session(&self, id: &str) -> Result<SftpTransferSession, SftpError> {
        let session = self.get_session(id)?;
        Ok(SftpTransferSession {
            sftp: session.sftp.clone(),
            generation: session.generation,
        })
    }

    /// Reconnect and replace an SFTP session only if no other transfer has
    /// already replaced the failed generation.
    pub async fn reconnect_if_generation(
        &self,
        id: &str,
        failed_generation: u64,
        ssh_manager: &SshManager,
        cancel: &CancellationToken,
    ) -> Result<u64, SftpError> {
        let reconnect_lock = self.get_session(id)?.reconnect_lock.clone();
        let _guard = reconnect_lock.lock().await;

        let (current_generation, old_ssh_session_id, host_config, use_sudo) = {
            let session = self.get_session(id)?;
            (
                session.generation,
                session.ssh_session_id.clone(),
                session.host_config.clone(),
                session.use_sudo,
            )
        };
        if current_generation != failed_generation {
            return Ok(current_generation);
        }

        let new_ssh_session_id = tokio::select! {
            _ = cancel.cancelled() => return Err(SftpError::TransferCancelled),
            result = ssh_manager.connect_no_pty(host_config, None) => result.map_err(SftpError::from)?,
        };
        let handle = ssh_manager
            .get_handle(&new_ssh_session_id.0)
            .map_err(SftpError::from)?;
        let open_result = tokio::select! {
            _ = cancel.cancelled() => Err(SftpError::TransferCancelled),
            result = connection::open_sftp_session(&handle, use_sudo) => result,
        };
        let new_sftp = match open_result {
            Ok(session) => session,
            Err(error) => {
                ssh_manager.remove_bare(&new_ssh_session_id.0);
                return Err(error);
            }
        };

        let next_generation = current_generation + 1;
        let Some(mut session) = self.sessions.get_mut(id) else {
            ssh_manager.remove_bare(&new_ssh_session_id.0);
            return Err(SftpError::SessionNotFound(id.to_string()));
        };
        session.sftp = Arc::new(Mutex::new(new_sftp));
        session.ssh_session_id = new_ssh_session_id.0;
        session.generation = next_generation;
        drop(session);

        ssh_manager.remove_bare(&old_ssh_session_id);
        Ok(next_generation)
    }

    pub fn remove_session(&self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn insert_transfer(&self, id: String, token: CancellationToken) {
        self.active_transfers.insert(id, token);
    }

    pub fn cancel_transfer(&self, id: &str) -> Result<(), SftpError> {
        let entry = self
            .active_transfers
            .get(id)
            .ok_or_else(|| SftpError::SessionNotFound(format!("transfer not found: {id}")))?;
        entry.value().cancel();
        Ok(())
    }

    pub fn remove_transfer(&self, id: &str) {
        self.active_transfers.remove(id);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Validate a server-supplied directory-entry name before joining it onto a
/// local path. The SFTP server controls these strings (READDIR/`SSH_FXP_NAME`),
/// and `russh-sftp` only filters literal `.`/`..` — so without this guard a
/// hostile server could return `..`, `/etc/cron.d/evil`, or `a/b` and escape the
/// local staging directory via `Path::join` (an absolute arg replaces the base;
/// `..` is resolved by the OS at create time). We require the name to be exactly
/// one normal path component: no separators, no `.`/`..`, no NUL, not absolute,
/// not empty. Returns the name on success.
pub(crate) fn validate_remote_name(name: &str) -> Result<&str, SftpError> {
    use std::path::{Component, Path};

    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(SftpError::InvalidPath(format!(
            "server returned an unsafe entry name: {name:?}"
        )));
    }

    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        // Exactly one component, and it must be a plain file/dir name (not `..`,
        // `.`, a root, or a Windows drive prefix).
        (Some(Component::Normal(c)), None) if c == std::ffi::OsStr::new(name) => Ok(name),
        _ => Err(SftpError::InvalidPath(format!(
            "server returned an unsafe entry name: {name:?}"
        ))),
    }
}

/// Convert a raw Unix mode word into a 9-character `rwxrwxrwx` string.
/// Only the lower 9 permission bits are examined.
pub fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_permissions_rwxr_xr_x() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
    }

    #[test]
    fn format_permissions_rw_r_r() {
        assert_eq!(format_permissions(0o644), "rw-r--r--");
    }

    #[test]
    fn format_permissions_all_zero() {
        assert_eq!(format_permissions(0), "---------");
    }

    #[test]
    fn validate_remote_name_accepts_plain_names() {
        for name in [
            "file.txt",
            "My Folder",
            "résumé.pdf",
            ".hidden",
            "a.b.c",
            "...",
        ] {
            assert!(validate_remote_name(name).is_ok(), "should accept {name:?}");
        }
    }

    #[test]
    fn validate_remote_name_rejects_traversal_and_separators() {
        // The hostile inputs a malicious SFTP server could return.
        for name in [
            "",
            ".",
            "..",
            "/",
            "/etc/passwd",
            "../../secret",
            "a/b",
            "a\\b", // Windows separator
            "C:\\evil",
            "with\0nul",
        ] {
            assert!(
                validate_remote_name(name).is_err(),
                "should reject {name:?}"
            );
        }
    }

    #[test]
    fn connection_interruptions_are_transient() {
        for kind in [
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::NotConnected,
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::UnexpectedEof,
        ] {
            assert!(map_remote_io(std::io::Error::from(kind)).is_transient());
        }
        assert!(map_client_error(ClientError::Timeout).is_transient());
        assert!(
            map_client_error(ClientError::Status(russh_sftp::protocol::Status {
                id: 1,
                status_code: StatusCode::ConnectionLost,
                error_message: "connection reset".to_string(),
                language_tag: String::new(),
            }))
            .is_transient()
        );
        assert!(
            map_remote_io(std::io::Error::other("I/O: Connection reset by peer")).is_transient()
        );
    }

    #[test]
    fn local_and_remote_data_errors_are_not_auto_retried() {
        assert!(
            !map_remote_io(std::io::Error::from(std::io::ErrorKind::PermissionDenied,))
                .is_transient()
        );
        assert!(!SftpError::LocalIoError("disk full".to_string()).is_transient());
    }
}
