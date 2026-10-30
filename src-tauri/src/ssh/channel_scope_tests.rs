//! A real loopback SSH peer, including delayed OPEN confirmation and stalled
//! metadata. These regressions cannot be covered by a byte-reader mock.
use super::{ChannelGuard, ChannelScope};
use crate::scp::listing::Flavor;
use crate::ssh::handle::{ConnectionHandle, SharedHandle};
use async_trait::async_trait;
use russh::server::Server as _;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct State {
    delay: Duration,
    flood: bool,
    requested: AtomicUsize,
    opened: AtomicUsize,
    closed: AtomicUsize,
    execs: AtomicUsize,
}
#[derive(Clone)]
struct Peer(Arc<State>);
impl russh::server::Server for Peer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
#[async_trait]
impl russh::server::Handler for Peer {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        _: &str,
        _: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<russh::server::Msg>,
        _: &mut russh::server::Session,
    ) -> Result<bool, Self::Error> {
        self.0.requested.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.0.delay).await;
        if self
            .0
            .opened
            .load(Ordering::SeqCst)
            .saturating_sub(self.0.closed.load(Ordering::SeqCst))
            >= 2
        {
            return Ok(false);
        }
        self.0.opened.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
    async fn channel_close(
        &mut self,
        _: russh::ChannelId,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: russh::ChannelId,
        _: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.0.execs.fetch_add(1, Ordering::SeqCst);
        session.channel_success(id);
        if self.0.flood {
            session.data(id, russh::CryptoVec::from_slice(&vec![b'x'; 96 * 1024]));
        }
        // Otherwise accept the command and never send data, EOF or exit status.
        Ok(())
    }
}

async fn fixture(
    delay: Duration,
    flood: bool,
) -> (SharedHandle, Arc<State>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(State {
        delay,
        flood,
        requested: AtomicUsize::new(0),
        opened: AtomicUsize::new(0),
        closed: AtomicUsize::new(0),
        execs: AtomicUsize::new(0),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = Arc::new(russh::server::Config {
        keys: vec![russh_keys::key::KeyPair::generate_ed25519()],
        auth_rejection_time: Duration::ZERO,
        inactivity_timeout: None,
        ..Default::default()
    });
    let mut peer = Peer(state.clone());
    let server = tokio::spawn(async move {
        peer.run_on_socket(config, &listener).await.unwrap();
    });
    let mut client = russh::client::connect(
        Arc::new(russh::client::Config::default()),
        address,
        crate::ssh::handler::SshClientHandler,
    )
    .await
    .unwrap();
    assert!(client
        .authenticate_password("fixture", "fixture")
        .await
        .unwrap());
    (Arc::new(ConnectionHandle::new(client)), state, server)
}
async fn wait(counter: &AtomicUsize, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while counter.load(Ordering::SeqCst) < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelled_late_confirmations_close_and_do_not_accumulate_openers() {
    let (handle, state, server) = fixture(Duration::from_millis(100), false).await;
    for number in 1..=4 {
        let cancel = CancellationToken::new();
        let scope = ChannelScope::new(&cancel);
        tokio::select! {
            _ = async { wait(&state.requested, number).await; cancel.cancel(); } => {},
            _ = scope.open(handle.clone()) => panic!("confirmation unexpectedly beat cancellation"),
        }
        scope.finish().await; // Must not wait for an unconfirmed channel.
        assert_eq!(state.opened.load(Ordering::SeqCst), number - 1);
        let queued_cancel = CancellationToken::new();
        let queued = ChannelScope::new(&queued_cancel);
        tokio::select! {
            _ = async { tokio::time::sleep(Duration::from_millis(10)).await; queued_cancel.cancel(); } => {},
            _ = queued.open(handle.clone()) => panic!("second opener bypassed the preview permit"),
        }
        queued.finish().await;
        wait(&state.closed, number).await;
        assert_eq!(state.requested.load(Ordering::SeqCst), number);
    }
    let cancel = CancellationToken::new();
    let scope = ChannelScope::new(&cancel);
    let channel = scope.open(handle.clone()).await.unwrap();
    drop(ChannelGuard::new(channel, Some(&scope)));
    scope.finish().await;
    wait(&state.closed, 5).await;
    assert_eq!(state.opened.load(Ordering::SeqCst), 5);
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn stalled_preview_confirmation_does_not_block_shared_disconnect() {
    let (handle, state, server) = fixture(Duration::from_secs(1), false).await;
    let cancel = CancellationToken::new();
    let scope = ChannelScope::new(&cancel);
    tokio::select! {
        _ = async { wait(&state.requested, 1).await; cancel.cancel(); } => {},
        _ = scope.open(handle.clone()) => panic!("confirmation unexpectedly beat cancellation"),
    }
    scope.finish().await;
    tokio::time::timeout(
        Duration::from_millis(250),
        handle.disconnect(russh::Disconnect::ByApplication, "", "en"),
    )
    .await
    .unwrap()
    .unwrap();
    server.abort();
}

#[tokio::test]
async fn cancelled_scp_metadata_closes_both_stat_and_posix_fallback_channels() {
    for flavor in [Flavor::Gnu, Flavor::Posix] {
        let (handle, state, server) = fixture(Duration::ZERO, false).await;
        let cancel = CancellationToken::new();
        let scope = ChannelScope::new(&cancel);
        tokio::select! {
            _ = async { wait(&state.execs, 1).await; cancel.cancel(); } => {},
            _ = crate::scp::exec::stat_scoped(handle.clone(), flavor, "/fixture", Some(&scope)) => panic!("stalled metadata unexpectedly completed"),
        }
        scope.finish().await;
        wait(&state.closed, 1).await;
        handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn preview_metadata_output_is_bounded_before_parsing() {
    let (handle, state, server) = fixture(Duration::ZERO, true).await;
    let cancel = CancellationToken::new();
    let scope = ChannelScope::new(&cancel);
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        crate::scp::exec::stat_scoped(handle.clone(), Flavor::Gnu, "/fixture", Some(&scope)),
    )
    .await
    .unwrap();
    assert!(matches!(
        result,
        Err(crate::scp::ScpError::ProtocolError(_))
    ));
    scope.finish().await;
    wait(&state.closed, 1).await;
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .unwrap();
    server.abort();
}
