mod cache;
mod source;

use crate::config::*;
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{Env, ShortContext};
use anyhow::{bail, Result};
use echo_media::ffmpeg::{HlsOptions, HlsSegments};
use echo_media::process::Running;
use echo_media::{Ffmpeg, Formats};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;
use tokio::fs;

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
    input: echo_media::Input,
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
    let segments = HlsSegments {
        index,
        start,
        length,
    };
    let running = Ffmpeg::shared()
        .c(h!())?
        .hls_segments(&input, &temporary.0, segments, &hls_options().c(h!())?)
        .c(h!())?;
    tokio::time::timeout(
        Duration::from_secs(MESSENGER_MEDIA_PREVIEW_SEGMENT_TIMEOUT_SECS),
        publish_window(running, entry, &temporary.0, index, count),
    )
    .await
    .c(h!())?
    .c(h!())
}

/// The encoder writes only into the window's `.work` directory, and the
/// kernel caps each file at the segment limit.
fn hls_options() -> Result<HlsOptions<'static>> {
    Ok(HlsOptions {
        formats: Formats::MOV,
        video_filter: MESSENGER_MEDIA_PREVIEW_VIDEO_FILTER,
        video_maxrate: MESSENGER_MEDIA_PREVIEW_VIDEO_MAXRATE,
        threads: MESSENGER_MEDIA_PREVIEW_VIDEO_THREADS.parse().c(h!())?,
        segment_secs: MESSENGER_MEDIA_PREVIEW_SEGMENT_SECS,
        segment_max_bytes: MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES,
        timeout: Duration::from_secs(
            MESSENGER_MEDIA_PREVIEW_SEGMENT_TIMEOUT_SECS,
        ),
    })
}

/// Make a finished segment private and return its size, or `None` while it
/// does not exist yet. The work directory is writable by the sandboxed
/// encoder, which may plant a symlink or FIFO there: the segment is opened
/// without following symlinks and without blocking, must be a regular
/// file, and is changed through its descriptor only, so this root process
/// never acts on a path the encoder chose.
async fn seal_segment(path: &Path) -> Result<Option<u64>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .await
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None)
        }
        Err(error) => return Err(error).c(h!()),
    };
    let metadata = file.metadata().await.c(h!())?;
    if !metadata.is_file() {
        bail!("video preview segment is not a regular file");
    }
    file.set_permissions(std::fs::Permissions::from_mode(
        MESSENGER_MEDIA_CACHE_FILE_MODE,
    ))
    .await
    .c(h!())?;
    Ok(Some(metadata.len()))
}

async fn publish_window(
    mut running: Running,
    entry: &cache::Entry,
    directory: &Path,
    index: u32,
    count: u32,
) -> Result<()> {
    let mut published = 0;
    loop {
        while published < count {
            let current = index + published;
            let path = directory.join(format!("{current}.ts"));
            let Some(size) = seal_segment(&path).await.c(h!())? else {
                break;
            };
            if size == 0 || size >= MESSENGER_MEDIA_PREVIEW_SEGMENT_MAX_BYTES {
                bail!(
                    "video preview segment exceeded its size limit or is empty"
                )
            }
            // The encoder still runs and could swap a symlink in before the
            // rename; `cache::Entry::cached_segment` refuses to serve one.
            fs::rename(path, entry.path(&format!("{current}.ts")))
                .await
                .c(h!())?;
            published += 1;
        }
        if running.try_wait().await.c(h!())?.is_some() {
            if published == count {
                return Ok(());
            }
            // The encoder may have finalized its last segment after the directory read.
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

#[cfg(test)]
mod tests;
