use std::future::Future;
use std::ops::Range;
use std::time::Duration;

use actix_identity::Identity;
use actix_web::http::{header, Method, StatusCode};
use actix_web::{
    web, HttpRequest, HttpResponse, HttpResponseBuilder, ResponseError,
};
use futures_util::{stream, StreamExt};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::preview_cache::{self, CacheBusy, CacheKey};
use super::read::{
    authorize_published_snapshot, load_published_content,
    prepare_authorized_content,
};
use super::repository::PublishedContent;
use crate::devices::access;
use crate::devices::config::{
    DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
    DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS,
    DEVICE_FILE_PREVIEW_MEDIA_CACHE_VERSION,
    DEVICE_FILE_PREVIEW_MEDIA_MAX_ENCRYPTED_PLAINTEXT_BYTES,
    DEVICE_FILE_PREVIEW_MEDIA_RETRY_AFTER_SECS,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};

pub(super) type BodyStream =
    stream::LocalBoxStream<'static, Result<web::Bytes, actix_web::Error>>;
type Target = (Uuid, Uuid, i64);

#[actix_web::route(
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/preview/media",
    method = "GET",
    method = "HEAD"
)]
pub(super) async fn media_content(
    env: web::Data<Env>,
    identity: Option<Identity>,
    request: HttpRequest,
    path: web::Path<Target>,
) -> HttpResponse {
    let result =
        serve_media(env, identity.as_ref(), &request, path.into_inner()).await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error.error_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_ENCODING,
        header::HeaderValue::from_static("identity"),
    );
    response.headers_mut().insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    response
}

async fn serve_media(
    env: web::Data<Env>,
    identity: Option<&Identity>,
    request: &HttpRequest,
    target: Target,
) -> Result<HttpResponse, AppError> {
    let identity = identity.ok_or(AppError::Unauthenticated).c(h!())?;
    let login = access::resolve_current_login(&env.dbx, identity)
        .await
        .c(h!())?;
    if target.2 <= 0 {
        return Err(AppError::BL {
            msg: "Неправильна ревізія файлу".to_owned(),
        });
    }
    let source =
        load_published_content(&env, &login, target.0, target.1, target.2)
            .await
            .c(h!())?;
    Ok(
        serve_authorized_source(env, login.id, request, target, source)
            .await
            .c(h!())?,
    )
}

async fn serve_authorized_source(
    env: web::Data<Env>,
    actor: Uuid,
    request: &HttpRequest,
    target: Target,
    source: PublishedContent,
) -> Result<HttpResponse, AppError> {
    let Some(content_type) = media_content_type(&source) else {
        return Ok(HttpResponse::UnsupportedMediaType().json(serde_json::json!({"msg": "Формат файлу не підтримує медіаперегляд"})));
    };
    let size = u64::try_from(source.source_size_bytes).c(h!())?;
    let selection = requested_range(request, size);
    let offset = match &selection {
        Selection::Partial(range) => range.start,
        _ => 0,
    };
    let retained = super::local_cache::open(
        &env,
        &source.object_key,
        size,
        source.is_encrypted,
        offset,
    )
    .await;
    if retained.is_none() {
        validate_storage(&env, &source, size)
            .await
            .map_err(media_error)
            .c(h!())?;
    }
    if matches!(selection, Selection::Unsatisfiable) {
        authorize_published_snapshot(&env, actor, target, &source)
            .await
            .c(h!())?;
        return Ok(HttpResponse::RangeNotSatisfiable()
            .insert_header((header::CONTENT_RANGE, format!("bytes */{size}")))
            .body(web::Bytes::new()));
    }
    let (range, partial) = match selection {
        Selection::Full => (0..size, false),
        Selection::Partial(range) => (range, true),
        Selection::Unsatisfiable => unreachable!(),
    };
    let mut response =
        media_response(&source, &content_type, size, &range, partial);
    if request.method() == Method::HEAD {
        authorize_published_snapshot(&env, actor, target, &source)
            .await
            .c(h!())?;
        return Ok(response.body(actix_web::body::SizedStream::new(
            size,
            stream::empty::<Result<web::Bytes, actix_web::Error>>(),
        )));
    }
    let body = prepare_authorized_media(&env, actor, target, &source, async {
        if let Some(file) = retained {
            return Ok(super::local_cache::stream(
                file,
                range.end - range.start,
            )
            .map(|chunk| {
                chunk.map_err(actix_web::error::ErrorInternalServerError)
            })
            .boxed_local());
        }
        prepare_body(env.clone(), target, &source, range)
            .await
            .c(h!())
    })
    .await
    .c(h!())?;
    Ok(response.streaming(body))
}

async fn validate_storage(
    env: &Env,
    source: &PublishedContent,
    size: u64,
) -> anyhow::Result<()> {
    let storage = env.s3.as_ref().ok_or(CacheBusy).c(h!())?;
    let mut config = env.s3_config.clone().ok_or(CacheBusy).c(h!())?;
    config.prefix.clear();
    let metadata = storage
        .stat(&config.prefixed_key(&source.object_key))
        .await
        .map_err(|_| CacheBusy)
        .c(h!())?;
    if !source.is_encrypted {
        anyhow::ensure!(
            metadata.content_length() == size,
            "Device media source size mismatch"
        );
    }
    Ok(())
}

pub(super) async fn prepare_authorized_media<F>(
    env: &Env,
    actor: Uuid,
    target: Target,
    source: &PublishedContent,
    prepare: F,
) -> Result<BodyStream, AppError>
where
    F: Future<Output = anyhow::Result<BodyStream>>,
{
    Ok(
        prepare_authorized_content(env, actor, target, source, async {
            prepare.await.map_err(media_error)
        })
        .await
        .c(h!())?,
    )
}

pub(super) async fn prepare_body(
    env: web::Data<Env>,
    target: Target,
    source: &PublishedContent,
    range: Range<u64>,
) -> anyhow::Result<BodyStream> {
    if source.is_encrypted {
        return prepare_encrypted(env, target, source, range).await.c(h!());
    }
    if range.is_empty() {
        return Ok(stream::empty().boxed_local());
    }
    let mut config = env.s3_config.clone().ok_or(CacheBusy).c(h!())?;
    config.prefix.clear();
    let bytes = crate::storage::stream_s3_object_range_with_operator(
        &env.s3,
        &Some(config),
        &source.object_key,
        range,
    )
    .await
    .map_err(|_| CacheBusy)
    .c(h!())?;
    Ok(bytes
        .map(|chunk| chunk.map_err(actix_web::error::ErrorInternalServerError))
        .boxed_local())
}

async fn prepare_encrypted(
    env: web::Data<Env>,
    target: Target,
    source: &PublishedContent,
    range: Range<u64>,
) -> anyhow::Result<BodyStream> {
    let size = u64::try_from(source.source_size_bytes).c(h!())?;
    anyhow::ensure!(
        size <= DEVICE_FILE_PREVIEW_MEDIA_MAX_ENCRYPTED_PLAINTEXT_BYTES,
        "Encrypted device media source exceeds its size limit"
    );
    let key = CacheKey {
        device_id: target.0,
        file_id: target.1,
        revision: target.2,
        object_key: source.object_key.clone(),
        sha256: source
            .source_sha256
            .clone()
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid device media source hash"))
            .c(h!())?,
        size,
        version: DEVICE_FILE_PREVIEW_MEDIA_CACHE_VERSION,
    };
    let object_key = source.object_key.clone();
    let lease = preview_cache::cache()
        .map_err(|_| CacheBusy)
        .c(h!())?
        .read(key, async move {
            decrypt_source(&env, &object_key).await.c(h!())
        })
        .await
        .c(h!())?;
    let mut file = tokio::fs::File::open(lease.path())
        .await
        .map_err(|_| CacheBusy)
        .c(h!())?;
    file.seek(std::io::SeekFrom::Start(range.start))
        .await
        .map_err(|_| CacheBusy)
        .c(h!())?;
    let stream = ReaderStream::new(file.take(range.end - range.start));
    Ok(stream
        .map(move |chunk| {
            let _lease = &lease;
            chunk.map_err(actix_web::error::ErrorInternalServerError)
        })
        .boxed_local())
}

async fn decrypt_source(
    env: &Env,
    object_key: &str,
) -> anyhow::Result<Vec<u8>> {
    let mut config = env.s3_config.clone().ok_or(CacheBusy).c(h!())?;
    config.prefix.clear();
    let key = &env
        .config
        .s3_config
        .as_ref()
        .ok_or(CacheBusy)
        .c(h!())?
        .strongbox_key;
    crate::storage::key_from_b64(key)
        .map_err(|_| CacheBusy)
        .c(h!())?;
    let result = crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
        &env.s3, &Some(config), key, object_key, Duration::from_secs(DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS),
        DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
    ).await;
    match result {
        Ok(bytes) => Ok(bytes),
        Err(error @ AppError::BL { .. }) => Err(error).c(h!()),
        Err(_) => Err(CacheBusy).c(h!()),
    }
}

fn media_error(error: anyhow::Error) -> AppError {
    if error.downcast_ref::<CacheBusy>().is_some() {
        return AppError::ServiceUnavailable {
            msg: "Медіаперегляд тимчасово недоступний. Повторіть спробу."
                .to_owned(),
            retry_after_secs: DEVICE_FILE_PREVIEW_MEDIA_RETRY_AFTER_SECS,
        };
    }
    error.into()
}

fn media_response(
    source: &PublishedContent,
    content_type: &str,
    size: u64,
    range: &Range<u64>,
    partial: bool,
) -> HttpResponseBuilder {
    let mut disposition = crate::utils::multipart::download_content_disposition(
        source.name.clone(),
    );
    disposition.disposition = header::DispositionType::Inline;
    let mut response = HttpResponse::build(if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    });
    response
        .content_type(content_type)
        .insert_header(disposition)
        .insert_header((header::ACCEPT_RANGES, "bytes"))
        .insert_header((
            header::CONTENT_LENGTH,
            (range.end - range.start).to_string(),
        ));
    if partial {
        response.insert_header((
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{size}", range.start, range.end - 1),
        ));
    }
    response
}

enum Selection {
    Full,
    Partial(Range<u64>),
    Unsatisfiable,
}

fn requested_range(request: &HttpRequest, size: u64) -> Selection {
    if request.method() == Method::HEAD
        || request.headers().contains_key(header::IF_RANGE)
        || request.headers().get_all(header::RANGE).count() != 1
    {
        return Selection::Full;
    }
    let Some(value) = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        return Selection::Full;
    };
    let Some((unit, range)) = value.trim().split_once('=') else {
        return Selection::Full;
    };
    if !unit.eq_ignore_ascii_case("bytes") || range.contains(',') {
        return Selection::Full;
    }
    let Some((start, end)) = range.split_once('-') else {
        return Selection::Full;
    };
    if start.is_empty() {
        let Some(suffix) = range_number(end) else {
            return Selection::Full;
        };
        if suffix == 0 || size == 0 {
            return Selection::Unsatisfiable;
        }
        return Selection::Partial(size.saturating_sub(suffix)..size);
    }
    let start_digits = start.trim_start_matches('0');
    let Some(start) = range_number(start) else {
        return Selection::Full;
    };
    let end = if end.is_empty() {
        None
    } else {
        let end_digits = end.trim_start_matches('0');
        let Some(end) = range_number(end) else {
            return Selection::Full;
        };
        if (end_digits.len(), end_digits) < (start_digits.len(), start_digits) {
            return Selection::Full;
        }
        Some(end)
    };
    if start >= size {
        return Selection::Unsatisfiable;
    }
    Selection::Partial(
        start..end.map_or(size, |end| end.saturating_add(1).min(size)),
    )
}

fn range_number(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(value.bytes().fold(0u64, |number, digit| {
        number
            .saturating_mul(10)
            .saturating_add(u64::from(digit - b'0'))
    }))
}

fn media_content_type(source: &PublishedContent) -> Option<String> {
    let mime = source
        .mime_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mime = match mime.as_str() {
        "application/mp4" => "video/mp4",
        "application/x-matroska" => "video/x-matroska",
        "audio/x-wav" => "audio/wav",
        "audio/mp3" | "audio/mpga" => "audio/mpeg",
        "audio/x-m4a" => "audio/mp4",
        "audio/x-flac" => "audio/flac",
        _ => &mime,
    };
    if let Some((kind, subtype)) = mime.split_once('/') {
        if (kind == "audio" || kind == "video")
            && !subtype.is_empty()
            && subtype.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || b"!#$%&'+-.^_`|~".contains(&byte)
            })
        {
            return Some(mime.to_owned());
        }
        if kind == "image" {
            return None;
        }
    }
    let extension = source
        .name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| !extension.contains(['/', '\\']))
        .or(source.extension.as_deref())
        .unwrap_or("")
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    extension_mime(&extension).map(str::to_owned)
}

fn extension_mime(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "mp4" | "m4v" | "f4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mpeg" | "mpg" | "vob" => "video/mpeg",
        "wmv" => "video/x-ms-wmv",
        "asf" => "video/x-ms-asf",
        "flv" => "video/x-flv",
        "3gp" => "video/3gpp",
        "3g2" => "video/3gpp2",
        "m2ts" => "video/mp2t",
        "ogv" => "video/ogg",
        "mp3" | "mpga" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => return None,
    })
}
