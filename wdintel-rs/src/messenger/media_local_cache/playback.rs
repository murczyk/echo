use super::{entry, files, settings, worker};
use crate::config::{
    MESSENGER_MEDIA_LOCAL_CACHE_FFMPEG_BIN,
    MESSENGER_MEDIA_LOCAL_CACHE_FFPROBE_BIN,
    MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_EXTRA_BYTES,
    MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_TIMEOUT_SECS,
    MESSENGER_MEDIA_LOCAL_CACHE_PROBE_TIMEOUT_SECS,
};
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{warn, Env, ShortContext};
use anyhow::{bail, Result};
use chrono::Utc;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;

pub(super) mod mp4;

pub(crate) enum PlaybackStatus {
    Ready(PathBuf),
    Pending,
    Original,
    Failed,
}

#[derive(Deserialize)]
struct Probe {
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    pix_fmt: Option<String>,
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
    if let Some(metadata) = entry.metadata().await.c(h!())? {
        if let Some(error) = metadata.playback_error {
            return Ok(if error == "unsupported" {
                PlaybackStatus::Original
            } else {
                PlaybackStatus::Failed
            });
        }
    }
    let media = media.clone();
    tokio::spawn(async move {
        let result = async {
            worker::recover_original(&env, &media, Utc::now().timestamp())
                .await
                .c(h!())?;
            prepare(&env, &media).await.c(h!())
        }
        .await;
        if let Err(error) = result {
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

async fn supported_source(source: &Path) -> Result<bool> {
    let output = tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_LOCAL_CACHE_PROBE_TIMEOUT_SECS),
        Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFPROBE_BIN)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,pix_fmt",
                "-of",
                "json",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(source)
            .kill_on_drop(true)
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .c(h!())?
    .c(h!())?;
    if !output.status.success() {
        bail!("ffprobe could not inspect the attachment")
    }
    let probe: Probe = serde_json::from_slice(&output.stdout).c(h!())?;
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    Ok(video.is_some_and(|stream| {
        stream.codec_name.as_deref() == Some("h264")
            && stream.pix_fmt.as_deref() == Some("yuv420p")
    }) && audio
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
    drop(files::create_private_file(&temporary.0).await.c(h!())?);
    let command = normalization_command(source, &temporary.0);
    tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_LOCAL_CACHE_PLAYBACK_TIMEOUT_SECS),
        run_normalizer(
            command,
            &temporary.0,
            reserved,
            settings(&env.config).c(h!())?.min_free_space_bytes,
        ),
    )
    .await
    .c(h!())?
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

pub(super) fn normalization_command(source: &Path, target: &Path) -> Command {
    let mut command = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFMPEG_BIN);
    command
        .args([
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(source)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-bsf:v",
            "h264_metadata=level=auto",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(target)
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

async fn run_normalizer(
    mut command: Command,
    path: &Path,
    max_size: u64,
    min_free: u64,
) -> Result<()> {
    let mut child = command.spawn().c(h!())?;
    loop {
        tokio::select! {
            status = child.wait() => {
                if !status.c(h!())?.success() { bail!("ffmpeg failed to normalize the attachment") }
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if fs::metadata(path).await.c(h!())?.len() > max_size || fs2::available_space(path).c(h!())? < min_free {
                    child.kill().await.c(h!())?;
                    bail!("video normalization exhausted its disk reservation");
                }
            }
        }
    }
}
