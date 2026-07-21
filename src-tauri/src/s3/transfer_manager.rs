use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::transfer_common::{
    eta_secs, record_finished, record_progress, FinishedStatus, ProgressFields,
};

use super::{S3Error, S3Manager, S3TransferDirection, S3TransferEvent, S3TransferStatus};

// ─── Constants ───────────────────────────────────────────────────────────────

const UPLOAD_CHUNK_SIZE: usize = 8 * 1024 * 1024;
const RANGE_SIZE: u64 = 8 * 1024 * 1024;

// ─── Job state ───────────────────────────────────────────────────────────────

pub enum TransferJobKind {
    UploadFile {
        local_path: PathBuf,
        /// S3 object key (full path within bucket).
        key: String,
    },
    UploadDir {
        local_path: PathBuf,
        /// S3 key prefix under which all files are uploaded.
        prefix: String,
    },
    DownloadFile {
        /// S3 object key.
        key: String,
        local_path: PathBuf,
    },
}

pub struct TransferJobState {
    pub transfer_id: String,
    pub s3_session_id: String,
    pub name: String,
    pub direction: S3TransferDirection,
    pub kind: TransferJobKind,
    pub status: S3TransferStatus,
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
    fn to_event(&self) -> S3TransferEvent {
        let eta_secs = eta_secs(self.speed_bps, self.total_bytes, self.bytes_transferred);

        S3TransferEvent {
            transfer_id: self.transfer_id.clone(),
            s3_session_id: self.s3_session_id.clone(),
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

pub struct S3TransferManager {
    jobs: Arc<DashMap<String, TransferJobState>>,
    finished_order: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    queue_tx: mpsc::UnboundedSender<String>,
    semaphore: Arc<Semaphore>,
    s3_manager: Arc<S3Manager>,
    app_handle: AppHandle,
    #[allow(dead_code)]
    max_concurrent: Arc<AtomicU32>,
    /// Holds the queue receiver until the worker loop is spawned (lazy init).
    worker_rx: Arc<std::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl S3TransferManager {
    pub fn new(s3_manager: Arc<S3Manager>, app_handle: AppHandle) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel::<String>();
        let jobs: Arc<DashMap<String, TransferJobState>> = Arc::new(DashMap::new());
        let finished_order = Arc::new(std::sync::Mutex::new(VecDeque::new()));
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
            s3_manager,
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
            let s3_manager = self.s3_manager.clone();
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
                    let s3_manager = s3_manager.clone();
                    let app_handle = app_handle.clone();

                    tokio::spawn(async move {
                        execute_transfer(&jobs, &finished_order, &job_id, &s3_manager, &app_handle)
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
            let _ = app_handle.emit("s3:transfer", job.to_event());
        }
    }

    // ─── Upload ──────────────────────────────────────────────────────────────

    /// Enqueue one or more local paths for upload.
    /// Each path becomes a separate job (file or recursive dir).
    /// Returns the generated `transfer_id`s.
    #[instrument(skip(self), fields(s3_session_id = %s3_session_id))]
    pub async fn enqueue_upload(
        &self,
        s3_session_id: String,
        local_paths: Vec<PathBuf>,
        prefix: String,
    ) -> Result<Vec<String>, S3Error> {
        self.ensure_worker_spawned();
        let mut ids = Vec::with_capacity(local_paths.len());

        for local_path in local_paths {
            let meta = tokio::fs::metadata(&local_path)
                .await
                .map_err(|e| S3Error::IoError(e.to_string()))?;

            let name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let transfer_id = uuid::Uuid::new_v4().to_string();
            let now = Self::unix_now_millis();
            let now_instant = Instant::now();

            let (kind, total_bytes, files_total) = if meta.is_dir() {
                let (bytes, count) = walk_local_dir_stats(&local_path).await;
                let key_prefix = format!("{}/{}", prefix.trim_end_matches('/'), name);
                (
                    TransferJobKind::UploadDir {
                        local_path: local_path.clone(),
                        prefix: key_prefix,
                    },
                    bytes,
                    count,
                )
            } else {
                let key = format!("{}/{}", prefix.trim_end_matches('/'), name);
                (
                    TransferJobKind::UploadFile {
                        local_path: local_path.clone(),
                        key,
                    },
                    meta.len(),
                    1u32,
                )
            };

            let job = TransferJobState {
                transfer_id: transfer_id.clone(),
                s3_session_id: s3_session_id.clone(),
                name: name.clone(),
                direction: S3TransferDirection::Upload,
                kind,
                status: S3TransferStatus::Queued,
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
                .map_err(|e| S3Error::OperationError(format!("queue send error: {e}")))?;

            ids.push(transfer_id);
        }

        Ok(ids)
    }

    // ─── Download ────────────────────────────────────────────────────────────

    /// Enqueue one or more S3 object keys for download into `local_dir`, each
    /// saved under its key's basename.
    #[instrument(skip(self), fields(s3_session_id = %s3_session_id))]
    pub async fn enqueue_download(
        &self,
        s3_session_id: String,
        keys: Vec<String>,
        local_dir: PathBuf,
    ) -> Result<Vec<String>, S3Error> {
        self.ensure_worker_spawned();

        // We need the bucket to retrieve object sizes.
        let bucket = self.s3_manager.get_bucket(&s3_session_id)?;

        let mut ids = Vec::with_capacity(keys.len());

        for key in keys {
            let name = std::path::Path::new(&key)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| key.clone());
            let local_path = local_dir.join(&name);
            let id = self
                .queue_download_job(&bucket, &s3_session_id, key, local_path)
                .await?;
            ids.push(id);
        }

        Ok(ids)
    }

    /// Enqueue a single object for streaming download to an explicit local path
    /// (e.g. a save-dialog target the user renamed). Unlike the one-shot
    /// [`s3_download_file`](crate::s3::commands::s3_download_file) command, this
    /// goes through the transfer pipeline, so it reports progress, can be
    /// cancelled, and streams to disk instead of buffering the whole object in
    /// memory.
    #[instrument(skip(self), fields(s3_session_id = %s3_session_id))]
    pub async fn enqueue_download_to(
        &self,
        s3_session_id: String,
        key: String,
        local_path: PathBuf,
    ) -> Result<String, S3Error> {
        self.ensure_worker_spawned();
        let bucket = self.s3_manager.get_bucket(&s3_session_id)?;
        self.queue_download_job(&bucket, &s3_session_id, key, local_path)
            .await
    }

    /// Build, register, and queue a single streaming download job that writes the
    /// object to `local_path` exactly. Shared by [`enqueue_download`] (path =
    /// `dir/basename`) and [`enqueue_download_to`] (caller-chosen path); the
    /// transfer's display name is the local file's name.
    ///
    /// [`enqueue_download`]: Self::enqueue_download
    /// [`enqueue_download_to`]: Self::enqueue_download_to
    async fn queue_download_job(
        &self,
        bucket: &s3::Bucket,
        s3_session_id: &str,
        key: String,
        local_path: PathBuf,
    ) -> Result<String, S3Error> {
        let name = local_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| key.clone());

        let transfer_id = uuid::Uuid::new_v4().to_string();
        let now = Self::unix_now_millis();
        let now_instant = Instant::now();

        // Fetch the object size via HEAD.
        let size = match bucket.head_object(&key).await {
            Ok((head, _)) => head.content_length.unwrap_or(0) as u64,
            Err(_) => 0,
        };

        let job = TransferJobState {
            transfer_id: transfer_id.clone(),
            s3_session_id: s3_session_id.to_string(),
            name,
            direction: S3TransferDirection::Download,
            kind: TransferJobKind::DownloadFile { key, local_path },
            status: S3TransferStatus::Queued,
            bytes_transferred: 0,
            total_bytes: size,
            files_done: 0,
            files_total: 1,
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
            .map_err(|e| S3Error::OperationError(format!("queue send error: {e}")))?;

        Ok(transfer_id)
    }

    // ─── Control ─────────────────────────────────────────────────────────────

    /// Cancel a queued or in-progress transfer.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn cancel(&self, transfer_id: &str) -> Result<(), S3Error> {
        let mut job = self
            .jobs
            .get_mut(transfer_id)
            .ok_or_else(|| S3Error::OperationError(format!("transfer not found: {transfer_id}")))?;

        job.cancel_token.cancel();

        // If still queued, mark cancelled immediately (the worker will no-op).
        if job.status == S3TransferStatus::Queued {
            job.status = S3TransferStatus::Cancelled;
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("s3:transfer", event);
            record_finished(&self.jobs, &self.finished_order, transfer_id);
        }

        Ok(())
    }

    /// Retry a failed or cancelled transfer by resetting its state and re-queuing it.
    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn retry(&self, transfer_id: &str) -> Result<(), S3Error> {
        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                S3Error::OperationError(format!("transfer not found: {transfer_id}"))
            })?;

            match &job.status {
                S3TransferStatus::Failed(_) | S3TransferStatus::Cancelled => {}
                _ => {
                    return Err(S3Error::OperationError(format!(
                        "transfer {transfer_id} is not in a failed/cancelled state"
                    )));
                }
            }

            job.status = S3TransferStatus::Queued;
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
            let _ = self.app_handle.emit("s3:transfer", event);
        }

        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| S3Error::OperationError(format!("queue send error: {e}")))?;

        Ok(())
    }

    /// Snapshot of every known transfer job.
    pub fn list_all(&self) -> Vec<S3TransferEvent> {
        self.jobs.iter().map(|r| r.value().to_event()).collect()
    }

    /// Remove completed, failed, and cancelled jobs from the registry.
    pub fn clear_finished(&self) {
        self.jobs.retain(|_, job| {
            !matches!(
                &job.status,
                S3TransferStatus::Completed
                    | S3TransferStatus::Failed(_)
                    | S3TransferStatus::Cancelled
            )
        });
    }
}

// ─── Local directory statistics ──────────────────────────────────────────────

/// Recursively walk a local directory and return (total_bytes, file_count).
/// Uses canonical paths to detect and skip symlink cycles.
async fn walk_local_dir_stats(path: &PathBuf) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_local_dir_inner(path, &mut visited)).await
}

async fn walk_local_dir_inner(path: &PathBuf, visited: &mut HashSet<PathBuf>) -> (u64, u32) {
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
    finished_order: &Arc<std::sync::Mutex<VecDeque<String>>>,
    job_id: &str,
    s3_manager: &Arc<S3Manager>,
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
                    S3TransferStatus::Cancelled,
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
        S3TransferStatus::InProgress,
        None,
        app_handle,
    );

    // Retrieve the bucket — bail with an error if the session is gone.
    let bucket = {
        let s3_session_id = {
            let job = match jobs.get(job_id) {
                Some(j) => j,
                None => return,
            };
            job.s3_session_id.clone()
        };

        match s3_manager.get_bucket(&s3_session_id) {
            Ok(b) => b,
            Err(e) => {
                set_job_status(
                    jobs,
                    finished_order,
                    job_id,
                    S3TransferStatus::Failed(e.to_string()),
                    Some(e.to_string()),
                    app_handle,
                );
                return;
            }
        }
    };

    // Extract the kind descriptor without holding the DashMap lock across awaits.
    let (kind_desc, cancel_token) = {
        let job = match jobs.get(job_id) {
            Some(j) => j,
            None => return,
        };
        let cancel_token = job.cancel_token.clone();
        let desc = match &job.kind {
            TransferJobKind::UploadFile { local_path, key } => KindDesc::UploadFile {
                local_path: local_path.clone(),
                key: key.clone(),
            },
            TransferJobKind::UploadDir { local_path, prefix } => KindDesc::UploadDir {
                local_path: local_path.clone(),
                prefix: prefix.clone(),
            },
            TransferJobKind::DownloadFile {
                key, local_path, ..
            } => KindDesc::DownloadFile {
                key: key.clone(),
                local_path: local_path.clone(),
            },
        };
        (desc, cancel_token)
    };

    let result = match kind_desc {
        KindDesc::UploadFile { local_path, key } => {
            run_upload_file(
                jobs,
                job_id,
                &bucket,
                &local_path,
                &key,
                &cancel_token,
                app_handle,
            )
            .await
        }
        KindDesc::UploadDir { local_path, prefix } => {
            run_upload_dir(
                jobs,
                job_id,
                &bucket,
                &local_path,
                &prefix,
                &cancel_token,
                app_handle,
            )
            .await
        }
        KindDesc::DownloadFile { key, local_path } => {
            run_download_file(
                jobs,
                job_id,
                &bucket,
                &key,
                &local_path,
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
            (S3TransferDirection::Upload, 0, 0, 0)
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
                    "protocol": "s3",
                    "direction": if job_direction == S3TransferDirection::Upload { "upload" } else { "download" },
                    "total_bytes": job_total_bytes,
                    "files_total": job_files_total,
                }),
            );
            set_job_status(
                jobs,
                finished_order,
                job_id,
                S3TransferStatus::Completed,
                None,
                app_handle,
            );
        }
        Err(S3Error::TransferCancelled) => set_job_status(
            jobs,
            finished_order,
            job_id,
            S3TransferStatus::Cancelled,
            None,
            app_handle,
        ),
        Err(e) => {
            crate::telemetry::capture(
                "transfer_failed",
                serde_json::json!({
                    "protocol": "s3",
                    "direction": if job_direction == S3TransferDirection::Upload { "upload" } else { "download" },
                    "bytes_transferred": job_bytes_transferred,
                    "total_bytes": job_total_bytes,
                }),
            );
            set_job_status(
                jobs,
                finished_order,
                job_id,
                S3TransferStatus::Failed(e.to_string()),
                Some(e.to_string()),
                app_handle,
            );
        }
    }
}

// An owned copy of the discriminant so we can release the DashMap reference.
enum KindDesc {
    UploadFile { local_path: PathBuf, key: String },
    UploadDir { local_path: PathBuf, prefix: String },
    DownloadFile { key: String, local_path: PathBuf },
}

// ─── Status helpers ───────────────────────────────────────────────────────────

fn set_job_status(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    finished_order: &Arc<std::sync::Mutex<VecDeque<String>>>,
    job_id: &str,
    status: S3TransferStatus,
    error: Option<String>,
    app_handle: &AppHandle,
) {
    let Some(mut job) = jobs.get_mut(job_id) else {
        return;
    };
    let is_terminal = matches!(
        status,
        S3TransferStatus::Completed | S3TransferStatus::Failed(_) | S3TransferStatus::Cancelled
    );
    job.status = status;
    job.error = error;
    let event = job.to_event();
    drop(job);
    let _ = app_handle.emit("s3:transfer", event);
    if is_terminal {
        record_finished(jobs, finished_order, job_id);
    }
}

impl FinishedStatus for TransferJobState {
    fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            S3TransferStatus::Completed | S3TransferStatus::Failed(_) | S3TransferStatus::Cancelled
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
) -> Result<(), S3Error> {
    if cancel_token.is_cancelled() {
        return Err(S3Error::TransferCancelled);
    }

    if let Some(mut job) = jobs.get_mut(job_id) {
        let should_emit = record_progress(&mut *job, new_bytes);
        if should_emit {
            job.last_emit = Instant::now();
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit("s3:transfer", event);
        }
    }

    Ok(())
}

// ─── Upload: single file ──────────────────────────────────────────────────────

/// Read the local file in chunks (tracking read progress), then PUT to S3.
/// S3 PUTs are atomic so we emit progress during the read phase; the network
/// hop appears instantaneous from the progress perspective.
async fn run_upload_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    bucket: &s3::Bucket,
    local_path: &PathBuf,
    key: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), S3Error> {
    const CONTENT_TYPE: &str = "application/octet-stream";

    if cancel_token.is_cancelled() {
        return Err(S3Error::TransferCancelled);
    }

    let file_len = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot stat {}: {e}", local_path.display())))?
        .len();

    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot read {}: {e}", local_path.display())))?;

    if file_len < UPLOAD_CHUNK_SIZE as u64 {
        let mut data = Vec::with_capacity(file_len as usize);
        file.read_to_end(&mut data)
            .await
            .map_err(|e| S3Error::IoError(e.to_string()))?;
        bucket
            .put_object(key, &data)
            .await
            .map_err(|e| S3Error::OperationError(format!("S3 PUT failed for {key}: {e}")))?;
        update_progress(jobs, job_id, file_len, cancel_token, app_handle)?;
    } else {
        let msg = bucket
            .initiate_multipart_upload(key, CONTENT_TYPE)
            .await
            .map_err(|e| {
                S3Error::OperationError(format!("S3 multipart initiate failed for {key}: {e}"))
            })?;
        let upload_id = msg.upload_id.clone();
        let upload_result = async {
            let mut parts = Vec::new();
            let mut buf = vec![0u8; UPLOAD_CHUNK_SIZE];
            let mut part_number: u32 = 0;

            loop {
                if cancel_token.is_cancelled() {
                    return Err(S3Error::TransferCancelled);
                }
                let mut filled = 0;
                while filled < buf.len() {
                    let n = file
                        .read(&mut buf[filled..])
                        .await
                        .map_err(|e| S3Error::IoError(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                if filled == 0 {
                    break;
                }

                part_number += 1;
                let part = bucket
                    .put_multipart_chunk(
                        buf[..filled].to_vec(),
                        &msg.key,
                        part_number,
                        &upload_id,
                        CONTENT_TYPE,
                    )
                    .await
                    .map_err(|e| {
                        S3Error::OperationError(format!(
                            "S3 multipart part {part_number} failed for {key}: {e}"
                        ))
                    })?;
                parts.push(part);

                update_progress(jobs, job_id, filled as u64, cancel_token, app_handle)?;

                if filled < buf.len() {
                    break;
                }
            }

            Ok(parts)
        }
        .await;

        match upload_result {
            Ok(parts) => {
                bucket
                    .complete_multipart_upload(&msg.key, &upload_id, parts)
                    .await
                    .map_err(|e| {
                        S3Error::OperationError(format!(
                            "S3 multipart complete failed for {key}: {e}"
                        ))
                    })?;
            }
            Err(e) => {
                let _ = bucket.abort_upload(&msg.key, &upload_id).await;
                return Err(e);
            }
        }
    }

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
    bucket: &s3::Bucket,
    local_path: &PathBuf,
    prefix: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), S3Error> {
    Box::pin(upload_dir_recursive(
        jobs,
        job_id,
        bucket,
        local_path,
        prefix,
        cancel_token,
        app_handle,
    ))
    .await
}

async fn upload_dir_recursive(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    bucket: &s3::Bucket,
    local_dir: &PathBuf,
    prefix: &str,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), S3Error> {
    let mut read_dir = tokio::fs::read_dir(local_dir)
        .await
        .map_err(|e| S3Error::IoError(e.to_string()))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| S3Error::IoError(e.to_string()))?
    {
        if cancel_token.is_cancelled() {
            return Err(S3Error::TransferCancelled);
        }

        let meta = entry
            .metadata()
            .await
            .map_err(|e| S3Error::IoError(e.to_string()))?;

        let child_name = entry.file_name().to_string_lossy().to_string();
        let child_prefix = format!("{prefix}/{child_name}");

        if meta.is_dir() {
            Box::pin(upload_dir_recursive(
                jobs,
                job_id,
                bucket,
                &entry.path(),
                &child_prefix,
                cancel_token,
                app_handle,
            ))
            .await?;
        } else {
            run_upload_file(
                jobs,
                job_id,
                bucket,
                &entry.path(),
                &child_prefix,
                cancel_token,
                app_handle,
            )
            .await?;
        }
    }

    Ok(())
}

// ─── Download: single file ────────────────────────────────────────────────────

/// GET the full object from S3, then write to a local file chunk-by-chunk
/// (tracking write progress so the UI shows meaningful progress).
async fn run_download_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    bucket: &s3::Bucket,
    key: &str,
    local_path: &PathBuf,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), S3Error> {
    use tokio::io::AsyncWriteExt;

    if cancel_token.is_cancelled() {
        return Err(S3Error::TransferCancelled);
    }

    // Ensure parent directory exists.
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| S3Error::IoError(e.to_string()))?;
    }

    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| S3Error::IoError(format!("Cannot create {}: {e}", local_path.display())))?;

    let total_size = jobs.get(job_id).map(|j| j.total_bytes).unwrap_or(0);

    let download_result: Result<(), S3Error> = async {
        if total_size == 0 {
            bucket
                .get_object_to_writer(key, &mut local_file)
                .await
                .map_err(|e| S3Error::OperationError(format!("S3 GET failed for {key}: {e}")))?;
            update_progress(jobs, job_id, 0, cancel_token, app_handle)?;
            return Ok(());
        }

        let mut offset = 0u64;
        while offset < total_size {
            if cancel_token.is_cancelled() {
                return Err(S3Error::TransferCancelled);
            }

            let end = (offset + RANGE_SIZE - 1).min(total_size - 1);
            bucket
                .get_object_range_to_writer(key, offset, Some(end), &mut local_file)
                .await
                .map_err(|e| {
                    S3Error::OperationError(format!("S3 GET range failed for {key}: {e}"))
                })?;

            let n = end - offset + 1;
            update_progress(jobs, job_id, n, cancel_token, app_handle)?;
            offset = end + 1;
        }
        Ok(())
    }
    .await;

    if let Err(e) = download_result {
        drop(local_file);
        let _ = tokio::fs::remove_file(local_path).await;
        return Err(e);
    }

    local_file
        .flush()
        .await
        .map_err(|e| S3Error::IoError(e.to_string()))?;

    // Mark this file done.
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
    }

    Ok(())
}
