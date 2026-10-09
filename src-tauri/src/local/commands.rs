//! Tauri command wrappers for local-filesystem browsing. Thin adapters over the
//! testable core logic in `super`. Stateless — no session or manager needed.

use super::{LocalEntry, LocalError};

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalEntry>, LocalError> {
    super::list_dir(&path).await
}

#[tauri::command]
pub fn local_home_dir() -> Result<String, LocalError> {
    super::home_dir()
}

#[tauri::command]
pub fn local_roots() -> Vec<String> {
    super::roots()
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), LocalError> {
    super::mkdir(&path).await
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), LocalError> {
    super::create_file(&path).await
}

#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), LocalError> {
    super::delete(&path, is_dir).await
}

#[tauri::command]
pub async fn local_rename(old_path: String, new_path: String) -> Result<(), LocalError> {
    super::rename(&old_path, &new_path).await
}

#[tauri::command]
pub fn local_edit(
    path: String,
    editor: Option<crate::editors::EditorConfig>,
) -> Result<(), LocalError> {
    super::edit(&path, editor)
}

#[tauri::command]
pub async fn local_copy(
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<Vec<String>, LocalError> {
    super::copy_entries(source_paths, target_dir).await
}

/// Start a native OS drag-out of local files (drag to the desktop/Finder). The
/// paths are already local — the pane just lists the local FS, which the
/// frontend can already read/copy/delete — so they're handed to the OS drag in
/// place, with no staging. Only paths that exist are dragged.
#[tauri::command]
pub async fn local_drag_out(
    app: tauri::AppHandle,
    window: tauri::Window,
    paths: Vec<String>,
) -> Result<crate::dragout::DragOutResult, LocalError> {
    let files: Vec<std::path::PathBuf> = paths
        .iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if files.is_empty() {
        return Ok(crate::dragout::DragOutResult {
            dropped: false,
            count: 0,
        });
    }
    let count = files.len();
    let dropped = crate::dragout::start_native_drag(app, window, files)
        .await
        .map_err(LocalError::IoError)?;
    Ok(crate::dragout::DragOutResult { dropped, count })
}

#[tauri::command]
pub async fn local_move(
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<Vec<String>, LocalError> {
    super::move_entries(source_paths, target_dir).await
}
