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
#[derive(Clone, Serialize, Deserialize)]
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
    /// Delegate signing to a running SSH agent (ssh-agent / gpg-agent with
    /// `--enable-ssh-support`). Uses `$SSH_AUTH_SOCK` unless `socket_path` overrides it.
    #[serde(rename = "sshAgent")]
    SshAgent {
        socket_path: Option<String>,
    },
}

/// Redacting `Debug`: sessions hold their `HostConfig` (and thus credentials)
/// in memory for reconnect, so a derived impl would leak the password /
/// passphrase / raw key into any `{:?}` log line or a future `#[instrument]`
/// capture. Variants are fully destructured so adding a field is a compile
/// error here — a new secret can't slip into Debug output unreviewed.
impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const REDACTED: &str = "<redacted>";
        match self {
            AuthMethod::Password { password: _ } => f
                .debug_struct("Password")
                .field("password", &REDACTED)
                .finish(),
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => f
                .debug_struct("PrivateKey")
                .field("key_path", key_path)
                .field("passphrase", &passphrase.as_ref().map(|_| REDACTED))
                .finish(),
            AuthMethod::PrivateKeyData {
                key_data: _,
                passphrase,
            } => f
                .debug_struct("PrivateKeyData")
                .field("key_data", &REDACTED)
                .field("passphrase", &passphrase.as_ref().map(|_| REDACTED))
                .finish(),
            AuthMethod::SshAgent { socket_path } => f
                .debug_struct("SshAgent")
                .field("socket_path", socket_path)
                .finish(),
        }
    }
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
    /// Resolved ProxyJump / bastion host to tunnel this connection through.
    ///
    /// When present, the connection is established by first opening an SSH
    /// session to this jump host and then tunnelling a `direct-tcpip` channel
    /// to the target. Boxed to break the otherwise-infinite recursive type
    /// size. `#[serde(default)]` keeps direct `ssh_connect` payloads (which omit
    /// the field) backwards-compatible.
    #[serde(default)]
    pub jump_host: Option<Box<HostConfig>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Sessions keep credentials in memory for reconnect — Debug output must
    /// never contain them, only the redaction marker.
    #[test]
    fn auth_method_debug_redacts_all_secrets() {
        let cases = [
            AuthMethod::Password {
                password: "hunter2".into(),
            },
            AuthMethod::PrivateKey {
                key_path: "/home/u/.ssh/id_ed25519".into(),
                passphrase: Some("hunter2".into()),
            },
            AuthMethod::PrivateKeyData {
                key_data: "-----BEGIN OPENSSH PRIVATE KEY-----hunter2".into(),
                passphrase: Some("hunter2".into()),
            },
        ];
        for auth in cases {
            let dbg = format!("{auth:?}");
            assert!(!dbg.contains("hunter2"), "secret leaked into Debug: {dbg}");
            assert!(dbg.contains("<redacted>"));
        }
        // Non-secret context stays visible for troubleshooting.
        let dbg = format!(
            "{:?}",
            AuthMethod::PrivateKey {
                key_path: "/k".into(),
                passphrase: None
            }
        );
        assert!(dbg.contains("/k"));
    }
}
