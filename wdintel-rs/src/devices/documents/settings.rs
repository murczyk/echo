use super::types::*;
use crate::{
    attachments::store::{execute, rows},
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::FromQueryResult;
use uuid::Uuid;

pub(crate) async fn load(env: &Env) -> anyhow::Result<DeviceDocumentSettings> {
    rows(&env.dbx,"select enabled,summaries_enabled,positions_enabled,ai_engine_id::text,position_engine_id::text from device_document_settings where id=1",vec![]).await.c(h!())?.pop().c(h!())
}

#[post("/api/admin/device-documents/settings")]
pub(crate) async fn save(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentSettings>,
) -> Result<Json<DeviceDocumentSettings>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let engine = req
        .ai_engine_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    let position = req
        .position_engine_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .c(h!())?;
    for id in [engine, position].into_iter().flatten() {
        #[derive(FromQueryResult)]
        struct Enabled {
            enabled: bool,
        }
        let valid=rows::<Enabled,_>(&env.dbx,"select enabled and callsign_enabled as enabled from ai_engine where id=$1",vec![id.into()]).await.c(h!())?.pop().is_some_and(|e|e.enabled);
        if !valid {
            return Err(AppError::BL {
                msg: "Вибраний ШІ рушій недоступний для тексту".into(),
            });
        }
    }
    if req.enabled
        && (req.summaries_enabled && engine.is_none()
            || req.positions_enabled && position.is_none())
    {
        return Err(AppError::BL {
            msg: "Оберіть рушії для увімкнених етапів".into(),
        });
    }
    execute(&env.dbx,"update device_document_settings set enabled=$1,summaries_enabled=$2,positions_enabled=$3,ai_engine_id=$4,position_engine_id=$5 where id=1",
        vec![req.enabled.into(),req.summaries_enabled.into(),req.positions_enabled.into(),engine.into(),position.into()]).await.c(h!())?;
    Ok(Json(load(&env).await.c(h!())?))
}

#[post("/api/admin/device-documents/page")]
pub(crate) async fn page(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentSearchReq>,
) -> Result<Json<DeviceDocumentAdminRsp>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let settings = load(&env).await.c(h!())?;
    let engines=rows(&env.dbx,"select id::text,name,model_name from ai_engine where enabled and callsign_enabled order by name",vec![]).await.c(h!())?;
    let mut response = DeviceDocumentAdminRsp {
        available: false,
        settings,
        engines,
        backfill_complete: false,
        discovered: 0,
        counts: vec![],
        documents: vec![],
    };
    let Ok(registry) = env.file_registry_db() else {
        return Ok(Json(response));
    };
    response.available = true;
    #[derive(FromQueryResult)]
    struct Backfill {
        complete: bool,
        discovered: i64,
    }
    let backfill = rows::<Backfill, _>(
        registry.connection(),
        "select complete,discovered from file_document_backfill where id=1",
        vec![],
    )
    .await
    .c(h!())?
    .pop()
    .c(h!())?;
    response.backfill_complete = backfill.complete;
    response.discovered = backfill.discovered;
    response.counts=rows(registry.connection(),"select kind,state,count(*) as count from file_document_job group by kind,state order by kind,state",vec![]).await.c(h!())?;
    if let Ok(login) = super::access::reader(
        &env,
        crate::users::login_id_from_identity(&user).c(h!())?,
    )
    .await
    {
        let ids = super::access::visible_ids(
            &env,
            &login,
            req.include_archived.unwrap_or(false),
        )
        .await
        .c(h!())?;
        response.documents = super::search::search(&env, &req, ids)
            .await
            .c(h!())?
            .documents;
    }
    Ok(Json(response))
}
