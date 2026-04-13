use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum RdpError {
    #[error("RDP connection failed: {0}")]
    ConnectionFailed(String),

    #[error("RDP authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("RDP session not found: {0}")]
    SessionNotFound(String),

    #[error("RDP protocol error: {0}")]
    ProtocolError(String),

    #[error("TLS error: {0}")]
    TlsError(String),

    #[error("I/O error: {0}")]
    IoError(String),
}

impl Serialize for RdpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("RdpError", 2)?;
        let kind = match self {
            RdpError::ConnectionFailed(_) => "connection_failed",
            RdpError::AuthenticationFailed(_) => "authentication_failed",
            RdpError::SessionNotFound(_) => "session_not_found",
            RdpError::ProtocolError(_) => "protocol_error",
            RdpError::TlsError(_) => "tls_error",
            RdpError::IoError(_) => "io_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<std::io::Error> for RdpError {
    fn from(e: std::io::Error) -> Self {
        RdpError::IoError(e.to_string())
    }
}
