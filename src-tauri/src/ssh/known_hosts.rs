use dashmap::{mapref::entry::Entry, DashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::types::SshNewHostKeyPayload;

pub enum HostKeyCheck {
    TrustedOnFirstUse,
    Known,
    Mismatch { recorded: String },
}

pub struct Inner {
    path: PathBuf,
    entries: DashMap<String, String>,
}
impl Inner {
    fn write_now(&self) {
        let mut out =
            String::from("# anySCP known_hosts - SHA-256 fingerprints, not OpenSSH-compatible\n");
        for entry in self.entries.iter() {
            out.push_str(entry.key());
            out.push(' ');
            out.push_str(entry.value());
            out.push('\n');
        }
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&self.path, out) {
            tracing::warn!("failed to persist known_hosts: {e}");
        }
    }
}

pub struct KnownHostsStore {
    inner: Arc<Inner>,
    app_handle: OnceLock<AppHandle>,
    writer: OnceLock<mpsc::UnboundedSender<WriteMsg>>,
}

enum WriteMsg {
    Write,
    Flush(tokio::sync::oneshot::Sender<()>),
}

impl KnownHostsStore {
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join("known_hosts");
        let entries = DashMap::new();
        if let Ok(contents) = std::fs::read_to_string(&path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((host, fp)) = line.split_once(' ') {
                    entries.insert(host.to_string(), fp.to_string());
                }
            }
        }
        Self {
            inner: Arc::new(Inner { path, entries }),
            app_handle: OnceLock::new(),
            writer: OnceLock::new(),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        let _ = self.app_handle.set(handle);
    }

    fn key(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    pub fn check(&self, host: &str, port: u16, fingerprint: &str) -> HostKeyCheck {
        let key = Self::key(host, port);

        match self.inner.entries.entry(key) {
            Entry::Occupied(occupied) => {
                let recorded = occupied.get().clone();
                if recorded == fingerprint {
                    HostKeyCheck::Known
                } else {
                    HostKeyCheck::Mismatch { recorded }
                }
            }
            Entry::Vacant(vacant) => {
                vacant.insert(fingerprint.to_string());
                self.persist();

                if let Some(handle) = self.app_handle.get() {
                    let _ = handle.emit(
                        "ssh:new-host-key",
                        &SshNewHostKeyPayload {
                            host: host.to_string(),
                            port,
                            fingerprint: fingerprint.to_string(),
                        },
                    );
                }
                HostKeyCheck::TrustedOnFirstUse
            }
        }
    }

    pub fn forget(&self, host: &str, port: u16) {
        self.inner.entries.remove(&Self::key(host, port));
        self.persist();
    }

    fn writer_tx(&self) -> Option<mpsc::UnboundedSender<WriteMsg>> {
        if let Some(tx) = self.writer.get() {
            return Some(tx.clone());
        }

        let handle = tokio::runtime::Handle::try_current().ok()?;
        let (tx, mut rx) = mpsc::unbounded_channel::<WriteMsg>();
        if self.writer.set(tx.clone()).is_err() {
            return self.writer.get().cloned();
        }

        let inner = self.inner.clone();
        handle.spawn(async move {
            while let Some(msg) = rx.recv().await {
                let inner = inner.clone();
                let _ = tokio::task::spawn_blocking(move || inner.write_now()).await;
                if let WriteMsg::Flush(ack) = msg {
                    let _ = ack.send(());
                }
            }
        });
        Some(tx)
    }

    fn persist(&self) {
        match self.writer_tx() {
            Some(tx) => {
                let _ = tx.send(WriteMsg::Write);
            }
            None => self.inner.write_now(),
        }
    }

    pub async fn flush(&self) {
        let Some(tx) = self.writer_tx() else {
            return;
        };
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        if tx.send(WriteMsg::Flush(ack_tx)).is_err() {
            return;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), ack_rx).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_is_trusted_and_recorded() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHostsStore::load(&dir);
        assert!(matches!(
            store.check("example.com", 22, "SHA256:abc"),
            HostKeyCheck::TrustedOnFirstUse
        ));
        assert!(matches!(
            store.check("example.com", 22, "SHA256:abc"),
            HostKeyCheck::Known
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_key_is_reported_as_mismatch() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHostsStore::load(&dir);
        store.check("example.com", 22, "SHA256:abc");

        match store.check("example.com", 22, "SHA256:xyz") {
            HostKeyCheck::Mismatch { recorded } => assert_eq!(recorded, "SHA256:abc"),
            _ => panic!("expected a mismatch"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_ports_on_the_same_host_are_independent() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHostsStore::load(&dir);
        store.check("example.com", 22, "SHA256:abc");
        assert!(matches!(
            store.check("example.com", 2222, "SHA256:xyz"),
            HostKeyCheck::TrustedOnFirstUse
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_clears_the_record_so_a_new_key_is_trusted_again() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHostsStore::load(&dir);
        store.check("example.com", 22, "SHA256:abc");
        store.forget("example.com", 22);
        assert!(matches!(
            store.check("example.com", 22, "SHA256:xyz"),
            HostKeyCheck::TrustedOnFirstUse
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_store_reloads_across_instances() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        {
            let store = KnownHostsStore::load(&dir);
            store.check("example.com", 22, "SHA256:abc");
        }
        let reloaded = KnownHostsStore::load(&dir);
        assert!(matches!(
            reloaded.check("example.com", 22, "SHA256:abc"),
            HostKeyCheck::Known
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn flush_waits_for_the_write_to_land_on_disk() {
        let dir = std::env::temp_dir().join(format!("anyscp-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHostsStore::load(&dir);
        store.check("example.com", 22, "SHA256:abc");
        store.flush().await;

        let contents = std::fs::read_to_string(dir.join("known_hosts")).expect("file written");
        assert!(contents.contains("example.com:22 SHA256:abc"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
