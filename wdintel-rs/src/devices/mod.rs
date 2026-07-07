use crate::devices::types::*;
use crate::types::{AppError, Env};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};

pub mod types;

mod access;
mod bl;
mod files;
mod query;
mod validation;

#[post("/api/device/list")]
pub async fn device_list(
    user: Identity,
    env: Data<Env>,
    req: Json<ListDevicesReq>,
) -> Result<Json<ListDevicesRsp>, AppError> {
    access::ensure_device_reader(&env.dbx, &user).await?;
    let req = req.into_inner();
    Ok(Json(query::list_devices(&env.dbx, &req).await?))
}

#[post("/api/device/detail")]
pub async fn device_detail(
    user: Identity,
    env: Data<Env>,
    req: Json<DeviceDetailReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    access::ensure_device_reader(&env.dbx, &user).await?;
    let req = req.into_inner();
    Ok(Json(query::get_device_details(&env.dbx, &req).await?))
}

#[post("/api/device/create")]
pub async fn device_create(
    user: Identity,
    env: Data<Env>,
    req: Json<CreateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let login = access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(
        bl::create_device(&env.dbx, &login, req.into_inner()).await?,
    ))
}

#[post("/api/device/update")]
pub async fn device_update(
    user: Identity,
    env: Data<Env>,
    req: Json<UpdateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(bl::update_device(&env.dbx, req.into_inner()).await?))
}

#[post("/api/device/delete")]
pub async fn device_delete(
    user: Identity,
    env: Data<Env>,
    req: Json<DeleteDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(bl::delete_device(&env.dbx, req.into_inner()).await?))
}

#[post("/api/device/restore")]
pub async fn device_restore(
    user: Identity,
    env: Data<Env>,
    req: Json<RestoreDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(bl::restore_device(&env.dbx, req.into_inner()).await?))
}

#[post("/api/device/files/list")]
pub async fn device_files_list(
    user: Identity,
    env: Data<Env>,
    req: Json<ListDeviceFilesReq>,
) -> Result<Json<ListDeviceFilesRsp>, AppError> {
    access::ensure_device_reader(&env.dbx, &user).await?;
    let req = req.into_inner();
    Ok(Json(query::list_device_files(&env.dbx, &req).await?))
}

#[post("/api/device/files/create")]
pub async fn device_files_create(
    user: Identity,
    env: Data<Env>,
    req: Json<CreateDeviceFilesReq>,
) -> Result<Json<CreateDeviceFilesRsp>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(
        files::create_device_files(&env.dbx, req.into_inner()).await?,
    ))
}

#[post("/api/device/files/delete")]
pub async fn device_files_delete(
    user: Identity,
    env: Data<Env>,
    req: Json<DeleteDeviceFileReq>,
) -> Result<Json<DeviceFileEntry>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(
        files::delete_device_file(&env.dbx, req.into_inner()).await?,
    ))
}

#[post("/api/device/files/restore")]
pub async fn device_files_restore(
    user: Identity,
    env: Data<Env>,
    req: Json<RestoreDeviceFileReq>,
) -> Result<Json<DeviceFileEntry>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(
        files::restore_device_file(&env.dbx, req.into_inner()).await?,
    ))
}
