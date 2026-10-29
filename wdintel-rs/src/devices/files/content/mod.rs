pub(in crate::devices) mod async_cleanup;
mod async_finalizer;
pub(in crate::devices) mod finalizer;
pub(in crate::devices) mod local_cache;
mod preview;
mod preview_cache;
mod protocol;
pub(in crate::devices) mod read;
pub(in crate::devices) mod repository;
mod reuse;
mod spool;
pub(crate) mod worker;

#[cfg(test)]
mod acceptance_tests;

use std::path::PathBuf;
use std::sync::Arc;

use actix_identity::Identity;
use actix_web::dev::HttpServiceFactory;
use actix_web::http::{header, Method};
use actix_web::{web, HttpRequest, HttpResponse};
use chrono::Utc;
use futures_util::StreamExt;
use opendal::Operator;
use tokio::sync::Semaphore;
use uuid::Uuid;

use self::protocol::{
    ContentError, UPLOAD_EXPIRES, UPLOAD_LENGTH, UPLOAD_METADATA, UPLOAD_OFFSET,
};
use self::repository::{
    CreateOutcome, NewUpload, RevalidateOutcome, Upload, UploadStatus,
};
use self::spool::{AcquireError, AppendError, LockedSpool, Spool};
use crate::config::{
    Config, ContentLimitsConfig, DEVICE_UPLOAD_FINALIZATION_COMPLETE_BODY_BYTES,
};
use crate::devices::config::*;
use crate::devices::upload_finalization::types::CompleteDeviceFileUploadReq;
use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::storage::S3Config;
use crate::types::{warn, Env, Mode, ShortContextErr};

pub(crate) const COLLECTION_PATH: &str =
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/content-uploads";
pub(crate) const RESOURCE_PATH: &str =
    "/api/device/file-content-uploads/{upload_id}";
pub(crate) const COMPLETE_PATH: &str =
    "/api/device/file-content-uploads/{upload_id}/complete";

#[derive(Clone)]
pub(crate) struct DeviceFileContentRuntime {
    config: ContentLimitsConfig,
    spool: Spool,
    storage: Operator,
    storage_config: S3Config,
    managed_storage: Arc<crate::storage::finalization::ManagedStorage>,
    strongbox_key: String,
    file_registry_db: FileRegistryDb,
    finalization_permits: Arc<Semaphore>,
    finalization_waiters: Arc<Semaphore>,
    metrics: Option<crate::telemetry::Metrics>,
}

pub(crate) async fn build_runtime(
    config: &Config,
    s3: Option<&Operator>,
    file_registry_db: Option<&FileRegistryDb>,
    metrics: Option<crate::telemetry::Metrics>,
    mode: Mode,
) -> Option<Arc<DeviceFileContentRuntime>> {
    match try_build_runtime(config, s3, file_registry_db, metrics, mode).await {
        Ok(runtime) => runtime,
        Err(error) => {
            warn!("Device content uploads are unavailable: {error:#?}");
            None
        }
    }
}

async fn try_build_runtime(
    config: &Config,
    s3: Option<&Operator>,
    file_registry_db: Option<&FileRegistryDb>,
    metrics: Option<crate::telemetry::Metrics>,
    mode: Mode,
) -> Result<Option<Arc<DeviceFileContentRuntime>>, AppError> {
    let limits = config
        .file_registry
        .as_ref()
        .map(|registry| registry.content_limits.clone())
        .unwrap_or_default();
    limits
        .validate()
        .map_err(|msg| AppError::BL { msg })
        .map_err(|error| error.c(h!()))?;
    let Some(file_registry_db) = file_registry_db else {
        return Ok(None);
    };
    if mode == Mode::Test {
        return Ok(None);
    }
    if config.storage_dir.trim().is_empty() {
        return Err(AppError::BL {
            msg:
                "persistent storage_dir is required for device content uploads"
                    .to_string(),
        });
    }
    let s3 = s3
        .cloned()
        .ok_or_else(|| AppError::BL {
            msg: "S3 is required for device content uploads".to_string(),
        })
        .map_err(|error| error.c(h!()))?;
    let raw_s3 = config
        .s3_config
        .as_ref()
        .ok_or_else(|| AppError::BL {
            msg: "[s3_config] is required for device content uploads"
                .to_string(),
        })
        .map_err(|error| error.c(h!()))?;
    if raw_s3.s3_bucket.trim().is_empty() {
        return Err(AppError::BL {
            msg: "device content S3 bucket must be configured".to_string(),
        });
    }
    crate::storage::key_from_b64(&raw_s3.strongbox_key)
        .map_err(|error| error.c(h!()))?;
    let storage_config = S3Config::with_prefix(raw_s3, String::new());
    let required_capacity = limits
        .max_reserved_bytes
        .checked_add(limits.spool_min_free_bytes)
        .ok_or_else(|| AppError::BL {
            msg: "device content spool capacity requirement overflowed"
                .to_string(),
        })
        .map_err(|error| error.c(h!()))?;
    let spool = Spool::initialize(
        PathBuf::from(&config.storage_dir).join("device-file-content-spool"),
        required_capacity,
    )
    .await
    .map_err(|error| AppError::from(error.context(h!())))?;
    Ok(Some(Arc::new(DeviceFileContentRuntime {
        config: limits.clone(),
        spool,
        storage: s3,
        managed_storage: Arc::new(
            crate::storage::finalization::ManagedStorage::new(
                storage_config.clone(),
                &raw_s3.strongbox_key,
            )
            .map_err(|error| AppError::from(error.context(h!())))?,
        ),
        storage_config,
        strongbox_key: raw_s3.strongbox_key.clone(),
        file_registry_db: file_registry_db.clone(),
        finalization_permits: Arc::new(Semaphore::new(
            limits.finalization_max_concurrent,
        )),
        finalization_waiters: Arc::new(Semaphore::new(
            DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING,
        )),
        metrics,
    })))
}

#[cfg(test)]
pub(crate) async fn runtime_for_test(
    file_registry_db: FileRegistryDb,
    spool_root: PathBuf,
    storage: Operator,
    metrics: Option<crate::telemetry::Metrics>,
) -> Arc<DeviceFileContentRuntime> {
    let strongbox_key = crate::storage::generate_strongbox_key_b64();
    let storage_config = S3Config {
        bucket: "device-content-test".to_owned(),
        region: String::new(),
        endpoint: String::new(),
        access_key_id: String::new(),
        secret_access_key: String::new(),
        prefix: String::new(),
    };
    let managed_storage = Arc::new(
        crate::storage::finalization::ManagedStorage::for_test(
            storage.clone(),
            storage_config.clone(),
            &strongbox_key,
        )
        .unwrap(),
    );
    Arc::new(DeviceFileContentRuntime {
        config: ContentLimitsConfig::default(),
        spool: Spool::for_test(spool_root).await.unwrap(),
        storage,
        storage_config,
        strongbox_key,
        managed_storage,
        file_registry_db,
        finalization_permits: Arc::new(Semaphore::new(
            DEVICE_FILE_CONTENT_FINALIZATION_MAX_CONCURRENT,
        )),
        finalization_waiters: Arc::new(Semaphore::new(
            DEVICE_FILE_CONTENT_FINALIZATION_MAX_WAITING,
        )),
        metrics,
    })
}

pub(crate) fn routes() -> impl HttpServiceFactory {
    (
        read::download_content,
        preview::media_content,
        reuse::routes(),
        web::resource(COMPLETE_PATH)
            .wrap(actix_web::middleware::from_fn(
                crate::devices::upload_finalization::ingress::file,
            ))
            .route(web::route().to(complete)),
        web::resource(COLLECTION_PATH).route(web::route().to(collection)),
        web::resource(RESOURCE_PATH).route(web::route().to(resource)),
    )
}

async fn collection(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<(String, String, String)>,
    payload: web::Payload,
) -> HttpResponse {
    if request.method() == Method::OPTIONS {
        return protocol::options(advertised_upload_max_bytes(&env));
    }
    let response =
        collection_inner(env, identity, request, path, payload).await;
    protocol::render(response, false)
}

async fn collection_inner(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<(String, String, String)>,
    mut payload: web::Payload,
) -> Result<HttpResponse, ContentError> {
    let login_id = request_login_id(identity)?;
    require_tus_version(&request)?;
    let (device_id, file_id, revision) = parse_collection_path(path)?;
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx, &login_id, device_id,
    )
    .await
    .map_err(|error| ContentError::from_app(error.c(h!())))?;
    if request.method() != Method::POST {
        return Err(ContentError::method_not_allowed());
    }
    let runtime = runtime(&env)?;
    runtime_preflight(runtime)?;
    ensure_empty_payload(request.headers(), &mut payload).await?;
    let upload_length = protocol::parse_upload_length(
        request.headers(),
        runtime.config.upload_max_bytes,
    )?;
    let expected_sha256 =
        protocol::parse_sha256_metadata(request.headers(), upload_length)?;
    let available_spool_bytes = runtime
        .spool
        .available_bytes()
        .map_err(|error| spool_unavailable(error.context(h!())))?;
    let now = Utc::now().fixed_offset();
    let outcome = repository::create_or_replay(
        runtime.file_registry_db.connection(),
        NewUpload {
            device_id,
            file_id,
            revision,
            created_by_login_id: login_id,
            upload_length,
            expected_sha256,
            available_spool_bytes,
            now,
        },
        &runtime.config,
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?;
    match outcome {
        CreateOutcome::Created(upload) | CreateOutcome::Replayed(upload) => {
            Ok(created_response(&upload))
        }
        CreateOutcome::InProgress(upload) => {
            let retry_after = (upload.expires_at - now).num_seconds().max(1);
            Err(ContentError::conflict("upload_in_progress")
                .header(header::LOCATION, resource_location(upload.id))
                .header(
                    header::RETRY_AFTER,
                    u64::try_from(retry_after).unwrap_or(1).to_string(),
                ))
        }
        CreateOutcome::ContentAlreadyCommitted => {
            Err(ContentError::conflict("content_already_committed"))
        }
        CreateOutcome::RevisionStale => {
            Err(ContentError::conflict("revision_stale"))
        }
        CreateOutcome::NotFound => Err(ContentError::not_found()),
        CreateOutcome::CapacityUnavailable => Err(ContentError::unavailable(
            "capacity_unavailable",
            runtime.config.cleanup_poll_interval_secs,
        )),
    }
}

async fn resource(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
) -> HttpResponse {
    if request.method() == Method::OPTIONS {
        return protocol::options(advertised_upload_max_bytes(&env));
    }
    let is_head = request.method() == Method::HEAD;
    let response = resource_inner(env, identity, request, path, payload).await;
    protocol::render(response, is_head)
}

async fn resource_inner(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
) -> Result<HttpResponse, ContentError> {
    let login_id = request_login_id(identity)?;
    require_tus_version(&request)?;
    let upload_id = parse_uuid(&path)?;
    let runtime = runtime(&env)?;
    let upload = repository::load_upload(
        runtime.file_registry_db.connection(),
        upload_id,
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    .ok_or_else(ContentError::not_found)?;
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &login_id,
        upload.device_id,
    )
    .await
    .map_err(|error| ContentError::from_app(error.c(h!())))?;

    let method = crate::tus::effective_resource_method(
        request.method(),
        request.headers(),
        &[Method::PATCH, Method::DELETE],
    );
    if !matches!(method, Method::HEAD | Method::PATCH | Method::DELETE) {
        return Err(ContentError::method_not_allowed());
    }
    if upload.status != UploadStatus::Open {
        return terminal_resource_response(&upload, &method);
    }
    if method == Method::PATCH {
        protocol::require_patch_content_type(request.headers())?;
    }
    let expected_offset = if method == Method::PATCH {
        Some(protocol::parse_upload_offset(request.headers())?)
    } else {
        None
    };
    let locked = acquire_spool(runtime, upload.id).await?;
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &login_id,
        upload.device_id,
    )
    .await
    .map_err(|error| ContentError::from_app(error.c(h!())))?;
    if crate::devices::upload_finalization::query::file_source_is_pinned(
        runtime.file_registry_db.connection(),
        upload.id,
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    {
        return if method == Method::HEAD {
            Ok(head_response(
                &upload,
                locked
                    .offset()
                    .map_err(|error| spool_unavailable(error.context(h!())))?,
                false,
            ))
        } else {
            Err(ContentError::conflict("upload_finalization_owned"))
        };
    }
    let upload = match repository::revalidate_open(
        runtime.file_registry_db.connection(),
        &upload,
        Utc::now().fixed_offset(),
        runtime.metrics.as_ref(),
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    {
        RevalidateOutcome::Open(upload) => upload,
        outcome => {
            cleanup_created_lock(&locked).await;
            return revalidated_resource_response(outcome, &method, &upload);
        }
    };
    match method {
        Method::HEAD => head_open_response(&upload, &locked),
        Method::PATCH => {
            patch(
                runtime,
                upload,
                locked,
                request,
                payload,
                expected_offset.unwrap(),
            )
            .await
        }
        Method::DELETE => delete(runtime, upload, locked).await,
        _ => unreachable!("resource method checked above"),
    }
}

async fn complete(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
) -> HttpResponse {
    let response = complete_inner(env, identity, request, path, payload).await;
    protocol::render(response, false)
}

async fn complete_inner(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<String>,
    mut payload: web::Payload,
) -> Result<HttpResponse, ContentError> {
    let login_id = request_login_id(identity)?;
    require_tus_version(&request)?;
    let upload_id = parse_uuid(&path)?;
    let runtime = runtime(&env)?;
    let upload = repository::load_upload(
        runtime.file_registry_db.connection(),
        upload_id,
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    .ok_or_else(ContentError::not_found)?;
    let asynchronous = if request.method() == Method::POST {
        parse_complete_payload(&request, &mut payload).await
    } else {
        Ok(false)
    };
    if matches!(asynchronous, Ok(true)) {
        return complete_async(&env, runtime, login_id, &upload)
            .await
            .map_err(|error| {
                error.header(header::CACHE_CONTROL, "private, no-store")
            });
    }
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &login_id,
        upload.device_id,
    )
    .await
    .map_err(|error| ContentError::from_app(error.c(h!())))?;
    if request.method() != Method::POST {
        return Err(ContentError::method_not_allowed());
    }
    if !matches!(upload.status, UploadStatus::Open | UploadStatus::Completed) {
        return Err(ContentError::gone(upload.status.code()));
    }
    asynchronous?;
    if upload.status == UploadStatus::Completed {
        return completed_replay(runtime, upload.id).await;
    }
    let permit = match finalizer::acquire_permit(runtime).await {
        Ok(permit) => permit,
        Err(error) => {
            crate::devices::access::authorize_file_sync_snapshot(
                &env.dbx,
                &login_id,
                upload.device_id,
            )
            .await
            .map_err(|error| ContentError::from_app(error.c(h!())))?;
            let content =
                finalizer::refresh_retryable_upload(runtime, &upload, error)
                    .await?;
            return Ok(HttpResponse::Ok().json(content));
        }
    };
    let locked = acquire_spool(runtime, upload.id).await;
    crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &login_id,
        upload.device_id,
    )
    .await
    .map_err(|error| ContentError::from_app(error.c(h!())))?;
    let locked = locked?;
    finalizer::ensure_sync_source_available(runtime, &upload).await?;
    let upload = match repository::revalidate_open(
        runtime.file_registry_db.connection(),
        &upload,
        Utc::now().fixed_offset(),
        runtime.metrics.as_ref(),
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    {
        RevalidateOutcome::Open(upload) => upload,
        RevalidateOutcome::Completed(content) => {
            cleanup_created_lock(&locked).await;
            return Ok(HttpResponse::Ok().json(content));
        }
        RevalidateOutcome::Terminal(status) => {
            cleanup_created_lock(&locked).await;
            return Err(ContentError::gone(status.code()));
        }
        RevalidateOutcome::ContentAlreadyCommitted => {
            cleanup_created_lock(&locked).await;
            return Err(ContentError::conflict("content_already_committed"));
        }
        RevalidateOutcome::Missing => {
            cleanup_created_lock(&locked).await;
            return Err(ContentError::not_found());
        }
    };
    if let Err(error) = runtime_preflight(runtime) {
        let content =
            finalizer::refresh_retryable_upload(runtime, &upload, error)
                .await?;
        return Ok(HttpResponse::Ok().json(content));
    }
    let content =
        finalizer::finalize(&env, runtime, login_id, upload, &locked, permit)
            .await?;
    Ok(HttpResponse::Ok().json(content))
}

async fn complete_async(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    actor: Uuid,
    upload: &Upload,
) -> Result<HttpResponse, ContentError> {
    use crate::devices::upload_finalization::{
        self,
        ingress::{self, AdmissionOutcome},
        types::*,
    };
    let db = runtime.file_registry_db.connection();
    if let Some(response) = replay_file(env, runtime, actor, upload).await? {
        return Ok(ingress::mark_response(
            response,
            AdmissionOutcome::Replayed,
        ));
    }
    upload_finalization::authorize_write(
        env,
        actor,
        upload.device_id,
        FinalizationKind::FinalizationFileKind,
    )
    .await
    .map_err(ContentError::from_app)?;
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .unwrap_or_default();
    if !settings.enabled
        || !settings.is_valid()
        || env.config.storage_dir.is_empty()
    {
        return Err(ContentError::unavailable(
            "async_finalization_unavailable",
            DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
        ));
    }
    if upload.status != UploadStatus::Open {
        return Err(ContentError::gone(upload.status.code()));
    }
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(settings.source_lock_millis);
    let locked = runtime
        .spool
        .acquire_until(upload.id, deadline)
        .await
        .map_err(spool_acquire_error);
    if let Some(response) = replay_file(env, runtime, actor, upload).await? {
        return Ok(ingress::mark_response(
            response,
            AdmissionOutcome::Replayed,
        ));
    }
    upload_finalization::authorize_write(
        env,
        actor,
        upload.device_id,
        FinalizationKind::FinalizationFileKind,
    )
    .await
    .map_err(ContentError::from_app)?;
    let locked = locked?;
    if upload.upload_length > runtime.config.upload_max_bytes {
        return Err(ContentError::payload_too_large(Some("upload_too_large")));
    }
    if locked
        .offset()
        .map_err(|error| spool_unavailable(error.context(h!())))?
        != upload.upload_length
    {
        return Err(ContentError::conflict("upload_incomplete"));
    }
    locked
        .make_durable(upload.upload_length)
        .await
        .map_err(|error| spool_unavailable(error.context(h!())))?;
    upload_finalization::fault::point("file_source_durable", upload.id).await;
    upload_finalization::authorize_write(
        env,
        actor,
        upload.device_id,
        FinalizationKind::FinalizationFileKind,
    )
    .await
    .map_err(ContentError::from_app)?;
    let snapshot = repository::admit_file(db, upload, actor, &settings).await?;
    upload_finalization::fault::point("file_admission_committed", upload.id)
        .await;
    Ok(async_file_response(snapshot))
}

async fn replay_file(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    actor: Uuid,
    upload: &Upload,
) -> Result<Option<HttpResponse>, ContentError> {
    use crate::devices::upload_finalization::{self, query, types::*};
    let db = runtime.file_registry_db.connection();
    if let Some((job, _)) = query::read_file_job(db, upload.id)
        .await
        .map_err(|error| repository_unavailable(error.context(h!())))?
    {
        let snapshot = upload_finalization::get_snapshot(env, job.id, actor)
            .await
            .map_err(ContentError::from_app)?;
        return Ok(Some(async_file_response(snapshot)));
    }
    let owned: bool = sqlx::query_scalar("select exists(select 1 from file_content_upload where id=$1 and created_by_login_id=$2)")
        .bind(upload.id).bind(actor).fetch_one(db.get_postgres_connection_pool()).await
        .map_err(|error| repository_unavailable(error.into()))?;
    if !owned {
        return Err(ContentError::not_found());
    }
    if repository::reconcile_publication(db, upload.id)
        .await
        .map_err(|error| repository_unavailable(error.context(h!())))?
        .is_none()
    {
        return Ok(None);
    }
    upload_finalization::authorize_read(
        env,
        actor,
        upload.device_id,
        FinalizationKind::FinalizationFileKind,
    )
    .await
    .map_err(ContentError::from_app)?;
    let snapshot = repository::adopt_completed_file(db, upload, actor)
        .await
        .map_err(|error| repository_unavailable(error.context(h!())))?;
    Ok(Some(async_file_response(snapshot)))
}

fn async_file_response(
    snapshot: crate::devices::upload_finalization::types::FinalizationJobSnapshot,
) -> HttpResponse {
    use crate::devices::upload_finalization::{self, types::*};
    if matches!(
        snapshot.status,
        FinalizationStatus::FinalizationCompleted
            | FinalizationStatus::FinalizationFailed
    ) {
        return upload_finalization::status_response(Ok(snapshot));
    }
    HttpResponse::Accepted()
        .insert_header((
            header::LOCATION,
            format!("/api/device/upload-finalization-jobs/{}", snapshot.job_id),
        ))
        .insert_header((header::RETRY_AFTER, "1"))
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .json(QueuedAcknowledgement {
            status: QueuedStatus::FinalizationQueuedAcknowledgement,
            job_id: snapshot.job_id,
        })
}

async fn patch(
    runtime: &DeviceFileContentRuntime,
    upload: Upload,
    locked: LockedSpool,
    request: HttpRequest,
    payload: web::Payload,
    expected_offset: u64,
) -> Result<HttpResponse, ContentError> {
    let actual_offset = locked
        .offset()
        .map_err(|error| spool_unavailable(error.context(h!())))?;
    if actual_offset != expected_offset {
        return Err(ContentError::conflict("offset_mismatch")
            .header(UPLOAD_OFFSET, actual_offset.to_string()));
    }
    let remaining = upload.upload_length.saturating_sub(actual_offset);
    if protocol::content_length(request.headers())
        .is_some_and(|length| length > remaining)
    {
        return Err(ContentError::payload_too_large(None)
            .header(UPLOAD_OFFSET, actual_offset.to_string()));
    }
    let appended = match locked
        .append(payload, actual_offset, upload.upload_length)
        .await
    {
        Ok(appended)
            if appended.offset != actual_offset
                && appended.accepted_bytes == 0 =>
        {
            return Err(ContentError::conflict("offset_mismatch")
                .header(UPLOAD_OFFSET, appended.offset.to_string()));
        }
        Ok(appended) => appended,
        Err(AppendError::ExceedsLength { offset }) => {
            return Err(ContentError::payload_too_large(Some(
                "chunk_exceeds_upload_length",
            ))
            .header(UPLOAD_OFFSET, offset.to_string()));
        }
        Err(AppendError::Payload(error)) => {
            return Err(ContentError::from_app(
                AppError::PayloadError { source: error }.c(h!()),
            ));
        }
        Err(AppendError::Internal(error)) => {
            return Err(spool_unavailable_with_offset(
                &locked,
                error.context(h!()),
            ));
        }
    };
    let now = Utc::now().fixed_offset();
    let refreshed = if appended.accepted_bytes > 0 {
        repository::refresh_open(
            runtime.file_registry_db.connection(),
            &upload,
            now,
            true,
            &runtime.config,
            runtime.metrics.as_ref(),
        )
        .await
    } else {
        repository::revalidate_open(
            runtime.file_registry_db.connection(),
            &upload,
            now,
            runtime.metrics.as_ref(),
        )
        .await
    }
    .map_err(|error| repository_unavailable(error.context(h!())))?;
    match refreshed {
        RevalidateOutcome::Open(upload) => {
            if appended.accepted_bytes > 0 {
                record_accepted_bytes(runtime, appended.accepted_bytes);
            }
            Ok(HttpResponse::NoContent()
                .insert_header((UPLOAD_OFFSET, appended.offset.to_string()))
                .insert_header((
                    UPLOAD_EXPIRES,
                    protocol::upload_expires(upload.expires_at),
                ))
                .finish())
        }
        outcome => {
            if appended.accepted_bytes > 0 {
                if let Err(error) = locked.truncate(actual_offset).await {
                    warn!("failed to roll back stale device content chunk: {error:#?}");
                }
            }
            revalidated_resource_response(outcome, &Method::PATCH, &upload)
        }
    }
}

async fn delete(
    runtime: &DeviceFileContentRuntime,
    upload: Upload,
    locked: LockedSpool,
) -> Result<HttpResponse, ContentError> {
    let outcome = repository::transition_open(
        runtime.file_registry_db.connection(),
        &upload,
        UploadStatus::Aborted,
        Utc::now().fixed_offset(),
        runtime.metrics.as_ref(),
    )
    .await
    .map_err(|error| {
        if error.downcast_ref::<crate::devices::upload_finalization::types::FinalizationFailure>()
            == Some(&crate::devices::upload_finalization::types::FinalizationFailure::SourceOwned)
        {
            ContentError::conflict("upload_finalization_owned")
        } else {
            repository_unavailable(error.context(h!()))
        }
    })?;
    drop(locked);
    match outcome {
        RevalidateOutcome::Terminal(UploadStatus::Aborted) => {
            Ok(HttpResponse::NoContent().finish())
        }
        outcome => {
            revalidated_resource_response(outcome, &Method::DELETE, &upload)
        }
    }
}

fn terminal_resource_response(
    upload: &Upload,
    method: &Method,
) -> Result<HttpResponse, ContentError> {
    match (upload.status, method) {
        (UploadStatus::Completed, &Method::HEAD) => {
            Ok(head_response(upload, upload.upload_length, false))
        }
        (UploadStatus::Completed, _) => {
            Err(ContentError::conflict("content_already_committed"))
        }
        (status, _) => Err(ContentError::gone(status.code())),
    }
}

fn revalidated_resource_response(
    outcome: RevalidateOutcome,
    method: &Method,
    known: &Upload,
) -> Result<HttpResponse, ContentError> {
    match outcome {
        RevalidateOutcome::Open(_) => unreachable!("open handled by caller"),
        RevalidateOutcome::Completed(content) if method == Method::HEAD => {
            let _ = content;
            Ok(head_response(known, known.upload_length, false))
        }
        RevalidateOutcome::Completed(_) => {
            Err(ContentError::conflict("content_already_committed"))
        }
        RevalidateOutcome::Terminal(status) => {
            Err(ContentError::gone(status.code()))
        }
        RevalidateOutcome::ContentAlreadyCommitted => {
            Err(ContentError::conflict("content_already_committed"))
        }
        RevalidateOutcome::Missing => Err(ContentError::not_found()),
    }
}

fn head_open_response(
    upload: &Upload,
    locked: &LockedSpool,
) -> Result<HttpResponse, ContentError> {
    let offset = locked
        .offset()
        .map_err(|error| spool_unavailable(error.context(h!())))?;
    Ok(head_response(upload, offset, true))
}

fn head_response(
    upload: &Upload,
    offset: u64,
    include_expiry: bool,
) -> HttpResponse {
    let mut response = HttpResponse::NoContent();
    response.insert_header((UPLOAD_LENGTH, upload.upload_length.to_string()));
    response.insert_header((UPLOAD_OFFSET, offset.to_string()));
    response.insert_header((
        UPLOAD_METADATA,
        protocol::canonical_metadata(&upload.expected_sha256),
    ));
    if include_expiry {
        response.insert_header((
            UPLOAD_EXPIRES,
            protocol::upload_expires(upload.expires_at),
        ));
    }
    response.finish()
}

fn created_response(upload: &Upload) -> HttpResponse {
    HttpResponse::Created()
        .insert_header((header::LOCATION, resource_location(upload.id)))
        .insert_header((
            UPLOAD_EXPIRES,
            protocol::upload_expires(upload.expires_at),
        ))
        .finish()
}

async fn completed_replay(
    runtime: &DeviceFileContentRuntime,
    upload_id: Uuid,
) -> Result<HttpResponse, ContentError> {
    let content = repository::reconcile_publication(
        runtime.file_registry_db.connection(),
        upload_id,
    )
    .await
    .map_err(|error| repository_unavailable(error.context(h!())))?
    .ok_or_else(|| ContentError::conflict("content_already_committed"))?;
    Ok(HttpResponse::Ok().json(content))
}

fn advertised_upload_max_bytes(env: &Env) -> u64 {
    env.device_file_content
        .as_deref()
        .map(|runtime| runtime.config.upload_max_bytes)
        .unwrap_or(DEVICE_FILE_CONTENT_UPLOAD_MAX_BYTES)
}

fn runtime(env: &Env) -> Result<&DeviceFileContentRuntime, ContentError> {
    env.file_registry_db()
        .map_err(|error| ContentError::from_app(error.c(h!())))?;
    env.device_file_content.as_deref().ok_or_else(|| {
        ContentError::unavailable(
            "device_content_unavailable",
            DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
        )
    })
}

fn runtime_preflight(
    runtime: &DeviceFileContentRuntime,
) -> Result<(), ContentError> {
    runtime
        .spool
        .preflight()
        .map_err(|error| spool_unavailable(error.context(h!())))
}

fn request_login_id(identity: Option<Identity>) -> Result<Uuid, ContentError> {
    let identity = identity
        .ok_or_else(|| ContentError::from_app(AppError::Unauthenticated))?;
    crate::users::login_id_from_identity(&identity)
        .map_err(|error| ContentError::from_app(error.c(h!())))
}

fn require_tus_version(request: &HttpRequest) -> Result<(), ContentError> {
    if crate::tus::has_supported_version(request.headers()) {
        Ok(())
    } else {
        Err(ContentError::precondition_failed())
    }
}

fn parse_collection_path(
    path: web::Path<(String, String, String)>,
) -> Result<(Uuid, Uuid, i64), ContentError> {
    let (device_id, file_id, revision) = path.into_inner();
    let device_id = parse_uuid(&device_id)?;
    let file_id = parse_uuid(&file_id)?;
    let revision = revision
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision >= 0)
        .ok_or_else(ContentError::not_found)?;
    Ok((device_id, file_id, revision))
}

fn parse_uuid(value: &str) -> Result<Uuid, ContentError> {
    Uuid::parse_str(value).map_err(|_| ContentError::not_found())
}

async fn parse_complete_payload(
    request: &HttpRequest,
    payload: &mut web::Payload,
) -> Result<bool, ContentError> {
    if protocol::content_length(request.headers()).is_some_and(|length| {
        length > DEVICE_UPLOAD_FINALIZATION_COMPLETE_BODY_BYTES as u64
    }) {
        return Err(ContentError::payload_too_large(None));
    }
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|error| {
            ContentError::from_app(
                AppError::PayloadError { source: error }.c(h!()),
            )
        })?;
        if chunk.len()
            > DEVICE_UPLOAD_FINALIZATION_COMPLETE_BODY_BYTES - body.len()
        {
            return Err(ContentError::payload_too_large(None));
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Ok(false);
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next());
    if !content_type.is_some_and(|value| {
        value.trim().eq_ignore_ascii_case("application/json")
    }) {
        return Err(ContentError::unsupported_media_type());
    }
    if body.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(ContentError::bad_request("invalid_finalization_request"));
    }
    serde_json::from_slice::<CompleteDeviceFileUploadReq>(&body)
        .map(|request| request.async_finalization)
        .map_err(|_| ContentError::bad_request("invalid_finalization_request"))
}

async fn ensure_empty_payload(
    headers: &actix_web::http::header::HeaderMap,
    payload: &mut web::Payload,
) -> Result<(), ContentError> {
    if protocol::content_length(headers).is_some_and(|length| length > 0) {
        return Err(ContentError::bad_request("unexpected_request_body"));
    }
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|error| {
            ContentError::from_app(
                AppError::PayloadError { source: error }.c(h!()),
            )
        })?;
        if !chunk.is_empty() {
            return Err(ContentError::bad_request("unexpected_request_body"));
        }
    }
    Ok(())
}

async fn acquire_spool(
    runtime: &DeviceFileContentRuntime,
    upload_id: Uuid,
) -> Result<LockedSpool, ContentError> {
    runtime
        .spool
        .acquire(upload_id)
        .await
        .map_err(spool_acquire_error)
}

fn spool_acquire_error(error: AcquireError) -> ContentError {
    match error {
        AcquireError::Busy => ContentError::unavailable(
            "upload_busy",
            DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
        ),
        AcquireError::Internal(error) => spool_unavailable(error.context(h!())),
    }
}

async fn cleanup_created_lock(locked: &LockedSpool) {
    if let Err(error) = locked.remove_created_lock().await {
        warn!("failed to remove orphan device content lock: {error:#?}");
    }
}

fn resource_location(upload_id: Uuid) -> String {
    format!("/api/device/file-content-uploads/{upload_id}")
}

fn repository_unavailable(error: anyhow::Error) -> ContentError {
    warn!("device content repository failed: {error:#?}");
    ContentError::unavailable(
        "file_registry_unavailable",
        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
    )
}

fn spool_unavailable_with_offset(
    locked: &LockedSpool,
    error: anyhow::Error,
) -> ContentError {
    let response = spool_unavailable(error);
    match locked.offset() {
        Ok(offset) => response.header(UPLOAD_OFFSET, offset.to_string()),
        Err(error) => {
            warn!("cannot read device content offset after spool failure: {error:#?}");
            response
        }
    }
}

fn spool_unavailable(error: anyhow::Error) -> ContentError {
    warn!("device content spool failed: {error:#?}");
    ContentError::unavailable(
        "spool_unavailable",
        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
    )
}

fn record_accepted_bytes(
    runtime: &DeviceFileContentRuntime,
    accepted_bytes: u64,
) {
    if let Some(metrics) = &runtime.metrics {
        metrics.record_device_file_content_accepted_bytes(accepted_bytes);
    }
}

fn record_terminal(runtime: &DeviceFileContentRuntime, status: UploadStatus) {
    if let Some(metrics) = &runtime.metrics {
        metrics.record_device_file_content_terminal(status.database_value());
    }
}
