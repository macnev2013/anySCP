use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{DbError, HostDb};
use crate::ssh::manager::SshManager;
use crate::types::SshError;

use super::{Snippet, SnippetFolder, SnippetSearchResult};

/// Persist (insert or update) a snippet.
#[tauri::command]
#[instrument(skip(state), fields(id = %snippet.id))]
pub async fn save_snippet(
    snippet: Snippet,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    let result = task::spawn_blocking(move || db.save_snippet(&snippet))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;
    if result.is_ok() {
        crate::telemetry::capture("snippet_saved", serde_json::json!({}));
    }
    result
}

/// Look up a single snippet by its UUID string.  Returns `None` when not found.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn get_snippet(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<Option<Snippet>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.get_snippet(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all snippets, optionally filtered by `folder_id`.
///
/// Pass `null` / `undefined` from the frontend to return snippets across all
/// folders.  Results are ordered by `sort_order ASC, name ASC`.
#[tauri::command]
#[instrument(skip(state), fields(folder_id = ?folder_id))]
pub async fn list_snippets(
    folder_id: Option<String>,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<Snippet>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_snippets(folder_id.as_deref()))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a snippet by its UUID string.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_snippet(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    let result = task::spawn_blocking(move || db.delete_snippet(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;
    if result.is_ok() {
        crate::telemetry::capture("snippet_deleted", serde_json::json!({}));
    }
    result
}

/// Full-text search over snippets using the FTS5 index.
///
/// Each whitespace-delimited token in `query` is converted to a prefix match,
/// giving instant typeahead results.  Results are ordered by relevance rank
/// and capped at `limit` rows.
#[tauri::command]
#[instrument(skip(state), fields(query = %query, limit = %limit))]
pub async fn search_snippets(
    query: String,
    limit: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<SnippetSearchResult>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.search_snippets(&query, limit))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Increment `use_count` and stamp `last_used_at` for a snippet.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn record_snippet_use(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.record_snippet_use(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Persist (insert or update) a snippet folder.
#[tauri::command]
#[instrument(skip(state), fields(id = %folder.id))]
pub async fn save_snippet_folder(
    folder: SnippetFolder,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_snippet_folder(&folder))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all snippet folders ordered by `sort_order ASC, name ASC`.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_snippet_folders(
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<SnippetFolder>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_snippet_folders())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a snippet folder by its UUID string.
///
/// Child sub-folders are cascade-deleted; snippets inside are orphaned
/// (their `folder_id` is set to NULL) rather than deleted.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_snippet_folder(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_snippet_folder(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Send a fully-resolved snippet command to an active SSH session's PTY and
/// optionally record the usage counter.
///
/// The frontend is responsible for interpolating template variables before
/// calling this command.  The resolved command must never be executed without
/// explicit user confirmation when `is_dangerous` is true.
#[tauri::command]
#[instrument(skip(ssh, db), fields(session_id = %session_id))]
pub async fn snippet_execute(
    session_id: String,
    resolved_command: String,
    snippet_id: Option<String>,
    ssh: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), SshError> {
    // 1. Write the command followed by a newline to the PTY.
    let bytes = format!("{}\n", resolved_command).into_bytes();
    ssh.send_input(&session_id, &bytes).await?;

    // 2. Record usage statistics in the background — a failure here must not
    //    propagate back to the frontend as an error.
    if let Some(sid) = snippet_id {
        let db = Arc::clone(&db);
        let _ = task::spawn_blocking(move || db.record_snippet_use(&sid)).await;
    }

    crate::telemetry::capture("snippet_executed", serde_json::json!({}));

    Ok(())
}
