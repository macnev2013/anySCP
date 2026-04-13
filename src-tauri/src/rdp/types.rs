use serde::{Deserialize, Serialize};

/// Configuration for establishing an RDP connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RdpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
}

/// Connection status change event.
#[derive(Debug, Clone, Serialize)]
pub struct RdpStatusPayload {
    pub session_id: String,
    pub status: String,
    pub message: Option<String>,
}

/// Mouse input from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct RdpMouseInput {
    pub x: u16,
    pub y: u16,
    pub button: Option<String>,
    pub pressed: bool,
    pub wheel_delta: Option<i16>,
}

/// Keyboard input from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct RdpKeyInput {
    pub scancode: u8,
    pub extended: bool,
    pub pressed: bool,
}
