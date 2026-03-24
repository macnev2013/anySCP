use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use russh_sftp::protocol::OpenFlags;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use super::{
    SftpError, SftpManager, TransferDirection, TransferEvent, TransferInfo, TransferStatus,
};

// ─── Constants ───────────────────────────────────────────────────────────────

const CHUNK_SIZE: usize = 32 * 1024; // 32 KB
/// Minimum duration between consecutive progress events per transfer.
const EMIT_THROTTLE: Duration = Duration::from_millis(100);
/// Window over which bytes are accumulated to compute speed.
const SPEED_WINDOW: Duration = Duration::from_secs(2);

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
        /// Cached file size captured at enqueue time; used to populate `total_bytes`.
        #[allow(dead_code)]
        size: u64,
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
        let eta_secs = if self.speed_bps > 0 && self.total_bytes > self.bytes_transferred {
            Some((self.total_bytes - self.bytes_transferred) / self.speed_bps)
        } else {
            None
        };

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
        let eta_secs = if self.speed_bps > 0 && self.total_bytes > self.bytes_transferred {
            Some((self.total_bytes - self.bytes_transferred) / self.speed_bps)
        } else {
            None
        };

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

pub struct TransferManager {
    jobs: Arc<DashMap<String, TransferJobState>>,
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
        let semaphore = Arc::new(Semaphore::new(3));
        let max_concurrent = Arc::new(AtomicU32::new(3));

        // Store the receiver — the worker loop is spawned lazily on first enqueue
        // because `new()` runs inside Tauri's `.setup()` where no tokio runtime is active yet.
        let worker_rx = Arc::new(std::sync::Mutex::new(Some(queue_rx)));

        Self {
            jobs,
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
                    let sftp_manager = sftp_manager.clone();
                    let app_handle = app_handle.clone();

                    tokio::spawn(async move {
                        execute_transfer(&jobs, &job_id, &sftp_manager, &app_handle).await;
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

            let (kind, total_bytes, files_total) =
                if attrs.file_type() == russh_sftp::protocol::FileType::Dir {
                    let local_dest = local_dir.join(&name);
                    let (bytes, count) = {
                        let sftp = sftp_arc.lock().await;
                        walk_remote_dir_stats(&sftp, &remote_path).await
                    };
                    (
                        TransferJobKind::DownloadDir {
                            remote_path: remote_path.clone(),
                            local_dir: local_dest,
                        },
                        bytes,
                        count,
                    )
                } else {
                    let local_dest = local_dir.join(&name);
                    let size = attrs.size.unwrap_or(0);
                    (
                        TransferJobKind::DownloadFile {
                            remote_path: remote_path.clone(),
                            local_path: local_dest,
                            size,
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

            ids.push(transfer_id);
        }

        Ok(ids)
    }

    // ─── Control ─────────────────────────────────────────────────────────────

    /// Cancel a queued or in-progress transfer.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn cancel(&self, transfer_id: &str) -> Result<(), SftpError> {
        let mut job = self
            .jobs
            .get_mut(transfer_id)
            .ok_or_else(|| SftpError::SessionNotFound(format!("transfer not found: {transfer_id}")))?;

        job.cancel_token.cancel();

        // If still queued, mark cancelled immediately (the worker will no-op).
        if job.status == TransferStatus::Queued {
            job.status = TransferStatus::Cancelled;
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("sftp:transfer", event);
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
        let old = self.max_concurrent.swap(n, Ordering::SeqCst);
        let current_permits = self.semaphore.available_permits() as u32;

        match n.cmp(&old) {
            std::cmp::Ordering::Greater => {
                self.semaphore.add_permits((n - old) as usize);
            }
            std::cmp::Ordering::Less => {
                // Acquire and permanently forget surplus permits so they are
                // removed from the pool. We only take what is currently idle.
                let to_remove = (old - n).min(current_permits);
                for _ in 0..to_remove {
                    if let Ok(permit) = self.semaphore.try_acquire() {
                        permit.forget();
                    }
                }
            }
            std::cmp::Ordering::Equal => {}
        }
    }
}

// ─── Remote directory statistics ─────────────────────────────────────────────

/// Recursively walk a remote directory and return (total_bytes, file_count).
/// Tracks visited paths to prevent infinite loops from symlink cycles.
async fn walk_remote_dir_stats(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_remote_dir_inner(sftp, path, &mut visited)).await
}

async fn walk_remote_dir_inner(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    visited: &mut HashSet<String>,
) -> (u64, u32) {
    if !visited.insert(path.to_string()) {
        return (0, 0); // cycle detected
    }

    let entries = match sftp.read_dir(path).await {
        Ok(e) => e,
        Err(_) => return (0, 0),
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
            let (b, c) = Box::pin(walk_remote_dir_inner(sftp, &full_path, visited)).await;
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
    job_id: &str,
    sftp_manager: &Arc<SftpManager>,
    app_handle: &AppHandle,
) {
    // Check if it was cancelled before we even got the semaphore permit.
    {
        if let Some(job) = jobs.get(job_id) {
            if job.cancel_token.is_cancelled() {
                drop(job);
                set_job_status(jobs, job_id, TransferStatus::Cancelled, None, app_handle);
                return;
            }
        } else {
            return; // job was removed externally
        }
    }

    // Mark InProgress.
    set_job_status(jobs, job_id, TransferStatus::InProgress, None, app_handle);

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
            TransferJobKind::UploadFile { local_path, remote_path } => {
                KindDesc::UploadFile {
                    local_path: local_path.clone(),
                    remote_path: remote_path.clone(),
                }
            }
            TransferJobKind::UploadDir { local_path, remote_dir } => KindDesc::UploadDir {
                local_path: local_path.clone(),
                remote_dir: remote_dir.clone(),
            },
            TransferJobKind::DownloadFile { remote_path, local_path, .. } => {
                KindDesc::DownloadFile {
                    remote_path: remote_path.clone(),
                    local_path: local_path.clone(),
                }
            }
            TransferJobKind::DownloadDir { remote_path, local_dir } => KindDesc::DownloadDir {
                remote_path: remote_path.clone(),
                local_dir: local_dir.clone(),
            },
        };
        (desc, cancel_token)
    };

    let result = match kind_desc {
        KindDesc::UploadFile { local_path, remote_path } => {
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
        KindDesc::UploadDir { local_path, remote_dir } => {
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
        KindDesc::DownloadFile { remote_path, local_path } => {
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
        KindDesc::DownloadDir { remote_path, local_dir } => {
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
            (job.direction.clone(), job.total_bytes, job.files_total, job.bytes_transferred)
        } else {
            (TransferDirection::Upload, 0, 0, 0)
        }
    };

    match result {
        Ok(()) => {
            crate::telemetry::capture("transfer_completed", serde_json::json!({
                "protocol": "sftp",
                "direction": if job_direction == TransferDirection::Upload { "upload" } else { "download" },
                "total_bytes": job_total_bytes,
                "files_total": job_files_total,
            }));
            set_job_status(jobs, job_id, TransferStatus::Completed, None, app_handle);
        }
        Err(SftpError::TransferCancelled) => {
            set_job_status(jobs, job_id, TransferStatus::Cancelled, None, app_handle)
        }
        Err(e) => {
            crate::telemetry::capture("transfer_failed", serde_json::json!({
                "protocol": "sftp",
                "direction": if job_direction == TransferDirection::Upload { "upload" } else { "download" },
                "bytes_transferred": job_bytes_transferred,
                "total_bytes": job_total_bytes,
            }));
            set_job_status(
                jobs,
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
    UploadFile { local_path: PathBuf, remote_path: String },
    UploadDir { local_path: PathBuf, remote_dir: String },
    DownloadFile { remote_path: String, local_path: PathBuf },
    DownloadDir { remote_path: String, local_dir: PathBuf },
}

// ─── Status helpers ───────────────────────────────────────────────────────────

fn set_job_status(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    status: TransferStatus,
    error: Option<String>,
    app_handle: &AppHandle,
) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.status = status;
        job.error = error;
        let event = job.to_event();
        drop(job);
        let _ = app_handle.emit("sftp:transfer", event);
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
        job.bytes_transferred += new_bytes;
        job.speed_window_bytes += new_bytes;

        // Recompute speed every SPEED_WINDOW. Before the first window completes,
        // estimate speed from the time elapsed so far so the UI doesn't show 0.
        let window_elapsed = job.speed_window_start.elapsed();
        if window_elapsed >= SPEED_WINDOW {
            let secs = window_elapsed.as_secs_f64().max(0.001);
            job.speed_bps = (job.speed_window_bytes as f64 / secs) as u64;
            job.speed_window_bytes = 0;
            job.speed_window_start = Instant::now();
        } else if job.speed_bps == 0 && window_elapsed.as_millis() > 200 {
            // Initial estimate before the first full window
            let secs = window_elapsed.as_secs_f64().max(0.001);
            job.speed_bps = (job.speed_window_bytes as f64 / secs) as u64;
        }

        // Emit only if EMIT_THROTTLE has elapsed.
        if job.last_emit.elapsed() >= EMIT_THROTTLE {
            job.last_emit = Instant::now();
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit("sftp:transfer", event);
        }
    }

    Ok(())
}

// ─── Upload: single file ──────────────────────────────────────────────────────

async fn run_upload_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp_arc: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    local_path: &PathBuf,
    remote_path: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| SftpError::LocalIoError(format!("Cannot read {}: {e}", local_path.display())))?;

    let mut remote_file = {
        let sftp = sftp_arc.lock().await;
        sftp.open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| SftpError::RemoteIoError(format!("Cannot write to {remote_path}: {e}")))?
    };

    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        if cancel_token.is_cancelled() {
            // Attempt cleanup of the partial remote file.
            let sftp = sftp_arc.lock().await;
            let _ = sftp.remove_file(remote_path).await;
            return Err(SftpError::TransferCancelled);
        }

        let n = local_file
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::LocalIoError(e.to_string()))?;
        if n == 0 {
            break;
        }

        remote_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

        update_progress(jobs, job_id, n as u64, cancel_token, app_handle)?;
    }

    remote_file
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    // Mark this file done.
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
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
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
    }

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
    local_dir: &PathBuf,
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
        if name == "." || name == ".." {
            continue;
        }

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
            Err(_) => {
                match sftp.metadata(&current).await {
                    Ok(attrs) if attrs.file_type() == russh_sftp::protocol::FileType::Dir => {}
                    _ => {
                        return Err(SftpError::RemoteIoError(format!(
                            "failed to create remote directory: {current}"
                        )));
                    }
                }
            }
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
                size: 1000,
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
}
