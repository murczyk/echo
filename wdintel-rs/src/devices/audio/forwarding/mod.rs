mod catalog;
mod settings;
pub mod types;
mod worker;

pub(in crate::devices) use settings::{apply, configured};
pub(super) use settings::{snapshot, Snapshot};
pub(super) use worker::publish;
pub(crate) use worker::run;

#[actix_web::post("/api/device/audio/forwarding/list")]
pub(crate) async fn list(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    body: actix_web::web::Json<types::ListDeviceAudioForwardingReq>,
) -> Result<
    actix_web::web::Json<types::ListDeviceAudioForwardingRsp>,
    crate::error::AppError,
> {
    use crate::{h, types::ShortContext};
    let actor = crate::devices::access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(actix_web::web::Json(
        catalog::list(&env.dbx, &actor, &body).await.c(h!())?,
    ))
}

#[actix_web::post("/api/device/audio/forwarding/remove")]
pub(crate) async fn remove(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    body: actix_web::web::Json<types::RemoveDeviceAudioForwardingReq>,
) -> Result<actix_web::HttpResponse, crate::error::AppError> {
    use crate::{h, types::ShortContext};
    let actor = crate::devices::access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    catalog::remove(&env.dbx, &actor, &body).await.c(h!())?;
    Ok(actix_web::HttpResponse::NoContent().finish())
}

#[actix_web::post("/api/device/audio/forwarding")]
pub(crate) async fn get(
    env: actix_web::web::Data<crate::types::Env>,
    user: actix_identity::Identity,
    body: actix_web::web::Json<super::types::DeviceAudioAsrSettingsReq>,
) -> Result<
    actix_web::web::Json<types::DeviceAudioForwardingSettings>,
    crate::error::AppError,
> {
    use crate::{h, types::ShortContext};
    let actor = crate::devices::access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    crate::devices::access::require_audio_edit(&actor.roles).c(h!())?;
    let device_id = crate::devices::types::parse_uuid(&body.device_id);
    super::query::find_visible_device(&env.dbx, &actor, device_id)
        .await
        .c(h!())?;
    Ok(actix_web::web::Json(
        settings::read(&env.dbx, &actor, device_id).await.c(h!())?,
    ))
}

#[cfg(test)]
mod tests;
