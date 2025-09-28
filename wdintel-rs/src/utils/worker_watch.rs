use log::{info, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct LoopGuard {
    name: &'static str,
    started_at: Instant,
}

impl LoopGuard {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            started_at: Instant::now(),
        }
    }
}

impl Drop for LoopGuard {
    fn drop(&mut self) {
        let elapsed = self.started_at.elapsed();
        record_iteration(self.name, elapsed);
    }
}

#[derive(Debug, Clone)]
pub struct WorkerSnapshot {
    pub name: &'static str,
    pub iterations: u64,
    pub total_elapsed: Duration,
    pub last_elapsed: Duration,
    pub consecutive_fast: u64,
}

#[derive(Debug)]
struct WorkerState {
    iterations: u64,
    total_elapsed: Duration,
    last_elapsed: Duration,
    consecutive_fast: u64,
    last_warn: Instant,
}

static WORKERS: Lazy<Mutex<HashMap<&'static str, WorkerState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const FAST_ITERATION_THRESHOLD: Duration = Duration::from_millis(200);
const FAST_ITERATION_WARN_LIMIT: u64 = 200;
const WARN_COOLDOWN: Duration = Duration::from_secs(60);

pub fn loop_guard(name: &'static str) -> LoopGuard {
    LoopGuard::new(name)
}

fn record_iteration(name: &'static str, elapsed: Duration) {
    let mut workers = WORKERS.lock().expect("worker metrics mutex poisoned");
    let state = workers.entry(name).or_insert_with(|| WorkerState {
        iterations: 0,
        total_elapsed: Duration::ZERO,
        last_elapsed: Duration::ZERO,
        consecutive_fast: 0,
        last_warn: Instant::now() - WARN_COOLDOWN,
    });

    state.iterations += 1;
    state.total_elapsed += elapsed;
    state.last_elapsed = elapsed;

    if elapsed < FAST_ITERATION_THRESHOLD {
        state.consecutive_fast += 1;
        if state.consecutive_fast >= FAST_ITERATION_WARN_LIMIT
            && state.last_warn.elapsed() >= WARN_COOLDOWN
        {
            warn!(
                "worker_busy_loop_detected name={name} iterations={} avg_ms={:.2} last_ms={:.2}",
                state.iterations,
                state
                    .total_elapsed
                    .as_secs_f64()
                    / state.iterations as f64
                    * 1000.0,
                elapsed.as_secs_f64() * 1000.0
            );
            state.last_warn = Instant::now();
        }
    } else {
        state.consecutive_fast = 0;
    }
}

pub fn snapshot() -> Vec<WorkerSnapshot> {
    let workers = WORKERS.lock().expect("worker metrics mutex poisoned");
    workers
        .iter()
        .map(|(name, state)| WorkerSnapshot {
            name,
            iterations: state.iterations,
            total_elapsed: state.total_elapsed,
            last_elapsed: state.last_elapsed,
            consecutive_fast: state.consecutive_fast,
        })
        .collect()
}

pub fn spawn_metrics_logger() {
    spawn_named_worker("worker_metrics_logger", async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            log_snapshot();
        }
    });
}

fn log_snapshot() {
    let snapshots = snapshot();
    if snapshots.is_empty() {
        return;
    }
    for snapshot in snapshots {
        let avg_ms = if snapshot.iterations > 0 {
            snapshot.total_elapsed.as_secs_f64() / snapshot.iterations as f64
                * 1000.0
        } else {
            0.0
        };
        info!(
            target: "worker_metrics",
            "worker={} iterations={} avg_ms={avg_ms:.2} last_ms={:.2} fast_in_row={}",
            snapshot.name,
            snapshot.iterations,
            snapshot.last_elapsed.as_secs_f64() * 1000.0,
            snapshot.consecutive_fast,
        );
    }
}

pub fn spawn_named_worker<F>(name: &'static str, fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        info!(target: "worker", "starting {name}");
        fut.await;
        info!(target: "worker", "finished {name}");
    });
}
