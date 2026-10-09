use super::types::*;
use super::*;
use crate::file_registry::entities::device_audio;
use actix_web::{http::header, web, HttpRequest};
use futures_util::StreamExt;
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QuerySelect,
};
use std::collections::{HashMap, VecDeque};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Instant, SystemTime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct PlaybackCache {
    entries: Mutex<CacheEntries>,
    scan: Mutex<Option<tokio::fs::ReadDir>>,
}

#[derive(Default)]
struct CacheEntries {
    by_id: HashMap<Uuid, Arc<CacheEntry>>,
    order: VecDeque<Uuid>,
}

struct CacheEntry {
    directory: tempfile::TempDir,
    generation: Arc<Mutex<()>>,
    last_used: std::sync::Mutex<Instant>,
}

pub(super) struct CacheLease {
    entry: Arc<CacheEntry>,
    file: std::fs::File,
}

impl Drop for CacheLease {
    fn drop(&mut self) {
        if let Ok(mut last_used) = self.entry.last_used.lock() {
            *last_used = Instant::now();
        }
        let _ = std::fs::write(self.entry.directory.path().join("used"), []);
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

fn lease_file(directory: &Path) -> anyhow::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join("lease"))
        .c(h!())
}

fn acquire_entry(
    entry: Arc<CacheEntry>,
) -> anyhow::Result<Option<Arc<CacheLease>>> {
    let file = match lease_file(entry.directory.path()) {
        Ok(file) => file,
        Err(error)
            if error.downcast_ref::<std::io::Error>().is_some_and(
                |error| error.kind() == std::io::ErrorKind::NotFound,
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error).c(h!()),
    };
    match fs2::FileExt::try_lock_shared(&file) {
        Ok(()) => Ok(Some(Arc::new(CacheLease { entry, file }))),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Ok(None)
        }
        Err(error) => Err(error).c(h!()),
    }
}

#[derive(FromQueryResult)]
struct ContentSource {
    mime_type: String,
    storage_key: String,
    source_size_bytes: i64,
    source_sha256: Vec<u8>,
}

#[derive(Default, Clone)]
pub(super) struct ContentHooks {
    #[cfg(test)]
    pub before_publication: Option<
        std::sync::Arc<
            dyn Fn() -> futures_util::future::BoxFuture<
                    'static,
                    anyhow::Result<()>,
                > + Send
                + Sync,
        >,
    >,
}

pub(super) fn routes() -> impl actix_web::dev::HttpServiceFactory {
    web::resource("/api/device/audio/{device_id}/{audio_id}/{representation}")
        .route(web::get().to(content_http))
        .route(web::head().to(content_http))
}

async fn content_http(
    env: web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    path: web::Path<(Uuid, Uuid, String)>,
    request: HttpRequest,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor = crate::users::login_id_from_identity(&user).c(h!())?;
    let representation = match path.2.as_str() {
        "content" => DeviceAudioRepresentation::Content,
        "wave" => DeviceAudioRepresentation::Wave,
        "spectrogram" => DeviceAudioRepresentation::Spectrogram,
        _ => return Err(AppError::NotFound.into()),
    };
    let command = OpenDeviceAudioCommand {
        device_id: path.0,
        audio_id: path.1,
        representation,
        method: if request.method() == actix_web::http::Method::HEAD {
            DeviceAudioMethod::Head
        } else {
            DeviceAudioMethod::Get
        },
        range: request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_range),
    };
    let result = super::open_content(&env.device_audio, actor, command).await;
    match result {
        Ok(content) => Ok(http_response(content)),
        Err(error) => {
            if let Some(range) = error
                .chain()
                .find_map(|error| error.downcast_ref::<UnsatisfiableRange>())
            {
                return Ok(HttpResponse::RangeNotSatisfiable()
                    .insert_header((
                        header::CONTENT_RANGE,
                        format!("bytes */{}", range.0),
                    ))
                    .insert_header((header::ACCEPT_RANGES, "bytes"))
                    .insert_header((header::CACHE_CONTROL, "private, no-store"))
                    .finish());
            }
            Err(error.into())
        }
    }
}

fn http_response(content: DeviceAudioContent) -> HttpResponse {
    let mut response = if content.range.is_some() {
        HttpResponse::PartialContent()
    } else {
        HttpResponse::Ok()
    };
    response
        .insert_header((header::CONTENT_TYPE, content.mime_type))
        .insert_header((header::CONTENT_LENGTH, content.length.to_string()))
        .insert_header((header::ACCEPT_RANGES, "bytes"))
        .insert_header((header::CONTENT_DISPOSITION, "inline"))
        .insert_header((header::CACHE_CONTROL, "private, no-store"));
    if let Some(range) = content.range {
        response.insert_header((
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end, range.total),
        ));
    }
    response.streaming(
        content.stream.map(|chunk| {
            chunk.map_err(actix_web::error::ErrorInternalServerError)
        }),
    )
}

fn parse_range(value: &str) -> Option<DeviceAudioRange> {
    let value = value.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    if !start.bytes().all(|byte| byte.is_ascii_digit())
        || !end.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    if start.is_empty() {
        Some(DeviceAudioRange::Suffix {
            length: end.parse().ok()?,
        })
    } else {
        Some(DeviceAudioRange::From {
            start: start.parse().ok()?,
            end: if end.is_empty() {
                None
            } else {
                Some(end.parse().ok()?)
            },
        })
    }
}

#[derive(Debug)]
struct UnsatisfiableRange(u64);

impl std::fmt::Display for UnsatisfiableRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "audio byte range is outside content of length {}",
            self.0
        )
    }
}
impl std::error::Error for UnsatisfiableRange {}

fn resolve_range(
    range: DeviceAudioRange,
    length: u64,
) -> anyhow::Result<DeviceAudioContentRange> {
    let (start, end) = match range {
        DeviceAudioRange::From { start, end } => (
            start,
            end.unwrap_or(length.saturating_sub(1))
                .min(length.saturating_sub(1)),
        ),
        DeviceAudioRange::Suffix { length: suffix } if suffix > 0 => {
            (length.saturating_sub(suffix), length.saturating_sub(1))
        }
        _ => return Err(UnsatisfiableRange(length).into()),
    };
    if start >= length || start > end {
        return Err(UnsatisfiableRange(length).into());
    }
    Ok(DeviceAudioContentRange {
        start,
        end,
        total: length,
    })
}

async fn find_source(
    runtime: &DeviceAudioRuntime,
    command: &OpenDeviceAudioCommand,
) -> anyhow::Result<ContentSource> {
    use device_audio::Column as C;
    device_audio::Entity::find_by_id(command.audio_id)
        .filter(C::DeviceId.eq(command.device_id))
        .select_only()
        .columns([
            C::MimeType,
            C::StorageKey,
            C::SourceSizeBytes,
            C::SourceSha256,
        ])
        .into_model::<ContentSource>()
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
}

pub(super) async fn open_content(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    command: OpenDeviceAudioCommand,
) -> anyhow::Result<DeviceAudioContent> {
    open_with_hooks(runtime, actor, command, ContentHooks::default())
        .await
        .c(h!())
}

pub(super) async fn open_with_hooks(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    command: OpenDeviceAudioCommand,
    hooks: ContentHooks,
) -> anyhow::Result<DeviceAudioContent> {
    authorize_read(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    let entry = tokio::time::timeout(
        Duration::from_secs(DEVICE_AUDIO_PREPARATION_WAIT_SECS),
        prepare_representation(
            runtime.clone(),
            Some(actor),
            &command,
            hooks,
            None,
        ),
    )
    .await
    .map_err(|_| unavailable("audio preparation timed out"))
    .c(h!())?
    .c(h!())?;
    let path = entry
        .entry
        .directory
        .path()
        .join(target_name(command.representation));
    let mut file = tokio::fs::File::open(&path).await.c(h!())?;
    let total = file.metadata().await.c(h!())?.len();
    authorize_read(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    touch(&entry.entry).await.c(h!())?;
    let range =
        if matches!(command.representation, DeviceAudioRepresentation::Content)
        {
            command
                .range
                .map(|range| resolve_range(range, total))
                .transpose()
                .c(h!())?
        } else {
            None
        };
    let length = range
        .as_ref()
        .map_or(total, |range| range.end - range.start + 1);
    let stream: std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = anyhow::Result<bytes::Bytes>>
                + Send,
        >,
    > = if matches!(command.method, DeviceAudioMethod::Head) {
        Box::pin(futures_util::stream::empty())
    } else {
        file.seek(std::io::SeekFrom::Start(
            range.as_ref().map_or(0, |range| range.start),
        ))
        .await
        .c(h!())?;
        Box::pin(tokio_util::io::ReaderStream::new(file.take(length)).map(
            move |chunk| {
                let _keep_cache_alive = &entry;
                chunk.c(h!())
            },
        ))
    };
    Ok(DeviceAudioContent {
        mime_type: if matches!(
            command.representation,
            DeviceAudioRepresentation::Content
        ) {
            "audio/mpeg"
        } else {
            "image/png"
        }
        .into(),
        length,
        range,
        stream,
    })
}

pub(super) async fn validate_source(
    runtime: &DeviceAudioRuntime,
    device_id: Uuid,
    audio_id: Uuid,
) -> anyhow::Result<()> {
    find_source(
        runtime,
        &OpenDeviceAudioCommand {
            device_id,
            audio_id,
            representation: DeviceAudioRepresentation::Content,
            method: DeviceAudioMethod::Head,
            range: None,
        },
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(super) async fn prepare_representation(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Option<Uuid>,
    command: &OpenDeviceAudioCommand,
    hooks: ContentHooks,
    job: Option<Arc<preparation::Job>>,
) -> anyhow::Result<Arc<CacheLease>> {
    let source = find_source(&runtime, command).await.c(h!())?;
    let entry = cache_entry(&runtime, command.audio_id).await.c(h!())?;
    let target = entry
        .entry
        .directory
        .path()
        .join(target_name(command.representation));
    if tokio::fs::try_exists(&target).await.c(h!())? {
        return Ok(entry);
    }
    let waiting = if job.is_none() {
        Some(
            runtime
                .preparation
                .waiting
                .clone()
                .acquire_owned()
                .await
                .c(h!())?,
        )
    } else {
        None
    };
    let generation = tokio::select! {
        _ = runtime.preparation.cancellation.cancelled() => return Err(unavailable("audio preparation is stopping")).c(h!()),
        generation = entry.entry.generation.clone().lock_owned() => generation,
    };
    if tokio::fs::try_exists(&target).await.c(h!())? {
        return Ok(entry);
    }
    let permit = runtime.preparation.admit(job.as_deref()).await.c(h!())?;
    if let Some(job) = job {
        job.started(command.representation);
    }
    let owned_entry = entry.clone();
    let owned_runtime = runtime.clone();
    let command = command.clone();
    runtime
        .preparation
        .tasks
        .spawn(async move {
            let (_waiting, _generation, _permit) =
                (waiting, generation, permit);
            generate(
                &owned_runtime,
                actor,
                &command,
                &source,
                &owned_entry.entry,
                &hooks,
            )
            .await
        })
        .await
        .c(h!())?
        .c(h!())?;
    Ok(entry)
}

pub(super) async fn readiness(
    runtime: &DeviceAudioRuntime,
    audio: Uuid,
) -> anyhow::Result<[bool; 3]> {
    let entry = runtime
        .playback_cache
        .entries
        .lock()
        .await
        .by_id
        .get(&audio)
        .cloned();
    let Some(entry) = entry else {
        return Ok([false; 3]);
    };
    let mut ready = [false; 3];
    for (index, representation) in
        preparation::REPRESENTATIONS.into_iter().enumerate()
    {
        ready[index] = tokio::fs::try_exists(
            entry.directory.path().join(target_name(representation)),
        )
        .await
        .c(h!())?;
    }
    Ok(ready)
}

pub(super) async fn stage_original(
    runtime: &DeviceAudioRuntime,
    audio: Uuid,
    source: &Path,
) -> anyhow::Result<()> {
    let entry = cache_entry(runtime, audio).await.c(h!())?;
    let Ok(_generation) = entry.entry.generation.try_lock() else {
        return Ok(());
    };
    let target = entry.entry.directory.path().join("original");
    if tokio::fs::try_exists(&target).await.c(h!())? {
        return Ok(());
    }
    preparation::ensure_space(runtime).await.c(h!())?;
    let temporary =
        tempfile::NamedTempFile::new_in(entry.entry.directory.path())
            .c(h!())?;
    tokio::fs::remove_file(temporary.path()).await.c(h!())?;
    if tokio::fs::hard_link(source, temporary.path())
        .await
        .is_err()
    {
        tokio::fs::copy(source, temporary.path()).await.c(h!())?;
    }
    tokio::fs::rename(temporary.path(), target).await.c(h!())
}

fn cache_root(runtime: &DeviceAudioRuntime) -> PathBuf {
    runtime.storage_dir.join("device-audio-cache")
}

async fn cache_entry(
    runtime: &DeviceAudioRuntime,
    audio: Uuid,
) -> anyhow::Result<Arc<CacheLease>> {
    let mut entries = runtime.playback_cache.entries.lock().await;
    if let Some(entry) = entries.by_id.get(&audio) {
        if let Some(lease) = acquire_entry(entry.clone()).c(h!())? {
            return Ok(lease);
        }
        entries.by_id.remove(&audio);
        entries.order.retain(|id| *id != audio);
    }
    let root = cache_root(runtime);
    tokio::fs::create_dir_all(&root).await.c(h!())?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
        .c(h!())?;
    let directory = tempfile::Builder::new()
        .prefix(&format!("{DEVICE_AUDIO_RENDITION_VERSION}-"))
        .tempdir_in(root)
        .c(h!())?;
    let entry = Arc::new(CacheEntry {
        directory,
        generation: Arc::new(Mutex::new(())),
        last_used: std::sync::Mutex::new(Instant::now()),
    });
    let lease = acquire_entry(entry.clone())
        .c(h!())?
        .ok_or_else(|| unavailable("cache lease is busy"))
        .c(h!())?;
    touch(&entry).await.c(h!())?;
    entries.by_id.insert(audio, entry);
    entries.order.push_back(audio);
    Ok(lease)
}

async fn touch(entry: &CacheEntry) -> anyhow::Result<()> {
    *entry
        .last_used
        .lock()
        .map_err(|_| anyhow::anyhow!("cache clock poisoned"))
        .c(h!())? = Instant::now();
    tokio::fs::write(entry.directory.path().join("used"), [])
        .await
        .c(h!())?;
    Ok(())
}

fn target_name(representation: DeviceAudioRepresentation) -> &'static str {
    match representation {
        DeviceAudioRepresentation::Content => "content.mp3",
        DeviceAudioRepresentation::Wave => "wave.png",
        DeviceAudioRepresentation::Spectrogram => "spectrogram.png",
    }
}

async fn generate(
    runtime: &DeviceAudioRuntime,
    actor: Option<Uuid>,
    command: &OpenDeviceAudioCommand,
    source: &ContentSource,
    entry: &CacheEntry,
    _hooks: &ContentHooks,
) -> anyhow::Result<PathBuf> {
    let target = entry
        .directory
        .path()
        .join(target_name(command.representation));
    if tokio::fs::try_exists(&target).await.c(h!())? {
        return Ok(target);
    }
    preparation::ensure_space(runtime).await.c(h!())?;
    let original = entry.directory.path().join("original");
    if !tokio::fs::try_exists(&original).await.c(h!())? {
        let plaintext = storage::verified_content(
            Arc::new(runtime.clone()),
            source.storage_key.clone(),
            storage::SourceFingerprint {
                size_bytes: u64::try_from(source.source_size_bytes).c(h!())?,
                sha256: source
                    .source_sha256
                    .clone()
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("invalid source hash"))
                    .c(h!())?,
            },
        )
        .await
        .c(h!())?;
        let temporary =
            tempfile::NamedTempFile::new_in(entry.directory.path()).c(h!())?;
        tokio::fs::write(temporary.path(), plaintext)
            .await
            .c(h!())?;
        if let Some(actor) = actor {
            authorize_read(runtime, actor, command.device_id)
                .await
                .c(h!())?;
        }
        tokio::fs::rename(temporary.path(), &original)
            .await
            .c(h!())?;
    }
    let temporary = tempfile::Builder::new()
        .suffix(
            if matches!(
                command.representation,
                DeviceAudioRepresentation::Content
            ) {
                ".mp3"
            } else {
                ".png"
            },
        )
        .tempfile_in(entry.directory.path())
        .c(h!())?;
    if matches!(command.representation, DeviceAudioRepresentation::Content)
        && source.mime_type == "audio/mpeg"
    {
        tokio::fs::copy(&original, temporary.path()).await.c(h!())?;
    } else {
        let ffmpeg =
            media_command(&original, temporary.path(), command.representation)
                .await
                .c(h!())?;
        tokio::select! {
            biased;
            _ = runtime.preparation.cancellation.cancelled() => {
                return Err(unavailable("audio preparation is stopping")).c(h!());
            }
            result = probe::run_decoder(ffmpeg) => result.c(h!())?,
        }
    }
    validate_output(temporary.path(), command.representation)
        .await
        .c(h!())?;
    #[cfg(test)]
    if let Some(hook) = &_hooks.before_publication {
        hook().await.c(h!())?;
    }
    if let Some(actor) = actor {
        authorize_read(runtime, actor, command.device_id)
            .await
            .c(h!())?;
    }
    tokio::fs::rename(temporary.path(), &target).await.c(h!())?;
    Ok(target)
}

async fn media_command(
    original: &Path,
    output: &Path,
    representation: DeviceAudioRepresentation,
) -> anyhow::Result<tokio::process::Command> {
    let mut command = tokio::process::Command::new("ffmpeg");
    command
        .args([
            "-y",
            "-v",
            "error",
            "-nostdin",
            "-threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-filter_threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-filter_complex_threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-xerror",
            "-err_detect",
            "explode",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(original);
    match representation {
        DeviceAudioRepresentation::Content => {
            let channels = probe::source_channels(original)
                .await
                .c(h!())?
                .min(2)
                .to_string();
            command.args([
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                DEVICE_AUDIO_RENDITION_QUALITY,
                "-ar",
                DEVICE_AUDIO_RENDITION_RATE,
                "-ac",
                &channels,
                "-f",
                "mp3",
            ]);
        }
        DeviceAudioRepresentation::Wave => {
            command.args([
                "-filter_complex",
                DEVICE_AUDIO_WAVE_FILTER,
                "-frames:v",
                "1",
                "-an",
                "-f",
                "image2",
            ]);
        }
        DeviceAudioRepresentation::Spectrogram => {
            command.args([
                "-lavfi",
                DEVICE_AUDIO_SPECTROGRAM_FILTER,
                "-frames:v",
                "1",
                "-an",
                "-f",
                "image2",
            ]);
        }
    }
    command
        .args(["-threads", DEVICE_AUDIO_FFMPEG_THREADS])
        .arg(output)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "pcm_s16le",
            "-threads",
            DEVICE_AUDIO_FFMPEG_THREADS,
            "-ar",
            DEVICE_AUDIO_RENDITION_RATE,
            "-f",
            "framecrc",
            "pipe:1",
        ]);
    Ok(command)
}

async fn validate_output(
    path: &Path,
    representation: DeviceAudioRepresentation,
) -> anyhow::Result<()> {
    let size = tokio::fs::metadata(path).await.c(h!())?.len();
    anyhow::ensure!(size > 0, "empty audio representation");
    if !matches!(representation, DeviceAudioRepresentation::Content) {
        anyhow::ensure!(
            size <= DEVICE_AUDIO_IMAGE_MAX_BYTES,
            "audio image output exceeds limit"
        );
        let bytes = tokio::fs::read(path).await.c(h!())?;
        anyhow::ensure!(
            bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "invalid audio image"
        );
    }
    Ok(())
}

pub(super) async fn cleanup_cache(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    let active = {
        let mut entries = runtime.playback_cache.entries.lock().await;
        for _ in 0..DEVICE_AUDIO_CLEANUP_BATCH {
            let Some(id) = entries.order.pop_front() else {
                break;
            };
            let expired = entries.by_id.get(&id).is_some_and(|entry| {
                Arc::strong_count(entry) == 1
                    && entry.last_used.lock().is_ok_and(|used| {
                        used.elapsed() >= DEVICE_AUDIO_CACHE_TTL
                    })
            });
            if expired {
                entries.by_id.remove(&id);
            } else {
                entries.order.push_back(id);
            }
        }
        entries
            .by_id
            .values()
            .map(|entry| entry.directory.path().to_path_buf())
            .collect::<std::collections::HashSet<_>>()
    };
    let mut scan = runtime.playback_cache.scan.lock().await;
    if scan.is_none() {
        *scan = match tokio::fs::read_dir(cache_root(runtime)).await {
            Ok(scan) => Some(scan),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(())
            }
            Err(error) => return Err(error).c(h!()),
        };
    }
    for _ in 0..DEVICE_AUDIO_CLEANUP_BATCH {
        let Some(entry) = scan.as_mut().c(h!())?.next_entry().await.c(h!())?
        else {
            *scan = None;
            break;
        };
        if active.contains(&entry.path())
            || !entry.file_type().await.c(h!())?.is_dir()
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{DEVICE_AUDIO_RENDITION_VERSION}-"))
        {
            continue;
        }
        let metadata =
            match tokio::fs::metadata(entry.path().join("used")).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    entry.metadata().await.c(h!())?
                }
                Err(error) => return Err(error).c(h!()),
            };
        let file = match lease_file(&entry.path()) {
            Ok(file) => file,
            Err(error)
                if error.downcast_ref::<std::io::Error>().is_some_and(
                    |error| error.kind() == std::io::ErrorKind::NotFound,
                ) =>
            {
                continue
            }
            Err(error) => return Err(error).c(h!()),
        };
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                continue
            }
            Err(error) => return Err(error).c(h!()),
        }
        let metadata =
            match tokio::fs::metadata(entry.path().join("used")).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    metadata
                }
                Err(error) => return Err(error).c(h!()),
            };
        if SystemTime::now()
            .duration_since(metadata.modified().c(h!())?)
            .unwrap_or_default()
            >= DEVICE_AUDIO_CACHE_TTL
        {
            match tokio::fs::remove_dir_all(entry.path()).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).c(h!()),
            }
        }
    }
    Ok(())
}
