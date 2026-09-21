mod cursor;
pub(in crate::devices::files) mod listing;
mod query;
pub(in crate::devices) mod read;
pub mod types;

use super::types::FileSyncSessionRsp;
use crate::devices::types::parse_uuid;
use crate::devices::{
    access,
    devices::query::{
        authorize_file_registry_access, FileRegistryDeviceAccess,
    },
};
use crate::file_registry::entities::file_sync_session;
use crate::{
    entities::login,
    error::AppError,
    file_registry::FileRegistryDb,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use types::*;
use uuid::Uuid;

pub(in crate::devices) async fn authorize(
    main_db: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
    sync_id: Uuid,
) -> Result<file_sync_session::Model, AppError> {
    authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    find_session(files, device_id, sync_id).await
}

async fn find_session(
    files: &FileRegistryDb,
    device_id: Uuid,
    sync_id: Uuid,
) -> Result<file_sync_session::Model, AppError> {
    file_sync_session::Entity::find_by_id(sync_id)
        .filter(file_sync_session::Column::DeviceId.eq(device_id))
        .one(files.connection())
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

#[post("/api/device/files/sessions/list")]
pub(crate) async fn list(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<ListDeviceSyncSessionsReq>,
) -> Result<Json<ListDeviceSyncSessionsRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(
        listing::list(&env.dbx, env.file_registry_db().c(h!())?, &login, body)
            .await
            .c(h!())?,
    ))
}

#[post("/api/device/files/sessions/get")]
pub(crate) async fn get(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<GetDeviceSyncSessionReq>,
) -> Result<Json<FileSyncSessionRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let files = env.file_registry_db().c(h!())?;
    let session = authorize(
        &env.dbx,
        files,
        &login,
        parse_uuid(&body.device_id),
        parse_uuid(&body.sync_id),
    )
    .await
    .c(h!())?;
    let sync = listing::map_sessions(files, vec![session])
        .await
        .c(h!())?
        .pop()
        .ok_or(AppError::NotFound)
        .c(h!())?;
    Ok(Json(FileSyncSessionRsp { sync }))
}

#[post("/api/device/files/sessions/summaries")]
pub(crate) async fn summaries(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceSyncSessionSummariesReq>,
) -> Result<Json<DeviceSyncSessionSummariesRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(
        listing::summaries(
            &env.dbx,
            env.file_registry_db().c(h!())?,
            &login,
            body,
        )
        .await
        .c(h!())?,
    ))
}
