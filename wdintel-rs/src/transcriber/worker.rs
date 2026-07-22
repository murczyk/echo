use crate::config::*;
use crate::entities::{signal_message, signal_message_media};
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use echo_gpu_client::{
    MaterializedAudio, QueueEvent, QueueSourceCursor, TranscriptionAdapter,
    WorkError, WorkerPolicy, WorkerRunResult,
};
use futures_util::TryStreamExt;
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, QuerySelect, RelationTrait,
};
use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub struct EchoTranscriptionAdapter {
    env: Arc<Env>,
    cache_dir: PathBuf,
    worker_id: Uuid,
}

impl EchoTranscriptionAdapter {
    pub async fn new(env: Arc<Env>, worker_id: Uuid) -> Result<Self> {
        let cache_dir = cache_dir(&env.config.storage_dir);
        prepare_cache_dir(&cache_dir).await.context(h!())?;
        cleanup_cache_dir(&cache_dir).await.context(h!())?;
        Ok(Self {
            env,
            cache_dir,
            worker_id,
        })
    }

    fn paths(
        &self,
        worker_id: Uuid,
        source_id: Uuid,
        attempt_count: i32,
        extension: &str,
    ) -> (PathBuf, PathBuf) {
        let stem = format!("{worker_id}-{source_id}-{attempt_count}");
        (
            self.cache_dir.join(format!("{stem}.{extension}")),
            self.cache_dir.join(format!("{stem}.{extension}.partial")),
        )
    }

    async fn find_media(
        &self,
        source_id: Uuid,
    ) -> Result<signal_message_media::Model> {
        signal_message_media::Entity::find_by_id(source_id)
            .join(
                sea_orm::JoinType::InnerJoin,
                signal_message_media::Relation::SignalMessage.def(),
            )
            .filter(signal_message::Column::Deleted.eq(false))
            .one(&self.env.dbx)
            .await
            .context(h!())?
            .ok_or_else(|| {
                WorkError::terminal("source media is missing").into()
            })
    }

    async fn ensure_queue_age(&self, source_id: Uuid) -> Result<()> {
        let item = echo_gpu_client::lookup(&self.env.dbx, source_id)
            .await
            .context(h!())?
            .ok_or_else(|| WorkError::terminal("queue item was removed"))?;
        let queued_at =
            item.0.reprocess_requested_at.unwrap_or(item.0.created_at);
        if total_age_exhausted(queued_at, chrono::Utc::now().naive_utc()) {
            return Err(WorkError::terminal(
                "transcription exceeded the 24 hour total-age limit",
            )
            .into());
        }
        Ok(())
    }

    async fn load_media(
        &self,
        media: &signal_message_media::Model,
    ) -> Result<Vec<u8>> {
        if media.is_encrypted {
            return crate::messenger::media::fetch_media_bytes(
                self.env.as_ref(),
                media,
            )
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to load encrypted media: {error}"
                ))
                .into()
            });
        }

        let byte_len = u64::try_from(media.size_bytes)
            .map_err(|_| WorkError::terminal("media has invalid size"))?;
        let stream = crate::messenger::media::stream_plaintext_media_range(
            self.env.as_ref(),
            media,
            0..byte_len,
        )
        .await
        .map_err(|error| {
            WorkError::retryable(format!(
                "failed to open plaintext media: {error}"
            ))
        })?;
        stream
            .try_fold(
                Vec::with_capacity(byte_len as usize),
                |mut data, chunk| async move {
                    data.extend_from_slice(&chunk);
                    Ok(data)
                },
            )
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to load plaintext media: {error}"
                ))
                .into()
            })
    }
}

#[async_trait]
impl TranscriptionAdapter for EchoTranscriptionAdapter {
    async fn materialize(
        &self,
        source_id: Uuid,
        worker_id: Uuid,
        attempt_count: i32,
    ) -> Result<MaterializedAudio> {
        self.ensure_queue_age(source_id).await.context(h!())?;
        let media = self.find_media(source_id).await.context(h!())?;
        if !crate::messenger::media::is_audio_media(&media) {
            return Err(WorkError::terminal("source media is not audio").into());
        }
        if media.size_bytes > ECHO_AUDIO_TRANSCRIPTION_MAX_BYTES {
            return Err(
                WorkError::terminal("source media exceeds 100 MiB").into()
            );
        }
        if media.size_bytes <= 0 {
            return Err(WorkError::terminal("source media is empty").into());
        }

        let extension = safe_audio_extension(&media);
        let (path, partial_path) =
            self.paths(worker_id, source_id, attempt_count, extension);
        remove_attempt_path(&path).await.context(h!())?;
        remove_attempt_path(&partial_path).await.context(h!())?;

        let data = self.load_media(&media).await.context(h!())?;
        if data.len() as i64 != media.size_bytes {
            return Err(WorkError::retryable(
                "materialized media size changed",
            )
            .into());
        }

        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options.open(&partial_path).await.map_err(|error| {
            WorkError::retryable(format!(
                "failed to create transcription cache file: {error}"
            ))
        })?;
        file.write_all(&data).await.map_err(|error| {
            WorkError::retryable(format!(
                "failed to write transcription cache file: {error}"
            ))
        })?;
        file.sync_all().await.map_err(|error| {
            WorkError::retryable(format!(
                "failed to sync transcription cache file: {error}"
            ))
        })?;
        drop(file);
        tokio::fs::rename(&partial_path, &path)
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to publish transcription cache file: {error}"
                ))
            })?;
        ensure_regular_file(&path).await.context(h!())?;

        Ok(MaterializedAudio {
            path,
            file_name: format!("{source_id}.{extension}"),
            byte_len: data.len() as u64,
        })
    }

    async fn release_materialized(
        &self,
        source_id: Uuid,
        worker_id: Uuid,
        attempt_count: i32,
    ) -> Result<()> {
        for extension in AUDIO_EXTENSIONS {
            let (path, partial_path) =
                self.paths(worker_id, source_id, attempt_count, extension);
            remove_attempt_path(&path).await.context(h!())?;
            remove_attempt_path(&partial_path).await.context(h!())?;
        }
        Ok(())
    }

    async fn retrying(&self, event: &QueueEvent) -> Result<()> {
        log::warn!(
            "audio transcription retry worker_id={} source_id={} attempt_count={} instance_id={:?} retry_at={:?} reason={:?}",
            self.worker_id,
            event.source_id,
            event.attempt_count,
            event.instance_id,
            event.retry_at,
            event.message,
        );
        Ok(())
    }

    async fn terminal_failure(&self, event: &QueueEvent) -> Result<()> {
        log::error!(
            "audio transcription terminal worker_id={} source_id={} attempt_count={} instance_id={:?} reason={:?}",
            self.worker_id,
            event.source_id,
            event.attempt_count,
            event.instance_id,
            event.message,
        );
        Ok(())
    }
}

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "mpeg", "mpga", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac",
    "webm", "audio",
];

fn safe_audio_extension(media: &signal_message_media::Model) -> &'static str {
    let extension = media
        .file_ext
        .as_deref()
        .or_else(|| {
            media
                .file_name
                .as_deref()
                .and_then(|name| Path::new(name).extension())
                .and_then(|extension| extension.to_str())
        })
        .unwrap_or_default();
    AUDIO_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| extension.eq_ignore_ascii_case(candidate))
        .unwrap_or("audio")
}

fn cache_dir(storage_dir: &str) -> PathBuf {
    let base = if storage_dir.trim().is_empty() {
        PathBuf::from("/var/tmp")
    } else {
        PathBuf::from(storage_dir)
    };
    base.join("echo_audio_cache")
}

fn total_age_exhausted(
    queued_at: chrono::NaiveDateTime,
    now: chrono::NaiveDateTime,
) -> bool {
    now - queued_at
        >= chrono::Duration::seconds(
            ECHO_AUDIO_TRANSCRIPTION_MAX_TOTAL_AGE_SECS,
        )
}

async fn prepare_cache_dir(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => {
            if !metadata.file_type().is_dir()
                || metadata.file_type().is_symlink()
            {
                bail!("transcription cache path is not a regular directory");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(path).await.context(h!())?;
        }
        Err(error) => return Err(error).context(h!()),
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .await
        .context(h!())?;
    Ok(())
}

async fn cleanup_cache_dir(path: &Path) -> Result<()> {
    let mut entries = tokio::fs::read_dir(path).await.context(h!())?;
    while let Some(entry) = entries.next_entry().await.context(h!())? {
        let metadata = tokio::fs::symlink_metadata(entry.path())
            .await
            .context(h!())?;
        if metadata.file_type().is_dir() {
            bail!("unexpected directory in transcription cache");
        }
        tokio::fs::remove_file(entry.path()).await.context(h!())?;
    }
    Ok(())
}

async fn remove_attempt_path(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_dir() => {
            bail!("unexpected directory in transcription cache")
        }
        Ok(_) => tokio::fs::remove_file(path).await.context(h!()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context(h!()),
    }
}

async fn ensure_regular_file(path: &Path) -> Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await.context(h!())?;
    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        bail!("transcription cache output is not a regular file")
    }
}

fn worker_policy() -> WorkerPolicy {
    WorkerPolicy {
        heartbeat_interval: Duration::from_secs(
            ECHO_AUDIO_TRANSCRIPTION_HEARTBEAT_SECS,
        ),
        stale_after: chrono::Duration::seconds(
            ECHO_AUDIO_TRANSCRIPTION_STALE_SECS,
        ),
        base_retry_delay: Duration::from_secs(
            ECHO_AUDIO_TRANSCRIPTION_RETRY_BASE_SECS,
        ),
        max_retry_delay: Duration::from_secs(
            ECHO_AUDIO_TRANSCRIPTION_RETRY_MAX_SECS,
        ),
        max_attempts: ECHO_AUDIO_TRANSCRIPTION_MAX_ATTEMPTS,
        max_error_len: ECHO_AUDIO_TRANSCRIPTION_MAX_ERROR_LEN,
    }
}

async fn cleanup_finished(env: &Env) -> Result<u64> {
    let cutoff = chrono::Utc::now().naive_utc()
        - chrono::Duration::days(ECHO_AUDIO_TRANSCRIPTION_RETENTION_DAYS);
    let mut deleted = 0;
    loop {
        let batch = echo_gpu_client::cleanup_finished(
            &env.dbx,
            cutoff,
            ECHO_AUDIO_TRANSCRIPTION_CLEANUP_BATCH_SIZE,
        )
        .await
        .context(h!())?;
        deleted += batch;
        if batch < ECHO_AUDIO_TRANSCRIPTION_CLEANUP_BATCH_SIZE {
            return Ok(deleted);
        }
    }
}

async fn cleanup_orphans(
    env: &Env,
    cursor: &mut Option<QueueSourceCursor>,
) -> Result<(u64, bool)> {
    let page = echo_gpu_client::scan_source_ids(
        &env.dbx,
        *cursor,
        ECHO_AUDIO_TRANSCRIPTION_CLEANUP_BATCH_SIZE,
    )
    .await
    .context(h!())?;
    let existing: HashSet<Uuid> = signal_message_media::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            signal_message_media::Relation::SignalMessage.def(),
        )
        .filter(
            signal_message_media::Column::Id
                .is_in(page.source_ids.iter().copied()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .select_only()
        .column(signal_message_media::Column::Id)
        .into_tuple::<Uuid>()
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect();
    let orphan_ids: Vec<_> = page
        .source_ids
        .into_iter()
        .filter(|source_id| !existing.contains(source_id))
        .collect();
    let deleted = echo_gpu_client::delete_by_sources(&env.dbx, &orphan_ids)
        .await
        .context(h!())?;
    *cursor = page.next_cursor;
    Ok((deleted, cursor.is_none()))
}

pub async fn run_nofail(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) {
    while !cancel_token.is_cancelled() {
        if let Err(error) =
            run(env.clone(), worker_id, cancel_token.clone()).await
        {
            log::error!(
                "audio transcription worker cycle failed worker_id={worker_id}: {error:#}"
            );
            wait_or_cancel(
                &cancel_token,
                ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
            )
            .await;
        }
    }
}

async fn run(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) -> Result<()> {
    let adapter = EchoTranscriptionAdapter::new(env.clone(), worker_id)
        .await
        .context(h!())?;
    let policy = worker_policy();
    let mut orphan_cursor = None;
    let mut last_status_log = None;
    log::info!("audio transcription worker started worker_id={worker_id}");

    loop {
        let finished = cleanup_finished(env.as_ref()).await.context(h!())?;
        let (orphans, orphan_scan_complete) =
            cleanup_orphans(env.as_ref(), &mut orphan_cursor)
                .await
                .context(h!())?;
        if finished > 0 || orphans > 0 {
            log::info!(
                "audio transcription cleanup worker_id={worker_id} finished={finished} orphans={orphans}"
            );
        }

        if cancel_token.is_cancelled() {
            break;
        }
        if !orphan_scan_complete {
            wait_or_cancel(
                &cancel_token,
                ECHO_AUDIO_TRANSCRIPTION_ACTIVE_SLEEP_MS,
            )
            .await;
            continue;
        }
        log_queue_status(env.as_ref(), worker_id, &mut last_status_log)
            .await
            .context(h!())?;
        if !crate::system_settings::audio_transcription_enabled(&env.dbx)
            .await
            .c(h!())?
        {
            wait_or_cancel(
                &cancel_token,
                ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
            )
            .await;
            continue;
        }

        let result = echo_gpu_client::run_transcriber_worker_once(
            env.echo_gpu_client.as_ref(),
            worker_id,
            &policy,
            &adapter,
        )
        .await
        .context(h!())?;
        wait_or_cancel(&cancel_token, worker_result_sleep_ms(&result)).await;
    }

    log::info!("audio transcription worker drained worker_id={worker_id}");
    Ok(())
}

async fn log_queue_status(
    env: &Env,
    worker_id: Uuid,
    last_log: &mut Option<tokio::time::Instant>,
) -> Result<()> {
    let now = tokio::time::Instant::now();
    if last_log.as_ref().is_some_and(|last_log| {
        now.duration_since(*last_log).as_secs()
            < ECHO_AUDIO_TRANSCRIPTION_STATUS_LOG_INTERVAL_SECS
    }) {
        return Ok(());
    }
    let status = echo_gpu_client::queue_status(&env.dbx)
        .await
        .context(h!())?;
    let oldest_due_age_seconds = status.oldest_due_at.map(|oldest_due_at| {
        (chrono::Utc::now().naive_utc() - oldest_due_at)
            .num_seconds()
            .max(0)
    });
    log::info!(
        "audio transcription status worker_id={worker_id} queued={} processing={} retrying={} completed={} terminal={} oldest_due_age_seconds={:?}",
        status.queued,
        status.processing,
        status.retrying,
        status.completed,
        status.terminal,
        oldest_due_age_seconds,
    );
    *last_log = Some(now);
    Ok(())
}

fn worker_result_sleep_ms(result: &WorkerRunResult) -> u64 {
    match result {
        WorkerRunResult::Idle(_) | WorkerRunResult::Retrying { .. } => {
            ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS
        }
        WorkerRunResult::Completed { .. }
        | WorkerRunResult::Terminal { .. }
        | WorkerRunResult::Stale { .. } => {
            ECHO_AUDIO_TRANSCRIPTION_ACTIVE_SLEEP_MS
        }
    }
}

async fn wait_or_cancel(cancel_token: &CancellationToken, sleep_ms: u64) {
    tokio::select! {
        _ = cancel_token.cancelled() => {}
        _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_with_extension(
        extension: Option<&str>,
    ) -> signal_message_media::Model {
        signal_message_media::Model {
            id: Uuid::now_v7(),
            signal_message_id: 1,
            content_type: "audio/ogg".to_string(),
            file_ext: extension.map(str::to_string),
            file_name: Some("recording.M4A".to_string()),
            size_bytes: 1,
            is_encrypted: false,
            created_at: chrono::Utc::now().naive_utc(),
        }
    }

    #[test]
    fn task_count_is_controlled_by_the_config_constant() {
        assert_eq!(ECHO_AUDIO_TRANSCRIPTION_CONCURRENCY, 1);
    }

    #[test]
    fn worker_result_sleep_distinguishes_idle_and_active_iterations() {
        assert_eq!(
            worker_result_sleep_ms(&WorkerRunResult::Idle(
                echo_gpu_client::IdleReason::NoActiveInstance,
            )),
            ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
        );
        assert_eq!(
            worker_result_sleep_ms(&WorkerRunResult::Completed {
                source_id: Uuid::now_v7(),
            }),
            ECHO_AUDIO_TRANSCRIPTION_ACTIVE_SLEEP_MS,
        );
    }

    #[test]
    fn empty_storage_uses_var_tmp() {
        assert_eq!(cache_dir(""), PathBuf::from("/var/tmp/echo_audio_cache"));
    }

    #[test]
    fn configured_storage_never_falls_back() {
        assert_eq!(
            cache_dir("/srv/echo"),
            PathBuf::from("/srv/echo/echo_audio_cache")
        );
    }

    #[test]
    fn total_age_limit_is_inclusive() {
        let now = chrono::Utc::now().naive_utc();
        assert!(!total_age_exhausted(
            now - chrono::Duration::seconds(
                ECHO_AUDIO_TRANSCRIPTION_MAX_TOTAL_AGE_SECS - 1,
            ),
            now,
        ));
        assert!(total_age_exhausted(
            now - chrono::Duration::seconds(
                ECHO_AUDIO_TRANSCRIPTION_MAX_TOTAL_AGE_SECS,
            ),
            now,
        ));
    }

    #[test]
    fn audio_extension_is_selected_from_the_allowlist() {
        assert_eq!(
            safe_audio_extension(&media_with_extension(Some("OpUs"))),
            "opus"
        );
        assert_eq!(safe_audio_extension(&media_with_extension(None)), "m4a");
        assert_eq!(
            safe_audio_extension(&media_with_extension(Some("../../wav"))),
            "audio"
        );
    }

    #[test]
    fn worker_policy_uses_echo_config_constants() {
        let policy = worker_policy();
        assert_eq!(
            policy.heartbeat_interval,
            Duration::from_secs(ECHO_AUDIO_TRANSCRIPTION_HEARTBEAT_SECS)
        );
        assert_eq!(
            policy.stale_after,
            chrono::Duration::seconds(ECHO_AUDIO_TRANSCRIPTION_STALE_SECS)
        );
        assert_eq!(
            policy.base_retry_delay,
            Duration::from_secs(ECHO_AUDIO_TRANSCRIPTION_RETRY_BASE_SECS)
        );
        assert_eq!(
            policy.max_retry_delay,
            Duration::from_secs(ECHO_AUDIO_TRANSCRIPTION_RETRY_MAX_SECS)
        );
        assert_eq!(policy.max_attempts, ECHO_AUDIO_TRANSCRIPTION_MAX_ATTEMPTS);
        assert_eq!(
            policy.max_error_len,
            ECHO_AUDIO_TRANSCRIPTION_MAX_ERROR_LEN
        );
    }
}
