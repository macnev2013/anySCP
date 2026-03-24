use async_trait::async_trait;
use russh::client;
use russh_keys::key::PublicKey;

/// Handles server events for a single SSH connection.
pub struct SshClientHandler;

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    /// Called when the server presents its host key.
    /// Phase 1: accept all. Phase 2: known_hosts verification.
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO(Phase 2): verify against known_hosts file
        Ok(true)
    }
}
