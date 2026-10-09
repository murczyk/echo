use super::types::*;
use super::*;
use crate::file_registry::entities::device_audio;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tokio::sync::{watch, Mutex, Notify, OwnedSemaphorePermit};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;

pub(super) const REPRESENTATIONS: [DeviceAudioRepresentation; 3] = [
    DeviceAudioRepresentation::Content,
    DeviceAudioRepresentation::Wave,
    DeviceAudioRepresentation::Spectrogram,
];

type State = DeviceAudioPreparationState;

pub(super) struct Preparation {
    jobs: Mutex<HashMap<Uuid, Arc<Job>>>,
    background: Arc<Semaphore>,
    interactive: Arc<Semaphore>,
    background_queue: Arc<Semaphore>,
    interactive_queue: Arc<Semaphore>,
    max_jobs: usize,
    pub waiting: Arc<Semaphore>,
    pub tasks: TaskTracker,
    pub cancellation: CancellationToken,
}

pub(super) struct Job {
    interactive: AtomicBool,
    promoted: Notify,
    states: watch::Sender<[State; 3]>,
    finished: std::sync::Mutex<Option<Instant>>,
}

impl Job {
    pub fn started(&self, representation: DeviceAudioRepresentation) {
        let index = REPRESENTATIONS
            .iter()
            .position(|item| *item == representation)
            .unwrap();
        self.states
            .send_modify(|states| states[index] = State::Preparing);
    }
}

struct Completion(Arc<Job>);

impl Drop for Completion {
    fn drop(&mut self) {
        self.0.states.send_modify(|states| {
            for state in states {
                if matches!(state, State::Queued | State::Preparing) {
                    *state = State::Failed;
                }
            }
        });
        *self
            .0
            .finished
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(Instant::now());
    }
}

impl Preparation {
    pub fn new() -> Self {
        let capacity = DEVICE_AUDIO_PREPARATION_QUEUE_SIZE;
        Self {
            jobs: Mutex::new(HashMap::new()),
            background: Arc::new(Semaphore::new(
                DEVICE_AUDIO_BACKGROUND_CONCURRENCY,
            )),
            interactive: Arc::new(Semaphore::new(
                DEVICE_AUDIO_INTERACTIVE_CONCURRENCY,
            )),
            background_queue: Arc::new(Semaphore::new(capacity)),
            interactive_queue: Arc::new(Semaphore::new(capacity)),
            max_jobs: capacity * 2,
            waiting: Arc::new(Semaphore::new(capacity)),
            tasks: TaskTracker::new(),
            cancellation: CancellationToken::new(),
        }
    }

    pub async fn admit(
        &self,
        job: Option<&Job>,
    ) -> anyhow::Result<OwnedSemaphorePermit> {
        loop {
            let promoted = async {
                match job {
                    Some(job) => job.promoted.notified().await,
                    None => std::future::pending().await,
                }
            };
            let interactive =
                job.is_none_or(|job| job.interactive.load(Ordering::Acquire));
            let pool = if interactive {
                &self.interactive
            } else {
                &self.background
            };
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(unavailable("audio preparation is stopping")).c(h!()),
                permit = pool.clone().acquire_owned() => return permit.c(h!()),
                _ = promoted, if !interactive => {},
            }
        }
    }

    pub async fn shutdown(&self) {
        self.cancellation.cancel();
        let jobs = self.jobs.lock().await;
        self.tasks.close();
        drop(jobs);
        self.tasks.wait().await;
    }
}

fn expired(job: &Job) -> bool {
    job.finished
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .is_some_and(|finished| {
            finished.elapsed().as_secs() >= DEVICE_AUDIO_PREPARATION_RETRY_SECS
        })
}

async fn enqueue(
    runtime: Arc<DeviceAudioRuntime>,
    device_id: Uuid,
    audio_id: Uuid,
    interactive: bool,
    retry: bool,
) -> anyhow::Result<Option<Arc<Job>>> {
    let preparation = &runtime.preparation;
    let mut jobs = preparation.jobs.lock().await;
    jobs.retain(|id, job| {
        !expired(job)
            && !(*id == audio_id
                && (retry
                    || job
                        .states
                        .borrow()
                        .iter()
                        .all(|state| *state == State::Ready))
                && job
                    .finished
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some())
    });
    if let Some(job) = jobs.get(&audio_id) {
        if interactive && !job.interactive.swap(true, Ordering::AcqRel) {
            job.promoted.notify_one();
        }
        return Ok(Some(job.clone()));
    }
    if preparation.cancellation.is_cancelled() {
        return Err(unavailable("audio preparation is stopping")).c(h!());
    }
    let queue = if interactive {
        &preparation.interactive_queue
    } else {
        &preparation.background_queue
    };
    let Ok(queued) = queue.clone().try_acquire_owned() else {
        if let Some(metrics) = &runtime.metrics {
            metrics.record_device_audio_preparation("queue_full", 0.0);
        }
        return Ok(None);
    };
    retire_completed(&mut jobs, preparation.max_jobs);
    let (states, _) = watch::channel([State::Queued; 3]);
    let job = Arc::new(Job {
        interactive: AtomicBool::new(interactive),
        promoted: Notify::new(),
        states,
        finished: std::sync::Mutex::new(None),
    });
    jobs.insert(audio_id, job.clone());
    let owned_job = job.clone();
    let owned_runtime = runtime.clone();
    preparation.tasks.spawn(async move {
        let _queued = queued;
        let _completion = Completion(owned_job.clone());
        run_job(owned_runtime, device_id, audio_id, &owned_job).await;
    });
    Ok(Some(job))
}

fn retire_completed(jobs: &mut HashMap<Uuid, Arc<Job>>, capacity: usize) {
    while jobs.len() >= capacity {
        let oldest = jobs
            .iter()
            .filter_map(|(id, job)| {
                job.finished
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .map(|finished| (*id, finished))
            })
            .min_by_key(|(_, finished)| *finished);
        let Some((id, _)) = oldest else {
            break;
        };
        jobs.remove(&id);
    }
}

async fn run_job(
    runtime: Arc<DeviceAudioRuntime>,
    device_id: Uuid,
    audio_id: Uuid,
    job: &Arc<Job>,
) {
    let started = Instant::now();
    for (index, representation) in REPRESENTATIONS.into_iter().enumerate() {
        if runtime.preparation.cancellation.is_cancelled() {
            break;
        }
        let command = OpenDeviceAudioCommand {
            device_id,
            audio_id,
            representation,
            method: DeviceAudioMethod::Get,
            range: None,
        };
        let result = content::prepare_representation(
            runtime.clone(),
            None,
            &command,
            content::ContentHooks::default(),
            Some(job.clone()),
        )
        .await;
        match result {
            Ok(_) => {
                job.states
                    .send_modify(|states| states[index] = State::Ready);
            }
            Err(error) => {
                job.states
                    .send_modify(|states| states[index] = State::Failed);
                log::warn!("device audio preparation failed: audio_id={audio_id}, representation={representation:?}, error={error:#}");
                if index == 0 {
                    job.states.send_replace([State::Failed; 3]);
                    break;
                }
            }
        }
    }
    if let Some(metrics) = &runtime.metrics {
        let outcome = if runtime.preparation.cancellation.is_cancelled() {
            "cancelled"
        } else if job
            .states
            .borrow()
            .iter()
            .all(|state| *state == State::Ready)
        {
            "ready"
        } else {
            "failed"
        };
        metrics.record_device_audio_preparation(
            outcome,
            started.elapsed().as_secs_f64(),
        );
    }
    log::info!("device audio preparation completed: audio_id={audio_id}, elapsed_ms={}, interactive={}, states={:?}",
        started.elapsed().as_millis(), job.interactive.load(Ordering::Acquire), *job.states.borrow());
}

pub(super) async fn prepare(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    device_id: Uuid,
    audio_id: Uuid,
    retry: bool,
) -> anyhow::Result<DeviceAudioPreparation> {
    authorize_read(&runtime, actor, device_id).await.c(h!())?;
    content::validate_source(&runtime, device_id, audio_id)
        .await
        .c(h!())?;
    let ready = content::readiness(&runtime, audio_id).await.c(h!())?;
    let job = if ready.iter().all(|ready| *ready) {
        None
    } else {
        enqueue(runtime.clone(), device_id, audio_id, true, retry)
            .await
            .c(h!())?
    };
    let mut states = job
        .as_ref()
        .map_or([State::Queued; 3], |job| *job.states.borrow());
    for index in 0..3 {
        if ready[index] {
            states[index] = State::Ready;
        } else if states[index] == State::Ready {
            states[index] = State::Queued;
        }
    }
    authorize_read(&runtime, actor, device_id).await.c(h!())?;
    Ok(DeviceAudioPreparation {
        content: states[0],
        wave: states[1],
        spectrogram: states[2],
        retry_after_ms: DEVICE_AUDIO_PREPARATION_POLL_MS,
    })
}

pub(super) async fn accepted(
    runtime: Arc<DeviceAudioRuntime>,
    attempt: &crate::file_registry::entities::device_audio_ingest::Model,
    source: &std::path::Path,
) {
    if let Err(error) =
        content::stage_original(&runtime, attempt.audio_id, source).await
    {
        log::warn!(
            "device audio local staging failed: audio_id={}, error={error:#}",
            attempt.audio_id
        );
    }
    if let Err(error) =
        enqueue(runtime, attempt.device_id, attempt.audio_id, false, false)
            .await
    {
        log::warn!("device audio preparation enqueue failed: audio_id={}, error={error:#}", attempt.audio_id);
    }
}

pub(super) async fn ensure_space(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    let path = runtime.storage_dir.clone();
    tokio::fs::create_dir_all(&path).await.c(h!())?;
    let available =
        tokio::task::spawn_blocking(move || fs2::available_space(path))
            .await
            .c(h!())?
            .c(h!())?;
    anyhow::ensure!(
        available
            >= DEVICE_AUDIO_PREPARATION_MIN_FREE_BYTES
                .saturating_add(DEVICE_AUDIO_MAX_BYTES),
        "insufficient free space for audio preparation"
    );
    Ok(())
}

pub(crate) async fn run(
    runtime: Arc<DeviceAudioRuntime>,
    cancellation: CancellationToken,
) {
    if runtime.files.is_none() || runtime.storage.is_none() {
        log::warn!("device audio background preparation is unavailable: file registry or byte storage is not configured");
        return;
    }
    let mut cursor = None;
    loop {
        if cancellation.is_cancelled() {
            break;
        }
        tokio::select! {
            _ = cancellation.cancelled() => break,
            result = recover(&runtime, &mut cursor) => {
                if let Err(error) = result { log::warn!("device audio preparation recovery failed: {error:#}"); }
            }
        }
        if let Err(error) = content::cleanup_cache(&runtime).await {
            log::warn!("device audio cache cleanup failed: {error:#}");
        }
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(DEVICE_AUDIO_PREPARATION_SCAN_SECS)) => {},
        }
    }
    runtime.preparation.shutdown().await;
}

type RecoveryCursor = (chrono::DateTime<chrono::FixedOffset>, Uuid);

pub(super) async fn recover(
    runtime: &Arc<DeviceAudioRuntime>,
    cursor: &mut Option<RecoveryCursor>,
) -> anyhow::Result<()> {
    ensure_space(runtime).await.c(h!())?;
    let since = chrono::Utc::now()
        - chrono::Duration::from_std(DEVICE_AUDIO_CACHE_TTL).c(h!())?;
    let mut query = device_audio::Entity::find()
        .select_only()
        .columns([
            device_audio::Column::Id,
            device_audio::Column::DeviceId,
            device_audio::Column::CreatedAt,
        ])
        .filter(device_audio::Column::CreatedAt.gte(since.fixed_offset()));
    if let Some((created_at, id)) = *cursor {
        query = query.filter(sea_orm::sea_query::Expr::cust_with_values(
            "(created_at, id) > ($1, $2)",
            [sea_orm::Value::from(created_at), sea_orm::Value::from(id)],
        ));
    }
    let rows = query
        .order_by_asc(device_audio::Column::CreatedAt)
        .order_by_asc(device_audio::Column::Id)
        .limit(DEVICE_AUDIO_PREPARATION_BATCH)
        .into_tuple::<(Uuid, Uuid, chrono::DateTime<chrono::FixedOffset>)>()
        .all(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    if rows.is_empty() {
        *cursor = None;
        return Ok(());
    }
    for (audio_id, device_id, created_at) in rows {
        if !content::readiness(runtime, audio_id)
            .await
            .c(h!())?
            .iter()
            .all(|ready| *ready)
            && enqueue(runtime.clone(), device_id, audio_id, false, false)
                .await
                .c(h!())?
                .is_none()
        {
            return Ok(());
        }
        *cursor = Some((created_at, audio_id));
    }
    Ok(())
}
