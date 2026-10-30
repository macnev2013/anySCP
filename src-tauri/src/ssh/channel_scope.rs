//! Short-lived protocol channels with explicit cancellation/close. russh 0.46
//! ChannelStream has no Drop-based channel close, so dropping a pending read is
//! insufficient. The relay owns the Channel until its Close has been sent.
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_util::sync::CancellationToken;

pub struct ChannelScope {
    cancel: CancellationToken,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pending: Mutex<Vec<russh::Channel<russh::client::Msg>>>,
    writers: Mutex<Vec<tokio::fs::File>>,
}
impl ChannelScope {
    pub fn new(parent: &CancellationToken) -> Self {
        Self {
            cancel: parent.child_token(),
            tasks: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            writers: Mutex::new(Vec::new()),
        }
    }

    /// Shield only the SSH channel handshake. russh 0.46 does not close a
    /// channel if confirmation arrives after its receiver has been dropped.
    /// The detached task owns that handshake and closes any unclaimed result.
    /// A per-connection preview permit bounds late openers, without locking
    /// normal SSH operations. No staging file is owned by this task.
    pub async fn open(
        &self,
        handle: super::handle::SharedHandle,
    ) -> Result<russh::Channel<russh::client::Msg>, russh::Error> {
        let cancel = self.cancel.clone();
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(russh::Error::Disconnect),
            permit = handle.preview_open.clone().acquire_owned() => permit.map_err(|_| russh::Error::Disconnect)?,
        };
        let slot = std::sync::Arc::new(Mutex::new(None));
        let owned_slot = slot.clone();
        let owned_cancel = cancel.clone();
        let (ready, receive) = tokio::sync::oneshot::channel();
        let (claimed, claim) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _permit = permit;
            if owned_cancel.is_cancelled() {
                let _ = ready.send(Err(russh::Error::Disconnect));
                return;
            }
            // Do not timeout/drop this future: that would recreate the leak.
            match handle.channel_open_session().await {
                Ok(channel) => *owned_slot.lock().unwrap() = Some(channel),
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            }
            let _ = ready.send(Ok(()));
            tokio::select! {
                biased;
                _ = owned_cancel.cancelled() => {},
                _ = claim => {}, // Receiver claimed it, or was dropped.
            }
            // Sending the channel itself over oneshot would leak if that
            // receiver were dropped *after* send succeeded. This shared slot
            // retains ownership until the receiver synchronously claims it.
            let unclaimed = owned_slot.lock().unwrap().take();
            if let Some(channel) = unclaimed {
                // This task already owns no file and is bounded by the preview
                // permit. Keep ownership through outgoing-queue backpressure,
                // until Close is queued or the connection itself ends.
                let _ = channel.close().await;
            }
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(russh::Error::Disconnect),
            result = receive => {
                result.map_err(|_| russh::Error::Disconnect)??;
                let channel = slot.lock().unwrap().take().ok_or(russh::Error::Disconnect)?;
                let _ = claimed.send(());
                Ok(channel)
            }
        }
    }

    pub fn stream(&self, mut channel: russh::Channel<russh::client::Msg>) -> DuplexStream {
        let (stream, mut relay) = tokio::io::duplex(64 * 1024);
        let cancel = self.cancel.clone();
        let task = tokio::spawn(async move {
            let forwarding = async {
                let mut buffer = [0u8; 32 * 1024];
                loop {
                    tokio::select! {
                        message = channel.wait() => match message {
                            Some(russh::ChannelMsg::Data { data }) => {
                                if relay.write_all(&data).await.is_err() { break; }
                            }
                            Some(russh::ChannelMsg::Eof | russh::ChannelMsg::Close) | None => break,
                            _ => {}
                        },
                        read = relay.read(&mut buffer) => match read {
                            Ok(0) | Err(_) => break,
                            Ok(count) => if channel.data(&buffer[..count]).await.is_err() { break; },
                        }
                    }
                }
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {},
                _ = forwarding => {},
            }
            // Closing this one channel does not lock/disconnect the shared SSH
            // handle or disturb the terminal/normal transfer channels.
            close_owned(channel).await;
        });
        self.tasks.lock().unwrap().push(task);
        stream
    }

    fn close_channel(&self, channel: russh::Channel<russh::client::Msg>) {
        // Guard::drop may run during runtime teardown: queue the channel here,
        // and perform async work only in finish(), never spawn from Drop.
        self.pending.lock().unwrap().push(channel);
    }

    pub async fn finish(&self) {
        self.cancel.cancel();
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for channel in pending {
            close_owned(channel).await;
        }
        // Tokio file writes can still be running in the blocking pool after
        // their owning future is dropped. Flush them before staging is deleted
        // or a replacement request is allowed to acquire the writer gate.
        let writers = std::mem::take(&mut *self.writers.lock().unwrap());
        for mut writer in writers {
            let _ = writer.flush().await;
        }
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            let _ = task.await;
        }
    }
}

async fn close_owned(channel: russh::Channel<russh::client::Msg>) {
    if tokio::time::timeout(std::time::Duration::from_secs(2), channel.close())
        .await
        .is_err()
    {
        // Let local-file cleanup finish promptly, but do not discard the SSH
        // channel just because its outgoing mailbox is temporarily full. This
        // continuation owns only the channel, never staging or the writer gate.
        tokio::spawn(async move {
            let _ = channel.close().await;
        });
    }
}
impl Drop for ChannelScope {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Protect the setup phase too: cancellation while waiting for subsystem/exec
/// setup must close the channel even before its byte relay has been installed.
pub struct ChannelGuard<'a> {
    channel: Option<russh::Channel<russh::client::Msg>>,
    scope: Option<&'a ChannelScope>,
}
impl<'a> ChannelGuard<'a> {
    pub fn new(
        channel: russh::Channel<russh::client::Msg>,
        scope: Option<&'a ChannelScope>,
    ) -> Self {
        Self {
            channel: Some(channel),
            scope,
        }
    }
    pub fn into_channel(mut self) -> russh::Channel<russh::client::Msg> {
        self.channel.take().unwrap()
    }
}
impl std::ops::Deref for ChannelGuard<'_> {
    type Target = russh::Channel<russh::client::Msg>;
    fn deref(&self) -> &Self::Target {
        self.channel.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for ChannelGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.channel.as_mut().unwrap()
    }
}
impl Drop for ChannelGuard<'_> {
    fn drop(&mut self) {
        if let (Some(scope), Some(channel)) = (self.scope, self.channel.take()) {
            scope.close_channel(channel);
        }
    }
}

/// Cancellation-safe ownership of local writes belonging to the channel scope.
/// The unscoped case preserves the existing normal-download behavior.
pub struct ScopedFile<'a> {
    file: Option<tokio::fs::File>,
    scope: Option<&'a ChannelScope>,
}
impl<'a> ScopedFile<'a> {
    pub fn new(file: tokio::fs::File, scope: Option<&'a ChannelScope>) -> Self {
        Self {
            file: Some(file),
            scope,
        }
    }
    pub async fn finish(mut self) -> std::io::Result<()> {
        self.file.as_mut().unwrap().flush().await?;
        self.file.take();
        Ok(())
    }
}
impl tokio::io::AsyncWrite for ScopedFile<'_> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(self.get_mut().file.as_mut().unwrap()).poll_write(cx, buffer)
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(self.get_mut().file.as_mut().unwrap()).poll_flush(cx)
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(self.get_mut().file.as_mut().unwrap()).poll_shutdown(cx)
    }
}
impl Drop for ScopedFile<'_> {
    fn drop(&mut self) {
        if let (Some(file), Some(scope)) = (self.file.take(), self.scope) {
            scope.writers.lock().unwrap().push(file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_writer_is_flushed_and_released_before_scope_cleanup_returns() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("download.part");
        let cancel = CancellationToken::new();
        let scope = ChannelScope::new(&cancel);
        let file = tokio::fs::File::create(&path).await.unwrap();
        let mut writer = ScopedFile::new(file, Some(&scope));
        writer.write_all(&[42; 32 * 1024]).await.unwrap();
        cancel.cancel();
        drop(writer); // Pending filesystem work belongs to the scope now.
        scope.finish().await;
        assert_eq!(std::fs::read(&path).unwrap(), vec![42; 32 * 1024]);
        assert!(scope.writers.lock().unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
#[path = "channel_scope_tests.rs"]
mod initialisation_tests;
