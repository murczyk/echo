use std::collections::HashSet;
use log::error;
use tokio::task::JoinSet;
use tokio::time::{sleep, Duration};

// Mock async functions to represent your actual logic
async fn list_datasource_ids() -> Vec<i64> {
    // In a real app, this would query a database/API
    sleep(Duration::from_secs(5)).await; // Poll every 5 seconds
    vec![1, 4, 88]
}

async fn run_datasource(datasource_id: i64) -> bool {
    println!("  [datasource {}] Starting...", datasource_id);
    // Simulate a long-running, self-healing task
    for i in 1..=3 {
        sleep(Duration::from_secs(2)).await;
        println!("  [Worker {}] Task {}/3 complete.", datasource_id, i);
    }

    // Simulate completion (true) or failure (false)
    let completed = datasource_id != 88; // 'B' will fail/restart for demonstration
    println!(
        "  [Worker {}] Assignment finished. Success: {}",
        datasource_id, completed
    );
    completed
}

// --- Main Runner Function ---

pub struct WorkerStatus {
    pub datasource_id: i64,
    pub failed: bool,
}

#[tokio::main]
async fn main() {
    let mut workers: JoinSet<WorkerStatus> = JoinSet::new();
    let poll_interval = Duration::from_secs(7);
    let mut running_ids = HashSet::new();

    loop {
        while let Some(Ok(res)) = workers.try_join_next() {
            if !res.failed {
                println!(
                    "✅ Worker for datasource {} was shut down: datasource disconnected.",
                    res.datasource_id
                );
            } else {
                running_ids.remove(&res.datasource_id);
            }
        }
        let datasource_ids = list_datasource_ids().await;
        for datasource_id in datasource_ids {
            if !running_ids.contains(&datasource_id) {
                println!(
                    "🚀 Spawning new worker for datasource {datasource_id}"
                );
                running_ids.insert(datasource_id);

                let worker_task = tokio::spawn(async move {
                    let completed = run_datasource(datasource_id.clone()).await;
                    if !completed {
                        error!(
                            "⚠️ Worker for datasource {datasource_id} failed! ",
                        );
                    }
                    WorkerStatus {
                        datasource_id,
                        failed: !completed,
                    }
                });
                workers.spawn(worker_task);
            }
        }

        sleep(poll_interval).await;
    }
}
