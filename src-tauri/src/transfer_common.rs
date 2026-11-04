use dashmap::DashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

// ─── Constants ───────────────────────────────────────────────────────────────

/// Minimum duration between consecutive progress events per transfer.
const EMIT_THROTTLE: Duration = Duration::from_millis(100);
/// Fix infinite history
const MAX_FINISHED_HISTORY: usize = 200;
/// Window over which bytes are accumulated to compute speed.
const SPEED_WINDOW: Duration = Duration::from_millis(500);

// ─── Helpers ───────────────────────────────────────────────────────────────

/// Access and modification times of a transfer's source, in whole seconds
/// since the Unix epoch — the resolution both SFTP v3 and the scp `T` record
/// carry. Copied onto the destination so a transfer keeps the original dates
/// instead of stamping the file with the time of the copy (#160).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileTimes {
    pub mtime: u64,
    pub atime: u64,
}

impl FileTimes {
    /// Times of a local file. `None` when the platform can't report the
    /// modification time or it predates the epoch; a missing access time
    /// falls back to the modification time.
    pub fn from_local(meta: &std::fs::Metadata) -> Option<Self> {
        let secs = |t: std::time::SystemTime| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        };
        let mtime = secs(meta.modified().ok()?)?;
        let atime = meta.accessed().ok().and_then(secs).unwrap_or(mtime);
        Some(Self { mtime, atime })
    }

    /// Stamp an open local file with these times. Call it after the last
    /// write: any later write moves the modification time again.
    pub fn apply_to(&self, file: &std::fs::File) -> std::io::Result<()> {
        let at = |s: u64| std::time::UNIX_EPOCH + Duration::from_secs(s);
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(at(self.mtime))
                .set_accessed(at(self.atime)),
        )
    }
}

pub fn eta_secs(speed_bps: u64, total_bytes: u64, bytes_transferred: u64) -> Option<u64> {
    if speed_bps > 0 && total_bytes > bytes_transferred {
        Some((total_bytes - bytes_transferred) / speed_bps)
    } else {
        None
    }
}

pub fn apply_concurrency(semaphore: &Semaphore, max_concurrent: &AtomicU32, n: u32) {
    let old = max_concurrent.swap(n, Ordering::SeqCst);
    let current = semaphore.available_permits() as u32;
    match n.cmp(&old) {
        std::cmp::Ordering::Greater => semaphore.add_permits((n - old) as usize),
        std::cmp::Ordering::Less => {
            let to_remove = (old - n).min(current);
            for _ in 0..to_remove {
                if let Ok(permit) = semaphore.try_acquire() {
                    permit.forget();
                }
            }
        }
        std::cmp::Ordering::Equal => {}
    }
}

pub trait ProgressFields {
    fn bytes_transferred(&mut self) -> &mut u64;
    fn speed_bps(&mut self) -> &mut u64;
    fn speed_window_bytes(&mut self) -> &mut u64;
    fn speed_window_start(&mut self) -> &mut Instant;
    fn last_emit(&mut self) -> &mut Instant;
}

pub fn record_progress<T: ProgressFields>(job: &mut T, new_bytes: u64) -> bool {
    const EMA_ALPHA: f64 = 0.3;

    *job.bytes_transferred() += new_bytes;
    *job.speed_window_bytes() += new_bytes;

    let window_elapsed = job.speed_window_start().elapsed();
    if window_elapsed >= SPEED_WINDOW {
        let secs = window_elapsed.as_secs_f64().max(0.001);
        let sample_bps = *job.speed_window_bytes() as f64 / secs;
        let prev_bps = *job.speed_bps() as f64;
        let smoothed = if prev_bps <= 0.0 {
            sample_bps
        } else {
            EMA_ALPHA * sample_bps + (1.0 - EMA_ALPHA) * prev_bps
        };
        *job.speed_bps() = smoothed.round() as u64;
        *job.speed_window_bytes() = 0;
        *job.speed_window_start() = Instant::now();
    } else if *job.speed_bps() == 0 && window_elapsed.as_millis() > 200 {
        let secs = window_elapsed.as_secs_f64().max(0.001);
        *job.speed_bps() = (*job.speed_window_bytes() as f64 / secs) as u64;
    }

    if job.last_emit().elapsed() >= EMIT_THROTTLE {
        *job.last_emit() = Instant::now();
        true
    } else {
        false
    }
}

pub trait FinishedStatus {
    fn is_terminal(&self) -> bool;
}

pub fn record_finished<T: FinishedStatus>(
    jobs: &DashMap<String, T>,
    finished_order: &Mutex<VecDeque<String>>,
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
        let still_terminal = jobs.get(&oldest).is_some_and(|job| job.is_terminal());
        if still_terminal {
            jobs.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eta_secs_matches_original_three_copies() {
        assert_eq!(eta_secs(0, 100, 10), None);
        assert_eq!(eta_secs(10, 100, 100), None);
        assert_eq!(eta_secs(10, 100, 50), Some(5));
    }

    struct FakeJob {
        bytes_transferred: u64,
        speed_bps: u64,
        speed_window_bytes: u64,
        speed_window_start: Instant,
        last_emit: Instant,
    }

    impl ProgressFields for FakeJob {
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

    #[test]
    fn record_progress_accumulates_bytes() {
        let mut job = FakeJob {
            bytes_transferred: 0,
            speed_bps: 0,
            speed_window_bytes: 0,
            speed_window_start: Instant::now(),
            last_emit: Instant::now() - Duration::from_secs(10),
        };
        let should_emit = record_progress(&mut job, 1024);
        assert_eq!(job.bytes_transferred, 1024);
        assert!(should_emit); // last_emit was far in the past
    }

    // ─── record_finished eviction ────────────────────────────────────────────

    struct FinishedJob {
        terminal: bool,
    }

    impl FinishedStatus for FinishedJob {
        fn is_terminal(&self) -> bool {
            self.terminal
        }
    }

    fn seed(
        jobs: &DashMap<String, FinishedJob>,
        order: &Mutex<VecDeque<String>>,
        count: usize,
        terminal: bool,
    ) {
        for i in 0..count {
            let id = format!("job-{i}");
            jobs.insert(id.clone(), FinishedJob { terminal });
            order.lock().unwrap().push_back(id);
        }
    }

    #[test]
    fn record_finished_evicts_oldest_terminal_jobs_past_the_cap() {
        let jobs = DashMap::new();
        let order = Mutex::new(VecDeque::new());
        seed(&jobs, &order, MAX_FINISHED_HISTORY, true);

        jobs.insert("newest".into(), FinishedJob { terminal: true });
        record_finished(&jobs, &order, "newest");

        let order = order.lock().unwrap();
        assert_eq!(order.len(), MAX_FINISHED_HISTORY);
        assert!(!jobs.contains_key("job-0"), "oldest terminal job evicted");
        assert!(jobs.contains_key("newest"));
        assert_eq!(order.back().map(String::as_str), Some("newest"));
    }

    #[test]
    fn record_finished_never_deletes_a_job_that_went_live_again() {
        let jobs = DashMap::new();
        let order = Mutex::new(VecDeque::new());
        seed(&jobs, &order, MAX_FINISHED_HISTORY, true);
        // job-0 is due for eviction but was retried back to a live state.
        jobs.get_mut("job-0").unwrap().terminal = false;

        jobs.insert("newest".into(), FinishedJob { terminal: true });
        record_finished(&jobs, &order, "newest");

        assert!(
            jobs.contains_key("job-0"),
            "non-terminal job must survive eviction (its order slot is still consumed)"
        );
    }

    #[test]
    fn record_finished_tolerates_order_ids_missing_from_the_map() {
        let jobs: DashMap<String, FinishedJob> = DashMap::new();
        let order = Mutex::new(VecDeque::new());
        // Order references jobs that were already removed externally.
        for i in 0..(MAX_FINISHED_HISTORY + 5) {
            order.lock().unwrap().push_back(format!("gone-{i}"));
        }

        jobs.insert("newest".into(), FinishedJob { terminal: true });
        record_finished(&jobs, &order, "newest");

        assert_eq!(order.lock().unwrap().len(), MAX_FINISHED_HISTORY);
        assert!(jobs.contains_key("newest"));
    }

    /// Deadlock watchdog: `record_finished` re-enters the map (get + remove of
    /// evicted ids), so it must never itself hold a guard across that access,
    /// and callers must drop theirs first (see set_job_status). Two shards is
    /// dashmap's minimum; a same-key re-entrant guard deadlocks regardless of
    /// shard count, and the watchdog turns that hang into a test failure.
    #[test]
    fn record_finished_mass_eviction_completes_on_a_minimal_shard_map() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let jobs: DashMap<String, FinishedJob> =
                DashMap::with_capacity_and_hasher_and_shard_amount(
                    512,
                    std::collections::hash_map::RandomState::new(),
                    2,
                );
            let order = Mutex::new(VecDeque::new());
            seed(&jobs, &order, MAX_FINISHED_HISTORY + 100, true);

            jobs.insert("newest".into(), FinishedJob { terminal: true });
            record_finished(&jobs, &order, "newest");
            let _ = tx.send(order.lock().unwrap().len());
        });

        let len = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("record_finished deadlocked on same-shard eviction");
        assert_eq!(len, MAX_FINISHED_HISTORY);
    }

    #[test]
    fn file_times_round_trip_through_a_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, b"x").unwrap();

        // 2001-09-09T01:46:40Z / 2020-09-13T12:26:40Z — clearly not "now".
        let want = FileTimes {
            mtime: 1_000_000_000,
            atime: 1_600_000_000,
        };
        let f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        want.apply_to(&f).unwrap();
        drop(f);

        let got = FileTimes::from_local(&std::fs::metadata(&path).unwrap()).unwrap();
        assert_eq!(got.mtime, want.mtime);
        assert_eq!(got.atime, want.atime);
    }
}
