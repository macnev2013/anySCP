use crate::db::HostDb;
use crate::ssh::keys::SshKeyInfo;
use crate::ssh::manager::SshManager;
use crate::types::{AuthMethod, HostConfig, SessionId, SshError};
use crate::vault;
use std::sync::Arc;
use tauri::{AppHandle, State};

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
    tokio::task::spawn_blocking(|| super::keys::list_ssh_keys())
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
    // 1. Load the SavedHost record from SQLite.
    // -----------------------------------------------------------------
    let db_clone = Arc::clone(&db);
    let id_for_db = host_id.clone();

    let saved_host = tokio::task::spawn_blocking(move || db_clone.get_host(&id_for_db))
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
        .map_err(|e| SshError::IoError(e.to_string()))?
        .ok_or_else(|| SshError::SessionNotFound(format!("host not found: {host_id}")))?;

    // -----------------------------------------------------------------
    // 2. Resolve the AuthMethod, pulling the secret from the keychain.
    //
    //    We move the fields we need into the blocking task so that neither
    //    the SavedHost nor the vault reference cross an await point.
    // -----------------------------------------------------------------
    let id_for_vault = host_id.clone();
    let auth_type = saved_host.auth_type.clone();
    let key_path = saved_host.key_path.clone();

    let auth_method =
        tokio::task::spawn_blocking(move || -> AuthMethod {
            match auth_type.as_str() {
                "privateKey" => {
                    let path = key_path.unwrap_or_default();
                    // A passphrase is optional — a key without encryption is valid.
                    let passphrase = match vault::get_credential(&id_for_vault) {
                        Ok(vault::StoredCredential::KeyPassphrase { passphrase }) => {
                            Some(passphrase)
                        }
                        _ => None,
                    };
                    AuthMethod::PrivateKey { key_path: path, passphrase }
                }
                _ => {
                    // Default: password auth.  An empty password means the
                    // keychain entry is missing; the SSH handshake will fail
                    // with AuthenticationFailed rather than a vault error.
                    let password = match vault::get_credential(&id_for_vault) {
                        Ok(vault::StoredCredential::Password { password }) => password,
                        _ => String::new(),
                    };
                    AuthMethod::Password { password }
                }
            }
        })
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?;

    // -----------------------------------------------------------------
    // 3. Build HostConfig and open the SSH connection.
    // -----------------------------------------------------------------
    let config = HostConfig {
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
    };

    let session_id = state.connect(config, app_handle).await?;

    crate::telemetry::capture("ssh_connected", serde_json::json!({
        "auth_type": saved_host.auth_type,
    }));

    Ok(session_id)
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

    let saved_host = tokio::task::spawn_blocking(move || db_clone.get_host(&id_for_db))
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
        .map_err(|e| SshError::IoError(e.to_string()))?
        .ok_or_else(|| SshError::SessionNotFound(format!("host not found: {host_id}")))?;

    let id_for_vault = host_id.clone();
    let auth_type = saved_host.auth_type.clone();
    let key_path = saved_host.key_path.clone();

    let auth_method =
        tokio::task::spawn_blocking(move || -> AuthMethod {
            match auth_type.as_str() {
                "privateKey" => {
                    let path = key_path.unwrap_or_default();
                    let passphrase = match vault::get_credential(&id_for_vault) {
                        Ok(vault::StoredCredential::KeyPassphrase { passphrase }) => Some(passphrase),
                        _ => None,
                    };
                    AuthMethod::PrivateKey { key_path: path, passphrase }
                }
                _ => {
                    let password = match vault::get_credential(&id_for_vault) {
                        Ok(vault::StoredCredential::Password { password }) => password,
                        _ => String::new(),
                    };
                    AuthMethod::Password { password }
                }
            }
        })
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?;

    let config = HostConfig {
        host: saved_host.host,
        port: saved_host.port,
        username: saved_host.username,
        auth_method,
        label: if saved_host.label.is_empty() { None } else { Some(saved_host.label) },
        keep_alive_interval: None,
        default_shell: None,
        startup_command: None,
    };

    state.connect_no_pty(config).await
}
