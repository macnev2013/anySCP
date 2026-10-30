//! Run-local cache: remote metadata is checked on every open, never taken from
//! the Explorer listing. Arc ownership pins files until native panel detach.
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio_util::sync::CancellationToken;

use super::staging::{self, Source, StagedFile};
use super::{PreviewError, Target};
use crate::ssh::channel_scope::ChannelScope;

const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 32;

#[derive(Clone, PartialEq, Eq)]
struct Metadata {
    modified: Option<SystemTime>,
    size: Option<u64>,
    // Also catch S3 replacement with a preserved/low-resolution timestamp.
    validator: Option<(String, Option<String>)>,
}

pub struct CachedFile {
    pub file: Arc<StagedFile>,
    metadata: Metadata,
    added_at: SystemTime,
    bytes: u64,
    ssh_id: Option<String>,
}

impl CachedFile {
    fn reusable(&self, remote: &Metadata) -> bool {
        remote
            .modified
            .is_some_and(|modified| modified <= self.added_at)
            && *remote == self.metadata
            && std::fs::symlink_metadata(&self.file.complete).is_ok_and(|local| {
                local.is_file() && !local.file_type().is_symlink() && local.len() == self.bytes
            })
    }
}

#[derive(Default)]
pub struct PreviewCache {
    entries: VecDeque<(Target, Arc<CachedFile>)>,
}

impl PreviewCache {
    pub fn take(&mut self, target: &Target) -> Option<Arc<CachedFile>> {
        let index = self.entries.iter().position(|(key, _)| key == target)?;
        self.entries.remove(index).map(|(_, file)| file)
    }

    pub fn insert(&mut self, target: Target, file: Arc<CachedFile>) {
        self.take(&target);
        self.entries.push_back((target, file));
        while self.entries.len() > MAX_CACHE_ENTRIES
            || self.entries.iter().map(|(_, file)| file.bytes).sum::<u64>() > MAX_CACHE_BYTES
        {
            self.entries.pop_front();
        }
    }

    pub fn close_session(&mut self, id: &str) {
        self.entries.retain(|(target, _)| target.session_id() != id);
    }

    pub fn close_ssh_session(&mut self, id: &str) {
        self.entries
            .retain(|(_, file)| file.ssh_id.as_deref() != Some(id));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

fn epoch_time(seconds: u64) -> Option<SystemTime> {
    UNIX_EPOCH.checked_add(std::time::Duration::from_secs(seconds))
}

fn s3_time(value: &str) -> Option<SystemTime> {
    use time::format_description::well_known::{Rfc2822, Rfc3339};
    time::OffsetDateTime::parse(value, &Rfc2822)
        .or_else(|_| time::OffsetDateTime::parse(value, &Rfc3339))
        .ok()
        .map(SystemTime::from)
}

async fn metadata(source: &Source, scope: &ChannelScope) -> Result<Metadata, PreviewError> {
    let result = match source {
        Source::Sftp {
            handle, sudo, path, ..
        } => {
            let channel =
                crate::sftp::commands::open_sftp_channel(handle.clone(), *sudo, Some(scope))
                    .await
                    .map_err(PreviewError::remote)?;
            let sftp = russh_sftp::client::SftpSession::new(scope.stream(channel))
                .await
                .map_err(PreviewError::remote)?;
            let meta = sftp
                .symlink_metadata(path)
                .await
                .map_err(PreviewError::remote)?;
            if meta.file_type() != russh_sftp::protocol::FileType::File {
                return Err(PreviewError::invalid_file());
            }
            let _ = sftp.close().await;
            Metadata {
                modified: meta
                    .mtime
                    .and_then(|seconds| epoch_time(u64::from(seconds))),
                size: meta.size,
                validator: None,
            }
        }
        Source::Scp {
            handle,
            flavor,
            path,
            ..
        } => {
            let meta = crate::scp::exec::stat_scoped(handle.clone(), *flavor, path, Some(scope))
                .await
                .map_err(PreviewError::remote)?
                .ok_or_else(|| {
                    PreviewError::new("download_failed", "Remote file no longer exists")
                })?;
            if meta.entry_type != crate::scp::ScpEntryType::File {
                return Err(PreviewError::invalid_file());
            }
            Metadata {
                // Portable ls fallback uses zero when no reliable mtime is
                // available. It must never turn into a permanent cache hit.
                modified: if meta.mtime == 0 {
                    None
                } else {
                    epoch_time(meta.mtime)
                },
                size: Some(meta.size),
                validator: None,
            }
        }
        Source::S3 { bucket, key } => {
            if key.ends_with('/') {
                return Err(PreviewError::invalid_file());
            }
            let (head, code) = bucket.head_object(key).await.map_err(|error| {
                staging::s3_error(
                    error,
                    "Could not read S3 object metadata (check connection and permissions)",
                )
            })?;
            if code != 200 || head.delete_marker == Some(true) {
                return Err(PreviewError::new(
                    if matches!(code, 401 | 403) {
                        "permission_denied"
                    } else {
                        "download_failed"
                    },
                    "S3 object is unavailable or access was denied",
                ));
            }
            let size = head
                .content_length
                .map(u64::try_from)
                .transpose()
                .map_err(|_| PreviewError::new("download_failed", "Invalid S3 object size"))?;
            Metadata {
                modified: head.last_modified.as_deref().and_then(s3_time),
                size,
                validator: Some(
                    head.e_tag
                        .filter(|etag| !etag.is_empty() && !etag.starts_with("W/"))
                        .map(|etag| (etag, head.version_id))
                        .ok_or_else(|| {
                            PreviewError::new(
                                "download_failed",
                                "This S3 service provides no strong ETag for a consistent preview",
                            )
                        })?,
                ),
            }
        }
    };
    if let Some(size) = result.size {
        staging::check_size(size)?;
    }
    Ok(result)
}

pub async fn prepare(
    source: &Source,
    fresh: &Arc<StagedFile>,
    cached: Option<Arc<CachedFile>>,
    cancel: &CancellationToken,
    scope: &ChannelScope,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Arc<CachedFile>, PreviewError> {
    let metadata = metadata(source, scope).await?;
    if let Some(cached) = cached.filter(|file| file.reusable(&metadata)) {
        return Ok(cached);
    }
    // Use the start of downloading, rather than completion: updates made
    // during a slow transfer must not become older than the cache timestamp.
    let added_at = SystemTime::now();
    staging::download(source, fresh, cancel, scope, &mut progress).await?;
    let bytes = std::fs::metadata(&fresh.complete)
        .map_err(PreviewError::io)?
        .len();
    Ok(Arc::new(CachedFile {
        file: fresh.clone(),
        metadata,
        added_at,
        bytes,
        ssh_id: source.ssh_id().map(str::to_string),
    }))
}

#[cfg(test)]
mod tests {
    use super::super::staging::StagingRoot;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn target(session: &str, bucket: &str, key: &str) -> Target {
        Target::S3 {
            session_id: session.into(),
            bucket_name: bucket.into(),
            key: key.into(),
        }
    }

    fn cached(root: &StagingRoot) -> Arc<CachedFile> {
        let file = Arc::new(root.request("test.txt").unwrap());
        std::fs::write(&file.complete, b"hello").unwrap();
        Arc::new(CachedFile {
            file,
            metadata: Metadata {
                modified: epoch_time(1_700_000_000),
                size: Some(5),
                validator: None,
            },
            added_at: epoch_time(1_700_000_010).unwrap(),
            bytes: 5,
            ssh_id: Some("ssh".into()),
        })
    }

    #[test]
    fn freshness_requires_a_known_timestamp_and_an_intact_regular_file() {
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let mut file = cached(&root);
        assert!(file.reusable(&file.metadata));
        // Equality reuses a complete file too; future mtimes always miss.
        Arc::get_mut(&mut file).unwrap().added_at = file.metadata.modified.unwrap();
        assert!(file.reusable(&file.metadata));
        Arc::get_mut(&mut file).unwrap().added_at = epoch_time(1_699_999_999).unwrap();
        assert!(!file.reusable(&file.metadata));
        Arc::get_mut(&mut file).unwrap().added_at = epoch_time(1_700_000_010).unwrap();
        for metadata in [
            Metadata {
                modified: None,
                ..file.metadata.clone()
            },
            Metadata {
                modified: epoch_time(1_700_000_011),
                ..file.metadata.clone()
            },
            Metadata {
                size: Some(6),
                ..file.metadata.clone()
            },
            Metadata {
                validator: Some(("new".into(), None)),
                ..file.metadata.clone()
            },
        ] {
            assert!(!file.reusable(&metadata));
        }
        std::fs::write(&file.file.complete, b"bad").unwrap();
        assert!(!file.reusable(&file.metadata));
        std::fs::remove_file(&file.file.complete).unwrap();
        assert!(!file.reusable(&file.metadata));
        #[cfg(unix)]
        {
            let elsewhere = parent.path().join("elsewhere");
            std::fs::write(&elsewhere, b"hello").unwrap();
            std::os::unix::fs::symlink(&elsewhere, &file.file.complete).unwrap();
            assert!(!file.reusable(&file.metadata));
        }
    }

    #[test]
    fn cache_separates_targets_and_preserves_panel_files_until_detach() {
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let file = cached(&root);
        let path = file.file.complete.clone();
        let a = target("session", "bucket", "a/test.txt");
        let mut cache = PreviewCache::default();
        cache.insert(a.clone(), file.clone());
        for other in [
            target("other", "bucket", "a/test.txt"),
            target("session", "other", "a/test.txt"),
            target("session", "bucket", "b/test.txt"),
            Target::Sftp {
                session_id: "session".into(),
                path: "a/test.txt".into(),
            },
            Target::Scp {
                session_id: "session".into(),
                path: "a/test.txt".into(),
            },
        ] {
            assert!(cache.take(&other).is_none());
        }
        let hit = cache.take(&a).unwrap();
        assert!(Arc::ptr_eq(&file, &hit));
        cache.insert(a, hit);
        cache.close_session("other");
        assert_eq!(cache.entries.len(), 1);
        cache.close_session("session");
        assert!(cache.entries.is_empty());
        assert!(path.exists()); // Panel still holds the file.
        drop(file);
        assert!(!path.exists());

        let file = cached(&root);
        cache.insert(target("sftp", "", "test.txt"), file.clone());
        cache.close_ssh_session("unrelated");
        assert_eq!(cache.entries.len(), 1);
        cache.close_ssh_session("ssh");
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn eviction_bounds_both_disk_bytes_and_entry_count_and_keeps_recent_hits() {
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let mut cache = PreviewCache::default();
        for index in 0..MAX_CACHE_ENTRIES {
            cache.insert(target("s", "b", &index.to_string()), cached(&root));
        }
        let key = target("s", "b", "0");
        let hit = cache.take(&key).unwrap();
        cache.insert(key.clone(), hit);
        cache.insert(target("s", "b", "extra"), cached(&root));
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(cache.take(&target("s", "b", "1")).is_none());
        assert!(cache.take(&key).is_some());
        cache.clear();
        for index in 0..6 {
            let mut file = cached(&root);
            Arc::get_mut(&mut file).unwrap().bytes = super::super::MAX_BYTES;
            cache.insert(target("s", "b", &index.to_string()), file);
        }
        assert_eq!(cache.entries.len(), 5);
        assert!(cache.take(&target("s", "b", "0")).is_none());
    }

    #[test]
    fn parses_s3_last_modified_without_using_local_timezone() {
        assert_eq!(
            s3_time("Tue, 14 Nov 2023 22:13:20 GMT"),
            epoch_time(1_700_000_000)
        );
        assert_eq!(s3_time("2023-11-14T22:13:20Z"), epoch_time(1_700_000_000));
        assert_eq!(s3_time("invalid"), None);
    }

    async fn fixture(responses: Vec<String>) -> (Source, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 16 * 1024);
                }
                requests.push(String::from_utf8(request).unwrap());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        let bucket = s3::Bucket::new(
            "fixture",
            s3::Region::Custom {
                region: "test".into(),
                endpoint: format!("http://{address}"),
            },
            s3::creds::Credentials::anonymous().unwrap(),
        )
        .unwrap()
        .with_path_style();
        (
            Source::S3 {
                bucket,
                key: "test.txt".into(),
            },
            server,
        )
    }

    fn head(etag: &str, modified: Option<&str>) -> String {
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\nETag: \"{etag}\"\r\n{}\r\n",
            modified.map(|value| format!("Last-Modified: {value}\r\n")).unwrap_or_default())
    }

    fn download_responses(etag: &str, modified: Option<&str>, contents: &str) -> Vec<String> {
        vec![
            head(etag, modified),
            head(etag, modified),
            format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\n\r\n{contents}"),
            head(etag, modified),
        ]
    }

    async fn open(
        root: &StagingRoot,
        source: &Source,
        cached: Option<Arc<CachedFile>>,
    ) -> Result<Arc<CachedFile>, PreviewError> {
        let fresh = Arc::new(root.request("test.txt").unwrap());
        let cancel = CancellationToken::new();
        let scope = ChannelScope::new(&cancel);
        let result = prepare(source, &fresh, cached, &cancel, &scope, |_, _| {}).await;
        scope.finish().await;
        result
    }

    #[tokio::test]
    async fn s3_reopen_only_heads_then_redownloads_newer_or_replaced_objects() {
        let old = Some("Tue, 14 Nov 2023 22:13:20 GMT");
        let new = Some("Thu, 01 Jan 2037 00:00:00 GMT");
        let mut responses = download_responses("A", old, "hello");
        responses.push(head("A", old)); // Reopen: metadata only, no GET.
        responses.extend(download_responses("B", new, "newer"));
        responses.extend(download_responses("C", new, "third")); // Same mtime, new ETag.
        let (source, server) = fixture(responses).await;
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let first = open(&root, &source, None).await.unwrap();
        let second = open(&root, &source, Some(first.clone())).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let third = open(&root, &source, Some(second)).await.unwrap();
        assert_ne!(first.file.complete, third.file.complete);
        assert_eq!(std::fs::read(&third.file.complete).unwrap(), b"newer");
        let fourth = open(&root, &source, Some(third)).await.unwrap();
        assert_eq!(std::fs::read(&fourth.file.complete).unwrap(), b"third");
        let requests = server.await.unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("GET "))
                .count(),
            3
        );
        assert!(requests[4].starts_with("HEAD "));
    }

    #[tokio::test]
    async fn s3_missing_or_invalid_timestamp_and_missing_local_file_force_download() {
        for (modified, remove) in [
            (None, false),
            (Some("invalid"), false),
            (Some("Tue, 14 Nov 2023 22:13:20 GMT"), true),
        ] {
            let mut responses = download_responses("A", modified, "hello");
            responses.extend(download_responses("A", modified, "hello"));
            let (source, server) = fixture(responses).await;
            let parent = tempfile::tempdir().unwrap();
            let root = StagingRoot::new(parent.path()).unwrap();
            let first = open(&root, &source, None).await.unwrap();
            if remove {
                std::fs::remove_file(&first.file.complete).unwrap();
            }
            let second = open(&root, &source, Some(first.clone())).await.unwrap();
            assert_ne!(first.file.complete, second.file.complete);
            assert_eq!(
                server
                    .await
                    .unwrap()
                    .iter()
                    .filter(|r| r.starts_with("GET "))
                    .count(),
                2
            );
        }
    }

    #[tokio::test]
    async fn s3_denied_or_deleted_remote_never_falls_back_to_cached_contents() {
        for (status, kind) in [(403, "permission_denied"), (404, "download_failed")] {
            let modified = Some("Tue, 14 Nov 2023 22:13:20 GMT");
            let mut responses = download_responses("A", modified, "hello");
            responses.push(format!(
                "HTTP/1.1 {status} Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ));
            let (source, server) = fixture(responses).await;
            let parent = tempfile::tempdir().unwrap();
            let root = StagingRoot::new(parent.path()).unwrap();
            let first = open(&root, &source, None).await.unwrap();
            let error = open(&root, &source, Some(first)).await.err().unwrap();
            assert_eq!(error.kind, kind);
            assert_eq!(server.await.unwrap().len(), 5);
        }
    }
}
