use serde::{Deserialize, Serialize};
use std::fmt;

/// Opaque session identifier. Wraps a UUID v4 string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How to authenticate to the remote host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    /// Plaintext password (kept only in Rust memory).
    #[serde(rename = "password")]
    Password { password: String },
    /// Path to a PEM/OpenSSH private key file on disk.
    #[serde(rename = "privateKey")]
    PrivateKey {
        key_path: String,
        passphrase: Option<String>,
    },
    /// Raw private key material (e.g. pasted into the UI).
    #[serde(rename = "privateKeyData")]
    PrivateKeyData {
        key_data: String,
        passphrase: Option<String>,
    },
}

/// Configuration for an SSH bastion/jump host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BastionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

/// Everything needed to open an SSH connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Human-readable label shown in the UI tab.
    pub label: Option<String>,
    /// Keepalive interval in seconds (overrides default 60s).
    pub keep_alive_interval: Option<u32>,
    /// Shell to request instead of the default login shell.
    pub default_shell: Option<String>,
    /// Command to execute after the shell is ready.
    pub startup_command: Option<String>,
    /// Bastion / jump host configuration.
    pub bastion: Option<BastionConfig>,
}

/// Lifecycle state of a single SSH session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", content = "message")]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnecting,
    Disconnected,
    Error(String),
}
