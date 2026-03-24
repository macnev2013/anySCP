use crate::types::{ConnectionStatus, SshError, SshOutputPayload, SshStatusPayload};
use russh::client::Handle;
use russh::ChannelMsg;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use super::handler::SshClientHandler;

/// Commands sent from the frontend to the reader/writer task.
enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Eof,
}

/// Wraps a single connected SSH session. Input is funneled through an mpsc
/// channel so the background task owns the russh channel exclusively —
/// eliminating the deadlock that occurs when a Mutex is shared between
/// the reader (blocking on `wait()`) and the writer (`data()`).
///
/// The underlying `Handle` is stored in an `Arc<Mutex<>>` so that the SFTP
/// layer can open additional channels on the same connection without taking
/// ownership and without cloning (which `Handle` does not support).
/// Minimal config needed to open additional channels on the same connection.
#[derive(Clone)]
pub struct SplitConfig {
    pub default_shell: Option<String>,
}

pub struct SshSession {
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
    reader_task: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    session_id: String,
    split_config: SplitConfig,
}

impl SshSession {
    /// Open a PTY channel on an authenticated connection, start the output
    /// reader loop, and return the session wrapper.
    pub async fn open_pty(
        handle: Handle<SshClientHandler>,
        session_id: String,
        cols: u32,
        rows: u32,
        app_handle: AppHandle,
        default_shell: Option<String>,
        startup_command: Option<String>,
    ) -> Result<Self, SshError> {
        // Wrap the handle immediately so it can be shared with SFTP later.
        let handle = Arc::new(Mutex::new(handle));

        let channel = handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        channel
            .request_pty(
                false,
                "xterm-256color",
                cols,
                rows,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        // Use custom shell if specified, otherwise request default login shell
        if let Some(shell) = &default_shell {
            channel
                .exec(false, shell.as_bytes())
                .await
                .map_err(|e| SshError::ChannelError(e.to_string()))?;
        } else {
            channel
                .request_shell(false)
                .await
                .map_err(|e| SshError::ChannelError(e.to_string()))?;
        }

        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();

        // Schedule startup command: wait for the shell to initialize (MOTD,
        // profile scripts, prompt) then send the command via the normal
        // input channel. The 800ms delay is a pragmatic choice that works
        // across most servers and shell configs.
        if let Some(cmd) = startup_command {
            let startup_tx = cmd_tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                let input = format!("{}\n", cmd);
                let _ = startup_tx.send(SessionCmd::Data(input.into_bytes()));
            });
        }

        let reader_session_id = session_id.clone();
        let reader_app = app_handle.clone();

        // The background task owns the channel exclusively. It multiplexes
        // between reading SSH output and processing frontend commands.
        let reader_task = tokio::spawn(async move {
            let mut channel = channel;

            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let payload = SshOutputPayload {
                                    session_id: reader_session_id.clone(),
                                    data: data.to_vec(),
                                };
                                let _ = reader_app.emit("ssh:output", &payload);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let payload = SshOutputPayload {
                                    session_id: reader_session_id.clone(),
                                    data: data.to_vec(),
                                };
                                let _ = reader_app.emit("ssh:output", &payload);
                            }
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                                let status_payload = SshStatusPayload {
                                    session_id: reader_session_id.clone(),
                                    status: ConnectionStatus::Disconnected,
                                };
                                let _ = reader_app.emit("ssh:status", &status_payload);
                                break;
                            }
                            _ => {}
                        }
                    }
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(SessionCmd::Data(data)) => {
                                let _ = channel.data(&data[..]).await;
                            }
                            Some(SessionCmd::Resize { cols, rows }) => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            Some(SessionCmd::Eof) | None => {
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                }
            }
        });

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.clone(),
                status: ConnectionStatus::Connected,
            },
        );

        Ok(Self {
            handle,
            cmd_tx,
            reader_task,
            session_id,
            split_config: SplitConfig { default_shell },
        })
    }

    /// Open a new PTY channel on the same authenticated connection.
    /// Used for split panes — avoids re-authentication.
    pub async fn open_split_pty(
        handle: Arc<Mutex<Handle<SshClientHandler>>>,
        session_id: String,
        cols: u32,
        rows: u32,
        app_handle: AppHandle,
        default_shell: Option<String>,
    ) -> Result<Self, SshError> {
        let channel = handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?;

        if let Some(shell) = &default_shell {
            channel
                .exec(false, shell.as_bytes())
                .await
                .map_err(|e| SshError::ChannelError(e.to_string()))?;
        } else {
            channel
                .request_shell(false)
                .await
                .map_err(|e| SshError::ChannelError(e.to_string()))?;
        }

        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();

        let reader_session_id = session_id.clone();
        let reader_app = app_handle.clone();

        let reader_task = tokio::spawn(async move {
            let mut channel = channel;
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let payload = SshOutputPayload {
                                    session_id: reader_session_id.clone(),
                                    data: data.to_vec(),
                                };
                                let _ = reader_app.emit("ssh:output", &payload);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let payload = SshOutputPayload {
                                    session_id: reader_session_id.clone(),
                                    data: data.to_vec(),
                                };
                                let _ = reader_app.emit("ssh:output", &payload);
                            }
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                                let status_payload = SshStatusPayload {
                                    session_id: reader_session_id.clone(),
                                    status: ConnectionStatus::Disconnected,
                                };
                                let _ = reader_app.emit("ssh:status", &status_payload);
                                break;
                            }
                            _ => {}
                        }
                    }
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(SessionCmd::Data(data)) => {
                                let _ = channel.data(&data[..]).await;
                            }
                            Some(SessionCmd::Resize { cols, rows }) => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            Some(SessionCmd::Eof) | None => {
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                }
            }
        });

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.clone(),
                status: ConnectionStatus::Connected,
            },
        );

        Ok(Self {
            handle,
            cmd_tx,
            reader_task,
            session_id,
            split_config: SplitConfig { default_shell },
        })
    }

    /// Return the shared Handle so the SFTP layer can lock it briefly to open
    /// its own channel on the same authenticated connection.
    pub fn ssh_handle(&self) -> Arc<Mutex<Handle<SshClientHandler>>> {
        self.handle.clone()
    }

    /// Return the config needed to open additional split channels.
    pub fn host_config(&self) -> SplitConfig {
        self.split_config.clone()
    }

    /// Write raw bytes into the PTY channel (user keystrokes).
    pub async fn send_input(&self, data: &[u8]) -> Result<(), SshError> {
        self.cmd_tx
            .send(SessionCmd::Data(data.to_vec()))
            .map_err(|_| SshError::ChannelError("session task closed".to_string()))
    }

    /// Resize the remote PTY.
    pub async fn resize_pty(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.cmd_tx
            .send(SessionCmd::Resize { cols, rows })
            .map_err(|_| SshError::ChannelError("session task closed".to_string()))
    }

    /// Gracefully disconnect: signal EOF to the background task.
    pub async fn disconnect(self) -> Result<(), SshError> {
        let _ = self.cmd_tx.send(SessionCmd::Eof);
        let _ = self.reader_task.await;
        Ok(())
    }
}
