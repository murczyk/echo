use actix_identity::Identity;
use actix_web::{
    http::{header, Method, StatusCode},
    web, HttpRequest, HttpResponse, ResponseError,
};
use uuid::Uuid;

use super::{query, types::*, worker};
use crate::{
    config::KMZ_CONTENT_TYPE,
    devices::config::*,
    devices::files::content::read::load_published_content,
    error::AppError,
    h,
    types::{Env, ShortContextErr},
};

const BASE: &str = "/api/device/files";

struct PreviewError(StatusCode, &'static str);

enum Failure {
    App(AppError),
    Preview(PreviewError),
}
impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}

impl Failure {
    fn c(self, context: &'static str) -> Self {
        match self {
            Self::App(error) => Self::App(error.c(context)),
            Self::Preview(error) => Self::Preview(error),
        }
    }
}

fn reject(status: StatusCode, code: &'static str) -> Failure {
    Failure::Preview(PreviewError(status, code))
}

fn unavailable() -> Failure {
    reject(StatusCode::SERVICE_UNAVAILABLE, "preview_unavailable")
}

fn render(result: Result<HttpResponse, Failure>) -> HttpResponse {
    let mut response = match result {
        Ok(response) => response,
        Err(Failure::App(
            error @ (AppError::Unauthenticated
            | AppError::Forbidden(_)
            | AppError::ForbiddenWithHeader { .. }
            | AppError::NotFound),
        )) => error.error_response(),
        Err(Failure::App(error)) => {
            crate::types::warn!(
                "device preview request unavailable: {error:#}"
            );
            return render(Err(unavailable()));
        }
        Err(Failure::Preview(PreviewError(status, code))) => {
            let mut response = HttpResponse::build(status);
            if matches!(
                status,
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
            ) {
                response.insert_header((
                    header::RETRY_AFTER,
                    DEVICE_FILE_PREVIEW_GEODATA_RETRY_COOLDOWN_SECONDS
                        .to_string(),
                ));
            }
            response
                .json(serde_json::json!({"code":code,"message":message(code)}))
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response
}

fn message(code: &str) -> &'static str {
    match code {
        "source_invalid" => "Некоректний картографічний файл",
        "result_invalid" => "Конвертер повернув некоректний KMZ",
        "source_too_large" => "Файл перевищує обмеження конвертації",
        "result_too_large" => "Результат конвертації перевищує обмеження",
        "unsupported_format" => "Цей формат не підтримує конвертацію",
        "conversion_timeout" => "Час конвертації вичерпано",
        "conversion_unavailable" => "Конвертер тимчасово недоступний",
        "storage_unavailable" => "Сховище тимчасово недоступне",
        "admission_full" | "retry_cooldown" => {
            "Спробуйте підготувати перегляд пізніше"
        }
        "generation_conflict" => "Стан перегляду змінився",
        "not_found" => "Файл не знайдено",
        "invalid_request" => "Некоректний запит",
        _ => "Підготовка перегляду тимчасово недоступна",
    }
}

fn database_error(error: anyhow::Error) -> Failure {
    if let Some(rejection) = error.downcast_ref::<query::Rejection>() {
        let status = match rejection.0 {
            "not_found" => StatusCode::NOT_FOUND,
            "invalid_request" => StatusCode::BAD_REQUEST,
            "unsupported_format" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "source_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            "generation_conflict" => StatusCode::CONFLICT,
            "admission_full" | "retry_cooldown" => {
                StatusCode::TOO_MANY_REQUESTS
            }
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        return reject(status, rejection.0);
    }
    crate::types::warn!("device preview repository unavailable: {error:#}");
    unavailable()
}

fn archive_members(request: &HttpRequest) -> Result<Option<String>, Failure> {
    #[derive(serde::Deserialize)]
    struct Selection {
        archive_members: Option<String>,
    }
    let selection = web::Query::<Selection>::from_query(request.query_string())
        .map_err(|_| reject(StatusCode::BAD_REQUEST, "invalid_request"))
        .map_err(|error| error.c(h!()))?;
    if let Some(members) = &selection.archive_members {
        super::archive::indices(members)
            .map_err(database_error)
            .map_err(|error| error.c(h!()))?;
    }
    Ok(selection.into_inner().archive_members)
}

fn path(
    path: web::Path<(String, String, String)>,
) -> Result<(Uuid, Uuid, i64), Failure> {
    let (device, file, revision) = path.into_inner();
    let parse = |value: &str| {
        Uuid::parse_str(value)
            .map_err(|_| reject(StatusCode::NOT_FOUND, "not_found"))
    };
    let revision = revision
        .parse()
        .ok()
        .filter(|value: &i64| *value > 0)
        .ok_or_else(|| reject(StatusCode::NOT_FOUND, "not_found"))
        .map_err(|error| error.c(h!()))?;
    Ok((
        parse(&device).map_err(|error| error.c(h!()))?,
        parse(&file).map_err(|error| error.c(h!()))?,
        revision,
    ))
}

async fn login(
    env: &Env,
    identity: Option<Identity>,
) -> Result<crate::entities::login::Model, Failure> {
    let identity = identity
        .ok_or(AppError::Unauthenticated)
        .map_err(|error| error.c(h!()))?;
    crate::devices::access::resolve_current_login(&env.dbx, &identity)
        .await
        .map_err(|error| Failure::from(error.c(h!())))
}

fn configured(env: &Env) -> Result<(), Failure> {
    let strongbox = env
        .config
        .s3_config
        .as_ref()
        .ok_or_else(unavailable)
        .map_err(|error| error.c(h!()))?;
    let config = env
        .s3_config
        .as_ref()
        .ok_or_else(unavailable)
        .map_err(|error| error.c(h!()))?;
    if env.s3.is_none()
        || env.config.alpine_converter_url.is_none()
        || !crate::storage::is_s3_encryption_ready(
            config,
            &strongbox.strongbox_key,
        )
    {
        return Err(unavailable());
    }
    Ok(())
}

fn response(
    device: Uuid,
    file: Uuid,
    revision: i64,
    current: Option<query::Preview>,
) -> DeviceFileGeodataPreviewRsp {
    let mut response = DeviceFileGeodataPreviewRsp {
        file_id: file,
        revision,
        generation: None,
        status: DeviceFileGeodataPreviewStatus::GeodataIdle,
        retryable: false,
        retry_after_ms: None,
        result_size_bytes: None,
        result_url: None,
        error_code: None,
        error_message: None,
    };
    if let Some(current) = current {
        response.generation = Some(current.generation);
        response.status = match current.state.as_str() {
            "queued" => DeviceFileGeodataPreviewStatus::GeodataQueued,
            "running" => DeviceFileGeodataPreviewStatus::GeodataRunning,
            "retry_wait" => DeviceFileGeodataPreviewStatus::GeodataRetryWait,
            "ready" => DeviceFileGeodataPreviewStatus::GeodataReady,
            _ => DeviceFileGeodataPreviewStatus::GeodataFailed,
        };
        response.retryable = current.retryable;
        match response.status {
            DeviceFileGeodataPreviewStatus::GeodataReady => {
                response.result_size_bytes = current.result_size_bytes;
                let suffix = current
                    .archive_members
                    .as_ref()
                    .map(|members| format!("?archive_members={members}"))
                    .unwrap_or_default();
                response.result_url=Some(format!("{BASE}/{device}/{file}/revisions/{revision}/preview/geodata/{}/content{suffix}",current.generation));
            }
            DeviceFileGeodataPreviewStatus::GeodataFailed => {
                response.error_message = current
                    .error_code
                    .as_deref()
                    .map(|code| message(code).to_owned());
                response.error_code = current.error_code;
                if response.retryable {
                    response.retry_after_ms=Some(((current.updated_at+chrono::Duration::seconds(DEVICE_FILE_PREVIEW_GEODATA_RETRY_COOLDOWN_SECONDS))-chrono::Utc::now().fixed_offset()).num_milliseconds().max(0));
                }
            }
            _ => {
                response.retry_after_ms =
                    Some(DEVICE_FILE_PREVIEW_GEODATA_STATUS_POLL_MS)
            }
        }
    }
    response
}

#[actix_web::get("/api/device/files/{device_id}/{file_id}/revisions/{revision}/preview/geodata")]
pub(super) async fn geodata_status(
    request: HttpRequest,
    env: web::Data<Env>,
    identity: Option<Identity>,
    selected: web::Path<(String, String, String)>,
) -> HttpResponse {
    render(
        status_inner(&env, identity, selected, archive_members(&request)).await,
    )
}

async fn status_inner(
    env: &Env,
    identity: Option<Identity>,
    selected: web::Path<(String, String, String)>,
    members: Result<Option<String>, Failure>,
) -> Result<HttpResponse, Failure> {
    let members = members.map_err(|error| error.c(h!()))?;
    let members = members.as_deref();
    let (device, file, revision) =
        path(selected).map_err(|error| error.c(h!()))?;
    let login = login(env, identity).await.map_err(|error| error.c(h!()))?;
    load_published_content(env, &login, device, file, revision)
        .await
        .map_err(|error| error.c(h!()))?;
    let db = env
        .file_registry_db()
        .map_err(|error| error.c(h!()))?
        .connection();
    let current =
        query::current_selection(db, (device, file, revision), members)
            .await
            .map_err(|error| database_error(error.context(h!())))?;
    Ok(HttpResponse::Ok().json(response(device, file, revision, current)))
}

#[actix_web::post("/api/device/files/{device_id}/{file_id}/revisions/{revision}/preview/geodata")]
pub(super) async fn prepare(
    request: HttpRequest,
    env: web::Data<Env>,
    identity: Option<Identity>,
    selected: web::Path<(String, String, String)>,
    body: Result<web::Bytes, actix_web::Error>,
) -> HttpResponse {
    let result = match body {
        Ok(body) => {
            prepare_inner(
                &env,
                identity,
                selected,
                &body,
                None,
                archive_members(&request),
            )
            .await
        }
        Err(_) => Err(reject(StatusCode::PAYLOAD_TOO_LARGE, "invalid_request")),
    };
    render(result)
}

#[actix_web::post("/api/device/files/{device_id}/{file_id}/revisions/{revision}/preview/geodata/retry")]
pub(super) async fn retry(
    request: HttpRequest,
    env: web::Data<Env>,
    identity: Option<Identity>,
    selected: web::Path<(String, String, String)>,
    body: Result<web::Json<RetryDeviceFileGeodataPreviewReq>, actix_web::Error>,
) -> HttpResponse {
    let result = match body {
        Ok(body) => {
            prepare_inner(
                &env,
                identity,
                selected,
                &[],
                Some(body.expected_generation),
                archive_members(&request),
            )
            .await
        }
        Err(_) => Err(reject(StatusCode::BAD_REQUEST, "invalid_request")),
    };
    render(result)
}

async fn prepare_inner(
    env: &Env,
    identity: Option<Identity>,
    selected: web::Path<(String, String, String)>,
    body: &[u8],
    expected: Option<Uuid>,
    members: Result<Option<String>, Failure>,
) -> Result<HttpResponse, Failure> {
    let members = members.map_err(|error| error.c(h!()))?;
    let members = members.as_deref();
    let (device, file, revision) =
        path(selected).map_err(|error| error.c(h!()))?;
    let login = login(env, identity).await.map_err(|error| error.c(h!()))?;
    let source = load_published_content(env, &login, device, file, revision)
        .await
        .map_err(|error| error.c(h!()))?;
    if !query::source_allowed(
        &source.name,
        source.extension.as_deref(),
        source.mime_type.as_deref(),
        members,
    ) {
        return Err(reject(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_format",
        ));
    }
    if source.source_size_bytes > query::source_limit(members) as i64 {
        return Err(reject(StatusCode::PAYLOAD_TOO_LARGE, "source_too_large"));
    }
    if !body.is_empty() {
        return Err(reject(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let available = configured(env).is_ok();
    let db = env
        .file_registry_db()
        .map_err(|error| error.c(h!()))?
        .connection();
    let prior = query::current_selection(db, (device, file, revision), members)
        .await
        .map_err(|error| database_error(error.context(h!())))?;
    let generation = match query::prepare_selection(
        db,
        (device, file, revision),
        members,
        expected,
        available,
    )
    .await
    {
        Ok(generation) => generation,
        Err(error) => {
            worker::record(env, "prepare_reject");
            return Err(database_error(error.context(h!())));
        }
    };
    worker::record(
        env,
        if prior.is_some_and(|prior| prior.generation == generation) {
            "prepare_reuse"
        } else {
            "prepare_create"
        },
    );
    let current =
        query::current_selection(db, (device, file, revision), members)
            .await
            .map_err(|error| database_error(error.context(h!())))?;
    let response = response(device, file, revision, current);
    let status = if matches!(
        response.status,
        DeviceFileGeodataPreviewStatus::GeodataReady
            | DeviceFileGeodataPreviewStatus::GeodataFailed
    ) {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok(HttpResponse::build(status).json(response))
}

#[actix_web::route("/api/device/files/{device_id}/{file_id}/revisions/{revision}/preview/geodata/{generation}/content",method="GET",method="HEAD")]
pub(super) async fn content(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    selected: web::Path<(String, String, String, String)>,
) -> HttpResponse {
    render(content_inner(&env, identity, request, selected).await)
}

async fn content_inner(
    env: &Env,
    identity: Option<Identity>,
    request: HttpRequest,
    selected: web::Path<(String, String, String, String)>,
) -> Result<HttpResponse, Failure> {
    let members = archive_members(&request).map_err(|error| error.c(h!()))?;
    let members = members.as_deref();
    let (device, file, revision, generation) = selected.into_inner();
    let parse = |value: &str| {
        Uuid::parse_str(value)
            .map_err(|_| reject(StatusCode::NOT_FOUND, "not_found"))
    };
    let (device, file, generation) = (
        parse(&device).map_err(|error| error.c(h!()))?,
        parse(&file).map_err(|error| error.c(h!()))?,
        parse(&generation).map_err(|error| error.c(h!()))?,
    );
    let revision = revision
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| reject(StatusCode::NOT_FOUND, "not_found"))
        .map_err(|error| error.c(h!()))?;
    let login = login(env, identity).await.map_err(|error| error.c(h!()))?;
    load_published_content(env, &login, device, file, revision)
        .await
        .map_err(|error| error.c(h!()))?;
    let db = env
        .file_registry_db()
        .map_err(|error| error.c(h!()))?
        .connection();
    let known = query::load(db, generation)
        .await
        .map_err(|error| database_error(error.context(h!())))?
        .filter(|known| {
            known.device_id == device
                && known.file_id == file
                && known.revision == revision
                && known.source_file_id.is_some()
                && known.archive_members.as_deref() == members
        })
        .ok_or_else(|| reject(StatusCode::NOT_FOUND, "not_found"))
        .map_err(|error| error.c(h!()))?;
    let current =
        query::current_selection(db, (device, file, revision), members)
            .await
            .map_err(|error| database_error(error.context(h!())))?
            .filter(|current| {
                current.generation == known.generation
                    && current.state == "ready"
            })
            .ok_or_else(|| reject(StatusCode::CONFLICT, "generation_conflict"))
            .map_err(|error| error.c(h!()))?;
    let size = current
        .result_size_bytes
        .ok_or_else(unavailable)
        .map_err(|error| error.c(h!()))? as u64;
    let mut disposition = crate::utils::multipart::download_content_disposition(
        format!("preview-{file}-{revision}-{generation}.kmz"),
    );
    disposition.disposition = header::DispositionType::Attachment;
    let mut response = HttpResponse::Ok();
    response
        .insert_header((header::CONTENT_TYPE, KMZ_CONTENT_TYPE))
        .insert_header((header::CONTENT_LENGTH, size.to_string()))
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header(disposition);
    if request.method() == Method::HEAD {
        return Ok(response.body(actix_web::body::SizedStream::new(
            size,
            futures_util::stream::empty::<Result<web::Bytes, actix_web::Error>>(
            ),
        )));
    }
    let bytes = worker::read_bytes(
        env,
        &current.output_object_key,
        size,
        current
            .result_encrypted
            .ok_or_else(unavailable)
            .map_err(|error| error.c(h!()))?,
        DEVICE_FILE_PREVIEW_GEODATA_CIPHERTEXT_MAX_BYTES,
    )
    .await
    .map_err(|error| database_error(error.context(h!())))?;
    use sha2::{Digest, Sha256};
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if current.result_sha256.as_deref() != Some(digest.as_slice()) {
        return Err(unavailable());
    }
    let login =
        crate::devices::access::resolve_login_by_id(&env.dbx, &login.id)
            .await
            .map_err(|error| Failure::from(error.c(h!())))?;
    load_published_content(env, &login, device, file, revision)
        .await
        .map_err(|error| error.c(h!()))?;
    if !query::current_selection(db, (device, file, revision), members)
        .await
        .map_err(|error| database_error(error.context(h!())))?
        .is_some_and(|fresh| {
            fresh.generation == generation && fresh.state == "ready"
        })
    {
        return Err(reject(StatusCode::CONFLICT, "generation_conflict"));
    }
    Ok(response.body(bytes))
}
