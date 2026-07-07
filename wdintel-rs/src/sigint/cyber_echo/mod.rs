pub mod bl;
pub mod query;
pub mod tus;
pub mod types;

use crate::error::AppError;
use crate::types::*;
use actix_web::{post, route, web, HttpRequest, HttpResponse};
use types::{
    CreateCyberEchoSignalMessagePayload, CreateCyberEchoSignalMessageRsp,
};

const CYBER_ECHO_TUS_PATH_BASE: &str = "/api/sigint/cyber-echo/tus";

#[post("/api/sigint/cyber-echo/message/create")]
pub async fn cyber_echo_message_create(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<CreateCyberEchoSignalMessagePayload>,
) -> Result<web::Json<CreateCyberEchoSignalMessageRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    Ok(web::Json(
        bl::create_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())?,
    ))
}

#[route("/api/sigint/cyber-echo/tus", method = "POST", method = "OPTIONS")]
pub async fn cyber_echo_tus_base(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    handle_cyber_echo_tus(user, env, req, None, payload).await
}

#[route(
    "/api/sigint/cyber-echo/tus/{file_id}",
    method = "HEAD",
    method = "PATCH",
    method = "DELETE",
    method = "OPTIONS"
)]
pub async fn cyber_echo_tus_file(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    handle_cyber_echo_tus(user, env, req, Some(path.into_inner()), payload)
        .await
}

async fn handle_cyber_echo_tus(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    req: HttpRequest,
    request_file: Option<String>,
    payload: web::Payload,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    crate::system_settings::ensure_cyber_echo_enabled(&env.dbx)
        .await
        .c(h!())?;
    if env.config.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "s3 config is required for attachment upload".to_string(),
        });
    }

    let handler = tus::TusHandler::new(
        env.config.storage_dir.clone(),
        CYBER_ECHO_TUS_PATH_BASE,
    );
    handler
        .handle_request(
            &login,
            req.method(),
            req.headers(),
            request_file,
            payload,
        )
        .await
}
