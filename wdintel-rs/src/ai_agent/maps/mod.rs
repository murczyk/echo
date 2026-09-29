pub mod export;
pub mod prepare;
#[cfg(test)]
mod tests;
pub mod types;

use self::types::*;
use crate::config::AI_AGENT_MAP_BATCH_MAX_RECORDS;
use crate::entities::{ai_agent_request_event, ai_agent_user_link};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
    HttpResponse,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

impl AiAgentMapDocument {
    pub fn summary(&self, request_id: Uuid) -> AiAgentMapSummary {
        AiAgentMapSummary {
            id: self.id.clone(),
            request_id: request_id.to_string(),
            title: self.title.clone(),
            is_main: self.is_main,
            warnings: self.warnings.clone(),
            total_count: self.total_count,
            valid_count: self.valid_count,
            invalid_count: self.invalid_count,
        }
    }
}

pub(super) fn parse(payload: &Value) -> Option<AiAgentMapDocument> {
    serde_json::from_value(payload.get("document")?.clone()).ok()
}

pub(super) async fn load_documents(
    dbx: &impl ConnectionTrait,
    request_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Vec<AiAgentMapDocument>>> {
    let mut documents: HashMap<Uuid, Vec<AiAgentMapDocument>> = HashMap::new();
    if request_ids.is_empty() {
        return Ok(documents);
    }
    let events = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::RequestId)
        .column(ai_agent_request_event::Column::Payload)
        .filter(
            ai_agent_request_event::Column::RequestId
                .is_in(request_ids.iter().copied()),
        )
        .filter(ai_agent_request_event::Column::EventType.eq("map_artifact"))
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<(Uuid, Value)>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut seen = HashSet::new();
    for (request_id, payload) in events {
        if let Some(document) = parse(&payload) {
            if seen.insert((request_id, document.id.clone())) {
                documents.entry(request_id).or_default().push(document);
            }
        }
    }
    Ok(documents)
}

pub(super) async fn load_summaries(
    dbx: &impl ConnectionTrait,
    request_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Vec<AiAgentMapSummary>>> {
    let mut summaries: HashMap<Uuid, Vec<AiAgentMapSummary>> = HashMap::new();
    if request_ids.is_empty() {
        return Ok(summaries);
    }
    let events = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::RequestId)
        .column(ai_agent_request_event::Column::MapSummary)
        .filter(
            ai_agent_request_event::Column::RequestId
                .is_in(request_ids.iter().copied()),
        )
        .filter(ai_agent_request_event::Column::EventType.eq("map_artifact"))
        .filter(ai_agent_request_event::Column::MapSummary.is_not_null())
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<(Uuid, Value)>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut seen = HashSet::new();
    for (request_id, payload) in events {
        if let Ok(summary) =
            serde_json::from_value::<AiAgentMapSummary>(payload)
        {
            if seen.insert((request_id, summary.id.clone())) {
                summaries.entry(request_id).or_default().push(summary);
            }
        }
    }
    Ok(summaries)
}

async fn owner_id(env: &Env, user: &Identity) -> Result<Uuid, AppError> {
    let login_id = crate::users::login_id_from_identity(user).c(h!())?;
    crate::users::ensure_base_role_by_id(&env.dbx, &login_id)
        .await
        .c(h!())?;
    let link = ai_agent_user_link::Entity::find()
        .filter(ai_agent_user_link::Column::AgentLoginId.eq(login_id))
        .one(&env.dbx)
        .await
        .c(h!())?;
    if let Some(link) = link {
        return Ok(link.human_login_id);
    }
    Ok(super::access::current_human_login(&env.dbx, user, false)
        .await
        .c(h!())?
        .id)
}

async fn check_sources(
    env: &Env,
    login_id: Uuid,
    document: &AiAgentMapDocument,
) -> Result<(), AppError> {
    let sources = document
        .records
        .iter()
        .flat_map(|record| &record.sources)
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Ok(());
    }
    let ids = sources
        .iter()
        .map(|source| source.message_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let logins =
        crate::users::get_organism_login_ids_by_id(&env.dbx, &login_id)
            .await
            .c(h!())?;
    let messages = crate::rer_importer::inbox::messages_by_id_bl(
        &login_id,
        &logins,
        env,
        &ids,
        &Default::default(),
    )
    .await
    .c(h!())?;
    let identifiers = messages
        .into_iter()
        .map(|(id, message)| {
            let identifier = message
                .message_uuid
                .as_deref()
                .or(message.message_uid.as_deref())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string());
            (id, identifier)
        })
        .collect::<HashMap<_, _>>();
    if sources.iter().any(|source| {
        identifiers.get(&source.message_id) != Some(&source.message_identifier)
    }) {
        return Err(AppError::Forbidden("Джерело мапи недоступне".to_string()));
    }
    Ok(())
}

async fn authorized_document(
    env: &Env,
    user: &Identity,
    req: &AiAgentMapGetReq,
) -> Result<AiAgentMapDocument, AppError> {
    let owner_id = owner_id(env, user).await.c(h!())?;
    document_for_owner(env, owner_id, req).await
}

pub(super) async fn document_for_owner(
    env: &Env,
    owner_id: Uuid,
    req: &AiAgentMapGetReq,
) -> Result<AiAgentMapDocument, AppError> {
    let request_id = super::access::parse_uuid(&req.request_id).c(h!())?;
    super::access::parse_uuid(&req.map_id).c(h!())?;
    let request = super::owned_request(&env.dbx, owner_id, request_id)
        .await
        .c(h!())?;
    super::owned_conversation(&env.dbx, owner_id, request.conversation_id)
        .await
        .c(h!())?;
    let document = load_documents(&env.dbx, &[request_id])
        .await
        .c(h!())?
        .remove(&request_id)
        .unwrap_or_default()
        .into_iter()
        .find(|document| document.id == req.map_id)
        .ok_or(AppError::NotFound)
        .c(h!())?;
    check_sources(env, owner_id, &document).await.c(h!())?;
    Ok(document)
}

#[post("/api/ai-agent/maps/prepare")]
pub async fn prepare_map(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapPrepareReq>,
) -> Result<Json<AiAgentMapPrepareRsp>, AppError> {
    owner_id(&env, &user).await.c(h!())?;
    if req.records.is_empty()
        || req.records.len() > AI_AGENT_MAP_BATCH_MAX_RECORDS
    {
        return Err(AppError::BL {
            msg: "Пакет мапи має містити від 1 до 16 записів".to_string(),
        });
    }
    let records = req
        .into_inner()
        .records
        .into_iter()
        .map(prepare::prepare_record)
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    Ok(Json(AiAgentMapPrepareRsp { records }))
}

#[post("/api/ai-agent/maps/get")]
pub async fn get_map(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapGetReq>,
) -> Result<Json<AiAgentMapDocument>, AppError> {
    Ok(Json(authorized_document(&env, &user, &req).await.c(h!())?))
}

async fn download(
    env: &Env,
    user: &Identity,
    req: &AiAgentMapGetReq,
    format: &str,
) -> Result<HttpResponse, AppError> {
    super::access::current_human_login(&env.dbx, user, false)
        .await
        .c(h!())?;
    let document = authorized_document(env, user, req).await.c(h!())?;
    let (content_type, bytes) = if format == "csv" {
        ("text/csv; charset=utf-8", export::csv(&document).c(h!())?)
    } else {
        if document.valid_count == 0 {
            return Err(AppError::BL {
                msg: "Мапа не містить коректних точок; доступний CSV"
                    .to_string(),
            });
        }
        (
            "application/vnd.google-earth.kmz",
            export::kmz(&document, &crate::icons::get_icon_path(&env.config))
                .c(h!())?,
        )
    };
    Ok(HttpResponse::Ok()
        .content_type(content_type)
        .insert_header((
            "Content-Disposition",
            format!("attachment; filename=\"map-{}.{format}\"", document.id),
        ))
        .insert_header(("Cache-Control", "private, no-store"))
        .body(bytes))
}

#[post("/api/ai-agent/maps/csv")]
pub async fn download_csv(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapGetReq>,
) -> Result<HttpResponse, AppError> {
    download(&env, &user, &req, "csv").await
}

#[post("/api/ai-agent/maps/kmz")]
pub async fn download_kmz(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapGetReq>,
) -> Result<HttpResponse, AppError> {
    download(&env, &user, &req, "kmz").await
}
