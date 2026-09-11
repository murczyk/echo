use crate::users::ensure_rer_role;
use crate::users::login_id_from_identity;
mod api_error;
pub mod bl;
pub mod query;
pub mod types;

use crate::types::*;
use actix_web::{post, web};
use api_error::{DirectSubmitAction, DirectSubmitApiError};
use types::{
    DirectSubmitCopyReq, DirectSubmitCopyRsp, DirectSubmitParsePayload,
    DirectSubmitParseRsp, DirectSubmitPayload, DirectSubmitRsp,
};

#[post("/api/1.1/messages/copy")]
pub async fn copy_message(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitCopyReq>,
) -> Result<web::Json<DirectSubmitCopyRsp>, DirectSubmitApiError> {
    let action = DirectSubmitAction::Copy;
    ensure_rer_role(&env.dbx, &user)
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    let login = login_id_from_identity(&user)
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    let can_use_message_devices =
        crate::devices::access::require_message_devices(&env.dbx, &login)
            .await
            .c(h!())
            .is_ok();
    let mut response = bl::copy_signal_messages(
        &login,
        &env,
        payload.into_inner().message_ids,
    )
    .await
    .c(h!())
    .map_err(|err| DirectSubmitApiError::new(err, action))?;
    if !can_use_message_devices {
        for payload in &mut response.payloads {
            payload.device_name_id = Some(None);
        }
    }
    Ok(web::Json(response))
}

#[post("/api/1.1/submit-direct")]
pub async fn submit_direct(
    user: actix_identity::Identity,
    env: web::Data<Env>,
    payload: web::Json<DirectSubmitPayload>,
) -> Result<web::Json<DirectSubmitRsp>, DirectSubmitApiError> {
    let action = DirectSubmitAction::Save;
    ensure_rer_role(&env.dbx, &user)
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    let login = login_id_from_identity(&user)
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    if payload.device_name_id.is_some() {
        crate::devices::access::require_message_devices(&env.dbx, &login)
            .await
            .c(h!())
            .map_err(|err| DirectSubmitApiError::new(err, action))?;
    }
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
    ensure_rer_role(&env.dbx, &user)
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    let login = login_id_from_identity(&user)
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    if payload.device_name_id.is_some() {
        crate::devices::access::require_message_devices(&env.dbx, &login)
            .await
            .c(h!())
            .map_err(|err| DirectSubmitApiError::new(err, action))?;
    }
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
    ensure_rer_role(&env.dbx, &user)
        .await
        .c(h!())
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    let login = login_id_from_identity(&user)
        .map_err(|err| DirectSubmitApiError::new(err, action))?;
    Ok(web::Json(
        bl::parse_signal_message(&login, &env, payload.into_inner())
            .await
            .c(h!())
            .map_err(|err| DirectSubmitApiError::new(err, action))?,
    ))
}
