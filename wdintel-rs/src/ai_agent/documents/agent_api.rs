//! Routes the runner uses to read templates and earlier document versions
//! and to store generated files. Each resolves the running request of the
//! calling agent session and stays inside that request's conversation.

use super::revisions;
use super::types::*;
use super::validate::DOCX_CONTENT_TYPE;
use crate::ai_agent::access;
use crate::ai_agent::uploads::agent_api::visible_uploads;
use crate::ai_agent::work_memory::running_request;
use crate::config::AI_AGENT_DOCUMENT_MAX_BYTES;
use crate::entities::ai_agent_document;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_web::{
    get,
    http::header,
    post,
    web::{self, Bytes, Data, Json, Query},
    HttpRequest, HttpResponse,
};
use futures::StreamExt;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{json, Value};

const TEMPLATE_EXTENSION: &str = "docx";

#[post("/api/ai-agent/documents/ai/list")]
pub async fn agent_list(
    env: Data<Env>,
    http: HttpRequest,
    _req: Json<Value>,
) -> Result<Json<Value>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let documents =
        revisions::runner_documents(&env.dbx, request.conversation_id)
            .await
            .c(h!())?;
    let templates = visible_uploads(&env, &request)
        .await
        .c(h!())?
        .into_iter()
        .filter(|upload| upload.extension == TEMPLATE_EXTENSION)
        .map(|upload| AgentTemplate {
            upload_id: upload.id.to_string(),
            file_name: upload.file_name,
            size_bytes: upload.size_bytes,
        })
        .collect::<Vec<_>>();
    Ok(Json(
        json!({ "documents": documents, "templates": templates }),
    ))
}

#[get("/api/ai-agent/documents/ai/source")]
pub async fn agent_source(
    env: Data<Env>,
    http: HttpRequest,
    query: Query<AgentDocumentSourceQuery>,
) -> Result<HttpResponse, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let (storage_key, revision) =
        match (query.upload_id.as_deref(), query.document_id.as_deref()) {
            (Some(upload_id), None) => {
                let upload_id = access::parse_uuid(upload_id)?;
                let upload = visible_uploads(&env, &request)
                    .await
                    .c(h!())?
                    .into_iter()
                    .find(|upload| upload.id == upload_id)
                    .ok_or(AppError::NotFound)?;
                if upload.extension != TEMPLATE_EXTENSION {
                    return Err(AppError::BL {
                        msg: "Шаблоном може бути лише файл .docx".to_string(),
                    });
                }
                (upload.storage_key, None)
            }
            (None, Some(document_id)) => {
                let document = ai_agent_document::Entity::find_by_id(
                    access::parse_uuid(document_id)?,
                )
                .filter(
                    ai_agent_document::Column::ConversationId
                        .eq(request.conversation_id),
                )
                .one(&env.dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?;
                let revision = revisions::revision(
                    &env.dbx,
                    document.id,
                    query.revision.unwrap_or(document.head_revision),
                )
                .await
                .c(h!())?;
                (revision.storage_key, Some(revision.revision))
            }
            _ => {
                return Err(AppError::BL {
                    msg: "Pass either uploadId or documentId".to_string(),
                })
            }
        };
    let bytes = super::store::fetch(&env, &storage_key).await.c(h!())?;
    let mut response = HttpResponse::Ok();
    response
        .insert_header((header::CONTENT_TYPE, DOCX_CONTENT_TYPE))
        .insert_header((header::CACHE_CONTROL, "private, no-store"));
    if let Some(revision) = revision {
        response
            .insert_header(("X-Echo-Document-Revision", revision.to_string()));
    }
    Ok(response.body(bytes))
}

#[post("/api/ai-agent/documents/ai/save")]
pub async fn agent_save(
    env: Data<Env>,
    http: HttpRequest,
    query: Query<AgentDocumentSaveQuery>,
    payload: web::Payload,
) -> Result<Json<AgentSavedDocument>, AppError> {
    let request = running_request(&env, &http).await.c(h!())?;
    let bytes = read_bounded(payload).await?;
    Ok(Json(
        revisions::save_agent_output(&env, &request, &query, bytes)
            .await
            .c(h!())?,
    ))
}

async fn read_bounded(mut payload: web::Payload) -> Result<Bytes, AppError> {
    let mut body = web::BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > AI_AGENT_DOCUMENT_MAX_BYTES
        {
            return Err(AppError::BL {
                msg: format!(
                    "Документ більший за {} МБ",
                    AI_AGENT_DOCUMENT_MAX_BYTES / 1024 / 1024
                ),
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}
