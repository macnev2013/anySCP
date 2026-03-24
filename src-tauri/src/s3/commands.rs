use std::sync::Arc;

use s3::Bucket;
use tauri::{AppHandle, Emitter, State};
use tracing::instrument;

use crate::db::HostDb;
use super::{
    S3BucketInfo, S3Connection, S3Entry, S3EntryType, S3Error, S3ListResult, S3Manager,
    S3TransferEvent,
};
use super::transfer_manager::S3TransferManager;

// ─── Connection ──────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager, db))]
pub async fn s3_connect(
    label: String,
    provider: String,
    bucket_name: String,
    region: String,
    endpoint: Option<String>,
    access_key: String,
    secret_key: String,
    path_style: bool,
    group_id: Option<String>,
    color: Option<String>,
    environment: Option<String>,
    notes: Option<String>,
    s3_manager: State<'_, Arc<S3Manager>>,
    db: State<'_, Arc<HostDb>>,
) -> Result<String, S3Error> {
    let session_id = uuid::Uuid::new_v4().to_string();

    s3_manager.connect(
        session_id.clone(),
        label.clone(),
        &bucket_name,
        &region,
        endpoint.as_deref(),
        &access_key,
        &secret_key,
        path_style,
    )?;

    // Persist to DB
    let db = Arc::clone(&db);
    let sid = session_id.clone();
    let lbl = label.clone();
    let prov = provider.clone();
    let reg = region.clone();
    let ep = endpoint.clone();
    let bkt = bucket_name.clone();
    let ps = path_style;
    let gid = group_id.clone();
    let col = color.clone();
    let env = environment.clone();
    let nts = notes.clone();
    let _ = tokio::task::spawn_blocking(move || {
        db.save_s3_connection(&sid, &lbl, &prov, &reg, ep.as_deref(), Some(&bkt), ps, gid.as_deref(), col.as_deref(), env.as_deref(), nts.as_deref())
    }).await;

    // Save credentials to vault
    let vault_key = format!("s3:{}", session_id);
    let cred = crate::vault::StoredCredential::Password { password: format!("{}:{}", access_key, secret_key) };
    let _ = tokio::task::spawn_blocking(move || {
        crate::vault::save_credential(&vault_key, &cred)
    }).await;

    crate::telemetry::capture("s3_connected", serde_json::json!({
        "provider": provider,
    }));

    Ok(session_id)
}

/// Save an S3 connection to DB + vault without connecting.
#[tauri::command]
#[instrument(skip(db))]
pub async fn s3_save_connection(
    label: String,
    provider: String,
    bucket_name: String,
    region: String,
    endpoint: Option<String>,
    access_key: String,
    secret_key: String,
    path_style: bool,
    group_id: Option<String>,
    color: Option<String>,
    environment: Option<String>,
    notes: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<String, S3Error> {
    let id = uuid::Uuid::new_v4().to_string();

    let db = Arc::clone(&db);
    let sid = id.clone();
    let lbl = label.clone();
    let prov = provider.clone();
    let reg = region.clone();
    let ep = endpoint.clone();
    let bkt = bucket_name.clone();
    let gid = group_id.clone();
    let col = color.clone();
    let env = environment.clone();
    let nts = notes.clone();

    tokio::task::spawn_blocking(move || {
        db.save_s3_connection(
            &sid, &lbl, &prov, &reg, ep.as_deref(),
            if bkt.is_empty() { None } else { Some(&bkt) },
            path_style, gid.as_deref(), col.as_deref(), env.as_deref(), nts.as_deref(),
        )
    })
    .await
    .map_err(|e| S3Error::IoError(format!("task panicked: {e}")))?
    .map_err(|e| S3Error::OperationError(e.to_string()))?;

    // Save credentials to vault
    let vault_key = format!("s3:{}", id);
    let cred = crate::vault::StoredCredential::Password {
        password: format!("{}:{}", access_key, secret_key),
    };
    let _ = tokio::task::spawn_blocking(move || {
        crate::vault::save_credential(&vault_key, &cred)
    }).await;

    crate::telemetry::capture("s3_connection_saved", serde_json::json!({ "provider": provider }));
    Ok(id)
}

/// Update an existing S3 connection. Credentials are optional — if omitted,
/// the existing vault entry is kept.
#[tauri::command]
#[instrument(skip(db))]
pub async fn s3_update_connection(
    id: String,
    label: String,
    provider: String,
    bucket_name: String,
    region: String,
    endpoint: Option<String>,
    path_style: bool,
    group_id: Option<String>,
    color: Option<String>,
    environment: Option<String>,
    notes: Option<String>,
    access_key: Option<String>,
    secret_key: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), S3Error> {
    let db = Arc::clone(&db);
    let sid = id.clone();
    let lbl = label.clone();
    let prov = provider.clone();
    let reg = region.clone();
    let ep = endpoint.clone();
    let bkt = bucket_name.clone();
    let gid = group_id.clone();
    let col = color.clone();
    let env = environment.clone();
    let nts = notes.clone();

    tokio::task::spawn_blocking(move || {
        db.save_s3_connection(
            &sid, &lbl, &prov, &reg, ep.as_deref(),
            if bkt.is_empty() { None } else { Some(&bkt) },
            path_style, gid.as_deref(), col.as_deref(), env.as_deref(), nts.as_deref(),
        )
    })
    .await
    .map_err(|e| S3Error::IoError(format!("task panicked: {e}")))?
    .map_err(|e| S3Error::OperationError(e.to_string()))?;

    // Only update credentials if both are provided
    if let (Some(ak), Some(sk)) = (access_key, secret_key) {
        if !ak.is_empty() && !sk.is_empty() {
            let vault_key = format!("s3:{}", id);
            let cred = crate::vault::StoredCredential::Password {
                password: format!("{}:{}", ak, sk),
            };
            let _ = tokio::task::spawn_blocking(move || {
                crate::vault::save_credential(&vault_key, &cred)
            }).await;
        }
    }

    Ok(())
}

#[tauri::command]
#[instrument(skip(db))]
pub async fn s3_list_connections(
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<S3Connection>, S3Error> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.list_s3_connections())
        .await
        .map_err(|e| S3Error::IoError(format!("task panicked: {e}")))?
        .map_err(|e| S3Error::OperationError(e.to_string()))
}

#[tauri::command]
#[instrument(skip(s3_manager, db))]
pub async fn s3_delete_connection(
    id: String,
    s3_manager: State<'_, Arc<S3Manager>>,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), S3Error> {
    s3_manager.disconnect(&id);

    let db = Arc::clone(&db);
    let id_clone = id.clone();
    let _ = tokio::task::spawn_blocking(move || db.delete_s3_connection(&id_clone)).await;

    // Remove vault credential
    let vault_key = format!("s3:{}", id);
    let _ = tokio::task::spawn_blocking(move || {
        crate::vault::delete_credential(&vault_key)
    }).await;

    crate::telemetry::capture("s3_connection_deleted", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
#[instrument(skip(s3_manager, db))]
pub async fn s3_reconnect(
    id: String,
    s3_manager: State<'_, Arc<S3Manager>>,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), S3Error> {
    // Load connection from DB
    let db_clone = Arc::clone(&db);
    let connections = tokio::task::spawn_blocking(move || db_clone.list_s3_connections())
        .await
        .map_err(|e| S3Error::IoError(format!("task panicked: {e}")))?
        .map_err(|e| S3Error::OperationError(e.to_string()))?;

    let conn = connections.iter().find(|c| c.id == id)
        .ok_or_else(|| S3Error::SessionNotFound(id.clone()))?;

    // Load credentials from vault
    let vault_key = format!("s3:{}", id);
    let cred = tokio::task::spawn_blocking(move || crate::vault::get_credential(&vault_key))
        .await
        .map_err(|e| S3Error::IoError(format!("task panicked: {e}")))?
        .map_err(|e| S3Error::CredentialError(format!("No saved credentials: {e}")))?;

    let (access_key, secret_key) = match cred {
        crate::vault::StoredCredential::Password { password } => {
            let parts: Vec<&str> = password.splitn(2, ':').collect();
            if parts.len() == 2 {
                (parts[0].to_string(), parts[1].to_string())
            } else {
                return Err(S3Error::CredentialError("Invalid credential format".to_string()));
            }
        }
        _ => return Err(S3Error::CredentialError("Unexpected credential type".to_string())),
    };

    let bucket_name = conn.bucket.clone().unwrap_or_default();
    s3_manager.connect(
        id,
        conn.label.clone(),
        &bucket_name,
        &conn.region,
        conn.endpoint.as_deref(),
        &access_key,
        &secret_key,
        conn.path_style,
    )?;

    crate::telemetry::capture("s3_reconnected", serde_json::json!({}));

    Ok(())
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_disconnect(
    s3_session_id: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    s3_manager.disconnect(&s3_session_id);
    Ok(())
}

// ─── Bucket operations ───────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_list_buckets(
    s3_session_id: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<Vec<S3BucketInfo>, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let creds = bucket.credentials().await
        .map_err(|e| S3Error::CredentialError(e.to_string()))?;
    let result = Bucket::list_buckets(bucket.region().clone(), creds)
        .await
        .map_err(|e| S3Error::OperationError(format!("List buckets failed: {e}")))?;

    Ok(result
        .bucket_names()
        .into_iter()
        .map(|name| S3BucketInfo {
            name: name.to_string(),
            creation_date: None,
        })
        .collect())
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_switch_bucket(
    s3_session_id: String,
    bucket_name: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    s3_manager.switch_bucket(&s3_session_id, &bucket_name).await
}

// ─── Object operations ───────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_list_objects(
    s3_session_id: String,
    prefix: String,
    continuation_token: Option<String>,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<S3ListResult, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let results = if let Some(_token) = continuation_token {
        bucket
            .list(prefix.clone(), Some("/".to_string()))
            .await
            .map_err(|e| S3Error::OperationError(format!("List objects failed: {e}")))?
    } else {
        bucket
            .list(prefix.clone(), Some("/".to_string()))
            .await
            .map_err(|e| S3Error::OperationError(format!("List objects failed: {e}")))?
    };

    let mut entries = Vec::new();

    for result in &results {
        // Directories (common prefixes)
        for cp in &result.common_prefixes.clone().unwrap_or_default() {
            let full_prefix = &cp.prefix;
            let name = full_prefix
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(full_prefix)
                .to_string();

            if !name.is_empty() {
                entries.push(S3Entry {
                    name,
                    key: full_prefix.clone(),
                    entry_type: S3EntryType::Directory,
                    size: 0,
                    last_modified: None,
                    storage_class: None,
                });
            }
        }

        // Files (objects)
        for obj in &result.contents {
            let key = &obj.key;
            // Skip the prefix itself (directory marker)
            if key == &prefix || key.ends_with('/') {
                continue;
            }

            let name = key
                .rsplit('/')
                .next()
                .unwrap_or(key)
                .to_string();

            entries.push(S3Entry {
                name,
                key: key.clone(),
                entry_type: S3EntryType::File,
                size: obj.size,
                last_modified: Some(obj.last_modified.clone()),
                storage_class: obj.storage_class.clone(),
            });
        }
    }

    // Sort: dirs first, then files alphabetically
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == S3EntryType::Directory;
        let b_dir = b.entry_type == S3EntryType::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let is_truncated = results.last().map(|r| r.is_truncated).unwrap_or(false);
    let next_token = results
        .last()
        .and_then(|r| r.next_continuation_token.clone());

    Ok(S3ListResult {
        entries,
        continuation_token: next_token,
        is_truncated,
        prefix,
    })
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_delete_object(
    s3_session_id: String,
    key: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;
    bucket
        .delete_object(&key)
        .await
        .map_err(|e| S3Error::OperationError(format!("Delete failed: {e}")))?;
    crate::telemetry::capture("s3_object_deleted", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_delete_objects(
    s3_session_id: String,
    keys: Vec<String>,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<u32, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;
    let mut deleted = 0u32;

    for key in &keys {
        match bucket.delete_object(key).await {
            Ok(_) => deleted += 1,
            Err(e) => {
                tracing::warn!(key = %key, error = %e, "Failed to delete object");
            }
        }
    }

    crate::telemetry::capture("s3_objects_deleted_batch", serde_json::json!({ "count": deleted }));
    Ok(deleted)
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_create_folder(
    s3_session_id: String,
    prefix: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;
    let key = if prefix.ends_with('/') {
        prefix
    } else {
        format!("{prefix}/")
    };

    bucket
        .put_object(&key, &[])
        .await
        .map_err(|e| S3Error::OperationError(format!("Create folder failed: {e}")))?;

    crate::telemetry::capture("s3_folder_created", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_presign_url(
    s3_session_id: String,
    key: String,
    expiry_secs: u32,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<String, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let url = bucket
        .presign_get(&key, expiry_secs, None)
        .await
        .map_err(|e| S3Error::OperationError(format!("Presign failed: {e}")))?;

    crate::telemetry::capture("s3_presign_url_generated", serde_json::json!({ "expiry_secs": expiry_secs }));
    Ok(url)
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_head_object(
    s3_session_id: String,
    key: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<S3Entry, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let (head, _code) = bucket
        .head_object(&key)
        .await
        .map_err(|e| S3Error::OperationError(format!("Head object failed: {e}")))?;

    let name = key
        .rsplit('/')
        .next()
        .unwrap_or(&key)
        .to_string();

    Ok(S3Entry {
        name,
        key: key.clone(),
        entry_type: if key.ends_with('/') {
            S3EntryType::Directory
        } else {
            S3EntryType::File
        },
        size: head.content_length.unwrap_or(0) as u64,
        last_modified: head.last_modified,
        storage_class: None,
    })
}

// ─── Upload / Download ───────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_upload_file(
    s3_session_id: String,
    local_path: String,
    key: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let mut file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot read {local_path}: {e}")))?;

    bucket
        .put_object_stream(&mut file, &key)
        .await
        .map_err(|e| S3Error::OperationError(format!("Upload failed: {e}")))?;

    Ok(())
}

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_download_file(
    s3_session_id: String,
    key: String,
    local_path: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    let response = bucket
        .get_object(&key)
        .await
        .map_err(|e| S3Error::OperationError(format!("Download failed: {e}")))?;

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&local_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| S3Error::IoError(format!("Cannot create directory: {e}")))?;
    }

    tokio::fs::write(&local_path, response.bytes())
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot write {local_path}: {e}")))?;

    Ok(())
}

// ─── File creation ──────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_create_file(
    s3_session_id: String,
    key: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;
    bucket
        .put_object(&key, &[])
        .await
        .map_err(|e| S3Error::OperationError(format!("Create file failed: {e}")))?;
    crate::telemetry::capture("s3_file_created", serde_json::json!({}));
    Ok(())
}

// ─── Multi-file upload (drag-drop) ──────────────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_upload_files(
    s3_session_id: String,
    local_paths: Vec<String>,
    prefix: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<u32, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;
    let mut uploaded = 0u32;

    for local_path in &local_paths {
        let path = std::path::Path::new(local_path);
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|e| S3Error::IoError(format!("Cannot stat {local_path}: {e}")))?;

        if meta.is_dir() {
            uploaded += upload_directory_recursive(&bucket, path, &prefix).await?;
        } else {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let key = format!("{prefix}{file_name}");

            let mut file = tokio::fs::File::open(path)
                .await
                .map_err(|e| S3Error::IoError(format!("Cannot read {local_path}: {e}")))?;

            bucket
                .put_object_stream(&mut file, &key)
                .await
                .map_err(|e| S3Error::OperationError(format!("Upload failed for {file_name}: {e}")))?;
            uploaded += 1;
        }
    }

    Ok(uploaded)
}

/// Recursively upload a local directory to S3 under the given prefix.
async fn upload_directory_recursive(
    bucket: &s3::Bucket,
    local_dir: &std::path::Path,
    prefix: &str,
) -> Result<u32, S3Error> {
    let dir_name = local_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".to_string());
    let sub_prefix = format!("{prefix}{dir_name}/");
    let mut uploaded = 0u32;

    let mut read_dir = tokio::fs::read_dir(local_dir)
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot read directory: {e}")))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot read directory entry: {e}")))?
    {
        let entry_path = entry.path();
        let meta = entry
            .metadata()
            .await
            .map_err(|e| S3Error::IoError(format!("Cannot stat entry: {e}")))?;

        if meta.is_dir() {
            uploaded += Box::pin(upload_directory_recursive(bucket, &entry_path, &sub_prefix)).await?;
        } else {
            let file_name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let key = format!("{sub_prefix}{file_name}");

            let mut file = tokio::fs::File::open(&entry_path)
                .await
                .map_err(|e| S3Error::IoError(format!("Cannot read file: {e}")))?;

            bucket
                .put_object_stream(&mut file, &key)
                .await
                .map_err(|e| S3Error::OperationError(format!("Upload failed for {file_name}: {e}")))?;
            uploaded += 1;
        }
    }

    Ok(uploaded)
}

// ─── Delete prefix (recursive folder delete) ────────────────────────────────

#[tauri::command]
#[instrument(skip(s3_manager))]
pub async fn s3_delete_prefix(
    s3_session_id: String,
    prefix: String,
    s3_manager: State<'_, Arc<S3Manager>>,
) -> Result<u32, S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    // List all objects under this prefix (no delimiter = recursive)
    let results = bucket
        .list(prefix.clone(), None)
        .await
        .map_err(|e| S3Error::OperationError(format!("List for delete failed: {e}")))?;

    let mut deleted = 0u32;
    for result in &results {
        for obj in &result.contents {
            match bucket.delete_object(&obj.key).await {
                Ok(_) => deleted += 1,
                Err(e) => {
                    tracing::warn!(key = %obj.key, error = %e, "Failed to delete object");
                }
            }
        }
    }

    crate::telemetry::capture("s3_prefix_deleted", serde_json::json!({ "count": deleted }));
    Ok(deleted)
}

// ─── Transfer Manager commands ───────────────────────────────────────────────

/// Enqueue one or more local paths for upload to S3 under `prefix`.
/// Returns the generated `transfer_id`s for each path.
#[tauri::command]
#[instrument(skip(s3_transfer_manager), fields(s3_session_id = %s3_session_id))]
pub async fn s3_enqueue_upload(
    s3_session_id: String,
    local_paths: Vec<String>,
    prefix: String,
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<Vec<String>, S3Error> {
    let file_count = local_paths.len();
    let paths: Vec<std::path::PathBuf> = local_paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect();

    let result = s3_transfer_manager
        .enqueue_upload(s3_session_id, paths, prefix)
        .await;
    if result.is_ok() {
        crate::telemetry::capture("s3_upload_enqueued", serde_json::json!({ "file_count": file_count }));
    }
    result
}

/// Enqueue one or more S3 object keys for download to `local_dir`.
/// Returns the generated `transfer_id`s for each key.
#[tauri::command]
#[instrument(skip(s3_transfer_manager), fields(s3_session_id = %s3_session_id))]
pub async fn s3_enqueue_download(
    s3_session_id: String,
    keys: Vec<String>,
    local_dir: String,
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<Vec<String>, S3Error> {
    let file_count = keys.len();
    let result = s3_transfer_manager
        .enqueue_download(s3_session_id, keys, std::path::PathBuf::from(local_dir))
        .await;
    if result.is_ok() {
        crate::telemetry::capture("s3_download_enqueued", serde_json::json!({ "file_count": file_count }));
    }
    result
}

/// Cancel a queued or in-progress S3 transfer.
#[tauri::command]
#[instrument(skip(s3_transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn s3_cancel_transfer(
    transfer_id: String,
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<(), S3Error> {
    s3_transfer_manager.cancel(&transfer_id)
}

/// Retry a failed or cancelled S3 transfer.
#[tauri::command]
#[instrument(skip(s3_transfer_manager), fields(transfer_id = %transfer_id))]
pub async fn s3_retry_transfer(
    transfer_id: String,
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<(), S3Error> {
    s3_transfer_manager.retry(&transfer_id)
}

/// Return a snapshot of every known S3 transfer job.
#[tauri::command]
#[instrument(skip(s3_transfer_manager))]
pub async fn s3_list_transfers(
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<Vec<S3TransferEvent>, S3Error> {
    Ok(s3_transfer_manager.list_all())
}

/// Remove completed, failed, and cancelled jobs from the registry.
#[tauri::command]
#[instrument(skip(s3_transfer_manager))]
pub async fn s3_clear_finished_transfers(
    s3_transfer_manager: State<'_, Arc<S3TransferManager>>,
) -> Result<(), S3Error> {
    s3_transfer_manager.clear_finished();
    Ok(())
}

// ─── Edit in VS Code ─────────────────────────────────────────────────────────

/// Download an S3 object to a temp directory, open it in VS Code,
/// watch for saves, and re-upload to S3 each time the file is saved.
#[tauri::command]
#[instrument(skip(s3_manager, app_handle), fields(s3_session_id = %s3_session_id, key = %key))]
pub async fn s3_edit_in_vscode(
    s3_session_id: String,
    key: String,
    s3_manager: State<'_, Arc<S3Manager>>,
    app_handle: AppHandle,
) -> Result<(), S3Error> {
    let bucket = s3_manager.get_bucket(&s3_session_id)?;

    // Extract filename from the S3 key.
    let file_name = std::path::Path::new(&key)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    // Create temp directory.
    let temp_dir = std::env::temp_dir().join("anyscp-edit");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| S3Error::IoError(e.to_string()))?;

    let local_path = temp_dir.join(&file_name);

    // 1. Download the object from S3.
    {
        let response = bucket
            .get_object(&key)
            .await
            .map_err(|e| S3Error::OperationError(format!("S3 GET failed for {key}: {e}")))?;

        tokio::fs::write(&local_path, response.bytes())
            .await
            .map_err(|e| S3Error::IoError(e.to_string()))?;
    }

    // 2. Open in VS Code (without --wait so it returns immediately).
    tokio::process::Command::new("code")
        .arg(&local_path)
        .spawn()
        .map_err(|e| {
            S3Error::IoError(format!(
                "Failed to open VS Code: {e}. Is 'code' in your PATH?"
            ))
        })?;

    crate::telemetry::capture("edit_in_vscode", serde_json::json!({ "source": "s3" }));

    // 3. Watch for file saves and re-upload on each save.
    let key_bg = key.clone();
    let local_path_bg = local_path.clone();
    let app_handle_bg = app_handle.clone();
    let sid = s3_session_id.clone();
    let s3_manager_bg = Arc::clone(&s3_manager);

    tokio::task::spawn_blocking(move || {
        use notify::{Config, Event, EventKind, RecursiveMode, Watcher};
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Event>();

        let mut watcher = notify::RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            Config::default(),
        )
        .expect("Failed to create file watcher");

        watcher
            .watch(&local_path_bg, RecursiveMode::NonRecursive)
            .expect("Failed to watch file");

        tracing::info!(
            local_path = %local_path_bg.display(),
            key = %key_bg,
            "Watching S3 edit file for saves..."
        );

        // Watch for 30 minutes max, then stop.
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(30 * 60);

        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(event) => {
                    // Only re-upload on actual write/modify events.
                    let is_write = matches!(
                        event.kind,
                        EventKind::Modify(notify::event::ModifyKind::Data(_))
                            | EventKind::Modify(notify::event::ModifyKind::Any)
                    );

                    if !is_write {
                        continue;
                    }

                    // Small debounce — editors may write multiple times.
                    std::thread::sleep(std::time::Duration::from_millis(300));

                    // Read and re-upload.
                    match std::fs::read(&local_path_bg) {
                        Ok(contents) => {
                            let key_inner = key_bg.clone();
                            let app_handle_inner = app_handle_bg.clone();
                            let sid_inner = sid.clone();
                            let s3_manager_inner = Arc::clone(&s3_manager_bg);

                            let rt = tokio::runtime::Handle::current();
                            rt.spawn(async move {
                                let bucket = match s3_manager_inner.get_bucket(&sid_inner) {
                                    Ok(b) => b,
                                    Err(e) => {
                                        tracing::error!(
                                            error = %e,
                                            "S3 session gone during edit"
                                        );
                                        return;
                                    }
                                };

                                match bucket.put_object(&key_inner, &contents).await {
                                    Ok(_) => {
                                        tracing::info!(
                                            key = %key_inner,
                                            "S3 object re-uploaded on save"
                                        );
                                        let _ = app_handle_inner
                                            .emit("s3:file-edited", &sid_inner);
                                    }
                                    Err(e) => {
                                        tracing::error!(
                                            error = %e,
                                            "Failed to re-upload S3 object on save"
                                        );
                                    }
                                }
                            });
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "Failed to read local file on save");
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if std::time::Instant::now() > deadline {
                        tracing::info!("S3 edit file watcher expired after 30 minutes");
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        // Cleanup temp file.
        let _ = std::fs::remove_file(&local_path_bg);
    });

    Ok(())
}
