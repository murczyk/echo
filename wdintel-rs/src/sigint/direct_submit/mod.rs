mod api_error;
pub mod bl;
pub mod query;
pub mod types;

use crate::types::*;
use actix_web::{post, web};
use api_error::{DirectSubmitAction, DirectSubmitApiError};
use types::{
    DirectSubmitParsePayload, DirectSubmitParseRsp, DirectSubmitPayload,
    DirectSubmitRsp,
};

#[post("/api/1.1/submit-direct")]
pub async fn submit_direct(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitPayload>,
) -> Result<web::Json<DirectSubmitRsp>, DirectSubmitApiError> {
    let action = DirectSubmitAction::Save;
    let login = user
        .id()
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    Ok(web::Json(
        bl::submit_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())
            .map_err(|err| DirectSubmitApiError::new(err, action))?,
    ))
}

#[post("/api/1.1/message/{id}/edit")]
pub async fn edit_message(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    path: web::Path<i64>,
    payload: web::Json<DirectSubmitPayload>,
) -> Result<web::Json<DirectSubmitRsp>, DirectSubmitApiError> {
    let action = DirectSubmitAction::Edit;
    let login = user
        .id()
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    Ok(web::Json(
        bl::edit_signal_message(
            &login,
            &env,
            path.into_inner(),
            payload.into_inner(),
        )
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?,
    ))
}

#[post("/api/1.1/submit-direct/parse")]
pub async fn parse_direct_submit(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitParsePayload>,
) -> Result<web::Json<DirectSubmitParseRsp>, DirectSubmitApiError> {
    let action = DirectSubmitAction::Parse;
    let login = user
        .id()
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    Ok(web::Json(
        bl::parse_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())
            .map_err(|err| DirectSubmitApiError::new(err, action))?,
    ))
}
