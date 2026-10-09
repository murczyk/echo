use super::*;
use std::sync::{Mutex, Weak};

#[derive(Hash, PartialEq, Eq)]
struct CountRequestKey {
    pool_identity: usize,
    login: uuid::Uuid,
    request: String,
}

static COUNT_FALLBACK_QUEUES: once_cell::sync::Lazy<
    Mutex<HashMap<CountRequestKey, Weak<tokio::sync::Mutex<()>>>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn fallback_queue(key: CountRequestKey) -> Arc<tokio::sync::Mutex<()>> {
    let mut queues = COUNT_FALLBACK_QUEUES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    queues.retain(|_, queue| queue.strong_count() > 0);
    if let Some(queue) = queues.get(&key).and_then(Weak::upgrade) {
        return queue;
    }
    let queue = Arc::new(tokio::sync::Mutex::new(()));
    if queues.len() < ANALYTICS_COUNT_FALLBACK_QUEUE_MAX_ENTRIES {
        queues.insert(key, Arc::downgrade(&queue));
    }
    queue
}

pub(super) async fn read_with_fallback<T, A, AFut, P, PFut>(
    env: &Env,
    login: uuid::Uuid,
    req: &AnalysisStatsReq,
    operation: &str,
    analytics_query: A,
    postgres_query: P,
) -> anyhow::Result<T>
where
    A: FnOnce(DatabaseConnection) -> AFut,
    AFut: std::future::Future<Output = Result<T, AppError>>,
    P: FnOnce(DatabaseConnection) -> PFut,
    PFut: std::future::Future<Output = Result<T, AppError>>,
{
    let queue = fallback_queue(CountRequestKey {
        pool_identity: postgres_pool_identity(&env.dbx),
        login,
        request: serde_json::to_string(req).c(h!())?,
    });
    Ok(with_analytics_read_fallback_inner(
        env,
        operation,
        analytics_count_request_supported(req),
        true,
        Some(queue),
        analytics_query,
        postgres_query,
    )
    .await
    .context(h!())?
    .value)
}
