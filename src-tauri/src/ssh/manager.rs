use crate::types::{
    AuthMethod, ConnectionStatus, HostConfig, SessionId, SshError, SshStatusPayload,
};
use dashmap::DashMap;
use russh::client;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tracing::info;

use super::handler::SshClientHandler;
use super::session::SshSession;

/// A bare (PTY-less) SSH connection used by the SFTP layer.
struct BareConn {
    /// The authenticated target handle, shared with the SFTP layer.
    handle: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
    /// When the target is reached through a ProxyJump, the jump-host handle is
    /// stored here so the tunnel underneath stays open. It is never locked —
    /// merely keeping it alive prevents russh from tearing down the tunnel.
    _jump_handle: Option<client::Handle<SshClientHandler>>,
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
            inactivity_timeout: if keepalive_secs > 0 {
                Some(std::time::Duration::from_secs(keepalive_secs))
            } else {
                None // No timeout — connection stays alive until explicitly closed
            },
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump
        // host. `jump_handle` (when present) must outlive the target session,
        // so it is handed to the SshSession to keep alive.
        let (handle, jump_handle) = Self::establish(&config, russh_config).await?;

        info!(session_id = %sid, host = %config.host, "SSH authenticated");

        let session = SshSession::open_pty(
            handle,
            jump_handle,
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
        let (handle, jump_handle) = Self::establish(&config, russh_config).await?;

        info!(session_id = %sid, host = %config.host, "SSH authenticated (no PTY, for SFTP)");

        self.bare_handles.insert(
            sid.clone(),
            BareConn {
                handle: Arc::new(tokio::sync::Mutex::new(handle)),
                _jump_handle: jump_handle,
            },
        );

        Ok(session_id)
    }

    /// Establish a connected + authenticated russh handle for `config`.
    ///
    /// When `config.jump_host` is set, the connection is tunnelled: an SSH
    /// session to the jump host is opened first, a `direct-tcpip` channel to the
    /// target is opened over it, and the target SSH session runs over that
    /// channel (`ssh -J jump target`). The returned jump handle MUST be kept
    /// alive for as long as the target session is in use — dropping it tears
    /// down the tunnel. For direct connections the second element is `None`.
    async fn establish(
        config: &HostConfig,
        russh_config: Arc<client::Config>,
    ) -> Result<
        (
            client::Handle<SshClientHandler>,
            Option<client::Handle<SshClientHandler>>,
        ),
        SshError,
    > {
        if let Some(jump) = &config.jump_host {
            // 1. Connect + authenticate to the jump host.
            let jump_addr = format!("{}:{}", jump.host, jump.port);
            let mut jump_handle =
                client::connect(russh_config.clone(), &jump_addr, SshClientHandler)
                    .await
                    .map_err(|e| {
                        SshError::ConnectionFailed(format!("tunnel host {}: {e}", jump.host))
                    })?;
            Self::authenticate_handle(&mut jump_handle, jump)
                .await
                .map_err(|e| match e {
                    SshError::AuthenticationFailed(m) => {
                        SshError::AuthenticationFailed(format!("tunnel host: {m}"))
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

            Ok((handle, Some(jump_handle)))
        } else {
            let addr = format!("{}:{}", config.host, config.port);
            let mut handle = client::connect(russh_config, &addr, SshClientHandler)
                .await
                .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
            Self::authenticate_handle(&mut handle, config).await?;
            Ok((handle, None))
        }
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

                Self::auth_with_key_data(
                    handle,
                    &config.username,
                    &key_data,
                    passphrase.as_deref(),
                )
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
        // Get the shared handle and host config from the source session
        let (handle, host_config) = {
            let entry = self
                .sessions
                .get(source_session_id)
                .ok_or_else(|| SshError::SessionNotFound(source_session_id.to_string()))?;
            (entry.value().ssh_handle(), entry.value().host_config())
        };

        let new_id = SessionId::new();
        let sid = new_id.0.clone();

        let session = SshSession::open_split_pty(
            handle,
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
