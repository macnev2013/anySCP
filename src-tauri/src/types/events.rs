use serde::{Deserialize, Serialize};

/// Payload emitted on the `ssh:output` Tauri event channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshOutputPayload {
    pub session_id: String,
    /// Raw terminal bytes from the PTY.
    pub data: Vec<u8>,
}

/// Payload emitted on the `ssh:status` Tauri event channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshStatusPayload {
    pub session_id: String,
    pub status: super::session::ConnectionStatus,
}
