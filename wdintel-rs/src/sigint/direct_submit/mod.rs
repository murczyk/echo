pub mod bl;
pub mod query;
pub mod types;

use crate::error::AppError;
use crate::types::*;
use actix_web::{post, web};
use types::{
    DirectSubmitParsePayload, DirectSubmitParseRsp, DirectSubmitPayload,
    DirectSubmitRsp,
};

#[post("/api/1.1/submit-direct")]
pub async fn submit_direct(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitPayload>,
) -> Result<web::Json<DirectSubmitRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    Ok(web::Json(
        bl::submit_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())?,
    ))
}

#[post("/api/1.1/submit-direct/parse")]
pub async fn parse_direct_submit(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitParsePayload>,
) -> Result<web::Json<DirectSubmitParseRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    Ok(web::Json(
        bl::parse_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())?,
    ))
}
