use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task;
use tracing::{instrument, warn};

use crate::db::{DbError, HostDb};
use crate::types::{HostConfig, SshError};

use super::{manager::PortForwardManager, ForwardType, PortForwardRule, TunnelState, TunnelStatus};

// ─── CRUD ────────────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(db))]
#[allow(clippy::too_many_arguments)]
pub async fn pf_create_rule(
    host_id: Option<String>,
    label: Option<String>,
    description: Option<String>,
    forward_type: String,
    bind_address: String,
    local_port: u32,
    remote_host: String,
    remote_port: u32,
    auto_start: bool,
    db: State<'_, Arc<HostDb>>,
) -> Result<PortForwardRule, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = Arc::clone(&db);

    // Store the canonical lowercase form (matches imported rules) regardless of
    // the casing the frontend sent ("Local" vs "local").
    let forward_type = forward_type.to_ascii_lowercase();

    let c_id = id.clone();
    let c_host_id = host_id.clone();
    let c_label = label.clone();
    let c_desc = description.clone();
    let c_ft = forward_type.clone();
    let c_bind = bind_address.clone();
    let c_rhost = remote_host.clone();

    task::spawn_blocking(move || {
        db.create_pf_rule(
            &c_id,
            c_host_id.as_deref(),
            c_label.as_deref(),
            c_desc.as_deref(),
            &c_ft,
            &c_bind,
            local_port,
            &c_rhost,
            remote_port,
            auto_start,
        )
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))??;

    crate::telemetry::capture(
        "tunnel_rule_created",
        serde_json::json!({ "auto_start": auto_start }),
    );
    Ok(PortForwardRule {
        id,
        host_id,
        label,
        description,
        forward_type: ForwardType::from_str(&forward_type),
        bind_address,
        local_port,
        remote_host,
        remote_port,
        auto_start,
        enabled: true,
        last_used_at: None,
        total_bytes: 0,
        created_at: String::new(),
    })
}

#[tauri::command]
#[instrument(skip(db))]
#[allow(clippy::too_many_arguments)]
pub async fn pf_update_rule(
    id: String,
    label: Option<String>,
    description: Option<String>,
    bind_address: String,
    local_port: u32,
    remote_host: String,
    remote_port: u32,
    auto_start: bool,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&db);
    task::spawn_blocking(move || {
        db.update_pf_rule(
            &id,
            label.as_deref(),
            description.as_deref(),
            &bind_address,
            local_port,
            &remote_host,
            remote_port,
            auto_start,
        )
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(db))]
pub async fn pf_delete_rule(id: String, db: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&db);
    let result = task::spawn_blocking(move || db.delete_pf_rule(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;
    if result.is_ok() {
        crate::telemetry::capture("tunnel_rule_deleted", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(db))]
pub async fn pf_list_rules(
    host_id: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<PortForwardRule>, DbError> {
    let db = Arc::clone(&db);
    task::spawn_blocking(move || db.list_pf_rules(host_id.as_deref()))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Tunnel control ──────────────────────────────────────────────────────────

/// Resolve a saved host into a [`HostConfig`] for a tunnel's dedicated SSH
/// connection, including its full ProxyJump chain so a tunnel for a host that's
/// only reachable through a bastion connects the same way the terminal does.
/// Reuses the connect path's resolver (credentials from the vault, cycle-guarded
/// jump chain) and runs the blocking DB/keychain work off the async runtime.
async fn resolve_tunnel_host_config(
    db: Arc<HostDb>,
    host_id: String,
) -> Result<HostConfig, SshError> {
    task::spawn_blocking(move || {
        crate::ssh::commands::build_host_config_blocking(&host_id, &db, &mut Vec::new())
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Start the tunnel described by `rule`, establishing its own dedicated SSH
/// connection. `auto_started` marks tunnels brought up automatically on host
/// connect so they can be torn down when the host disconnects.
async fn start_rule(
    app_handle: AppHandle,
    rule: PortForwardRule,
    auto_started: bool,
) -> Result<TunnelStatus, SshError> {
    let host_id = rule
        .host_id
        .clone()
        .ok_or_else(|| SshError::SessionNotFound("tunnel has no host".to_string()))?;

    let db = app_handle.state::<Arc<HostDb>>().inner().clone();
    let pf_manager = app_handle
        .state::<Arc<PortForwardManager>>()
        .inner()
        .clone();

    let config = resolve_tunnel_host_config(db.clone(), host_id.clone()).await?;

    // Record last_used_at (best effort).
    let dbc = db.clone();
    let rid = rule.id.clone();
    let _ = task::spawn_blocking(move || dbc.touch_pf_rule(&rid)).await;

    pf_manager
        .start_tunnel(
            rule.id,
            rule.forward_type,
            config,
            rule.bind_address,
            rule.local_port,
            rule.remote_host,
            rule.remote_port,
            Some(host_id),
            auto_started,
        )
        .await
}

/// Start a single tunnel on demand (manual toggle from the UI). The rule is
/// loaded from the DB so its forward type and parameters are authoritative.
#[tauri::command]
#[instrument(skip(db))]
pub async fn pf_start_tunnel(
    rule_id: String,
    app_handle: AppHandle,
    db: State<'_, Arc<HostDb>>,
) -> Result<TunnelStatus, SshError> {
    let dbc = Arc::clone(&db);
    let rid = rule_id.clone();
    let rule = task::spawn_blocking(move || dbc.get_pf_rule(&rid))
        .await
        .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
        .map_err(|e| SshError::IoError(e.to_string()))?
        .ok_or_else(|| SshError::SessionNotFound(format!("tunnel rule not found: {rule_id}")))?;

    let status = start_rule(app_handle, rule, false).await?;
    crate::telemetry::capture("tunnel_started", serde_json::json!({}));
    Ok(status)
}

/// Start every `auto_start` tunnel bound to `host_id`. Invoked in the background
/// right after a host's SSH session is established. Each tunnel gets its own
/// connection; a failure to bring one up surfaces as a non-fatal `pf:status`
/// error and never aborts the others or the host connection.
pub async fn start_auto_tunnels_for_host(app_handle: AppHandle, host_id: String) {
    let db = app_handle.state::<Arc<HostDb>>().inner().clone();

    let hid = host_id.clone();
    let rules = match task::spawn_blocking(move || db.list_pf_rules(Some(&hid))).await {
        Ok(Ok(rules)) => rules,
        Ok(Err(e)) => {
            warn!(host_id = %host_id, error = %e, "auto-start: failed to list tunnels");
            return;
        }
        Err(e) => {
            warn!(host_id = %host_id, error = %e, "auto-start: list task panicked");
            return;
        }
    };

    for rule in rules.into_iter().filter(|r| r.auto_start) {
        let rule_id = rule.id.clone();
        let local_port = rule.local_port;
        match start_rule(app_handle.clone(), rule, true).await {
            Ok(_) => {
                info_started(&rule_id);
            }
            Err(e) => {
                warn!(rule_id = %rule_id, error = %e, "auto-start: tunnel failed");
                // Surface a non-fatal error to the UI without stopping the rest.
                let _ = app_handle.emit(
                    "pf:status",
                    &TunnelStatus {
                        rule_id,
                        status: TunnelState::Error,
                        local_port,
                        connections: 0,
                        error: Some(e.to_string()),
                    },
                );
            }
        }
    }
}

/// Stop all auto-started tunnels for a host (called when the host disconnects).
pub fn stop_auto_tunnels_for_host(app_handle: &AppHandle, host_id: &str) {
    let pf_manager = app_handle.state::<Arc<PortForwardManager>>();
    pf_manager.stop_auto_started_for_host(host_id);
}

fn info_started(rule_id: &str) {
    tracing::info!(rule_id = %rule_id, "auto-start: tunnel active");
}

#[tauri::command]
#[instrument(skip(pf_manager))]
pub async fn pf_stop_tunnel(
    rule_id: String,
    pf_manager: State<'_, Arc<PortForwardManager>>,
) -> Result<(), crate::types::SshError> {
    let result = pf_manager.stop_tunnel(&rule_id);
    if result.is_ok() {
        crate::telemetry::capture("tunnel_stopped", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(pf_manager))]
pub async fn pf_list_active_tunnels(
    pf_manager: State<'_, Arc<PortForwardManager>>,
) -> Result<Vec<TunnelStatus>, crate::types::SshError> {
    Ok(pf_manager.list_active())
}
