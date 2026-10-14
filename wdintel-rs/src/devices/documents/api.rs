use super::{access, types::*};
use crate::{
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use uuid::Uuid;

pub(in crate::devices) async fn authorize(
    env: &Env,
    user: &Identity,
    device: &str,
) -> Result<(), AppError> {
    let login = access::reader(
        env,
        crate::users::login_id_from_identity(user).c(h!())?,
    )
    .await
    .c(h!())?;
    Ok(
        access::authorize(env, &login, Uuid::parse_str(device).c(h!())?)
            .await
            .c(h!())?,
    )
}

#[post("/api/device/files/ai/search")]
pub(crate) async fn search(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentSearchReq>,
) -> Result<Json<DeviceDocumentSearchRsp>, AppError> {
    let login = access::reader(
        &env,
        crate::users::login_id_from_identity(&user).c(h!())?,
    )
    .await
    .c(h!())?;
    let ids = access::visible_ids(
        &env,
        &login,
        req.include_archived.unwrap_or(false),
    )
    .await
    .c(h!())?;
    Ok(Json(super::search::search(&env, &req, ids).await.c(h!())?))
}

#[post("/api/device/files/ai/get")]
pub(crate) async fn get(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentReadReq>,
) -> Result<Json<DeviceDocumentReadRsp>, AppError> {
    authorize(&env, &user, &req.device_id).await.c(h!())?;
    let mut req = req.into_inner();
    req.limit = Some(0);
    Ok(Json(super::read::read(&env, &req).await.c(h!())?))
}

#[post("/api/device/files/ai/read")]
pub(crate) async fn read(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentReadReq>,
) -> Result<Json<DeviceDocumentReadRsp>, AppError> {
    authorize(&env, &user, &req.device_id).await.c(h!())?;
    Ok(Json(super::read::read(&env, &req).await.c(h!())?))
}

pub(crate) use super::inspection::{inspect, status};

#[post("/api/admin/device-documents/retry")]
pub(crate) async fn retry(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentReadReq>,
) -> Result<Json<DeviceDocumentReadRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    authorize(&env, &user, &req.device_id).await.c(h!())?;
    let _ = super::read::read(&env, &req).await.c(h!())?;
    use crate::attachments::store::execute;
    use sea_orm::TransactionTrait;
    let db = env.file_registry_db().c(h!())?.connection();
    let tx = db.begin().await.c(h!())?;
    let file = Uuid::parse_str(&req.file_id).c(h!())?;
    let generation = Uuid::now_v7();
    let changed=execute(&tx,"update file_document set generation=$3,state='queued',last_error=null where file_id=$1 and revision=$2",vec![file.into(),req.revision.into(),generation.into()]).await.c(h!())?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    execute(&tx,"update file_document_job set state='superseded',lease=null,lease_until=null where file_id=$1 and revision=$2 and kind<>'inspect' and state<>'completed'",vec![file.into(),req.revision.into()]).await.c(h!())?;
    super::queue::enqueue(&tx, file, req.revision, generation, "extract")
        .await
        .c(h!())?;
    execute(&tx,"update file_document_job set payload=jsonb_build_object('force',true) where file_id=$1 and revision=$2 and generation=$3 and kind='extract'",vec![file.into(),req.revision.into(),generation.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(Json(super::read::read(&env, &req).await.c(h!())?))
}
