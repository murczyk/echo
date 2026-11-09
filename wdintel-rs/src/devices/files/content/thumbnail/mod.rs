mod cache;
mod source;

use actix_identity::Identity;
use actix_web::http::header;
use actix_web::{web, HttpResponse, ResponseError};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use super::read::{authorize_published_snapshot, load_published_content};
use super::repository::PublishedContent;
use crate::devices::access;
use crate::devices::config::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};

type Target = (Uuid, Uuid, i64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Failure {
    Terminal,
    Transient,
    Access,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Key {
    digest: [u8; 32],
    size: u64,
}

impl Key {
    fn new(target: Target, source: &PublishedContent, image: bool) -> Self {
        let mut hash = Sha256::new();
        hash.update(target.0.as_bytes());
        hash.update(target.1.as_bytes());
        hash.update(target.2.to_be_bytes());
        hash.update(DEVICE_FILE_THUMBNAIL_VERSION.to_be_bytes());
        hash.update((source.object_key.len() as u64).to_be_bytes());
        hash.update(source.object_key.as_bytes());
        hash.update(&source.source_sha256);
        hash.update(source.source_size_bytes.to_be_bytes());
        hash.update([u8::from(source.is_encrypted), u8::from(image)]);
        Self {
            digest: hash.finalize().into(),
            size: source.source_size_bytes as u64,
        }
    }
}

#[actix_web::get(
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/thumbnail"
)]
pub(super) async fn content(
    env: web::Data<Env>,
    identity: Option<Identity>,
    target: web::Path<Target>,
) -> HttpResponse {
    let mut response =
        match serve(env, identity.as_ref(), target.into_inner()).await {
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
    response
}

async fn serve(
    env: web::Data<Env>,
    identity: Option<&Identity>,
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
    let source = Arc::new(
        load_published_content(&env, &login, target.0, target.1, target.2)
            .await
            .c(h!())?,
    );
    let Some(image) = source::image_kind(&source) else {
        return Ok(HttpResponse::UnsupportedMediaType().finish());
    };
    if source.source_size_bytes <= 0
        || source.source_size_bytes as u64
            > DEVICE_FILE_THUMBNAIL_SOURCE_MAX_BYTES
    {
        return Ok(failure_response(Failure::Terminal));
    }
    let key = Key::new(target, &source, image);
    let cache = match cache::cache() {
        Ok(cache) => cache,
        Err(error) => {
            log::warn!("device thumbnail cache unavailable: {error:#}");
            return Ok(failure_response(Failure::Transient));
        }
    };
    let task_env = env.clone();
    let task_source = source.clone();
    let lookup =
        cache.request(key, env.metrics.clone(), move |path| async move {
            source::generate(
                &task_env,
                login.id,
                target,
                &task_source,
                image,
                &path,
            )
            .await
        });
    match lookup {
        cache::Lookup::Pending => Ok(HttpResponse::Accepted()
            .insert_header((
                header::RETRY_AFTER,
                DEVICE_FILE_THUMBNAIL_RETRY_AFTER_SECS.to_string(),
            ))
            .finish()),
        cache::Lookup::Failed(failure) => Ok(failure_response(failure)),
        cache::Lookup::Ready(entry) => {
            let bytes = match read_jpeg(entry.path()).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    cache.invalidate(&key, &entry);
                    return Ok(failure_response(Failure::Transient));
                }
            };
            authorize_published_snapshot(&env, login.id, target, &source)
                .await
                .c(h!())?;
            Ok(HttpResponse::Ok().content_type("image/jpeg").body(bytes))
        }
    }
}

async fn read_jpeg(path: &std::path::Path) -> anyhow::Result<Vec<u8>> {
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
        .c(h!())?;
    let mut bytes = Vec::new();
    file.take(DEVICE_FILE_THUMBNAIL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .c(h!())?;
    anyhow::ensure!(
        bytes.len() as u64 <= DEVICE_FILE_THUMBNAIL_MAX_BYTES
            && bytes.starts_with(&[0xff, 0xd8, 0xff])
            && bytes.ends_with(&[0xff, 0xd9]),
        "Invalid cached thumbnail"
    );
    Ok(bytes)
}

fn failure_response(failure: Failure) -> HttpResponse {
    if failure == Failure::Terminal {
        HttpResponse::UnprocessableEntity().finish()
    } else {
        HttpResponse::ServiceUnavailable()
            .insert_header((
                header::RETRY_AFTER,
                DEVICE_FILE_THUMBNAIL_RETRY_AFTER_SECS.to_string(),
            ))
            .finish()
    }
}

#[cfg(test)]
mod tests;
