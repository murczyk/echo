use super::{
    queue::{self, Job},
    types::*,
};
use crate::{
    attachments::store::{execute, rows},
    config::*,
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{FromQueryResult, TransactionTrait};
use uuid::Uuid;

#[post("/api/device/files/ai/inspect-original")]
pub(crate) async fn inspect(
    env: Data<Env>,
    user: Identity,
    req: Json<DeviceDocumentInspectionReq>,
) -> Result<Json<DeviceDocumentInspectionRsp>, AppError> {
    super::api::authorize(&env, &user, &req.device_id)
        .await
        .c(h!())?;
    if !super::settings::load(&env).await.c(h!())?.enabled {
        return Err(AppError::BL {
            msg: "Обробку файлів пристроїв вимкнено".into(),
        });
    }
    if !matches!(req.operation.as_str(), "table" | "page" | "ocr" | "image") {
        return Err(AppError::BL {
            msg: "Невідома операція перевірки".into(),
        });
    }
    for selector in [&req.member, &req.locator].into_iter().flatten() {
        super::search::check_text(selector).c(h!())?;
    }
    let db = env.file_registry_db().c(h!())?.connection();
    let tx = db.begin().await.c(h!())?;
    execute(
        &tx,
        "select id from file_document_backfill where id=1 for update",
        vec![],
    )
    .await
    .c(h!())?;
    #[derive(FromQueryResult)]
    struct Count {
        count: i64,
    }
    let count=rows::<Count,_>(&tx,"select count(*) as count from file_document_job where kind='inspect' and state in ('queued','running','retry_wait')",vec![]).await.c(h!())?.pop().c(h!())?.count;
    if count >= DEVICE_DOCUMENT_MAX_INSPECTIONS {
        return Err(AppError::BL {
            msg: "Черга перевірки файлів заповнена".into(),
        });
    }
    let file = Uuid::parse_str(&req.file_id).c(h!())?;
    let device = Uuid::parse_str(&req.device_id).c(h!())?;
    #[derive(FromQueryResult)]
    struct Generation {
        generation: Uuid,
    }
    let generation=rows::<Generation,_>(&tx,"select generation from file_document where device_id=$1 and file_id=$2 and revision=$3",vec![device.into(),file.into(),req.revision.into()]).await.c(h!())?.pop().ok_or(AppError::NotFound)?.generation;
    let id = Uuid::now_v7();
    execute(&tx,"insert into file_document_job(id,file_id,revision,generation,kind,payload) values($1,$2,$3,$4,'inspect',$5)",vec![id.into(),file.into(),req.revision.into(),generation.into(),serde_json::to_value(req.0).c(h!())?.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(Json(DeviceDocumentInspectionRsp {
        id: id.to_string(),
        state: "queued".into(),
        result: None,
        error: None,
    }))
}

#[post("/api/device/files/ai/inspection-status")]
pub(crate) async fn status(
    env: Data<Env>,
    user: Identity,
    req: Json<crate::ai_position::types::AiPositionIdReq>,
) -> Result<Json<DeviceDocumentInspectionRsp>, AppError> {
    #[derive(FromQueryResult)]
    struct Status {
        device_id: Uuid,
        state: String,
        result: Option<serde_json::Value>,
    }
    let result=rows::<Status,_>(env.file_registry_db().c(h!())?.connection(),"select d.device_id,j.state,j.result from file_document_job j join file_document d on d.file_id=j.file_id and d.revision=j.revision where j.id=$1 and j.kind='inspect'",vec![req.id.into()]).await.c(h!())?.pop().ok_or(AppError::NotFound)?;
    super::api::authorize(&env, &user, &result.device_id.to_string())
        .await
        .c(h!())?;
    Ok(Json(DeviceDocumentInspectionRsp {
        id: req.id.to_string(),
        error: (result.state == "failed")
            .then(|| "Не вдалося перевірити файл".into()),
        state: result.state,
        result: result
            .result
            .map(serde_json::from_value)
            .transpose()
            .c(h!())?,
    }))
}

pub(super) async fn process(env: &Env, job: &Job) -> anyhow::Result<bool> {
    let req: DeviceDocumentInspectionReq =
        serde_json::from_value(job.payload.clone())
            .or_else(|_| {
                let mut payload = job.payload.clone();
                payload.as_object_mut().map(|p| p.remove("extractorJobId"));
                serde_json::from_value(payload)
            })
            .c(h!())?;
    if !super::extraction::published(env, job, job.id)
        .await
        .c(h!())?
    {
        let source = super::extraction::source(env, job).await.c(h!())?;
        let Some(mut package) = super::extraction::package(env, job, &source)
            .await
            .c(h!())?
        else {
            return Ok(false);
        };
        package.sections.retain(|section| {
            req.member
                .as_ref()
                .is_none_or(|member| member == &section.member)
                && req.locator.as_ref().is_none_or(|locator| {
                    section
                        .locator
                        .to_lowercase()
                        .contains(&locator.to_lowercase())
                })
        });
        if package.sections.len() > DEVICE_DOCUMENT_READ_MAX_LIMIT as usize {
            package
                .sections
                .truncate(DEVICE_DOCUMENT_READ_MAX_LIMIT as usize);
            package.complete = false;
            package.warnings.push(
                "Уточніть сторінку або файл в архіві для решти вмісту".into(),
            );
        }
        super::extraction::publish(env, job, package)
            .await
            .c(h!())?;
    }
    let result = super::read::read(
        env,
        &DeviceDocumentReadReq {
            device_id: req.device_id,
            file_id: req.file_id,
            revision: req.revision,
            extraction_revision: Some(job.id.to_string()),
            limit: Some(DEVICE_DOCUMENT_READ_MAX_LIMIT),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let db = env.file_registry_db().c(h!())?.connection();
    let tx = db.begin().await.c(h!())?;
    queue::renew(&tx, job).await.c(h!())?;
    execute(
        &tx,
        "update file_document_job set result=$3 where id=$1 and lease=$2",
        vec![
            job.id.into(),
            job.lease.into(),
            serde_json::to_value(result).c(h!())?.into(),
        ],
    )
    .await
    .c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(true)
}
