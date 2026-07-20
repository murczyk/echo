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
    let login = crate::users::identity_id(&user)?;
    ensure_request_allowed(&login, &env).await.c(h!())?;

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
    login: &uuid::Uuid,
    env: &Env,
) -> Result<(), AppError> {
    crate::users::has_role(&env.dbx, login, "Rer")
        .await
        .c(h!())?;
    if env.config.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }

    Ok(())
}
