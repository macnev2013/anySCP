use async_trait::async_trait;
use russh::client;
use russh_keys::key::PublicKey;
use std::sync::{Arc, Mutex};
use tracing::warn;

use super::known_hosts::{HostKeyCheck, KnownHostsStore};

pub type MismatchSlot = Arc<Mutex<Option<(String, String)>>>;

pub struct SshClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<KnownHostsStore>,
    mismatch: MismatchSlot,
}

impl SshClientHandler {
    pub fn new(host: String, port: u16, known_hosts: Arc<KnownHostsStore>) -> (Self, MismatchSlot) {
        let mismatch: MismatchSlot = Arc::new(Mutex::new(None));
        (
            Self {
                host,
                port,
                known_hosts,
                mismatch: mismatch.clone(),
            },
            mismatch,
        )
    }
}

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = format!("SHA256:{}", server_public_key.fingerprint());
        match self.known_hosts.check(&self.host, self.port, &fingerprint) {
            HostKeyCheck::TrustedOnFirstUse | HostKeyCheck::Known => Ok(true),
            HostKeyCheck::Mismatch { recorded } => {
                warn!(
                    host = %self.host,
                    port = self.port,
                    expected = %recorded,
                    got = %fingerprint,
                    "SSH host key mismatch — refusing connection"
                );
                if let Ok(mut slot) = self.mismatch.lock() {
                    *slot = Some((recorded, fingerprint));
                }
                Ok(false)
            }
        }
    }
}
