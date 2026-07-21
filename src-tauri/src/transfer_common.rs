use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

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

pub fn record_progress<T: ProgressFields>(
    job: &mut T,
    new_bytes: u64,
    emit_throttle: Duration,
    speed_window: Duration,
) -> bool {
    const EMA_ALPHA: f64 = 0.3;

    *job.bytes_transferred() += new_bytes;
    *job.speed_window_bytes() += new_bytes;

    let window_elapsed = job.speed_window_start().elapsed();
    if window_elapsed >= speed_window {
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

    if job.last_emit().elapsed() >= emit_throttle {
        *job.last_emit() = Instant::now();
        true
    } else {
        false
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
        let should_emit = record_progress(
            &mut job,
            1024,
            Duration::from_millis(100),
            Duration::from_secs(2),
        );
        assert_eq!(job.bytes_transferred, 1024);
        assert!(should_emit); // last_emit was far in the past
    }
}
