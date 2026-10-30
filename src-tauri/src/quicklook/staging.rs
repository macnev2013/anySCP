//! Private, bounded staging. Only backend-generated directories are removed.
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{PreviewError, Target, MAX_BYTES};

pub struct StagingRoot {
    path: PathBuf,
    _owner: File,
}

fn private_dir(path: &Path) -> Result<(), PreviewError> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(path).map_err(PreviewError::io)?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(PreviewError::new(
                    "local_io",
                    "Unsafe Quick Look staging directory",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o077 != 0 {
                    return Err(PreviewError::new(
                        "local_io",
                        "Quick Look staging must be private",
                    ));
                }
            }
            Ok(())
        }
        Err(e) => Err(PreviewError::io(e)),
    }
}

fn private_file(path: &Path, create_new: bool) -> Result<File, PreviewError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(PreviewError::io)
}

impl StagingRoot {
    pub fn new(parent: &Path) -> Result<Self, PreviewError> {
        std::fs::create_dir_all(parent).map_err(PreviewError::io)?;
        let root = parent.join("quicklook-v1");
        private_dir(&root)?;
        // Serialize sweeping with creation/locking of a new run. A live run
        // always holds its owner lock before this global lock is released.
        let sweep = private_file(&root.join("sweep.lock"), false)?;
        sweep.lock_exclusive().map_err(PreviewError::io)?;
        for entry in std::fs::read_dir(&root).map_err(PreviewError::io)? {
            let Ok(entry) = entry else {
                continue;
            };
            if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
                || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                continue;
            }
            let lock_path = entry.path().join("owner.lock");
            if let Ok(meta) = std::fs::symlink_metadata(&lock_path) {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    continue;
                }
            }
            let owner = match private_file(&lock_path, false) {
                Ok(owner) => owner,
                Err(_) => continue, // Another live process may just have removed its own run.
            };
            if owner.try_lock_exclusive().is_ok() {
                // Retain the owner lock until removal completes.
                if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                    tracing::warn!(error = %e, "Could not clean stale Quick Look run");
                }
            }
        }
        let path = root.join(uuid::Uuid::new_v4().to_string());
        private_dir(&path)?;
        let owner = private_file(&path.join("owner.lock"), true)?;
        owner.lock_exclusive().map_err(PreviewError::io)?;
        Ok(Self {
            path,
            _owner: owner,
        })
    }

    pub fn cleanup(&self) {
        if let Err(e) = std::fs::remove_dir_all(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "Could not clean Quick Look run");
            }
        }
    }

    pub fn request(&self, name: &str) -> Result<StagedFile, PreviewError> {
        crate::sftp::validate_remote_name(name)
            .map_err(|_| PreviewError::new("invalid_selection", "Unsafe preview filename"))?;
        let directory = self.path.join(uuid::Uuid::new_v4().to_string());
        private_dir(&directory)?;
        let part_name = if name == "download.part" {
            "download.part.part"
        } else {
            "download.part"
        };
        Ok(StagedFile {
            part: directory.join(part_name),
            complete: directory.join(name),
            directory,
        })
    }
}

impl Drop for StagingRoot {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub struct StagedFile {
    directory: PathBuf,
    part: PathBuf,
    pub complete: PathBuf,
}

impl StagedFile {
    pub fn writer(&self) -> Result<tokio::fs::File, PreviewError> {
        Ok(tokio::fs::File::from_std(private_file(&self.part, true)?))
    }

    pub async fn finish(&self) -> Result<(), PreviewError> {
        tokio::fs::rename(&self.part, &self.complete)
            .await
            .map_err(PreviewError::io)
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.directory) {
            if error.kind() == std::io::ErrorKind::NotFound {
                return;
            }
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let directory = self.directory.clone();
                runtime.spawn(async move {
                    for delay in [100, 500, 1500] {
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        match tokio::fs::remove_dir_all(&directory).await {
                            Ok(()) => return,
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                            Err(_) => {}
                        }
                    }
                    tracing::warn!(
                        "Quick Look request cleanup deferred to next startup after retries"
                    );
                });
            } else {
                tracing::warn!(error = %error, "Quick Look request cleanup deferred to next startup");
            }
        }
    }
}

pub fn check_size(size: u64) -> Result<(), PreviewError> {
    if size > MAX_BYTES {
        Err(PreviewError::new(
            "too_large",
            "Quick Look supports files up to 100 MiB",
        ))
    } else {
        Ok(())
    }
}

/// Counts actual bytes before writing. The entire future is cancellation-safe:
/// the manager selects against cancellation/deadline even while read is pending.
pub async fn bounded_copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    expected: Option<u64>,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<u64, PreviewError> {
    if let Some(size) = expected {
        check_size(size)?;
    }
    let mut buffer = [0u8; 32 * 1024];
    let mut received = 0;
    progress(0, expected);
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(PreviewError::remote)?;
        if count == 0 {
            break;
        }
        received += count as u64;
        check_size(received)?;
        writer
            .write_all(&buffer[..count])
            .await
            .map_err(PreviewError::io)?;
        progress(received, expected);
    }
    if expected.is_some_and(|expected| expected != received) {
        return Err(PreviewError::new(
            "download_failed",
            "Remote file changed size during preview download",
        ));
    }
    writer.flush().await.map_err(PreviewError::io)?;
    Ok(received)
}

type SshHandle = crate::ssh::handle::SharedHandle;

/// Snapshot session handles at acceptance, including the actual SCP transport
/// and bucket. No manager map guard survives a network await.
pub enum Source {
    Sftp {
        handle: SshHandle,
        sudo: bool,
        path: String,
        ssh_id: String,
    },
    Scp {
        handle: SshHandle,
        flavor: crate::scp::listing::Flavor,
        path: String,
        ssh_id: String,
    },
    S3 {
        bucket: Box<s3::Bucket>,
        key: String,
    },
}
impl Source {
    pub fn bind(app: &tauri::AppHandle, target: &Target) -> Result<Self, PreviewError> {
        use tauri::Manager;
        match target {
            Target::Sftp { session_id, path } => {
                let manager = app.state::<Arc<crate::sftp::SftpManager>>();
                let session = manager
                    .get_session(session_id)
                    .map_err(PreviewError::session)?;
                let ssh_id = session.ssh_session_id.clone();
                let handle = app
                    .state::<crate::ssh::manager::SshManager>()
                    .get_handle(&ssh_id)
                    .map_err(PreviewError::session)?;
                Ok(Self::Sftp {
                    handle,
                    sudo: session.use_sudo,
                    path: path.clone(),
                    ssh_id,
                })
            }
            Target::Scp { session_id, path } => {
                let manager = app.state::<Arc<crate::scp::ScpManager>>();
                let session = manager
                    .get_session(session_id)
                    .map_err(PreviewError::session)?;
                Ok(Self::Scp {
                    handle: session.ssh_handle.clone(),
                    flavor: session.flavor,
                    path: path.clone(),
                    ssh_id: session.ssh_session_id.clone(),
                })
            }
            Target::S3 {
                session_id,
                bucket_name,
                key,
            } => {
                let bucket = app
                    .state::<Arc<crate::s3::S3Manager>>()
                    .get_bucket(session_id)
                    .map_err(PreviewError::session)?;
                if bucket.name() != *bucket_name {
                    return Err(PreviewError::new(
                        "session_unavailable",
                        "The S3 bucket changed; select the file again",
                    ));
                }
                Ok(Self::S3 {
                    bucket,
                    key: key.clone(),
                })
            }
        }
    }
    pub fn ssh_id(&self) -> Option<&str> {
        match self {
            Self::Sftp { ssh_id, .. } | Self::Scp { ssh_id, .. } => Some(ssh_id),
            Self::S3 { .. } => None,
        }
    }
}

pub async fn download(
    source: &Source,
    file: &StagedFile,
    cancel: &tokio_util::sync::CancellationToken,
    scope: &crate::ssh::channel_scope::ChannelScope,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), PreviewError> {
    match source {
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
            if let Some(size) = meta.size {
                check_size(size)?;
            }
            let mut remote = sftp.open(path).await.map_err(PreviewError::remote)?;
            let meta = remote.metadata().await.map_err(PreviewError::remote)?;
            if meta.file_type() != russh_sftp::protocol::FileType::File {
                return Err(PreviewError::invalid_file());
            }
            let mut writer =
                crate::ssh::channel_scope::ScopedFile::new(file.writer()?, Some(scope));
            bounded_copy(&mut remote, &mut writer, meta.size, &mut progress).await?;
            let _ = remote.shutdown().await;
            writer.finish().await.map_err(PreviewError::io)?;
            let _ = sftp.close().await;
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
            check_size(meta.size)?;
            progress(0, Some(meta.size));
            crate::scp::transfer::download_file_limited(
                handle.clone(),
                path,
                &file.part,
                cancel,
                crate::scp::transfer::DownloadLimit {
                    max_bytes: MAX_BYTES,
                    expected_size: meta.size,
                    scope: Some(scope),
                },
                |bytes| progress(bytes, Some(meta.size)),
            )
            .await
            .map_err(|error| match error {
                crate::scp::ScpError::SizeLimitExceeded { .. } => {
                    PreviewError::new("too_large", "Quick Look supports files up to 100 MiB")
                }
                crate::scp::ScpError::TransferCancelled => {
                    PreviewError::new("cancelled", "Preview cancelled")
                }
                error => PreviewError::remote(error),
            })?;
        }
        Source::S3 { bucket, key } => {
            download_s3(bucket, key, file, Some(scope), &mut progress).await?;
        }
    }
    file.finish().await
}

pub(super) fn s3_error(error: s3::error::S3Error, message: &str) -> PreviewError {
    let kind = match error {
        s3::error::S3Error::HttpFailWithBody(401 | 403, _) => "permission_denied",
        s3::error::S3Error::HttpFailWithBody(412, _) => "object_changed",
        s3::error::S3Error::Reqwest(_)
        | s3::error::S3Error::Io(_)
        | s3::error::S3Error::Credentials(_) => "session_unavailable",
        _ => "download_failed",
    };
    // Never expose response bodies, signed URLs, or credential errors.
    PreviewError::new(kind, message)
}

async fn download_s3(
    bucket: &s3::Bucket,
    key: &str,
    file: &StagedFile,
    scope: Option<&crate::ssh::channel_scope::ChannelScope>,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<(), PreviewError> {
    use futures_util::StreamExt;
    if key.ends_with('/') {
        return Err(PreviewError::invalid_file());
    }
    let (head, code) = bucket.head_object(key).await.map_err(|error| {
        s3_error(
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
    let expected = match head.content_length {
        Some(size) if size < 0 => {
            return Err(PreviewError::new(
                "download_failed",
                "Invalid S3 object size",
            ))
        }
        Some(size) => {
            check_size(size as u64)?;
            Some(size as u64)
        }
        None => None,
    };
    let mut pinned = bucket.clone();
    let etag = head
        .e_tag
        .as_deref()
        .filter(|etag| !etag.is_empty() && !etag.starts_with("W/"))
        .ok_or_else(|| {
            PreviewError::new(
                "download_failed",
                "This S3 service provides no strong ETag for a consistent preview",
            )
        })?;
    let etag = if etag.starts_with('"') {
        etag.to_string()
    } else {
        format!("\"{etag}\"")
    };
    pinned.extra_headers_mut().insert(
        "if-match",
        etag.parse()
            .map_err(|_| PreviewError::new("download_failed", "Invalid S3 ETag"))?,
    );
    // One streaming GET avoids assembling ranges from different versions.
    // If-Match binds it to HEAD where supported. A second HEAD below also
    // detects services ignoring that condition while an object is changing.
    let mut response = pinned
        .get_object_stream(key)
        .await
        .map_err(|error| s3_error(error, "S3 object download failed or the object changed"))?;
    if response.status_code != 200 {
        let kind = match response.status_code {
            412 => "object_changed",
            401 | 403 => "permission_denied",
            _ => "download_failed",
        };
        return Err(PreviewError::new(
            kind,
            "S3 object changed or download was denied",
        ));
    }
    let mut writer = crate::ssh::channel_scope::ScopedFile::new(file.writer()?, scope);
    let mut received = 0;
    progress(0, expected);
    while let Some(chunk) = response.bytes().next().await {
        let chunk = chunk
            .map_err(|_| PreviewError::new("download_failed", "S3 object stream interrupted"))?;
        received += chunk.len() as u64;
        check_size(received)?;
        writer.write_all(&chunk).await.map_err(PreviewError::io)?;
        progress(received, expected);
    }
    if expected.is_some_and(|size| size != received) {
        return Err(PreviewError::new(
            "download_failed",
            "S3 object changed size during download",
        ));
    }
    writer.flush().await.map_err(PreviewError::io)?;
    writer.finish().await.map_err(PreviewError::io)?;
    let (after, code) = bucket
        .head_object(key)
        .await
        .map_err(|error| s3_error(error, "Could not verify the downloaded S3 object"))?;
    if code != 200
        || head.e_tag != after.e_tag
        || head.version_id != after.version_id
        || head.content_length != after.content_length
    {
        return Err(PreviewError::new(
            "download_failed",
            "S3 object changed during download; try again",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn actual_limit_includes_boundary_and_rejects_unknown_or_forged_sizes() {
        for (actual, expected, kind) in [
            (MAX_BYTES, Some(MAX_BYTES), None),
            (MAX_BYTES + 1, None, Some("too_large")),
            (MAX_BYTES + 1, Some(1), Some("too_large")),
            (10, Some(1), Some("download_failed")),
            (0, Some(0), None),
        ] {
            let mut reader = tokio::io::repeat(1).take(actual);
            let mut writer = tokio::io::sink();
            let result = bounded_copy(&mut reader, &mut writer, expected, &mut |_, _| {}).await;
            assert_eq!(result.err().as_ref().map(|e| e.kind.as_str()), kind);
        }
        assert!(check_size(MAX_BYTES).is_ok());
        assert_eq!(check_size(MAX_BYTES + 1).unwrap_err().kind, "too_large");
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_reader_that_never_produces_data() {
        let (mut reader, _writer) = tokio::io::duplex(1);
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            let mut sink = tokio::io::sink();
            let mut progress = |_, _| {};
            tokio::select! {
                _ = token.cancelled() => "cancelled",
                _ = bounded_copy(&mut reader, &mut sink, None, &mut progress) => "read",
            }
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap(),
            "cancelled"
        );
    }

    #[tokio::test]
    async fn staging_is_private_isolated_atomic_and_removed_after_failure() {
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let first = root.request("測試 with spaces.pdf").unwrap();
        let second = root.request("測試 with spaces.pdf").unwrap();
        assert_ne!(first.complete, second.complete);
        let directory = first.directory.clone();
        let mut writer = first.writer().unwrap();
        writer.write_all(b"hello").await.unwrap();
        writer.flush().await.unwrap();
        drop(writer);
        assert!(!first.complete.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&first.part).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        first.finish().await.unwrap();
        assert!(first.complete.exists());
        assert!(!first.part.exists());
        drop(first);
        assert!(!directory.exists());
        for name in ["", ".", "..", "a/b", "a\\b", "\0bad"] {
            assert!(root.request(name).is_err());
        }
    }

    #[test]
    fn sweep_preserves_live_runs_and_removes_dead_runs_only() {
        let parent = tempfile::tempdir().unwrap();
        let first = StagingRoot::new(parent.path()).unwrap();
        let dead = first
            .path
            .parent()
            .unwrap()
            .join(uuid::Uuid::new_v4().to_string());
        private_dir(&dead).unwrap();
        private_file(&dead.join("owner.lock"), true).unwrap();
        let unrelated = first.path.parent().unwrap().join("other-data");
        std::fs::create_dir(&unrelated).unwrap();
        let second = StagingRoot::new(parent.path()).unwrap();
        assert!(first.path.exists());
        assert!(second.path.exists());
        assert!(!dead.exists());
        assert!(unrelated.exists());
    }
}

#[cfg(test)]
mod s3_consistency_tests {
    use super::*;

    async fn fixture(
        responses: Vec<String>,
    ) -> (Box<s3::Bucket>, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
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
        (bucket, server)
    }
    fn head(etag: Option<&str>, size: Option<u64>) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n{}{}\r\n",
            etag.map(|etag| format!("ETag: {etag}\r\n"))
                .unwrap_or_default(),
            size.map(|size| format!("Content-Length: {size}\r\n"))
                .unwrap_or_default()
        )
    }
    fn body() -> String {
        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\n\r\nhello".into()
    }

    #[tokio::test]
    async fn dropping_a_cancelled_s3_reader_closes_the_stalled_http_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for number in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                if number == 0 {
                    socket
                        .write_all(head(Some("\"A\""), Some(10)).as_bytes())
                        .await
                        .unwrap();
                } else {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc").await.unwrap();
                    // The response body stalls here. Cancelling the downloader
                    // must close this socket instead of waiting for EOF.
                    assert_eq!(
                        tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            socket.read(&mut byte)
                        )
                        .await
                        .unwrap()
                        .unwrap(),
                        0
                    );
                }
            }
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
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let file = root.request("stalled.txt").unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut progress = |bytes, _| {
            if bytes > 0 {
                cancel.cancel();
            }
        };
        let result = super::super::with_deadline(
            &cancel,
            tokio::time::Instant::now() + std::time::Duration::from_secs(5),
            download_s3(&bucket, "key", &file, None, &mut progress),
        )
        .await;
        assert_eq!(result.unwrap_err().kind, "cancelled");
        assert!(!file.complete.exists());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn no_validator_or_oversized_metadata_never_starts_a_get() {
        for (response, kind) in [
            (head(None, Some(5)), "download_failed"),
            (head(Some("W/\"weak\""), Some(5)), "download_failed"),
            (head(Some("\"A\""), Some(MAX_BYTES + 1)), "too_large"),
        ] {
            let (bucket, server) = fixture(vec![response]).await;
            let parent = tempfile::tempdir().unwrap();
            let root = StagingRoot::new(parent.path()).unwrap();
            let file = root.request("test.txt").unwrap();
            assert_eq!(
                download_s3(&bucket, "key", &file, None, &mut |_, _| {})
                    .await
                    .unwrap_err()
                    .kind,
                kind
            );
            assert!(!file.complete.exists());
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn unknown_size_is_bounded_and_sends_a_quoted_condition() {
        let (bucket, server) =
            fixture(vec![head(Some("A"), None), body(), head(Some("A"), None)]).await;
        let parent = tempfile::tempdir().unwrap();
        let root = StagingRoot::new(parent.path()).unwrap();
        let file = root.request("test.txt").unwrap();
        download_s3(&bucket, "key", &file, None, &mut |_, _| {})
            .await
            .unwrap();
        let requests = server.await.unwrap();
        assert!(requests[1].to_lowercase().contains("if-match: \"a\"\r\n"));
        assert!(!requests[1].to_lowercase().contains("range:"));
        assert!(bucket.extra_headers().get("if-match").is_none());
    }

    #[tokio::test]
    async fn changed_object_or_denied_get_cannot_publish_partial_staging() {
        for (responses, kind) in [
            (vec![head(Some("\"A\""), Some(5)), body(), head(Some("\"B\""), Some(5))], "download_failed"),
            (vec![head(Some("\"A\""), Some(5)), "HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()], "object_changed"),
            (vec![head(Some("\"A\""), Some(5)), "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()], "permission_denied"),
        ] {
            let (bucket, server) = fixture(responses).await;
            let parent = tempfile::tempdir().unwrap(); let root = StagingRoot::new(parent.path()).unwrap();
            let file = root.request("test.txt").unwrap();
            assert_eq!(download_s3(&bucket, "key", &file, None, &mut |_, _| {}).await.unwrap_err().kind, kind);
            assert!(!file.complete.exists());
            server.await.unwrap();
        }
    }
}
