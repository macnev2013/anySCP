//! Queue-based, concurrency-limited transfer manager for SCP — the SCP
//! analogue of `sftp::transfer_manager`. Files are transferred with the SCP
//! wire protocol (see [`super::transfer`]); directories are walked in Rust
//! and transferred file-by-file, with `mkdir -p` issued over SSH exec.
//!
//! Progress is emitted on the `scp:transfer` channel using the same
//! `TransferEvent` shape as SFTP (with the session id key renamed), so the
//! frontend can normalize both.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use russh::client::Handle;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::ssh::handler::SshClientHandler;

use super::{
    exec, transfer, ScpError, ScpManager, TransferDirection, TransferEvent, TransferInfo,
    TransferStatus,
};

// ─── Constants ───────────────────────────────────────────────────────────────

const EMIT_THROTTLE: Duration = Duration::from_millis(100);
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
    },
    DownloadDir {
        remote_path: String,
        local_dir: PathBuf,
    },
}

pub struct TransferJobState {
    pub transfer_id: String,
    pub scp_session_id: String,
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
    fn eta(&self) -> Option<u64> {
        if self.speed_bps > 0 && self.total_bytes > self.bytes_transferred {
            Some((self.total_bytes - self.bytes_transferred) / self.speed_bps)
        } else {
            None
        }
    }

    fn to_event(&self) -> TransferEvent {
        TransferEvent {
            transfer_id: self.transfer_id.clone(),
            scp_session_id: self.scp_session_id.clone(),
            name: self.name.clone(),
            direction: self.direction.clone(),
            status: self.status.clone(),
            error: self.error.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            files_total: self.files_total,
            speed_bps: self.speed_bps,
            eta_secs: self.eta(),
            created_at: self.created_at,
        }
    }

    fn to_info(&self) -> TransferInfo {
        TransferInfo {
            transfer_id: self.transfer_id.clone(),
            scp_session_id: self.scp_session_id.clone(),
            name: self.name.clone(),
            direction: self.direction.clone(),
            status: self.status.clone(),
            error: self.error.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            files_total: self.files_total,
            speed_bps: self.speed_bps,
            eta_secs: self.eta(),
            created_at: self.created_at,
        }
    }
}

// ─── Manager ─────────────────────────────────────────────────────────────────

pub struct ScpTransferManager {
    jobs: Arc<DashMap<String, TransferJobState>>,
    queue_tx: mpsc::UnboundedSender<String>,
    semaphore: Arc<Semaphore>,
    scp_manager: Arc<ScpManager>,
    app_handle: AppHandle,
    max_concurrent: Arc<AtomicU32>,
    worker_rx: Arc<std::sync::Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl ScpTransferManager {
    pub fn new(scp_manager: Arc<ScpManager>, app_handle: AppHandle) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel::<String>();
        Self {
            jobs: Arc::new(DashMap::new()),
            queue_tx,
            semaphore: Arc::new(Semaphore::new(3)),
            scp_manager,
            app_handle,
            max_concurrent: Arc::new(AtomicU32::new(3)),
            worker_rx: Arc::new(std::sync::Mutex::new(Some(queue_rx))),
        }
    }

    fn ensure_worker_spawned(&self) {
        let mut guard = self.worker_rx.lock().expect("worker_rx mutex poisoned");
        if let Some(mut queue_rx) = guard.take() {
            let jobs = self.jobs.clone();
            let semaphore = self.semaphore.clone();
            let scp_manager = self.scp_manager.clone();
            let app_handle = self.app_handle.clone();

            tokio::spawn(async move {
                while let Some(job_id) = queue_rx.recv().await {
                    let permit = semaphore
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("semaphore closed");
                    let jobs = jobs.clone();
                    let scp_manager = scp_manager.clone();
                    let app_handle = app_handle.clone();
                    tokio::spawn(async move {
                        execute_transfer(&jobs, &job_id, &scp_manager, &app_handle).await;
                        drop(permit);
                    });
                }
            });
        }
    }

    fn unix_now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn emit_initial(&self, job_id: &str) {
        if let Some(job) = self.jobs.get(job_id) {
            let _ = self.app_handle.emit("scp:transfer", job.to_event());
        }
    }

    fn insert_and_queue(&self, job: TransferJobState) -> Result<String, ScpError> {
        let id = job.transfer_id.clone();
        self.jobs.insert(id.clone(), job);
        self.emit_initial(&id);
        self.queue_tx
            .send(id.clone())
            .map_err(|e| ScpError::ChannelError(e.to_string()))?;
        Ok(id)
    }

    fn new_job(
        scp_session_id: &str,
        name: String,
        direction: TransferDirection,
        kind: TransferJobKind,
        total_bytes: u64,
        files_total: u32,
    ) -> TransferJobState {
        let now_instant = Instant::now();
        TransferJobState {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            scp_session_id: scp_session_id.to_string(),
            name,
            direction,
            kind,
            status: TransferStatus::Queued,
            bytes_transferred: 0,
            total_bytes,
            files_done: 0,
            files_total,
            speed_bps: 0,
            cancel_token: CancellationToken::new(),
            error: None,
            created_at: Self::unix_now_millis(),
            last_emit: now_instant,
            speed_window_bytes: 0,
            speed_window_start: now_instant,
        }
    }

    // ─── Enqueue ───────────────────────────────────────────────────────────

    #[instrument(skip(self), fields(scp_session_id = %scp_session_id))]
    pub async fn enqueue_upload(
        &self,
        scp_session_id: String,
        local_paths: Vec<PathBuf>,
        remote_dir: String,
    ) -> Result<Vec<String>, ScpError> {
        self.ensure_worker_spawned();
        let mut ids = Vec::with_capacity(local_paths.len());

        for local_path in local_paths {
            let meta = tokio::fs::metadata(&local_path)
                .await
                .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
            let name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);

            let job = if meta.is_dir() {
                let (bytes, count) = walk_local_dir_stats(&local_path).await;
                Self::new_job(
                    &scp_session_id,
                    name,
                    TransferDirection::Upload,
                    TransferJobKind::UploadDir {
                        local_path,
                        remote_dir: remote_path,
                    },
                    bytes,
                    count,
                )
            } else {
                Self::new_job(
                    &scp_session_id,
                    name,
                    TransferDirection::Upload,
                    TransferJobKind::UploadFile {
                        local_path,
                        remote_path,
                    },
                    meta.len(),
                    1,
                )
            };
            ids.push(self.insert_and_queue(job)?);
        }
        Ok(ids)
    }

    #[instrument(skip(self), fields(scp_session_id = %scp_session_id))]
    pub async fn enqueue_download(
        &self,
        scp_session_id: String,
        remote_paths: Vec<String>,
        local_dir: PathBuf,
    ) -> Result<Vec<String>, ScpError> {
        self.ensure_worker_spawned();
        let (handle, flavor) = {
            let session = self.scp_manager.get_session(&scp_session_id)?;
            (session.ssh_handle.clone(), session.flavor)
        };

        let mut ids = Vec::with_capacity(remote_paths.len());
        for remote_path in remote_paths {
            let name = Path::new(&remote_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let stat = exec::stat(handle.clone(), flavor, &remote_path)
                .await?
                .ok_or_else(|| ScpError::NotFound(remote_path.clone()))?;

            let local_dest = local_dir.join(&name);
            let job = if stat.entry_type == super::ScpEntryType::Directory {
                let (bytes, count) = exec::dir_stats(handle.clone(), flavor, &remote_path).await?;
                Self::new_job(
                    &scp_session_id,
                    name,
                    TransferDirection::Download,
                    TransferJobKind::DownloadDir {
                        remote_path,
                        local_dir: local_dest,
                    },
                    bytes,
                    count,
                )
            } else {
                Self::new_job(
                    &scp_session_id,
                    name,
                    TransferDirection::Download,
                    TransferJobKind::DownloadFile {
                        remote_path,
                        local_path: local_dest,
                    },
                    stat.size,
                    1,
                )
            };
            ids.push(self.insert_and_queue(job)?);
        }
        Ok(ids)
    }

    // ─── Control ─────────────────────────────────────────────────────────────

    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn cancel(&self, transfer_id: &str) -> Result<(), ScpError> {
        let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
            ScpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
        })?;
        job.cancel_token.cancel();
        if job.status == TransferStatus::Queued {
            job.status = TransferStatus::Cancelled;
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit("scp:transfer", event);
        }
        Ok(())
    }

    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn retry(&self, transfer_id: &str) -> Result<(), ScpError> {
        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                ScpError::SessionNotFound(format!("transfer not found: {transfer_id}"))
            })?;
            match &job.status {
                TransferStatus::Failed(_) | TransferStatus::Cancelled => {}
                _ => {
                    return Err(ScpError::ProtocolError(format!(
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
            let _ = self.app_handle.emit("scp:transfer", event);
        }
        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| ScpError::ChannelError(e.to_string()))?;
        Ok(())
    }

    pub fn list_all(&self) -> Vec<TransferInfo> {
        self.jobs.iter().map(|r| r.value().to_info()).collect()
    }

    pub fn clear_finished(&self) {
        self.jobs.retain(|_, job| {
            !matches!(
                &job.status,
                TransferStatus::Completed | TransferStatus::Failed(_) | TransferStatus::Cancelled
            )
        });
    }

    pub fn set_max_concurrent(&self, n: u32) {
        let old = self.max_concurrent.swap(n, Ordering::SeqCst);
        let current = self.semaphore.available_permits() as u32;
        match n.cmp(&old) {
            std::cmp::Ordering::Greater => self.semaphore.add_permits((n - old) as usize),
            std::cmp::Ordering::Less => {
                let to_remove = (old - n).min(current);
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

// ─── Local directory statistics ──────────────────────────────────────────────

async fn walk_local_dir_stats(path: &Path) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_local_dir_inner(path, &mut visited)).await
}

async fn walk_local_dir_inner(path: &Path, visited: &mut HashSet<PathBuf>) -> (u64, u32) {
    let canonical = match tokio::fs::canonicalize(path).await {
        Ok(p) => p,
        Err(_) => return (0, 0),
    };
    if !visited.insert(canonical) {
        return (0, 0);
    }
    let mut total_bytes = 0u64;
    let mut file_count = 0u32;
    let mut rd = match tokio::fs::read_dir(path).await {
        Ok(rd) => rd,
        Err(_) => return (0, 0),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let (b, c) = Box::pin(walk_local_dir_inner(&entry.path(), visited)).await;
            total_bytes += b;
            file_count += c;
        } else {
            total_bytes += meta.len();
            file_count += 1;
        }
    }
    (total_bytes, file_count)
}

// ─── Execute ───────────────────────────────────────────────────────────────────

async fn execute_transfer(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    scp_manager: &Arc<ScpManager>,
    app_handle: &AppHandle,
) {
    // Cancelled before we got a permit?
    if let Some(job) = jobs.get(job_id) {
        if job.cancel_token.is_cancelled() {
            drop(job);
            set_job_status(jobs, job_id, TransferStatus::Cancelled, None, app_handle);
            return;
        }
    } else {
        return;
    }

    set_job_status(jobs, job_id, TransferStatus::InProgress, None, app_handle);

    // Resolve the SSH handle and remote flavor.
    let (handle, flavor) = {
        let sid = match jobs.get(job_id) {
            Some(j) => j.scp_session_id.clone(),
            None => return,
        };
        match scp_manager.get_session(&sid) {
            Ok(s) => (s.ssh_handle.clone(), s.flavor),
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

    // Snapshot the kind + cancel token without holding the DashMap lock across awaits.
    let (kind_desc, cancel_token) = {
        let job = match jobs.get(job_id) {
            Some(j) => j,
            None => return,
        };
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
        (desc, job.cancel_token.clone())
    };

    let result = match kind_desc {
        KindDesc::UploadFile {
            local_path,
            remote_path,
        } => {
            run_upload_file(
                jobs,
                job_id,
                &handle,
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
                &handle,
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
                &handle,
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
                &handle,
                flavor,
                &remote_path,
                &local_dir,
                &cancel_token,
                app_handle,
            )
            .await
        }
    };

    let (direction, total_bytes, files_total, bytes_done) = jobs
        .get(job_id)
        .map(|j| {
            (
                j.direction.clone(),
                j.total_bytes,
                j.files_total,
                j.bytes_transferred,
            )
        })
        .unwrap_or((TransferDirection::Upload, 0, 0, 0));

    match result {
        Ok(()) => {
            crate::telemetry::capture(
                "transfer_completed",
                serde_json::json!({
                    "protocol": "scp",
                    "direction": if direction == TransferDirection::Upload { "upload" } else { "download" },
                    "total_bytes": total_bytes,
                    "files_total": files_total,
                }),
            );
            set_job_status(jobs, job_id, TransferStatus::Completed, None, app_handle);
        }
        Err(ScpError::TransferCancelled) => {
            set_job_status(jobs, job_id, TransferStatus::Cancelled, None, app_handle)
        }
        Err(e) => {
            crate::telemetry::capture(
                "transfer_failed",
                serde_json::json!({
                    "protocol": "scp",
                    "direction": if direction == TransferDirection::Upload { "upload" } else { "download" },
                    "bytes_transferred": bytes_done,
                    "total_bytes": total_bytes,
                }),
            );
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

// ─── Status / progress helpers ─────────────────────────────────────────────────

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
        let _ = app_handle.emit("scp:transfer", event);
    }
}

/// Set the absolute cumulative byte count for the current transfer and emit a
/// throttled progress event. `base_bytes` is the bytes completed by prior
/// files in a multi-file job; `file_bytes` is progress within the current file.
fn report_progress(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    cumulative: u64,
    app_handle: &AppHandle,
) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        let delta = cumulative.saturating_sub(job.bytes_transferred);
        job.bytes_transferred = cumulative;
        job.speed_window_bytes += delta;

        let window_elapsed = job.speed_window_start.elapsed();
        if window_elapsed >= SPEED_WINDOW {
            let secs = window_elapsed.as_secs_f64().max(0.001);
            job.speed_bps = (job.speed_window_bytes as f64 / secs) as u64;
            job.speed_window_bytes = 0;
            job.speed_window_start = Instant::now();
        } else if job.speed_bps == 0 && window_elapsed.as_millis() > 200 {
            let secs = window_elapsed.as_secs_f64().max(0.001);
            job.speed_bps = (job.speed_window_bytes as f64 / secs) as u64;
        }

        if job.last_emit.elapsed() >= EMIT_THROTTLE {
            job.last_emit = Instant::now();
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit("scp:transfer", event);
        }
    }
}

fn mark_file_done(jobs: &Arc<DashMap<String, TransferJobState>>, job_id: &str) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
    }
}

// ─── Runners ───────────────────────────────────────────────────────────────────

type Handle_ = Arc<Mutex<Handle<SshClientHandler>>>;

async fn run_upload_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    handle: &Handle_,
    local_path: &Path,
    remote_path: &str,
    cancel: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), ScpError> {
    // Ensure the remote parent exists.
    if let Some(parent) = Path::new(remote_path).parent() {
        let p = parent.to_string_lossy();
        if !p.is_empty() && p != "/" {
            exec::mkdir_p(handle.clone(), &p).await?;
        }
    }

    let jobs_cl = jobs.clone();
    let app_cl = app_handle.clone();
    let jid = job_id.to_string();
    transfer::upload_file(
        handle.clone(),
        local_path,
        remote_path,
        cancel,
        move |done| {
            report_progress(&jobs_cl, &jid, done, &app_cl);
        },
    )
    .await?;
    mark_file_done(jobs, job_id);
    Ok(())
}

async fn run_download_file(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    handle: &Handle_,
    remote_path: &str,
    local_path: &Path,
    cancel: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), ScpError> {
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
    }

    let jobs_cl = jobs.clone();
    let app_cl = app_handle.clone();
    let jid = job_id.to_string();
    transfer::download_file(
        handle.clone(),
        remote_path,
        local_path,
        cancel,
        move |done| {
            report_progress(&jobs_cl, &jid, done, &app_cl);
        },
    )
    .await?;
    mark_file_done(jobs, job_id);
    Ok(())
}

async fn run_upload_dir(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    handle: &Handle_,
    local_root: &Path,
    remote_root: &str,
    cancel: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), ScpError> {
    exec::mkdir_p(handle.clone(), remote_root).await?;

    // base_bytes accumulates completed-file totals so the per-file callback
    // can report a job-wide cumulative count.
    let mut base_bytes: u64 = 0;
    let mut stack = vec![local_root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if cancel.is_cancelled() {
            return Err(ScpError::TransferCancelled);
        }
        let rel = dir.strip_prefix(local_root).unwrap_or(Path::new(""));
        let remote_dir = join_under(remote_root, rel);
        exec::mkdir_p(handle.clone(), &remote_dir).await?;

        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
        while let Ok(Some(entry)) = rd.next_entry().await {
            if cancel.is_cancelled() {
                return Err(ScpError::TransferCancelled);
            }
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let entry_path = entry.path();
            if meta.is_dir() {
                stack.push(entry_path);
            } else {
                let file_name = entry.file_name().to_string_lossy().to_string();
                let remote_file = format!("{}/{}", remote_dir.trim_end_matches('/'), file_name);
                let jobs_cl = jobs.clone();
                let app_cl = app_handle.clone();
                let jid = job_id.to_string();
                let start = base_bytes;
                transfer::upload_file(
                    handle.clone(),
                    &entry_path,
                    &remote_file,
                    cancel,
                    move |done| report_progress(&jobs_cl, &jid, start + done, &app_cl),
                )
                .await?;
                base_bytes += meta.len();
                mark_file_done(jobs, job_id);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_download_dir(
    jobs: &Arc<DashMap<String, TransferJobState>>,
    job_id: &str,
    handle: &Handle_,
    flavor: super::listing::Flavor,
    remote_root: &str,
    local_root: &Path,
    cancel: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), ScpError> {
    tokio::fs::create_dir_all(local_root)
        .await
        .map_err(|e| ScpError::LocalIoError(e.to_string()))?;

    let mut tree = exec::enumerate_tree(handle.clone(), flavor, remote_root).await?;
    // Create directories before files: shallower paths first.
    tree.sort_by_key(|e| (!e.is_dir, e.rel_path.matches('/').count()));

    let mut base_bytes: u64 = 0;
    for entry in tree {
        if cancel.is_cancelled() {
            return Err(ScpError::TransferCancelled);
        }
        let local_path = local_root.join(&entry.rel_path);
        if entry.is_dir {
            tokio::fs::create_dir_all(&local_path)
                .await
                .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
            continue;
        }
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScpError::LocalIoError(e.to_string()))?;
        }
        let remote_file = format!("{}/{}", remote_root.trim_end_matches('/'), entry.rel_path);
        let jobs_cl = jobs.clone();
        let app_cl = app_handle.clone();
        let jid = job_id.to_string();
        let start = base_bytes;
        transfer::download_file(
            handle.clone(),
            &remote_file,
            &local_path,
            cancel,
            move |done| report_progress(&jobs_cl, &jid, start + done, &app_cl),
        )
        .await?;
        base_bytes += entry.size;
        mark_file_done(jobs, job_id);
    }
    Ok(())
}

/// Join `base` with a relative path, yielding a remote-style `/`-separated
/// path. An empty `rel` returns `base` unchanged.
fn join_under(base: &str, rel: &Path) -> String {
    let rel_str = rel.to_string_lossy();
    if rel_str.is_empty() {
        base.to_string()
    } else {
        // Normalize Windows separators just in case (local paths on Windows).
        let rel_norm = rel_str.replace('\\', "/");
        format!("{}/{}", base.trim_end_matches('/'), rel_norm)
    }
}
