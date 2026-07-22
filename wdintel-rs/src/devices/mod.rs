use crate::devices::types::*;
use crate::types::{AppError, Env};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};

pub mod types;

mod access;
mod bl;
mod custom_fields;
mod filesystem;
mod main_db;
mod query;
#[cfg(test)]
mod schema_tests;
#[allow(dead_code)]
mod service;
mod validation;
mod visibility;

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

#[post("/api/device/unit-stats")]
pub async fn device_unit_stats(
    user: Identity,
    env: Data<Env>,
) -> Result<Json<DeviceUnitStatsRsp>, AppError> {
    access::ensure_device_reader(&env.dbx, &user).await?;
    Ok(Json(query::list_device_unit_stats(&env.dbx).await?))
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

#[post("/api/device/archive")]
pub async fn device_archive(
    user: Identity,
    env: Data<Env>,
    req: Json<ArchiveDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    access::ensure_device_editor(&env.dbx, &user).await?;
    Ok(Json(bl::archive_device(&env.dbx, req.into_inner()).await?))
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
    Ok(Json(
        query::list_device_files(&env.dbx, &env.file_registry_db, &req).await?,
    ))
}
