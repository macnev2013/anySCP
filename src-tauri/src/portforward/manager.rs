use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{info, error};

use crate::ssh::handler::SshClientHandler;
use crate::types::SshError;

use super::{TunnelState, TunnelStatus};

struct ActiveTunnel {
    rule_id: String,
    local_port: u32,
    cancel_token: CancellationToken,
    connection_count: Arc<AtomicU32>,
    status: TunnelState,
    error: Option<String>,
}

pub struct PortForwardManager {
    tunnels: Arc<DashMap<String, ActiveTunnel>>,
    app_handle: AppHandle,
}

impl PortForwardManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            tunnels: Arc::new(DashMap::new()),
            app_handle,
        }
    }

    pub async fn start_tunnel(
        &self,
        rule_id: String,
        handle: Arc<tokio::sync::Mutex<russh::client::Handle<SshClientHandler>>>,
        bind_address: String,
        local_port: u32,
        remote_host: String,
        remote_port: u32,
    ) -> Result<TunnelStatus, SshError> {
        // Stop existing tunnel for this rule if any
        let _ = self.stop_tunnel(&rule_id);

        // Bind local TCP listener
        let addr = format!("{bind_address}:{local_port}");
        let listener = TcpListener::bind(&addr).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                SshError::IoError(format!("Port {local_port} is already in use"))
            } else {
                SshError::IoError(format!("Failed to bind {addr}: {e}"))
            }
        })?;

        // Get the actual bound port (may differ if local_port was 0)
        let actual_port = listener.local_addr()
            .map(|a| a.port() as u32)
            .unwrap_or(local_port);

        let cancel_token = CancellationToken::new();
        let connection_count = Arc::new(AtomicU32::new(0));

        let tunnel = ActiveTunnel {
            rule_id: rule_id.clone(),
            local_port: actual_port,
            cancel_token: cancel_token.clone(),
            connection_count: connection_count.clone(),
            status: TunnelState::Active,
            error: None,
        };

        self.tunnels.insert(rule_id.clone(), tunnel);

        // Emit status
        let status = TunnelStatus {
            rule_id: rule_id.clone(),
            status: TunnelState::Active,
            local_port: actual_port,
            connections: 0,
            error: None,
        };
        let _ = self.app_handle.emit("pf:status", &status);

        info!(rule_id = %rule_id, addr = %addr, actual_port = actual_port, "Tunnel started");

        // Spawn the listener task
        let app_handle = self.app_handle.clone();
        let rid = rule_id.clone();
        let tunnels = Arc::clone(&self.tunnels);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        info!(rule_id = %rid, "Tunnel cancelled");
                        break;
                    }
                    accept = listener.accept() => {
                        match accept {
                            Ok((tcp_stream, peer_addr)) => {
                                let count = connection_count.fetch_add(1, Ordering::Relaxed) + 1;
                                info!(rule_id = %rid, peer = %peer_addr, connections = count, "New connection");

                                let handle = handle.clone();
                                let rhost = remote_host.clone();
                                let rport = remote_port;
                                let cancel = cancel_token.clone();
                                let conn_count = connection_count.clone();
                                let app = app_handle.clone();
                                let rule_id_inner = rid.clone();

                                tokio::spawn(async move {
                                    let result = proxy_connection(
                                        tcp_stream,
                                        handle,
                                        &rhost,
                                        rport,
                                        &peer_addr.to_string(),
                                        peer_addr.port() as u32,
                                        cancel,
                                    )
                                    .await;

                                    let remaining = conn_count.fetch_sub(1, Ordering::Relaxed) - 1;
                                    if let Err(e) = result {
                                        error!(rule_id = %rule_id_inner, error = %e, "Connection proxy error");
                                    }

                                    let _ = app.emit("pf:status", &TunnelStatus {
                                        rule_id: rule_id_inner,
                                        status: TunnelState::Active,
                                        local_port: actual_port,
                                        connections: remaining,
                                        error: None,
                                    });
                                });
                            }
                            Err(e) => {
                                error!(rule_id = %rid, error = %e, "Accept error");
                            }
                        }
                    }
                }
            }

            // Cleanup: update tunnel status
            if let Some(mut tunnel) = tunnels.get_mut(&rid) {
                tunnel.status = TunnelState::Stopped;
            }
            let _ = app_handle.emit("pf:status", &TunnelStatus {
                rule_id: rid,
                status: TunnelState::Stopped,
                local_port: actual_port,
                connections: 0,
                error: None,
            });
        });

        Ok(status)
    }

    pub fn stop_tunnel(&self, rule_id: &str) -> Result<(), SshError> {
        if let Some((_, tunnel)) = self.tunnels.remove(rule_id) {
            tunnel.cancel_token.cancel();
            info!(rule_id = %rule_id, "Tunnel stopped");
            let _ = self.app_handle.emit("pf:status", &TunnelStatus {
                rule_id: rule_id.to_string(),
                status: TunnelState::Stopped,
                local_port: tunnel.local_port,
                connections: 0,
                error: None,
            });
        }
        Ok(())
    }

    pub fn list_active(&self) -> Vec<TunnelStatus> {
        self.tunnels
            .iter()
            .map(|entry| {
                let t = entry.value();
                TunnelStatus {
                    rule_id: t.rule_id.clone(),
                    status: t.status.clone(),
                    local_port: t.local_port,
                    connections: t.connection_count.load(Ordering::Relaxed),
                    error: t.error.clone(),
                }
            })
            .collect()
    }
}

/// Proxy data bidirectionally between a local TCP connection and an SSH direct-tcpip channel.
async fn proxy_connection(
    mut tcp_stream: tokio::net::TcpStream,
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<SshClientHandler>>>,
    remote_host: &str,
    remote_port: u32,
    originator_address: &str,
    originator_port: u32,
    cancel: CancellationToken,
) -> Result<(), SshError> {
    // Open a direct-tcpip channel
    let channel = {
        let h = handle.lock().await;
        h.channel_open_direct_tcpip(
            remote_host,
            remote_port,
            originator_address,
            originator_port,
        )
        .await
        .map_err(|e| SshError::ChannelError(format!("direct-tcpip failed: {e}")))?
    };

    let mut ssh_stream = channel.into_stream();
    let (mut tcp_read, mut tcp_write) = tcp_stream.split();

    let mut buf_ssh = vec![0u8; 32 * 1024];
    let mut buf_tcp = vec![0u8; 32 * 1024];

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,

            n = tcp_read.read(&mut buf_tcp) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ssh_stream.write_all(&buf_tcp[..n]).await.is_err() { break; }
                    }
                }
            }

            n = ssh_stream.read(&mut buf_ssh) => {
                match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tcp_write.write_all(&buf_ssh[..n]).await.is_err() { break; }
                    }
                }
            }
        }
    }

    Ok(())
}
