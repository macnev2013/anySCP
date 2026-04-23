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

/// Manages all active SSH sessions. Stored as Tauri managed state.
pub struct SshManager {
    sessions: DashMap<String, SshSession>,
    /// Bare SSH handles for SFTP-only connections (no PTY).
    bare_handles: DashMap<String, Arc<tokio::sync::Mutex<client::Handle<super::handler::SshClientHandler>>>>,
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

        // If a bastion/jump host is configured, connect through it
        let mut handle = if let Some(ref bastion) = config.bastion {
            // Connect to the bastion host
            let bastion_addr = format!("{}:{}", bastion.host, bastion.port);
            let bastion_handler = SshClientHandler;
            let mut bastion_handle = client::connect(russh_config.clone(), &bastion_addr, bastion_handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("bastion connection failed: {e}")))?;

            // Authenticate to bastion with its own credentials
            let bastion_auth = Self::authenticate(&mut bastion_handle, &bastion.username, &bastion.auth_method).await?;

            if !bastion_auth {
                return Err(SshError::AuthenticationFailed(
                    "bastion rejected credentials".to_string(),
                ));
            }

            info!(session_id = %sid, bastion = %bastion.host, "Bastion authenticated, opening tunnel");

            // Open a forwarded TCP channel through the bastion to the target host
            let channel = bastion_handle
                .channel_open_direct_tcpip(&config.host, config.port as u32, &bastion.host, bastion.port as u32)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("bastion tunnel failed: {e}")))?;

            // Use the forwarded channel as transport for the real SSH connection
            let target_handler = SshClientHandler;
            let target_config = Arc::new(client::Config {
                inactivity_timeout: if keepalive_secs > 0 {
                    Some(std::time::Duration::from_secs(keepalive_secs))
                } else {
                    None
                },
                ..Default::default()
            });
            client::connect_stream(target_config, channel.into_stream(), target_handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("target connection via bastion failed: {e}")))?
        } else {
            let addr = format!("{}:{}", config.host, config.port);
            let handler = SshClientHandler;
            client::connect(russh_config, &addr, handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(e.to_string()))?
        };

        let authenticated = Self::authenticate(&mut handle, &config.username, &config.auth_method).await?;

        if !authenticated {
            return Err(SshError::AuthenticationFailed(
                "server rejected credentials".to_string(),
            ));
        }

        info!(session_id = %sid, host = %config.host, "SSH authenticated");

        let session = SshSession::open_pty(
            handle,
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
    pub async fn connect_no_pty(
        &self,
        config: HostConfig,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        let russh_config = Arc::new(client::Config {
            inactivity_timeout: None, // SFTP connections stay alive indefinitely
            ..Default::default()
        });

        // If a bastion/jump host is configured, connect through it
        let mut handle = if let Some(ref bastion) = config.bastion {
            let bastion_addr = format!("{}:{}", bastion.host, bastion.port);
            let bastion_handler = SshClientHandler;
            let mut bastion_handle = client::connect(russh_config.clone(), &bastion_addr, bastion_handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("bastion connection failed: {e}")))?;

            let bastion_auth = Self::authenticate(&mut bastion_handle, &bastion.username, &bastion.auth_method).await?;

            if !bastion_auth {
                return Err(SshError::AuthenticationFailed(
                    "bastion rejected credentials".to_string(),
                ));
            }

            let channel = bastion_handle
                .channel_open_direct_tcpip(&config.host, config.port as u32, &bastion.host, bastion.port as u32)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("bastion tunnel failed: {e}")))?;

            let target_handler = SshClientHandler;
            let target_config = Arc::new(client::Config {
                inactivity_timeout: None,
                ..Default::default()
            });
            client::connect_stream(target_config, channel.into_stream(), target_handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(format!("target connection via bastion failed: {e}")))?
        } else {
            let addr = format!("{}:{}", config.host, config.port);
            let handler = SshClientHandler;
            client::connect(russh_config, &addr, handler)
                .await
                .map_err(|e| SshError::ConnectionFailed(e.to_string()))?
        };

        let authenticated = Self::authenticate(&mut handle, &config.username, &config.auth_method).await?;

        if !authenticated {
            return Err(SshError::AuthenticationFailed(
                "server rejected credentials".to_string(),
            ));
        }

        info!(session_id = %sid, host = %config.host, "SSH authenticated (no PTY, for SFTP)");

        self.bare_handles.insert(
            sid.clone(),
            Arc::new(tokio::sync::Mutex::new(handle)),
        );

        Ok(session_id)
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

    /// Authenticate a handle using an AuthMethod. Handles password, key file, and inline key.
    async fn authenticate(
        handle: &mut client::Handle<SshClientHandler>,
        username: &str,
        auth_method: &AuthMethod,
    ) -> Result<bool, SshError> {
        match auth_method {
            AuthMethod::Password { password } => handle
                .authenticate_password(username, password)
                .await
                .map_err(|e| SshError::AuthenticationFailed(e.to_string())),
            AuthMethod::PrivateKey { key_path, passphrase } => {
                let key_data = tokio::fs::read_to_string(key_path)
                    .await
                    .map_err(|e| SshError::IoError(e.to_string()))?;
                let key_data = if super::keys::is_ppk_format(&key_data) {
                    let kp = key_path.clone();
                    let pp = passphrase.clone();
                    tokio::task::spawn_blocking(move || {
                        super::keys::convert_ppk_to_openssh(&kp, pp.as_deref())
                    })
                    .await
                    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
                    ?
                } else {
                    key_data
                };
                Self::auth_with_key_data(handle, username, &key_data, passphrase.as_deref()).await
            }
            AuthMethod::PrivateKeyData { key_data, passphrase } => {
                Self::auth_with_key_data(handle, username, key_data, passphrase.as_deref()).await
            }
        }
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
            return Ok(entry.value().clone());
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
            let entry = self.sessions.get(source_session_id)
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
    pub async fn resize_pty(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), SshError> {
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
