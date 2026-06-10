use crate::types::{
    AuthMethod, ConnectionStatus, HostConfig, SessionId, SshError, SshStatusPayload,
};
use dashmap::DashMap;
use russh::client;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
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
    /// In-flight connection attempts, keyed by the frontend-supplied attempt ID.
    /// A handle exists here only while a `connect`/`connect_no_pty` call is
    /// running; cancelling its token aborts the attempt before any session is
    /// registered, so no ghost session or lingering handle is left behind.
    pending_connects: DashMap<String, CancellationToken>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            bare_handles: DashMap::new(),
            pending_connects: DashMap::new(),
        }
    }

    /// Register a cancellation token for an in-flight connection attempt and
    /// return a clone the connect path can await on. Re-registering the same
    /// attempt ID replaces (and orphans) the previous token.
    fn register_pending(&self, attempt_id: String) -> CancellationToken {
        let token = CancellationToken::new();
        self.pending_connects.insert(attempt_id, token.clone());
        token
    }

    /// Drop the pending registration for `attempt_id` once the attempt settles
    /// (succeeded, failed, or was cancelled).
    fn clear_pending(&self, attempt_id: &str) {
        self.pending_connects.remove(attempt_id);
    }

    /// Abort an in-flight connection attempt by its attempt ID. Returns `true`
    /// if a matching attempt was found and signalled. The connect path observes
    /// the cancellation, unwinds its partial state, and removes the registration.
    pub fn cancel_connect(&self, attempt_id: &str) -> bool {
        if let Some(entry) = self.pending_connects.get(attempt_id) {
            entry.cancel();
            true
        } else {
            false
        }
    }

    /// Establish a new SSH connection and return its SessionId.
    pub async fn connect(
        &self,
        config: HostConfig,
        app_handle: AppHandle,
        attempt_id: Option<String>,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        // Arm cancellation for this attempt (if the frontend supplied an ID) so
        // `cancel_connect` can abort it mid-handshake.
        let cancel_token = attempt_id
            .as_ref()
            .map(|id| self.register_pending(id.clone()));

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
        //
        // The whole establish + PTY-open is raced against the cancellation token:
        // if the user cancels, the future is dropped mid-await, which drops any
        // partially-established handles and lets russh tear the connection down.
        // Nothing is inserted into `sessions` until this succeeds, so a cancel
        // leaves no ghost session behind.
        let connect_fut = async {
            let (handle, jump_handles) = Self::establish(&config, russh_config).await?;

            info!(session_id = %sid, host = %config.host, "SSH authenticated");

            SshSession::open_pty(
                handle,
                Arc::new(jump_handles),
                sid.clone(),
                80,
                24,
                app_handle,
                config.default_shell.clone(),
                config.startup_command.clone(),
            )
            .await
        };

        let outcome = match &cancel_token {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Err(SshError::Cancelled),
                r = connect_fut => r,
            },
            None => connect_fut.await,
        };

        if let Some(id) = &attempt_id {
            self.clear_pending(id);
        }

        let session = outcome?;
        self.sessions.insert(sid.clone(), session);

        Ok(session_id)
    }

    /// Establish an SSH connection without opening a PTY.
    /// Used for SFTP-only sessions where no terminal is needed.
    /// Returns a session ID that can be used with `get_handle`.
    pub async fn connect_no_pty(
        &self,
        config: HostConfig,
        attempt_id: Option<String>,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        let cancel_token = attempt_id
            .as_ref()
            .map(|id| self.register_pending(id.clone()));

        let russh_config = Arc::new(client::Config {
            inactivity_timeout: None, // SFTP connections stay alive indefinitely
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump —
        // racing against the cancellation token so the user can abort mid-handshake.
        let establish_fut = Self::establish(&config, russh_config);
        let established = match &cancel_token {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Err(SshError::Cancelled),
                r = establish_fut => r,
            },
            None => establish_fut.await,
        };

        if let Some(id) = &attempt_id {
            self.clear_pending(id);
        }

        let (handle, jump_handles) = established?;

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

        // PTY sessions and bare (SFTP-only) handles live in separate maps —
        // check both so a no-PTY connection (e.g. an explorer connect whose
        // cancel landed after the handshake settled) can be torn down through
        // this same command instead of lingering in `bare_handles` forever.
        if let Some((_, session)) = self.sessions.remove(session_id) {
            session.disconnect().await?;
        } else if let Some((_, bare)) = self.bare_handles.remove(session_id) {
            // Best-effort goodbye — dropping the handles closes the connection
            // (and any ProxyJump tunnel beneath it) even if the server is gone.
            let _ = bare
                .handle
                .lock()
                .await
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        } else {
            return Err(SshError::SessionNotFound(session_id.to_string()));
        }

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Cancelling an attempt ID that was never registered (or whose attempt
    /// already settled) must report that nothing was found.
    #[test]
    fn cancel_connect_returns_false_for_unknown_attempt() {
        let manager = SshManager::new();
        assert!(!manager.cancel_connect("no-such-attempt"));
    }

    /// The token handed to the connect path observes a cancel issued through
    /// the manager by attempt ID.
    #[test]
    fn cancel_connect_signals_the_registered_token() {
        let manager = SshManager::new();
        let token = manager.register_pending("attempt-1".to_string());
        assert!(!token.is_cancelled());

        assert!(manager.cancel_connect("attempt-1"));
        assert!(token.is_cancelled());
    }

    /// Once an attempt settles and clears its registration, a late cancel is a
    /// no-op: the settled attempt's token must not be signalled.
    #[test]
    fn clear_pending_makes_a_late_cancel_a_no_op() {
        let manager = SshManager::new();
        let token = manager.register_pending("attempt-1".to_string());
        manager.clear_pending("attempt-1");

        assert!(!manager.cancel_connect("attempt-1"));
        assert!(!token.is_cancelled());
    }

    /// Re-registering an attempt ID replaces the token: a cancel reaches the
    /// new attempt, never the orphaned one.
    #[test]
    fn reregistering_an_attempt_id_replaces_the_token() {
        let manager = SshManager::new();
        let orphaned = manager.register_pending("attempt-1".to_string());
        let active = manager.register_pending("attempt-1".to_string());

        assert!(manager.cancel_connect("attempt-1"));
        assert!(active.is_cancelled());
        assert!(!orphaned.is_cancelled());
    }
}
