//! Owner-only routes of the chat's document workspace.

use super::revisions;
use super::types::*;
use crate::ai_agent::access;
use crate::entities::{ai_agent_conversation, ai_agent_document};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    get,
    http::header,
    post,
    web::{Data, Json, Path},
    HttpResponse,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use uuid::Uuid;

async fn owned_conversation(
    env: &Env,
    human_login_id: Uuid,
    conversation_id: Uuid,
) -> Result<ai_agent_conversation::Model, AppError> {
    ai_agent_conversation::Entity::find_by_id(conversation_id)
        .filter(ai_agent_conversation::Column::HumanLoginId.eq(human_login_id))
        .filter(ai_agent_conversation::Column::DeletedAt.is_null())
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// A document of a non-deleted conversation of the signed-in human.
async fn owned_document(
    env: &Env,
    user: &Identity,
    document_id: &str,
) -> Result<ai_agent_document::Model, AppError> {
    let human = access::current_human_login(&env.dbx, user, false)
        .await
        .c(h!())?;
    let document =
        ai_agent_document::Entity::find_by_id(access::parse_uuid(document_id)?)
            .filter(ai_agent_document::Column::HumanLoginId.eq(human.id))
            .one(&env.dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
    owned_conversation(env, human.id, document.conversation_id)
        .await
        .c(h!())?;
    Ok(document)
}

#[post("/api/ai-agent/documents/list")]
pub async fn list_documents(
    env: Data<Env>,
    user: Identity,
    req: Json<AiAgentDocumentListReq>,
) -> Result<Json<AiAgentDocumentListRsp>, AppError> {
    let human = access::current_human_login(&env.dbx, &user, false)
        .await
        .c(h!())?;
    let conversation = owned_conversation(
        &env,
        human.id,
        access::parse_uuid(&req.conversation_id)?,
    )
    .await
    .c(h!())?;
    let documents =
        revisions::conversation_documents(&env.dbx, conversation.id)
            .await
            .c(h!())?
            .iter()
            .map(|(document, head)| revisions::summary(document, head))
            .collect();
    Ok(Json(AiAgentDocumentListRsp { documents }))
}

#[post("/api/ai-agent/documents/workspace")]
pub async fn document_workspace(
    env: Data<Env>,
    user: Identity,
    req: Json<AiAgentDocumentWorkspaceReq>,
) -> Result<Json<AiAgentDocumentWorkspaceRsp>, AppError> {
    let document = owned_document(&env, &user, &req.document_id)
        .await
        .c(h!())?;
    Ok(Json(
        revisions::workspace(&env.dbx, &document).await.c(h!())?,
    ))
}

#[post("/api/ai-agent/documents/head")]
pub async fn set_document_head(
    env: Data<Env>,
    user: Identity,
    req: Json<AiAgentDocumentHeadReq>,
) -> Result<Json<AiAgentDocumentWorkspaceRsp>, AppError> {
    let document = owned_document(&env, &user, &req.document_id)
        .await
        .c(h!())?;
    Ok(Json(revisions::set_head(&env, document.id, &req).await?))
}

/// Downloads one revision as an opaque attachment; generated files never
/// render on the Echo origin.
#[get("/api/ai-agent/documents/{document_id}/revisions/{revision}/file")]
pub async fn download_document(
    env: Data<Env>,
    user: Identity,
    path: Path<(String, i32)>,
) -> Result<HttpResponse, AppError> {
    let (document_id, revision) = path.into_inner();
    let document = owned_document(&env, &user, &document_id).await.c(h!())?;
    let revision = revisions::revision(&env.dbx, document.id, revision)
        .await
        .c(h!())?;
    let bytes = super::store::fetch(&env, &revision.storage_key)
        .await
        .c(h!())?;
    let mut disposition = crate::utils::multipart::download_content_disposition(
        document.file_name,
    );
    disposition.disposition = header::DispositionType::Attachment;
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/octet-stream"))
        .insert_header(disposition)
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .insert_header(("Content-Security-Policy", "sandbox"))
        .body(bytes))
}
