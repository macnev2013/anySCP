use super::{Identity, PreviewError, QuickLookManager, Snapshot, Target, MAX_BYTES};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    supported: bool,
    max_bytes: u64,
}

#[tauri::command]
pub fn quicklook_capabilities() -> Capabilities {
    Capabilities {
        supported: cfg!(target_os = "macos"),
        max_bytes: MAX_BYTES,
    }
}

#[tauri::command]
pub fn quicklook_open(
    window: WebviewWindow,
    identity: Identity,
    target: Target,
    manager: State<'_, Arc<QuickLookManager>>,
) -> Result<bool, PreviewError> {
    manager.inner().open(
        window.app_handle().clone(),
        window.label().into(),
        identity,
        target,
    )
}

#[tauri::command]
pub fn quicklook_close(
    window: WebviewWindow,
    identity: Identity,
    manager: State<'_, Arc<QuickLookManager>>,
) {
    manager.close(window.label(), &identity);
}

#[tauri::command]
pub fn quicklook_state(
    window: WebviewWindow,
    manager: State<'_, Arc<QuickLookManager>>,
) -> Snapshot {
    manager.snapshot(window.label())
}
