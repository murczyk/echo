use self::types::{
    CreateDeviceNameReq, CreateDeviceNameRsp, DeviceNameSearchReq,
    DeviceNameSearchRsp,
};
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;

pub mod bl;
pub mod query;
pub mod types;

#[post("/api/sigint/device-name/create")]
pub async fn device_name_create(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateDeviceNameReq>,
) -> Result<Json<CreateDeviceNameRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Rer"])
        .await
        .c(h!())?;

    let rsp = bl::create_device_name(&env.dbx, login, req.into_inner())
        .await
        .c(h!())?;

    Ok(Json(rsp))
}

#[post("/api/sigint/device-name/search")]
pub async fn device_name_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeviceNameSearchReq>,
) -> Result<Json<DeviceNameSearchRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Rer"])
        .await
        .c(h!())?;

    let rsp = bl::search_device_names(&env.dbx, req.into_inner())
        .await
        .c(h!())?;

    Ok(Json(rsp))
}
