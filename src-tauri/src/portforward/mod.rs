pub mod commands;
pub mod manager;

use serde::{Deserialize, Serialize};

/// `app_settings` key for the global "auto-start tunnels by default" toggle.
/// Stored as the string `"true"` / `"false"`; absent means the default (`true`).
pub const AUTO_START_DEFAULT_SETTING_KEY: &str = "tunnels_auto_start_default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardRule {
    pub id: String,
    pub host_id: Option<String>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub forward_type: ForwardType,
    pub bind_address: String,
    pub local_port: u32,
    pub remote_host: String,
    pub remote_port: u32,
    pub auto_start: bool,
    pub enabled: bool,
    pub last_used_at: Option<String>,
    pub total_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ForwardType {
    /// Local forward (`ssh -L`): a local listener proxies to a remote
    /// destination over a `direct-tcpip` channel.
    Local,
    /// Remote forward (`ssh -R`): the server listens and forwards back to a
    /// destination reachable from this client.
    Remote,
    /// Dynamic forward (`ssh -D`): a local SOCKS proxy. No fixed destination.
    Dynamic,
}

impl ForwardType {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            ForwardType::Local => "local",
            ForwardType::Remote => "remote",
            ForwardType::Dynamic => "dynamic",
        }
    }

    /// Parse from the stored/transmitted string. Case-insensitive so it accepts
    /// both the canonical lowercase form (`"remote"`) and the frontend's
    /// PascalCase enum form (`"Remote"`).
    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "remote" => ForwardType::Remote,
            "dynamic" => ForwardType::Dynamic,
            _ => ForwardType::Local,
        }
    }
}

#[cfg(test)]
mod forward_type_tests {
    use super::ForwardType;

    #[test]
    fn from_str_is_case_insensitive() {
        assert_eq!(ForwardType::from_str("Remote"), ForwardType::Remote);
        assert_eq!(ForwardType::from_str("remote"), ForwardType::Remote);
        assert_eq!(ForwardType::from_str("Dynamic"), ForwardType::Dynamic);
        assert_eq!(ForwardType::from_str("DYNAMIC"), ForwardType::Dynamic);
        assert_eq!(ForwardType::from_str("Local"), ForwardType::Local);
        assert_eq!(ForwardType::from_str("anything"), ForwardType::Local);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub rule_id: String,
    pub status: TunnelState,
    pub local_port: u32,
    pub connections: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TunnelState {
    Starting,
    Active,
    Error,
    Stopped,
}
