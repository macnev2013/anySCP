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
            .map(|h| (h.host, h.username, h.port as u16))
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

        for entry in &entries {
            let now = timestamp_now();
            let id = uuid::Uuid::new_v4().to_string();

            let host = SavedHost {
                id,
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
                keep_alive_interval: entry.keep_alive_interval,
                default_shell: None,
                font_size: None,
                last_connected_at: None,
                connection_count: None,
                protocol: "ssh".to_string(),
                rdp_domain: None,
                rdp_width: None,
                rdp_height: None,
                created_at: now.clone(),
                updated_at: now,
            };

            match db.save_host(&host) {
                Ok(()) => imported += 1,
                Err(e) => {
                    errors.push(format!("{}: {e}", entry.host_alias));
                    skipped += 1;
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

    crate::telemetry::capture("ssh_config_imported", serde_json::json!({ "host_count": host_count }));
    result
}

fn timestamp_now() -> String {
    // SQLite-compatible datetime string
    "datetime('now')".to_string()
}
