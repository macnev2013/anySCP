pub mod commands;
pub mod exec;
pub mod listing;
pub mod transfer;
pub mod transfer_manager;
pub mod wire;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::ssh::handler::SshClientHandler;

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ScpError {
    #[error("SCP session not found: {0}")]
    SessionNotFound(String),
    #[error("SSH session not found: {0}")]
    SshSessionNotFound(String),
    #[error("SCP protocol error: {0}")]
    ProtocolError(String),
    #[error("Remote error: {0}")]
    RemoteError(String),
    #[error("Remote command failed (exit={exit_code}): {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },
    #[error("Remote I/O error: {0}")]
    RemoteIoError(String),
    #[error("Local I/O error: {0}")]
    LocalIoError(String),
    #[error("Transfer cancelled")]
    TransferCancelled,
    #[allow(dead_code)]
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[allow(dead_code)]
    #[error("Path not found: {0}")]
    NotFound(String),
    #[error("Channel error: {0}")]
    ChannelError(String),
    #[error("Output parse error: {0}")]
    ParseError(String),
}

/// Serialize as `{ kind, message }` — same convention as SshError / SftpError.
impl Serialize for ScpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ScpError", 2)?;
        let kind = match self {
            ScpError::SessionNotFound(_) => "session_not_found",
            ScpError::SshSessionNotFound(_) => "ssh_session_not_found",
            ScpError::ProtocolError(_) => "protocol_error",
            ScpError::RemoteError(_) => "remote_error",
            ScpError::CommandFailed { .. } => "command_failed",
            ScpError::RemoteIoError(_) => "remote_io_error",
            ScpError::LocalIoError(_) => "local_io_error",
            ScpError::TransferCancelled => "transfer_cancelled",
            ScpError::PermissionDenied(_) => "permission_denied",
            ScpError::NotFound(_) => "not_found",
            ScpError::ChannelError(_) => "channel_error",
            ScpError::ParseError(_) => "parse_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for ScpError {
    fn from(err: std::io::Error) -> Self {
        ScpError::RemoteIoError(err.to_string())
    }
}

// ─── Data types ──────────────────────────────────────────────────────────────

/// One directory entry. Field-compatible with `SftpEntry` so the frontend can
/// treat both uniformly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScpEntry {
    pub name: String,
    pub path: String,
    pub entry_type: ScpEntryType,
    pub size: u64,
    /// Raw Unix permission bits (lower 12 bits of the mode word).
    pub permissions: u32,
    /// Human-readable rwxrwxrwx string.
    pub permissions_display: String,
    /// Unix mtime as seconds since epoch, or `None` when not available.
    pub modified: Option<u64>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ScpEntryType {
    File,
    Directory,
    Symlink,
    Other,
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
    Completed,
    Failed(String),
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub scp_session_id: String,
    pub file_name: String,
    pub direction: TransferDirection,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub status: TransferStatus,
}

/// Event payload emitted to the frontend on the `scp:transfer` channel.
/// Field-shape matches `sftp::TransferEvent` with the session-id key renamed,
/// so the frontend hook can normalize both onto one type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferEvent {
    pub transfer_id: String,
    pub scp_session_id: String,
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
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferInfo {
    pub transfer_id: String,
    pub scp_session_id: String,
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
    pub created_at: u64,
}

// ─── Manager ─────────────────────────────────────────────────────────────────

/// A registered "SCP session" — really just a reference back to the SSH session
/// it lives on. SCP is stateless: every filesystem op and every transfer opens
/// a fresh channel on this SSH connection.
pub struct ScpSessionWrapper {
    /// The SSH session this SCP session rides on. Retained for diagnostics /
    /// future teardown coordination even though transfers only need the handle.
    #[allow(dead_code)]
    pub ssh_session_id: String,
    pub ssh_handle: Arc<Mutex<russh::client::Handle<SshClientHandler>>>,
    /// Remote userland, detected once at open — decides which listing/stat
    /// commands to issue.
    pub flavor: listing::Flavor,
}

pub struct ScpManager {
    sessions: DashMap<String, ScpSessionWrapper>,
    active_transfers: DashMap<String, CancellationToken>,
}

impl ScpManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            active_transfers: DashMap::new(),
        }
    }

    pub fn insert_session(&self, id: String, wrapper: ScpSessionWrapper) {
        self.sessions.insert(id, wrapper);
    }

    pub fn get_session(
        &self,
        id: &str,
    ) -> Result<dashmap::mapref::one::Ref<'_, String, ScpSessionWrapper>, ScpError> {
        self.sessions
            .get(id)
            .ok_or_else(|| ScpError::SessionNotFound(id.to_string()))
    }

    pub fn remove_session(&self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn insert_transfer(&self, id: String, token: CancellationToken) {
        self.active_transfers.insert(id, token);
    }

    pub fn cancel_transfer(&self, id: &str) -> Result<(), ScpError> {
        let entry = self
            .active_transfers
            .get(id)
            .ok_or_else(|| ScpError::SessionNotFound(format!("transfer not found: {id}")))?;
        entry.value().cancel();
        Ok(())
    }

    pub fn remove_transfer(&self, id: &str) {
        self.active_transfers.remove(id);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Convert a raw Unix mode word into a 9-character `rwxrwxrwx` string.
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

/// Quote a path for safe substitution into a shell command.
///
/// Wraps in single quotes and escapes any embedded single quotes as `'\''`.
/// Safe for any filename including spaces, $, `, *, etc.
pub fn shell_quote(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('\'');
    for c in path.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
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
    fn shell_quote_plain() {
        assert_eq!(shell_quote("/tmp/file"), "'/tmp/file'");
    }

    #[test]
    fn shell_quote_with_space() {
        assert_eq!(shell_quote("/tmp/my file"), "'/tmp/my file'");
    }

    #[test]
    fn shell_quote_with_single_quote() {
        assert_eq!(shell_quote("/tmp/it's.txt"), r"'/tmp/it'\''s.txt'");
    }

    #[test]
    fn shell_quote_with_metacharacters() {
        assert_eq!(shell_quote("/tmp/a;b`c$d*e"), "'/tmp/a;b`c$d*e'");
    }
}
