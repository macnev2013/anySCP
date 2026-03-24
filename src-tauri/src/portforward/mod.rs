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
