pub mod commands;
pub mod manager;

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ForwardType {
    Local,
    Remote,
}

impl ForwardType {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            ForwardType::Local => "local",
            ForwardType::Remote => "remote",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "remote" => ForwardType::Remote,
            _ => ForwardType::Local,
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_type_as_str_matches_db_representation() {
        assert_eq!(ForwardType::Local.as_str(), "local");
        assert_eq!(ForwardType::Remote.as_str(), "remote");
    }

    #[test]
    fn forward_type_from_str_parses_remote() {
        assert_eq!(ForwardType::from_str("remote"), ForwardType::Remote);
    }

    #[test]
    fn forward_type_from_str_parses_local() {
        assert_eq!(ForwardType::from_str("local"), ForwardType::Local);
    }

    #[test]
    fn forward_type_from_str_defaults_to_local_for_unknown() {
        // Defensive default: rows persisted with malformed values must still load.
        assert_eq!(ForwardType::from_str(""), ForwardType::Local);
        assert_eq!(ForwardType::from_str("REMOTE"), ForwardType::Local);
        assert_eq!(ForwardType::from_str("garbage"), ForwardType::Local);
    }

    #[test]
    fn forward_type_as_str_round_trips_through_from_str() {
        for ft in [ForwardType::Local, ForwardType::Remote] {
            assert_eq!(ForwardType::from_str(ft.as_str()), ft);
        }
    }

    #[test]
    fn tunnel_state_serializes_to_pascal_case() {
        // The frontend pattern-matches on these variant names, so changes here
        // are visible across the IPC boundary.
        let json = serde_json::to_string(&TunnelState::Active).unwrap();
        assert_eq!(json, "\"Active\"");
        let json = serde_json::to_string(&TunnelState::Stopped).unwrap();
        assert_eq!(json, "\"Stopped\"");
        let json = serde_json::to_string(&TunnelState::Starting).unwrap();
        assert_eq!(json, "\"Starting\"");
        let json = serde_json::to_string(&TunnelState::Error).unwrap();
        assert_eq!(json, "\"Error\"");
    }
}
