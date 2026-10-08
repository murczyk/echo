use super::{store::*, types::*};
use crate::error::AppError;
use crate::{
    config::*,
    entities::{attachment_document, attachment_settings, signal_message},
    h,
    types::{Env, ShortContext},
    users::{ensure_admin, ensure_base_role, login_id_from_identity},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{EntityTrait, FromQueryResult};
use uuid::Uuid;

pub async fn allowed(
    env: &Env,
    user: &Identity,
) -> Result<Vec<String>, AppError> {
    ensure_base_role(&env.dbx, user).await.c(h!())?;
    Ok(crate::messenger::group::get_identity_sigint_groups(
        &env.dbx,
        &login_id_from_identity(user).c(h!())?,
    )
    .await
    .c(h!())?)
}

pub async fn authorize(
    env: &Env,
    user: &Identity,
    id: Uuid,
) -> Result<(), AppError> {
    let media = crate::ocr::authorized_media(env, user, id).await.c(h!())?;
    let message = signal_message::Entity::find_by_id(media.signal_message_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    if message.deleted {
        return Err(AppError::Forbidden("attachment unavailable".into()));
    }
    Ok(())
}

#[post("/api/attachments/search")]
pub async fn search(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentSearchReq>,
) -> Result<Json<AttachmentSearchRsp>, AppError> {
    let groups = allowed(&env, &user).await.c(h!())?;
    Ok(Json(search_documents(&env, &req, groups).await.c(h!())?))
}

pub async fn search_documents(
    env: &Env,
    req: &AttachmentSearchReq,
    mut groups: Vec<String>,
) -> anyhow::Result<AttachmentSearchRsp> {
    if let Some(selected) = &req.selected_groups {
        groups.retain(|g| selected.contains(g));
    }
    let mut values = vec![groups.into()];
    let mut filters=vec!["not message.deleted and exists(select 1 from signal_message_group smg join signal_group sg on sg.master_key=smg.group_master_key and not sg.deleted and not sg.is_archived where smg.signal_message_id=message.id and smg.group_master_key=any($1))".to_string()];
    if let Some(query) = &req.query {
        filters.push(
            super::search::text_predicate(
                query,
                "outer_media.id",
                "document",
                false,
                &mut values,
            )
            .c(h!())?,
        );
    }
    if let Some(ids) = &req.message_ids {
        values.push(ids.clone().into());
        filters.push(format!("message.id=any(${})", values.len()));
    }
    if let Some(from) = req.from {
        values.push(from.into());
        filters.push(format!("coalesce(message.timestamp,message.created_at)>=to_timestamp(${}::double precision/1000) at time zone 'utc'",values.len()));
    }
    if let Some(to) = req.to {
        values.push(to.into());
        filters.push(format!("coalesce(message.timestamp,message.created_at)<=to_timestamp(${}::double precision/1000) at time zone 'utc'",values.len()));
    }
    if let Some(format) = &req.format {
        values.push(format.to_lowercase().into());
        filters.push(format!("lower(media.file_ext)=${}", values.len()));
    }
    if let Some(cursor) = &req.cursor {
        values.push(Uuid::parse_str(cursor).c(h!())?.into());
        filters.push(format!("media.id<${}", values.len()));
    }
    let limit = req.limit.unwrap_or(ATTACHMENT_SEARCH_LIMIT).clamp(1, 50);
    let columns = if let Some(query) = req
        .query
        .as_deref()
        .filter(|query| !query.trim().is_empty())
    {
        values.push(query.to_string().into());
        ITEM_COLUMNS.replace("null::text as snippet", &format!("(select chunk.member || ' — ' || chunk.locator || ': ' || ts_headline('russian',chunk.text,websearch_to_tsquery('russian',${}),'MaxWords=40,MinWords=10,StartSel=[,StopSel=]') from attachment_chunk chunk where chunk.media_id=media.id and chunk.revision=doc.revision order by (chunk.search_tsv @@ websearch_to_tsquery('russian',${})) desc, chunk.ordinal limit 1) as snippet",values.len(),values.len()))
    } else {
        ITEM_COLUMNS.to_string()
    };
    values.push((limit + 1).into());
    let mut documents=rows::<AttachmentItem,_>(&env.dbx,&format!("select {columns} {ITEM_FROM} cross join lateral (select media.id) outer_media where {} order by media.id desc limit ${}",filters.join(" and "),values.len()),values).await.c(h!())?;
    let more = documents.len() > limit as usize;
    documents.truncate(limit as usize);
    let next_cursor = more.then(|| documents.last().unwrap().media_id.clone());
    Ok(AttachmentSearchRsp {
        documents,
        next_cursor,
    })
}

#[post("/api/attachments/get")]
pub async fn get(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentReadReq>,
) -> Result<Json<AttachmentReadRsp>, AppError> {
    authorize(&env, &user, Uuid::parse_str(&req.media_id).c(h!())?)
        .await
        .c(h!())?;
    let mut req = req.into_inner();
    if req.limit.is_none() {
        req.limit = Some(0);
    }
    Ok(Json(read_document(&env, &req).await.c(h!())?))
}

#[post("/api/attachments/read")]
pub async fn read(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentReadReq>,
) -> Result<Json<AttachmentReadRsp>, AppError> {
    authorize(&env, &user, Uuid::parse_str(&req.media_id).c(h!())?)
        .await
        .c(h!())?;
    Ok(Json(read_document(&env, &req).await.c(h!())?))
}

pub async fn read_document(
    env: &Env,
    req: &AttachmentReadReq,
) -> anyhow::Result<AttachmentReadRsp> {
    let id = Uuid::parse_str(&req.media_id).c(h!())?;
    let document=rows::<AttachmentItem,_>(&env.dbx,&format!("select {ITEM_COLUMNS} {ITEM_FROM} where media.id=$1 and not message.deleted"),vec![id.into()]).await.c(h!())?.pop().c(h!())?;
    if let Some(revision) = &req.revision {
        anyhow::ensure!(
            document.revision.as_ref() == Some(revision),
            "document revision changed; reload metadata"
        );
    }
    let mut values = vec![
        id.into(),
        req.after.unwrap_or(-1).into(),
        document
            .revision
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .c(h!())?
            .into(),
    ];
    let mut filter =
        "chunk.media_id=$1 and chunk.ordinal>$2 and chunk.revision=$3"
            .to_string();
    if let Some(member) = &req.member {
        values.push(member.clone().into());
        filter += &format!(" and chunk.member=${}", values.len());
    }
    if let Some(query) = &req.query {
        values.push(
            format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"))
                .into(),
        );
        filter += &format!(
            " and (chunk.text ilike ${0} or chunk.locator ilike ${0})",
            values.len()
        );
    }
    let limit = req.limit.unwrap_or(ATTACHMENT_READ_LIMIT).clamp(0, 8);
    values.push((limit + 1).into());
    let mut sections=rows::<AttachmentSection,_>(&env.dbx,&format!("select chunk.id::text,chunk.ordinal,chunk.member,chunk.locator,chunk.text,chunk.markdown,chunk.html,chunk.summary from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision where {filter} order by ordinal limit ${}",values.len()),values).await.c(h!())?;
    let more = sections.len() > limit as usize;
    sections.truncate(limit as usize);
    let next_after = if more {
        Some(sections.last().map_or(-1, |section| section.ordinal))
    } else {
        None
    };
    let stored = attachment_document::Entity::find_by_id(id)
        .one(&env.dbx)
        .await
        .c(h!())?;
    anyhow::ensure!(
        stored
            .as_ref()
            .and_then(|document| document.revision)
            .map(|id| id.to_string())
            == document.revision,
        "document revision changed; reload metadata"
    );
    let warnings = stored
        .map(|d| serde_json::from_value(d.warnings))
        .transpose()
        .c(h!())?
        .unwrap_or_default();
    #[derive(FromQueryResult)]
    struct Coordinates {
        coordinates: serde_json::Value,
    }
    let ids = sections
        .iter()
        .map(|section| Uuid::parse_str(&section.id).c(h!()))
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let coordinates = rows::<Coordinates,_>(&env.dbx,"select coalesce(jsonb_agg(point),'[]') as coordinates from attachment_chunk chunk cross join lateral jsonb_array_elements(chunk.coordinates) point where chunk.id=any($1)",vec![ids.into()]).await.c(h!())?.pop().c(h!())?.coordinates;
    Ok(AttachmentReadRsp {
        coordinates: serde_json::from_value(coordinates).c(h!())?,
        document,
        sections,
        next_after,
        warnings,
    })
}

#[post("/api/admin/attachments/page")]
pub async fn admin_page(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentSearchReq>,
) -> Result<Json<AttachmentAdminRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let groups = allowed(&env, &user).await.c(h!())?;
    let documents = search_documents(&env, &req, groups)
        .await
        .c(h!())?
        .documents;
    let counts=rows(&env.dbx,"select kind,state,count(*) as count from attachment_job group by kind,state order by kind,state",vec![]).await.c(h!())?;
    let engines=rows(&env.dbx,"select id::text,name,model_name from ai_engine where enabled and callsign_enabled order by name",vec![]).await.c(h!())?;
    Ok(Json(AttachmentAdminRsp {
        settings: load_settings(&env).await.c(h!())?,
        counts,
        documents,
        engines,
    }))
}

async fn load_settings(env: &Env) -> anyhow::Result<AttachmentSettings> {
    let s = attachment_settings::Entity::find_by_id(1i16)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    Ok(AttachmentSettings {
        enabled: s.enabled,
        positions_enabled: s.positions_enabled,
        summaries_enabled: s.summaries_enabled,
        ai_engine_id: s.ai_engine_id.map(|id| id.to_string()),
        position_engine_id: s.position_engine_id.map(|id| id.to_string()),
        backfill_complete: s.backfill_complete,
    })
}

#[post("/api/admin/attachments/settings")]
pub async fn settings(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentSettings>,
) -> Result<Json<AttachmentSettings>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
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
        let valid = rows::<Enabled,_>(&env.dbx,"select enabled and callsign_enabled as enabled from ai_engine where id=$1",vec![id.into()]).await.c(h!())?.pop().is_some_and(|engine|engine.enabled);
        if !valid {
            return Err(AppError::BL {
                msg: "Вибраний ШІ рушій недоступний для тексту".into(),
            });
        }
    }
    if req.enabled
        && ((req.summaries_enabled && engine.is_none())
            || (req.positions_enabled && position.is_none()))
    {
        return Err(AppError::BL {
            msg: "Оберіть рушії для увімкнених етапів".into(),
        });
    }
    execute(&env.dbx,"update attachment_settings set enabled=$1,summaries_enabled=$2,positions_enabled=$3,ai_engine_id=$4,position_engine_id=$5 where id=1",
        vec![req.enabled.into(),req.summaries_enabled.into(),req.positions_enabled.into(),engine.into(),position.into()]).await.c(h!())?;
    Ok(Json(load_settings(&env).await.c(h!())?))
}

#[post("/api/admin/attachments/retry")]
pub async fn retry(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentReadReq>,
) -> Result<Json<AttachmentReadRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let id = Uuid::parse_str(&req.media_id).c(h!())?;
    authorize(&env, &user, id).await.c(h!())?;
    retry_document(&env.dbx, id).await.c(h!())?;
    Ok(Json(read_document(&env, &req).await.c(h!())?))
}

#[post("/api/attachments/inspect-original")]
pub async fn inspect(
    env: Data<Env>,
    user: Identity,
    req: Json<AttachmentInspectionReq>,
) -> Result<Json<AttachmentInspectionRsp>, AppError> {
    let id = Uuid::parse_str(&req.media_id).c(h!())?;
    authorize(&env, &user, id).await.c(h!())?;
    if !matches!(req.operation.as_str(), "table" | "page" | "ocr" | "image") {
        return Err(AppError::BL {
            msg: "unsupported inspection operation".into(),
        });
    }
    if req.member.as_ref().is_some_and(|value| value.len() > 4000)
        || req.locator.as_ref().is_some_and(|value| value.len() > 1000)
    {
        return Err(AppError::BL {
            msg: "Inspection selector too long".into(),
        });
    }
    use sea_orm::TransactionTrait;
    let tx = env.dbx.begin().await.c(h!())?;
    execute(
        &tx,
        "select id from attachment_settings where id=1 for update",
        vec![],
    )
    .await
    .c(h!())?;
    #[derive(FromQueryResult)]
    struct Count {
        count: i64,
    }
    let count=rows::<Count,_>(&tx,"select count(*) as count from attachment_job where kind='inspect' and state in ('queued','running','retry_wait')",vec![]).await.c(h!())?.pop().c(h!())?.count;
    if count >= ATTACHMENT_MAX_INSPECTION_JOBS {
        return Err(AppError::BL {
            msg: "Original inspection queue is full".into(),
        });
    }
    let document = attachment_document::Entity::find_by_id(id)
        .one(&tx)
        .await
        .c(h!())?
        .c(h!())?;
    let inspection = Uuid::now_v7();
    execute(&tx,"insert into attachment_job(id,media_id,generation,kind,payload) values($1,$2,$3,'inspect',$4)",
        vec![inspection.into(),id.into(),document.generation.into(),serde_json::to_value(req.0).c(h!())?.into()]).await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(Json(AttachmentInspectionRsp {
        id: inspection.to_string(),
        state: "queued".into(),
        result: None,
        error: None,
    }))
}

#[post("/api/attachments/inspection-status")]
pub async fn inspection_status(
    env: Data<Env>,
    user: Identity,
    req: Json<crate::ai_position::types::AiPositionIdReq>,
) -> Result<Json<AttachmentInspectionRsp>, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        media_id: Uuid,
        state: String,
        result: Option<serde_json::Value>,
        last_error: Option<String>,
    }
    let row=rows::<Row,_>(&env.dbx,"select job.media_id,job.state,job.result,job.last_error from attachment_job job join attachment_document doc on doc.media_id=job.media_id and doc.generation=job.generation where job.id=$1 and job.kind='inspect'",vec![req.id.into()]).await.c(h!())?.pop().c(h!())?;
    authorize(&env, &user, row.media_id).await.c(h!())?;
    Ok(Json(AttachmentInspectionRsp {
        id: req.id.to_string(),
        state: row.state,
        result: row.result.map(serde_json::from_value).transpose().c(h!())?,
        error: row.last_error,
    }))
}

pub(crate) async fn retry_document(
    db: &sea_orm::DatabaseConnection,
    id: Uuid,
) -> anyhow::Result<()> {
    use sea_orm::{QuerySelect, TransactionTrait};
    let tx = db.begin().await.c(h!())?;
    attachment_document::Entity::find_by_id(id)
        .lock_exclusive()
        .one(&tx)
        .await
        .c(h!())?
        .c(h!())?;
    let generation = Uuid::now_v7();
    execute(&tx,"update attachment_document set generation=$2,state='queued',extractor_job_id=null,last_error=null where media_id=$1",vec![id.into(),generation.into()]).await.c(h!())?;
    execute(&tx,"update attachment_job set state='superseded',lease=null,lease_until=null where media_id=$1 and generation<>$2 and state<>'completed'",vec![id.into(),generation.into()]).await.c(h!())?;
    queue(&tx, id, generation, "extract").await.c(h!())?;
    tx.commit().await.c(h!())?;
    Ok(())
}
