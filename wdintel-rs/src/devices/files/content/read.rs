use std::future::Future;
use std::time::Duration;

use actix_identity::Identity;
use actix_web::http::{header, Method};
use actix_web::{web, HttpRequest, HttpResponse};
use uuid::Uuid;

use crate::devices::access;
use crate::devices::config::{
    DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
    DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS,
    DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
};
use crate::devices::devices::query::{
    authorize_file_registry_access, FileRegistryDeviceAccess,
};
use crate::entities::login;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};

use super::repository::{self, PublishedContent};

#[actix_web::route(
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/content",
    method = "GET",
    method = "HEAD"
)]
pub(super) async fn download_content(
    env: web::Data<Env>,
    identity: Identity,
    request: HttpRequest,
    path: web::Path<(Uuid, Uuid, i64)>,
) -> Result<HttpResponse, AppError> {
    let login = access::resolve_current_login(&env.dbx, &identity)
        .await
        .c(h!())?;
    let (device_id, file_id, revision) = path.into_inner();
    let content =
        load_published_content(&env, &login, device_id, file_id, revision)
            .await
            .c(h!())?;
    Ok(prepare_authorized_content(
        &env,
        login.id,
        (device_id, file_id, revision),
        &content,
        serve_content(&env, &request, &content),
    )
    .await
    .c(h!())?)
}

pub(in crate::devices) async fn prepare_authorized_content<F, T>(
    env: &Env,
    actor: Uuid,
    target: (Uuid, Uuid, i64),
    source: &PublishedContent,
    prepare: F,
) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    let prepared = prepare.await.c(h!())?;
    authorize_published_snapshot(env, actor, target, source)
        .await
        .c(h!())?;
    Ok(prepared)
}

pub(in crate::devices) async fn authorize_published_snapshot(
    env: &Env,
    actor: Uuid,
    target: (Uuid, Uuid, i64),
    source: &PublishedContent,
) -> Result<(), AppError> {
    let login = access::resolve_login_by_id(&env.dbx, &actor)
        .await
        .c(h!())?;
    let current =
        load_published_content(env, &login, target.0, target.1, target.2)
            .await
            .c(h!())?;
    if current.object_key != source.object_key
        || current.source_sha256 != source.source_sha256
        || current.source_size_bytes != source.source_size_bytes
        || current.is_encrypted != source.is_encrypted
    {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub(in crate::devices) async fn load_published_content(
    env: &Env,
    login: &login::Model,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<PublishedContent, AppError> {
    authorize_file_registry_access(
        &env.dbx,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    repository::find_published_content(
        env.file_registry_db().c(h!())?.connection(),
        device_id,
        file_id,
        revision,
    )
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)
}

pub(super) async fn serve_content(
    env: &Env,
    request: &HttpRequest,
    content: &PublishedContent,
) -> Result<HttpResponse, AppError> {
    let size = u64::try_from(content.source_size_bytes).c(h!())?;
    if let Some(file) = super::local_cache::open(
        env,
        &content.object_key,
        size,
        content.is_encrypted,
        0,
    )
    .await
    {
        let mut response = content_response(content, size);
        if request.method() == Method::HEAD {
            return Ok(head_response(response, size));
        }
        return Ok(response.streaming(super::local_cache::stream(file, size)));
    }
    let storage = env.s3.as_ref().ok_or_else(storage_unavailable).c(h!())?;
    let mut config = env
        .s3_config
        .clone()
        .ok_or_else(storage_unavailable)
        .c(h!())?;
    config.prefix.clear();
    let metadata = storage
        .stat(&config.prefixed_key(&content.object_key))
        .await
        .c(h!())?;
    if !content.is_encrypted && metadata.content_length() != size {
        return Err(anyhow::anyhow!("Device file content size mismatch").into());
    }
    let mut response = content_response(content, size);
    if request.method() == Method::HEAD {
        return Ok(head_response(response, size));
    }
    if content.is_encrypted {
        let bytes = decrypt_content(env, &config, &content.object_key)
            .await
            .c(h!())?;
        if bytes.len() as u64 != size {
            return Err(
                anyhow::anyhow!("Device file content size mismatch").into()
            );
        }
        return Ok(response.body(bytes));
    }
    let stream = crate::storage::stream_s3_object_range_with_operator(
        &env.s3,
        &Some(config),
        &content.object_key,
        0..size,
    )
    .await
    .c(h!())?;
    Ok(response.streaming(stream))
}

fn content_response(
    content: &PublishedContent,
    size: u64,
) -> actix_web::HttpResponseBuilder {
    let mut disposition = crate::utils::multipart::download_content_disposition(
        content.name.clone(),
    );
    disposition.disposition = header::DispositionType::Attachment;
    let mut response = HttpResponse::Ok();
    response
        .content_type("application/octet-stream")
        .insert_header(disposition)
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header((header::CONTENT_LENGTH, size.to_string()))
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"));
    response
}

fn head_response(
    mut response: actix_web::HttpResponseBuilder,
    size: u64,
) -> HttpResponse {
    response.body(actix_web::body::SizedStream::new(
        size,
        futures_util::stream::empty::<Result<web::Bytes, actix_web::Error>>(),
    ))
}

async fn decrypt_content(
    env: &Env,
    storage_config: &crate::storage::S3Config,
    object_key: &str,
) -> anyhow::Result<Vec<u8>> {
    let config = env
        .config
        .s3_config
        .as_ref()
        .ok_or_else(storage_unavailable)
        .c(h!())?;
    crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(
        &env.s3,
        &Some(storage_config.clone()),
        &config.strongbox_key,
        object_key,
        Duration::from_secs(DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS),
        DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
    )
    .await
    .c(h!())
}

fn storage_unavailable() -> AppError {
    AppError::ServiceUnavailable {
        msg: "Сховище контенту файлів недоступне".to_string(),
        retry_after_secs: DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
    }
}
