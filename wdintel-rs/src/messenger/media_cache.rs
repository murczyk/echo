use crate::config::{
    Config, MESSENGER_MEDIA_CACHE_BUSY_RETRY_AFTER_SECS,
    MESSENGER_MEDIA_CACHE_CLEANUP_INTERVAL_SECS,
    MESSENGER_MEDIA_CACHE_DIR_MODE, MESSENGER_MEDIA_CACHE_DIR_NAME,
    MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS,
    MESSENGER_MEDIA_CACHE_FAILURE_TTL_SECS, MESSENGER_MEDIA_CACHE_FILE_MODE,
    MESSENGER_MEDIA_CACHE_MAX_CONCURRENT_POPULATIONS,
    MESSENGER_MEDIA_CACHE_MAX_TOTAL_SIZE_BYTES,
    MESSENGER_MEDIA_CACHE_MAX_TRACKED_FAILURES,
    MESSENGER_MEDIA_CACHE_MIN_FILE_SIZE_BYTES,
    MESSENGER_MEDIA_CACHE_RETRYABLE_FAILURE_TTL_SECS,
    MESSENGER_MEDIA_CACHE_TEMP_TTL_SECS, MESSENGER_MEDIA_CACHE_TTL_SECS,
};
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::storage;
use crate::types::{error, info, warn, Env, ShortContext};
use once_cell::sync::Lazy;
use opendal::Operator;
use std::collections::HashMap;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

static MEDIA_CACHE_POPULATIONS: Lazy<
    Mutex<HashMap<PathBuf, Arc<PopulationFlight>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
static MEDIA_CACHE_FAILURES: Lazy<
    Mutex<HashMap<PathBuf, CachedPopulationFailure>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
static MEDIA_CACHE_POPULATION_SEMAPHORE: Lazy<Arc<Semaphore>> =
    Lazy::new(|| {
        Arc::new(Semaphore::new(
            MESSENGER_MEDIA_CACHE_MAX_CONCURRENT_POPULATIONS,
        ))
    });

#[derive(Clone, Debug)]
enum PopulationState {
    Running,
    Ready,
    Failed,
}

#[derive(Clone, Debug)]
struct PopulationFailure {
    msg: String,
    log_msg: String,
    retryable: bool,
}

struct CachedPopulationFailure {
    failure: PopulationFailure,
    expires_at: Instant,
}

impl PopulationFailure {
    fn into_app_error(self) -> AppError {
        if self.retryable {
            AppError::ServiceUnavailable {
                msg: self.msg,
                retry_after_secs: MESSENGER_MEDIA_CACHE_BUSY_RETRY_AFTER_SECS,
            }
        } else {
            AppError::BL { msg: self.msg }
        }
    }
}

impl From<AppError> for PopulationFailure {
    fn from(error: AppError) -> Self {
        match error {
            AppError::ServiceUnavailable { msg, .. } => Self {
                log_msg: msg.clone(),
                msg,
                retryable: true,
            },
            AppError::BL { msg } => Self {
                log_msg: msg.clone(),
                msg,
                retryable: false,
            },
            error => Self {
                msg: "temporary messenger media cache failure; retry later"
                    .to_string(),
                log_msg: format!("{error:#?}"),
                retryable: true,
            },
        }
    }
}

impl From<String> for PopulationFailure {
    fn from(msg: String) -> Self {
        Self {
            log_msg: msg.clone(),
            msg,
            retryable: false,
        }
    }
}

struct PopulationFlight {
    state: watch::Sender<PopulationState>,
    cancelled: AtomicBool,
}

impl PopulationFlight {
    fn new() -> Self {
        let (state, _) = watch::channel(PopulationState::Running);
        Self {
            state,
            cancelled: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    async fn wait(&self) -> Result<(), AppError> {
        let mut state = self.state.subscribe();
        loop {
            let current = state.borrow().clone();
            match current {
                PopulationState::Running => {
                    state.changed().await.c(crate::h!())?
                }
                PopulationState::Ready => return Ok(()),
                PopulationState::Failed => {
                    return Err(AppError::BL {
                        msg: "media cache population failed".to_string(),
                    });
                }
            }
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.state.send_replace(PopulationState::Failed);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct PopulationGuard {
    cache_path: PathBuf,
    flight: Arc<PopulationFlight>,
    completed: bool,
}

impl PopulationGuard {
    fn new(cache_path: PathBuf, flight: Arc<PopulationFlight>) -> Self {
        Self {
            cache_path,
            flight,
            completed: false,
        }
    }

    fn complete(mut self, result: Result<(), PopulationFailure>) {
        let state = if self.flight.is_cancelled() {
            PopulationState::Failed
        } else {
            match result {
                Ok(()) => PopulationState::Ready,
                Err(_) => PopulationState::Failed,
            }
        };
        self.flight.state.send_replace(state);
        remove_population(&self.cache_path, &self.flight);
        self.completed = true;
    }
}

impl Drop for PopulationGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.flight.state.send_replace(PopulationState::Failed);
        remove_population(&self.cache_path, &self.flight);
    }
}

struct CacheSource {
    s3: Option<Operator>,
    s3_config: Option<storage::S3Config>,
    strongbox_key: String,
    object_key: String,
}

struct TemporaryCacheFile {
    path: PathBuf,
    published: bool,
}

struct CacheSizeEntry {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

impl TemporaryCacheFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    #[cfg(test)]
    async fn publish(mut self, cache_path: &Path) -> Result<(), AppError> {
        fs::rename(&self.path, cache_path).await.c(h!())?;
        self.published = true;
        Ok(())
    }

    async fn publish_for_population(
        mut self,
        cache_path: &Path,
        flight: &Arc<PopulationFlight>,
    ) -> Result<(), AppError> {
        let temp_path = self.path.clone();
        let cache_path = cache_path.to_path_buf();
        let flight = flight.clone();
        tokio::task::spawn_blocking(move || {
            let populations = lock_populations();
            let is_current = !flight.is_cancelled()
                && populations
                    .get(&cache_path)
                    .is_some_and(|current| Arc::ptr_eq(current, &flight));
            if !is_current {
                return Err(AppError::BL {
                    msg: "media cache population was cancelled before publish"
                        .to_string(),
                });
            }
            std::fs::rename(temp_path, cache_path).map_err(AppError::from)
        })
        .await
        .c(h!())??;
        self.published = true;
        Ok(())
    }
}

impl Drop for TemporaryCacheFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn should_cache_media(size_bytes: i64) -> bool {
    size_bytes > MESSENGER_MEDIA_CACHE_MIN_FILE_SIZE_BYTES
}

pub fn media_cache_dir(config: &Config) -> PathBuf {
    PathBuf::from(&config.storage_dir).join(MESSENGER_MEDIA_CACHE_DIR_NAME)
}

pub fn media_cache_path(config: &Config, media_id: Uuid) -> PathBuf {
    media_cache_dir(config).join(media_id.to_string())
}

pub async fn cached_media_path_if_ready(
    config: &Config,
    media_id: Uuid,
    expected_size: i64,
) -> Result<Option<PathBuf>, AppError> {
    let expected_size = u64::try_from(expected_size).c(h!())?;
    let cache_path = media_cache_path(config, media_id);
    if cached_file_is_valid(&cache_path, expected_size).await? {
        Ok(Some(cache_path))
    } else {
        Ok(None)
    }
}

pub async fn ensure_media_cached(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<PathBuf, AppError> {
    ensure_media_cached_with_behavior(env, media, CachePopulationBehavior::Wait)
        .await
}

pub async fn poll_media_cache(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<PathBuf, AppError> {
    ensure_media_cached_with_behavior(env, media, CachePopulationBehavior::Poll)
        .await
}

#[derive(Clone, Copy)]
enum CachePopulationBehavior {
    Wait,
    Poll,
}

async fn ensure_media_cached_with_behavior(
    env: &Env,
    media: &signal_message_media::Model,
    behavior: CachePopulationBehavior,
) -> Result<PathBuf, AppError> {
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    let cache_path = media_cache_path(&env.config, media.id);
    ensure_cache_dir(cache_path.parent().c(h!())?).await?;
    if cached_file_is_valid(&cache_path, expected_size).await? {
        touch_cache_file(&cache_path).await;
        return Ok(cache_path);
    }
    if let Some(failure) = recent_population_failure(&cache_path) {
        return Err(failure.into_app_error());
    }

    let source = cache_source(env, media)?;
    let population_path = cache_path.clone();
    populate_singleflight(
        cache_path.clone(),
        behavior,
        move |flight| async move {
            populate_cache_file(
                source,
                &population_path,
                expected_size,
                &flight,
            )
            .await
        },
    )
    .await?;

    if !cached_file_is_valid(&cache_path, expected_size).await? {
        return Err(AppError::BL {
            msg: format!(
                "media cache population produced an invalid file for {}",
                media.id
            ),
        });
    }
    touch_cache_file(&cache_path).await;
    Ok(cache_path)
}

fn cache_source(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<CacheSource, AppError> {
    let config = env.config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    Ok(CacheSource {
        s3: env.s3.clone(),
        s3_config: env.s3_config.clone(),
        strongbox_key: config.strongbox_key.clone(),
        object_key: crate::messenger::media::media_object_key(media),
    })
}

async fn populate_cache_file(
    source: CacheSource,
    cache_path: &Path,
    expected_size: u64,
    flight: &Arc<PopulationFlight>,
) -> Result<(), AppError> {
    if cached_file_is_valid(cache_path, expected_size).await? {
        return Ok(());
    }
    remove_invalid_cache_entry(cache_path).await?;
    info!(
        "populating decrypted media cache file={} expected_size={expected_size}",
        cache_path.display()
    );
    let data = storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout(
        &source.s3,
        &source.s3_config,
        &source.strongbox_key,
        &source.object_key,
        Duration::from_secs(MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS),
    )
    .await?;
    let actual_size = data.len() as u64;
    if actual_size != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "decrypted media size mismatch: expected {expected_size}, got {actual_size}"
            ),
        });
    }
    publish_cache_bytes_for_population(cache_path, &data, flight).await?;
    drop(data);
    if let Some(cache_dir) = cache_path.parent() {
        if let Err(err) = enforce_cache_size_limit(
            cache_dir,
            MESSENGER_MEDIA_CACHE_MAX_TOTAL_SIZE_BYTES,
        )
        .await
        {
            warn!("failed to enforce messenger media cache size: {err:#?}");
        }
    }
    info!(
        "populated decrypted media cache file={} size={actual_size}",
        cache_path.display()
    );
    Ok(())
}

async fn populate_singleflight<F, Fut, E>(
    cache_path: PathBuf,
    behavior: CachePopulationBehavior,
    populate: F,
) -> Result<(), AppError>
where
    F: FnOnce(Arc<PopulationFlight>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), E>> + Send + 'static,
    E: Into<PopulationFailure> + Send + 'static,
{
    let Some((flight, permit)) = population_for_path(&cache_path, behavior)
        .await
        .map_err(PopulationFailure::into_app_error)?
    else {
        return Err(cache_population_pending_error());
    };
    if let Some(permit) = permit {
        drop(spawn_population_task(
            cache_path.clone(),
            flight.clone(),
            permit,
            populate(flight.clone()),
        ));
    }
    match behavior {
        CachePopulationBehavior::Poll => Err(cache_population_pending_error()),
        CachePopulationBehavior::Wait => {
            wait_for_population(&cache_path, &flight).await
        }
    }
}

async fn wait_for_population(
    cache_path: &Path,
    flight: &PopulationFlight,
) -> Result<(), AppError> {
    let mut state = flight.state.subscribe();
    loop {
        let current = state.borrow().clone();
        match current {
            PopulationState::Running => state.changed().await.c(h!())?,
            PopulationState::Ready => return Ok(()),
            PopulationState::Failed => {
                return Err(recent_population_failure(cache_path)
                    .map(PopulationFailure::into_app_error)
                    .unwrap_or_else(cache_population_pending_error));
            }
        }
    }
}

fn cache_population_pending_error() -> AppError {
    AppError::ServiceUnavailable {
        msg: "messenger media cache population is in progress; retry later"
            .to_string(),
        retry_after_secs: MESSENGER_MEDIA_CACHE_BUSY_RETRY_AFTER_SECS,
    }
}

fn spawn_population_task<Fut, E>(
    cache_path: PathBuf,
    flight: Arc<PopulationFlight>,
    permit: OwnedSemaphorePermit,
    populate: Fut,
) -> JoinHandle<()>
where
    Fut: Future<Output = Result<(), E>> + Send + 'static,
    E: Into<PopulationFailure> + Send + 'static,
{
    let failure_path = cache_path.clone();
    let guard = PopulationGuard::new(cache_path, flight);
    tokio::spawn(async move {
        let result = populate.await.map_err(Into::into);
        if guard.flight.is_cancelled() {
            clear_population_failure(&failure_path);
        } else {
            match &result {
                Ok(()) => clear_population_failure(&failure_path),
                Err(failure) => {
                    warn!(
                        "messenger media cache population failed: {}",
                        failure.log_msg
                    );
                    record_population_failure(
                        failure_path.clone(),
                        failure.clone(),
                    );
                }
            }
        }
        drop(permit);
        guard.complete(result);
    })
}

async fn population_for_path(
    cache_path: &Path,
    behavior: CachePopulationBehavior,
) -> Result<
    Option<(Arc<PopulationFlight>, Option<OwnedSemaphorePermit>)>,
    PopulationFailure,
> {
    match behavior {
        CachePopulationBehavior::Poll => {
            Ok(population_for_path_with_semaphore(
                cache_path,
                &MEDIA_CACHE_POPULATION_SEMAPHORE,
            ))
        }
        CachePopulationBehavior::Wait => {
            population_for_path_and_wait_for_permit(
                cache_path,
                &MEDIA_CACHE_POPULATION_SEMAPHORE,
            )
            .await
        }
    }
}

async fn population_for_path_and_wait_for_permit(
    cache_path: &Path,
    semaphore: &Arc<Semaphore>,
) -> Result<
    Option<(Arc<PopulationFlight>, Option<OwnedSemaphorePermit>)>,
    PopulationFailure,
> {
    if let Some(flight) = lock_populations().get(cache_path).cloned() {
        return Ok(Some((flight, None)));
    }
    let Some(permit) = semaphore.clone().acquire_owned().await.ok() else {
        return Ok(None);
    };
    if let Some(flight) = lock_populations().get(cache_path).cloned() {
        return Ok(Some((flight, None)));
    }
    if let Some(failure) = recent_population_failure(cache_path) {
        return Err(failure);
    }
    let mut populations = lock_populations();
    if let Some(flight) = populations.get(cache_path) {
        return Ok(Some((flight.clone(), None)));
    }
    let flight = Arc::new(PopulationFlight::new());
    populations.insert(cache_path.to_path_buf(), flight.clone());
    Ok(Some((flight, Some(permit))))
}

fn population_for_path_with_semaphore(
    cache_path: &Path,
    semaphore: &Arc<Semaphore>,
) -> Option<(Arc<PopulationFlight>, Option<OwnedSemaphorePermit>)> {
    let mut populations = lock_populations();
    if let Some(flight) = populations.get(cache_path) {
        return Some((flight.clone(), None));
    }
    let permit = semaphore.clone().try_acquire_owned().ok()?;
    let flight = Arc::new(PopulationFlight::new());
    populations.insert(cache_path.to_path_buf(), flight.clone());
    Some((flight, Some(permit)))
}

fn remove_population(cache_path: &Path, flight: &Arc<PopulationFlight>) {
    let mut populations = lock_populations();
    if populations
        .get(cache_path)
        .is_some_and(|current| Arc::ptr_eq(current, flight))
    {
        populations.remove(cache_path);
    }
}

fn lock_populations(
) -> MutexGuard<'static, HashMap<PathBuf, Arc<PopulationFlight>>> {
    MEDIA_CACHE_POPULATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn recent_population_failure(cache_path: &Path) -> Option<PopulationFailure> {
    let mut failures = MEDIA_CACHE_FAILURES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    failures.retain(|_, failure| failure.expires_at > now);
    failures
        .get(cache_path)
        .map(|failure| failure.failure.clone())
}

fn record_population_failure(cache_path: PathBuf, failure: PopulationFailure) {
    let mut failures = MEDIA_CACHE_FAILURES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    failures.retain(|_, cached| cached.expires_at > now);
    if failures.len() >= MESSENGER_MEDIA_CACHE_MAX_TRACKED_FAILURES
        && !failures.contains_key(&cache_path)
    {
        if let Some(oldest) = failures
            .iter()
            .min_by_key(|(_, cached)| cached.expires_at)
            .map(|(path, _)| path.clone())
        {
            failures.remove(&oldest);
        }
    }
    let ttl_secs = if failure.retryable {
        MESSENGER_MEDIA_CACHE_RETRYABLE_FAILURE_TTL_SECS
    } else {
        MESSENGER_MEDIA_CACHE_FAILURE_TTL_SECS
    };
    failures.insert(
        cache_path,
        CachedPopulationFailure {
            failure,
            expires_at: now + Duration::from_secs(ttl_secs),
        },
    );
}

fn clear_population_failure(cache_path: &Path) {
    MEDIA_CACHE_FAILURES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(cache_path);
}

#[cfg(test)]
async fn publish_cache_bytes(
    cache_path: &Path,
    data: &[u8],
) -> Result<(), AppError> {
    let temp_path = temporary_cache_path(cache_path);
    let temp_file = TemporaryCacheFile::new(temp_path.clone());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
        .open(&temp_path)
        .await
        .c(h!())?;
    file.write_all(data).await.c(h!())?;
    file.flush().await.c(h!())?;
    drop(file);
    temp_file.publish(cache_path).await
}

async fn publish_cache_bytes_for_population(
    cache_path: &Path,
    data: &[u8],
    flight: &Arc<PopulationFlight>,
) -> Result<(), AppError> {
    let temp_path = temporary_cache_path(cache_path);
    let temp_file = TemporaryCacheFile::new(temp_path.clone());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
        .open(&temp_path)
        .await
        .c(h!())?;
    file.write_all(data).await.c(h!())?;
    file.flush().await.c(h!())?;
    drop(file);
    temp_file.publish_for_population(cache_path, flight).await
}

pub async fn remove_cached_media_file_best_effort(
    config: &Config,
    media_id: Uuid,
) {
    let cache_path = media_cache_path(config, media_id);
    cancel_population(&cache_path);
    if let Err(error) = remove_cache_path_if_present(&cache_path).await {
        warn!(
            "failed to remove decrypted media cache file={} media_id={media_id}: {error:#?}",
            cache_path.display()
        );
    }
    if let Err(error) = remove_cache_temporary_files(&cache_path).await {
        warn!(
            "failed to remove decrypted media cache temporary files for media_id={media_id}: {error:#?}"
        );
    }
}

fn cancel_population(cache_path: &Path) {
    clear_population_failure(cache_path);
    let flight = lock_populations().remove(cache_path);
    if let Some(flight) = flight {
        flight.cancel();
    }
}

async fn remove_cache_path_if_present(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn remove_cache_temporary_files(
    cache_path: &Path,
) -> Result<(), AppError> {
    let Some(cache_dir) = cache_path.parent() else {
        return Ok(());
    };
    let prefix = format!(
        "{}.tmp-",
        cache_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .unwrap_or_default()
    );
    let mut entries = match fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let file_name = entry.file_name();
        if file_name
            .to_str()
            .is_some_and(|file_name| file_name.starts_with(&prefix))
        {
            remove_cache_path_if_present(&entry.path()).await?;
        }
    }
    Ok(())
}

fn temporary_cache_path(cache_path: &Path) -> PathBuf {
    let file_name = cache_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("media");
    cache_path.with_file_name(format!("{file_name}.tmp-{}", Uuid::new_v4()))
}

async fn ensure_cache_dir(cache_dir: &Path) -> Result<(), AppError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(MESSENGER_MEDIA_CACHE_DIR_MODE)
        .create(cache_dir)
        .await
        .c(h!())?;
    fs::set_permissions(
        cache_dir,
        std::fs::Permissions::from_mode(MESSENGER_MEDIA_CACHE_DIR_MODE),
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn cached_file_is_valid(
    cache_path: &Path,
    expected_size: u64,
) -> Result<bool, AppError> {
    match fs::symlink_metadata(cache_path).await {
        Ok(metadata) => {
            Ok(metadata.file_type().is_file()
                && metadata.len() == expected_size)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

async fn remove_invalid_cache_entry(cache_path: &Path) -> Result<(), AppError> {
    match fs::remove_file(cache_path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

async fn touch_cache_file(cache_path: &Path) {
    let cache_path = cache_path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&cache_path)?;
        file.set_times(
            std::fs::FileTimes::new().set_modified(SystemTime::now()),
        )
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => warn!("failed to touch media cache file: {err:?}"),
        Err(err) => warn!("failed to join media cache touch task: {err:?}"),
    }
}

pub async fn run_cache_cleanup_worker_nofail(cache_dir: PathBuf) {
    info!(
        "starting messenger media cache cleanup worker dir={}",
        cache_dir.display()
    );
    loop {
        let _loop_guard = crate::utils::worker_watch::loop_guard(
            "messenger_media_cache_cleanup_worker",
        );
        if let Err(err) =
            cleanup_cache_dir_once(&cache_dir, SystemTime::now()).await
        {
            error!("messenger media cache cleanup failed: {err:#?}");
        }
        tokio::time::sleep(Duration::from_secs(
            MESSENGER_MEDIA_CACHE_CLEANUP_INTERVAL_SECS,
        ))
        .await;
    }
}

async fn cleanup_cache_dir_once(
    cache_dir: &Path,
    now: SystemTime,
) -> Result<(), AppError> {
    ensure_cache_dir(cache_dir).await?;
    cleanup_stale_cache_entries(cache_dir, now).await?;
    enforce_cache_size_limit(
        cache_dir,
        MESSENGER_MEDIA_CACHE_MAX_TOTAL_SIZE_BYTES,
    )
    .await
}

async fn cleanup_stale_cache_entries(
    cache_dir: &Path,
    now: SystemTime,
) -> Result<(), AppError> {
    let mut entries = fs::read_dir(cache_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        if let Err(err) = cleanup_cache_entry(&entry, now).await {
            warn!(
                "failed to clean messenger media cache entry={}: {err:#?}",
                entry.path().display()
            );
        }
    }
    Ok(())
}

async fn enforce_cache_size_limit(
    cache_dir: &Path,
    max_size: u64,
) -> Result<(), AppError> {
    let (mut total_size, mut entries) =
        collect_cache_size_entries(cache_dir).await?;
    entries.sort_by_key(|entry| entry.modified);
    for entry in entries {
        if total_size <= max_size {
            break;
        }
        match fs::remove_file(&entry.path).await {
            Ok(()) => {
                total_size = total_size.saturating_sub(entry.size);
                info!(
                    "removed messenger media cache file for size limit file={} size={} remaining_size={total_size}",
                    entry.path.display(),
                    entry.size,
                );
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                total_size = total_size.saturating_sub(entry.size);
            }
            Err(err) => warn!(
                "failed to remove messenger media cache file for size limit file={}: {err:?}",
                entry.path.display()
            ),
        }
    }
    if total_size > max_size {
        warn!(
            "messenger media cache remains over size limit current_size={total_size} max_size={max_size}; active files were preserved"
        );
    }
    Ok(())
}

async fn collect_cache_size_entries(
    cache_dir: &Path,
) -> Result<(u64, Vec<CacheSizeEntry>), AppError> {
    let mut total_size = 0_u64;
    let mut cache_entries = Vec::new();
    let mut entries = fs::read_dir(cache_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let file_type = entry.file_type().await.c(h!())?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if cache_entry_ttl(file_name).is_none() {
            continue;
        }
        let metadata = entry.metadata().await.c(h!())?;
        total_size = total_size.saturating_add(metadata.len());
        if is_active_cache_entry(&entry.path(), file_name) {
            continue;
        }
        cache_entries.push(CacheSizeEntry {
            path: entry.path(),
            size: metadata.len(),
            modified: metadata.modified().c(h!())?,
        });
    }
    Ok((total_size, cache_entries))
}

async fn cleanup_cache_entry(
    entry: &fs::DirEntry,
    now: SystemTime,
) -> Result<(), AppError> {
    let file_type = entry.file_type().await.c(h!())?;
    if !file_type.is_file() {
        return Ok(());
    }
    let file_name = entry.file_name();
    let Some(file_name) = file_name.to_str() else {
        return Ok(());
    };
    let Some(ttl) = cache_entry_ttl(file_name) else {
        return Ok(());
    };
    if is_active_cache_entry(entry.path().as_path(), file_name) {
        return Ok(());
    }
    let metadata = entry.metadata().await.c(h!())?;
    let modified = metadata.modified().c(h!())?;
    if now.duration_since(modified).unwrap_or_default() <= ttl {
        return Ok(());
    }
    match fs::remove_file(entry.path()).await {
        Ok(()) => info!(
            "removed stale messenger media cache file={}",
            entry.path().display()
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

fn cache_entry_ttl(file_name: &str) -> Option<Duration> {
    if Uuid::parse_str(file_name).is_ok() {
        return Some(Duration::from_secs(MESSENGER_MEDIA_CACHE_TTL_SECS));
    }
    let (cache_name, temp_name) = file_name.split_once(".tmp-")?;
    if Uuid::parse_str(cache_name).is_ok() && Uuid::parse_str(temp_name).is_ok()
    {
        Some(Duration::from_secs(MESSENGER_MEDIA_CACHE_TEMP_TTL_SECS))
    } else {
        None
    }
}

fn is_active_cache_entry(path: &Path, file_name: &str) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let cache_path = file_name.split_once(".tmp-").map_or_else(
        || path.to_path_buf(),
        |(cache_name, _)| parent.join(cache_name),
    );
    lock_populations().contains_key(&cache_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn caches_only_files_larger_than_threshold() {
        assert!(!should_cache_media(
            MESSENGER_MEDIA_CACHE_MIN_FILE_SIZE_BYTES
        ));
        assert!(should_cache_media(
            MESSENGER_MEDIA_CACHE_MIN_FILE_SIZE_BYTES + 1
        ));
    }

    #[test]
    fn cache_failure_status_distinguishes_integrity_from_infrastructure() {
        let integrity = PopulationFailure::from(AppError::BL {
            msg: "decryption failed".to_string(),
        })
        .into_app_error();
        assert!(matches!(integrity, AppError::BL { .. }));

        let infrastructure = PopulationFailure::from(AppError::IO {
            source: std::io::Error::other("disk unavailable"),
        })
        .into_app_error();
        assert!(matches!(
            infrastructure,
            AppError::ServiceUnavailable { .. }
        ));
    }

    #[tokio::test]
    async fn concurrent_population_uses_same_flight() {
        let temp_dir = tempfile::tempdir().unwrap();
        let cache_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let runs = Arc::new(AtomicUsize::new(0));
        let runs_first = runs.clone();
        let cache_path_first = cache_path.clone();
        let started = Arc::new(tokio::sync::Notify::new());
        let started_first = started.clone();
        let release = Arc::new(tokio::sync::Notify::new());
        let release_first = release.clone();
        let semaphore = Arc::new(Semaphore::new(1));
        let (first_flight, first_permit) =
            population_for_path_with_semaphore(&cache_path, &semaphore)
                .unwrap();
        let first = spawn_population_task(
            cache_path.clone(),
            first_flight.clone(),
            first_permit.unwrap(),
            async move {
                runs_first.fetch_add(1, Ordering::SeqCst);
                started_first.notify_one();
                release_first.notified().await;
                fs::write(cache_path_first, b"ready")
                    .await
                    .map_err(|err| err.to_string())
            },
        );

        started.notified().await;
        let (second_flight, second_permit) =
            population_for_path_with_semaphore(&cache_path, &semaphore)
                .unwrap();
        assert!(second_permit.is_none());
        assert!(Arc::ptr_eq(&first_flight, &second_flight));
        let second_cache_path = cache_path.clone();
        let second = tokio::spawn(async move {
            wait_for_population(&second_cache_path, &second_flight).await
        });
        release.notify_one();

        first.await.unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn waiting_request_waits_for_population_capacity() {
        let cache_path = PathBuf::from(format!("/tmp/{}", Uuid::new_v4()));
        let semaphore = Arc::new(Semaphore::new(0));
        let request_path = cache_path.clone();
        let request_semaphore = semaphore.clone();
        let request = tokio::spawn(async move {
            population_for_path_and_wait_for_permit(
                &request_path,
                &request_semaphore,
            )
            .await
        });

        tokio::task::yield_now().await;
        assert!(!request.is_finished());
        semaphore.add_permits(1);

        let (flight, permit) = request.await.unwrap().unwrap().unwrap();
        assert!(permit.is_some());
        remove_population(&cache_path, &flight);
    }

    #[tokio::test]
    async fn waiting_request_observes_failure_recorded_while_queued() {
        let cache_path = PathBuf::from(format!("/tmp/{}", Uuid::new_v4()));
        let semaphore = Arc::new(Semaphore::new(0));
        let request_path = cache_path.clone();
        let request_semaphore = semaphore.clone();
        let request = tokio::spawn(async move {
            population_for_path_and_wait_for_permit(
                &request_path,
                &request_semaphore,
            )
            .await
        });

        tokio::task::yield_now().await;
        assert!(!request.is_finished());
        record_population_failure(
            cache_path.clone(),
            PopulationFailure::from(AppError::BL {
                msg: "decryption failed".to_string(),
            }),
        );
        semaphore.add_permits(1);

        let failure = match request.await.unwrap() {
            Err(failure) => failure,
            Ok(_) => panic!("queued request ignored the cached failure"),
        };
        assert_eq!(failure.msg, "decryption failed");
        assert!(!lock_populations().contains_key(&cache_path));
        clear_population_failure(&cache_path);
    }

    #[tokio::test]
    async fn aborted_population_unblocks_waiters_and_removes_flight() {
        let cache_path = PathBuf::from(format!("/tmp/{}", Uuid::new_v4()));
        let semaphore = Arc::new(Semaphore::new(1));
        let (flight, permit) =
            population_for_path_with_semaphore(&cache_path, &semaphore)
                .unwrap();
        let task = spawn_population_task(
            cache_path.clone(),
            flight.clone(),
            permit.unwrap(),
            std::future::pending::<Result<(), String>>(),
        );
        task.abort();

        let result =
            tokio::time::timeout(Duration::from_secs(1), flight.wait())
                .await
                .unwrap();
        assert!(result.is_err());
        let (next_flight, next_permit) =
            population_for_path_with_semaphore(&cache_path, &semaphore)
                .unwrap();
        assert!(next_permit.is_some());
        remove_population(&cache_path, &next_flight);
    }

    #[tokio::test]
    async fn cancelled_population_cannot_publish_after_media_deletion() {
        let temp_dir = tempfile::tempdir().unwrap();
        let cache_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let semaphore = Arc::new(Semaphore::new(1));
        let (flight, permit) =
            population_for_path_with_semaphore(&cache_path, &semaphore)
                .unwrap();
        let publish_flight = flight.clone();
        let publish_path = cache_path.clone();
        let started = Arc::new(tokio::sync::Notify::new());
        let started_task = started.clone();
        let release = Arc::new(tokio::sync::Notify::new());
        let release_task = release.clone();
        let task = spawn_population_task(
            cache_path.clone(),
            flight.clone(),
            permit.unwrap(),
            async move {
                started_task.notify_one();
                release_task.notified().await;
                publish_cache_bytes_for_population(
                    &publish_path,
                    b"deleted media",
                    &publish_flight,
                )
                .await
                .map_err(|error| error.to_string())
            },
        );

        started.notified().await;
        cancel_population(&cache_path);
        assert!(flight.wait().await.is_err());
        release.notify_one();
        task.await.unwrap();

        assert!(!cache_path.exists());
        assert!(!lock_populations().contains_key(&cache_path));
    }

    #[tokio::test]
    async fn publishes_file_atomically_with_private_permissions() {
        let temp_dir = tempfile::tempdir().unwrap();
        ensure_cache_dir(temp_dir.path()).await.unwrap();
        let cache_path = temp_dir.path().join(Uuid::new_v4().to_string());

        publish_cache_bytes(&cache_path, b"decrypted")
            .await
            .unwrap();

        assert_eq!(fs::read(&cache_path).await.unwrap(), b"decrypted");
        let mode = fs::metadata(&cache_path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, MESSENGER_MEDIA_CACHE_FILE_MODE);
        let mut entries = fs::read_dir(temp_dir.path()).await.unwrap();
        assert!(entries.next_entry().await.unwrap().is_some());
        assert!(entries.next_entry().await.unwrap().is_none());
    }

    #[test]
    fn distinct_population_fails_fast_but_same_path_still_joins() {
        let semaphore = Arc::new(Semaphore::new(1));
        let first_path = PathBuf::from(Uuid::new_v4().to_string());
        let second_path = PathBuf::from(Uuid::new_v4().to_string());
        let (first_flight, first_permit) =
            population_for_path_with_semaphore(&first_path, &semaphore)
                .unwrap();

        let (same_flight, same_permit) =
            population_for_path_with_semaphore(&first_path, &semaphore)
                .unwrap();
        assert!(same_permit.is_none());
        assert!(Arc::ptr_eq(&first_flight, &same_flight));
        assert!(population_for_path_with_semaphore(&second_path, &semaphore)
            .is_none());

        remove_population(&first_path, &first_flight);
        drop(first_permit);
        let (second_flight, second_permit) =
            population_for_path_with_semaphore(&second_path, &semaphore)
                .unwrap();
        assert!(second_permit.is_some());
        remove_population(&second_path, &second_flight);
    }

    #[tokio::test]
    async fn ready_probe_never_creates_or_populates_cache() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        config.storage_dir = temp_dir.path().display().to_string();
        let media_id = Uuid::new_v4();

        assert!(cached_media_path_if_ready(&config, media_id, 5)
            .await
            .unwrap()
            .is_none());
        assert!(!media_cache_dir(&config).exists());

        ensure_cache_dir(&media_cache_dir(&config)).await.unwrap();
        let cache_path = media_cache_path(&config, media_id);
        publish_cache_bytes(&cache_path, b"ready").await.unwrap();
        assert_eq!(
            cached_media_path_if_ready(&config, media_id, 5)
                .await
                .unwrap(),
            Some(cache_path)
        );
    }

    #[tokio::test]
    async fn cleanup_removes_only_stale_known_cache_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let stale_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let fresh_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let unknown_path = temp_dir.path().join("keep-me");
        fs::write(&stale_path, b"stale").await.unwrap();
        fs::write(&fresh_path, b"fresh").await.unwrap();
        fs::write(&unknown_path, b"unknown").await.unwrap();
        let now = SystemTime::now();
        let stale_time =
            now - Duration::from_secs(MESSENGER_MEDIA_CACHE_TTL_SECS + 1);
        std::fs::File::open(&stale_path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stale_time))
            .unwrap();

        cleanup_cache_dir_once(temp_dir.path(), now).await.unwrap();

        assert!(!stale_path.exists());
        assert!(fresh_path.exists());
        assert!(unknown_path.exists());
    }

    #[tokio::test]
    async fn size_limit_evicts_oldest_cache_files_first() {
        let temp_dir = tempfile::tempdir().unwrap();
        let oldest_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let middle_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let newest_path = temp_dir.path().join(Uuid::new_v4().to_string());
        fs::write(&oldest_path, b"oldest").await.unwrap();
        fs::write(&middle_path, b"middle").await.unwrap();
        fs::write(&newest_path, b"newest").await.unwrap();
        let now = SystemTime::now();
        set_modified(&oldest_path, now - Duration::from_secs(3));
        set_modified(&middle_path, now - Duration::from_secs(2));
        set_modified(&newest_path, now - Duration::from_secs(1));

        enforce_cache_size_limit(temp_dir.path(), 12).await.unwrap();

        assert!(!oldest_path.exists());
        assert!(middle_path.exists());
        assert!(newest_path.exists());
    }

    #[tokio::test]
    async fn size_limit_preserves_active_population() {
        let temp_dir = tempfile::tempdir().unwrap();
        let active_path = temp_dir.path().join(Uuid::new_v4().to_string());
        let inactive_path = temp_dir.path().join(Uuid::new_v4().to_string());
        fs::write(&active_path, b"active").await.unwrap();
        fs::write(&inactive_path, b"inactive").await.unwrap();
        let semaphore = Arc::new(Semaphore::new(1));
        let (flight, _permit) =
            population_for_path_with_semaphore(&active_path, &semaphore)
                .unwrap();

        enforce_cache_size_limit(temp_dir.path(), 6).await.unwrap();

        assert!(active_path.exists());
        assert!(!inactive_path.exists());
        remove_population(&active_path, &flight);
    }

    fn set_modified(path: &Path, modified: SystemTime) {
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
}
