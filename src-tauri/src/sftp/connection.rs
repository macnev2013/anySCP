use std::sync::Arc;

use russh::client::Handle;

use crate::ssh::handler::SshClientHandler;

use super::{map_client_error, SftpError};

pub type SshHandle = Arc<tokio::sync::Mutex<Handle<SshClientHandler>>>;

/// Open and initialize an SFTP channel on an authenticated SSH connection.
pub async fn open_sftp_session(
    handle: &SshHandle,
    use_sudo: bool,
) -> Result<russh_sftp::client::SftpSession, SftpError> {
    let channel = {
        let handle = handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| SftpError::TransportError(e.to_string()))?
    };

    if use_sudo {
        let mut check = {
            let handle = handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| SftpError::TransportError(e.to_string()))?
        };
        check
            .exec(true, "sudo -n true")
            .await
            .map_err(|e| SftpError::TransportError(e.to_string()))?;

        let mut exit_status = None;
        while let Some(message) = check.wait().await {
            match message {
                russh::ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit_status != Some(0) {
            return Err(SftpError::PermissionDenied(
                "passwordless sudo is required to browse as root, but it is not configured \
                 for this user"
                    .to_string(),
            ));
        }

        channel
            .exec(
                true,
                "sudo -n /bin/sh -c 'for p in \"$(command -v sftp-server 2>/dev/null)\" \
                 /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server \
                 /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do \
                 [ -x \"$p\" ] && exec \"$p\"; done; \
                 echo \"sftp-server: not found\" >&2; exit 127'",
            )
            .await
            .map_err(|e| SftpError::TransportError(e.to_string()))?;
    } else {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SftpError::TransportError(e.to_string()))?;
    }

    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(map_client_error)
}
