use super::{entry, files, settings, worker};
use crate::config::{
    MESSENGER_MEDIA_CACHE_FAILURE_TTL_SECS,
    MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_EXTRA_BYTES,
    MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_TIMEOUT_SECS,
    MESSENGER_MEDIA_LOCAL_CACHE_PROBE_TIMEOUT_SECS,
};
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{warn, Env, ShortContext};
use anyhow::{bail, Result};
use chrono::Utc;
use echo_media::ffmpeg::{ProbeOptions, RemuxOptions};
use echo_media::{Formats, Input};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;

pub(super) mod mp4;

pub(crate) enum PlaybackStatus {
    Ready(PathBuf),
    Pending,
    Original,
    Failed,
}

/// Entries that recently failed to get cache room, so polling clients are sent
/// to the original stream instead of waiting for a copy that cannot be made.
static CACHE_FULL: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(Mutex::default);

fn recently_cache_full(id: &str) -> bool {
    let ttl = Duration::from_secs(MESSENGER_MEDIA_CACHE_FAILURE_TTL_SECS);
    let mut full = CACHE_FULL.lock().unwrap_or_else(|e| e.into_inner());
    full.retain(|_, at| at.elapsed() < ttl);
    full.contains_key(id)
}

fn mark_cache_full(id: String) {
    let mut full = CACHE_FULL.lock().unwrap_or_else(|e| e.into_inner());
    full.insert(id, Instant::now());
}

pub(crate) async fn playback_status(
    env: Arc<Env>,
    media: &signal_message_media::Model,
) -> Result<PlaybackStatus> {
    let env = Arc::new(super::configured_env(&env).await.c(h!())?);
    if settings(&env.config).is_none() {
        return Ok(PlaybackStatus::Original);
    }
    if !crate::messenger::media::is_video_media(media) {
        return Ok(PlaybackStatus::Original);
    }
    let entry = entry(&env.config, media).c(h!())?;
    if let Some(path) = entry.ready(true).await.c(h!())? {
        return Ok(PlaybackStatus::Ready(path));
    }
    if !media.is_encrypted {
        return Ok(PlaybackStatus::Original);
    }
    if let Some(metadata) = entry.metadata().await.c(h!())? {
        if let Some(error) = metadata.playback_error {
            return Ok(if error == "unsupported" {
                PlaybackStatus::Original
            } else {
                PlaybackStatus::Failed
            });
        }
    }
    if recently_cache_full(&entry.id) {
        return Ok(PlaybackStatus::Original);
    }
    let media = media.clone();
    let entry_id = entry.id.clone();
    tokio::spawn(async move {
        let result = async {
            worker::recover_original(&env, &media, Utc::now().timestamp())
                .await
                .c(h!())?;
            prepare(&env, &media).await.c(h!())
        }
        .await;
        if let Err(error) = result {
            if error.downcast_ref::<files::CacheFull>().is_some() {
                mark_cache_full(entry_id);
            }
            warn!("requested video playback preparation failed media_id={}: {error:#}", media.id)
        }
    });
    Ok(PlaybackStatus::Pending)
}

pub(super) async fn prepare(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<()> {
    if !crate::messenger::media::is_video_media(media) {
        return Ok(());
    }
    let entry = entry(&env.config, media).c(h!())?;
    let Some(_lock) = files::try_lock(&entry.path("lock")).await.c(h!())?
    else {
        return Ok(());
    };
    let Some(mut metadata) = entry.metadata().await.c(h!())? else {
        return Ok(());
    };
    if metadata.playback_error.is_some()
        || entry.ready(true).await.c(h!())?.is_some()
    {
        return Ok(());
    }
    let Some(source) = entry.ready(false).await.c(h!())? else {
        return Ok(());
    };
    let Some(_normalizer) =
        files::try_lock(&entry.root.join("normalizer.lock"))
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    if !supported_source(&source).await.c(h!())? {
        metadata.playback_error = Some("unsupported".to_string());
        return entry.write_metadata(&metadata).await.c(h!());
    }
    let reserved = entry
        .size
        .saturating_add(MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_EXTRA_BYTES);
    let _reservation = files::reserve(&env.config, &entry, reserved)
        .await
        .c(h!())?;
    match normalize(env, &entry, &source, reserved).await {
        Ok(size) => metadata.playback_size = Some(size),
        Err(error) => {
            warn!(
                "video normalization failed media_id={}: {error:#}",
                media.id
            );
            metadata.playback_error = Some("normalization failed".to_string());
        }
    }
    entry.write_metadata(&metadata).await.c(h!())
}

/// Whether the retained original is H.264 yuv420p with optional AAC, which a
/// stream copy can turn into a playable MP4. Input that ffprobe can never read
/// (corrupt, or a demuxer outside the whitelist) counts as unsupported.
async fn supported_source(source: &Path) -> Result<bool> {
    let options = ProbeOptions {
        formats: Formats::VIDEO,
        timeout: Duration::from_secs(
            MESSENGER_MEDIA_LOCAL_CACHE_PROBE_TIMEOUT_SECS,
        ),
    };
    let input = Input::file(source).c(h!())?;
    let probe = match crate::media_sandbox::ffmpeg().c(h!())?.probe(&input, &options).await {
        Ok(probe) => probe,
        Err(error) if error.is_terminal() => {
            warn!("video probe rejected {}: {error:#}", source.display());
            return Ok(false);
        }
        Err(error) => return Err(error).c(h!()),
    };
    Ok(probe.first("video").is_some_and(|stream| {
        stream.codec_name.as_deref() == Some("h264")
            && stream.pix_fmt.as_deref() == Some("yuv420p")
    }) && probe
        .first("audio")
        .is_none_or(|stream| stream.codec_name.as_deref() == Some("aac")))
}

async fn normalize(
    env: &Env,
    entry: &files::Entry,
    source: &Path,
    reserved: u64,
) -> Result<u64> {
    let temporary = files::TemporaryFile(entry.path("playback.tmp"));
    files::remove_if_present(&temporary.0).await.c(h!())?;
    let min_free = settings(&env.config).c(h!())?.min_free_space_bytes;
    remux_watching_disk(source, &temporary.0, &entry.root, reserved, min_free)
        .await
        .c(h!())?;
    mp4::validate(&temporary.0).await.c(h!())?;
    let file = fs::File::open(&temporary.0).await.c(h!())?;
    let size = file.metadata().await.c(h!())?.len();
    if size == 0 || size > reserved {
        bail!("normalized video exceeded its reservation or is empty")
    }
    file.sync_all().await.c(h!())?;
    fs::rename(&temporary.0, entry.path("playback.mp4"))
        .await
        .c(h!())?;
    files::sync_directory(&entry.root).await.c(h!())?;
    Ok(size)
}

/// Sandboxed stream copy into `target`, capped at `reserved` bytes by the
/// kernel. Stops the copy (dropping it kills ffmpeg) when free space on the
/// cache volume falls below `min_free`.
async fn remux_watching_disk(
    source: &Path,
    target: &Path,
    root: &Path,
    reserved: u64,
    min_free: u64,
) -> Result<()> {
    let options = RemuxOptions {
        formats: Formats::VIDEO,
        timeout: Duration::from_secs(
            MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_TIMEOUT_SECS,
        ),
        ..RemuxOptions::new(reserved)
    };
    let input = Input::file(source).c(h!())?;
    let media = crate::media_sandbox::ffmpeg().c(h!())?;
    let remux = media.remux_mp4_faststart(&input, target, &options);
    tokio::pin!(remux);
    loop {
        tokio::select! {
            result = &mut remux => {
                result.c(h!())?;
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if fs2::available_space(root).c(h!())? < min_free {
                    bail!("video normalization exhausted its disk reservation");
                }
            }
        }
    }
}
