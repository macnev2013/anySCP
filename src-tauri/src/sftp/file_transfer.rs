//! Single-file SFTP transfer engine.
//!
//! Resumable jobs keep their checkpoint in the transfer manager and write to a
//! stable `.part` path. Directory jobs use the same byte-transfer code with an
//! ephemeral checkpoint that is removed on failure. Final destinations are
//! replaced only after every byte has been acknowledged and the partial file
//! has been closed.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{map_client_error, map_remote_io, SftpError};

const CHUNK_SIZE: usize = 256 * 1024;
const PIPELINE_DEPTH: u64 = 4;
const VERIFY_WINDOW: u64 = 64 * 1024;

fn remote_context(error: SftpError, context: impl std::fmt::Display) -> SftpError {
    match error {
        SftpError::TransportError(message) => {
            SftpError::TransportError(format!("{context}: {message}"))
        }
        other => SftpError::RemoteIoError(format!("{context}: {other}")),
    }
}

#[derive(Clone)]
pub struct UploadCheckpoint(Arc<Mutex<UploadState>>);

struct UploadState {
    source: LocalFingerprint,
    initialized: bool,
    /// Each cursor advances independently because regions upload concurrently.
    regions: Vec<UploadRegion>,
}

#[derive(Clone, Copy)]
struct LocalFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UploadRegion {
    start: u64,
    end: u64,
    next: u64,
}

impl UploadCheckpoint {
    pub fn new(metadata: &std::fs::Metadata) -> Self {
        let source = LocalFingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        };
        let regions = plan_upload_regions(source.len)
            .into_iter()
            .map(|(start, end)| UploadRegion {
                start,
                end,
                next: start,
            })
            .collect();
        Self(Arc::new(Mutex::new(UploadState {
            source,
            initialized: false,
            regions,
        })))
    }

    pub fn transferred(&self) -> u64 {
        self.state()
            .regions
            .iter()
            .map(|region| region.next - region.start)
            .sum()
    }

    pub fn has_partial(&self) -> bool {
        self.state().initialized
    }

    pub fn clear_partial(&self) {
        self.state().initialized = false;
    }

    fn validate(&self, metadata: &std::fs::Metadata) -> Result<(), SftpError> {
        let source = self.state().source;
        if metadata.len() != source.len || metadata.modified().ok() != source.modified {
            return Err(SftpError::LocalIoError(
                "local file changed since the transfer started".to_string(),
            ));
        }
        Ok(())
    }

    fn initialized(&self) -> bool {
        self.state().initialized
    }

    fn mark_initialized(&self) {
        self.state().initialized = true;
    }

    fn pending_regions(&self) -> Vec<(usize, u64, u64)> {
        self.state()
            .regions
            .iter()
            .enumerate()
            .filter_map(|(index, region)| {
                (region.next < region.end).then_some((index, region.next, region.end))
            })
            .collect()
    }

    fn advance(&self, index: usize, bytes: u64) {
        let mut state = self.state();
        let region = &mut state.regions[index];
        region.next += bytes;
        debug_assert!(region.next <= region.end);
    }

    fn verification_windows(&self) -> Vec<(u64, u64)> {
        self.state()
            .regions
            .iter()
            .filter(|region| region.next > region.start)
            .map(|region| {
                let start = region.next.saturating_sub(VERIFY_WINDOW).max(region.start);
                (start, region.next - start)
            })
            .collect()
    }

    fn state(&self) -> MutexGuard<'_, UploadState> {
        self.0.lock().expect("upload checkpoint poisoned")
    }
}

#[derive(Clone)]
pub struct DownloadCheckpoint(Arc<Mutex<DownloadState>>);

struct DownloadState {
    source: RemoteFingerprint,
    initialized: bool,
    offset: u64,
}

#[derive(Clone, Copy)]
struct RemoteFingerprint {
    len: u64,
    modified: Option<u32>,
}

impl DownloadCheckpoint {
    pub fn new(size: u64, modified: Option<u32>) -> Self {
        Self(Arc::new(Mutex::new(DownloadState {
            source: RemoteFingerprint {
                len: size,
                modified,
            },
            initialized: false,
            offset: 0,
        })))
    }

    pub fn has_partial(&self) -> bool {
        self.state().initialized
    }

    pub fn clear_partial(&self) {
        self.state().initialized = false;
    }

    fn validate(&self, attributes: &FileAttributes) -> Result<(), SftpError> {
        let source = self.state().source;
        if attributes.size.unwrap_or(0) != source.len || attributes.mtime != source.modified {
            return Err(SftpError::RemoteIoError(
                "remote file changed since the transfer started".to_string(),
            ));
        }
        Ok(())
    }

    fn source_len(&self) -> u64 {
        self.state().source.len
    }

    fn offset(&self) -> u64 {
        self.state().offset
    }

    fn mark_initialized(&self) {
        self.state().initialized = true;
    }

    fn advance(&self, bytes: u64) {
        self.state().offset += bytes;
    }

    fn state(&self) -> MutexGuard<'_, DownloadState> {
        self.0.lock().expect("download checkpoint poisoned")
    }
}

pub async fn upload_resumable(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &Path,
    remote_path: &str,
    transfer_id: &str,
    checkpoint: UploadCheckpoint,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let partial_path = upload_partial_path(remote_path, transfer_id);
    upload(
        sftp,
        local_path,
        remote_path,
        &partial_path,
        checkpoint,
        cancel,
        progress,
    )
    .await
}

pub async fn upload_fresh(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &Path,
    remote_path: &str,
    transfer_id: &str,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let metadata = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    let checkpoint = UploadCheckpoint::new(&metadata);
    let partial_path = upload_partial_path(remote_path, transfer_id);
    let result = upload(
        sftp,
        local_path,
        remote_path,
        &partial_path,
        checkpoint,
        cancel,
        progress,
    )
    .await;
    if result.is_err() {
        let session = sftp.lock().await;
        let _ = session.remove_file(&partial_path).await;
    }
    result
}

async fn upload(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &Path,
    remote_path: &str,
    partial_path: &str,
    checkpoint: UploadCheckpoint,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let metadata = tokio::fs::metadata(local_path).await.map_err(|e| {
        SftpError::LocalIoError(format!("Cannot read {}: {e}", local_path.display()))
    })?;
    checkpoint.validate(&metadata)?;

    if !checkpoint.initialized() {
        let session = sftp.lock().await;
        let mut file = session
            .open_with_flags(
                partial_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(map_client_error)?;
        file.shutdown().await.map_err(map_remote_io)?;
        checkpoint.mark_initialized();
    } else if checkpoint.transferred() > 0 {
        verify_upload_partial(sftp, local_path, partial_path, &checkpoint).await?;
    }

    if cancel.is_cancelled() {
        return Err(SftpError::TransferCancelled);
    }

    let region_cancel = cancel.child_token();
    let mut tasks = JoinSet::new();
    for (index, start, end) in checkpoint.pending_regions() {
        tasks.spawn(upload_region(UploadRegionContext {
            sftp: sftp.clone(),
            local_path: local_path.to_path_buf(),
            remote_path: partial_path.to_string(),
            checkpoint: checkpoint.clone(),
            cancel: region_cancel.clone(),
            progress: progress.clone(),
            index,
            start,
            end,
        }));
    }
    drop(progress);

    let mut first_error = None;
    let mut cancelled = false;
    while let Some(result) = tasks.join_next().await {
        let result = result.unwrap_or_else(|e| Err(SftpError::RemoteIoError(e.to_string())));
        if let Err(error) = result {
            match error {
                SftpError::TransferCancelled => cancelled = true,
                other => {
                    if first_error.is_none() {
                        first_error = Some(other);
                    }
                    region_cancel.cancel();
                }
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    if cancelled {
        return Err(SftpError::TransferCancelled);
    }

    finalize_upload(sftp, partial_path, remote_path).await
}

struct UploadRegionContext {
    sftp: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: PathBuf,
    remote_path: String,
    checkpoint: UploadCheckpoint,
    cancel: CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
    index: usize,
    start: u64,
    end: u64,
}

async fn upload_region(context: UploadRegionContext) -> Result<(), SftpError> {
    let mut local_file = tokio::fs::File::open(&context.local_path)
        .await
        .map_err(|e| {
            SftpError::LocalIoError(format!("Cannot read {}: {e}", context.local_path.display()))
        })?;
    local_file
        .seek(std::io::SeekFrom::Start(context.start))
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    let mut remote_file = {
        let session = context.sftp.lock().await;
        session
            .open_with_flags(&context.remote_path, OpenFlags::WRITE)
            .await
            .map_err(map_client_error)?
    };
    remote_file
        .seek(std::io::SeekFrom::Start(context.start))
        .await
        .map_err(map_remote_io)?;

    copy_region(
        &mut local_file,
        &mut remote_file,
        context.end - context.start,
        &context.cancel,
        |bytes| {
            context.checkpoint.advance(context.index, bytes);
            let _ = context.progress.send(bytes);
            Ok(())
        },
    )
    .await?;

    remote_file.shutdown().await.map_err(map_remote_io)
}

async fn verify_upload_partial(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &Path,
    partial_path: &str,
    checkpoint: &UploadCheckpoint,
) -> Result<(), SftpError> {
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    let mut remote_file = {
        let session = sftp.lock().await;
        session.open(partial_path).await.map_err(map_client_error)?
    };

    for (start, len) in checkpoint.verification_windows() {
        let local = read_range(&mut local_file, start, len)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        let remote = read_range(&mut remote_file, start, len)
            .await
            .map_err(map_remote_io)?;
        if local != remote {
            return Err(SftpError::RemoteIoError(
                "partial upload no longer matches the local file".to_string(),
            ));
        }
    }
    Ok(())
}

pub async fn download_resumable(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_path: &Path,
    transfer_id: &str,
    checkpoint: DownloadCheckpoint,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let partial_path = download_partial_path(local_path, transfer_id);
    download(
        sftp,
        remote_path,
        local_path,
        &partial_path,
        checkpoint,
        cancel,
        progress,
    )
    .await
}

pub async fn download_fresh(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_path: &Path,
    transfer_id: &str,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let attributes = {
        let session = sftp.lock().await;
        session
            .metadata(remote_path)
            .await
            .map_err(map_client_error)?
    };
    let checkpoint = DownloadCheckpoint::new(attributes.size.unwrap_or(0), attributes.mtime);
    let partial_path = download_partial_path(local_path, transfer_id);
    let result = download(
        sftp,
        remote_path,
        local_path,
        &partial_path,
        checkpoint,
        cancel,
        progress,
    )
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial_path).await;
    }
    result
}

async fn download(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_path: &Path,
    partial_path: &Path,
    checkpoint: DownloadCheckpoint,
    cancel: &CancellationToken,
    progress: mpsc::UnboundedSender<u64>,
) -> Result<(), SftpError> {
    let attributes = {
        let session = sftp.lock().await;
        session
            .metadata(remote_path)
            .await
            .map_err(map_client_error)?
    };
    checkpoint.validate(&attributes)?;

    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    }

    let offset = checkpoint.offset();
    let mut local_file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(partial_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    checkpoint.mark_initialized();

    let partial_len = local_file
        .metadata()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?
        .len();
    if partial_len < offset {
        return Err(SftpError::LocalIoError(
            "partial download is shorter than its checkpoint".to_string(),
        ));
    }
    let mut remote_file = {
        let session = sftp.lock().await;
        session.open(remote_path).await.map_err(map_client_error)?
    };
    if offset > 0 {
        let start = offset.saturating_sub(VERIFY_WINDOW);
        let len = offset - start;
        let local = read_range(&mut local_file, start, len)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        let remote = read_range(&mut remote_file, start, len)
            .await
            .map_err(map_remote_io)?;
        if local != remote {
            return Err(SftpError::LocalIoError(
                "partial download no longer matches the remote file".to_string(),
            ));
        }
    }
    local_file
        .set_len(offset)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    local_file
        .seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    remote_file
        .seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(map_remote_io)?;

    let mut buffer = vec![0u8; CHUNK_SIZE];
    while checkpoint.offset() < checkpoint.source_len() {
        if cancel.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        let remaining = checkpoint.source_len() - checkpoint.offset();
        let wanted = buffer.len().min(remaining as usize);
        let read = remote_file
            .read(&mut buffer[..wanted])
            .await
            .map_err(map_remote_io)?;
        if read == 0 {
            return Err(SftpError::RemoteIoError(
                "remote file ended before the expected size".to_string(),
            ));
        }
        local_file
            .write_all(&buffer[..read])
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        checkpoint.advance(read as u64);
        let _ = progress.send(read as u64);
    }
    drop(progress);

    local_file
        .flush()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    remote_file.shutdown().await.map_err(map_remote_io)?;
    drop(local_file);

    finalize_download(partial_path, local_path).await
}

async fn finalize_upload(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    partial_path: &str,
    remote_path: &str,
) -> Result<(), SftpError> {
    let session = sftp.lock().await;
    match session.rename(partial_path, remote_path).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            let partial_exists = session.metadata(partial_path).await.is_ok();
            let destination_exists = session.metadata(remote_path).await.is_ok();
            if !partial_exists || !destination_exists {
                return Err(remote_context(
                    map_client_error(first_error),
                    format_args!("Cannot finalize {remote_path}"),
                ));
            }
            session.remove_file(remote_path).await.map_err(|error| {
                remote_context(
                    map_client_error(error),
                    format_args!("Cannot replace {remote_path}"),
                )
            })?;
            session
                .rename(partial_path, remote_path)
                .await
                .map_err(|error| {
                    remote_context(
                        map_client_error(error),
                        format_args!("Cannot finalize {remote_path}"),
                    )
                })
        }
    }
}

async fn finalize_download(partial_path: &Path, local_path: &Path) -> Result<(), SftpError> {
    match tokio::fs::rename(partial_path, local_path).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if !partial_path.exists() || !local_path.exists() {
                return Err(SftpError::LocalIoError(format!(
                    "Cannot finalize download: {first_error}"
                )));
            }
            tokio::fs::remove_file(local_path)
                .await
                .map_err(|e| SftpError::LocalIoError(format!("Cannot replace download: {e}")))?;
            tokio::fs::rename(partial_path, local_path)
                .await
                .map_err(|e| SftpError::LocalIoError(format!("Cannot finalize download: {e}")))
        }
    }
}

pub async fn discard_upload(
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    transfer_id: &str,
) -> Result<(), SftpError> {
    use russh_sftp::client::error::Error;
    use russh_sftp::protocol::StatusCode;

    let session = sftp.lock().await;
    match session
        .remove_file(&upload_partial_path(remote_path, transfer_id))
        .await
    {
        Ok(()) => Ok(()),
        Err(Error::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(()),
        Err(error) => Err(map_client_error(error)),
    }
}

pub async fn discard_download(local_path: &Path, transfer_id: &str) -> Result<(), SftpError> {
    match tokio::fs::remove_file(download_partial_path(local_path, transfer_id)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SftpError::LocalIoError(error.to_string())),
    }
}

fn upload_partial_path(remote_path: &str, transfer_id: &str) -> String {
    format!("{remote_path}.anyscp-{transfer_id}.part")
}

fn download_partial_path(local_path: &Path, transfer_id: &str) -> PathBuf {
    let mut name = local_path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".anyscp-{transfer_id}.part"));
    local_path.with_file_name(name)
}

fn plan_upload_regions(file_size: u64) -> Vec<(u64, u64)> {
    if file_size == 0 {
        return Vec::new();
    }
    let depth = if file_size < CHUNK_SIZE as u64 * 2 {
        1
    } else {
        PIPELINE_DEPTH.min(file_size / CHUNK_SIZE as u64 + 1)
    };
    let region_size = file_size.div_ceil(depth);
    (0..depth)
        .map(|i| (i * region_size, ((i + 1) * region_size).min(file_size)))
        .filter(|(start, end)| start < end)
        .collect()
}

async fn copy_region<R, W, F>(
    local: &mut R,
    remote: &mut W,
    len: u64,
    cancel: &CancellationToken,
    mut on_progress: F,
) -> Result<(), SftpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64) -> Result<(), SftpError>,
{
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut remaining = len;
    while remaining > 0 {
        if cancel.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        let wanted = buffer.len().min(remaining as usize);
        let read = local
            .read(&mut buffer[..wanted])
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        if read == 0 {
            return Err(SftpError::LocalIoError(format!(
                "file shrank during upload ({remaining} bytes missing)"
            )));
        }
        remote
            .write_all(&buffer[..read])
            .await
            .map_err(map_remote_io)?;
        remaining -= read as u64;
        on_progress(read as u64)?;
    }
    Ok(())
}

async fn read_range<R>(reader: &mut R, start: u64, len: u64) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + AsyncSeek + Unpin,
{
    reader.seek(std::io::SeekFrom::Start(start)).await?;
    let mut bytes = vec![0; len as usize];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "file_transfer_tests.rs"]
mod tests;
