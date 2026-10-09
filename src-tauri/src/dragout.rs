//! Native OS drag-out (drag files from an explorer pane to the desktop/Finder),
//! shared by the remote (SFTP) and local panes. The remote side stages bytes to
//! a temp dir first (see `sftp::commands::sftp_drag_out`); the local side hands
//! its real on-disk paths straight through (`local::commands::local_drag_out`).
//! Both end by handing a fixed file list to the `drag` crate on the main thread.

use std::path::PathBuf;

use tauri::{AppHandle, Window};

/// Drag preview icon, embedded as raw bytes so it never needs to live on disk
/// (where a staged file of the same name could clobber it).
static DRAG_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// Outcome of a drag-out: whether the OS drag ended in a drop and how many
/// top-level items were dragged.
#[derive(serde::Serialize)]
pub struct DragOutResult {
    pub dropped: bool,
    pub count: usize,
}

/// Run the native OS drag on the main thread with an already-resolved list of
/// local file paths, resolving to `true` if the drag ended in a drop.
///
/// Platform note: the `drag` crate's GTK backend is X11-oriented and best-effort
/// under Wayland. The `drag` callback (Dropped/Cancel) is the only completion
/// signal we await; if a platform fails to fire it, a timeout reclaims the
/// blocking thread (reporting "not dropped") so it can't leak indefinitely.
pub async fn start_native_drag(
    app: AppHandle,
    window: Window,
    files: Vec<PathBuf>,
) -> Result<bool, String> {
    let icon_bytes = DRAG_ICON_PNG.to_vec();

    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
        let tx_cb = tx.clone();

        app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            let raw_window = window.gtk_window();
            #[cfg(not(target_os = "linux"))]
            let raw_window = tauri::Result::Ok(window.clone());

            match raw_window {
                Ok(w) => {
                    let started = drag::start_drag(
                        &w,
                        drag::DragItem::Files(files),
                        drag::Image::Raw(icon_bytes),
                        move |result, _cursor| {
                            let _ = tx_cb.send(Ok(matches!(result, drag::DragResult::Dropped)));
                        },
                        drag::Options::default(),
                    );
                    if let Err(e) = started {
                        let _ = tx.send(Err(format!("could not start drag: {e}")));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("no window handle for drag: {e}")));
                }
            }
        })
        .map_err(|e| format!("main-thread dispatch failed: {e}"))?;

        // A native drag gesture completes in seconds; this large backstop only
        // catches a platform that never fires the callback, so the thread is
        // reclaimed instead of parking forever (blocking-pool exhaustion).
        match rx.recv_timeout(std::time::Duration::from_secs(300)) {
            Ok(res) => res,
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("drag task failed: {e}"))?
}
