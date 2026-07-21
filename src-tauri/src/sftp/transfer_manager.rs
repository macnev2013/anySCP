use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use russh_sftp::protocol::OpenFlags;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::transfer_common::{apply_concurrency, eta_secs, record_progress, ProgressFields};

use super::{
    validate_remote_name, SftpError, SftpManager, TransferDirection, TransferEvent, TransferInfo,
    TransferStatus,
};

// ─── Constants ───────────────────────────────────────────────────────────────

const CHUNK_SIZE: usize = 256 * 1024; // 256 KB
/// Minimum duration between consecutive progress events per transfer.
const EMIT_THROTTLE: Duration = Duration::from_millis(100);
/// Fix infinite history
const MAX_FINISHED_HISTORY: usize = 200;
/// Window over which bytes are accumulated to compute speed.
const SPEED_WINDOW: Duration = Duration::from_millis(500);

// ─── Job state ───────────────────────────────────────────────────────────────

pub enum TransferJobKind {
    UploadFile {
        local_path: PathBuf,
        remote_path: String,
    },
    UploadDir {
        local_path: PathBuf,
        remote_dir: String,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
    },
    DownloadDir {
        remote_path: String,
        local_dir: PathBuf,
    },
}

pub struct TransferJobState {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub name: String,
    pub direction: TransferDirection,
    pub kind: TransferJobKind,
    pub status: TransferStatus,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub cancel_token: CancellationToken,
    pub error: Option<String>,
    pub created_at: u64,
    pub last_emit: Instant,
    pub speed_window_bytes: u64,
    pub speed_window_start: Instant,
}

impl TransferJobState {
    fn to_event(&self) -> TransferEvent {
        let eta_secs = eta_secs(self.speed_bps, self.total_bytes, self.bytes_transferred);

        TransferEvent {
            transfer_id: self.transfer_id.clone(),
            sftp_session_id: self.sftp_session_id.clone(),
            name: self.name.clone(),
            direction: self.direction.clone(),
            status: self.status.clone(),
            error: self.error.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            files_total: self.files_total,
            speed_bps: self.speed_bps,
            eta_secs,
            created_at: self.created_at,
        }
    }

    fn to_info(&self) -> TransferInfo {
        let eta_secs = eta_secs(self.speed_bps, self.total_bytes, self.bytes_transferred);

        TransferInfo {
            transfer_id: self.transfer_id.clone(),
            sftp_session_id: self.sftp_session_id.clone(),
            name: self.name.clone(),
            direction: self.direction.clone(),
            status: self.status.clone(),
            error: self.error.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            files_total: self.files_total,
            speed_bps: self.speed_bps,
            eta_secs,
            created_at: self.created_at,
        }
    }
}

// ─── Manager ─────────────────────────────────────────────────────────────────

impl ProgressFields for TransferJobState {
    fn bytes_transferred(&mut self) -> &mut u64 {
        &mut self.bytes_transferred
    }
    fn speed_bps(&mut self) -> &mut u64 {
        &mut self.speed_bps
    }
    fn speed_window_bytes(&mut self) -> &mut u64 {
        &mut self.speed_window_bytes
    }
    fn speed_window_start(&mut self) -> &mut Instant {
        &mut self.speed_window_start
    }
    fn last_emit(&mut self) -> &mut Instant {
        &mut self.last_emit
    }
}

pub struct TransferManager {
    jobs: Arc<DashMap<String, TransferJobState>>,
    /// FIFO if finished job ids, oldest to first
    finished_order: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    queue_tx: mpsc::UnboundedSender<String>,
    semaphore: Arc<Semaphore>,
    sftp_manager: Arc<SftpManager>,
    app_handle: AppHandle,
    max_concurrent: Arc<AtomicU32>,
    /// Holds the queue receiver until the worker loop is spawned (lazy init).
    worker_rx: Arc<std::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl TransferManager {
    pub fn new(sftp_manager: Arc<SftpManager>, app_handle: AppHandle) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel::<String>();
        let jobs: Arc<DashMap<String, TransferJobState>> = Arc::new(DashMap::new());
        let finished_order = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        let semaphore = Arc::new(Semaphore::new(3));
        let max_concurrent = Arc::new(AtomicU32::new(3));

        // Store the receiver — the worker loop is spawned lazily on first enqueue
        // because `new()` runs inside Tauri's `.setup()` where no tokio runtime is active yet.
        let worker_rx = Arc::new(std::sync::Mutex::new(Some(queue_rx)));

        Self {
            jobs,
            finished_order,
            queue_tx,
            semaphore,
            sftp_manager,
            app_handle,
            max_concurrent,
            worker_rx,
        }
    }

    /// Ensure the background worker loop is running. Called lazily on first enqueue.
    fn ensure_worker_spawned(&self) {
        let mut guard = self.worker_rx.lock().expect("worker_rx mutex poisoned");
        if let Some(mut queue_rx) = guard.take() {
            let jobs = self.jobs.clone();
            let finished_order = self.finished_order.clone();
            let semaphore = self.semaphore.clone();
            let sftp_manager = self.sftp_manager.clone();
            let app_handle = self.app_handle.clone();

            tokio::spawn(async move {
                while let Some(job_id) = queue_rx.recv().await {
                    let permit = semaphore
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("semaphore closed");

                    let jobs = jobs.clone();
                    let finished_order = finished_order.clone();
                    let sftp_manager = sftp_manager.clone();
                    let app_handle = app_handle.clone();

                    tokio::spawn(async move {
                        execute_transfer(
                            &jobs,
                            &finished_order,
                            &job_id,
                            &sftp_manager,
                            &app_handle,
                        )
                        .await;
                        drop(permit);
                    });
                }
            });
        }
        // If `guard` was already `None`, the worker was already spawned — nothing to do.
    }

    // ─── Enqueue helpers ─────────────────────────────────────────────────────

    fn unix_now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn emit_initial(
        jobs: &DashMap<String, TransferJobState>,
        job_id: &str,
        app_handle: &AppHandle,
    ) {
        if let Some(job) = jobs.get(job_id) {
            let _ = app_handle.emit("sftp:transfer", job.to_event());
        }
    }

    // ─── Upload ──────────────────────────────────────────────────────────────

    /// Enqueue one or more local paths for upload.
    /// Each path becomes a separate job (file or recursive dir).
    /// Returns the generated `transfer_id`s.
    #[instrument(skip(self), fields(sftp_session_id = %sftp_session_id))]
    pub async fn enqueue_upload(
        &self,
        sftp_session_id: String,
        local_paths: Vec<PathBuf>,
        remote_dir: String,
    ) -> Result<Vec<String>, SftpError> {
        self.ensure_worker_spawned();
        let mut ids = Vec::with_capacity(local_paths.len());

        for local_path in local_paths {
            let meta = tokio::fs::metadata(&local_path)
                .await
                .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

            let name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let transfer_id = uuid::Uuid::new_v4().to_string();
            let now = Self::unix_now_millis();
            let now_instant = Instant::now();

            let (kind, total_bytes, files_total) = if meta.is_dir() {
                let (bytes, count) = walk_local_dir_stats(&local_path).await;
                let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
                (
                    TransferJobKind::UploadDir {
                        local_path: local_path.clone(),
                        remote_dir: remote_path,
                    },
                    bytes,
                    count,
                )
            } else {
                let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
                (
                    TransferJobKind::UploadFile {
                        local_path: local_path.clone(),
                        remote_path,
                    },
                    meta.len(),
                    1u32,
                )
            };

            let job = TransferJobState {
                transfer_id: transfer_id.clone(),
                sftp_session_id: sftp_session_id.clone(),
                name: name.clone(),
                direction: TransferDirection::Upload,
                kind,
                status: TransferStatus::Queued,
                bytes_transferred: 0,
                total_bytes,
                files_done: 0,
                files_total,
                speed_bps: 0,
                cancel_token: CancellationToken::new(),
                error: None,
                created_at: now,
                last_emit: now_instant,
                speed_window_bytes: 0,
                speed_window_start: now_instant,
            };

            self.jobs.insert(transfer_id.clone(), job);
            Self::emit_initial(&self.jobs, &transfer_id, &self.app_handle);
            self.queue_tx
                .send(transfer_id.clone())
                .map_err(|e| SftpError::ChannelError(e.to_string()))?;

            ids.push(transfer_id);
        }

        Ok(ids)
    }

    // ─── Download ────────────────────────────────────────────────────────────

    /// Enqueue one or more remote paths for download.
    #[instrument(skip(self), fields(sftp_session_id = %sftp_session_id))]
    pub async fn enqueue_download(
        &self,
        sftp_session_id: String,
        remote_paths: Vec<String>,
        local_dir: PathBuf,
    ) -> Result<Vec<String>, SftpError> {
        self.ensure_worker_spawned();
        let sftp_arc = {
            let session_ref = self.sftp_manager.get_session(&sftp_session_id)?;
            session_ref.sftp.clone()
        };

        let mut ids = Vec::with_capacity(remote_paths.len());

        for remote_path in remote_paths {
            let name = std::path::Path::new(&remote_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let transfer_id = uuid::Uuid::new_v4().to_string();
            let now = Self::unix_now_millis();
            let now_instant = Instant::now();

            let attrs = {
                let sftp = sftp_arc.lock().await;
                sftp.metadata(&remote_path)
                    .await
                    .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
            };

            let is_dir = attrs.file_type() == russh_sftp::protocol::FileType::Dir;
            let (kind, total_bytes, files_total) = if is_dir {
                let local_dest = local_dir.join(&name);
                // Total are unknown until the background stat walk
                // start at 0 so the job appears in the UI immediately
                (
                    TransferJobKind::DownloadDir {
                        remote_path: remote_path.clone(),
                        local_dir: local_dest,
                    },
                    0u64,
                    0u32,
                )
            } else {
                let local_dest = local_dir.join(&name);
                let size = attrs.size.unwrap_or(0);
                (
                    TransferJobKind::DownloadFile {
                        remote_path: remote_path.clone(),
                        local_path: local_dest,
                    },
                    size,
                    1u32,
                )
            };

            let job = TransferJobState {
                transfer_id: transfer_id.clone(),
                sftp_session_id: sftp_session_id.clone(),
                name: name.clone(),
                direction: TransferDirection::Download,
                kind,
                status: TransferStatus::Queued,
                bytes_transferred: 0,
                total_bytes,
                files_done: 0,
                files_total,
                speed_bps: 0,
                cancel_token: CancellationToken::new(),
                error: None,
                created_at: now,
                last_emit: now_instant,
                speed_window_bytes: 0,
                speed_window_start: now_instant,
            };

            self.jobs.insert(transfer_id.clone(), job);
            Self::emit_initial(&self.jobs, &transfer_id, &self.app_handle);
            self.queue_tx
                .send(transfer_id.clone())
                .map_err(|e| SftpError::ChannelError(e.to_string()))?;

            if is_dir {
                let jobs = self.jobs.clone();
                let app_handle = self.app_handle.clone();
                let sftp_arc = sftp_arc.clone();
                let stat_remote_path = remote_path.clone();
                let stat_transfer_id = transfer_id.clone();
                tokio::spawn(async move {
                    let (byte, count) = walk_remote_dir_stats(&sftp_arc, &stat_remote_path).await;
                    if let Some(mut job) = jobs.get_mut(&stat_transfer_id) {
                        // never report a total below what's already transferred
                        job.total_bytes = byte.max(job.bytes_transferred);
                        job.files_total = count.max(job.files_done);
                        let event = job.to_event();
                        drop(job);
                        let _ = app_handle.emit("sftp:transfer", event);
                    }
                });
            }

            ids.push(transfer_id);
        }

        Ok(ids)
    }

    // ─── Control ─────────────────────────────────────────────────────────────

    /// Cancel a queued or in-progress transfer.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn cancel(&self, transfer_id: &str) -> Result<(), SftpError> {
        let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
            SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
        })?;

        job.cancel_token.cancel();

        // If still queued, mark cancelled immediately (the worker will no-op).
        if job.status == TransferStatus::Queued {
            job.status = TransferStatus::Cancelled;
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("sftp:transfer", event);
            record_finished(&self.jobs, &self.finished_order, transfer_id);
        }

        Ok(())
    }

    /// Retry a failed transfer by resetting its state and re-queuing it.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn retry(&self, transfer_id: &str) -> Result<(), SftpError> {
        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?;

            match &job.status {
                TransferStatus::Failed(_) | TransferStatus::Cancelled => {}
                _ => {
                    return Err(SftpError::ProtocolError(format!(
                        "transfer {transfer_id} is not in a failed/cancelled state"
                    )));
                }
            }

            job.status = TransferStatus::Queued;
            job.bytes_transferred = 0;
            job.files_done = 0;
            job.speed_bps = 0;
            job.error = None;
            job.cancel_token = CancellationToken::new();
            job.last_emit = Instant::now();
            job.speed_window_bytes = 0;
            job.speed_window_start = Instant::now();

            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("sftp:transfer", event);
        }

        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;

        Ok(())
    }

    /// Snapshot of every known transfer job.
    pub fn list_all(&self) -> Vec<TransferInfo> {
        self.jobs.iter().map(|r| r.value().to_info()).collect()
    }

    /// Remove completed, failed, and cancelled jobs from the registry.
    pub fn clear_finished(&self) {
        self.jobs.retain(|_, job| {
            !matches!(
                &job.status,
                TransferStatus::Completed | TransferStatus::Failed(_) | TransferStatus::Cancelled
            )
        });
    }

    /// Adjust the maximum number of concurrent transfers.
    /// Increasing the limit adds semaphore permits; decreasing reconfigures
    /// the counter so future acquisitions are limited (in-flight work is not
    /// interrupted).
    pub fn set_max_concurrent(&self, n: u32) {
        apply_concurrency(&self.semaphore, &self.max_concurrent, n);
    }
}

// ─── Remote directory statistics ─────────────────────────────────────────────

/// Recursively walk a remote directory and return (total_bytes, file_count).
/// Tracks visited paths to prevent infinite loops from symlink cycles.
async fn walk_remote_dir_stats(
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    path: &str,
) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_remote_dir_inner(sftp_arc, path, &mut visited)).await
}

async fn walk_remote_dir_inner(
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    path: &str,
    visited: &mut HashSet<String>,
) -> (u64, u32) {
    if !visited.insert(path.to_string()) {
        return (0, 0); // cycle detected
    }

    let entries = {
        let sftp = sftp_arc.lock().await;
        match sftp.read_dir(path).await {
            Ok(e) => e,
            Err(e) => {
                // Treated as empty so the walk can proceed (don't stay silent)
                tracing::warn!(path, error = %e, "read_dir failed during stat walk; subtree size will be undercounted");
                return (0, 0);
            }
        }
    };

    let mut total_bytes: u64 = 0;
    let mut file_count: u32 = 0;

    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if path == "/" {
            format!("/{name}")
        } else {
            format!("{path}/{name}")
        };

        let attrs = entry.metadata();
        if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
            let (b, c) = Box::pin(walk_remote_dir_inner(sftp_arc, &full_path, visited)).await;
            total_bytes += b;
            file_count += c;
        } else {
            total_bytes += attrs.size.unwrap_or(0);
            file_count += 1;
        }
    }

    (total_bytes, file_count)
}

// ─── Local directory statistics ──────────────────────────────────────────────

/// Recursively walk a local directory and return (total_bytes, file_count).
/// Uses canonical paths to detect and skip symlink cycles.
async fn walk_local_dir_stats(path: &PathBuf) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_local_dir_inner(path, &mut visited)).await
}

async fn walk_local_dir_inner(path: &PathBuf, visited: &mut HashSet<PathBuf>) -> (u64, u32) {
    // Canonicalize to resolve symlinks and detect cycles
    let canonical = match tokio::fs::canonicalize(path).await {
        Ok(p) => p,
        Err(_) => return (0, 0),
    };
    if !visited.insert(canonical) {
        return (0, 0); // cycle detected
    }

    let mut total_bytes: u64 = 0;
    let mut file_count: u32 = 0;

    let mut read_dir = match tokio::fs::read_dir(path).await {
        Ok(rd) => rd,
        Err(_) => return (0, 0),
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.is_dir() {
            let child_path = entry.path();
            let (b, c) = Box::pin(walk_local_dir_inner(&child_path, visited)).await;
            total_bytes += b;
            file_count += c;
        } else {
            total_bytes += meta.len();
            file_count += 1;
        }
    }

    (total_bytes, file_count)
}

// ─── Execute transfer ─────────────────────────────────────────────────────────

/// Top-level dispatcher. Runs inside the worker task.
async fn execute_transfer(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    finished_order: &Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    job_id: &str,
    sftp_manager: &Arc<SftpManager>,
    app_handle: &AppHandle,
) {
    // Check if it was cancelled before we even got the semaphore permit.
    {
        if let Some(job) = jobs.get(job_id) {
            if job.cancel_token.is_cancelled() {
                drop(job);
                set_job_status(
                    jobs,
                    finished_order,
                    job_id,
                    TransferStatus::Cancelled,
                    None,
                    app_handle,
                );
                return;
            }
        } else {
            return; // job was removed externally
        }
    }

    // Mark InProgress.
    set_job_status(
        jobs,
        finished_order,
        job_id,
        TransferStatus::InProgress,
        None,
        app_handle,
    );

    // Retrieve the SFTP session arc — bail with an error if the session is gone.
    let sftp_arc = {
        let sftp_session_id = {
            let job = match jobs.get(job_id) {
                Some(j) => j,
                None => return,
            };
            job.sftp_session_id.clone()
        };

        match sftp_manager.get_session(&sftp_session_id) {
            Ok(session_ref) => session_ref.sftp.clone(),
            Err(e) => {
                set_job_status(
                    jobs,
                    finished_order,
                    job_id,
                    TransferStatus::Failed(e.to_string()),
                    Some(e.to_string()),
                    app_handle,
                );
                return;
            }
        }
    };

    // We need to move the job *kind* out to avoid holding the DashMap lock
    // across await points. We reconstruct a temporary descriptor.
    let (kind_desc, cancel_token) = {
        let job = match jobs.get(job_id) {
            Some(j) => j,
            None => return,
        };
        // We can't move out of the DashMap ref, so we clone what we need.
        let cancel_token = job.cancel_token.clone();
        let desc = match &job.kind {
            TransferJobKind::UploadFile {
                local_path,
                remote_path,
            } => KindDesc::UploadFile {
                local_path: local_path.clone(),
                remote_path: remote_path.clone(),
            },
            TransferJobKind::UploadDir {
                local_path,
                remote_dir,
            } => KindDesc::UploadDir {
                local_path: local_path.clone(),
                remote_dir: remote_dir.clone(),
            },
            TransferJobKind::DownloadFile {
                remote_path,
                local_path,
                ..
            } => KindDesc::DownloadFile {
                remote_path: remote_path.clone(),
                local_path: local_path.clone(),
            },
            TransferJobKind::DownloadDir {
                remote_path,
                local_dir,
            } => KindDesc::DownloadDir {
                remote_path: remote_path.clone(),
                local_dir: local_dir.clone(),
            },
        };
        (desc, cancel_token)
    };

    let result = match kind_desc {
        KindDesc::UploadFile {
            local_path,
            remote_path,
        } => {
            run_upload_file(
                jobs,
                job_id,
                &sftp_arc,
                &local_path,
                &remote_path,
                &cancel_token,
                app_handle,
            )
            .await
        }
        KindDesc::UploadDir {
            local_path,
            remote_dir,
        } => {
            run_upload_dir(
                jobs,
                job_id,
                &sftp_arc,
                &local_path,
                &remote_dir,
                &cancel_token,
                app_handle,
            )
            .await
        }
        KindDesc::DownloadFile {
            remote_path,
            local_path,
        } => {
            run_download_file(
                jobs,
                job_id,
                &sftp_arc,
                &remote_path,
                &local_path,
                &cancel_token,
                app_handle,
            )
            .await
        }
        KindDesc::DownloadDir {
            remote_path,
            local_dir,
        } => {
            run_download_dir(
                jobs,
                job_id,
                &sftp_arc,
                &remote_path,
                &local_dir,
                &cancel_token,
                app_handle,
            )
            .await
        }
    };

    // Snapshot job metrics before setting terminal status.
    let (job_direction, job_total_bytes, job_files_total, job_bytes_transferred) = {
        if let Some(job) = jobs.get(job_id) {
            (
                job.direction.clone(),
                job.total_bytes,
                job.files_total,
                job.bytes_transferred,
            )
        } else {
            (TransferDirection::Upload, 0, 0, 0)
        }
    };

    match result {
        Ok(()) => {
            if let Some(mut job) = jobs.get_mut(job_id) {
                job.bytes_transferred = job.total_bytes;
            }
            crate::telemetry::capture(
                "transfer_completed",
                serde_json::json!({
                    "protocol": "sftp",
                    "direction": if job_direction == TransferDirection::Upload { "upload" } else { "download" },
                    "total_bytes": job_total_bytes,
                    "files_total": job_files_total,
                }),
            );
            set_job_status(
                jobs,
                finished_order,
                job_id,
                TransferStatus::Completed,
                None,
                app_handle,
            );
        }
        Err(SftpError::TransferCancelled) => set_job_status(
            jobs,
            finished_order,
            job_id,
            TransferStatus::Cancelled,
            None,
            app_handle,
        ),
        Err(e) => {
            crate::telemetry::capture(
                "transfer_failed",
                serde_json::json!({
                    "protocol": "sftp",
                    "direction": if job_direction == TransferDirection::Upload { "upload" } else { "download" },
                    "bytes_transferred": job_bytes_transferred,
                    "total_bytes": job_total_bytes,
                }),
            );
            set_job_status(
                jobs,
                finished_order,
                job_id,
                TransferStatus::Failed(e.to_string()),
                Some(e.to_string()),
                app_handle,
            );
        }
    }
}

// An owned copy of the discriminant so we can release the DashMap reference.
enum KindDesc {
    UploadFile {
        local_path: PathBuf,
        remote_path: String,
    },
    UploadDir {
        local_path: PathBuf,
        remote_dir: String,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
    },
    DownloadDir {
        remote_path: String,
        local_dir: PathBuf,
    },
}

// ─── Status helpers ───────────────────────────────────────────────────────────

fn set_job_status(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    finished_order: &Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    job_id: &str,
    status: TransferStatus,
    error: Option<String>,
    app_handle: &AppHandle,
) {
    let Some(mut job) = jobs.get_mut(job_id) else {
        return;
    };
    let is_terminal = matches!(
        status,
        TransferStatus::Completed | TransferStatus::Failed(_) | TransferStatus::Cancelled
    );
    job.status = status;
    job.error = error;
    let event = job.to_event();
    drop(job);
    let _ = app_handle.emit("sftp:transfer", event);

    if is_terminal {
        record_finished(jobs, finished_order, job_id);
    }
}

/// Track a newly-finished job and evict the oldest once history exceeds
fn record_finished(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    finished_order: &Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    job_id: &str,
) {
    let mut order = finished_order
        .lock()
        .expect("finished_order mutex poisoned");
    order.push_back(job_id.to_string());

    while order.len() > MAX_FINISHED_HISTORY {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        let still_terminal = jobs.get(&oldest).is_some_and(|job| {
            matches!(
                job.status,
                TransferStatus::Completed | TransferStatus::Failed(_) | TransferStatus::Cancelled
            )
        });
        if still_terminal {
            jobs.remove(&oldest);
        }
    }
}

/// Update bytes/speed/ETA and emit a throttled progress event.
/// Returns `Err(TransferCancelled)` if the token is cancelled.
fn update_progress(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    new_bytes: u64,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    if cancel_token.is_cancelled() {
        return Err(SftpError::TransferCancelled);
    }

    if let Some(mut job) = jobs.get_mut(job_id) {
        let should_emit = record_progress(&mut *job, new_bytes, EMIT_THROTTLE, SPEED_WINDOW);
        if should_emit {
            job.last_emit = Instant::now();
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit("sftp:transfer", event);
        }
    }

    Ok(())
}

// ─── Upload: single file ──────────────────────────────────────────────────────

/// Maximum number of concurrent region writers per file. Each writer keeps one
/// SFTP write request in flight, so this bounds the pipeline depth over the
/// session.
const PIPELINE_DEPTH: u64 = 4;

/// Split a file of `file_size` bytes into up to [`PIPELINE_DEPTH`] contiguous
/// `[start, end)` regions. Files smaller than two chunks aren't worth the
/// extra open/close round-trips and get a single region; an empty file gets
/// none.
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

/// A failed region upload, tagged with whether every byte of the region had
/// already been written and acked when the failure happened. Distinguishes a
/// partial remote file (must be removed) from a complete one whose handle
/// merely failed to close (must NOT be removed — that would be data loss).
struct RegionError {
    err: SftpError,
    write_complete: bool,
}

/// State shared by the concurrent region writers of one file upload.
struct UploadFileCtx {
    sftp_arc: Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: PathBuf,
    remote_path: String,
    /// WRITE-only when the file was pre-created empty; CREATE|TRUNCATE|WRITE
    /// when a single region owns the file end-to-end.
    open_flags: OpenFlags,
    cancel_token: CancellationToken,
    progress_tx: mpsc::UnboundedSender<u64>,
}

fn mark_file_done(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    app_handle: &AppHandle,
) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
        let event = job.to_event();
        drop(job);
        let _ = app_handle.emit("sftp:transfer", event);
    }
}

/// Fold per-region outcomes into the first error to surface and whether the
/// remote file must be removed. Removal happens only when bytes are actually
/// missing: if every region wrote fully and only a close failed, the file is
/// complete and deleting it would be data loss.
fn fold_region_results(results: Vec<Result<(), RegionError>>) -> (Option<SftpError>, bool) {
    let mut first_err = None;
    let mut remove_partial = false;
    for r in results {
        if let Err(RegionError {
            err,
            write_complete,
        }) = r
        {
            remove_partial |= !write_complete;
            first_err.get_or_insert(err);
        }
    }
    (first_err, remove_partial)
}

async fn run_upload_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &Path,
    remote_path: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let file_size = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(format!("Cannot read {}: {e}", local_path.display())))?
        .len();

    let regions = plan_upload_regions(file_size);

    // With multiple concurrent writers the truncation must happen exactly once
    // before any of them opens the file (a TRUNCATE racing other regions'
    // writes would clobber their data), so the file is pre-created empty and
    // regions open it WRITE-only. A single writer truncates via its own handle
    // and skips the extra round-trip; an empty file has no writer at all and
    // relies on the pre-create alone.
    let open_flags = if regions.len() == 1 {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        let sftp = sftp_arc.lock().await;
        let mut f = sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| SftpError::RemoteIoError(format!("Cannot write to {remote_path}: {e}")))?;
        f.shutdown()
            .await
            .map_err(|e| SftpError::RemoteIoError(format!("Cannot write to {remote_path}: {e}")))?;
        OpenFlags::WRITE
    };

    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<u64>();
    let aggregator = tokio::spawn({
        let jobs = jobs.clone();
        let job_id = job_id.to_string();
        let cancel_token = cancel_token.clone();
        let app_handle = app_handle.clone();
        async move {
            while let Some(n) = progress_rx.recv().await {
                let _ = update_progress(&jobs, &job_id, n, &cancel_token, &app_handle);
            }
        }
    });

    let ctx = Arc::new(UploadFileCtx {
        sftp_arc: sftp_arc.clone(),
        local_path: local_path.to_path_buf(),
        remote_path: remote_path.to_string(),
        open_flags,
        cancel_token: cancel_token.clone(),
        progress_tx,
    });

    let tasks: Vec<_> = regions
        .into_iter()
        .map(|(start, end)| tokio::spawn(upload_region(ctx.clone(), start, end)))
        .collect();

    let mut results = Vec::with_capacity(tasks.len());
    for t in tasks {
        let r = match t.await {
            Ok(r) => r,
            // Task panicked/aborted mid-write — assume the file is partial.
            Err(join_err) => Err(RegionError {
                err: SftpError::RemoteIoError(join_err.to_string()),
                write_complete: false,
            }),
        };
        // Abort the remaining regions as soon as bytes are known to be
        // missing. A close-only failure lets them finish: the file may still
        // come out complete, and it must then be kept.
        if matches!(&r, Err(re) if !re.write_complete) {
            cancel_token.cancel();
        }
        results.push(r);
    }

    drop(ctx);
    let _ = aggregator.await;

    let (first_err, remove_partial) = fold_region_results(results);
    if let Some(e) = first_err {
        // Best-effort cleanup of the partial remote file; on a dropped
        // connection the remove itself fails, which is fine. When overwriting
        // an existing file the original was already truncated at open, so
        // removing the partial is the better of two lossy outcomes.
        if remove_partial {
            let sftp = sftp_arc.lock().await;
            let _ = sftp.remove_file(remote_path).await;
        }
        return Err(e);
    }

    mark_file_done(jobs, job_id, app_handle);
    Ok(())
}

/// Upload bytes `[start, end)` of the local file through its own remote
/// handle. On failure, reports whether the region's writes had all completed
/// (see [`RegionError`]).
async fn upload_region(ctx: Arc<UploadFileCtx>, start: u64, end: u64) -> Result<(), RegionError> {
    use tokio::io::AsyncSeekExt;

    let incomplete = |err: SftpError| RegionError {
        err,
        write_complete: false,
    };
    let local_ctx = |e: &dyn std::fmt::Display| {
        SftpError::LocalIoError(format!("Cannot read {}: {e}", ctx.local_path.display()))
    };
    let remote_ctx = |e: &dyn std::fmt::Display| {
        SftpError::RemoteIoError(format!("Cannot write to {}: {e}", ctx.remote_path))
    };

    let mut local_file = tokio::fs::File::open(&ctx.local_path)
        .await
        .map_err(|e| incomplete(local_ctx(&e)))?;
    local_file
        .seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| incomplete(local_ctx(&e)))?;

    let mut remote_file = {
        let sftp = ctx.sftp_arc.lock().await;
        sftp.open_with_flags(&ctx.remote_path, ctx.open_flags)
            .await
            .map_err(|e| incomplete(remote_ctx(&e)))?
    };
    remote_file
        .seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| incomplete(remote_ctx(&e)))?;

    copy_region(
        &mut local_file,
        &mut remote_file,
        end - start,
        &ctx.cancel_token,
        |n| {
            let _ = ctx.progress_tx.send(n);
            Ok(())
        },
    )
    .await
    .map_err(|err| {
        incomplete(match err {
            SftpError::LocalIoError(msg) => local_ctx(&msg),
            SftpError::RemoteIoError(msg) => remote_ctx(&msg),
            other => other,
        })
    })?;

    // Every byte is written and acked past this point: a close failure is
    // surfaced but must not count as a partial upload.
    remote_file.shutdown().await.map_err(|e| RegionError {
        err: remote_ctx(&e),
        write_complete: true,
    })
}

/// Pump `len` bytes from `local` into `remote` in `CHUNK_SIZE` chunks,
/// reporting progress after every chunk. Generic over the endpoints so the
/// copy loop is unit-testable without an SFTP session.
///
/// A source that runs dry before `len` bytes is an error, not EOF: regions
/// are planned from the file size up front, and a silently short region would
/// leave a hole of stale or zero bytes in the assembled remote file.
async fn copy_region<R, W, F>(
    local: &mut R,
    remote: &mut W,
    len: u64,
    cancel_token: &CancellationToken,
    mut on_progress: F,
) -> Result<(), SftpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64) -> Result<(), SftpError>,
{
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut remaining = len;
    while remaining > 0 {
        if cancel_token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        let want = buf.len().min(remaining as usize);
        let n = local
            .read(&mut buf[..want])
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        if n == 0 {
            return Err(SftpError::LocalIoError(format!(
                "file shrank during upload ({remaining} bytes missing)"
            )));
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        remaining -= n as u64;
        on_progress(n as u64)?;
    }
    Ok(())
}

// ─── Upload: directory ────────────────────────────────────────────────────────

async fn run_upload_dir(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &PathBuf,
    remote_dir: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    // Create the top-level remote directory.
    {
        let sftp = sftp_arc.lock().await;
        remote_mkdir_p(&sftp, remote_dir).await?;
    }

    Box::pin(upload_dir_recursive(
        jobs,
        job_id,
        sftp_arc,
        local_path,
        remote_dir,
        cancel_token,
        app_handle,
    ))
    .await
}

async fn upload_dir_recursive(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_dir: &PathBuf,
    remote_dir: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let mut read_dir = tokio::fs::read_dir(local_dir)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?
    {
        if cancel_token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }

        let meta = entry
            .metadata()
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        let child_name = entry.file_name().to_string_lossy().to_string();
        let remote_child = format!("{remote_dir}/{child_name}");

        if meta.is_dir() {
            {
                let sftp = sftp_arc.lock().await;
                remote_mkdir_p(&sftp, &remote_child).await?;
            }
            Box::pin(upload_dir_recursive(
                jobs,
                job_id,
                sftp_arc,
                &entry.path(),
                &remote_child,
                cancel_token,
                app_handle,
            ))
            .await?;
        } else {
            run_upload_file(
                jobs,
                job_id,
                sftp_arc,
                &entry.path(),
                &remote_child,
                cancel_token,
                app_handle,
            )
            .await?;
        }
    }

    Ok(())
}

// ─── Download: single file ────────────────────────────────────────────────────

async fn run_download_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_path: &PathBuf,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let mut remote_file = {
        let sftp = sftp_arc.lock().await;
        sftp.open(remote_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };

    // Ensure local parent directory exists.
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
    }

    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        if cancel_token.is_cancelled() {
            let _ = tokio::fs::remove_file(local_path).await;
            return Err(SftpError::TransferCancelled);
        }

        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        if n == 0 {
            break;
        }

        local_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

        update_progress(jobs, job_id, n as u64, cancel_token, app_handle)?;
    }

    local_file
        .flush()
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    remote_file
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    // Mark this file done.
    mark_file_done(jobs, job_id, app_handle);

    Ok(())
}

// ─── Download: directory ──────────────────────────────────────────────────────

async fn run_download_dir(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_path: &str,
    local_dir: &PathBuf,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    tokio::fs::create_dir_all(local_dir)
        .await
        .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

    Box::pin(download_dir_recursive(
        jobs,
        job_id,
        sftp_arc,
        remote_path,
        local_dir,
        cancel_token,
        app_handle,
    ))
    .await
}

async fn download_dir_recursive(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    remote_dir: &str,
    local_dir: &Path,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let entries = {
        let sftp = sftp_arc.lock().await;
        sftp.read_dir(remote_dir)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };

    for entry in entries {
        let name = entry.file_name();
        // Skip "."/".." and reject any unsafe server-supplied name (separators,
        // traversal, absolute) before joining it onto a local path — a hostile
        // server must not be able to escape `local_dir`.
        let name = match validate_remote_name(&name) {
            Ok(n) => n.to_string(),
            Err(_) => continue,
        };

        if cancel_token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }

        let remote_child = if remote_dir == "/" {
            format!("/{name}")
        } else {
            format!("{remote_dir}/{name}")
        };
        let local_child = local_dir.join(&name);

        let attrs = entry.metadata();
        if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
            tokio::fs::create_dir_all(&local_child)
                .await
                .map_err(|e| SftpError::LocalIoError(e.to_string()))?;

            Box::pin(download_dir_recursive(
                jobs,
                job_id,
                sftp_arc,
                &remote_child,
                &local_child,
                cancel_token,
                app_handle,
            ))
            .await?;
        } else {
            run_download_file(
                jobs,
                job_id,
                sftp_arc,
                &remote_child,
                &local_child,
                cancel_token,
                app_handle,
            )
            .await?;
        }
    }

    Ok(())
}

// ─── Remote mkdir -p ──────────────────────────────────────────────────────────

async fn remote_mkdir_p(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), SftpError> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut current = String::new();

    for seg in segments {
        current = format!("{current}/{seg}");
        match sftp.create_dir(&current).await {
            Ok(()) => {}
            Err(_) => match sftp.metadata(&current).await {
                Ok(attrs) if attrs.file_type() == russh_sftp::protocol::FileType::Dir => {}
                _ => {
                    return Err(SftpError::RemoteIoError(format!(
                        "failed to create remote directory: {current}"
                    )));
                }
            },
        }
    }

    Ok(())
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_job_state_to_info_computes_eta() {
        let now = Instant::now();
        let job = TransferJobState {
            transfer_id: "t1".to_string(),
            sftp_session_id: "s1".to_string(),
            name: "file.txt".to_string(),
            direction: TransferDirection::Upload,
            kind: TransferJobKind::UploadFile {
                local_path: PathBuf::from("/tmp/file.txt"),
                remote_path: "/remote/file.txt".to_string(),
            },
            status: TransferStatus::InProgress,
            bytes_transferred: 500,
            total_bytes: 1000,
            files_done: 0,
            files_total: 1,
            speed_bps: 100,
            cancel_token: CancellationToken::new(),
            error: None,
            created_at: 0,
            last_emit: now,
            speed_window_bytes: 0,
            speed_window_start: now,
        };

        let info = job.to_info();
        // remaining = 500 bytes, speed = 100 bps => ETA = 5 seconds
        assert_eq!(info.eta_secs, Some(5));
        assert_eq!(info.bytes_transferred, 500);
        assert_eq!(info.total_bytes, 1000);
    }

    #[test]
    fn transfer_job_state_no_eta_when_complete() {
        let now = Instant::now();
        let job = TransferJobState {
            transfer_id: "t2".to_string(),
            sftp_session_id: "s1".to_string(),
            name: "file.txt".to_string(),
            direction: TransferDirection::Download,
            kind: TransferJobKind::DownloadFile {
                remote_path: "/remote/file.txt".to_string(),
                local_path: PathBuf::from("/tmp/file.txt"),
            },
            status: TransferStatus::Completed,
            bytes_transferred: 1000,
            total_bytes: 1000,
            files_done: 1,
            files_total: 1,
            speed_bps: 100,
            cancel_token: CancellationToken::new(),
            error: None,
            created_at: 0,
            last_emit: now,
            speed_window_bytes: 0,
            speed_window_start: now,
        };

        let info = job.to_info();
        // No remaining bytes => no ETA
        assert_eq!(info.eta_secs, None);
    }

    #[test]
    fn transfer_job_state_no_eta_when_speed_zero() {
        let now = Instant::now();
        let job = TransferJobState {
            transfer_id: "t3".to_string(),
            sftp_session_id: "s1".to_string(),
            name: "dir".to_string(),
            direction: TransferDirection::Upload,
            kind: TransferJobKind::UploadDir {
                local_path: PathBuf::from("/tmp/dir"),
                remote_dir: "/remote/dir".to_string(),
            },
            status: TransferStatus::InProgress,
            bytes_transferred: 0,
            total_bytes: 1000,
            files_done: 0,
            files_total: 5,
            speed_bps: 0,
            cancel_token: CancellationToken::new(),
            error: None,
            created_at: 0,
            last_emit: now,
            speed_window_bytes: 0,
            speed_window_start: now,
        };

        let info = job.to_info();
        // Speed is 0 => cannot compute ETA
        assert_eq!(info.eta_secs, None);
    }

    // ─── plan_upload_regions ──────────────────────────────────────────────

    const C: u64 = CHUNK_SIZE as u64;

    #[test]
    fn plan_regions_empty_file_has_no_regions() {
        assert!(plan_upload_regions(0).is_empty());
    }

    #[test]
    fn plan_regions_small_files_get_a_single_region() {
        for size in [1, C - 1, C, 2 * C - 1] {
            assert_eq!(plan_upload_regions(size), vec![(0, size)], "size {size}");
        }
    }

    #[test]
    fn plan_regions_depth_scales_with_size_up_to_pipeline_depth() {
        // 2 chunks => 2C/C + 1 = 3 regions; large files cap at PIPELINE_DEPTH.
        assert_eq!(plan_upload_regions(2 * C).len(), 3);
        assert_eq!(plan_upload_regions(100 * C).len(), PIPELINE_DEPTH as usize);
    }

    #[test]
    fn plan_regions_cover_the_file_exactly_without_overlap() {
        let sizes = [
            1,
            2,
            C - 1,
            C,
            C + 1,
            2 * C,
            2 * C + 1,
            3 * C,
            4 * C,
            10 * C + 7,
            1_000_000_007,
        ];
        for size in sizes {
            let regions = plan_upload_regions(size);
            assert!(!regions.is_empty(), "size {size}");
            assert!(regions.len() <= PIPELINE_DEPTH as usize, "size {size}");
            assert_eq!(regions.first().unwrap().0, 0, "size {size}");
            assert_eq!(regions.last().unwrap().1, size, "size {size}");
            for (start, end) in &regions {
                assert!(start < end, "empty region at size {size}");
            }
            for pair in regions.windows(2) {
                assert_eq!(pair[0].1, pair[1].0, "gap/overlap at size {size}");
            }
        }
    }

    // ─── copy_region ──────────────────────────────────────────────────────

    use std::io::Cursor;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// Deterministic non-repeating-ish payload so region mixups show up as
    /// content mismatches, not just length mismatches.
    fn test_data(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// Reader that serves at most `max` bytes per read call, to exercise the
    /// short-read accounting of the copy loop.
    struct TrickleReader {
        inner: Cursor<Vec<u8>>,
        max: usize,
    }

    impl AsyncRead for TrickleReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let cap = self.max.min(buf.remaining());
            let mut tmp = vec![0u8; cap];
            let n = std::io::Read::read(&mut self.inner, &mut tmp).unwrap();
            buf.put_slice(&tmp[..n]);
            Poll::Ready(Ok(()))
        }
    }

    /// Writer that accepts `accept` bytes and then fails, to simulate a
    /// connection dropped mid-region.
    struct FailingWriter {
        written: usize,
        accept: usize,
    }

    impl AsyncWrite for FailingWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.written + buf.len() > self.accept {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "connection lost",
                )));
            }
            self.written += buf.len();
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn copy_region_copies_exact_bytes_and_reports_progress() {
        let data = test_data(3 * CHUNK_SIZE + 17);
        let mut src = Cursor::new(data.clone());
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();
        let mut progressed = 0u64;

        copy_region(&mut src, &mut dst, data.len() as u64, &token, |n| {
            progressed += n;
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(dst.into_inner(), data);
        assert_eq!(progressed, data.len() as u64);
    }

    #[tokio::test]
    async fn copy_region_handles_short_reads() {
        // 10_000 bytes served 337 bytes at a time: the loop must keep reading
        // until the region is complete, not treat a short read as EOF.
        let data = test_data(10_000);
        let mut src = TrickleReader {
            inner: Cursor::new(data.clone()),
            max: 337,
        };
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();

        copy_region(&mut src, &mut dst, data.len() as u64, &token, |_| Ok(()))
            .await
            .unwrap();

        assert_eq!(dst.into_inner(), data);
    }

    #[tokio::test]
    async fn copy_region_errors_when_source_runs_dry() {
        // Region planned for 1000 bytes but the file only has 400 left — a
        // silent break would leave a hole in the assembled remote file.
        let mut src = Cursor::new(test_data(400));
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();

        let err = copy_region(&mut src, &mut dst, 1000, &token, |_| Ok(()))
            .await
            .unwrap_err();

        match err {
            SftpError::LocalIoError(msg) => assert!(msg.contains("shrank"), "got: {msg}"),
            other => panic!("expected LocalIoError, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn copy_region_stops_immediately_when_already_cancelled() {
        let mut src = Cursor::new(test_data(1000));
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();
        token.cancel();

        let err = copy_region(&mut src, &mut dst, 1000, &token, |_| Ok(()))
            .await
            .unwrap_err();

        assert!(matches!(err, SftpError::TransferCancelled));
        assert!(dst.into_inner().is_empty());
    }

    #[tokio::test]
    async fn copy_region_stops_at_next_chunk_after_cancellation() {
        // Trickle 100 bytes per read out of 1000 and cancel from the first
        // progress callback: exactly one chunk may land, never the rest.
        let mut src = TrickleReader {
            inner: Cursor::new(test_data(1000)),
            max: 100,
        };
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();
        let cancel_from_progress = token.clone();

        let err = copy_region(&mut src, &mut dst, 1000, &token, |_| {
            cancel_from_progress.cancel();
            Ok(())
        })
        .await
        .unwrap_err();

        assert!(matches!(err, SftpError::TransferCancelled));
        assert_eq!(dst.into_inner().len(), 100);
    }

    #[tokio::test]
    async fn copy_region_surfaces_write_failures() {
        let data = test_data(2 * CHUNK_SIZE);
        let mut src = Cursor::new(data);
        let mut dst = FailingWriter {
            written: 0,
            accept: CHUNK_SIZE,
        };
        let token = CancellationToken::new();

        let err = copy_region(&mut src, &mut dst, (2 * CHUNK_SIZE) as u64, &token, |_| {
            Ok(())
        })
        .await
        .unwrap_err();

        assert!(matches!(err, SftpError::RemoteIoError(_)));
    }

    #[tokio::test]
    async fn copy_region_propagates_progress_errors() {
        let mut src = Cursor::new(test_data(100));
        let mut dst = Cursor::new(Vec::new());
        let token = CancellationToken::new();

        let err = copy_region(&mut src, &mut dst, 100, &token, |_| {
            Err(SftpError::ChannelError("progress sink gone".into()))
        })
        .await
        .unwrap_err();

        assert!(matches!(err, SftpError::ChannelError(_)));
    }

    #[tokio::test]
    async fn planned_regions_reassemble_into_identical_file() {
        // End-to-end over the pure pieces: plan regions for a multi-region
        // file, copy each independently, reassemble by offset, compare.
        let data = test_data(3 * CHUNK_SIZE + 1234);
        let regions = plan_upload_regions(data.len() as u64);
        assert!(regions.len() > 1);

        let token = CancellationToken::new();
        let mut assembled = vec![0u8; data.len()];
        for &(start, end) in &regions {
            let mut src = Cursor::new(data[start as usize..end as usize].to_vec());
            let mut dst = Cursor::new(Vec::new());
            copy_region(&mut src, &mut dst, end - start, &token, |_| Ok(()))
                .await
                .unwrap();
            assembled[start as usize..end as usize].copy_from_slice(&dst.into_inner());
        }

        assert_eq!(assembled, data);
    }

    // ─── fold_region_results ──────────────────────────────────────────────

    fn region_err(msg: &str, write_complete: bool) -> Result<(), RegionError> {
        Err(RegionError {
            err: SftpError::RemoteIoError(msg.into()),
            write_complete,
        })
    }

    #[test]
    fn fold_all_ok_keeps_file_and_no_error() {
        let (err, remove) = fold_region_results(vec![Ok(()), Ok(()), Ok(())]);
        assert!(err.is_none());
        assert!(!remove);
    }

    #[test]
    fn fold_close_only_failure_surfaces_error_but_keeps_file() {
        // Every byte was written and acked; only a handle close failed. The
        // remote file is complete — deleting it would be data loss.
        let (err, remove) = fold_region_results(vec![Ok(()), region_err("close failed", true)]);
        assert!(err.is_some());
        assert!(!remove);
    }

    #[test]
    fn fold_write_failure_removes_partial_file() {
        let (err, remove) = fold_region_results(vec![Ok(()), region_err("dropped", false)]);
        assert!(err.is_some());
        assert!(remove);
    }

    #[test]
    fn fold_mixed_failures_remove_file_and_report_first_error() {
        let (err, remove) = fold_region_results(vec![
            region_err("close failed", true),
            region_err("dropped", false),
        ]);
        assert!(remove, "any incomplete region must trigger removal");
        match err {
            Some(SftpError::RemoteIoError(msg)) => assert_eq!(msg, "close failed"),
            other => panic!("expected first error, got {other:?}"),
        }
    }
}
