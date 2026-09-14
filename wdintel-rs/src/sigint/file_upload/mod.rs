use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
pub mod fallback;
mod lifecycle;
pub mod tus;

#[cfg(test)]
mod acceptance_tests;

use crate::error::AppError;
use crate::types::*;
use actix_multipart::Multipart;
use actix_web::http::header::HeaderMap;
use actix_web::http::Method;
use actix_web::{post, route, web, HttpRequest, HttpResponse};

pub const TUS_PATH_BASE: &str = "/api/sigint/file-upload/tus";
pub const FALLBACK_PATH: &str = "/api/sigint/file-upload/fallback";
#[route("/api/sigint/file-upload/tus", method = "POST", method = "OPTIONS")]
pub async fn tus_base(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    handle_tus(user, env, req, None, payload).await
}

#[route(
    "/api/sigint/file-upload/tus/{file_id}",
    method = "HEAD",
    method = "PATCH",
    method = "POST",
    method = "DELETE",
    method = "OPTIONS"
)]
pub async fn tus_file(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    handle_tus(user, env, req, Some(path.into_inner()), payload).await
}

#[post("/api/sigint/file-upload/fallback")]
pub async fn fallback_upload(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let login = login_id_from_identity(&user).context(h!())?;
    ensure_request_allowed(&user, &env).await.c(h!())?;

    fallback::upload(
        tus::TusHandler::new(env.config.storage_dir.clone(), TUS_PATH_BASE),
        &login,
        req.headers(),
        payload,
    )
    .await
}

async fn handle_tus(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    request_file: Option<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_request_allowed(&user, &env).await.c(h!())?;
    let method = effective_tus_method(
        req.method(),
        req.headers(),
        request_file.is_some(),
    );

    tus::TusHandler::new(env.config.storage_dir.clone(), TUS_PATH_BASE)
        .handle_request(&login, &method, req.headers(), request_file, payload)
        .await
}

async fn ensure_request_allowed(
    user: &actix_identity::Identity,
    env: &Env,
) -> Result<(), AppError> {
    ensure_rer_role(&env.dbx, user).await.c(h!())?;
    if env.config.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }

    Ok(())
}

fn effective_tus_method(
    method: &Method,
    headers: &HeaderMap,
    has_request_file: bool,
) -> Method {
    if !has_request_file {
        return method.clone();
    }
    crate::tus::effective_resource_method(method, headers, &[Method::PATCH])
}

pub async fn run_cleanup_nofail(
    storage_dir: String,
    cancellation: tokio_util::sync::CancellationToken,
) {
    let handler = tus::TusHandler::new(storage_dir, TUS_PATH_BASE);
    loop {
        if let Err(error) = handler.cleanup_expired().await {
            log::error!("failed to clean legacy attachment uploads: {error:?}");
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(crate::config::SIGINT_FILE_UPLOAD_CLEANUP_INTERVAL_SECS)) => {}
        }
    }
}

pub(crate) async fn remove_consumed_upload(
    path: &std::path::Path,
) -> anyhow::Result<bool> {
    lifecycle::remove_consumed(path).await.c(h!())
}

pub(crate) async fn lock_uploaded_source(
    path: &std::path::Path,
) -> anyhow::Result<Option<lifecycle::UploadLock>> {
    lifecycle::lock_source(path).await.c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::{HeaderName, HeaderValue};

    const HEADER_NAME_HTTP_METHOD_OVERRIDE: HeaderName =
        HeaderName::from_static("x-http-method-override");

    #[test]
    fn post_with_patch_override_uses_patch_for_file_upload() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HEADER_NAME_HTTP_METHOD_OVERRIDE.clone(),
            HeaderValue::from_static("PATCH"),
        );

        assert_eq!(
            effective_tus_method(&Method::POST, &headers, true),
            Method::PATCH
        );
    }

    #[test]
    fn post_without_patch_override_stays_post() {
        assert_eq!(
            effective_tus_method(&Method::POST, &HeaderMap::new(), true),
            Method::POST
        );
    }

    #[test]
    fn patch_override_does_not_change_base_creation_request() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HEADER_NAME_HTTP_METHOD_OVERRIDE.clone(),
            HeaderValue::from_static("PATCH"),
        );

        assert_eq!(
            effective_tus_method(&Method::POST, &headers, false),
            Method::POST
        );
    }

    #[test]
    fn delete_override_stays_post_for_sigint_upload() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HEADER_NAME_HTTP_METHOD_OVERRIDE.clone(),
            HeaderValue::from_static("DELETE"),
        );

        assert_eq!(
            effective_tus_method(&Method::POST, &headers, true),
            Method::POST,
        );
    }
}
