use crate::config::*;
use crate::h;
use crate::types::Env;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use echo_gpu_client::{
    MaterializedAudio, QueueEvent, TranscriptionAdapter, WorkError,
    WorkerPolicy,
};
use echo_media::ffmpeg::ProbeOptions;
use echo_media::{Formats, Input};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const ECHO_AUDIO_TRANSCRIPTION_PROBE_TIMEOUT_SECS: u64 = 30;

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

    async fn ensure_queue_age(&self, source_id: Uuid) -> Result<()> {
        let item = echo_gpu_client::lookup(&self.env.dbx, source_id)
            .await
            .map_err(retryable_preparation)
            .context(h!())?
            .ok_or_else(|| WorkError::terminal("queue item was removed"))
            .context(h!())?;
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
        let key = super::service::source_key(&self.env.dbx, source_id)
            .await
            .map_err(retryable_preparation)
            .context(h!())?
            .ok_or_else(|| {
                WorkError::terminal("transcription source is missing")
            })
            .context(h!())?;
        let data = crate::storage::read_transcription_source(&self.env, &key)
            .await
            .context(h!())?;
        let extension = "audio";
        let (path, partial_path) =
            self.paths(worker_id, source_id, attempt_count, extension);
        remove_attempt_path(&path)
            .await
            .map_err(retryable_preparation)
            .context(h!())?;
        remove_attempt_path(&partial_path)
            .await
            .map_err(retryable_preparation)
            .context(h!())?;
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options
            .open(&partial_path)
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to create transcription cache file: {error}"
                ))
            })
            .context(h!())?;
        file.write_all(&data)
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to write transcription cache file: {error}"
                ))
            })
            .context(h!())?;
        file.sync_all()
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to sync transcription cache file: {error}"
                ))
            })
            .context(h!())?;
        drop(file);
        tokio::fs::rename(&partial_path, &path)
            .await
            .map_err(|error| {
                WorkError::retryable(format!(
                    "failed to publish transcription cache file: {error}"
                ))
            })
            .context(h!())?;
        ensure_regular_file(&path)
            .await
            .map_err(retryable_preparation)
            .context(h!())?;
        ensure_audio(&path).await.context(h!())?;

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

/// Sandboxed ffprobe: the source must contain an audio stream. Input that can
/// never decode is terminal; timeouts and environment failures retry.
async fn ensure_audio(path: &Path) -> Result<()> {
    let input = Input::file(path)
        .map_err(retryable_preparation)
        .context(h!())?;
    let options = ProbeOptions {
        timeout: Duration::from_secs(
            ECHO_AUDIO_TRANSCRIPTION_PROBE_TIMEOUT_SECS,
        ),
        ..ProbeOptions::new(Formats::AUDIO)
    };
    let probed = crate::media_sandbox::ffmpeg()
        .map_err(retryable_preparation)
        .context(h!())?
        .probe(&input, &options)
        .await;
    match probed {
        Ok(probe) if probe.first("audio").is_some() => Ok(()),
        Ok(_) => {
            Err(WorkError::terminal("source is not decodable audio").into())
        }
        Err(error) if error.is_terminal() => {
            log::debug!("audio probe rejected {}: {error:#?}", path.display());
            Err(WorkError::terminal("source is not decodable audio").into())
        }
        Err(echo_media::MediaError::Timeout(_)) => {
            Err(WorkError::retryable("audio probe timed out").into())
        }
        Err(error) => Err(retryable_preparation(error)).context(h!()),
    }
}

fn retryable_preparation(error: impl std::fmt::Display) -> WorkError {
    WorkError::retryable(format!("transcription preparation failed: {error}"))
}

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "mpeg", "mpga", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac",
    "webm", "audio",
];

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

pub(crate) fn worker_policy() -> WorkerPolicy {
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
