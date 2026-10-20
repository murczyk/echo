use super::{
    enqueue,
    query::{self, Rejection},
    types::*,
};
use crate::{
    devices::{
        access,
        devices::query::{
            authorize_file_registry_access, FileRegistryDeviceAccess,
        },
    },
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    http::{header, StatusCode},
    web, HttpResponse, ResponseError,
};
use anyhow::{Context, Result};
use uuid::Uuid;

type Target = (Uuid, Uuid, i64);

#[actix_web::get(
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/archive"
)]
pub(super) async fn get_status(
    env: web::Data<Env>,
    identity: Option<Identity>,
    path: web::Path<Target>,
) -> HttpResponse {
    render(read(&env, identity.as_ref(), path.into_inner()).await)
}

#[actix_web::post(
    "/api/device/files/{device_id}/{file_id}/revisions/{revision}/archive"
)]
pub(super) async fn post_ensure(
    env: web::Data<Env>,
    identity: Option<Identity>,
    path: web::Path<Target>,
    body: web::Bytes,
) -> HttpResponse {
    render(prepare(&env, identity.as_ref(), path.into_inner(), &body).await)
}

fn target((device_id, file_id, revision): Target) -> DeviceFileContentRef {
    DeviceFileContentRef {
        device_id,
        file_id,
        revision,
    }
}

async fn authorize(
    env: &Env,
    identity: Option<&Identity>,
    device: Uuid,
) -> Result<()> {
    let login = access::resolve_current_login(
        &env.dbx,
        identity.ok_or(AppError::Unauthenticated).context(h!())?,
    )
    .await
    .c(h!())?;
    authorize_file_registry_access(
        &env.dbx,
        &login,
        device,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn read(
    env: &Env,
    identity: Option<&Identity>,
    identity_path: Target,
) -> Result<HttpResponse> {
    authorize(env, identity, identity_path.0)
        .await
        .context(h!())?;
    let status = query::status(
        env.file_registry_db().c(h!())?.connection(),
        target(identity_path),
    )
    .await
    .context(h!())?;
    authorize(env, identity, identity_path.0)
        .await
        .context(h!())?;
    Ok(HttpResponse::Ok().json(status))
}

async fn prepare(
    env: &Env,
    identity: Option<&Identity>,
    identity_path: Target,
    body: &[u8],
) -> Result<HttpResponse> {
    authorize(env, identity, identity_path.0)
        .await
        .context(h!())?;
    if !body.is_empty() {
        return Err(Rejection("invalid_request").into());
    }
    let target = target(identity_path);
    let db = env.file_registry_db().c(h!())?.connection();
    let mut status = query::status(db, target.clone()).await.context(h!())?;
    match status.archive.state {
        DeviceArchiveState::ArchiveMissingContent => {
            return Err(Rejection("content_missing").into());
        }
        DeviceArchiveState::ArchiveNotPrepared => {
            if !super::worker::configured(env) {
                return Err(Rejection("archive_unavailable").into());
            }
            enqueue::ensure(
                db,
                target.device_id,
                target.file_id,
                target.revision,
            )
            .await
            .context(h!())?
            .ok_or(Rejection("content_missing"))
            .context(h!())?;
            status = query::status(db, target).await.context(h!())?;
        }
        _ => {}
    }
    authorize(env, identity, identity_path.0)
        .await
        .context(h!())?;
    let terminal = matches!(
        status.archive.state,
        DeviceArchiveState::ArchiveReady | DeviceArchiveState::ArchiveFailed
    );
    Ok(HttpResponse::build(if terminal {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    })
    .json(status))
}

fn render(result: Result<HttpResponse>) -> HttpResponse {
    let mut response = match result {
        Ok(response) => response,
        Err(error) => match error.downcast_ref::<AppError>() {
            Some(
                error @ (AppError::Unauthenticated
                | AppError::Forbidden(_)
                | AppError::ForbiddenWithHeader { .. }
                | AppError::NotFound),
            ) => error.error_response(),
            _ => rejection(error),
        },
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

fn rejection(error: anyhow::Error) -> HttpResponse {
    let code = match error.downcast_ref::<Rejection>() {
        Some(rejection) => rejection.0,
        None => {
            crate::types::warn!("Archive request unavailable: {error:#}");
            "archive_unavailable"
        }
    };
    let (status, message) = match code {
        "invalid_request" => (StatusCode::BAD_REQUEST, "Некоректний запит"),
        "not_found" => (StatusCode::NOT_FOUND, "Файл не знайдено"),
        "unsupported_format" => (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Формат архіву не підтримується",
        ),
        "content_missing" => (StatusCode::CONFLICT, "Контент файлу відсутній"),
        "archive_not_ready" => {
            (StatusCode::CONFLICT, "Архів ще не підготовлено")
        }
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Підготовка архівів тимчасово недоступна",
        ),
    };
    let mut response = HttpResponse::build(status);
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response.insert_header((header::RETRY_AFTER, "2"));
    }
    response.json(serde_json::json!({ "code": code, "message": message }))
}
