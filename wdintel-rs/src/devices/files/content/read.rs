use std::time::Duration;

use actix_identity::Identity;
use actix_web::http::{header, Method};
use actix_web::{web, HttpRequest, HttpResponse};
use sea_orm::{DatabaseBackend, FromQueryResult, Statement};
use uuid::Uuid;

use crate::config::{
    DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
    DEVICE_FILE_CONTENT_DOWNLOAD_TIMEOUT_SECS,
    DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
};
use crate::devices::access;
use crate::devices::devices::query::{
    authorize_file_registry_access, FileRegistryDeviceAccess,
};
use crate::entities::login;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};

#[derive(FromQueryResult)]
struct PublishedContent {
    name: String,
    object_key: String,
    source_size_bytes: i64,
    is_encrypted: bool,
}

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
    Ok(serve_content(&env, &request, content).await.c(h!())?)
}

async fn load_published_content(
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
    PublishedContent::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select entry.name, content.object_key, content.source_size_bytes, content.is_encrypted
         from file_revision entry
         join file_content content on content.file_id = entry.id
             and content.revision = entry.revision
         where entry.device_id = $1 and entry.id = $2
             and entry.revision = $3",
        [device_id.into(), file_id.into(), revision.into()],
    ))
    .one(env.file_registry_db().c(h!())?.connection())
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)
}

async fn serve_content(
    env: &Env,
    request: &HttpRequest,
    content: PublishedContent,
) -> Result<HttpResponse, AppError> {
    let size = u64::try_from(content.source_size_bytes).c(h!())?;
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
    let mut disposition =
        crate::utils::multipart::download_content_disposition(content.name);
    disposition.disposition = header::DispositionType::Attachment;
    let mut response = HttpResponse::Ok();
    response
        .content_type("application/octet-stream")
        .insert_header(disposition)
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header((header::CONTENT_LENGTH, size.to_string()))
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"));
    if request.method() == Method::HEAD {
        return Ok(response.body(actix_web::body::SizedStream::new(
            size,
            futures_util::stream::empty::<Result<web::Bytes, actix_web::Error>>(
            ),
        )));
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
