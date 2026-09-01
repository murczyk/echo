use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
pub mod fallback;
pub mod tus;

use crate::error::AppError;
use crate::types::*;
use actix_multipart::Multipart;
use actix_web::http::header::{HeaderMap, HeaderName};
use actix_web::http::Method;
use actix_web::{post, route, web, HttpRequest, HttpResponse};

pub const TUS_PATH_BASE: &str = "/api/sigint/file-upload/tus";
const HEADER_NAME_HTTP_METHOD_OVERRIDE: HeaderName =
    HeaderName::from_static("x-http-method-override");

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
    let is_patch_override = headers
        .get(&HEADER_NAME_HTTP_METHOD_OVERRIDE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("PATCH"));
    if has_request_file && method == Method::POST && is_patch_override {
        Method::PATCH
    } else {
        method.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::HeaderValue;

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
}
