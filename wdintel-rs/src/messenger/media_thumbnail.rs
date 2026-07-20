use crate::config::{
    Config, MESSENGER_MEDIA_THUMBNAIL_DIR_MODE,
    MESSENGER_MEDIA_THUMBNAIL_DIR_NAME, MESSENGER_MEDIA_THUMBNAIL_FFMPEG_BIN,
    MESSENGER_MEDIA_THUMBNAIL_FFMPEG_FILTER,
    MESSENGER_MEDIA_THUMBNAIL_FFMPEG_TIMEOUT_SECS,
    MESSENGER_MEDIA_THUMBNAIL_FILE_MODE, MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX,
    MESSENGER_MEDIA_THUMBNAIL_MAX_CONCURRENT_GENERATIONS,
    MESSENGER_MEDIA_THUMBNAIL_MAX_RETRY_ATTEMPTS,
    MESSENGER_MEDIA_THUMBNAIL_MAX_TOTAL_SIZE_BYTES,
    MESSENGER_MEDIA_THUMBNAIL_ORPHAN_CLEANUP_INTERVAL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_ORPHAN_QUERY_BATCH_SIZE,
    MESSENGER_MEDIA_THUMBNAIL_ORPHAN_SOURCE_TTL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_CONCURRENT_TASKS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_INITIAL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_MAX_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_TERMINAL_TTL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RETRY_INITIAL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_RETRY_MAX_SECS,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_BUDGET_LOCK_FILE_NAME,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_DIR_NAME,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_FILE_SUFFIX,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_COUNT,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_FILE_SIZE_BYTES,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_TOTAL_SIZE_BYTES,
    MESSENGER_MEDIA_THUMBNAIL_SOURCE_TTL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_TEMP_TTL_SECS,
    MESSENGER_MEDIA_THUMBNAIL_WORKER_SCAN_INTERVAL_SECS,
};
use crate::entities::signal_message_media;
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{
    ensure_media_access, is_video_media, media_object_key,
    stream_plaintext_media_range,
};
use crate::messenger::media_cache;
use crate::storage;
use crate::types::{error, info, warn, Env, ShortContext};
use actix_files::NamedFile;
use actix_web::http::header;
use actix_web::{get, HttpRequest, HttpResponse};
use futures_util::TryStreamExt;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::future::Future;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

struct TemporaryFile {
    path: PathBuf,
    published: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    async fn publish(mut self, destination: &Path) -> Result<(), AppError> {
        fs::rename(&self.path, destination).await.c(h!())?;
        self.published = true;
        Ok(())
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct ThumbnailSourceBudgetLock {
    file: std::fs::File,
}

impl Drop for ThumbnailSourceBudgetLock {
    fn drop(&mut self) {
        let _ = std::fs::File::unlock(&self.file);
    }
}

#[derive(Clone, Copy)]
struct RetryState {
    failures: u32,
    retry_at: Instant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ThumbnailSourceReference {
    source_path: PathBuf,
    expected_size: u64,
    source_device: u64,
    source_inode: u64,
    delete_source: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadThumbnailSourceStage {
    Independent,
    Referenced,
}

#[derive(Clone, Copy)]
enum ThumbnailQueueEntryKind {
    StagedSource,
    SourceReference,
}

static ACTIVE_THUMBNAIL_SOURCES: LazyLock<Mutex<HashMap<Uuid, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
type ThumbnailOperationMutex = tokio::sync::Mutex<()>;
static THUMBNAIL_OPERATIONS: LazyLock<
    Mutex<HashMap<Uuid, Weak<ThumbnailOperationMutex>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));
static THUMBNAIL_RECOVERIES: LazyLock<
    Mutex<HashMap<Uuid, ThumbnailRecoveryState>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));
static THUMBNAIL_RECOVERY_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| {
        Arc::new(Semaphore::new(
            MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_CONCURRENT_TASKS,
        ))
    });
static THUMBNAIL_GENERATION_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| {
        Arc::new(Semaphore::new(
            MESSENGER_MEDIA_THUMBNAIL_MAX_CONCURRENT_GENERATIONS,
        ))
    });

#[derive(Clone, Copy)]
enum ThumbnailRecoveryState {
    Running { failures: u32 },
    CoolingDown { failures: u32, retry_at: Instant },
    Terminal { failures: u32, failed_at: Instant },
}

struct ThumbnailRecoveryGuard {
    media_id: Uuid,
    failures: u32,
    completed: bool,
}

impl ThumbnailRecoveryGuard {
    fn complete(mut self, success: bool) {
        finish_thumbnail_recovery(self.media_id, self.failures, success);
        self.completed = true;
    }

    fn defer(mut self, retry_after_secs: u64) {
        defer_thumbnail_recovery(
            self.media_id,
            self.failures,
            Duration::from_secs(retry_after_secs),
        );
        self.completed = true;
    }
}

impl Drop for ThumbnailRecoveryGuard {
    fn drop(&mut self) {
        if !self.completed {
            finish_thumbnail_recovery(self.media_id, self.failures, false);
        }
    }
}

struct ThumbnailOperation {
    media_id: Uuid,
    operation: Arc<ThumbnailOperationMutex>,
}

impl ThumbnailOperation {
    fn new(media_id: Uuid) -> Self {
        let mut operations = THUMBNAIL_OPERATIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(operation) =
            operations.get(&media_id).and_then(Weak::upgrade)
        {
            return Self {
                media_id,
                operation,
            };
        }
        let operation = Arc::new(ThumbnailOperationMutex::new(()));
        operations.insert(media_id, Arc::downgrade(&operation));
        Self {
            media_id,
            operation,
        }
    }

    async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.operation.lock().await
    }

    fn try_lock(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        self.operation.try_lock().ok()
    }
}

impl Drop for ThumbnailOperation {
    fn drop(&mut self) {
        let mut operations = THUMBNAIL_OPERATIONS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let is_current =
            operations.get(&self.media_id).is_some_and(|operation| {
                std::ptr::eq(operation.as_ptr(), Arc::as_ptr(&self.operation))
            });
        if is_current && Arc::strong_count(&self.operation) == 1 {
            operations.remove(&self.media_id);
        }
    }
}

async fn with_thumbnail_operation<T>(
    media_id: Uuid,
    future: impl Future<Output = T>,
) -> T {
    let operation = ThumbnailOperation::new(media_id);
    let _guard = operation.lock().await;
    future.await
}

#[must_use]
pub struct ThumbnailSourceLease {
    media_id: Uuid,
}

impl ThumbnailSourceLease {
    pub fn new(media_id: Uuid) -> Self {
        let mut active = ACTIVE_THUMBNAIL_SOURCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active.entry(media_id).or_default() += 1;
        Self { media_id }
    }
}

impl Drop for ThumbnailSourceLease {
    fn drop(&mut self) {
        let mut active = ACTIVE_THUMBNAIL_SOURCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(count) = active.get_mut(&self.media_id) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            active.remove(&self.media_id);
        }
    }
}

fn thumbnail_source_is_active(media_id: Uuid) -> bool {
    ACTIVE_THUMBNAIL_SOURCES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(&media_id)
}

fn begin_thumbnail_recovery(media_id: Uuid) -> Option<ThumbnailRecoveryGuard> {
    let now = Instant::now();
    let mut recoveries = THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let failures = match recoveries.get(&media_id) {
        Some(ThumbnailRecoveryState::Running { .. }) => return None,
        Some(ThumbnailRecoveryState::CoolingDown { retry_at, .. })
            if *retry_at > now =>
        {
            return None;
        }
        Some(ThumbnailRecoveryState::CoolingDown { failures, .. }) => *failures,
        Some(ThumbnailRecoveryState::Terminal { failed_at, .. })
            if now.saturating_duration_since(*failed_at)
                < Duration::from_secs(
                    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_TERMINAL_TTL_SECS,
                ) =>
        {
            return None;
        }
        Some(ThumbnailRecoveryState::Terminal { .. }) => 0,
        None => 0,
    };
    prune_thumbnail_recoveries(&mut recoveries, now);
    if !ensure_thumbnail_recovery_capacity(&mut recoveries, media_id) {
        return None;
    }
    recoveries.insert(media_id, ThumbnailRecoveryState::Running { failures });
    Some(ThumbnailRecoveryGuard {
        media_id,
        failures,
        completed: false,
    })
}

fn ensure_thumbnail_recovery_capacity(
    recoveries: &mut HashMap<Uuid, ThumbnailRecoveryState>,
    media_id: Uuid,
) -> bool {
    if recoveries.contains_key(&media_id)
        || recoveries.len()
            < MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA
    {
        return true;
    }
    let evicted = recoveries.iter().find_map(|(media_id, recovery)| {
        (!matches!(recovery, ThumbnailRecoveryState::Running { .. }))
            .then_some(*media_id)
    });
    if let Some(evicted) = evicted {
        recoveries.remove(&evicted);
    }
    recoveries.len() < MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA
}

fn prune_thumbnail_recoveries(
    recoveries: &mut HashMap<Uuid, ThumbnailRecoveryState>,
    now: Instant,
) {
    recoveries.retain(|_, recovery| match recovery {
        ThumbnailRecoveryState::Running { .. } => true,
        ThumbnailRecoveryState::CoolingDown { retry_at, .. } => *retry_at > now,
        ThumbnailRecoveryState::Terminal { failed_at, .. } => {
            now.saturating_duration_since(*failed_at)
                < Duration::from_secs(
                    MESSENGER_MEDIA_THUMBNAIL_RECOVERY_TERMINAL_TTL_SECS,
                )
        }
    });
}

fn thumbnail_recovery_terminal_failures(media_id: Uuid) -> Option<u32> {
    let now = Instant::now();
    let mut recoveries = THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    prune_thumbnail_recoveries(&mut recoveries, now);
    match recoveries.get(&media_id) {
        Some(ThumbnailRecoveryState::Terminal { failures, .. }) => {
            Some(*failures)
        }
        _ => None,
    }
}

fn mark_thumbnail_recovery_terminal(media_id: Uuid, failures: u32) {
    let now = Instant::now();
    let mut recoveries = THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    prune_thumbnail_recoveries(&mut recoveries, now);
    if !ensure_thumbnail_recovery_capacity(&mut recoveries, media_id) {
        return;
    }
    recoveries.insert(
        media_id,
        ThumbnailRecoveryState::Terminal {
            failures,
            failed_at: now,
        },
    );
}

fn clear_thumbnail_recovery(media_id: Uuid) {
    THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&media_id);
}

fn finish_thumbnail_recovery(
    media_id: Uuid,
    previous_failures: u32,
    success: bool,
) {
    let mut recoveries = THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let is_current = matches!(
        recoveries.get(&media_id),
        Some(ThumbnailRecoveryState::Running { failures })
            if *failures == previous_failures
    );
    if !is_current {
        return;
    }
    if success {
        recoveries.remove(&media_id);
        return;
    }
    let failures = previous_failures.saturating_add(1);
    if failures >= MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS {
        recoveries.insert(
            media_id,
            ThumbnailRecoveryState::Terminal {
                failures,
                failed_at: Instant::now(),
            },
        );
        return;
    }
    let shift = failures.saturating_sub(1).min(16);
    let delay_secs = MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_INITIAL_SECS
        .saturating_mul(1_u64 << shift)
        .min(MESSENGER_MEDIA_THUMBNAIL_RECOVERY_RETRY_MAX_SECS);
    recoveries.insert(
        media_id,
        ThumbnailRecoveryState::CoolingDown {
            failures,
            retry_at: Instant::now() + Duration::from_secs(delay_secs),
        },
    );
}

fn defer_thumbnail_recovery(
    media_id: Uuid,
    previous_failures: u32,
    delay: Duration,
) {
    let mut recoveries = THUMBNAIL_RECOVERIES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let is_current = matches!(
        recoveries.get(&media_id),
        Some(ThumbnailRecoveryState::Running { failures })
            if *failures == previous_failures
    );
    if !is_current {
        return;
    }
    recoveries.insert(
        media_id,
        ThumbnailRecoveryState::CoolingDown {
            failures: previous_failures,
            retry_at: Instant::now() + delay,
        },
    );
}

fn schedule_thumbnail_recovery(
    env: Arc<Env>,
    media: signal_message_media::Model,
) {
    let Some((recovery, permit)) = begin_scheduled_thumbnail_recovery(media.id)
    else {
        return;
    };
    drop(tokio::spawn(async move {
        match recover_missing_thumbnail(&env, &media, permit).await {
            Ok(()) => recovery.complete(true),
            Err(AppError::ServiceUnavailable {
                msg,
                retry_after_secs,
            }) => {
                warn!(
                    "deferred messenger media thumbnail recovery for {}: {msg}",
                    media.id
                );
                recovery.defer(retry_after_secs);
            }
            Err(err) => {
                warn!(
                    "failed to recover messenger media thumbnail for {}: {err:#?}",
                    media.id
                );
                recovery.complete(false);
            }
        }
    }));
}

fn begin_scheduled_thumbnail_recovery(
    media_id: Uuid,
) -> Option<(ThumbnailRecoveryGuard, OwnedSemaphorePermit)> {
    let permit = THUMBNAIL_RECOVERY_SEMAPHORE
        .clone()
        .try_acquire_owned()
        .ok()?;
    let recovery = begin_thumbnail_recovery(media_id)?;
    Some((recovery, permit))
}

async fn recover_missing_thumbnail(
    env: &Env,
    media: &signal_message_media::Model,
    _permit: OwnedSemaphorePermit,
) -> Result<(), AppError> {
    let operation = ThumbnailOperation::new(media.id);
    let _operation_guard = operation.lock().await;
    recover_missing_thumbnail_locked(env, media).await
}

async fn recover_missing_thumbnail_locked(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<(), AppError> {
    let Some(media) = signal_message_media::Entity::find_by_id(media.id)
        .one(&env.dbx)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    if !is_video_media(&media) {
        return Ok(());
    }

    let thumbnail_path = media_thumbnail_path(&env.config, media.id);
    if jpeg_file_is_ready(&thumbnail_path).await? {
        return Ok(());
    }
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    let staged_source = media_thumbnail_source_path(&env.config, media.id);
    if regular_file_has_size(&staged_source, Some(expected_size)).await? {
        return Ok(());
    }
    remove_file_if_present(&staged_source).await?;
    if read_thumbnail_source_reference(&media_thumbnail_source_reference_path(
        &env.config,
        media.id,
    ))
    .await?
    .is_some()
    {
        return Ok(());
    }

    if media.is_encrypted {
        recover_encrypted_thumbnail(env, &media, &thumbnail_path, expected_size)
            .await
    } else {
        recover_plaintext_thumbnail(env, &media, &thumbnail_path, expected_size)
            .await
    }
}

pub fn media_thumbnail_path(config: &Config, media_id: Uuid) -> PathBuf {
    thumbnail_dir(config)
        .join(format!("{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}"))
}

fn media_thumbnail_source_path(config: &Config, media_id: Uuid) -> PathBuf {
    thumbnail_source_dir(config).join(format!(
        "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
    ))
}

fn media_thumbnail_source_reference_path(
    config: &Config,
    media_id: Uuid,
) -> PathBuf {
    thumbnail_source_reference_path(&thumbnail_source_dir(config), media_id)
}

fn thumbnail_source_reference_path(
    source_dir: &Path,
    media_id: Uuid,
) -> PathBuf {
    source_dir.join(format!(
        "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_FILE_SUFFIX}"
    ))
}

pub async fn remove_media_thumbnail_files_best_effort(
    config: &Config,
    media_id: Uuid,
) {
    with_thumbnail_operation(media_id, async {
        let paths = [
            media_thumbnail_path(config, media_id),
            media_thumbnail_source_path(config, media_id),
        ];
        for path in paths {
            if let Err(err) = remove_file_if_present(&path).await {
                warn!(
                    "failed to remove messenger media thumbnail file={} media_id={media_id}: {err:#?}",
                    path.display()
                );
            }
        }
        let reference_path =
            media_thumbnail_source_reference_path(config, media_id);
        if let Err(err) = finalize_thumbnail_source_reference_locked(
            &thumbnail_source_dir(config),
            &reference_path,
            true,
        )
        .await
        {
            warn!(
                "failed to remove messenger media thumbnail source reference file={} media_id={media_id}: {err:#?}",
                reference_path.display()
            );
        }
    })
    .await;
}

async fn remove_thumbnail_paths_best_effort(
    media_id: Uuid,
    paths: &[PathBuf],
    description: &str,
) -> bool {
    with_thumbnail_operation(media_id, async {
        let mut success = true;
        for path in paths {
            if let Err(err) = remove_file_if_present(path).await {
                success = false;
                warn!(
                    "failed to remove {description} file={} media_id={media_id}: {err:#?}",
                    path.display()
                );
            }
        }
        success
    })
    .await
}

fn thumbnail_dir(config: &Config) -> PathBuf {
    media_cache::media_cache_dir(config)
        .join(MESSENGER_MEDIA_THUMBNAIL_DIR_NAME)
}

fn thumbnail_source_dir(config: &Config) -> PathBuf {
    media_cache::media_cache_dir(config)
        .join(MESSENGER_MEDIA_THUMBNAIL_SOURCE_DIR_NAME)
}

async fn lock_thumbnail_source_budget(
    source_dir: &Path,
) -> Result<ThumbnailSourceBudgetLock, AppError> {
    ensure_private_dir(source_dir).await?;
    let lock_path =
        source_dir.join(MESSENGER_MEDIA_THUMBNAIL_SOURCE_BUDGET_LOCK_FILE_NAME);
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(MESSENGER_MEDIA_THUMBNAIL_FILE_MODE)
        .open(lock_path)
        .await
        .c(h!())?
        .into_std()
        .await;
    let file = tokio::task::spawn_blocking(move || {
        std::fs::File::lock(&file)?;
        Ok::<std::fs::File, std::io::Error>(file)
    })
    .await
    .c(h!())?
    .c(h!())?;
    Ok(ThumbnailSourceBudgetLock { file })
}

#[cfg(test)]
async fn thumbnail_source_directory_size(
    source_dir: &Path,
) -> Result<u64, AppError> {
    Ok(thumbnail_source_directory_usage(source_dir).await?.0)
}

async fn thumbnail_source_directory_usage(
    source_dir: &Path,
) -> Result<(u64, usize), AppError> {
    let mut total_size = 0_u64;
    let mut count = 0_usize;
    let mut referenced_paths = HashSet::new();
    let mut entries = fs::read_dir(source_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        if !metadata.is_file() {
            continue;
        }
        if thumbnail_queue_entry(&entry.file_name()).is_some() {
            count = count.saturating_add(1);
        }
        if thumbnail_source_reference_media_id(&entry.file_name()).is_some() {
            if let Some(reference) =
                read_thumbnail_source_reference(&entry.path()).await?
            {
                total_size = total_size.checked_add(metadata.len()).ok_or(
                    AppError::BL {
                        msg: "thumbnail source directory size overflowed"
                            .to_string(),
                    },
                )?;
                if referenced_paths.insert(reference.source_path) {
                    total_size = total_size
                        .checked_add(reference.expected_size)
                        .ok_or(AppError::BL {
                            msg: "thumbnail source directory size overflowed"
                                .to_string(),
                        })?;
                }
                continue;
            }
        }
        total_size =
            total_size.checked_add(metadata.len()).ok_or(AppError::BL {
                msg: "thumbnail source directory size overflowed".to_string(),
            })?;
    }
    Ok((total_size, count))
}

async fn thumbnail_source_reference_directory_usage(
    source_dir: &Path,
) -> Result<(u64, usize), AppError> {
    let mut total_size = 0_u64;
    let mut count = 0_usize;
    let mut entries = fs::read_dir(source_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let Some(file_name) = entry.file_name().to_str().map(str::to_string)
        else {
            continue;
        };
        if !file_name
            .contains(MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_FILE_SUFFIX)
        {
            continue;
        }
        if thumbnail_source_reference_media_id(&entry.file_name()).is_some() {
            count = count.saturating_add(1);
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        if metadata.is_file() {
            total_size =
                total_size.checked_add(metadata.len()).ok_or(AppError::BL {
                    msg: "thumbnail source reference directory size overflowed"
                        .to_string(),
                })?;
        }
    }
    Ok((total_size, count))
}

async fn ensure_thumbnail_source_reference_capacity(
    source_dir: &Path,
    reference: &ThumbnailSourceReference,
    manifest_size: u64,
) -> Result<ThumbnailSourceBudgetLock, AppError> {
    if manifest_size == 0
        || manifest_size
            > MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_FILE_SIZE_BYTES
    {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source reference size {manifest_size} exceeds the file limit"
            ),
        });
    }
    let budget = lock_thumbnail_source_budget(source_dir).await?;
    let (current_manifest_size, current_reference_count) =
        thumbnail_source_reference_directory_usage(source_dir).await?;
    if current_reference_count
        >= MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_COUNT
    {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source reference count limit reached: current={current_reference_count} max={MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_COUNT}"
            ),
        });
    }
    let new_manifest_size = current_manifest_size
        .checked_add(manifest_size)
        .ok_or(AppError::BL {
            msg: "thumbnail source reference size overflowed".to_string(),
        })?;
    if new_manifest_size
        > MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_TOTAL_SIZE_BYTES
    {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source reference budget exceeded: current={current_manifest_size} requested={manifest_size} max={MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_TOTAL_SIZE_BYTES}"
            ),
        });
    }
    let (current_source_size, current_source_count) =
        thumbnail_source_directory_usage(source_dir).await?;
    if current_source_count >= MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source count limit reached: current={current_source_count} max={MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT}"
            ),
        });
    }
    let requested_source_size = if thumbnail_source_is_already_referenced(
        source_dir,
        &reference.source_path,
    )
    .await?
    {
        manifest_size
    } else {
        reference.expected_size.checked_add(manifest_size).ok_or(
            AppError::BL {
                msg: "thumbnail source reference size overflowed".to_string(),
            },
        )?
    };
    let new_source_size = current_source_size
        .checked_add(requested_source_size)
        .ok_or(AppError::BL {
            msg: "thumbnail source reference size overflowed".to_string(),
        })?;
    if new_source_size > MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source budget exceeded: current={current_source_size} requested={requested_source_size} max={MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES}"
            ),
        });
    }
    Ok(budget)
}

async fn thumbnail_source_is_already_referenced(
    source_dir: &Path,
    source_path: &Path,
) -> Result<bool, AppError> {
    let mut entries = fs::read_dir(source_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        if thumbnail_source_reference_media_id(&entry.file_name()).is_none() {
            continue;
        }
        if read_thumbnail_source_reference(&entry.path())
            .await?
            .is_some_and(|reference| reference.source_path == source_path)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn ensure_thumbnail_source_capacity(
    source_dir: &Path,
    expected_size: u64,
    max_total_size: u64,
) -> Result<ThumbnailSourceBudgetLock, AppError> {
    if expected_size == 0 || expected_size > max_total_size {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source size {expected_size} exceeds the {max_total_size} byte limit"
            ),
        });
    }
    let budget = lock_thumbnail_source_budget(source_dir).await?;
    let (current_size, current_count) =
        thumbnail_source_directory_usage(source_dir).await?;
    if current_count >= MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source count limit reached: current={current_count} max={MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_COUNT}"
            ),
        });
    }
    let new_size =
        current_size
            .checked_add(expected_size)
            .ok_or(AppError::BL {
                msg: "thumbnail source directory size overflowed".to_string(),
            })?;
    if new_size > max_total_size {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source budget exceeded: current={current_size} requested={expected_size} max={max_total_size}"
            ),
        });
    }
    Ok(budget)
}

async fn create_bounded_thumbnail_source_file(
    source_dir: &Path,
    path: &Path,
    expected_size: u64,
) -> Result<(TemporaryFile, fs::File), AppError> {
    create_bounded_thumbnail_source_file_with_limit(
        source_dir,
        path,
        expected_size,
        MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES,
    )
    .await
}

async fn create_bounded_thumbnail_source_file_with_limit(
    source_dir: &Path,
    path: &Path,
    expected_size: u64,
    max_total_size: u64,
) -> Result<(TemporaryFile, fs::File), AppError> {
    let _budget = ensure_thumbnail_source_capacity(
        source_dir,
        expected_size,
        max_total_size,
    )
    .await?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_THUMBNAIL_FILE_MODE)
        .open(path)
        .await
        .c(h!())?;
    let temporary_file = TemporaryFile::new(path.to_path_buf());
    file.set_len(expected_size).await.c(h!())?;
    Ok((temporary_file, file))
}

pub async fn stage_upload_thumbnail_source_file(
    config: &Config,
    media_id: Uuid,
    original_path: &Path,
    size_bytes: i64,
    delete_source: bool,
) -> Result<UploadThumbnailSourceStage, AppError> {
    let expected_size = u64::try_from(size_bytes).c(h!())?;
    with_thumbnail_operation(media_id, async {
        let original_path = fs::canonicalize(original_path).await.c(h!())?;
        if !regular_file_has_size(&original_path, Some(expected_size)).await? {
            return Err(AppError::BL {
                msg: format!(
                    "local thumbnail source is incomplete for media {media_id}"
                ),
            });
        }
        if jpeg_file_is_ready(&media_thumbnail_path(config, media_id)).await? {
            return Ok(UploadThumbnailSourceStage::Independent);
        }
        let source_dir = thumbnail_source_dir(config);
        let staged = stage_thumbnail_source_file_in_dir_locked(
            &source_dir,
            media_id,
            &original_path,
            expected_size,
            true,
            false,
        )
        .await;
        match staged {
            Ok(true) => {
                remove_file_if_present(&thumbnail_source_reference_path(
                    &source_dir,
                    media_id,
                ))
                .await?;
                clear_thumbnail_recovery(media_id);
                Ok(UploadThumbnailSourceStage::Independent)
            }
            Ok(false) => {
                stage_thumbnail_source_reference_locked(
                    &source_dir,
                    media_id,
                    &original_path,
                    expected_size,
                    delete_source,
                )
                .await?;
                clear_thumbnail_recovery(media_id);
                Ok(UploadThumbnailSourceStage::Referenced)
            }
            Err(error) => {
                warn!(
                    "failed to hard-link thumbnail source for media {media_id}; retaining a local source reference: {error:#?}"
                );
                stage_thumbnail_source_reference_locked(
                    &source_dir,
                    media_id,
                    &original_path,
                    expected_size,
                    delete_source,
                )
                .await?;
                clear_thumbnail_recovery(media_id);
                Ok(UploadThumbnailSourceStage::Referenced)
            }
        }
    })
    .await
}

async fn stage_thumbnail_source_reference_locked(
    source_dir: &Path,
    media_id: Uuid,
    source_path: &Path,
    expected_size: u64,
    delete_source: bool,
) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(source_path).await.c(h!())?;
    if !metadata.file_type().is_file() || metadata.len() != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "local thumbnail source changed before reference staging for media {media_id}"
            ),
        });
    }
    let reference = ThumbnailSourceReference {
        source_path: source_path.to_path_buf(),
        expected_size,
        source_device: metadata.dev(),
        source_inode: metadata.ino(),
        delete_source,
    };
    let reference_path = thumbnail_source_reference_path(source_dir, media_id);
    if read_thumbnail_source_reference(&reference_path)
        .await?
        .as_ref()
        == Some(&reference)
    {
        return Ok(());
    }
    remove_file_if_present(&reference_path).await?;
    let data = serde_json::to_vec(&reference).c(h!())?;
    let data_size = u64::try_from(data.len()).c(h!())?;
    if data_size
        > MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_FILE_SIZE_BYTES
    {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source reference for media {media_id} exceeds the size limit"
            ),
        });
    }
    let _budget = ensure_thumbnail_source_reference_capacity(
        source_dir, &reference, data_size,
    )
    .await?;
    let temp_path = temporary_path(&reference_path, None);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_THUMBNAIL_FILE_MODE)
        .open(&temp_path)
        .await
        .c(h!())?;
    let temp_file = TemporaryFile::new(temp_path);
    write_private_file(&mut file, &data).await?;
    drop(file);
    temp_file.publish(&reference_path).await
}

pub async fn try_stage_thumbnail_source_file(
    config: &Config,
    media_id: Uuid,
    original_path: &Path,
    size_bytes: i64,
) -> Result<bool, AppError> {
    let expected_size = u64::try_from(size_bytes).c(h!())?;
    let operation = ThumbnailOperation::new(media_id);
    let Some(_guard) = operation.try_lock() else {
        return Ok(false);
    };
    stage_thumbnail_source_file_locked(
        config,
        media_id,
        original_path,
        expected_size,
        true,
    )
    .await
}

async fn stage_thumbnail_source_file_locked(
    config: &Config,
    media_id: Uuid,
    original_path: &Path,
    expected_size: u64,
    allow_copy: bool,
) -> Result<bool, AppError> {
    if jpeg_file_is_ready(&media_thumbnail_path(config, media_id)).await? {
        return Ok(true);
    }
    let staged = stage_thumbnail_source_file_in_dir_locked(
        &thumbnail_source_dir(config),
        media_id,
        original_path,
        expected_size,
        true,
        allow_copy,
    )
    .await?;
    if staged {
        clear_thumbnail_recovery(media_id);
    }
    Ok(staged)
}

pub async fn try_stage_thumbnail_source_bytes(
    config: &Config,
    media_id: Uuid,
    data: &[u8],
) -> Result<bool, AppError> {
    let operation = ThumbnailOperation::new(media_id);
    let Some(_guard) = operation.try_lock() else {
        return Ok(false);
    };
    if jpeg_file_is_ready(&media_thumbnail_path(config, media_id)).await? {
        return Ok(true);
    }
    stage_thumbnail_source_bytes_in_dir_locked(
        &thumbnail_source_dir(config),
        media_id,
        data,
    )
    .await?;
    clear_thumbnail_recovery(media_id);
    Ok(true)
}

pub async fn generate_thumbnail_from_bytes(
    config: &Config,
    media_id: Uuid,
    data: &[u8],
) -> Result<(), AppError> {
    generate_thumbnail_from_bytes_in_paths(
        &thumbnail_source_dir(config),
        &media_thumbnail_path(config, media_id),
        media_id,
        data,
    )
    .await
}

pub async fn generate_thumbnail_from_source_file(
    config: &Config,
    media_id: Uuid,
    source_path: &Path,
    expected_size: u64,
) -> Result<(), AppError> {
    with_thumbnail_operation(media_id, async {
        if !regular_file_has_size(source_path, Some(expected_size)).await? {
            return Err(AppError::BL {
                msg: format!(
                    "local thumbnail source is incomplete for media {media_id}"
                ),
            });
        }
        let thumbnail_path = media_thumbnail_path(config, media_id);
        if jpeg_file_is_ready(&thumbnail_path).await? {
            return Ok(());
        }
        generate_thumbnail(source_path, &thumbnail_path, media_id).await
    })
    .await
}

async fn generate_thumbnail_from_bytes_in_paths(
    source_dir: &Path,
    thumbnail_path: &Path,
    media_id: Uuid,
    data: &[u8],
) -> Result<(), AppError> {
    with_thumbnail_operation(media_id, async {
        generate_thumbnail_from_bytes_locked(
            source_dir,
            thumbnail_path,
            media_id,
            data,
        )
        .await
    })
    .await
}

async fn generate_thumbnail_from_bytes_locked(
    source_dir: &Path,
    thumbnail_path: &Path,
    media_id: Uuid,
    data: &[u8],
) -> Result<(), AppError> {
    if jpeg_file_is_ready(thumbnail_path).await? {
        return Ok(());
    }
    ensure_private_dir(source_dir).await?;
    let source_path = temporary_thumbnail_source_path(source_dir, media_id);
    let (_source_file, mut source) = create_bounded_thumbnail_source_file(
        source_dir,
        &source_path,
        data.len() as u64,
    )
    .await?;
    write_private_file(&mut source, data).await?;
    drop(source);
    generate_thumbnail(&source_path, thumbnail_path, media_id).await
}

async fn recover_encrypted_thumbnail(
    env: &Env,
    media: &signal_message_media::Model,
    thumbnail_path: &Path,
    expected_size: u64,
) -> Result<(), AppError> {
    if media_cache::should_cache_media(media.size_bytes) {
        let cache_path = media_cache::ensure_media_cached(env, media).await?;
        return generate_thumbnail(&cache_path, thumbnail_path, media.id).await;
    }

    let s3_config = env.config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    let data = storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout(
        &env.s3,
        &env.s3_config,
        &s3_config.strongbox_key,
        &media_object_key(media),
        Duration::from_secs(
            MESSENGER_MEDIA_THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_SECS,
        ),
    )
    .await?;
    if data.len() as u64 != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail recovery size mismatch for {}: expected {expected_size}, got {}",
                media.id,
                data.len()
            ),
        });
    }
    generate_thumbnail_from_bytes_locked(
        &thumbnail_source_dir(&env.config),
        thumbnail_path,
        media.id,
        &data,
    )
    .await
}

async fn recover_plaintext_thumbnail(
    env: &Env,
    media: &signal_message_media::Model,
    thumbnail_path: &Path,
    expected_size: u64,
) -> Result<(), AppError> {
    if expected_size == 0
        || expected_size > MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES
    {
        return Err(AppError::BL {
            msg: format!(
                "media {} cannot fit in the bounded thumbnail recovery source",
                media.id
            ),
        });
    }
    let source_dir = thumbnail_source_dir(&env.config);
    ensure_private_dir(&source_dir).await?;
    let source_path = temporary_thumbnail_source_path(&source_dir, media.id);
    let (_source_file, destination) = create_bounded_thumbnail_source_file(
        &source_dir,
        &source_path,
        expected_size,
    )
    .await?;
    write_plaintext_thumbnail_source(env, media, destination, expected_size)
        .await?;
    generate_thumbnail(&source_path, thumbnail_path, media.id).await
}

async fn write_plaintext_thumbnail_source(
    env: &Env,
    media: &signal_message_media::Model,
    mut destination: fs::File,
    expected_size: u64,
) -> Result<(), AppError> {
    let mut source =
        stream_plaintext_media_range(env, media, 0..expected_size).await?;
    let media_id = media.id;
    let written = tokio::time::timeout(
        Duration::from_secs(
            MESSENGER_MEDIA_THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_SECS,
        ),
        async {
            let mut written = 0_u64;
            while let Some(chunk) = source.try_next().await.c(h!())? {
                written = written
                    .checked_add(u64::try_from(chunk.len()).c(h!())?)
                    .ok_or(AppError::BL {
                        msg: format!(
                            "thumbnail recovery byte count overflowed for {media_id}"
                        ),
                    })?;
                if written > expected_size {
                    return Err(AppError::BL {
                        msg: format!(
                            "thumbnail recovery exceeded expected size for {media_id}"
                        ),
                    });
                }
                destination.write_all(&chunk).await.c(h!())?;
            }
            destination.flush().await.c(h!())?;
            Ok::<u64, AppError>(written)
        },
    )
    .await
    .map_err(|_| AppError::BL {
        msg: format!("thumbnail recovery timed out for {media_id}"),
    })??;
    if written != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail recovery size mismatch for {media_id}: expected {expected_size}, got {written}"
            ),
        });
    }
    Ok(())
}

fn temporary_thumbnail_source_path(
    source_dir: &Path,
    media_id: Uuid,
) -> PathBuf {
    temporary_path(
        &source_dir.join(format!(
            "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        )),
        None,
    )
}

#[cfg(test)]
async fn stage_thumbnail_source_file_in_dir(
    source_dir: &Path,
    media_id: Uuid,
    original_path: &Path,
    expected_size: u64,
) -> Result<(), AppError> {
    with_thumbnail_operation(
        media_id,
        stage_thumbnail_source_file_in_dir_locked(
            source_dir,
            media_id,
            original_path,
            expected_size,
            true,
            true,
        ),
    )
    .await?;
    Ok(())
}

async fn stage_thumbnail_source_file_in_dir_locked(
    source_dir: &Path,
    media_id: Uuid,
    original_path: &Path,
    expected_size: u64,
    allow_hard_link: bool,
    allow_copy: bool,
) -> Result<bool, AppError> {
    if !regular_file_has_size(original_path, Some(expected_size)).await? {
        return Err(AppError::BL {
            msg: format!(
                "local thumbnail source is incomplete for media {media_id}"
            ),
        });
    }
    ensure_private_dir(source_dir).await?;
    let source_path = source_dir.join(format!(
        "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
    ));
    if regular_file_has_size(&source_path, Some(expected_size)).await? {
        return Ok(true);
    }
    remove_file_if_present(&source_path).await?;

    let temp_path = temporary_path(&source_path, None);
    let temp_file = if allow_hard_link
        && try_stage_hard_link(
            source_dir,
            original_path,
            &temp_path,
            expected_size,
        )
        .await?
    {
        TemporaryFile::new(temp_path.clone())
    } else if allow_copy {
        copy_private_file(source_dir, original_path, &temp_path, expected_size)
            .await?
    } else {
        return Ok(false);
    };
    temp_file.publish(&source_path).await?;
    Ok(true)
}

#[cfg(test)]
async fn stage_thumbnail_source_bytes_in_dir(
    source_dir: &Path,
    media_id: Uuid,
    data: &[u8],
) -> Result<(), AppError> {
    with_thumbnail_operation(
        media_id,
        stage_thumbnail_source_bytes_in_dir_locked(source_dir, media_id, data),
    )
    .await
}

async fn stage_thumbnail_source_bytes_in_dir_locked(
    source_dir: &Path,
    media_id: Uuid,
    data: &[u8],
) -> Result<(), AppError> {
    ensure_private_dir(source_dir).await?;
    let source_path = source_dir.join(format!(
        "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
    ));
    if regular_file_has_size(&source_path, Some(data.len() as u64)).await? {
        return Ok(());
    }
    remove_file_if_present(&source_path).await?;

    let temp_path = temporary_path(&source_path, None);
    let (temp_file, mut file) = create_bounded_thumbnail_source_file(
        source_dir,
        &temp_path,
        data.len() as u64,
    )
    .await?;
    write_private_file(&mut file, data).await?;
    drop(file);
    temp_file.publish(&source_path).await
}

async fn try_stage_hard_link(
    source_dir: &Path,
    original_path: &Path,
    temp_path: &Path,
    expected_size: u64,
) -> Result<bool, AppError> {
    let metadata = match fs::symlink_metadata(original_path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(err) => return Err(err.into()),
    };
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    let _budget = ensure_thumbnail_source_capacity(
        source_dir,
        expected_size,
        MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES,
    )
    .await?;
    match fs::hard_link(original_path, temp_path).await {
        Ok(()) => {
            if !regular_file_has_size(temp_path, Some(expected_size)).await? {
                remove_file_if_present(temp_path).await?;
                return Err(AppError::BL {
                    msg: "local thumbnail source changed while linking"
                        .to_string(),
                });
            }
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

async fn write_private_file(
    file: &mut fs::File,
    data: &[u8],
) -> Result<(), AppError> {
    file.write_all(data).await.c(h!())?;
    file.flush().await.c(h!())?;
    Ok(())
}

async fn copy_private_file(
    source_dir: &Path,
    source_path: &Path,
    destination_path: &Path,
    expected_size: u64,
) -> Result<TemporaryFile, AppError> {
    let source = fs::File::open(source_path).await.c(h!())?;
    let read_limit = expected_size.checked_add(1).ok_or(AppError::BL {
        msg: "thumbnail source copy read limit overflowed".to_string(),
    })?;
    let mut source = source.take(read_limit);
    let (temporary_file, mut destination) =
        create_bounded_thumbnail_source_file(
            source_dir,
            destination_path,
            expected_size,
        )
        .await?;
    let copied = tokio::io::copy(&mut source, &mut destination)
        .await
        .c(h!())?;
    if copied != expected_size {
        return Err(AppError::BL {
            msg: format!(
                "local thumbnail source changed while copying: expected {expected_size}, got {copied}"
            ),
        });
    }
    destination.flush().await.c(h!())?;
    Ok(temporary_file)
}

pub async fn run_thumbnail_worker_nofail(env: Arc<Env>) {
    info!("starting messenger media thumbnail worker");
    let mut retries = HashMap::new();
    let mut next_orphan_cleanup = Instant::now();
    loop {
        let _loop_guard = crate::utils::worker_watch::loop_guard(
            "messenger_media_thumbnail_worker",
        );
        if let Err(err) = run_thumbnail_worker_pass(
            &env,
            &mut retries,
            &mut next_orphan_cleanup,
        )
        .await
        {
            error!("messenger media thumbnail worker failed: {err:#?}");
        }
        tokio::time::sleep(Duration::from_secs(
            MESSENGER_MEDIA_THUMBNAIL_WORKER_SCAN_INTERVAL_SECS,
        ))
        .await;
    }
}

async fn run_thumbnail_worker_pass(
    env: &Env,
    retries: &mut HashMap<Uuid, RetryState>,
    next_orphan_cleanup: &mut Instant,
) -> Result<(), AppError> {
    ensure_private_dir(&thumbnail_dir(&env.config)).await?;
    ensure_private_dir(&thumbnail_source_dir(&env.config)).await?;
    if Instant::now() >= *next_orphan_cleanup {
        cleanup_stale_temporary_files(&thumbnail_dir(&env.config)).await?;
        cleanup_stale_temporary_files(&thumbnail_source_dir(&env.config))
            .await?;
        if let Err(err) = cleanup_orphaned_thumbnail_files(env).await {
            warn!(
                "failed to clean orphaned messenger media thumbnails: {err:#?}"
            );
        }
        cleanup_thumbnail_sources(
            &thumbnail_source_dir(&env.config),
            retries,
            Duration::from_secs(MESSENGER_MEDIA_THUMBNAIL_SOURCE_TTL_SECS),
            MESSENGER_MEDIA_THUMBNAIL_SOURCE_MAX_TOTAL_SIZE_BYTES,
        )
        .await?;
        *next_orphan_cleanup = Instant::now()
            + Duration::from_secs(
                MESSENGER_MEDIA_THUMBNAIL_ORPHAN_CLEANUP_INTERVAL_SECS,
            );
    }

    let mut entries = fs::read_dir(thumbnail_source_dir(&env.config))
        .await
        .c(h!())?;
    let mut present_sources = HashSet::new();
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let Some((media_id, kind)) = thumbnail_queue_entry(&entry.file_name())
        else {
            continue;
        };
        present_sources.insert(media_id);
        match kind {
            ThumbnailQueueEntryKind::StagedSource => {
                process_thumbnail_source(env, media_id, entry.path(), retries)
                    .await;
            }
            ThumbnailQueueEntryKind::SourceReference => {
                process_thumbnail_source_reference(
                    env,
                    media_id,
                    entry.path(),
                    retries,
                )
                .await;
            }
        }
    }
    prune_thumbnail_retry_state(retries, &present_sources);
    Ok(())
}

fn prune_thumbnail_retry_state(
    retries: &mut HashMap<Uuid, RetryState>,
    present_sources: &HashSet<Uuid>,
) {
    retries.retain(|media_id, _| present_sources.contains(media_id));
}

struct CompletedThumbnailEntry {
    media_id: Uuid,
    path: PathBuf,
    size: u64,
    changed: SystemTime,
}

async fn cleanup_orphaned_thumbnail_files(env: &Env) -> Result<(), AppError> {
    let mut entries = fs::read_dir(thumbnail_dir(&env.config)).await.c(h!())?;
    let mut thumbnails = Vec::new();
    loop {
        let mut batch = read_completed_thumbnail_batch(
            &mut entries,
            MESSENGER_MEDIA_THUMBNAIL_ORPHAN_QUERY_BATCH_SIZE,
        )
        .await?;
        if batch.is_empty() {
            break;
        }
        thumbnails.append(&mut batch);
    }
    thumbnails.sort_by_key(|thumbnail| std::cmp::Reverse(thumbnail.changed));

    let mut retained_size = 0_u64;
    let now = SystemTime::now();
    let mut thumbnails = thumbnails.into_iter();
    loop {
        let thumbnails = thumbnails
            .by_ref()
            .take(MESSENGER_MEDIA_THUMBNAIL_ORPHAN_QUERY_BATCH_SIZE)
            .collect::<Vec<_>>();
        if thumbnails.is_empty() {
            return Ok(());
        }
        cleanup_completed_thumbnail_batch(
            env,
            thumbnails,
            &mut retained_size,
            now,
        )
        .await?;
    }
}

async fn read_completed_thumbnail_batch(
    entries: &mut fs::ReadDir,
    max_entries: usize,
) -> Result<Vec<CompletedThumbnailEntry>, AppError> {
    let max_entries = max_entries.max(1);
    let mut thumbnails = Vec::with_capacity(max_entries);
    while thumbnails.len() < max_entries {
        let Some(entry) = entries.next_entry().await.c(h!())? else {
            break;
        };
        let Some(media_id) = completed_thumbnail_media_id(&entry.file_name())
        else {
            continue;
        };
        if !entry.file_type().await.c(h!())?.is_file() {
            continue;
        }
        let metadata = entry.metadata().await.c(h!())?;
        thumbnails.push(CompletedThumbnailEntry {
            media_id,
            path: entry.path(),
            size: metadata.len(),
            changed: metadata_changed_time(&metadata),
        });
    }
    Ok(thumbnails)
}

async fn cleanup_completed_thumbnail_batch(
    env: &Env,
    thumbnails: Vec<CompletedThumbnailEntry>,
    retained_size: &mut u64,
    now: SystemTime,
) -> Result<(), AppError> {
    let existing_media_ids = signal_message_media::Entity::find()
        .select_only()
        .column(signal_message_media::Column::Id)
        .filter(
            signal_message_media::Column::Id
                .is_in(thumbnails.iter().map(|thumbnail| thumbnail.media_id)),
        )
        .into_tuple::<Uuid>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    clean_completed_thumbnail_entries(
        thumbnails,
        &existing_media_ids,
        retained_size,
        now,
    )
    .await;
    Ok(())
}

async fn clean_completed_thumbnail_entries(
    thumbnails: Vec<CompletedThumbnailEntry>,
    existing_media_ids: &HashSet<Uuid>,
    retained_size: &mut u64,
    _now: SystemTime,
) {
    for thumbnail in thumbnails {
        let is_active = thumbnail_source_is_active(thumbnail.media_id);
        if is_active {
            *retained_size = retained_size.saturating_add(thumbnail.size);
            continue;
        }
        let is_orphaned = !existing_media_ids.contains(&thumbnail.media_id);
        let exceeds_size_limit = retained_size
            .checked_add(thumbnail.size)
            .is_none_or(|size| {
                size > MESSENGER_MEDIA_THUMBNAIL_MAX_TOTAL_SIZE_BYTES
            });
        if !is_orphaned && !exceeds_size_limit {
            *retained_size = retained_size.saturating_add(thumbnail.size);
            continue;
        }
        let description = if is_orphaned {
            "orphaned messenger media thumbnail"
        } else {
            "over-budget messenger media thumbnail"
        };
        let removed = remove_thumbnail_paths_best_effort(
            thumbnail.media_id,
            std::slice::from_ref(&thumbnail.path),
            description,
        )
        .await;
        if !removed {
            *retained_size = retained_size.saturating_add(thumbnail.size);
            continue;
        }
        info!(
            "removed {description} file={} media_id={}",
            thumbnail.path.display(),
            thumbnail.media_id
        );
    }
}

fn completed_thumbnail_media_id(file_name: &OsStr) -> Option<Uuid> {
    let file_name = file_name.to_str()?;
    let media_id =
        file_name.strip_suffix(MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX)?;
    Uuid::parse_str(media_id).ok()
}

fn thumbnail_source_media_id(file_name: &OsStr) -> Option<Uuid> {
    let file_name = file_name.to_str()?;
    let media_id =
        file_name.strip_suffix(MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX)?;
    Uuid::parse_str(media_id).ok()
}

fn thumbnail_source_reference_media_id(file_name: &OsStr) -> Option<Uuid> {
    let file_name = file_name.to_str()?;
    let media_id = file_name
        .strip_suffix(MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_FILE_SUFFIX)?;
    Uuid::parse_str(media_id).ok()
}

fn thumbnail_queue_entry(
    file_name: &OsStr,
) -> Option<(Uuid, ThumbnailQueueEntryKind)> {
    if let Some(media_id) = thumbnail_source_media_id(file_name) {
        return Some((media_id, ThumbnailQueueEntryKind::StagedSource));
    }
    thumbnail_source_reference_media_id(file_name)
        .map(|media_id| (media_id, ThumbnailQueueEntryKind::SourceReference))
}

async fn process_thumbnail_source(
    env: &Env,
    media_id: Uuid,
    source_path: PathBuf,
    retries: &mut HashMap<Uuid, RetryState>,
) {
    if thumbnail_source_is_active(media_id)
        || retry_is_pending(retries, media_id)
    {
        return;
    }
    let operation = ThumbnailOperation::new(media_id);
    let _operation_guard = operation.lock().await;
    match generate_staged_thumbnail_locked(env, media_id, &source_path).await {
        Ok(()) => {
            retries.remove(&media_id);
        }
        Err(err) => {
            let (failures, delay) = record_retry_failure(retries, media_id);
            if failures >= MESSENGER_MEDIA_THUMBNAIL_MAX_RETRY_ATTEMPTS {
                match remove_file_if_present(&source_path).await {
                    Ok(()) => {
                        retries.remove(&media_id);
                        mark_thumbnail_recovery_terminal(media_id, failures);
                    }
                    Err(remove_err) => {
                        warn!(
                            "failed to discard thumbnail source for media {media_id}: {remove_err:#?}"
                        );
                        return;
                    }
                }
                warn!(
                    "discarded video thumbnail source for media {media_id} after {failures} failures: {err:#?}"
                );
                return;
            }
            warn!(
                "video thumbnail generation failed for media {}; retrying in {}s: {err:#?}",
                media_id,
                delay.as_secs()
            );
        }
    }
}

async fn process_thumbnail_source_reference(
    env: &Env,
    media_id: Uuid,
    reference_path: PathBuf,
    retries: &mut HashMap<Uuid, RetryState>,
) {
    if thumbnail_source_is_active(media_id)
        || retry_is_pending(retries, media_id)
    {
        return;
    }
    let operation = ThumbnailOperation::new(media_id);
    let _operation_guard = operation.lock().await;
    match generate_referenced_thumbnail_locked(env, media_id, &reference_path)
        .await
    {
        Ok(()) => {
            retries.remove(&media_id);
        }
        Err(err) => {
            let (failures, delay) = record_retry_failure(retries, media_id);
            if failures >= MESSENGER_MEDIA_THUMBNAIL_MAX_RETRY_ATTEMPTS {
                match discard_thumbnail_source_reference_locked(
                    env,
                    media_id,
                    &reference_path,
                )
                .await
                {
                    Ok(()) => {
                        retries.remove(&media_id);
                        mark_thumbnail_recovery_terminal(media_id, failures);
                    }
                    Err(remove_err) => {
                        warn!(
                            "failed to discard thumbnail source reference for media {media_id}: {remove_err:#?}"
                        );
                        return;
                    }
                }
                warn!(
                    "discarded video thumbnail source reference for media {media_id} after {failures} failures: {err:#?}"
                );
                return;
            }
            warn!(
                "video thumbnail generation from a local source reference failed for media {}; retrying in {}s: {err:#?}",
                media_id,
                delay.as_secs()
            );
        }
    }
}

fn retry_is_pending(
    retries: &HashMap<Uuid, RetryState>,
    media_id: Uuid,
) -> bool {
    retries
        .get(&media_id)
        .is_some_and(|retry| retry.retry_at > Instant::now())
}

fn record_retry_failure(
    retries: &mut HashMap<Uuid, RetryState>,
    media_id: Uuid,
) -> (u32, Duration) {
    let failures = retries
        .get(&media_id)
        .map_or(1, |retry| retry.failures.saturating_add(1));
    let shift = failures.saturating_sub(1).min(16);
    let delay_secs = MESSENGER_MEDIA_THUMBNAIL_RETRY_INITIAL_SECS
        .saturating_mul(1_u64 << shift)
        .min(MESSENGER_MEDIA_THUMBNAIL_RETRY_MAX_SECS);
    let delay = Duration::from_secs(delay_secs);
    retries.insert(
        media_id,
        RetryState {
            failures,
            retry_at: Instant::now() + delay,
        },
    );
    (failures, delay)
}

struct ThumbnailSourceEntry {
    media_id: Uuid,
    path: PathBuf,
    size: u64,
    changed: SystemTime,
}

async fn cleanup_thumbnail_sources(
    source_dir: &Path,
    retries: &mut HashMap<Uuid, RetryState>,
    max_age: Duration,
    max_total_size: u64,
) -> Result<(), AppError> {
    let mut total_size = 0_u64;
    let mut sources = Vec::new();
    let mut entries = fs::read_dir(source_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let Some(media_id) = thumbnail_source_media_id(&entry.file_name())
        else {
            continue;
        };
        let metadata = entry.metadata().await.c(h!())?;
        if !metadata.is_file() {
            continue;
        }
        if thumbnail_source_is_active(media_id) {
            total_size = total_size.saturating_add(metadata.len());
            continue;
        }
        let changed = metadata_changed_time(&metadata);
        if SystemTime::now()
            .duration_since(changed)
            .unwrap_or_default()
            > max_age
            && remove_thumbnail_source_if_expired(
                media_id,
                &entry.path(),
                max_age,
            )
            .await?
        {
            retries.remove(&media_id);
            info!(
                "removed expired messenger media thumbnail source file={}",
                entry.path().display()
            );
            continue;
        }
        total_size = total_size.saturating_add(metadata.len());
        sources.push(ThumbnailSourceEntry {
            media_id,
            path: entry.path(),
            size: metadata.len(),
            changed,
        });
    }

    sources.sort_by_key(|source| source.changed);
    for source in sources {
        if total_size <= max_total_size {
            break;
        }
        let removed = remove_thumbnail_paths_best_effort(
            source.media_id,
            std::slice::from_ref(&source.path),
            "over-budget messenger media thumbnail source",
        )
        .await;
        if !removed {
            continue;
        }
        retries.remove(&source.media_id);
        total_size = total_size.saturating_sub(source.size);
        info!(
            "removed messenger media thumbnail source for size limit file={} size={} remaining_size={total_size}",
            source.path.display(),
            source.size
        );
    }
    if total_size > max_total_size {
        warn!(
            "messenger media thumbnail sources remain over size limit current_size={total_size} max_size={max_total_size}; active or failed-to-delete sources were preserved"
        );
    }
    Ok(())
}

fn metadata_changed_time(metadata: &std::fs::Metadata) -> SystemTime {
    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
}

async fn remove_thumbnail_source_if_expired(
    media_id: Uuid,
    source_path: &Path,
    max_age: Duration,
) -> Result<bool, AppError> {
    let operation = ThumbnailOperation::new(media_id);
    let _operation_guard = operation.lock().await;
    if thumbnail_source_is_active(media_id)
        || !file_is_older_than(source_path, max_age).await?
    {
        return Ok(false);
    }
    remove_file_if_present(source_path).await?;
    Ok(true)
}

async fn generate_staged_thumbnail_locked(
    env: &Env,
    media_id: Uuid,
    source_path: &Path,
) -> Result<(), AppError> {
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let Some(media) = media else {
        if file_is_older_than(
            source_path,
            Duration::from_secs(
                MESSENGER_MEDIA_THUMBNAIL_ORPHAN_SOURCE_TTL_SECS,
            ),
        )
        .await?
        {
            remove_file_if_present(source_path).await?;
        }
        return Ok(());
    };
    if !is_video_media(&media) {
        remove_file_if_present(source_path).await?;
        return Ok(());
    }
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    if !regular_file_has_size(source_path, Some(expected_size)).await? {
        return Err(AppError::BL {
            msg: format!(
                "staged thumbnail source is incomplete for media {media_id}"
            ),
        });
    }

    let thumbnail_path = media_thumbnail_path(&env.config, media_id);
    if jpeg_file_is_ready(&thumbnail_path).await? {
        remove_file_if_present(source_path).await?;
        return Ok(());
    }
    generate_thumbnail(source_path, &thumbnail_path, media_id).await?;
    remove_file_if_present(source_path).await
}

async fn generate_referenced_thumbnail_locked(
    env: &Env,
    media_id: Uuid,
    reference_path: &Path,
) -> Result<(), AppError> {
    let Some(reference) =
        read_thumbnail_source_reference(reference_path).await?
    else {
        return Ok(());
    };
    let media = signal_message_media::Entity::find_by_id(media_id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    let Some(media) = media else {
        if file_is_older_than(
            reference_path,
            Duration::from_secs(
                MESSENGER_MEDIA_THUMBNAIL_ORPHAN_SOURCE_TTL_SECS,
            ),
        )
        .await?
        {
            finalize_thumbnail_source_reference_locked(
                &thumbnail_source_dir(&env.config),
                reference_path,
                true,
            )
            .await?;
        }
        return Ok(());
    };
    if !is_video_media(&media) {
        return finalize_thumbnail_source_reference_locked(
            &thumbnail_source_dir(&env.config),
            reference_path,
            true,
        )
        .await;
    }
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    if reference.expected_size != expected_size
        || !thumbnail_source_reference_matches_file(&reference).await?
    {
        warn!(
            "discarding incomplete local thumbnail source reference for media {media_id}; object-storage recovery remains available"
        );
        return finalize_thumbnail_source_reference_locked(
            &thumbnail_source_dir(&env.config),
            reference_path,
            true,
        )
        .await;
    }

    let thumbnail_path = media_thumbnail_path(&env.config, media_id);
    if !jpeg_file_is_ready(&thumbnail_path).await? {
        generate_thumbnail(&reference.source_path, &thumbnail_path, media_id)
            .await?;
    }
    finalize_thumbnail_source_reference_locked(
        &thumbnail_source_dir(&env.config),
        reference_path,
        true,
    )
    .await
}

async fn discard_thumbnail_source_reference_locked(
    env: &Env,
    _media_id: Uuid,
    reference_path: &Path,
) -> Result<(), AppError> {
    match read_thumbnail_source_reference(reference_path).await {
        Err(err) => {
            remove_file_if_present(reference_path).await?;
            warn!(
                "discarded unreadable thumbnail source reference file={}: {err:#?}",
                reference_path.display()
            );
            Ok(())
        }
        Ok(_) => {
            finalize_thumbnail_source_reference_locked(
                &thumbnail_source_dir(&env.config),
                reference_path,
                true,
            )
            .await
        }
    }
}

async fn generate_thumbnail(
    input_path: &Path,
    thumbnail_path: &Path,
    media_id: Uuid,
) -> Result<(), AppError> {
    let _generation_permit = THUMBNAIL_GENERATION_SEMAPHORE
        .clone()
        .acquire_owned()
        .await
        .c(h!())?;
    ensure_private_dir(thumbnail_path.parent().c(h!())?).await?;
    let temp_path = temporary_path(thumbnail_path, Some("jpg"));
    create_empty_private_file(&temp_path).await?;
    let temp_file = TemporaryFile::new(temp_path.clone());

    let status = match tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_THUMBNAIL_FFMPEG_TIMEOUT_SECS),
        build_thumbnail_command(input_path, &temp_path).status(),
    )
    .await
    {
        Ok(status) => status.c(h!())?,
        Err(_) => {
            return Err(AppError::BL {
                msg: format!(
                    "ffmpeg timed out generating thumbnail for media {media_id}"
                ),
            });
        }
    };
    if !status.success() {
        return Err(AppError::BL {
            msg: format!(
                "ffmpeg failed generating thumbnail for media {media_id} with status {status}"
            ),
        });
    }
    if !jpeg_file_is_ready(&temp_path).await? {
        return Err(AppError::BL {
            msg: format!(
                "ffmpeg produced an invalid thumbnail for media {media_id}"
            ),
        });
    }
    fs::set_permissions(
        &temp_path,
        std::fs::Permissions::from_mode(MESSENGER_MEDIA_THUMBNAIL_FILE_MODE),
    )
    .await
    .c(h!())?;
    temp_file.publish(thumbnail_path).await
}

fn build_thumbnail_command(input_path: &Path, output_path: &Path) -> Command {
    let mut command = Command::new(MESSENGER_MEDIA_THUMBNAIL_FFMPEG_BIN);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("-nostdin")
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(input_path)
        .arg("-map")
        .arg("0:v:0")
        .arg("-vf")
        .arg(MESSENGER_MEDIA_THUMBNAIL_FFMPEG_FILTER)
        .arg("-frames:v")
        .arg("1")
        .arg("-an")
        .arg("-sn")
        .arg("-threads")
        .arg("1")
        .arg("-f")
        .arg("image2")
        .arg("-c:v")
        .arg("mjpeg")
        .arg(output_path);
    command
}

async fn create_empty_private_file(path: &Path) -> Result<(), AppError> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_THUMBNAIL_FILE_MODE)
        .open(path)
        .await
        .c(h!())?;
    Ok(())
}

async fn ensure_private_dir(path: &Path) -> Result<(), AppError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(MESSENGER_MEDIA_THUMBNAIL_DIR_MODE)
        .create(path)
        .await
        .c(h!())?;
    fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(MESSENGER_MEDIA_THUMBNAIL_DIR_MODE),
    )
    .await
    .c(h!())?;
    Ok(())
}

fn temporary_path(path: &Path, extension: Option<&str>) -> PathBuf {
    let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or("media");
    let suffix =
        extension.map_or_else(String::new, |extension| format!(".{extension}"));
    path.with_file_name(format!("{file_name}.tmp-{}{suffix}", Uuid::new_v4()))
}

async fn regular_file_has_size(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<bool, AppError> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(err) => return Err(err.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Ok(false);
    }
    Ok(expected_size
        .is_none_or(|expected_size| metadata.len() == expected_size))
}

async fn jpeg_file_is_ready(path: &Path) -> Result<bool, AppError> {
    if !regular_file_has_size(path, None).await? {
        return Ok(false);
    }
    let mut file = fs::File::open(path).await.c(h!())?;
    let mut magic = [0_u8; 3];
    match file.read_exact(&mut magic).await {
        Ok(_) => Ok(magic == [0xff, 0xd8, 0xff]),
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
            Ok(false)
        }
        Err(err) => Err(err.into()),
    }
}

async fn file_is_older_than(
    path: &Path,
    age: Duration,
) -> Result<bool, AppError> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(err) => return Err(err.into()),
    };
    let changed = metadata_changed_time(&metadata);
    Ok(SystemTime::now()
        .duration_since(changed)
        .unwrap_or_default()
        > age)
}

async fn remove_file_if_present(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

async fn read_thumbnail_source_reference(
    path: &Path,
) -> Result<Option<ThumbnailSourceReference>, AppError> {
    let metadata = match fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(err) => return Err(err.into()),
    };
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len()
            > MESSENGER_MEDIA_THUMBNAIL_SOURCE_REFERENCE_MAX_FILE_SIZE_BYTES
    {
        return Err(AppError::BL {
            msg: format!(
                "invalid thumbnail source reference file {}",
                path.display()
            ),
        });
    }
    let data = fs::read(path).await.c(h!())?;
    if u64::try_from(data.len()).c(h!())? != metadata.len() {
        return Err(AppError::BL {
            msg: format!(
                "thumbnail source reference changed while reading {}",
                path.display()
            ),
        });
    }
    let reference = serde_json::from_slice(&data).c(h!())?;
    Ok(Some(reference))
}

async fn finalize_thumbnail_source_reference_locked(
    source_dir: &Path,
    reference_path: &Path,
    delete_source: bool,
) -> Result<(), AppError> {
    let _budget = lock_thumbnail_source_budget(source_dir).await?;
    let Some(reference) =
        read_thumbnail_source_reference(reference_path).await?
    else {
        return Ok(());
    };
    if delete_source
        && reference.delete_source
        && !thumbnail_source_has_other_reference(
            source_dir,
            reference_path,
            &reference.source_path,
        )
        .await?
        && thumbnail_source_reference_matches_file(&reference).await?
    {
        remove_file_if_present(&reference.source_path).await?;
    }
    remove_file_if_present(reference_path).await
}

async fn thumbnail_source_reference_matches_file(
    reference: &ThumbnailSourceReference,
) -> Result<bool, AppError> {
    let metadata = match fs::symlink_metadata(&reference.source_path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(err) => return Err(err.into()),
    };
    Ok(metadata.file_type().is_file()
        && metadata.len() == reference.expected_size
        && metadata.dev() == reference.source_device
        && metadata.ino() == reference.source_inode)
}

async fn thumbnail_source_has_other_reference(
    source_dir: &Path,
    removed_reference_path: &Path,
    source_path: &Path,
) -> Result<bool, AppError> {
    let mut entries = fs::read_dir(source_dir).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        if entry.path() == removed_reference_path
            || thumbnail_source_reference_media_id(&entry.file_name()).is_none()
        {
            continue;
        }
        match read_thumbnail_source_reference(&entry.path()).await {
            Ok(Some(reference)) if reference.source_path == source_path => {
                return Ok(true);
            }
            Ok(_) => {}
            Err(err) => warn!(
                "failed to inspect thumbnail source reference file={}: {err:#?}",
                entry.path().display()
            ),
        }
    }
    Ok(false)
}

async fn cleanup_stale_temporary_files(
    directory: &Path,
) -> Result<(), AppError> {
    let now = SystemTime::now();
    let mut entries = fs::read_dir(directory).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !file_name.contains(".tmp-")
            || !entry.file_type().await.c(h!())?.is_file()
        {
            continue;
        }
        let modified = entry.metadata().await.c(h!())?.modified().c(h!())?;
        if now.duration_since(modified).unwrap_or_default()
            <= Duration::from_secs(MESSENGER_MEDIA_THUMBNAIL_TEMP_TTL_SECS)
        {
            continue;
        }
        match fs::remove_file(entry.path()).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn thumbnail_pending_response() -> HttpResponse {
    HttpResponse::Accepted()
        .insert_header((header::RETRY_AFTER, "2"))
        .insert_header(("x-messenger-media-thumbnail-status", "pending"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .finish()
}

fn thumbnail_failed_response(failures: u32) -> HttpResponse {
    HttpResponse::UnprocessableEntity()
        .insert_header(("x-messenger-media-thumbnail-status", "failed"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .body(format!(
            "thumbnail generation failed after {failures} attempts"
        ))
}

enum ThumbnailGenerationStatus {
    Pending,
    Failed(u32),
}

impl ThumbnailGenerationStatus {
    fn into_response(self) -> HttpResponse {
        match self {
            Self::Pending => thumbnail_pending_response(),
            Self::Failed(failures) => thumbnail_failed_response(failures),
        }
    }
}

async fn schedule_thumbnail_recovery_if_needed(
    env: &actix_web::web::Data<Env>,
    media: &signal_message_media::Model,
) -> Result<ThumbnailGenerationStatus, AppError> {
    if let Some(failures) = thumbnail_recovery_terminal_failures(media.id) {
        return Ok(ThumbnailGenerationStatus::Failed(failures));
    }
    let expected_size = u64::try_from(media.size_bytes).c(h!())?;
    let source_path = media_thumbnail_source_path(&env.config, media.id);
    if regular_file_has_size(&source_path, Some(expected_size)).await? {
        return Ok(ThumbnailGenerationStatus::Pending);
    }
    let reference_path =
        media_thumbnail_source_reference_path(&env.config, media.id);
    match read_thumbnail_source_reference(&reference_path).await {
        Ok(Some(_)) => return Ok(ThumbnailGenerationStatus::Pending),
        Ok(None) => {}
        Err(err) => warn!(
            "failed to inspect queued thumbnail source reference for media {}: {err:#?}",
            media.id
        ),
    }
    schedule_thumbnail_recovery(env.clone().into_inner(), media.clone());
    Ok(ThumbnailGenerationStatus::Pending)
}

#[get("/api/messenger/media/{media_id}/thumbnail")]
pub async fn messenger_media_thumbnail(
    user: actix_identity::Identity,
    req: HttpRequest,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<(Uuid,)>,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let media = signal_message_media::Entity::find_by_id(path.0)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if !is_video_media(&media) {
        return Err(AppError::NotFound);
    }
    ensure_media_access(&env.dbx, &login, media.signal_message_id).await?;

    let thumbnail_path = media_thumbnail_path(&env.config, media.id);
    if !jpeg_file_is_ready(&thumbnail_path).await? {
        return Ok(schedule_thumbnail_recovery_if_needed(&env, &media)
            .await?
            .into_response());
    }
    let file = match NamedFile::open_async(thumbnail_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(schedule_thumbnail_recovery_if_needed(&env, &media)
                .await?
                .into_response());
        }
        Err(err) => return Err(err.into()),
    }
    .set_content_type(actix_web::mime::IMAGE_JPEG)
    .use_etag(true)
    .use_last_modified(true);
    touch_thumbnail_file(file.path().to_path_buf());
    let mut response = file.into_response(&req);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-cache"),
    );
    Ok(response)
}

fn touch_thumbnail_file(path: PathBuf) {
    drop(tokio::task::spawn_blocking(move || {
        let result = std::fs::File::open(&path).and_then(|file| {
            file.set_times(
                std::fs::FileTimes::new().set_modified(SystemTime::now()),
            )
        });
        if let Err(error) = result {
            warn!(
                "failed to update messenger media thumbnail access time file={}: {error:?}",
                path.display()
            );
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_recovery_is_single_flight_and_cools_down_after_failure() {
        let media_id = Uuid::new_v4();
        let recovery = begin_thumbnail_recovery(media_id).unwrap();

        assert!(begin_thumbnail_recovery(media_id).is_none());
        recovery.complete(false);
        assert!(begin_thumbnail_recovery(media_id).is_none());

        THUMBNAIL_RECOVERIES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&media_id);
    }

    #[test]
    fn dropped_thumbnail_recovery_enters_cooldown() {
        let media_id = Uuid::new_v4();
        let recovery = begin_thumbnail_recovery(media_id).unwrap();
        drop(recovery);

        assert!(begin_thumbnail_recovery(media_id).is_none());

        THUMBNAIL_RECOVERIES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&media_id);
    }

    #[test]
    fn retryable_thumbnail_recovery_does_not_consume_an_attempt() {
        let media_id = Uuid::new_v4();
        let recovery = begin_thumbnail_recovery(media_id).unwrap();
        recovery.defer(2);

        let recoveries = THUMBNAIL_RECOVERIES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(matches!(
            recoveries.get(&media_id),
            Some(ThumbnailRecoveryState::CoolingDown { failures: 0, .. })
        ));
        drop(recoveries);
        clear_thumbnail_recovery(media_id);
    }

    #[test]
    fn successful_thumbnail_recovery_can_be_scheduled_again() {
        let media_id = Uuid::new_v4();
        let recovery = begin_thumbnail_recovery(media_id).unwrap();
        recovery.complete(true);

        let recovery = begin_thumbnail_recovery(media_id).unwrap();
        recovery.complete(true);
    }

    #[test]
    fn repeated_thumbnail_recovery_failures_become_terminal() {
        let media_id = Uuid::new_v4();
        for attempt in 1..=MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS
        {
            let recovery = begin_thumbnail_recovery(media_id).unwrap();
            recovery.complete(false);
            if attempt < MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS {
                let mut recoveries = THUMBNAIL_RECOVERIES
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let Some(ThumbnailRecoveryState::CoolingDown {
                    retry_at, ..
                }) = recoveries.get_mut(&media_id)
                else {
                    panic!("recovery should be cooling down");
                };
                *retry_at = Instant::now();
            }
        }

        assert_eq!(
            thumbnail_recovery_terminal_failures(media_id),
            Some(MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS)
        );
        let response = thumbnail_failed_response(
            MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_RETRY_ATTEMPTS,
        );
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            response
                .headers()
                .get("x-messenger-media-thumbnail-status")
                .unwrap(),
            "failed"
        );
        clear_thumbnail_recovery(media_id);
    }

    #[test]
    fn thumbnail_recovery_does_not_queue_behind_busy_work() {
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let (first_recovery, permit) =
            begin_scheduled_thumbnail_recovery(first_id).unwrap();

        assert!(begin_scheduled_thumbnail_recovery(second_id).is_none());

        first_recovery.complete(true);
        drop(permit);
        let (second_recovery, permit) =
            begin_scheduled_thumbnail_recovery(second_id).unwrap();
        second_recovery.complete(true);
        drop(permit);
    }

    #[test]
    fn full_recovery_state_evicts_non_running_work() {
        let failed_at = Instant::now();
        let mut recoveries = (0
            ..MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA)
            .map(|_| {
                (
                    Uuid::new_v4(),
                    ThumbnailRecoveryState::Terminal {
                        failures: 1,
                        failed_at,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let media_id = Uuid::new_v4();

        assert!(ensure_thumbnail_recovery_capacity(
            &mut recoveries,
            media_id
        ));
        recoveries
            .insert(media_id, ThumbnailRecoveryState::Running { failures: 0 });
        assert_eq!(
            recoveries.len(),
            MESSENGER_MEDIA_THUMBNAIL_RECOVERY_MAX_TRACKED_MEDIA
        );
    }

    #[tokio::test]
    async fn staged_hard_link_survives_original_removal() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let original_path = temp_dir.path().join("original.mp4");
        let data = b"local video";
        fs::write(&original_path, data).await.unwrap();
        let media_id = Uuid::new_v4();

        stage_thumbnail_source_file_in_dir(
            &source_dir,
            media_id,
            &original_path,
            data.len() as u64,
        )
        .await
        .unwrap();
        fs::remove_file(original_path).await.unwrap();

        let staged_path = source_dir.join(format!(
            "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        assert_eq!(fs::read(staged_path).await.unwrap(), data);
    }

    #[tokio::test]
    async fn upload_staging_does_not_copy_when_hard_links_are_unavailable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let original_path = temp_dir.path().join("original.mp4");
        let data = b"local video";
        fs::write(&original_path, data).await.unwrap();
        let media_id = Uuid::new_v4();

        let staged = stage_thumbnail_source_file_in_dir_locked(
            &source_dir,
            media_id,
            &original_path,
            data.len() as u64,
            false,
            false,
        )
        .await
        .unwrap();

        assert!(!staged);
        assert!(!source_dir
            .join(format!(
                "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
            ))
            .exists());
    }

    #[tokio::test]
    async fn source_reference_retains_bounded_local_source_without_copying() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let original_path = temp_dir.path().join("original.mp4");
        let data = vec![7_u8; 1024];
        fs::write(&original_path, &data).await.unwrap();
        let original_path = fs::canonicalize(original_path).await.unwrap();
        let media_id = Uuid::new_v4();

        stage_thumbnail_source_reference_locked(
            &source_dir,
            media_id,
            &original_path,
            data.len() as u64,
            true,
        )
        .await
        .unwrap();

        let reference_path =
            thumbnail_source_reference_path(&source_dir, media_id);
        assert!(reference_path.exists());
        assert!(
            fs::metadata(&reference_path).await.unwrap().len()
                < data.len() as u64
        );
        assert!(
            thumbnail_source_directory_size(&source_dir).await.unwrap()
                >= data.len() as u64
        );

        finalize_thumbnail_source_reference_locked(
            &source_dir,
            &reference_path,
            true,
        )
        .await
        .unwrap();
        assert!(!reference_path.exists());
        assert!(!original_path.exists());
    }

    #[tokio::test]
    async fn shared_source_is_deleted_after_its_last_reference() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let original_path = temp_dir.path().join("original.mp4");
        fs::write(&original_path, b"shared source").await.unwrap();
        let original_path = fs::canonicalize(original_path).await.unwrap();
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        for media_id in [first_id, second_id] {
            stage_thumbnail_source_reference_locked(
                &source_dir,
                media_id,
                &original_path,
                13,
                true,
            )
            .await
            .unwrap();
        }

        finalize_thumbnail_source_reference_locked(
            &source_dir,
            &thumbnail_source_reference_path(&source_dir, first_id),
            true,
        )
        .await
        .unwrap();
        assert!(original_path.exists());

        finalize_thumbnail_source_reference_locked(
            &source_dir,
            &thumbnail_source_reference_path(&source_dir, second_id),
            true,
        )
        .await
        .unwrap();
        assert!(!original_path.exists());
    }

    #[tokio::test]
    async fn file_copy_fallback_streams_to_a_private_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let original_path = temp_dir.path().join("original.mp4");
        let copied_path = temp_dir.path().join("copied.source");
        let data = b"local video copy";
        fs::write(&original_path, data).await.unwrap();

        let _copied_file = copy_private_file(
            temp_dir.path(),
            &original_path,
            &copied_path,
            data.len() as u64,
        )
        .await
        .unwrap();

        assert_eq!(fs::read(&copied_path).await.unwrap(), data);
        let mode = fs::metadata(copied_path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, MESSENGER_MEDIA_THUMBNAIL_FILE_MODE);
    }

    #[tokio::test]
    async fn file_copy_stops_after_the_first_excess_byte() {
        let temp_dir = tempfile::tempdir().unwrap();
        let original_path = temp_dir.path().join("growing.mp4");
        let copied_path = temp_dir.path().join("copied.source");
        fs::write(&original_path, b"too much video").await.unwrap();

        let error = match copy_private_file(
            temp_dir.path(),
            &original_path,
            &copied_path,
            3,
        )
        .await
        {
            Ok(_) => panic!("oversized source copy should fail"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            AppError::BL { msg } if msg.contains("expected 3, got 4")
        ));
        assert!(!copied_path.exists());
    }

    #[tokio::test]
    async fn byte_staging_is_reserved_for_already_decrypted_small_media() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let media_id = Uuid::new_v4();
        let data = b"already decrypted small video";

        stage_thumbnail_source_bytes_in_dir(&source_dir, media_id, data)
            .await
            .unwrap();

        let staged_path = source_dir.join(format!(
            "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        assert_eq!(fs::read(staged_path).await.unwrap(), data);
    }

    #[tokio::test]
    async fn source_budget_rejects_a_single_oversized_reservation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let source_path = source_dir.join("oversized.tmp");

        let result = create_bounded_thumbnail_source_file_with_limit(
            &source_dir,
            &source_path,
            11,
            10,
        )
        .await;

        assert!(result.is_err());
        assert!(!source_path.exists());
    }

    #[tokio::test]
    async fn concurrent_source_reservations_cannot_exceed_the_budget() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let first_dir = source_dir.clone();
        let second_dir = source_dir.clone();
        let first_path = source_dir.join("first.tmp");
        let second_path = source_dir.join("second.tmp");

        let (first, second) = tokio::join!(
            create_bounded_thumbnail_source_file_with_limit(
                &first_dir,
                &first_path,
                6,
                10,
            ),
            create_bounded_thumbnail_source_file_with_limit(
                &second_dir,
                &second_path,
                6,
                10,
            ),
        );

        assert_ne!(first.is_ok(), second.is_ok());
        assert!(
            thumbnail_source_directory_size(&source_dir).await.unwrap() <= 10
        );
    }

    #[tokio::test]
    async fn inline_generation_removes_temporary_source_after_failure() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source_dir = temp_dir.path().join("sources");
        let thumbnail_path = temp_dir.path().join("thumbnail.jpg");

        let result = generate_thumbnail_from_bytes_in_paths(
            &source_dir,
            &thumbnail_path,
            Uuid::new_v4(),
            b"not a video",
        )
        .await;

        assert!(result.is_err());
        assert!(directory_is_empty(&source_dir).await);
        assert!(!thumbnail_path.exists());
    }

    async fn directory_is_empty(path: &Path) -> bool {
        let mut entries = fs::read_dir(path).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry.file_name()
                != OsStr::new(
                    MESSENGER_MEDIA_THUMBNAIL_SOURCE_BUDGET_LOCK_FILE_NAME,
                )
            {
                return false;
            }
        }
        true
    }

    #[test]
    fn worker_queue_parser_accepts_only_staged_source_names() {
        let media_id = Uuid::new_v4();
        let source_name =
            format!("{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}");
        let temp_name = format!("{source_name}.tmp-{}", Uuid::new_v4());

        assert_eq!(
            thumbnail_source_media_id(OsStr::new(&source_name)),
            Some(media_id)
        );
        assert_eq!(
            thumbnail_source_media_id(OsStr::new(&media_id.to_string())),
            None
        );
        assert_eq!(thumbnail_source_media_id(OsStr::new(&temp_name)), None);
    }

    #[test]
    fn completed_thumbnail_parser_accepts_only_published_names() {
        let media_id = Uuid::new_v4();
        let thumbnail_name =
            format!("{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}");
        let temp_name = format!(
            "{thumbnail_name}.tmp-{}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}",
            Uuid::new_v4()
        );

        assert_eq!(
            completed_thumbnail_media_id(OsStr::new(&thumbnail_name)),
            Some(media_id)
        );
        assert_eq!(
            completed_thumbnail_media_id(OsStr::new(&media_id.to_string())),
            None
        );
        assert_eq!(completed_thumbnail_media_id(OsStr::new(&temp_name)), None);
    }

    #[tokio::test]
    async fn completed_thumbnail_scan_reads_bounded_batches() {
        let temp_dir = tempfile::tempdir().unwrap();
        let media_ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        for media_id in media_ids {
            let path = temp_dir.path().join(format!(
                "{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}"
            ));
            fs::write(path, b"jpeg").await.unwrap();
        }
        fs::write(temp_dir.path().join("ignored.txt"), b"ignored")
            .await
            .unwrap();

        let mut entries = fs::read_dir(temp_dir.path()).await.unwrap();
        let first = read_completed_thumbnail_batch(&mut entries, 2)
            .await
            .unwrap();
        let second = read_completed_thumbnail_batch(&mut entries, 2)
            .await
            .unwrap();
        let third = read_completed_thumbnail_batch(&mut entries, 2)
            .await
            .unwrap();

        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 1);
        assert!(third.is_empty());
        let found = first
            .into_iter()
            .chain(second)
            .map(|thumbnail| thumbnail.media_id)
            .collect::<HashSet<_>>();
        assert_eq!(found, HashSet::from(media_ids));
    }

    #[tokio::test]
    async fn deletion_waits_for_in_flight_thumbnail_publish() {
        let temp_dir = tempfile::tempdir().unwrap();
        let media_id = Uuid::new_v4();
        let thumbnail_path = temp_dir
            .path()
            .join(format!("{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}"));
        let generation_path = thumbnail_path.clone();
        let (generation_started_tx, generation_started_rx) =
            tokio::sync::oneshot::channel();
        let (allow_publish_tx, allow_publish_rx) =
            tokio::sync::oneshot::channel();
        let generation = tokio::spawn(async move {
            with_thumbnail_operation(media_id, async move {
                generation_started_tx.send(()).unwrap();
                allow_publish_rx.await.unwrap();
                fs::write(generation_path, b"jpeg").await.unwrap();
            })
            .await;
        });
        generation_started_rx.await.unwrap();

        let deletion = remove_thumbnail_paths_best_effort(
            media_id,
            std::slice::from_ref(&thumbnail_path),
            "test thumbnail",
        );
        tokio::pin!(deletion);
        tokio::select! {
            biased;
            removed = &mut deletion => panic!("deletion completed before generation: {removed}"),
            _ = tokio::task::yield_now() => {}
        }

        allow_publish_tx.send(()).unwrap();
        generation.await.unwrap();
        assert!(deletion.await);
        assert!(!thumbnail_path.exists());
    }

    #[tokio::test]
    async fn orphan_cleanup_preserves_database_and_in_progress_media() {
        let temp_dir = tempfile::tempdir().unwrap();
        let existing_id = Uuid::new_v4();
        let active_id = Uuid::new_v4();
        let orphaned_id = Uuid::new_v4();
        let entries = [existing_id, active_id, orphaned_id]
            .into_iter()
            .map(|media_id| CompletedThumbnailEntry {
                media_id,
                path: temp_dir.path().join(format!(
                    "{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}"
                )),
                size: 4,
                changed: SystemTime::now(),
            })
            .collect::<Vec<_>>();
        for entry in &entries {
            fs::write(&entry.path, b"jpeg").await.unwrap();
        }
        let active_lease = ThumbnailSourceLease::new(active_id);
        let mut retained_size = 0;

        clean_completed_thumbnail_entries(
            entries,
            &HashSet::from([existing_id]),
            &mut retained_size,
            SystemTime::now(),
        )
        .await;

        assert!(media_thumbnail_file_exists(temp_dir.path(), existing_id));
        assert!(media_thumbnail_file_exists(temp_dir.path(), active_id));
        assert!(!media_thumbnail_file_exists(temp_dir.path(), orphaned_id));
        drop(active_lease);
    }

    fn media_thumbnail_file_exists(directory: &Path, media_id: Uuid) -> bool {
        directory
            .join(format!("{media_id}{MESSENGER_MEDIA_THUMBNAIL_FILE_SUFFIX}"))
            .exists()
    }

    #[tokio::test]
    async fn jpeg_readiness_rejects_partial_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let thumbnail_path = temp_dir.path().join("thumbnail.jpg");
        fs::write(&thumbnail_path, [0xff, 0xd8]).await.unwrap();
        assert!(!jpeg_file_is_ready(&thumbnail_path).await.unwrap());

        fs::write(&thumbnail_path, [0xff, 0xd8, 0xff, 0xdb])
            .await
            .unwrap();
        assert!(jpeg_file_is_ready(&thumbnail_path).await.unwrap());
    }

    #[test]
    fn ffmpeg_command_reads_a_local_path_and_emits_one_jpeg() {
        let command = build_thumbnail_command(
            Path::new("/tmp/input.mp4"),
            Path::new("/tmp/output.jpg"),
        );
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.windows(2).any(|args| args == ["-i", "/tmp/input.mp4"]));
        assert!(args.windows(2).any(|args| args == ["-frames:v", "1"]));
        assert_eq!(args.last().map(String::as_str), Some("/tmp/output.jpg"));
    }

    #[test]
    fn retry_delay_is_bounded() {
        let mut retries = HashMap::new();
        let media_id = Uuid::new_v4();
        let mut delay = Duration::ZERO;
        for _ in 0..100 {
            (_, delay) = record_retry_failure(&mut retries, media_id);
        }

        assert_eq!(
            delay,
            Duration::from_secs(MESSENGER_MEDIA_THUMBNAIL_RETRY_MAX_SECS)
        );
    }

    #[test]
    fn retry_state_is_pruned_when_the_source_disappears() {
        let present_id = Uuid::new_v4();
        let missing_id = Uuid::new_v4();
        let retry = RetryState {
            failures: 1,
            retry_at: Instant::now(),
        };
        let mut retries =
            HashMap::from([(present_id, retry), (missing_id, retry)]);

        prune_thumbnail_retry_state(&mut retries, &HashSet::from([present_id]));

        assert!(retries.contains_key(&present_id));
        assert!(!retries.contains_key(&missing_id));
    }

    #[tokio::test]
    async fn source_cleanup_removes_expired_files_and_retry_state() {
        let temp_dir = tempfile::tempdir().unwrap();
        let media_id = Uuid::new_v4();
        let source_path = temp_dir.path().join(format!(
            "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        fs::write(&source_path, b"video").await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        let mut retries = HashMap::from([(
            media_id,
            RetryState {
                failures: 1,
                retry_at: Instant::now(),
            },
        )]);

        cleanup_thumbnail_sources(
            temp_dir.path(),
            &mut retries,
            Duration::ZERO,
            u64::MAX,
        )
        .await
        .unwrap();

        assert!(!source_path.exists());
        assert!(!retries.contains_key(&media_id));
    }

    #[tokio::test]
    async fn source_cleanup_preserves_active_uploads() {
        let temp_dir = tempfile::tempdir().unwrap();
        let media_id = Uuid::new_v4();
        let source_path = temp_dir.path().join(format!(
            "{media_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        fs::write(&source_path, b"active upload").await.unwrap();
        let lease = ThumbnailSourceLease::new(media_id);

        cleanup_thumbnail_sources(
            temp_dir.path(),
            &mut HashMap::new(),
            Duration::ZERO,
            0,
        )
        .await
        .unwrap();
        assert!(source_path.exists());

        drop(lease);
        cleanup_thumbnail_sources(
            temp_dir.path(),
            &mut HashMap::new(),
            Duration::ZERO,
            0,
        )
        .await
        .unwrap();
        assert!(!source_path.exists());
    }

    #[tokio::test]
    async fn source_budget_removes_the_final_source_when_it_is_still_over_limit(
    ) {
        let temp_dir = tempfile::tempdir().unwrap();
        let oldest_id = Uuid::new_v4();
        let oldest_path = temp_dir.path().join(format!(
            "{oldest_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        fs::write(&oldest_path, b"oldest").await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        let newest_id = Uuid::new_v4();
        let newest_path = temp_dir.path().join(format!(
            "{newest_id}{MESSENGER_MEDIA_THUMBNAIL_SOURCE_FILE_SUFFIX}"
        ));
        fs::write(&newest_path, b"newest").await.unwrap();

        cleanup_thumbnail_sources(
            temp_dir.path(),
            &mut HashMap::new(),
            Duration::from_secs(60),
            5,
        )
        .await
        .unwrap();

        assert!(!oldest_path.exists());
        assert!(!newest_path.exists());
    }
}
