pub mod commands;
pub mod transfer_manager;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

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
            SftpError::LocalIoError(_) => "local_io_error",
            SftpError::TransferCancelled => "transfer_cancelled",
            SftpError::PermissionDenied(_) => "permission_denied",
            SftpError::NotFound(_) => "not_found",
            SftpError::ChannelError(_) => "channel_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
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
    pub created_at: u64,
}

// ─── Manager ─────────────────────────────────────────────────────────────────

pub struct SftpSessionWrapper {
    pub sftp: Arc<Mutex<russh_sftp::client::SftpSession>>,
    #[allow(dead_code)]
    pub ssh_session_id: String,
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
}
