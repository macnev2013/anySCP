use serde::Serialize;

/// All SSH-related errors surfaced to the frontend via Tauri command results.
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Channel error: {0}")]
    ChannelError(String),

    #[error("Key parse error: {0}")]
    KeyParseError(String),

    #[error("I/O error: {0}")]
    IoError(String),

    #[allow(dead_code)]
    #[error("Session already disconnected")]
    AlreadyDisconnected,
}

impl Serialize for SshError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SshError", 2)?;
        let kind = match self {
            SshError::ConnectionFailed(_) => "connection_failed",
            SshError::AuthenticationFailed(_) => "authentication_failed",
            SshError::SessionNotFound(_) => "session_not_found",
            SshError::ChannelError(_) => "channel_error",
            SshError::KeyParseError(_) => "key_parse_error",
            SshError::IoError(_) => "io_error",
            SshError::AlreadyDisconnected => "already_disconnected",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for SshError {
    fn from(e: std::io::Error) -> Self {
        SshError::IoError(e.to_string())
    }
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::ConnectionFailed(e.to_string())
    }
}

impl From<russh_keys::Error> for SshError {
    fn from(e: russh_keys::Error) -> Self {
        SshError::KeyParseError(e.to_string())
    }
}
