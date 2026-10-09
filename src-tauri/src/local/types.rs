//! Data types for local-filesystem browsing, surfaced to the frontend.

use serde::Serialize;

/// A local directory entry. Field-compatible with `sftp::SftpEntry` so the
/// frontend can reuse the same TypeScript type and `toExplorerEntry` mapper.
#[derive(Debug, Clone, Serialize)]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub entry_type: LocalEntryType,
    pub size: u64,
    /// Lower 12 bits of the Unix mode; 0 on platforms without Unix permissions.
    pub permissions: u32,
    /// `rwxr-xr-x`-style string; empty on non-Unix.
    pub permissions_display: String,
    /// mtime as whole seconds since the Unix epoch, when available.
    pub modified: Option<u64>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum LocalEntryType {
    File,
    Directory,
    Symlink,
    Other,
}

/// Errors surfaced to the frontend as `{ kind, message }` (mirrors `SftpError`).
#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    #[error("Path not found: {0}")]
    NotFound(String),
    #[error("Not a directory: {0}")]
    NotADirectory(String),
    #[error("Already exists: {0}")]
    AlreadyExists(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("I/O error: {0}")]
    IoError(String),
}

impl LocalError {
    fn kind(&self) -> &'static str {
        match self {
            LocalError::NotFound(_) => "not_found",
            LocalError::NotADirectory(_) => "not_a_directory",
            LocalError::AlreadyExists(_) => "already_exists",
            LocalError::InvalidPath(_) => "invalid_path",
            LocalError::IoError(_) => "io_error",
        }
    }
}

impl Serialize for LocalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("LocalError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for LocalError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let msg = e.to_string();
        match e.kind() {
            ErrorKind::NotFound => LocalError::NotFound(msg),
            ErrorKind::AlreadyExists => LocalError::AlreadyExists(msg),
            _ => LocalError::IoError(msg),
        }
    }
}
