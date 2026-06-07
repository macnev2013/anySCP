use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use super::{ConnectionHistoryEntry, DbError, HostDb, HostGroup, RecentConnection, SavedHost};

/// Persist (insert or update) a host entry.
///
/// ProxyJump cycles, self-references, and dangling tunnel-host targets are
/// rejected atomically with the write inside [`HostDb::save_host_validated`].
#[tauri::command]
#[instrument(skip(state), fields(id = %host.id))]
pub async fn save_host(host: SavedHost, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_host_validated(&host))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all saved hosts, ordered by label.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_hosts(state: State<'_, Arc<HostDb>>) -> Result<Vec<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_hosts())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a saved host by its UUID string.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_host(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_host(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Look up a single host by its UUID string.  Returns `None` when not found.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn get_host(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<Option<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.get_host(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Create a new host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn create_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.create_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Update an existing host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn update_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.update_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all host groups, ordered by sort_order then name.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_groups(state: State<'_, Arc<HostDb>>) -> Result<Vec<HostGroup>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_groups())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a host group.  Member hosts are orphaned (their
/// `group_id` is set to NULL) rather than deleted.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_group(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Delete a host group AND all hosts inside it.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group_with_hosts(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_group_with_hosts(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Record a successful connection for the given host id.  Also prunes the
/// history table to keep at most 50 rows.
#[tauri::command]
#[instrument(skip(state), fields(host_id = %host_id))]
pub async fn record_connection(
    host_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.record_connection(&host_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return the most-recent distinct connection per host, ordered newest-first.
/// `limit` caps the number of rows returned.
#[tauri::command]
#[instrument(skip(state), fields(limit = %limit))]
pub async fn list_recent_connections(
    limit: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<RecentConnection>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_recent_connections(limit))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Connection History (full audit log) ──────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn list_connection_history(
    host_id: Option<String>,
    limit: u32,
    offset: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<ConnectionHistoryEntry>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_connection_history(host_id.as_deref(), limit, offset))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── App Settings ─────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn save_setting(
    key: String,
    value: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_setting(&key, &value))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn load_all_settings(
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<(String, String)>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.load_all_settings())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Factory reset ─────────────────────────────────────────────────────────────

/// Permanently wipe ALL local data — saved hosts, groups, connection history,
/// snippets, port-forward rules, S3 connections, and app settings — plus their
/// stored credentials in the OS keychain. Returns anySCP to first-launch state.
///
/// This is irreversible; the frontend gates it behind a typed confirmation and
/// relaunches the app afterwards.
#[tauri::command]
#[instrument(skip(state))]
pub async fn factory_reset(state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || {
        let keys = db.factory_reset()?;
        // Purge secrets from the keychain. Best-effort: a missing entry is fine,
        // and one bad key shouldn't abort the rest — the rows are already gone.
        for host_id in &keys.host_ids {
            if let Err(e) = crate::vault::delete_credential(host_id) {
                tracing::warn!(host_id = %host_id, error = %e, "factory reset: keychain purge failed");
            }
        }
        for s3_id in &keys.s3_ids {
            let key = format!("s3:{s3_id}");
            if let Err(e) = crate::vault::delete_credential(&key) {
                tracing::warn!(key = %key, error = %e, "factory reset: keychain purge failed");
            }
        }
        Ok::<(), DbError>(())
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}
