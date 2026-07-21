use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
pub mod tus;

use crate::error::AppError;
use crate::types::*;
use actix_web::{route, web, HttpRequest, HttpResponse};

pub const TUS_PATH_BASE: &str = "/api/sigint/file-upload/tus";

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

async fn handle_tus(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    request_file: Option<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    let login = login_id_from_identity(&user)?;
    ensure_request_allowed(&user, &env).await.c(h!())?;

    tus::TusHandler::new(env.config.storage_dir.clone(), TUS_PATH_BASE)
        .handle_request(
            &login,
            req.method(),
            req.headers(),
            request_file,
            payload,
        )
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
