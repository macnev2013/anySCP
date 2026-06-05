use crate::db::HostDb;
use crate::ssh::keys::SshKeyInfo;
use crate::ssh::manager::SshManager;
use crate::types::{AuthMethod, HostConfig, SessionId, SshError};
use crate::vault;
use russh::client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::net::{lookup_host, TcpStream};
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHealthCheckResult {
    pub status: HostHealthStatus,
    pub message: String,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostHealthStatus {
    Reachable,
    DnsFailed,
    PortClosed,
    SshFailed,
}

const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

#[tauri::command]
pub async fn ssh_connect(
    host_config: HostConfig,
    state: State<'_, SshManager>,
    app_handle: AppHandle,
) -> Result<SessionId, SshError> {
    state.connect(host_config, app_handle).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, SshManager>,
    app_handle: AppHandle,
) -> Result<(), SshError> {
    let result = state.disconnect(&session_id, app_handle).await;
    if result.is_ok() {
        crate::telemetry::capture("ssh_disconnected", serde_json::json!({}));
    }
    result
}

#[tauri::command]
pub async fn ssh_send_input(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, SshManager>,
) -> Result<(), SshError> {
    state.send_input(&session_id, &data).await
}

#[tauri::command]
pub async fn ssh_resize_pty(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, SshManager>,
) -> Result<(), SshError> {
    state.resize_pty(&session_id, cols, rows).await
}

/// Open a new PTY channel on an existing SSH connection (for split panes).
/// Returns a new session ID backed by a new channel on the same connection.
#[tauri::command]
pub async fn ssh_split_session(
    source_session_id: String,
    state: State<'_, SshManager>,
    app_handle: AppHandle,
) -> Result<SessionId, SshError> {
    let result = state.split_session(&source_session_id, app_handle).await;
    if result.is_ok() {
        crate::telemetry::capture("ssh_split_pane", serde_json::json!({}));
    }
    result
}

/// Scan `~/.ssh/` for private key files and return metadata for each one.
#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<SshKeyInfo>, SshError> {
    tokio::task::spawn_blocking(super::keys::list_ssh_keys)
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Inspect a single SSH key file at any path. Validates the format and returns metadata.
#[tauri::command]
pub async fn inspect_ssh_key(path: String) -> Result<SshKeyInfo, SshError> {
    tokio::task::spawn_blocking(move || super::keys::inspect_ssh_key(&path))
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Check whether a saved host is reachable without opening a terminal or using
/// stored credentials. Loads the host from the DB and delegates to
/// [`probe_host_health`]. Authentication is intentionally skipped, so a
/// `Reachable` result only means the endpoint speaks SSH — not that the host
/// identity is verified or that the stored credentials would be accepted.
#[tauri::command]
pub async fn ssh_health_check_saved_host(
    host_id: String,
    db: State<'_, Arc<HostDb>>,
) -> Result<HostHealthCheckResult, SshError> {
    let db_clone = Arc::clone(&db);
    let id_for_db = host_id.clone();
    let saved_host = tokio::task::spawn_blocking(move || db_clone.get_host(&id_for_db))
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
        .map_err(|e| SshError::IoError(e.to_string()))?
        .ok_or_else(|| SshError::SessionNotFound(format!("host not found: {host_id}")))?;

    Ok(probe_host_health(&saved_host.host, saved_host.port).await)
}

/// Probe a host's SSH reachability: DNS resolution → TCP connect → SSH transport
/// handshake (no authentication). Each stage is bounded by `HEALTH_CHECK_TIMEOUT`;
/// crucially the TCP stage shares a *single* budget across all resolved addresses
/// so a host that resolves to many (or black-holed) addresses cannot stall the
/// probe for `N * HEALTH_CHECK_TIMEOUT`. The connected TCP stream is reused for the
/// handshake, so a reachable host is connected to only once. Never returns an
/// error — every failure mode maps to a structured `HostHealthCheckResult`.
async fn probe_host_health(host: &str, port: u16) -> HostHealthCheckResult {
    let started = Instant::now();
    let elapsed_ms = || started.elapsed().as_millis() as u64;
    let addr = format!("{host}:{port}");

    // ── DNS ────────────────────────────────────────────────────────────────
    let resolved = match timeout(HEALTH_CHECK_TIMEOUT, lookup_host(&addr)).await {
        Ok(Ok(addrs)) => addrs.collect::<Vec<_>>(),
        Ok(Err(e)) => {
            return HostHealthCheckResult {
                status: HostHealthStatus::DnsFailed,
                message: format!("DNS lookup failed: {e}"),
                latency_ms: None,
            };
        }
        Err(_) => {
            return HostHealthCheckResult {
                status: HostHealthStatus::DnsFailed,
                message: "DNS lookup timed out".to_string(),
                latency_ms: None,
            };
        }
    };

    if resolved.is_empty() {
        return HostHealthCheckResult {
            status: HostHealthStatus::DnsFailed,
            message: "DNS lookup returned no addresses".to_string(),
            latency_ms: None,
        };
    }

    // ── TCP ──────────────────────────────────────────────────────────────
    // Try each resolved address in turn, but bound the whole loop to a single
    // HEALTH_CHECK_TIMEOUT budget so address count can't multiply the wait.
    let tcp_deadline = started + HEALTH_CHECK_TIMEOUT;
    let mut tcp_error = None;
    let mut reachable_stream = None;
    for socket_addr in resolved {
        let remaining = tcp_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            tcp_error = Some("TCP connection timed out".to_string());
            break;
        }
        match timeout(remaining, TcpStream::connect(socket_addr)).await {
            Ok(Ok(stream)) => {
                reachable_stream = Some(stream);
                break;
            }
            Ok(Err(e)) => tcp_error = Some(e.to_string()),
            Err(_) => tcp_error = Some("TCP connection timed out".to_string()),
        }
    }

    let Some(stream) = reachable_stream else {
        return HostHealthCheckResult {
            status: HostHealthStatus::PortClosed,
            message: tcp_error
                .map(|e| format!("TCP port is not reachable: {e}"))
                .unwrap_or_else(|| "TCP port is not reachable".to_string()),
            latency_ms: Some(elapsed_ms()),
        };
    };

    // ── SSH transport handshake (no auth) ────────────────────────────────
    // Reuse the already-connected TCP stream via `connect_stream` so we don't
    // open a second connection to the host. The handshake bound is the outer
    // `timeout`, so no `inactivity_timeout` is needed on the throwaway config.
    let russh_config = Arc::new(client::Config::default());
    let handler = super::handler::SshClientHandler;
    match timeout(
        HEALTH_CHECK_TIMEOUT,
        client::connect_stream(russh_config, stream, handler),
    )
    .await
    {
        Ok(Ok(handle)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            HostHealthCheckResult {
                status: HostHealthStatus::Reachable,
                message: "Ping".to_string(),
                latency_ms: Some(elapsed_ms()),
            }
        }
        Ok(Err(e)) => HostHealthCheckResult {
            status: HostHealthStatus::SshFailed,
            message: format!("SSH handshake failed: {e}"),
            latency_ms: Some(elapsed_ms()),
        },
        Err(_) => HostHealthCheckResult {
            status: HostHealthStatus::SshFailed,
            message: "SSH handshake timed out".to_string(),
            latency_ms: Some(elapsed_ms()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A hostname under the reserved `.invalid` TLD (RFC 6761) never resolves,
    /// so the probe must short-circuit at the DNS stage with no latency reading.
    #[tokio::test]
    async fn probe_reports_dns_failed_for_unresolvable_host() {
        let result = probe_host_health("anyscp-nonexistent.invalid", 22).await;
        assert!(
            matches!(result.status, HostHealthStatus::DnsFailed),
            "expected DnsFailed, got {:?} ({})",
            result.status,
            result.message,
        );
        assert!(result.latency_ms.is_none());
    }

    /// Binding an ephemeral port then dropping the listener yields a port that is
    /// guaranteed closed, so the TCP stage must report PortClosed.
    #[tokio::test]
    async fn probe_reports_port_closed_for_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);

        let result = probe_host_health("127.0.0.1", port).await;
        assert!(
            matches!(result.status, HostHealthStatus::PortClosed),
            "expected PortClosed, got {:?} ({})",
            result.status,
            result.message,
        );
        assert!(result.latency_ms.is_some());
    }
}

/// Connect to a saved host by its UUID.
///
/// This command is the secure entry-point for connecting to hosts that have
/// credentials stored in the OS keychain.  The frontend supplies only the
/// opaque `host_id`; passwords and passphrases are fetched entirely in Rust
/// and never cross the IPC boundary.
///
/// Steps:
/// 1. Look up `SavedHost` from SQLite.
/// 2. Fetch the matching `StoredCredential` from the OS keychain (best-effort
///    — private-key hosts may not have a passphrase stored).
/// 3. Build a `HostConfig` and delegate to `SshManager::connect`.
#[tauri::command]
pub async fn connect_saved_host(
    host_id: String,
    state: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
    app_handle: AppHandle,
) -> Result<SessionId, SshError> {
    // -----------------------------------------------------------------
    // Resolve the full HostConfig (credentials + ProxyJump chain) entirely
    // inside one blocking task — DB and keychain access are synchronous.
    // -----------------------------------------------------------------
    let db_clone = Arc::clone(&db);
    let id_for_db = host_id.clone();
    let config = tokio::task::spawn_blocking(move || {
        build_host_config_blocking(&id_for_db, &db_clone, &mut Vec::new())
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))??;

    let auth_type = auth_method_label(&config.auth_method).to_string();
    let session_id = state.connect(config, app_handle).await?;

    crate::telemetry::capture(
        "ssh_connected",
        serde_json::json!({
            "auth_type": auth_type,
        }),
    );

    Ok(session_id)
}

/// Short label for an AuthMethod variant, used for telemetry only.
fn auth_method_label(auth: &AuthMethod) -> &'static str {
    match auth {
        AuthMethod::Password { .. } => "password",
        AuthMethod::PrivateKey { .. } => "privateKey",
        AuthMethod::PrivateKeyData { .. } => "privateKeyData",
    }
}

/// Resolve the AuthMethod for a saved host, pulling secrets from the keychain.
/// An empty password / absent passphrase means the keychain entry is missing;
/// the SSH handshake then fails with AuthenticationFailed rather than a vault
/// error.
fn resolve_auth_method(host_id: &str, auth_type: &str, key_path: Option<String>) -> AuthMethod {
    match auth_type {
        "privateKey" => {
            let path = key_path.unwrap_or_default();
            let passphrase = match vault::get_credential(host_id) {
                Ok(vault::StoredCredential::KeyPassphrase { passphrase }) => Some(passphrase),
                _ => None,
            };
            AuthMethod::PrivateKey {
                key_path: path,
                passphrase,
            }
        }
        _ => {
            let password = match vault::get_credential(host_id) {
                Ok(vault::StoredCredential::Password { password }) => password,
                _ => String::new(),
            };
            AuthMethod::Password { password }
        }
    }
}

/// Recursively build a [`HostConfig`] for a saved host, including its
/// credentials and its full ProxyJump chain (`jump_host`). Runs entirely
/// synchronously (DB + keychain only) so it can be called inside a single
/// `spawn_blocking`. `visited` guards against cyclic ProxyJump references.
///
/// A missing jump host surfaces as a clear `"tunnel host ... not found"` error
/// rather than the generic not-found message used for the top-level host.
fn build_host_config_blocking(
    host_id: &str,
    db: &HostDb,
    visited: &mut Vec<String>,
) -> Result<HostConfig, SshError> {
    if visited.iter().any(|v| v == host_id) {
        return Err(SshError::ConnectionFailed(
            "circular ProxyJump configuration detected".to_string(),
        ));
    }
    visited.push(host_id.to_string());

    let saved_host = db
        .get_host(host_id)
        .map_err(|e| SshError::IoError(e.to_string()))?
        .ok_or_else(|| SshError::SessionNotFound(format!("host not found: {host_id}")))?;

    let auth_method = resolve_auth_method(host_id, &saved_host.auth_type, saved_host.key_path);

    // Resolve the ProxyJump target (if any) into a nested HostConfig.
    let jump_host = match saved_host.proxy_jump_host_id.as_deref() {
        Some(jump_id) if !jump_id.is_empty() => {
            let jump_cfg =
                build_host_config_blocking(jump_id, db, visited).map_err(|e| match e {
                    SshError::SessionNotFound(_) => SshError::ConnectionFailed(format!(
                        "tunnel host not found in saved hosts (id {jump_id})"
                    )),
                    other => other,
                })?;
            Some(Box::new(jump_cfg))
        }
        _ => None,
    };

    Ok(HostConfig {
        host: saved_host.host,
        port: saved_host.port,
        username: saved_host.username,
        auth_method,
        label: if saved_host.label.is_empty() {
            None
        } else {
            Some(saved_host.label)
        },
        keep_alive_interval: saved_host.keep_alive_interval,
        default_shell: saved_host.default_shell,
        startup_command: saved_host.startup_command,
        jump_host,
    })
}

/// Connect to a saved host without opening a PTY.
/// Used for SFTP-only sessions where no terminal is needed.
/// Returns a session ID whose Handle can be used for SFTP.
#[tauri::command]
pub async fn connect_saved_host_no_pty(
    host_id: String,
    state: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
) -> Result<SessionId, SshError> {
    let db_clone = Arc::clone(&db);
    let id_for_db = host_id.clone();
    let config = tokio::task::spawn_blocking(move || {
        build_host_config_blocking(&id_for_db, &db_clone, &mut Vec::new())
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))??;

    state.connect_no_pty(config).await
}
