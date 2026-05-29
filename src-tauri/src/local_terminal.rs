use crate::types::{SshOutputPayload, SshStatusPayload, ConnectionStatus};
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tracing::info;

/// Manages local (non-SSH) terminal sessions.
pub struct LocalTerminalManager {
    sessions: DashMap<String, LocalSession>,
}

struct LocalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master_pty: Mutex<Box<dyn MasterPty + Send>>,
    _reader_handle: std::thread::JoinHandle<()>,
}

// Safety: All fields are behind Mutex, making concurrent access safe.
unsafe impl Sync for LocalSession {}

impl LocalTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }
}

#[tauri::command]
pub async fn local_open_pty(
    state: State<'_, LocalTerminalManager>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let sid = session_id.clone();

    let _ = app_handle.emit(
        "ssh:status",
        &SshStatusPayload {
            session_id: sid.clone(),
            status: ConnectionStatus::Connecting,
        },
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Spawn the user's default shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell
    cmd.env("TERM", "xterm-256color");

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| format!("Failed to get writer: {e}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to get reader: {e}"))?;

    let reader_sid = sid.clone();
    let reader_app = app_handle.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = reader_app.emit(
                        "ssh:output",
                        &SshOutputPayload {
                            session_id: reader_sid.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    let _ = app_handle.emit(
        "ssh:status",
        &SshStatusPayload {
            session_id: sid.clone(),
            status: ConnectionStatus::Connected,
        },
    );

    info!(session_id = %sid, shell = %shell, "Local terminal opened");

    state.sessions.insert(
        sid.clone(),
        LocalSession {
            writer: Mutex::new(writer),
            master_pty: Mutex::new(pair.master),
            _reader_handle: reader_handle,
        },
    );

    Ok(sid)
}

#[tauri::command]
pub async fn local_send_input(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, LocalTerminalManager>,
) -> Result<(), String> {
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local session not found: {session_id}"))?;
    entry
        .writer
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .write_all(&data)
        .map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn local_resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, LocalTerminalManager>,
) -> Result<(), String> {
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local session not found: {session_id}"))?;
    entry
        .master_pty
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn local_disconnect(
    session_id: String,
    state: State<'_, LocalTerminalManager>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let _ = app_handle.emit(
        "ssh:status",
        &SshStatusPayload {
            session_id: session_id.clone(),
            status: ConnectionStatus::Disconnecting,
        },
    );

    state.sessions.remove(&session_id);

    let _ = app_handle.emit(
        "ssh:status",
        &SshStatusPayload {
            session_id: session_id.clone(),
            status: ConnectionStatus::Disconnected,
        },
    );

    info!(session_id = %session_id, "Local terminal closed");
    Ok(())
}
