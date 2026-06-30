use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use russh::client;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::ssh::handler::SshClientHandler;
use crate::ssh::manager::SshManager;
use crate::types::{HostConfig, SshError};

use super::{ForwardType, TunnelState, TunnelStatus};

/// Monotonic id distinguishing successive tunnel instances for the same rule.
/// Lets a stale listener task tell whether the map entry under its rule id is
/// still *its own* instance before touching it — so restarting a tunnel (e.g.
/// on reconnect) can't have the previous instance's teardown clobber the new
/// one's status/event.
static INSTANCE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_instance_id() -> u64 {
    INSTANCE_SEQ.fetch_add(1, Ordering::Relaxed)
}

struct ActiveTunnel {
    rule_id: String,
    instance_id: u64,
    local_port: u32,
    cancel_token: CancellationToken,
    connection_count: Arc<AtomicU32>,
    status: TunnelState,
    error: Option<String>,
    /// Host this tunnel belongs to (if any). Used to tear down auto-started
    /// tunnels when their host disconnects.
    host_id: Option<String>,
    /// Whether this tunnel was started automatically on host connect.
    auto_started: bool,
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

    /// Start a tunnel for `rule_id`. Establishes a dedicated SSH connection from
    /// `config` (owned for the tunnel's lifetime) and brings up the appropriate
    /// forwarding for `forward_type`:
    ///
    /// * `Local` — bind a local listener, proxy each connection to
    ///   `remote_host:remote_port` over a `direct-tcpip` channel.
    /// * `Dynamic` — bind a local SOCKS5 proxy; the destination of each
    ///   connection is negotiated per-request (`remote_host`/`remote_port` are
    ///   ignored).
    /// * `Remote` — ask the server to listen on `bind_address:local_port` and
    ///   forward back to `remote_host:remote_port` on this machine.
    ///
    /// Any previously-active tunnel for the same `rule_id` is stopped first, so
    /// re-starting (e.g. on reconnect) never collides with its own leftover
    /// listener.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_tunnel(
        &self,
        rule_id: String,
        forward_type: ForwardType,
        config: HostConfig,
        bind_address: String,
        local_port: u32,
        remote_host: String,
        remote_port: u32,
        host_id: Option<String>,
        auto_started: bool,
    ) -> Result<TunnelStatus, SshError> {
        // Stop existing tunnel for this rule if any (clean slate).
        let _ = self.stop_tunnel(&rule_id);

        match forward_type {
            ForwardType::Local | ForwardType::Dynamic => {
                self.start_listener_tunnel(
                    rule_id,
                    forward_type,
                    config,
                    bind_address,
                    local_port,
                    remote_host,
                    remote_port,
                    host_id,
                    auto_started,
                )
                .await
            }
            ForwardType::Remote => {
                self.start_remote_tunnel(
                    rule_id,
                    config,
                    bind_address,
                    local_port,
                    remote_host,
                    remote_port,
                    host_id,
                    auto_started,
                )
                .await
            }
        }
    }

    /// Local & Dynamic forwarding: bind a local TCP listener and proxy each
    /// accepted connection over the SSH connection.
    #[allow(clippy::too_many_arguments)]
    async fn start_listener_tunnel(
        &self,
        rule_id: String,
        forward_type: ForwardType,
        config: HostConfig,
        bind_address: String,
        local_port: u32,
        remote_host: String,
        remote_port: u32,
        host_id: Option<String>,
        auto_started: bool,
    ) -> Result<TunnelStatus, SshError> {
        // Bind the local listener BEFORE connecting so a port conflict fails fast
        // and surfaces the familiar "already in use" message.
        let addr = format!("{bind_address}:{local_port}");
        let listener = TcpListener::bind(&addr).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                SshError::IoError(format!("Port {local_port} is already in use"))
            } else if e.kind() == std::io::ErrorKind::PermissionDenied {
                // Ports below 1024 are privileged on most OSes and can't be bound
                // without elevated rights — the common cause of this failure.
                if local_port < 1024 {
                    SshError::IoError(format!(
                        "Port {local_port} requires elevated privileges (ports below 1024). \
                         Pick a higher local port for this tunnel."
                    ))
                } else {
                    SshError::IoError(format!("Permission denied binding {addr}"))
                }
            } else {
                SshError::IoError(format!("Failed to bind {addr}: {e}"))
            }
        })?;
        let actual_port = listener
            .local_addr()
            .map(|a| a.port() as u32)
            .unwrap_or(local_port);

        // Establish the dedicated SSH connection used by this tunnel.
        let russh_config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });
        let (handle, jump_handles) = SshManager::establish(&config, russh_config).await?;
        let handle = Arc::new(tokio::sync::Mutex::new(handle));

        let cancel_token = CancellationToken::new();
        let connection_count = Arc::new(AtomicU32::new(0));
        let instance_id = next_instance_id();

        self.tunnels.insert(
            rule_id.clone(),
            ActiveTunnel {
                rule_id: rule_id.clone(),
                instance_id,
                local_port: actual_port,
                cancel_token: cancel_token.clone(),
                connection_count: connection_count.clone(),
                status: TunnelState::Active,
                error: None,
                host_id,
                auto_started,
            },
        );

        let status = TunnelStatus {
            rule_id: rule_id.clone(),
            status: TunnelState::Active,
            local_port: actual_port,
            connections: 0,
            error: None,
        };
        let _ = self.app_handle.emit("pf:status", &status);
        info!(rule_id = %rule_id, addr = %addr, actual_port, ?forward_type, "Tunnel started");

        let app_handle = self.app_handle.clone();
        let rid = rule_id.clone();
        let tunnels = Arc::clone(&self.tunnels);

        tokio::spawn(async move {
            // Hold the jump-host chain alive for the tunnel's lifetime.
            let _jump_handles = jump_handles;
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
                                    let result = match forward_type {
                                        ForwardType::Dynamic => {
                                            handle_socks_connection(tcp_stream, handle, peer_addr, cancel).await
                                        }
                                        _ => {
                                            proxy_to_remote(
                                                tcp_stream,
                                                handle,
                                                &rhost,
                                                rport,
                                                &peer_addr.to_string(),
                                                peer_addr.port() as u32,
                                                cancel,
                                            )
                                            .await
                                        }
                                    };

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

            // Only remove + announce Stopped if the map entry is still *this*
            // instance. If `stop_tunnel` already removed it, or a restart
            // replaced it with a newer instance, leave that newer state intact
            // (it owns its own Active/Stopped events).
            if tunnels
                .remove_if(&rid, |_, t| t.instance_id == instance_id)
                .is_some()
            {
                let _ = app_handle.emit(
                    "pf:status",
                    &TunnelStatus {
                        rule_id: rid,
                        status: TunnelState::Stopped,
                        local_port: actual_port,
                        connections: 0,
                        error: None,
                    },
                );
            }
        });

        Ok(status)
    }

    /// Remote forwarding: open a dedicated SSH connection whose handler routes
    /// server-initiated `forwarded-tcpip` channels to a local destination, then
    /// ask the server to listen on `bind_address:listen_port`.
    #[allow(clippy::too_many_arguments)]
    async fn start_remote_tunnel(
        &self,
        rule_id: String,
        config: HostConfig,
        bind_address: String,
        listen_port: u32,
        dest_host: String,
        dest_port: u32,
        host_id: Option<String>,
        auto_started: bool,
    ) -> Result<TunnelStatus, SshError> {
        if config.jump_host.is_some() {
            return Err(SshError::IoError(
                "Remote forwarding through a ProxyJump host is not supported".to_string(),
            ));
        }

        let russh_config = Arc::new(client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });

        let handler = RemoteForwardHandler {
            dest_host: dest_host.clone(),
            dest_port,
            rule_id: rule_id.clone(),
        };

        let addr = format!("{}:{}", config.host, config.port);
        let mut handle = client::connect(russh_config, &addr, handler)
            .await
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
        SshManager::authenticate_handle(&mut handle, &config).await?;

        // Ask the server to start listening. A bind conflict on the *server* is
        // reported here as a request denial.
        handle
            .tcpip_forward(bind_address.clone(), listen_port)
            .await
            .map_err(|e| {
                SshError::IoError(format!(
                    "server refused to forward {bind_address}:{listen_port}: {e}"
                ))
            })?;

        let cancel_token = CancellationToken::new();
        let connection_count = Arc::new(AtomicU32::new(0));
        let instance_id = next_instance_id();

        self.tunnels.insert(
            rule_id.clone(),
            ActiveTunnel {
                rule_id: rule_id.clone(),
                instance_id,
                local_port: listen_port,
                cancel_token: cancel_token.clone(),
                connection_count: connection_count.clone(),
                status: TunnelState::Active,
                error: None,
                host_id,
                auto_started,
            },
        );

        let status = TunnelStatus {
            rule_id: rule_id.clone(),
            status: TunnelState::Active,
            local_port: listen_port,
            connections: 0,
            error: None,
        };
        let _ = self.app_handle.emit("pf:status", &status);
        info!(rule_id = %rule_id, bind = %bind_address, listen_port, "Remote tunnel started");

        let app_handle = self.app_handle.clone();
        let rid = rule_id.clone();
        let tunnels = Arc::clone(&self.tunnels);
        let bind_for_cancel = bind_address.clone();

        // Keep the connection (and thus the server-side listener) alive until the
        // tunnel is cancelled; the handler drives forwarded channels meanwhile.
        tokio::spawn(async move {
            cancel_token.cancelled().await;
            let _ = handle
                .cancel_tcpip_forward(bind_for_cancel, listen_port)
                .await;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            drop(handle);

            // Only announce Stopped if this instance is still the live one (see
            // the listener-tunnel teardown for the reasoning).
            if tunnels
                .remove_if(&rid, |_, t| t.instance_id == instance_id)
                .is_some()
            {
                let _ = app_handle.emit(
                    "pf:status",
                    &TunnelStatus {
                        rule_id: rid,
                        status: TunnelState::Stopped,
                        local_port: listen_port,
                        connections: 0,
                        error: None,
                    },
                );
            }
        });

        Ok(status)
    }

    pub fn stop_tunnel(&self, rule_id: &str) -> Result<(), SshError> {
        if let Some((_, tunnel)) = self.tunnels.remove(rule_id) {
            tunnel.cancel_token.cancel();
            info!(rule_id = %rule_id, "Tunnel stopped");
            let _ = self.app_handle.emit(
                "pf:status",
                &TunnelStatus {
                    rule_id: rule_id.to_string(),
                    status: TunnelState::Stopped,
                    local_port: tunnel.local_port,
                    connections: 0,
                    error: None,
                },
            );
        }
        Ok(())
    }

    /// Stop every auto-started tunnel belonging to `host_id`. Called when the
    /// host disconnects so auto-activated tunnels are torn down cleanly with no
    /// orphaned listeners. Manually-started tunnels (or tunnels for other hosts)
    /// are left running.
    pub fn stop_auto_started_for_host(&self, host_id: &str) {
        let to_stop: Vec<String> = self
            .tunnels
            .iter()
            .filter(|e| e.value().auto_started && e.value().host_id.as_deref() == Some(host_id))
            .map(|e| e.key().clone())
            .collect();
        for rule_id in to_stop {
            let _ = self.stop_tunnel(&rule_id);
        }
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

/// Proxy data bidirectionally between a local TCP connection and an SSH
/// `direct-tcpip` channel to a fixed `remote_host:remote_port` (Local forward).
async fn proxy_to_remote(
    tcp_stream: TcpStream,
    handle: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
    remote_host: &str,
    remote_port: u32,
    originator_address: &str,
    originator_port: u32,
    cancel: CancellationToken,
) -> Result<(), SshError> {
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
    pump(tcp_stream, channel.into_stream(), cancel).await;
    Ok(())
}

/// Handle a single SOCKS5 client connection (Dynamic forward): negotiate the
/// target, open a `direct-tcpip` channel to it, and proxy.
async fn handle_socks_connection(
    mut tcp_stream: TcpStream,
    handle: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
    peer_addr: std::net::SocketAddr,
    cancel: CancellationToken,
) -> Result<(), SshError> {
    let (host, port) = socks5_negotiate(&mut tcp_stream).await?;

    let channel = {
        let h = handle.lock().await;
        h.channel_open_direct_tcpip(
            host.clone(),
            port as u32,
            peer_addr.ip().to_string(),
            peer_addr.port() as u32,
        )
        .await
    };

    // Reply to the SOCKS client based on whether the channel opened.
    match channel {
        Ok(channel) => {
            // Success reply (bound address reported as 0.0.0.0:0 — clients ignore it).
            tcp_stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .map_err(|e| SshError::IoError(e.to_string()))?;
            pump(tcp_stream, channel.into_stream(), cancel).await;
            Ok(())
        }
        Err(e) => {
            // 0x05 = connection refused (general failure mapping).
            let _ = tcp_stream
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            Err(SshError::ChannelError(format!(
                "SOCKS direct-tcpip to {host}:{port} failed: {e}"
            )))
        }
    }
}

/// Minimal SOCKS5 negotiation: greeting (no-auth only) + CONNECT request.
/// Returns the requested `(host, port)`. BIND/UDP and authenticated greetings
/// are rejected.
async fn socks5_negotiate(stream: &mut TcpStream) -> Result<(String, u16), SshError> {
    let io = |e: std::io::Error| SshError::IoError(e.to_string());

    // ── Greeting: VER, NMETHODS, METHODS… ──
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] != 0x05 {
        return Err(SshError::IoError("not a SOCKS5 client".to_string()));
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0x00) {
        // No acceptable methods.
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err(SshError::IoError(
            "SOCKS5 client requires authentication (unsupported)".to_string(),
        ));
    }
    // Select "no authentication required".
    stream.write_all(&[0x05, 0x00]).await.map_err(io)?;

    // ── Request: VER, CMD, RSV, ATYP, ADDR, PORT ──
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(io)?;
    if req[0] != 0x05 {
        return Err(SshError::IoError("bad SOCKS5 request".to_string()));
    }
    if req[1] != 0x01 {
        // Only CONNECT is supported.
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(SshError::IoError(
            "only SOCKS5 CONNECT is supported".to_string(),
        ));
    }

    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv4Addr::new(a[0], a[1], a[2], a[3]).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8(name)
                .map_err(|_| SshError::IoError("invalid SOCKS5 hostname".to_string()))?
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(io)?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        other => {
            return Err(SshError::IoError(format!(
                "unsupported SOCKS5 address type {other}"
            )));
        }
    };

    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(io)?;
    Ok((host, u16::from_be_bytes(port)))
}

/// Pump bytes bidirectionally between a TCP stream and an SSH channel stream
/// until either side closes or the tunnel is cancelled.
async fn pump<S>(mut tcp_stream: TcpStream, mut ssh_stream: S, cancel: CancellationToken)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = tokio::io::copy_bidirectional(&mut tcp_stream, &mut ssh_stream) => {}
    }
}

// ─── Remote forwarding handler ─────────────────────────────────────────────────

/// SSH client handler for a Remote-forward connection. When the server opens a
/// `forwarded-tcpip` channel (a connection arrived on the server's listener), it
/// connects to the configured local destination and proxies the two together.
struct RemoteForwardHandler {
    dest_host: String,
    dest_port: u32,
    rule_id: String,
}

#[async_trait]
impl client::Handler for RemoteForwardHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let dest = format!("{}:{}", self.dest_host, self.dest_port);
        let rule_id = self.rule_id.clone();
        tokio::spawn(async move {
            match TcpStream::connect(&dest).await {
                Ok(tcp) => {
                    pump(tcp, channel.into_stream(), CancellationToken::new()).await;
                }
                Err(e) => {
                    warn!(rule_id = %rule_id, dest = %dest, error = %e, "remote forward: local connect failed");
                }
            }
        });
        Ok(())
    }
}
