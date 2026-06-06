use crate::types::{
    AuthMethod, ConnectionStatus, HostConfig, SessionId, SshError, SshStatusPayload,
};
use dashmap::DashMap;
use russh::client;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tracing::info;

use super::handler::SshClientHandler;
use super::session::SshSession;

/// The target handle plus the chain of jump-host handles that must outlive it
/// (deepest hop first, empty for a direct connection).
type EstablishedConn = (
    client::Handle<SshClientHandler>,
    Vec<client::Handle<SshClientHandler>>,
);

/// Boxed, `Send` future for the recursive [`SshManager::establish`]. Boxing is
/// required because the recursion makes the future type self-referential.
type EstablishFuture<'a> =
    Pin<Box<dyn Future<Output = Result<EstablishedConn, SshError>> + Send + 'a>>;

/// A bare (PTY-less) SSH connection used by the SFTP layer.
struct BareConn {
    /// The authenticated target handle, shared with the SFTP layer.
    handle: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
    /// When the target is reached through a ProxyJump chain, the jump-host
    /// handles (one per hop) are stored here so the tunnel underneath stays
    /// open. They are never locked — merely keeping them alive prevents russh
    /// from tearing down the tunnel.
    _jump_handles: Vec<client::Handle<SshClientHandler>>,
}

/// Manages all active SSH sessions. Stored as Tauri managed state.
pub struct SshManager {
    sessions: DashMap<String, SshSession>,
    /// Bare SSH handles for SFTP-only connections (no PTY).
    bare_handles: DashMap<String, BareConn>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            bare_handles: DashMap::new(),
        }
    }

    /// Establish a new SSH connection and return its SessionId.
    pub async fn connect(
        &self,
        config: HostConfig,
        app_handle: AppHandle,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: sid.clone(),
                status: ConnectionStatus::Connecting,
            },
        );

        let keepalive_secs = config.keep_alive_interval.unwrap_or(0) as u64;
        let russh_config = Arc::new(client::Config {
            // Send SSH keepalive probes rather than arming an inactivity GC timer.
            // `inactivity_timeout` only tears the session down after a quiet
            // window (and sends nothing to prevent it), which would also collapse
            // any ProxyJump tunnel beneath an idle session. `keepalive_interval`
            // proactively keeps the connection — and the tunnel — alive, while
            // `keepalive_max` unanswered probes still detect a genuinely dead peer.
            keepalive_interval: if keepalive_secs > 0 {
                Some(std::time::Duration::from_secs(keepalive_secs))
            } else {
                None // No keepalive — connection stays alive until explicitly closed
            },
            keepalive_max: 3,
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump
        // chain. The jump handles must outlive the target session, so they are
        // handed (shared) to the SshSession to keep alive; sharing via Arc lets
        // split panes on the same connection hold the tunnel open too.
        let (handle, jump_handles) = Self::establish(&config, russh_config).await?;

        info!(session_id = %sid, host = %config.host, "SSH authenticated");

        let session = SshSession::open_pty(
            handle,
            Arc::new(jump_handles),
            sid.clone(),
            80,
            24,
            app_handle,
            config.default_shell.clone(),
            config.startup_command.clone(),
        )
        .await?;

        self.sessions.insert(sid.clone(), session);

        Ok(session_id)
    }

    /// Establish an SSH connection without opening a PTY.
    /// Used for SFTP-only sessions where no terminal is needed.
    /// Returns a session ID that can be used with `get_handle`.
    pub async fn connect_no_pty(&self, config: HostConfig) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        let russh_config = Arc::new(client::Config {
            inactivity_timeout: None, // SFTP connections stay alive indefinitely
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump.
        let (handle, jump_handles) = Self::establish(&config, russh_config).await?;

        info!(session_id = %sid, host = %config.host, "SSH authenticated (no PTY, for SFTP)");

        self.bare_handles.insert(
            sid.clone(),
            BareConn {
                handle: Arc::new(tokio::sync::Mutex::new(handle)),
                _jump_handles: jump_handles,
            },
        );

        Ok(session_id)
    }

    /// Establish a connected + authenticated russh handle for `config`, returning
    /// the target handle plus the chain of jump-host handles that must be kept
    /// alive beneath it (empty for a direct connection).
    ///
    /// When `config.jump_host` is set the connection is tunnelled, and because a
    /// jump host may itself be reached through its own ProxyJump this recurses to
    /// build the *entire* chain (`ssh -J a,b,c target`): each hop opens a
    /// `direct-tcpip` channel to the next over the already-authenticated handle
    /// below it. Every returned jump handle MUST outlive the target session —
    /// dropping one tears down the tunnel above it. Recursion depth is bounded by
    /// the cyclic-reference guard in `build_host_config_blocking`, which resolves
    /// the chain before this runs.
    ///
    /// Returns a boxed future because the recursion makes the future type
    /// self-referential (an `async fn` calling itself cannot size its own future).
    pub(crate) fn establish(
        config: &HostConfig,
        russh_config: Arc<client::Config>,
    ) -> EstablishFuture<'_> {
        Box::pin(async move {
            let Some(jump) = config.jump_host.as_deref() else {
                // Direct connection — no tunnel.
                let addr = format!("{}:{}", config.host, config.port);
                let mut handle = client::connect(russh_config, &addr, SshClientHandler)
                    .await
                    .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
                Self::authenticate_handle(&mut handle, config).await?;
                return Ok((handle, Vec::new()));
            };

            // 1. Recursively establish the jump connection (it may itself be
            //    tunnelled through its own ProxyJump). Reaching/auth errors are
            //    re-labelled so the failing hop is identifiable.
            let (jump_handle, mut chain) = Self::establish(jump, russh_config.clone())
                .await
                .map_err(|e| match e {
                    SshError::ConnectionFailed(m) => {
                        SshError::ConnectionFailed(format!("tunnel host {}: {m}", jump.host))
                    }
                    SshError::AuthenticationFailed(m) => {
                        SshError::AuthenticationFailed(format!("tunnel host {}: {m}", jump.host))
                    }
                    other => other,
                })?;

            // 2. Open a direct-tcpip channel through the jump host to the target.
            let channel = jump_handle
                .channel_open_direct_tcpip(
                    config.host.clone(),
                    config.port as u32,
                    "127.0.0.1".to_string(),
                    0,
                )
                .await
                .map_err(|e| {
                    SshError::ConnectionFailed(format!(
                        "failed to open tunnel to {}:{}: {e}",
                        config.host, config.port
                    ))
                })?;

            // 3. Run the target SSH session over the tunnelled channel.
            let mut handle =
                client::connect_stream(russh_config, channel.into_stream(), SshClientHandler)
                    .await
                    .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
            Self::authenticate_handle(&mut handle, config).await?;

            // Keep this hop's handle and everything beneath it alive under the
            // target session.
            chain.push(jump_handle);
            Ok((handle, chain))
        })
    }

    /// Authenticate an already-connected handle using the config's auth method.
    /// Shared by direct and tunnelled connection paths (and the health-check
    /// probe, which authenticates the jump host before tunnelling to the target).
    pub(crate) async fn authenticate_handle(
        handle: &mut client::Handle<SshClientHandler>,
        config: &HostConfig,
    ) -> Result<(), SshError> {
        let authenticated = match &config.auth_method {
            AuthMethod::Password { password } => handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?,
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let key_data = tokio::fs::read_to_string(key_path)
                    .await
                    .map_err(|e| SshError::IoError(e.to_string()))?;

                // Auto-convert PPK to OpenSSH if detected
                let key_data = if super::keys::is_ppk_format(&key_data) {
                    let kp = key_path.clone();
                    let pp = passphrase.clone();
                    tokio::task::spawn_blocking(move || {
                        super::keys::convert_ppk_to_openssh(&kp, pp.as_deref())
                    })
                    .await
                    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))??
                } else {
                    key_data
                };

                Self::auth_with_key_data(handle, &config.username, &key_data, passphrase.as_deref())
                    .await?
            }
            AuthMethod::PrivateKeyData {
                key_data,
                passphrase,
            } => {
                Self::auth_with_key_data(handle, &config.username, key_data, passphrase.as_deref())
                    .await?
            }
        };

        if !authenticated {
            return Err(SshError::AuthenticationFailed(
                "server rejected credentials".to_string(),
            ));
        }
        Ok(())
    }

    async fn auth_with_key_data(
        handle: &mut client::Handle<SshClientHandler>,
        username: &str,
        key_data: &str,
        passphrase: Option<&str>,
    ) -> Result<bool, SshError> {
        let key_pair = russh_keys::decode_secret_key(key_data, passphrase)
            .map_err(|e| SshError::KeyParseError(e.to_string()))?;
        let key = Arc::new(key_pair);
        handle
            .authenticate_publickey(username, key)
            .await
            .map_err(|e| SshError::AuthenticationFailed(e.to_string()))
    }

    /// Return the shared Handle for an active session.  Used by the SFTP layer
    /// to open an independent SFTP channel on the same connection.
    ///
    /// The caller must lock the handle only long enough to call
    /// `channel_open_session()`, then drop the guard.
    pub fn get_handle(
        &self,
        session_id: &str,
    ) -> Result<std::sync::Arc<tokio::sync::Mutex<russh::client::Handle<SshClientHandler>>>, SshError>
    {
        // Check PTY sessions first, then bare handles (SFTP-only)
        if let Some(entry) = self.sessions.get(session_id) {
            return Ok(entry.value().ssh_handle());
        }
        if let Some(entry) = self.bare_handles.get(session_id) {
            return Ok(entry.value().handle.clone());
        }
        Err(SshError::SessionNotFound(session_id.to_string()))
    }

    /// Open a new PTY channel on the same connection as an existing session.
    /// Returns the new session ID.
    pub async fn split_session(
        &self,
        source_session_id: &str,
        app_handle: AppHandle,
    ) -> Result<SessionId, SshError> {
        // Get the shared handle, host config, and the ProxyJump tunnel chain from
        // the source session. The jump handles are shared (Arc) so the tunnel
        // stays open as long as the parent OR any split pane is alive — closing
        // the parent tab no longer tears the tunnel out from under its children.
        let (handle, host_config, jump_handles) = {
            let entry = self
                .sessions
                .get(source_session_id)
                .ok_or_else(|| SshError::SessionNotFound(source_session_id.to_string()))?;
            (
                entry.value().ssh_handle(),
                entry.value().host_config(),
                entry.value().jump_handles(),
            )
        };

        let new_id = SessionId::new();
        let sid = new_id.0.clone();

        let session = SshSession::open_split_pty(
            handle,
            jump_handles,
            sid.clone(),
            80,
            24,
            app_handle,
            host_config.default_shell,
        )
        .await?;

        self.sessions.insert(sid, session);
        Ok(new_id)
    }

    /// Send bytes to a session's PTY channel.
    pub async fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), SshError> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        entry.value().send_input(data).await
    }

    /// Resize a session's PTY.
    pub async fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), SshError> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        entry.value().resize_pty(cols, rows).await
    }

    /// Disconnect and remove a session.
    pub async fn disconnect(
        &self,
        session_id: &str,
        app_handle: AppHandle,
    ) -> Result<(), SshError> {
        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.to_string(),
                status: ConnectionStatus::Disconnecting,
            },
        );

        let (_, session) = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;

        session.disconnect().await?;

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.to_string(),
                status: ConnectionStatus::Disconnected,
            },
        );

        info!(session_id = %session_id, "SSH disconnected");
        Ok(())
    }
}
