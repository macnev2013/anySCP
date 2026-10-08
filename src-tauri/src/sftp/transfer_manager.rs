use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::transfer_common::{
    apply_concurrency, eta_secs, record_finished, record_progress, FinishedStatus, ProgressFields,
};

use super::file_transfer::{self, DownloadCheckpoint, UploadCheckpoint};
use super::{
    validate_remote_name, SftpError, SftpManager, TransferDirection, TransferEvent, TransferInfo,
    TransferStatus,
};

/// Five reconnect attempts over 83 seconds. The delay is cancellable, so a user
/// pause or cancel never waits for the backoff schedule to finish.
const AUTO_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(60),
];

// ─── Job state ───────────────────────────────────────────────────────────────

pub enum TransferJobKind {
    UploadFile {
        local_path: PathBuf,
        remote_path: String,
        checkpoint: UploadCheckpoint,
    },
    UploadDir {
        local_path: PathBuf,
        remote_dir: String,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
        checkpoint: DownloadCheckpoint,
    },
    DownloadDir {
        remote_path: String,
        local_dir: PathBuf,
    },
}

impl TransferJobKind {
    fn resume_supported(&self) -> bool {
        matches!(self, Self::UploadFile { .. } | Self::DownloadFile { .. })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StopRequest {
    None,
    Pause,
    Cancel,
}

enum PartialArtifact {
    Upload {
        sftp_session_id: String,
        remote_path: String,
        checkpoint: UploadCheckpoint,
    },
    Download {
        local_path: PathBuf,
        checkpoint: DownloadCheckpoint,
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
    stop_request: StopRequest,
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
            resume_supported: self.kind.resume_supported(),
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
            resume_supported: self.kind.resume_supported(),
            created_at: self.created_at,
        }
    }

    fn queue_again(&mut self) {
        let now = Instant::now();
        self.status = TransferStatus::Queued;
        self.speed_bps = 0;
        self.error = None;
        self.cancel_token = CancellationToken::new();
        self.stop_request = StopRequest::None;
        self.last_emit = now;
        self.speed_window_bytes = 0;
        self.speed_window_start = now;
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
    ssh_manager: Arc<SshManager>,
    app_handle: AppHandle,
    max_concurrent: Arc<AtomicU32>,
    /// Holds the queue receiver until the worker loop is spawned (lazy init).
    worker_rx: Arc<std::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl TransferManager {
    pub fn new(
        sftp_manager: Arc<SftpManager>,
        ssh_manager: Arc<SshManager>,
        app_handle: AppHandle,
    ) -> Self {
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
            ssh_manager,
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
            let ssh_manager = self.ssh_manager.clone();
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
                    let ssh_manager = ssh_manager.clone();
                    let app_handle = app_handle.clone();

                    tokio::spawn(async move {
                        execute_transfer(
                            &jobs,
                            &finished_order,
                            &job_id,
                            &sftp_manager,
                            &ssh_manager,
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
                        checkpoint: UploadCheckpoint::new(&meta),
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
                stop_request: StopRequest::None,
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
                        checkpoint: DownloadCheckpoint::new(size, attrs.mtime),
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
                stop_request: StopRequest::None,
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

        if !matches!(
            job.status,
            TransferStatus::Queued | TransferStatus::InProgress
        ) {
            return Err(SftpError::ProtocolError(format!(
                "transfer {transfer_id} cannot be cancelled from its current state"
            )));
        }
        job.stop_request = StopRequest::Cancel;
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

    /// Pause an in-progress resumable transfer after its current chunk.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn pause(&self, transfer_id: &str) -> Result<(), SftpError> {
        let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
            SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
        })?;
        if !job.kind.resume_supported() {
            return Err(SftpError::ProtocolError(
                "only single-file SFTP transfers can be paused".to_string(),
            ));
        }
        if job.status != TransferStatus::InProgress {
            return Err(SftpError::ProtocolError(format!(
                "transfer {transfer_id} is not in progress"
            )));
        }
        job.stop_request = StopRequest::Pause;
        job.cancel_token.cancel();
        Ok(())
    }

    /// Resume a paused or failed single-file transfer from its checkpoint.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn resume(&self, transfer_id: &str) -> Result<(), SftpError> {
        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?;

            if !job.kind.resume_supported() {
                return Err(SftpError::ProtocolError(
                    "only single-file SFTP transfers can be resumed".to_string(),
                ));
            }
            match &job.status {
                TransferStatus::Failed(_) | TransferStatus::Paused => {}
                _ => {
                    return Err(SftpError::ProtocolError(format!(
                        "transfer {transfer_id} is not paused or failed"
                    )));
                }
            }

            job.queue_again();

            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("sftp:transfer", event);
        }

        self.forget_finished(transfer_id);

        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;

        Ok(())
    }

    /// Retry directory transfers from the beginning; single files resume.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn retry(&self, transfer_id: &str) -> Result<(), SftpError> {
        let resumable = self
            .jobs
            .get(transfer_id)
            .ok_or_else(|| {
                SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?
            .kind
            .resume_supported();
        if resumable {
            return self.resume(transfer_id);
        }

        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?;
            if !matches!(
                job.status,
                TransferStatus::Failed(_) | TransferStatus::Cancelled
            ) {
                return Err(SftpError::ProtocolError(format!(
                    "transfer {transfer_id} is not in a failed/cancelled state"
                )));
            }
            job.bytes_transferred = 0;
            job.files_done = 0;
            job.queue_again();
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("sftp:transfer", event);
        }
        self.forget_finished(transfer_id);
        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;
        Ok(())
    }

    /// Snapshot of every known transfer job.
    pub fn list_all(&self) -> Vec<TransferInfo> {
        self.jobs.iter().map(|r| r.value().to_info()).collect()
    }

    /// Remove a settled transfer and its resumable partial artifact.
    pub async fn discard(&self, transfer_id: &str) -> Result<(), SftpError> {
        let artifact = {
            let job = self.jobs.get(transfer_id).ok_or_else(|| {
                SftpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?;
            if !matches!(
                job.status,
                TransferStatus::Paused
                    | TransferStatus::Completed
                    | TransferStatus::Failed(_)
                    | TransferStatus::Cancelled
            ) {
                return Err(SftpError::ProtocolError(format!(
                    "transfer {transfer_id} is still active"
                )));
            }
            if matches!(
                job.status,
                TransferStatus::Paused | TransferStatus::Failed(_) | TransferStatus::Cancelled
            ) {
                partial_artifact(&job)
            } else {
                None
            }
        };

        if let Some(artifact) = artifact {
            discard_partial(&self.sftp_manager, transfer_id, artifact).await?;
        }
        self.jobs.remove(transfer_id);
        self.forget_finished(transfer_id);
        Ok(())
    }

    /// Clear settled jobs that do not retain a resumable checkpoint.
    pub async fn clear_finished(&self) -> Result<(), SftpError> {
        let ids: Vec<String> = self
            .jobs
            .iter()
            .filter(|entry| {
                let terminal = matches!(
                    &entry.status,
                    TransferStatus::Completed
                        | TransferStatus::Failed(_)
                        | TransferStatus::Cancelled
                );
                let retained_checkpoint = entry.kind.resume_supported()
                    && matches!(
                        &entry.status,
                        TransferStatus::Failed(_) | TransferStatus::Cancelled
                    );
                terminal && !retained_checkpoint
            })
            .map(|entry| entry.transfer_id.clone())
            .collect();
        for id in ids {
            self.discard(&id).await?;
        }
        Ok(())
    }

    /// Adjust the maximum number of concurrent transfers.
    /// Increasing the limit adds semaphore permits; decreasing reconfigures
    /// the counter so future acquisitions are limited (in-flight work is not
    /// interrupted).
    pub fn set_max_concurrent(&self, n: u32) {
        apply_concurrency(&self.semaphore, &self.max_concurrent, n);
    }

    fn forget_finished(&self, transfer_id: &str) {
        self.finished_order
            .lock()
            .expect("finished_order mutex poisoned")
            .retain(|id| id != transfer_id);
    }
}

fn partial_artifact(job: &TransferJobState) -> Option<PartialArtifact> {
    match &job.kind {
        TransferJobKind::UploadFile {
            remote_path,
            checkpoint,
            ..
        } if checkpoint.has_partial() => Some(PartialArtifact::Upload {
            sftp_session_id: job.sftp_session_id.clone(),
            remote_path: remote_path.clone(),
            checkpoint: checkpoint.clone(),
        }),
        TransferJobKind::DownloadFile {
            local_path,
            checkpoint,
            ..
        } if checkpoint.has_partial() => Some(PartialArtifact::Download {
            local_path: local_path.clone(),
            checkpoint: checkpoint.clone(),
        }),
        _ => None,
    }
}

async fn discard_partial(
    sftp_manager: &Arc<SftpManager>,
    transfer_id: &str,
    artifact: PartialArtifact,
) -> Result<(), SftpError> {
    match artifact {
        PartialArtifact::Upload {
            sftp_session_id,
            remote_path,
            checkpoint,
        } => {
            let sftp = sftp_manager.get_session(&sftp_session_id)?.sftp.clone();
            file_transfer::discard_upload(&sftp, &remote_path, transfer_id).await?;
            checkpoint.clear_partial();
        }
        PartialArtifact::Download {
            local_path,
            checkpoint,
        } => {
            file_transfer::discard_download(&local_path, transfer_id).await?;
            checkpoint.clear_partial();
        }
    }
    Ok(())
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
    ssh_manager: &Arc<SshManager>,
    app_handle: &AppHandle,
) {
    // Check if it was cancelled before we even got the semaphore permit.
    {
        if let Some(job) = jobs.get(job_id) {
            if job.cancel_token.is_cancelled() {
                let status = match job.stop_request {
                    StopRequest::Pause => TransferStatus::Paused,
                    StopRequest::None | StopRequest::Cancel => TransferStatus::Cancelled,
                };
                drop(job);
                set_job_status(jobs, finished_order, job_id, status, None, app_handle);
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

    // We need to move the job *kind* out to avoid holding the DashMap lock
    // across await points. We reconstruct a temporary descriptor.
    let (sftp_session_id, kind_desc, cancel_token) = {
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
                checkpoint,
            } => KindDesc::UploadFile {
                local_path: local_path.clone(),
                remote_path: remote_path.clone(),
                checkpoint: checkpoint.clone(),
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
                checkpoint,
            } => KindDesc::DownloadFile {
                remote_path: remote_path.clone(),
                local_path: local_path.clone(),
                checkpoint: checkpoint.clone(),
            },
            TransferJobKind::DownloadDir {
                remote_path,
                local_dir,
            } => KindDesc::DownloadDir {
                remote_path: remote_path.clone(),
                local_dir: local_dir.clone(),
            },
        };
        (job.sftp_session_id.clone(), desc, cancel_token)
    };

    let transfer_session = match sftp_manager.transfer_session(&sftp_session_id) {
        Ok(session) => session,
        Err(error) => {
            set_job_status(
                jobs,
                finished_order,
                job_id,
                TransferStatus::Failed(error.to_string()),
                Some(error.to_string()),
                app_handle,
            );
            return;
        }
    };
    let mut generation = transfer_session.generation;
    let mut result = run_transfer_attempt(
        jobs,
        job_id,
        &transfer_session.sftp,
        &kind_desc,
        &cancel_token,
        app_handle,
    )
    .await;

    if kind_desc.resume_supported() {
        for (retry_index, delay) in AUTO_RETRY_DELAYS.iter().enumerate() {
            if !result.as_ref().is_err_and(SftpError::is_transient) {
                break;
            }

            tracing::warn!(
                transfer_id = %job_id,
                attempt = retry_index + 1,
                delay_ms = delay.as_millis(),
                "transient SFTP transfer failure; reconnecting before retry"
            );
            result = async {
                wait_for_retry(*delay, &cancel_token).await?;
                generation = sftp_manager
                    .reconnect_if_generation(
                        &sftp_session_id,
                        generation,
                        ssh_manager,
                        &cancel_token,
                    )
                    .await?;
                let session = sftp_manager.transfer_session(&sftp_session_id)?;
                run_transfer_attempt(
                    jobs,
                    job_id,
                    &session.sftp,
                    &kind_desc,
                    &cancel_token,
                    app_handle,
                )
                .await
            }
            .await;
        }
    }

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
        Err(SftpError::TransferCancelled) => {
            let stop_request = jobs
                .get(job_id)
                .map(|job| job.stop_request)
                .unwrap_or(StopRequest::Cancel);
            match stop_request {
                StopRequest::Pause => set_job_status(
                    jobs,
                    finished_order,
                    job_id,
                    TransferStatus::Paused,
                    None,
                    app_handle,
                ),
                StopRequest::Cancel => {
                    let artifact = jobs.get(job_id).and_then(|job| partial_artifact(&job));
                    if let Some(artifact) = artifact {
                        let _ = discard_partial(sftp_manager, job_id, artifact).await;
                    }
                    set_job_status(
                        jobs,
                        finished_order,
                        job_id,
                        TransferStatus::Cancelled,
                        None,
                        app_handle,
                    );
                }
                StopRequest::None => set_job_status(
                    jobs,
                    finished_order,
                    job_id,
                    TransferStatus::Failed("transfer interrupted".to_string()),
                    Some("transfer interrupted".to_string()),
                    app_handle,
                ),
            }
        }
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
#[derive(Clone)]
enum KindDesc {
    UploadFile {
        local_path: PathBuf,
        remote_path: String,
        checkpoint: UploadCheckpoint,
    },
    UploadDir {
        local_path: PathBuf,
        remote_dir: String,
    },
    DownloadFile {
        remote_path: String,
        local_path: PathBuf,
        checkpoint: DownloadCheckpoint,
    },
    DownloadDir {
        remote_path: String,
        local_dir: PathBuf,
    },
}

impl KindDesc {
    fn resume_supported(&self) -> bool {
        matches!(self, Self::UploadFile { .. } | Self::DownloadFile { .. })
    }
}

async fn wait_for_retry(delay: Duration, cancel: &CancellationToken) -> Result<(), SftpError> {
    tokio::select! {
        _ = tokio::time::sleep(delay) => Ok(()),
        _ = cancel.cancelled() => Err(SftpError::TransferCancelled),
    }
}

async fn run_transfer_attempt(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    sftp: &Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    kind: &KindDesc,
    cancel: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    match kind {
        KindDesc::UploadFile {
            local_path,
            remote_path,
            checkpoint,
        } => {
            run_upload_file(
                FileTransferContext {
                    jobs,
                    job_id,
                    sftp,
                    cancel,
                    app_handle,
                },
                local_path,
                remote_path,
                UploadMode::Resumable(checkpoint.clone()),
            )
            .await
        }
        KindDesc::UploadDir {
            local_path,
            remote_dir,
        } => {
            run_upload_dir(
                jobs, job_id, sftp, local_path, remote_dir, cancel, app_handle,
            )
            .await
        }
        KindDesc::DownloadFile {
            remote_path,
            local_path,
            checkpoint,
        } => {
            run_download_file(
                FileTransferContext {
                    jobs,
                    job_id,
                    sftp,
                    cancel,
                    app_handle,
                },
                remote_path,
                local_path,
                DownloadMode::Resumable(checkpoint.clone()),
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
                sftp,
                remote_path,
                local_dir,
                cancel,
                app_handle,
            )
            .await
        }
    }
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
    // A terminal status is final: the transition that set it already emitted
    // and recorded the job. A second call (queued-cancel followed by the
    // worker's dequeue, or a cancel racing the InProgress mark) must not
    // overwrite it or push a duplicate history entry.
    if job.is_terminal() {
        return;
    }
    job.status = status;
    job.error = error;
    let event = job.to_event();
    let is_terminal = job.is_terminal();
    // Drop the shard write-guard BEFORE record_finished: it re-enters the map
    // (get/remove of the evicted id), and a same-shard hit would deadlock.
    drop(job);

    let _ = app_handle.emit("sftp:transfer", event);
    if is_terminal {
        record_finished(jobs, finished_order, job_id);
    }
}

impl FinishedStatus for TransferJobState {
    fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            TransferStatus::Completed | TransferStatus::Failed(_) | TransferStatus::Cancelled
        )
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
    if let Some(mut job) = jobs.get_mut(job_id) {
        let should_emit = record_progress(&mut *job, new_bytes);
        if should_emit {
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit("sftp:transfer", event);
        }
    }
    if cancel_token.is_cancelled() {
        Err(SftpError::TransferCancelled)
    } else {
        Ok(())
    }
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

#[derive(Clone, Copy)]
struct FileTransferContext<'a> {
    jobs: &'a Arc<DashMap<String, TransferJobState>>,
    job_id: &'a str,
    sftp: &'a Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>,
    cancel: &'a CancellationToken,
    app_handle: &'a AppHandle,
}

enum UploadMode {
    Fresh,
    Resumable(UploadCheckpoint),
}

enum DownloadMode {
    Fresh,
    Resumable(DownloadCheckpoint),
}

impl FileTransferContext<'_> {
    fn progress_channel(&self) -> (mpsc::UnboundedSender<u64>, tokio::task::JoinHandle<()>) {
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<u64>();
        let jobs = self.jobs.clone();
        let job_id = self.job_id.to_string();
        let cancel = self.cancel.clone();
        let app_handle = self.app_handle.clone();
        let aggregator = tokio::spawn(async move {
            while let Some(bytes) = progress_rx.recv().await {
                let _ = update_progress(&jobs, &job_id, bytes, &cancel, &app_handle);
            }
        });
        (progress_tx, aggregator)
    }
}

async fn run_upload_file(
    context: FileTransferContext<'_>,
    local_path: &Path,
    remote_path: &str,
    mode: UploadMode,
) -> Result<(), SftpError> {
    let (progress_tx, aggregator) = context.progress_channel();

    let result = match mode {
        UploadMode::Resumable(checkpoint) => {
            file_transfer::upload_resumable(
                context.sftp,
                local_path,
                remote_path,
                context.job_id,
                checkpoint,
                context.cancel,
                progress_tx,
            )
            .await
        }
        UploadMode::Fresh => {
            file_transfer::upload_fresh(
                context.sftp,
                local_path,
                remote_path,
                context.job_id,
                context.cancel,
                progress_tx,
            )
            .await
        }
    };
    let _ = aggregator.await;
    result?;
    mark_file_done(context.jobs, context.job_id, context.app_handle);
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
                FileTransferContext {
                    jobs,
                    job_id,
                    sftp: sftp_arc,
                    cancel: cancel_token,
                    app_handle,
                },
                &entry.path(),
                &remote_child,
                UploadMode::Fresh,
            )
            .await?;
        }
    }

    Ok(())
}

// ─── Download: single file ────────────────────────────────────────────────────

async fn run_download_file(
    context: FileTransferContext<'_>,
    remote_path: &str,
    local_path: &Path,
    mode: DownloadMode,
) -> Result<(), SftpError> {
    let (progress_tx, aggregator) = context.progress_channel();

    let result = match mode {
        DownloadMode::Resumable(checkpoint) => {
            file_transfer::download_resumable(
                context.sftp,
                remote_path,
                local_path,
                context.job_id,
                checkpoint,
                context.cancel,
                progress_tx,
            )
            .await
        }
        DownloadMode::Fresh => {
            file_transfer::download_fresh(
                context.sftp,
                remote_path,
                local_path,
                context.job_id,
                context.cancel,
                progress_tx,
            )
            .await
        }
    };
    let _ = aggregator.await;
    result?;
    mark_file_done(context.jobs, context.job_id, context.app_handle);
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
                FileTransferContext {
                    jobs,
                    job_id,
                    sftp: sftp_arc,
                    cancel: cancel_token,
                    app_handle,
                },
                &remote_child,
                &local_child,
                DownloadMode::Fresh,
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

    #[tokio::test]
    async fn retry_wait_stops_when_transfer_is_paused_or_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = wait_for_retry(Duration::from_secs(60), &cancel).await;
        assert!(matches!(result, Err(SftpError::TransferCancelled)));
    }

    #[test]
    fn transfer_job_state_to_info_computes_eta() {
        let now = Instant::now();
        let job = TransferJobState {
            transfer_id: "t1".to_string(),
            sftp_session_id: "s1".to_string(),
            name: "file.txt".to_string(),
            direction: TransferDirection::Upload,
            kind: TransferJobKind::UploadDir {
                local_path: PathBuf::from("/tmp/file.txt"),
                remote_dir: "/remote/file.txt".to_string(),
            },
            status: TransferStatus::InProgress,
            bytes_transferred: 500,
            total_bytes: 1000,
            files_done: 0,
            files_total: 1,
            speed_bps: 100,
            cancel_token: CancellationToken::new(),
            stop_request: StopRequest::None,
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
            kind: TransferJobKind::DownloadDir {
                remote_path: "/remote/file.txt".to_string(),
                local_dir: PathBuf::from("/tmp/file.txt"),
            },
            status: TransferStatus::Completed,
            bytes_transferred: 1000,
            total_bytes: 1000,
            files_done: 1,
            files_total: 1,
            speed_bps: 100,
            cancel_token: CancellationToken::new(),
            stop_request: StopRequest::None,
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
            stop_request: StopRequest::None,
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
