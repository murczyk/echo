mod bl;
mod content;
mod cursor;
mod ingest;
mod preparation;
mod probe;
mod query;
mod storage;
pub(crate) mod types;
mod upload;
mod worker;

pub(crate) use preparation::run as run_preparation;
pub(crate) use upload::routes as upload_routes;

pub(crate) fn routes() -> impl actix_web::dev::HttpServiceFactory {
    (
        actix_web::web::resource("/api/device/audio/receive")
            .route(actix_web::web::post().to(receive_http)),
        actix_web::web::resource("/api/device/audio/list")
            .route(actix_web::web::post().to(list_http)),
        actix_web::web::resource("/api/device/audio/detail")
            .route(actix_web::web::post().to(detail_http)),
        actix_web::web::resource("/api/device/audio/transcription/save")
            .app_data(actix_web::web::JsonConfig::default().limit(usize::MAX))
            .route(actix_web::web::post().to(save_transcription_http)),
        actix_web::web::resource("/api/device/audio/processing/set")
            .route(actix_web::web::post().to(set_processed_http)),
        actix_web::web::resource("/api/device/audio/playback/prepare")
            .route(actix_web::web::post().to(prepare_http)),
        content::routes(),
    )
}

async fn prepare_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::PrepareDeviceAudioReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor = crate::users::login_id_from_identity(&user).c(h!())?;
    Ok(HttpResponse::Ok().json(
        preparation::prepare(
            env.device_audio.clone(),
            actor,
            crate::devices::types::parse_uuid(&request.device_id),
            crate::devices::types::parse_uuid(&request.audio_id),
            request.retry,
        )
        .await
        .c(h!())?,
    ))
}

async fn list_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::ListDeviceAudioReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let request = request.into_inner();
    let command = types::ListDeviceAudioCommand {
        device_id: crate::devices::types::parse_uuid(&request.device_id),
        unprocessed_only: request.unprocessed_only,
        limit: request.limit,
        cursor: request.cursor,
    };
    Ok(HttpResponse::Ok()
        .json(list(&env.device_audio, actor_id, command).await.c(h!())?))
}

async fn detail_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::DeviceAudioDetailReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let request = request.into_inner();
    let command = types::DeviceAudioDetailCommand {
        device_id: crate::devices::types::parse_uuid(&request.device_id),
        audio_id: crate::devices::types::parse_uuid(&request.audio_id),
    };
    Ok(HttpResponse::Ok()
        .json(detail(&env.device_audio, actor_id, command).await.c(h!())?))
}

async fn receive_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::ReceiveDeviceAudioReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let request = request.into_inner();
    let command = types::ReceiveDeviceAudioCommand {
        device_id: crate::devices::types::parse_uuid(&request.device_id),
        upload_url: request.upload_url,
        name: request.name,
        recording_started_at: chrono::DateTime::parse_from_rfc3339(
            &request.recording_started_at,
        )
        .c(h!())?
        .with_timezone(&chrono::Utc),
    };
    match receive(&env.device_audio, actor_id, command)
        .await
        .c(h!())?
    {
        types::ReceiveDeviceAudioOutcome::Accepted(response) => {
            Ok(HttpResponse::Created().json(response))
        }
        types::ReceiveDeviceAudioOutcome::Duplicate => Err(query::conflict(
            "device_audio_name_conflict",
            "Аудіо з такою назвою вже існує",
        )
        .into()),
    }
}

async fn save_transcription_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::SaveDeviceAudioTranscriptionReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let request = request.into_inner();
    let command = types::SaveDeviceAudioTranscriptionCommand {
        device_id: crate::devices::types::parse_uuid(&request.device_id),
        audio_id: crate::devices::types::parse_uuid(&request.audio_id),
        text: request.text,
        expected_text_version: crate::devices::types::parse_uuid(
            &request.expected_text_version,
        ),
    };
    match save_transcription(&env.device_audio, actor_id, command).await.c(h!())? {
        types::SaveDeviceAudioTranscriptionOutcome::Saved(response)
        | types::SaveDeviceAudioTranscriptionOutcome::Unchanged(response) => Ok(HttpResponse::Ok().json(response)),
        types::SaveDeviceAudioTranscriptionOutcome::Conflict { audio_id, current } => Ok(HttpResponse::Conflict()
            .json(serde_json::json!({"message":"Транскрипцію вже змінено","details":{"code":"device_audio_text_conflict","audio_id":audio_id,"current":current}}))),
    }
}

async fn set_processed_http(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    request: actix_web::web::Json<types::SetDeviceAudioProcessingReq>,
) -> Result<HttpResponse, DeviceAudioHttpError> {
    let actor_id = crate::users::login_id_from_identity(&user).c(h!())?;
    let request = request.into_inner();
    let command = types::SetDeviceAudioProcessingCommand {
        device_id: crate::devices::types::parse_uuid(&request.device_id),
        audio_id: crate::devices::types::parse_uuid(&request.audio_id),
        processed: request.processed,
        expected_processing_version: crate::devices::types::parse_uuid(
            &request.expected_processing_version,
        ),
    };
    match set_processed(&env.device_audio, actor_id, command).await.c(h!())? {
        types::SetDeviceAudioProcessingOutcome::Saved(response)
        | types::SetDeviceAudioProcessingOutcome::Unchanged(response) => Ok(HttpResponse::Ok().json(response)),
        types::SetDeviceAudioProcessingOutcome::Conflict(current) => Ok(HttpResponse::Conflict()
            .json(serde_json::json!({"message":"Статус аудіо вже змінено","details":{"code":"device_audio_processing_conflict","audio_id":current.audio_id,"current":{"processed":current.processed,"processing_version":current.processing_version}}}))),
    }
}

#[cfg(test)]
mod acceptance_tests;
#[cfg(test)]
mod tests;

use crate::config::Config;
use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::storage::S3Config;
use crate::types::{ShortContext, Uuid};
use actix_web::{http::StatusCode, HttpResponse, ResponseError};
use sea_orm::DatabaseConnection;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

pub(super) const DEVICE_AUDIO_RECEIVE_CONCURRENCY: usize = 4;
pub(super) const DEVICE_AUDIO_PROBE_CONCURRENCY: usize = 2;
pub(super) const DEVICE_AUDIO_DECRYPT_CONCURRENCY: usize = 2;
pub(super) const DEVICE_AUDIO_BACKGROUND_CONCURRENCY: usize = 2;
pub(super) const DEVICE_AUDIO_INTERACTIVE_CONCURRENCY: usize = 2;
pub(super) const DEVICE_AUDIO_PREPARATION_QUEUE_SIZE: usize = 256;
pub(super) const DEVICE_AUDIO_FFMPEG_THREADS: &str = "1";
pub(super) const DEVICE_AUDIO_RECEIVE_WAIT_SECS: u64 = 120;
pub(super) const DEVICE_AUDIO_PREPARATION_WAIT_SECS: u64 = 120;
pub(super) const DEVICE_AUDIO_PREPARATION_RETRY_SECS: u64 = 10;
pub(super) const DEVICE_AUDIO_PREPARATION_POLL_MS: u64 = 1000;
pub(super) const DEVICE_AUDIO_PREPARATION_SCAN_SECS: u64 = 30;
pub(super) const DEVICE_AUDIO_PREPARATION_BATCH: u64 = 100;
pub(super) const DEVICE_AUDIO_PREPARATION_MIN_FREE_BYTES: u64 =
    1024 * 1024 * 1024;

pub(super) const DEVICE_AUDIO_MAX_BYTES: u64 = 104_857_600;
pub(super) const DEVICE_AUDIO_MAX_CIPHERTEXT_BYTES: u64 = 105_906_176;
pub(super) const DEVICE_AUDIO_MAX_NAME_BYTES: usize = 1024;
pub(super) const DEVICE_AUDIO_DEFAULT_PAGE_SIZE: u32 = 50;
pub(super) const DEVICE_AUDIO_MAX_PAGE_SIZE: u32 = 200;
pub(super) const DEVICE_AUDIO_CURSOR_VERSION: u8 = 1;
pub(super) const DEVICE_AUDIO_MAX_CURSOR_BYTES: usize = 1024;
pub(super) const DEVICE_AUDIO_PENDING_TTL: Duration =
    Duration::from_secs(4 * 60 * 60);
pub(super) const DEVICE_AUDIO_COMPLETED_TTL: Duration =
    Duration::from_secs(8 * 60 * 60);
pub(super) const DEVICE_AUDIO_DOWNLOAD_TIMEOUT: Duration =
    Duration::from_secs(60);
pub(super) const DEVICE_AUDIO_HEARTBEAT_INTERVAL: Duration =
    Duration::from_secs(10);
pub(super) const DEVICE_AUDIO_ABANDONED_HEARTBEAT: Duration =
    Duration::from_secs(5 * 60);
pub(super) const DEVICE_AUDIO_CLEANUP_INTERVAL: Duration =
    Duration::from_secs(60);
pub(super) const DEVICE_AUDIO_CLEANUP_BATCH: u64 = 100;
pub(crate) const DEVICE_AUDIO_CLEANUP_METRIC: &str =
    "echo.device_audio.cleanup.count";
pub(super) const DEVICE_AUDIO_BUSY_RETRY_AFTER_SECS: u64 = 60;
pub(super) const DEVICE_AUDIO_DECODER_PROGRESS_TIMEOUT: Duration =
    Duration::from_secs(5 * 60);
pub(super) const DEVICE_AUDIO_DECODER_STDERR_BYTES: usize = 64 * 1024;
pub(super) const DEVICE_AUDIO_PROBE_OUTPUT_BYTES: usize = 64 * 1024;
pub(super) const DEVICE_AUDIO_PROCESS_READ_BYTES: usize = 8192;
pub(super) const DEVICE_AUDIO_MIN_TIMESTAMP_US: i64 = -210_866_803_200_000_000;
pub(super) const DEVICE_AUDIO_MAX_JS_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;
pub(super) const DEVICE_AUDIO_MICROSECONDS_PER_SECOND: u64 = 1_000_000;
pub(super) const DEVICE_AUDIO_CACHE_TTL: Duration =
    Duration::from_secs(24 * 60 * 60);
pub(super) const DEVICE_AUDIO_TOMBSTONE_RESCAN: Duration =
    Duration::from_secs(24 * 60 * 60);
pub(super) const DEVICE_AUDIO_MAX_DIAGNOSTIC_BYTES: usize = 4096;
pub(super) const DEVICE_AUDIO_RENDITION_VERSION: &str = "v1";
pub(super) const DEVICE_AUDIO_RENDITION_RATE: &str = "48000";
pub(super) const DEVICE_AUDIO_RENDITION_QUALITY: &str = "2";
pub(super) const DEVICE_AUDIO_IMAGE_MAX_BYTES: u64 = 1024 * 1024;
pub(super) const DEVICE_AUDIO_WAVE_FILTER: &str = "[0:a]aformat=channel_layouts=mono,compand,showwavespic=s=600x100:colors=#9cf42f";
pub(super) const DEVICE_AUDIO_SPECTROGRAM_FILTER: &str = "[0:a]showspectrumpic=s=500x200:mode=combined:legend=off,format=rgba,colorkey=black:0.01:0";

#[derive(Clone)]
pub(crate) struct DeviceAudioRuntime {
    dbx: DatabaseConnection,
    files: Option<FileRegistryDb>,
    storage: Option<DeviceAudioByteStore>,
    storage_dir: PathBuf,
    receive_permits: Arc<Semaphore>,
    probe_permits: Arc<Semaphore>,
    decrypt_permits: Arc<Semaphore>,
    playback_decrypt_permits: Arc<Semaphore>,
    preparation: Arc<preparation::Preparation>,
    namespace_scan: Arc<tokio::sync::Mutex<Option<tokio::fs::ReadDir>>>,
    metrics: Option<crate::telemetry::Metrics>,
    playback_cache: Arc<content::PlaybackCache>,
}

#[derive(Clone)]
struct DeviceAudioByteStore {
    operator: opendal::Operator,
    config: S3Config,
    strongbox_key: String,
}

pub(crate) fn build_runtime(
    config: &Config,
    dbx: &DatabaseConnection,
    files: Option<&FileRegistryDb>,
    storage: Option<&opendal::Operator>,
    metrics: Option<crate::telemetry::Metrics>,
) -> Arc<DeviceAudioRuntime> {
    let storage = match build_byte_store(config, storage) {
        Ok(storage) => Some(storage),
        Err(error) => {
            log::warn!("Device audio byte storage is unavailable: {error:#}");
            None
        }
    };
    Arc::new(DeviceAudioRuntime {
        dbx: dbx.clone(),
        files: files.cloned(),
        storage,
        storage_dir: PathBuf::from(&config.storage_dir),
        receive_permits: Arc::new(Semaphore::new(
            DEVICE_AUDIO_RECEIVE_CONCURRENCY,
        )),
        probe_permits: Arc::new(Semaphore::new(DEVICE_AUDIO_PROBE_CONCURRENCY)),
        decrypt_permits: Arc::new(Semaphore::new(
            DEVICE_AUDIO_DECRYPT_CONCURRENCY,
        )),
        playback_decrypt_permits: Arc::new(Semaphore::new(
            DEVICE_AUDIO_BACKGROUND_CONCURRENCY
                + DEVICE_AUDIO_INTERACTIVE_CONCURRENCY,
        )),
        preparation: Arc::new(preparation::Preparation::new()),
        namespace_scan: Arc::new(tokio::sync::Mutex::new(None)),
        metrics,
        playback_cache: Arc::new(content::PlaybackCache::default()),
    })
}

fn build_byte_store(
    config: &Config,
    storage: Option<&opendal::Operator>,
) -> anyhow::Result<DeviceAudioByteStore> {
    let operator = storage
        .cloned()
        .ok_or_else(|| unavailable("S3 operator is missing"))
        .c(h!())?;
    let raw_config = config
        .s3_config
        .as_ref()
        .ok_or_else(|| unavailable("[s3_config] is missing"))
        .c(h!())?;
    let storage_config = S3Config::with_prefix(raw_config, String::new());
    if !storage_config.is_configured() || config.storage_dir.trim().is_empty() {
        return Err(
            unavailable("S3 bucket and storage_dir are required").into()
        );
    }
    crate::storage::key_from_b64(&raw_config.strongbox_key).c(h!())?;
    Ok(DeviceAudioByteStore {
        operator,
        config: storage_config,
        strongbox_key: raw_config.strongbox_key.clone(),
    })
}

fn unavailable(message: &str) -> AppError {
    AppError::ServiceUnavailable {
        msg: format!("Device audio is unavailable: {message}"),
        retry_after_secs: DEVICE_AUDIO_BUSY_RETRY_AFTER_SECS,
    }
}

impl DeviceAudioRuntime {
    fn file_database(&self) -> anyhow::Result<&DatabaseConnection> {
        let files = self
            .files
            .as_ref()
            .ok_or_else(|| unavailable("[file_registry] is missing"))
            .c(h!())?;
        Ok(files.connection())
    }

    fn byte_store(&self) -> anyhow::Result<&DeviceAudioByteStore> {
        self.storage
            .as_ref()
            .ok_or_else(|| unavailable("byte storage is not configured"))
            .c(h!())
    }
}

pub(crate) async fn authorize_source(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
) -> anyhow::Result<()> {
    bl::authorize(runtime, actor_id, device_id, bl::AudioAccess::Source)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn receive(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::ReceiveDeviceAudioCommand,
) -> anyhow::Result<types::ReceiveDeviceAudioOutcome> {
    ingest::receive(Arc::new(runtime.clone()), actor_id, command)
        .await
        .c(h!())
}

pub(crate) async fn list(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::ListDeviceAudioCommand,
) -> anyhow::Result<types::ListDeviceAudioRsp> {
    bl::list(runtime, actor_id, command).await.c(h!())
}

pub(crate) async fn detail(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::DeviceAudioDetailCommand,
) -> anyhow::Result<types::DeviceAudioDetails> {
    bl::detail(runtime, actor_id, command).await.c(h!())
}

pub(crate) async fn save_transcription(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::SaveDeviceAudioTranscriptionCommand,
) -> anyhow::Result<types::SaveDeviceAudioTranscriptionOutcome> {
    bl::save_transcription(runtime, actor_id, command)
        .await
        .c(h!())
}

pub(crate) async fn set_processed(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::SetDeviceAudioProcessingCommand,
) -> anyhow::Result<types::SetDeviceAudioProcessingOutcome> {
    bl::set_processed(runtime, actor_id, command).await.c(h!())
}

pub(crate) async fn cleanup_once(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    worker::cleanup_once(runtime).await.c(h!())
}

pub(crate) async fn open_content(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    command: types::OpenDeviceAudioCommand,
) -> anyhow::Result<types::DeviceAudioContent> {
    content::open_content(Arc::new(runtime.clone()), actor_id, command)
        .await
        .c(h!())
}

pub(crate) async fn run_cleanup_nofail(
    runtime: Arc<DeviceAudioRuntime>,
    cancellation: tokio_util::sync::CancellationToken,
) {
    worker::run_cleanup_nofail(runtime, cancellation).await;
}

pub(crate) async fn authorize_read(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
) -> anyhow::Result<()> {
    bl::authorize(runtime, actor_id, device_id, bl::AudioAccess::Read)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn authorize_edit(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
) -> anyhow::Result<()> {
    bl::authorize(runtime, actor_id, device_id, bl::AudioAccess::Edit)
        .await
        .c(h!())?;
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) enum DeviceAudioMediaError {
    UnsupportedMedia,
    InvalidAudio { reason: String },
}

impl std::fmt::Display for DeviceAudioMediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedMedia => write!(f, "Непідтримуваний формат аудіо"),
            Self::InvalidAudio { reason } => {
                write!(f, "Некоректне аудіо: {reason}")
            }
        }
    }
}

impl std::error::Error for DeviceAudioMediaError {}

#[derive(Debug)]
pub(crate) enum DeviceAudioHttpError {
    App(AppError),
    Media(DeviceAudioMediaError),
}

impl From<AppError> for DeviceAudioHttpError {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}

impl From<anyhow::Error> for DeviceAudioHttpError {
    fn from(error: anyhow::Error) -> Self {
        match error.chain().find_map(|error| {
            error.downcast_ref::<DeviceAudioMediaError>().cloned()
        }) {
            Some(media) => Self::Media(media),
            None => Self::App(AppError::from(error)),
        }
    }
}

impl std::fmt::Display for DeviceAudioHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::App(error) => std::fmt::Display::fmt(error, f),
            Self::Media(error) => std::fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for DeviceAudioHttpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::App(error) => Some(error),
            Self::Media(error) => Some(error),
        }
    }
}

impl ResponseError for DeviceAudioHttpError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::App(error) => error.error_response().status(),
            Self::Media(DeviceAudioMediaError::UnsupportedMedia) => {
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            }
            Self::Media(DeviceAudioMediaError::InvalidAudio { .. }) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
        }
    }

    fn error_response(&self) -> HttpResponse {
        match self {
            Self::App(error) => error.error_response(),
            Self::Media(error) => {
                let code = match error {
                    DeviceAudioMediaError::UnsupportedMedia => {
                        "device_audio_unsupported_media"
                    }
                    DeviceAudioMediaError::InvalidAudio { .. } => {
                        "device_audio_invalid_audio"
                    }
                };
                HttpResponse::build(self.status_code()).json(
                    serde_json::json!({
                        "message": error.to_string(),
                        "details": { "code": code }
                    }),
                )
            }
        }
    }
}
