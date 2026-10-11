mod cache;
mod source;

use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Result};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
#[error("video preview workers are busy")]
pub(crate) struct Busy;

pub(crate) fn eligible(media: &signal_message_media::Model) -> bool {
    !media.is_encrypted
        && media.size_bytes >= MESSENGER_MEDIA_PREVIEW_MIN_SOURCE_BYTES
        && (media.content_type == "video/mp4"
            || media
                .file_ext
                .as_deref()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4")))
}

pub(crate) async fn recommended(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<bool> {
    if !eligible(media) {
        return Ok(false);
    }
    let info = source::info(env, media).await.c(h!())?;
    Ok(media.size_bytes as f64 * 8.0 / info.duration
        > MESSENGER_MEDIA_PREVIEW_NATIVE_MAX_BITRATE as f64)
}

fn segment_bounds(index: u32, duration: f64) -> Option<(f64, f64)> {
    let start = index as f64 * MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS;
    (start < duration).then_some((
        start,
        MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS.min(duration - start),
    ))
}

pub(crate) async fn playlist(
    env: &Env,
    media: &signal_message_media::Model,
) -> Result<String> {
    let info = source::info(env, media).await.c(h!())?;
    let mut playlist = format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n",
        MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS.ceil() as u32
    );
    let mut index = 0;
    while let Some((_, length)) = segment_bounds(index, info.duration) {
        playlist
            .push_str(&format!("#EXTINF:{length:.6},\nsegments/{index}.ts\n"));
        index += 1;
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    Ok(playlist)
}

pub(crate) async fn segment(
    env: &Env,
    media: &signal_message_media::Model,
    index: u32,
) -> Result<Option<actix_files::NamedFile>> {
    let info = source::info(env, media).await.c(h!())?;
    if segment_bounds(index, info.duration).is_none() {
        return Ok(None);
    }
    let entry = cache::Entry::new(env, media).c(h!())?;
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(MESSENGER_MEDIA_PREVIEW_SEGMENT_TIMEOUT_SECS);
    let mut started = false;
    loop {
        if let Some(file) = entry.cached_segment(index).await.c(h!())? {
            prefetch_window(env, media, index, info.duration);
            return Ok(Some(file));
        }
        if !started {
            started = start_window(env, media, index, info.duration)
                .await
                .c(h!())?;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Busy.into());
        }
        tokio::time::sleep(Duration::from_millis(
            MESSENGER_MEDIA_PREVIEW_POLL_MILLIS,
        ))
        .await;
    }
}

fn prefetch_window(
    env: &Env,
    media: &signal_message_media::Model,
    index: u32,
    duration: f64,
) {
    let index = index + MESSENGER_MEDIA_PREVIEW_LOOKAHEAD_SEGMENTS;
    if segment_bounds(index, duration).is_none() {
        return;
    }
    let env = env.clone();
    let media = media.clone();
    tokio::spawn(async move {
        if let Err(error) = start_window(&env, &media, index, duration).await {
            crate::types::warn!(
                "video preview look-ahead failed media_id={}: {error:#}",
                media.id
            );
        }
    });
}

async fn start_window(
    env: &Env,
    media: &signal_message_media::Model,
    index: u32,
    duration: f64,
) -> Result<bool> {
    let entry = cache::Entry::new(env, media).c(h!())?;
    let Some(lock) = entry.lock(index).await.c(h!())? else {
        return Ok(false);
    };
    if entry.cached_segment(index).await.c(h!())?.is_some() {
        return Ok(true);
    }
    let Some(slot) = entry.slot().await.c(h!())? else {
        return Ok(false);
    };
    let mut locks = vec![lock];
    let mut count = 1;
    for next in index + 1..index + MESSENGER_MEDIA_PREVIEW_WINDOW_SEGMENTS {
        if segment_bounds(next, duration).is_none()
            || entry.cached_segment(next).await.c(h!())?.is_some()
        {
            break;
        }
        let Some(lock) = entry.lock(next).await.c(h!())? else {
            break;
        };
        locks.push(lock);
        count += 1;
    }
    let input = source::input(env, media).await.c(h!())?;
    entry.prepare_space(input.min_free).await.c(h!())?;
    let media_id = media.id;
    tokio::spawn(async move {
        let _locks = locks;
        let _slot = slot;
        if let Err(error) =
            render_window(input.value, &entry, index, count, duration).await
        {
            crate::types::warn!("video preview generation failed media_id={media_id}: {error:#}");
        }
    });
    Ok(true)
}

async fn render_window(
    input: std::ffi::OsString,
    entry: &cache::Entry,
    index: u32,
    count: u32,
    duration: f64,
) -> Result<()> {
    let temporary = cache::TemporaryDirectory(
        entry.path(&format!("{}.work", uuid::Uuid::new_v4())),
    );
    let mut directory = fs::DirBuilder::new();
    directory
        .mode(MESSENGER_MEDIA_CACHE_DIR_MODE)
        .create(&temporary.0)
        .await
        .c(h!())?;
    let start = index as f64 * MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS;
    let length = (count as f64 * MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS)
        .min(duration - start);
    let command = segment_command(input, &temporary.0, index, start, length);
    tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_PREVIEW_SEGMENT_TIMEOUT_SECS),
        publish_window(command, entry, &temporary.0, index, count),
    )
    .await
    .c(h!())?
    .c(h!())
}

async fn publish_window(
    mut command: Command,
    entry: &cache::Entry,
    directory: &Path,
    index: u32,
    count: u32,
) -> Result<()> {
    let mut child = command.spawn().c(h!())?;
    let mut published = 0;
    loop {
        while published < count {
            let current = index + published;
            let path = directory.join(format!("{current}.ts"));
            let metadata = match fs::metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    break
                }
                Err(error) => return Err(error).c(h!()),
            };
            if metadata.len() == 0
                || metadata.len() >= MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES
            {
                bail!(
                    "video preview segment exceeded its size limit or is empty"
                )
            }
            fs::set_permissions(
                &path,
                std::os::unix::fs::PermissionsExt::from_mode(
                    MESSENGER_MEDIA_CACHE_FILE_MODE,
                ),
            )
            .await
            .c(h!())?;
            fs::rename(path, entry.path(&format!("{current}.ts")))
                .await
                .c(h!())?;
            published += 1;
        }
        if let Some(status) = child.try_wait().c(h!())? {
            if !status.success() {
                bail!("could not encode video preview")
            }
            if published == count {
                return Ok(());
            }
            // The child may have finalized its last segment after the directory read.
            if !directory.join(format!("{}.ts", index + published)).exists() {
                bail!("video preview did not produce every requested segment")
            }
        }
        let partial = directory.join(format!("{}.ts.tmp", index + published));
        if let Ok(metadata) = fs::metadata(partial).await {
            if metadata.len() >= MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES {
                bail!("video preview segment exceeded its size limit")
            }
        }
        tokio::time::sleep(Duration::from_millis(
            MESSENGER_MEDIA_PREVIEW_POLL_MILLIS,
        ))
        .await;
    }
}

fn segment_command(
    input: std::ffi::OsString,
    directory: &Path,
    index: u32,
    start: f64,
    length: f64,
) -> Command {
    let mut command = Command::new(MESSENGER_MEDIA_LOCAL_CACHE_FFMPEG_BIN);
    command.args(["-nostdin", "-v", "error", "-y"]);
    source::input_options(&mut command);
    command.args([
        "-analyzeduration",
        "1",
        "-probesize",
        "32768",
        "-fpsprobesize",
        "0",
    ]);
    command
        .args(["-ss", &start.to_string(), "-i"])
        .arg(input)
        .args(["-t", &length.to_string(), "-map", "0:v:0", "-map", "0:a:0?"])
        .args([
            "-vf",
            MESSENGER_MEDIA_PREVIEW_VIDEO_FILTER,
            "-filter_threads",
            "1",
            "-c:v",
            "libx264",
            "-threads",
            MESSENGER_MEDIA_PREVIEW_VIDEO_THREADS,
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-crf",
            "23",
            "-maxrate",
            MESSENGER_MEDIA_PREVIEW_VIDEO_MAXRATE,
            "-bufsize",
            MESSENGER_MEDIA_PREVIEW_VIDEO_MAXRATE,
            "-pix_fmt",
            "yuv420p",
            "-g",
            "30",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-output_ts_offset",
        ])
        .arg(start.to_string())
        .arg("-af")
        .arg(format!(
            "aresample=48000,atrim=end={},asetpts=PTS+1024",
            (length - 1024.0 / 48000.0).max(0.0)
        ))
        .args([
            "-avoid_negative_ts",
            "disabled",
            "-muxdelay",
            "0",
            "-f",
            "hls",
            "-hls_time",
        ])
        .arg(MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS.to_string())
        .args([
            "-hls_playlist_type",
            "vod",
            "-hls_flags",
            "temp_file+independent_segments",
            "-start_number",
        ])
        .arg(index.to_string())
        .arg("-hls_segment_filename")
        .arg(directory.join("%d.ts"))
        .arg(directory.join("preview.m3u8"))
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests;
