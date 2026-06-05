use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{DbError, HostDb, SavedHost};
use crate::types::SshError;

use super::{ImportResult, SshConfigEntry, SshConfigImportEntry};

/// Parse SSH config and return a preview of importable hosts.
#[tauri::command]
#[instrument(skip(db))]
pub async fn import_parse_ssh_config(
    path: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<SshConfigEntry>, SshError> {
    let db = Arc::clone(&db);

    task::spawn_blocking(move || {
        // Get existing hosts for duplicate detection
        let existing = db
            .list_hosts()
            .unwrap_or_default()
            .into_iter()
            .map(|h| (h.host, h.username, h.port))
            .collect::<Vec<_>>();

        super::parse_ssh_config(path.as_deref(), &existing)
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Save selected SSH config entries as SavedHosts.
#[tauri::command]
#[instrument(skip(db))]
pub async fn import_save_ssh_hosts(
    entries: Vec<SshConfigImportEntry>,
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    let host_count = entries.len();
    let db = Arc::clone(&db);

    let result = task::spawn_blocking(move || {
        let mut imported = 0u32;
        let mut skipped = 0u32;
        let mut errors = Vec::new();

        // alias (Host block name) → generated host id, for ProxyJump resolution.
        let mut alias_to_id: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // (host id, raw ProxyJump value) pairs that still need resolving.
        let mut pending_jumps: Vec<(String, String)> = Vec::new();

        for entry in &entries {
            let now = timestamp_now();
            let id = uuid::Uuid::new_v4().to_string();

            let host = SavedHost {
                id: id.clone(),
                label: entry.host_alias.clone(),
                host: entry.hostname.clone(),
                port: entry.port as _,
                username: entry.user.clone(),
                auth_type: if entry.identity_file.is_some() {
                    "privateKey".to_string()
                } else {
                    "password".to_string()
                },
                key_path: entry.identity_file.clone(),
                group_id: None,
                color: None,
                notes: None,
                environment: None,
                os_type: None,
                startup_command: None,
                proxy_jump: entry.proxy_jump.clone(),
                proxy_jump_host_id: None,
                keep_alive_interval: entry.keep_alive_interval,
                default_shell: None,
                font_size: None,
                last_connected_at: None,
                connection_count: None,
                created_at: now.clone(),
                updated_at: now,
            };

            match db.save_host(&host) {
                Ok(()) => {
                    imported += 1;
                    alias_to_id.insert(entry.host_alias.clone(), id.clone());
                    if let Some(pj) = entry.proxy_jump.as_ref().filter(|s| !s.trim().is_empty()) {
                        pending_jumps.push((id, pj.clone()));
                    }
                }
                Err(e) => {
                    errors.push(format!("{}: {e}", entry.host_alias));
                    skipped += 1;
                }
            }
        }

        // Second pass: resolve each parsed ProxyJump value against the imported
        // (and pre-existing) hosts, then link via proxy_jump_host_id. Matching is
        // best-effort — an unresolved jump simply leaves the free-text
        // proxy_jump field in place without breaking the import.
        let existing_hosts = db.list_hosts().unwrap_or_default();
        for (host_id, jump_value) in pending_jumps {
            if let Some(jump_id) = resolve_jump_target(&jump_value, &alias_to_id, &existing_hosts) {
                // Don't let a host point at itself.
                if jump_id != host_id {
                    let _ = db.set_proxy_jump_host(&host_id, Some(jump_id.as_str()));
                }
            }
        }

        Ok(ImportResult {
            imported,
            skipped,
            errors,
        })
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;

    crate::telemetry::capture(
        "ssh_config_imported",
        serde_json::json!({ "host_count": host_count }),
    );
    result
}

fn timestamp_now() -> String {
    // SQLite-compatible datetime string
    "datetime('now')".to_string()
}

/// Resolve a raw `ProxyJump` directive value to a saved-host id.
///
/// SSH config ProxyJump values come in several shapes: a bare `Host` alias
/// (`database`), `user@host`, or `user@host:port`. We try, in order:
///   1. an exact alias match among the just-imported hosts,
///   2. a label match among all saved hosts,
///   3. a hostname match (after stripping any `user@` and `:port`).
/// Returns `None` when nothing matches — the import then leaves the free-text
/// `proxy_jump` field untouched.
fn resolve_jump_target(
    jump_value: &str,
    alias_to_id: &std::collections::HashMap<String, String>,
    existing_hosts: &[SavedHost],
) -> Option<String> {
    let value = jump_value.trim();

    // 1. Exact alias (Host block name) match among freshly imported hosts.
    if let Some(id) = alias_to_id.get(value) {
        return Some(id.clone());
    }

    // 2. Label match across all saved hosts.
    if let Some(h) = existing_hosts.iter().find(|h| h.label == value) {
        return Some(h.id.clone());
    }

    // 3. Strip `user@` and `:port`, then match on alias or hostname.
    let without_user = value.rsplit('@').next().unwrap_or(value);
    let host_part = without_user.split(':').next().unwrap_or(without_user);

    if let Some(id) = alias_to_id.get(host_part) {
        return Some(id.clone());
    }
    if let Some(h) = existing_hosts
        .iter()
        .find(|h| h.host == host_part || h.label == host_part)
    {
        return Some(h.id.clone());
    }

    None
}
