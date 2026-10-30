//! Authenticated russh handles expose shared (&self) operations. Keep them
//! immutable after authentication so a slow preview channel confirmation does
//! not lock out terminal, metadata, forwarding, or disconnect operations.
use super::handler::SshClientHandler;
use std::ops::Deref;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub type SharedHandle = Arc<ConnectionHandle>;
pub struct ConnectionHandle {
    client: russh::client::Handle<SshClientHandler>,
    // Only preview initialisation is serialised. At most one abandoned open
    // can await a late confirmation on this SSH connection, without blocking
    // normal SSH operations or accumulating detached opener tasks.
    pub(crate) preview_open: Arc<Semaphore>,
}
impl ConnectionHandle {
    pub fn new(client: russh::client::Handle<SshClientHandler>) -> Self {
        Self {
            client,
            preview_open: Arc::new(Semaphore::new(1)),
        }
    }
}
impl Deref for ConnectionHandle {
    type Target = russh::client::Handle<SshClientHandler>;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}
