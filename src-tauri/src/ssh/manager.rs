use crate::types::{
    AuthMethod, ConnectionStatus, HostConfig, SessionId, SshError, SshStatusPayload,
};
use dashmap::DashMap;
use russh::client;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tracing::info;

use super::handler::SshClientHandler;
use super::session::SshSession;

/// Authenticated SSH handle plus any upstream jump handles that must outlive it.
/// The jump_chain entries each hold a russh `Handle` that owns the transport
/// the next inner connection is layered on. Drop them and the inner channel dies.
struct AuthenticatedHandle {
    handle: client::Handle<SshClientHandler>,
    jump_chain: Vec<Arc<Mutex<client::Handle<SshClientHandler>>>>,
}

/// Bare (no-PTY) SSH connection used by SFTP. Keeps the jump chain alive
/// alongside the target handle so the underlying transport stays open.
struct BareHandle {
    handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
    #[allow(dead_code)]
    jump_chain: Vec<Arc<Mutex<client::Handle<SshClientHandler>>>>,
}

/// Manages all active SSH sessions. Stored as Tauri managed state.
pub struct SshManager {
    sessions: DashMap<String, SshSession>,
    /// Bare SSH handles for SFTP-only connections (no PTY).
    bare_handles: DashMap<String, BareHandle>,
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

        let host_for_log = config.host.clone();
        let default_shell = config.default_shell.clone();
        let startup_command = config.startup_command.clone();

        let AuthenticatedHandle { handle, jump_chain } =
            open_authenticated_handle(config, russh_config).await?;

        info!(session_id = %sid, host = %host_for_log, "SSH authenticated");

        let session = SshSession::open_pty(
            handle,
            sid.clone(),
            80,
            24,
            app_handle,
            default_shell,
            startup_command,
            jump_chain,
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

        let host_for_log = config.host.clone();
        let AuthenticatedHandle { handle, jump_chain } =
            open_authenticated_handle(config, russh_config).await?;

        info!(session_id = %sid, host = %host_for_log, "SSH authenticated (no PTY, for SFTP)");

        self.bare_handles.insert(
            sid.clone(),
            BareHandle {
                handle: Arc::new(Mutex::new(handle)),
                jump_chain,
            },
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

// ────────────────────────────────────────────────────────────────────────────
// Proxy-aware connection helper
// ────────────────────────────────────────────────────────────────────────────

/// Build the SSH transport (direct TCP, ProxyCommand subprocess, or ProxyJump
/// channel) and authenticate. Returns the authenticated handle along with any
/// upstream jump handles that must outlive it.
///
/// Precedence matches OpenSSH: if both `proxy_command` and `proxy_jump` are
/// set on the config, `proxy_command` wins.
///
/// Returns a `BoxFuture` because the ProxyJump branch recurses into itself —
/// async fn recursion requires a heap-allocated future with a fixed size.
fn open_authenticated_handle(
    config: HostConfig,
    russh_cfg: Arc<client::Config>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<AuthenticatedHandle, SshError>> + Send>,
> {
    Box::pin(open_authenticated_handle_inner(config, russh_cfg))
}

async fn open_authenticated_handle_inner(
    config: HostConfig,
    russh_cfg: Arc<client::Config>,
) -> Result<AuthenticatedHandle, SshError> {
    let mut jump_chain: Vec<Arc<Mutex<client::Handle<SshClientHandler>>>> = Vec::new();

    let mut handle = if let Some(cmd) = config.proxy_command.as_ref() {
        // ── ProxyCommand: spawn subprocess via shell, pipe stdio to russh ──
        let expanded = expand_proxy_command_tokens(
            cmd.trim(),
            &config.host,
            config.port,
            &config.username,
        );
        if expanded.is_empty() {
            return Err(SshError::ConnectionFailed(
                "ProxyCommand is empty after token expansion".to_string(),
            ));
        }
        #[cfg(not(windows))]
        let (shell, flag): (&str, &str) = ("sh", "-c");
        #[cfg(windows)]
        let (shell, flag): (&str, &str) = ("cmd", "/C");

        let stream = russh_config::Stream::proxy_command(shell, &[flag, expanded.as_str()])
            .await
            .map_err(|e| {
                SshError::ConnectionFailed(format!("ProxyCommand failed to spawn: {e}"))
            })?;
        client::connect_stream(russh_cfg.clone(), stream, SshClientHandler)
            .await
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?
    } else if let Some(jump_str) = config.proxy_jump.as_ref() {
        // ── ProxyJump (single-hop): SSH to bastion, then direct-tcpip to target ──
        if jump_str.contains(',') {
            return Err(SshError::ConnectionFailed(
                "Multi-hop ProxyJump is not supported in v1. Express the chain via ProxyCommand (e.g. `ssh -J a,b -W %h:%p`) instead.".to_string(),
            ));
        }
        let (jump_user, jump_host, jump_port) =
            parse_proxy_jump(jump_str.trim(), &config.username);
        let jump_config = HostConfig {
            host: jump_host,
            port: jump_port,
            username: jump_user,
            auth_method: config.auth_method.clone(),
            label: None,
            keep_alive_interval: None,
            default_shell: None,
            startup_command: None,
            proxy_jump: None,
            proxy_command: None,
        };

        // Recurse to authenticate the jump host (this call is itself boxed
        // by the outer `open_authenticated_handle` indirection).
        let jump_auth: AuthenticatedHandle =
            open_authenticated_handle(jump_config, russh_cfg.clone()).await?;

        let channel = jump_auth
            .handle
            .channel_open_direct_tcpip(
                config.host.clone(),
                config.port as u32,
                "127.0.0.1",
                0,
            )
            .await
            .map_err(|e| {
                SshError::ConnectionFailed(format!(
                    "ProxyJump: failed to open direct-tcpip channel: {e}"
                ))
            })?;
        let stream = channel.into_stream();

        // Anchor the jump handle (and its own jumps, transitively) so they
        // outlive the target session — dropping them would kill the transport.
        let mut chain = jump_auth.jump_chain;
        chain.push(Arc::new(Mutex::new(jump_auth.handle)));
        jump_chain = chain;

        client::connect_stream(russh_cfg.clone(), stream, SshClientHandler)
            .await
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?
    } else {
        // ── No proxy: plain TCP (the original code path) ──
        let addr = format!("{}:{}", config.host, config.port);
        client::connect(russh_cfg.clone(), &addr, SshClientHandler)
            .await
            .map_err(|e| SshError::ConnectionFailed(e.to_string()))?
    };

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

            SshManager::auth_with_key_data(
                &mut handle,
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
            SshManager::auth_with_key_data(
                &mut handle,
                &config.username,
                key_data,
                passphrase.as_deref(),
            )
            .await?
        }
    };

    if !authenticated {
        return Err(SshError::AuthenticationFailed(
            "server rejected credentials".to_string(),
        ));
    }

    Ok(AuthenticatedHandle { handle, jump_chain })
}

/// Expand OpenSSH ProxyCommand tokens: `%h` → host, `%p` → port, `%r` →
/// remote user, `%%` → literal `%`. Unknown `%X` sequences pass through
/// unchanged (matches OpenSSH).
fn expand_proxy_command_tokens(cmd: &str, host: &str, port: u16, user: &str) -> String {
    let mut out = String::with_capacity(cmd.len());
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('p') => {
                out.push_str(&port.to_string());
            }
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Parse a ProxyJump value `[user@]host[:port]` into (user, host, port).
/// Falls back to the default user and port 22 when omitted.
fn parse_proxy_jump(s: &str, default_user: &str) -> (String, String, u16) {
    let (user, hostport) = match s.split_once('@') {
        Some((u, h)) if !u.is_empty() => (u.to_string(), h),
        _ => (default_user.to_string(), s),
    };
    // Use rsplit_once so IPv6 brackets / hostnames containing ':' aren't an
    // issue for the common case `host:port` written by users and ssh-config.
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => {
            let parsed = p.trim().parse::<u16>().unwrap_or(22);
            (h.trim().to_string(), parsed)
        }
        None => (hostport.trim().to_string(), 22u16),
    };
    (user, host, port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tokens_basic() {
        assert_eq!(
            expand_proxy_command_tokens("nc %h %p", "example.com", 22, "alice"),
            "nc example.com 22"
        );
    }

    #[test]
    fn expand_tokens_user_and_literal_percent() {
        assert_eq!(
            expand_proxy_command_tokens("ssh -l %r %h:%p && echo 100%%", "h", 2222, "bob"),
            "ssh -l bob h:2222 && echo 100%"
        );
    }

    #[test]
    fn expand_tokens_unknown_passthrough() {
        // OpenSSH leaves unknown tokens alone.
        assert_eq!(
            expand_proxy_command_tokens("echo %x %h", "host", 22, "u"),
            "echo %x host"
        );
    }

    #[test]
    fn parse_jump_full() {
        let (u, h, p) = parse_proxy_jump("alice@bastion.example.com:2222", "fallback");
        assert_eq!((u.as_str(), h.as_str(), p), ("alice", "bastion.example.com", 2222));
    }

    #[test]
    fn parse_jump_host_only() {
        let (u, h, p) = parse_proxy_jump("bastion", "fallback");
        assert_eq!((u.as_str(), h.as_str(), p), ("fallback", "bastion", 22));
    }

    #[test]
    fn parse_jump_user_only() {
        let (u, h, p) = parse_proxy_jump("alice@bastion", "fallback");
        assert_eq!((u.as_str(), h.as_str(), p), ("alice", "bastion", 22));
    }

    #[test]
    fn parse_jump_host_port() {
        let (u, h, p) = parse_proxy_jump("bastion:2222", "fallback");
        assert_eq!((u.as_str(), h.as_str(), p), ("fallback", "bastion", 2222));
    }
}
