//! Read-only routes the agent uses to work with conversation uploads.
//!
//! Every route resolves the running request of the calling agent session
//! and only exposes uploads already sent in that request's conversation.

use super::{formats, types::*};
use crate::ai_agent::{access, work_memory::running_request};
use crate::attachments::store::rows;
use crate::config::{
    AI_AGENT_UPLOAD_CONTEXT_MAX_ITEMS, AI_AGENT_UPLOAD_QUERY_MAX_CHARS,
    AI_AGENT_UPLOAD_READ_LIMIT, AI_AGENT_UPLOAD_READ_MAX_LIMIT,
    AI_AGENT_UPLOAD_SEARCH_LIMIT, AI_AGENT_UPLOAD_SEARCH_MAX_LIMIT,
};
use crate::entities::{
    ai_agent_engine_runtime_profile, ai_agent_request, ai_agent_upload,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_web::{
    post,
    web::{Data, Json},
    HttpRequest,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUploadDocument {
    pub upload_id: String,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub state: String,
    pub chunk_count: i32,
    pub text_chars: i64,
    pub warnings: Value,
    pub has_image: bool,
}

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUploadSection {
    ordinal: i32,
    member: String,
    locator: String,
    markdown: String,
}

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUploadMatch {
    upload_id: String,
    file_name: String,
    ordinal: i32,
    member: String,
    locator: String,
    snippet: String,
}

pub(crate) fn document(upload: &ai_agent_upload::Model) -> AgentUploadDocument {
    AgentUploadDocument {
        upload_id: upload.id.to_string(),
        file_name: upload.file_name.clone(),
        content_type: upload.content_type.clone(),
        size_bytes: upload.size_bytes,
        state: upload.state.clone(),
        chunk_count: upload.chunk_count,
        text_chars: upload.text_chars,
        warnings: upload.warnings.clone(),
        has_image: formats::is_image(&upload.extension)
            && upload.preview_key.is_some(),
    }
}

#[post("/api/ai-agent/uploads/ai/list")]
pub async fn agent_list(
    env: Data<Env>,
    http: HttpRequest,
    _req: Json<AgentUploadListReq>,
) -> Result<Json<Value>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let uploads = visible_uploads(&env, &request).await.c(h!())?;
    Ok(Json(json!({
        "documents": uploads.iter().map(document).collect::<Vec<_>>(),
    })))
}

#[post("/api/ai-agent/uploads/ai/read")]
pub async fn agent_read(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<AgentUploadReadReq>,
) -> Result<Json<Value>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let upload = sent_upload(&env, &request, &req.upload_id).await.c(h!())?;
    let limit = req
        .limit
        .unwrap_or(AI_AGENT_UPLOAD_READ_LIMIT)
        .clamp(1, AI_AGENT_UPLOAD_READ_MAX_LIMIT);
    let mut values = vec![upload.id.into(), req.after.unwrap_or(-1).into()];
    let mut filter = "upload_id=$1 and ordinal>$2".to_string();
    if let Some(query) = req.query.as_deref().filter(|q| !q.trim().is_empty()) {
        values.push(like_pattern(query).c(h!())?.into());
        filter +=
            " and (text ilike $3 escape '\\' or locator ilike $3 escape '\\')";
    }
    values.push((limit + 1).into());
    let sql = format!(
        "select ordinal,member,locator,markdown from ai_agent_upload_chunk where {filter} order by ordinal limit ${}",
        values.len()
    );
    let mut sections = rows::<AgentUploadSection, _>(&env.dbx, &sql, values)
        .await
        .c(h!())?;
    let more = sections.len() > limit as usize;
    sections.truncate(limit as usize);
    let next_after = more
        .then(|| sections.last().map(|section| section.ordinal))
        .flatten();
    Ok(Json(json!({
        "document": document(&upload),
        "sections": sections,
        "nextAfter": next_after,
    })))
}

#[post("/api/ai-agent/uploads/ai/search")]
pub async fn agent_search(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<AgentUploadSearchReq>,
) -> Result<Json<Value>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let visible = super::context::visible_request_ids(&env.dbx, &request)
        .await
        .c(h!())?
        .into_iter()
        .collect::<Vec<_>>();
    let query = req.query.trim();
    if query.is_empty() {
        return Err(AppError::BL {
            msg: "query is required".to_string(),
        });
    }
    let limit = req
        .limit
        .unwrap_or(AI_AGENT_UPLOAD_SEARCH_LIMIT)
        .clamp(1, AI_AGENT_UPLOAD_SEARCH_MAX_LIMIT);
    let matches = rows::<AgentUploadMatch, _>(
        &env.dbx,
        r#"
select chunk.upload_id::text as upload_id, upload.file_name, chunk.ordinal,
 chunk.member, chunk.locator,
 ts_headline('russian', chunk.text, websearch_to_tsquery('russian', $2),
   'MaxFragments=2,MaxWords=30,MinWords=8') as snippet
from ai_agent_upload_chunk chunk
join ai_agent_upload upload on upload.id=chunk.upload_id
where upload.conversation_id=$1 and upload.request_id=any($5)
  and (chunk.search_tsv @@ websearch_to_tsquery('russian', $2)
       or chunk.text ilike $3 escape '\')
order by ts_rank(chunk.search_tsv, websearch_to_tsquery('russian', $2)) desc,
 upload.created_at, chunk.ordinal
limit $4
        "#,
        vec![
            request.conversation_id.into(),
            query.to_string().into(),
            like_pattern(query).c(h!())?.into(),
            limit.into(),
            visible.into(),
        ],
    )
    .await
    .c(h!())?;
    Ok(Json(json!({ "matches": matches })))
}

/// Returns the downscaled image so a vision engine can look at it again in a
/// later turn. Unavailable when the conversation engine is text-only.
#[post("/api/ai-agent/uploads/ai/image")]
pub async fn agent_image(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<AgentUploadIdReq>,
) -> Result<Json<Value>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    if !vision_enabled(&env, request.ai_engine_id).await.c(h!())? {
        return Err(AppError::BL {
            msg: "The conversation model does not accept images".to_string(),
        });
    }
    let upload = sent_upload(&env, &request, &req.upload_id).await.c(h!())?;
    let data = preview_base64(&env, &upload)
        .await
        .c(h!())?
        .ok_or(AppError::BL {
            msg: "This upload has no image".to_string(),
        })
        .c(h!())?;
    Ok(Json(json!({
        "uploadId": upload.id.to_string(),
        "fileName": upload.file_name,
        "mimeType": "image/jpeg",
        "data": data,
    })))
}

pub(crate) async fn vision_enabled(
    env: &Env,
    ai_engine_id: Uuid,
) -> Result<bool, AppError> {
    Ok(
        ai_agent_engine_runtime_profile::Entity::find_by_id(ai_engine_id)
            .one(&env.dbx)
            .await
            .c(h!())?
            .is_some_and(|profile| profile.vision_input_enabled == Some(true)),
    )
}

pub(crate) async fn preview_base64(
    env: &Env,
    upload: &ai_agent_upload::Model,
) -> Result<Option<String>, AppError> {
    let Some(key) = &upload.preview_key else {
        return Ok(None);
    };
    let bytes = crate::messenger::media::fetch_media_bytes_by_key(env, key)
        .await
        .c(h!())?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(STANDARD.encode(bytes)))
}

/// Uploads sent with this request or earlier ones in its conversation;
/// files of later queued messages stay invisible to this run.
pub(crate) async fn visible_uploads(
    env: &Env,
    request: &ai_agent_request::Model,
) -> Result<Vec<ai_agent_upload::Model>, AppError> {
    let visible = super::context::visible_request_ids(&env.dbx, request)
        .await
        .c(h!())?;
    Ok(ai_agent_upload::Entity::find()
        .filter(
            ai_agent_upload::Column::ConversationId.eq(request.conversation_id),
        )
        .filter(ai_agent_upload::Column::RequestId.is_in(visible))
        .order_by_asc(ai_agent_upload::Column::CreatedAt)
        .order_by_asc(ai_agent_upload::Column::Id)
        .limit(AI_AGENT_UPLOAD_CONTEXT_MAX_ITEMS)
        .all(&env.dbx)
        .await
        .c(h!())?)
}

async fn sent_upload(
    env: &Env,
    request: &ai_agent_request::Model,
    upload_id: &str,
) -> Result<ai_agent_upload::Model, AppError> {
    let visible = super::context::visible_request_ids(&env.dbx, request)
        .await
        .c(h!())?;
    ai_agent_upload::Entity::find_by_id(access::parse_uuid(upload_id).c(h!())?)
        .filter(
            ai_agent_upload::Column::ConversationId.eq(request.conversation_id),
        )
        .filter(ai_agent_upload::Column::RequestId.is_in(visible))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

fn like_pattern(query: &str) -> Result<String, AppError> {
    if query.chars().count() > AI_AGENT_UPLOAD_QUERY_MAX_CHARS {
        return Err(AppError::BL {
            msg: "query is too long".to_string(),
        });
    }
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Ok(format!("%{escaped}%"))
}
