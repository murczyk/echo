//! Upload context added to the runner payload and to conversation history.

use super::{agent_api, formats};
use crate::config::{
    AI_AGENT_UPLOAD_INLINE_TEXT_MAX_CHARS, AI_AGENT_UPLOAD_MAX_IMAGES_PER_TURN,
};
use crate::entities::{
    ai_agent_request, ai_agent_upload, ai_agent_upload_chunk,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) async fn pending_count(
    env: &Env,
    request_id: Uuid,
) -> Result<u64, AppError> {
    Ok(ai_agent_upload::Entity::find()
        .filter(ai_agent_upload::Column::RequestId.eq(request_id))
        .filter(
            ai_agent_upload::Column::State.is_in(["uploaded", "extracting"]),
        )
        .count(&env.dbx)
        .await
        .c(h!())?)
}

pub(crate) struct RunnerUploads {
    pub uploads: Vec<Value>,
    pub turn_images: Vec<String>,
}

/// Lists every upload sent so far in the conversation. Full text is inlined
/// for the newest documents while it fits the budget; the agent reads the
/// rest with the upload tools.
pub(crate) async fn runner_uploads(
    env: &Env,
    request: &ai_agent_request::Model,
    vision: bool,
) -> Result<RunnerUploads, AppError> {
    let uploads = agent_api::visible_uploads(env, request).await.c(h!())?;
    let inline = inline_texts(env, request.id, &uploads).await.c(h!())?;
    let turn_images = if vision {
        uploads
            .iter()
            .filter(|upload| {
                upload.request_id == Some(request.id)
                    && formats::is_image(&upload.extension)
                    && upload.preview_key.is_some()
            })
            .take(AI_AGENT_UPLOAD_MAX_IMAGES_PER_TURN)
            .map(|upload| upload.id.to_string())
            .collect()
    } else {
        Vec::new()
    };
    let uploads = uploads
        .iter()
        .map(|upload| {
            let mut entry = serde_json::to_value(agent_api::document(upload))
                .unwrap_or_else(|_| json!({}));
            entry["currentMessage"] =
                json!(upload.request_id == Some(request.id));
            if let Some(text) = inline.get(&upload.id) {
                entry["inlineText"] = json!(text);
            }
            entry
        })
        .collect();
    Ok(RunnerUploads {
        uploads,
        turn_images,
    })
}

/// Requests up to and including the current one; uploads sent with later
/// queued messages stay invisible to this run.
pub(super) async fn visible_request_ids<C: ConnectionTrait>(
    db: &C,
    request: &ai_agent_request::Model,
) -> Result<HashSet<Uuid>, AppError> {
    Ok(ai_agent_request::Entity::find()
        .select_only()
        .column(ai_agent_request::Column::Id)
        .filter(
            ai_agent_request::Column::ConversationId
                .eq(request.conversation_id),
        )
        .filter(
            Condition::any()
                .add(ai_agent_request::Column::QueuedAt.lt(request.queued_at))
                .add(
                    Condition::all()
                        .add(
                            ai_agent_request::Column::QueuedAt
                                .eq(request.queued_at),
                        )
                        .add(ai_agent_request::Column::Id.lte(request.id)),
                ),
        )
        .into_tuple::<Uuid>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

async fn inline_texts(
    env: &Env,
    request_id: Uuid,
    uploads: &[ai_agent_upload::Model],
) -> Result<HashMap<Uuid, String>, AppError> {
    let mut ordered = uploads
        .iter()
        .filter(|upload| upload.state == "ready" && upload.chunk_count > 0)
        .collect::<Vec<_>>();
    // Current message first, then the most recent earlier uploads.
    ordered.sort_by_key(|upload| {
        (
            upload.request_id != Some(request_id),
            std::cmp::Reverse(upload.created_at),
        )
    });
    let mut remaining = AI_AGENT_UPLOAD_INLINE_TEXT_MAX_CHARS as i64;
    let mut texts = HashMap::new();
    for upload in ordered {
        if upload.text_chars > remaining {
            continue;
        }
        let chunks = ai_agent_upload_chunk::Entity::find()
            .filter(ai_agent_upload_chunk::Column::UploadId.eq(upload.id))
            .order_by_asc(ai_agent_upload_chunk::Column::Ordinal)
            .all(&env.dbx)
            .await
            .c(h!())?;
        let text = inline_text(&chunks);
        let chars = text.chars().count() as i64;
        if chars > remaining {
            continue;
        }
        remaining -= chars;
        texts.insert(upload.id, text);
    }
    Ok(texts)
}

fn inline_text(chunks: &[ai_agent_upload_chunk::Model]) -> String {
    chunks
        .iter()
        .map(|chunk| {
            format!(
                "[{} — {}]\n{}",
                chunk.member,
                chunk.locator,
                chunk.markdown.trim_end()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) async fn by_request<C: ConnectionTrait>(
    db: &C,
    request_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<ai_agent_upload::Model>>, AppError> {
    let mut grouped: HashMap<Uuid, Vec<ai_agent_upload::Model>> =
        HashMap::new();
    if request_ids.is_empty() {
        return Ok(grouped);
    }
    let uploads = ai_agent_upload::Entity::find()
        .filter(
            ai_agent_upload::Column::RequestId
                .is_in(request_ids.iter().copied()),
        )
        .order_by_asc(ai_agent_upload::Column::CreatedAt)
        .order_by_asc(ai_agent_upload::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    for upload in uploads {
        if let Some(request_id) = upload.request_id {
            grouped.entry(request_id).or_default().push(upload);
        }
    }
    Ok(grouped)
}

/// Prefix for an earlier user turn so the model knows which files it sent.
pub(crate) fn history_prefix(uploads: &[ai_agent_upload::Model]) -> String {
    if uploads.is_empty() {
        return String::new();
    }
    let files = uploads
        .iter()
        .map(|upload| format!("{} (uploadId {})", upload.file_name, upload.id))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[Attached files: {files}]\n")
}
