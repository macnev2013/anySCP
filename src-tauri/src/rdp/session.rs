/// RDP session — replaces the IronRDP implementation with FreeRDP.
///
/// The WebSocket frame-server code is unchanged from the previous version.
/// The session keeps a handle to the OS thread running the FreeRDP event
/// loop, and an mpsc channel for sending input commands from tokio tasks.
use super::error::RdpError;
use super::freerdp_client::FreeRdpClient;
use super::types::{RdpConfig, RdpKeyInput, RdpMouseInput, RdpStatusPayload};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

// ── Input command sent from tokio → FreeRDP thread ─────────────────────────

enum InputCmd {
    Mouse { flags: u16, x: u16, y: u16 },
    Key { scancode: u8, extended: bool, pressed: bool },
    Disconnect,
}

// ── Session ─────────────────────────────────────────────────────────────────

pub struct RdpSession {
    /// Channel to forward input to the FreeRDP client inside its OS thread.
    input_tx: mpsc::UnboundedSender<InputCmd>,
    /// JoinHandle for the OS thread running the FreeRDP blocking event loop.
    event_loop_handle: Option<std::thread::JoinHandle<()>>,
    pub ws_port: u16,
    #[allow(dead_code)]
    session_id: String,
}

impl RdpSession {
    pub async fn connect(
        config: RdpConfig,
        session_id: String,
        app_handle: AppHandle,
    ) -> Result<Self, RdpError> {
        let sid = session_id.clone();

        let _ = app_handle.emit(
            "rdp:status",
            &RdpStatusPayload {
                session_id: sid.clone(),
                status: "Connecting".into(),
                message: None,
            },
        );

        // 1. Broadcast channel — FreeRDP end_paint pushes frames; WS clients subscribe.
        let (frame_tx, _) = broadcast::channel::<Vec<u8>>(16);
        let frame_tx_ws = frame_tx.clone();

        // 2. WebSocket server bound on a random loopback port.
        let ws_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| RdpError::IoError(format!("ws bind: {e}")))?;
        let ws_port = ws_listener
            .local_addr()
            .map_err(|e| RdpError::IoError(e.to_string()))?
            .port();

        tokio::spawn(Self::ws_server(ws_listener, frame_tx_ws));
        info!(session_id = %sid, ws_port, "RDP WS frame server ready");

        // 3. Create the FreeRDP client (allocates context, sets settings).
        let client = FreeRdpClient::new(&config, frame_tx)
            .map_err(|e| RdpError::ConnectionFailed(e))?;

        // 4. Input channel: tokio side sends InputCmd; the OS thread processes them.
        //    The Arc wraps FreeRdpClient so we can call send_*_event from the
        //    tokio-side receiver task without crossing the thread boundary in an
        //    unsound way — the methods internally use unsafe but are safe to call
        //    from any thread (FreeRDP queues input atomically).
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<InputCmd>();

        // Wrap client in Arc so both the event-loop thread and the input dispatcher
        // can hold a reference.
        let client = Arc::new(client);
        let client_for_input = Arc::clone(&client);

        // 5. Tokio task: drain input_rx and forward to FreeRDP.
        tokio::spawn(async move {
            while let Some(cmd) = input_rx.recv().await {
                match cmd {
                    InputCmd::Mouse { flags, x, y } => {
                        client_for_input.send_mouse_event(flags, x, y);
                    }
                    InputCmd::Key { scancode, extended, pressed } => {
                        client_for_input.send_key_event(scancode, extended, pressed);
                    }
                    InputCmd::Disconnect => break,
                }
            }
        });

        // 6. OS thread: runs the blocking FreeRDP event loop.
        let app_handle_clone = app_handle.clone();
        let sid_clone = sid.clone();
        let client_for_thread = Arc::clone(&client);

        let event_loop_handle = std::thread::spawn(move || {
            run_event_loop(client_for_thread, sid_clone, app_handle_clone);
        });

        let _ = app_handle.emit(
            "rdp:status",
            &RdpStatusPayload {
                session_id: sid.clone(),
                status: "Connected".into(),
                message: None,
            },
        );

        Ok(Self {
            input_tx,
            event_loop_handle: Some(event_loop_handle),
            ws_port,
            session_id,
        })
    }

    // ── WebSocket frame server (unchanged from IronRDP version) ────────────

    async fn ws_server(listener: TcpListener, frame_tx: broadcast::Sender<Vec<u8>>) {
        loop {
            let stream = match listener.accept().await {
                Ok((s, addr)) => {
                    info!("RDP WS client from {addr}");
                    s
                }
                Err(e) => {
                    warn!("WS accept: {e}");
                    continue;
                }
            };
            let ws = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    warn!("WS handshake: {e}");
                    continue;
                }
            };
            let mut rx = frame_tx.subscribe();
            let (mut sink, _) = ws.split();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(data) => {
                            if sink.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
    }

    // ── Public input / control API ──────────────────────────────────────────

    pub fn send_mouse(&self, input: RdpMouseInput) -> Result<(), RdpError> {
        let flags = mouse_flags(&input);
        self.input_tx
            .send(InputCmd::Mouse { flags, x: input.x, y: input.y })
            .map_err(|_| RdpError::ProtocolError("session closed".into()))
    }

    pub fn send_key(&self, input: RdpKeyInput) -> Result<(), RdpError> {
        self.input_tx
            .send(InputCmd::Key {
                scancode: input.scancode,
                extended: input.extended,
                pressed: input.pressed,
            })
            .map_err(|_| RdpError::ProtocolError("session closed".into()))
    }

    pub fn resize(&self, _width: u16, _height: u16) -> Result<(), RdpError> {
        // FreeRDP 3.x dynamic resize requires DesktopResize + reconnect.
        // Stubbed for now; a future ADR should address this.
        Ok(())
    }

    pub async fn disconnect(mut self) -> Result<(), RdpError> {
        // Signal the input dispatcher to stop.
        let _ = self.input_tx.send(InputCmd::Disconnect);
        // Wait for the OS thread to exit.
        if let Some(handle) = self.event_loop_handle.take() {
            // spawn_blocking so we don't block the tokio executor.
            let _ = tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            })
            .await;
        }
        Ok(())
    }
}

// ── Event loop helper (runs on OS thread) ───────────────────────────────────

/// Runs the FreeRDP event loop for the lifetime of the session.
/// Blocks the calling OS thread until the session ends.
fn run_event_loop(
    client: Arc<FreeRdpClient>,
    session_id: String,
    app_handle: AppHandle,
) {
    // We need exclusive ownership to call connect_and_run (which frees the
    // instance inside).  We wait until the input dispatcher has also dropped
    // its Arc reference.  This is guaranteed by the Disconnect command being
    // processed before this thread calls join().
    //
    // In practice the Arc count here is 2 when connect_and_run starts
    // (this thread + input dispatcher task), so try_unwrap would fail.
    // To resolve this cleanly we call a non-consuming version of the event
    // loop that we expose from FreeRdpClient.
    match client.run_blocking() {
        Ok(()) => {
            info!(session_id, "FreeRDP session ended cleanly");
            let _ = app_handle.emit(
                "rdp:status",
                &RdpStatusPayload {
                    session_id,
                    status: "Disconnected".into(),
                    message: None,
                },
            );
        }
        Err(e) => {
            error!(session_id, "FreeRDP session error: {e}");
            let _ = app_handle.emit(
                "rdp:status",
                &RdpStatusPayload {
                    session_id,
                    status: "Error".into(),
                    message: Some(e),
                },
            );
        }
    }
}

// ── Mouse flag helpers ───────────────────────────────────────────────────────

use super::ffi;

/// Build the RDP mouse flags from our input struct.
/// For button clicks, do NOT include PTR_FLAGS_MOVE — the move and click
/// must be separate events or the server ignores the click.
fn mouse_flags(input: &RdpMouseInput) -> u16 {
    let mut flags: u32 = 0;

    if let Some(ref button) = input.button {
        let btn_flag = match button.as_str() {
            "left" => ffi::PTR_FLAGS_BUTTON1,
            "right" => ffi::PTR_FLAGS_BUTTON2,
            "middle" => ffi::PTR_FLAGS_BUTTON3,
            _ => 0,
        };
        if btn_flag != 0 {
            if input.pressed {
                flags |= ffi::PTR_FLAGS_DOWN | btn_flag;
            } else {
                flags |= btn_flag; // release = button flag without DOWN
            }
        }
    } else if input.wheel_delta.is_some() {
        // wheel event
    } else {
        // Pure mouse move (no button, no wheel)
        flags |= ffi::PTR_FLAGS_MOVE;
    }

    if let Some(delta) = input.wheel_delta {
        flags |= ffi::PTR_FLAGS_WHEEL;
        let mag = (delta.unsigned_abs() as u32).min(0xFF);
        flags |= mag;
        if delta < 0 {
            flags |= ffi::PTR_FLAGS_WHEEL_NEGATIVE;
        }
    }

    flags as u16
}
