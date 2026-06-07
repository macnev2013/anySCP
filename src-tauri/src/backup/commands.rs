//! Tauri commands for encrypted backup export / import.
//!
//! Both run the crypto + DB work on a blocking thread (Argon2 is deliberately
//! CPU-heavy, and the keychain/SQLite calls are synchronous). The frontend
//! picks the file path via the dialog plugin and supplies the passphrase.

use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::HostDb;

use super::{build_backup, restore_backup, BackupError};

/// Encrypt all app data with `password` and write the backup to `path`.
#[tauri::command]
#[instrument(skip(password, state), fields(path = %path))]
pub async fn backup_export(
    password: String,
    path: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), BackupError> {
    if password.is_empty() {
        return Err(BackupError::Crypto("password must not be empty".into()));
    }
    let db = Arc::clone(&state);
    task::spawn_blocking(move || {
        let bytes = build_backup(&db, &password)?;
        std::fs::write(&path, bytes).map_err(|e| BackupError::Io(e.to_string()))?;
        crate::telemetry::capture("backup_exported", serde_json::json!({}));
        Ok::<(), BackupError>(())
    })
    .await
    .map_err(|e| BackupError::Io(format!("task panicked: {e}")))?
}

/// Decrypt the backup at `path` with `password` and restore it, replacing all
/// current data and credentials. The frontend relaunches the app afterwards.
#[tauri::command]
#[instrument(skip(password, state), fields(path = %path))]
pub async fn backup_import(
    password: String,
    path: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), BackupError> {
    if password.is_empty() {
        return Err(BackupError::Crypto("password must not be empty".into()));
    }
    let db = Arc::clone(&state);
    task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| BackupError::Io(e.to_string()))?;
        restore_backup(&db, &password, &bytes)?;
        crate::telemetry::capture("backup_imported", serde_json::json!({}));
        Ok::<(), BackupError>(())
    })
    .await
    .map_err(|e| BackupError::Io(format!("task panicked: {e}")))?
}
