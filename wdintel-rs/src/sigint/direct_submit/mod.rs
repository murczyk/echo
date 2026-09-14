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

fn resolve_copy_message_device_access(
    result: Result<(), AppError>,
) -> Result<bool, AppError> {
    match result {
        Ok(()) => Ok(true),
        Err(AppError::Forbidden(_)) => Ok(false),
        Err(error) => Err(error.c(h!())),
    }
}

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
    let can_use_message_devices = resolve_copy_message_device_access(
        crate::devices::access::require_message_devices(&env.dbx, &login).await,
    )
    .c(h!())
    .map_err(|err| DirectSubmitApiError::new(err, action))?;
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

#[cfg(test)]
mod tests {
    use super::resolve_copy_message_device_access;
    use crate::error::AppError;

    #[test]
    fn copy_message_device_access_classifier_preserves_authorization_outcomes()
    {
        assert_eq!(resolve_copy_message_device_access(Ok(())).unwrap(), true);
        assert_eq!(
            resolve_copy_message_device_access(Err(AppError::Forbidden(
                "device operation is forbidden".to_string(),
            )))
            .unwrap(),
            false,
        );
    }

    #[test]
    fn copy_message_device_access_classifier_contextualizes_infrastructure_failures(
    ) {
        let error = resolve_copy_message_device_access(Err(AppError::IO {
            source: std::io::Error::other("device access database failure"),
        }))
        .unwrap_err();
        let AppError::AnyhowError { source } = error else {
            panic!("expected contextualized infrastructure error");
        };

        assert!(source.chain().count() > 1);
        assert!(source.chain().any(|cause| cause
            .to_string()
            .contains("device access database failure")));
    }
}
