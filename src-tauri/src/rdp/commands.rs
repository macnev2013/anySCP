use super::error::RdpError;
use super::manager::RdpManager;
use super::types::{RdpConfig, RdpKeyInput, RdpMouseInput};
use crate::db::HostDb;
use crate::vault;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct RdpConnectResult {
    pub session_id: String,
    pub ws_port: u16,
}

#[tauri::command]
pub async fn rdp_connect(
    config: RdpConfig,
    state: State<'_, Arc<RdpManager>>,
    app_handle: AppHandle,
) -> Result<RdpConnectResult, RdpError> {
    let (session_id, ws_port) = state.connect(config, app_handle).await?;
    Ok(RdpConnectResult { session_id, ws_port })
}

#[tauri::command]
pub async fn rdp_disconnect(
    session_id: String,
    state: State<'_, Arc<RdpManager>>,
    app_handle: AppHandle,
) -> Result<(), RdpError> {
    state.disconnect(&session_id, app_handle).await
}

#[tauri::command]
pub async fn rdp_send_mouse(
    session_id: String,
    input: RdpMouseInput,
    state: State<'_, Arc<RdpManager>>,
) -> Result<(), RdpError> {
    state.send_mouse(&session_id, input)
}

#[tauri::command]
pub async fn rdp_send_key(
    session_id: String,
    input: RdpKeyInput,
    state: State<'_, Arc<RdpManager>>,
) -> Result<(), RdpError> {
    state.send_key(&session_id, input)
}

#[tauri::command]
pub async fn rdp_resize(
    session_id: String,
    width: u16,
    height: u16,
    state: State<'_, Arc<RdpManager>>,
) -> Result<(), RdpError> {
    state.resize(&session_id, width, height)
}

#[tauri::command]
pub async fn rdp_connect_saved_host(
    host_id: String,
    state: State<'_, Arc<RdpManager>>,
    db: State<'_, Arc<HostDb>>,
    app_handle: AppHandle,
) -> Result<RdpConnectResult, RdpError> {
    let db_clone = Arc::clone(&db);
    let id_for_db = host_id.clone();
    let saved_host = tokio::task::spawn_blocking(move || db_clone.get_host(&id_for_db))
        .await
        .map_err(|e| RdpError::IoError(format!("task panicked: {e}")))?
        .map_err(|e| RdpError::IoError(e.to_string()))?
        .ok_or_else(|| RdpError::SessionNotFound(format!("host not found: {host_id}")))?;

    let id_for_vault = host_id.clone();
    let password = tokio::task::spawn_blocking(move || {
        match vault::get_credential(&id_for_vault) {
            Ok(vault::StoredCredential::Password { password }) => password,
            _ => String::new(),
        }
    })
    .await
    .map_err(|e| RdpError::IoError(format!("task panicked: {e}")))?;

    let config = super::types::RdpConfig {
        host: saved_host.host,
        port: saved_host.port,
        username: saved_host.username,
        password,
        domain: saved_host.rdp_domain,
        width: saved_host.rdp_width.unwrap_or(1920) as u16,
        height: saved_host.rdp_height.unwrap_or(1080) as u16,
    };

    let (session_id, ws_port) = state.connect(config, app_handle).await?;
    Ok(RdpConnectResult { session_id, ws_port })
}
