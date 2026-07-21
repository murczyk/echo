use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use echo_gpu_client::{
    MaterializedAudio, QueueSourceCursor, TranscriptionAdapter, WorkError,
    WorkerPolicy, WorkerRunResult,
};
use futures_util::TryStreamExt;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use std::collections::HashSet;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub struct EchoTranscriptionAdapter {
    env: Arc<Env>,
    cache_dir: PathBuf,
}

impl EchoTranscriptionAdapter {
    pub async fn new(env: Arc<Env>) -> Result<Self> {
        let cache_dir = cache_dir(&env.config.storage_dir);
        prepare_cache_dir(&cache_dir).await.context(h!())?;
        cleanup_cache_dir(&cache_dir).await.context(h!())?;
        Ok(Self { env, cache_dir })
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
            .one(&self.env.dbx)
            .await
            .context(h!())?
            .ok_or_else(|| {
                WorkError::terminal("source media is missing").into()
            })
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
        let mut file = options.open(&partial_path).await.context(h!())?;
        file.write_all(&data).await.context(h!())?;
        file.sync_all().await.context(h!())?;
        drop(file);
        tokio::fs::rename(&partial_path, &path)
            .await
            .context(h!())?;
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
) -> Result<u64> {
    let page = echo_gpu_client::scan_source_ids(
        &env.dbx,
        *cursor,
        ECHO_AUDIO_TRANSCRIPTION_CLEANUP_BATCH_SIZE,
    )
    .await
    .context(h!())?;
    let existing: HashSet<Uuid> = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::Id
                .is_in(page.source_ids.iter().copied()),
        )
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
    Ok(deleted)
}

pub async fn run_nofail(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) {
    if let Err(error) = run(env, worker_id, cancel_token).await {
        log::error!(
            "audio transcription worker stopped worker_id={worker_id}: {error:#}"
        );
    }
}

async fn run(
    env: Arc<Env>,
    worker_id: Uuid,
    cancel_token: CancellationToken,
) -> Result<()> {
    let adapter = EchoTranscriptionAdapter::new(env.clone())
        .await
        .context(h!())?;
    let policy = worker_policy();
    let mut orphan_cursor = None;
    log::info!("audio transcription worker started worker_id={worker_id}");

    loop {
        let finished = cleanup_finished(env.as_ref()).await.context(h!())?;
        let orphans = cleanup_orphans(env.as_ref(), &mut orphan_cursor)
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
        if !crate::system_settings::audio_transcription_enabled(&env.dbx)
            .await
            .c(h!())?
        {
            wait_or_cancel(&cancel_token).await;
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
        match result {
            WorkerRunResult::Idle(_) | WorkerRunResult::Retrying { .. } => {
                wait_or_cancel(&cancel_token).await
            }
            WorkerRunResult::Completed { .. }
            | WorkerRunResult::Terminal { .. }
            | WorkerRunResult::Stale { .. } => {}
        }
    }

    log::info!("audio transcription worker drained worker_id={worker_id}");
    Ok(())
}

async fn wait_or_cancel(cancel_token: &CancellationToken) {
    tokio::select! {
        _ = cancel_token.cancelled() => {}
        _ = tokio::time::sleep(Duration::from_millis(
            ECHO_AUDIO_TRANSCRIPTION_IDLE_SLEEP_MS,
        )) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_count_is_controlled_by_the_config_constant() {
        assert_eq!(ECHO_AUDIO_TRANSCRIPTION_CONCURRENCY, 1);
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
}
