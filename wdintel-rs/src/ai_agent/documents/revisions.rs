//! Documents and their revisions: agent saves, head moves, request targets
//! and the `document_artifact` events that announce saves in the chat.

use super::types::*;
use super::{store, validate};
use crate::config::{
    AI_AGENT_DOCUMENT_CLEANUP_BATCH, AI_AGENT_DOCUMENT_MAX_PER_CONVERSATION,
    AI_AGENT_DOCUMENT_MAX_REVISIONS, AI_AGENT_DOCUMENT_MAX_SAVES_PER_REQUEST,
    AI_AGENT_DOCUMENT_SUMMARY_MAX_CHARS, AI_AGENT_DOCUMENT_TITLE_MAX_CHARS,
};
use crate::entities::{
    ai_agent_document, ai_agent_document_revision, ai_agent_request,
    ai_agent_request_document_target, ai_agent_request_event,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_web::web::Bytes;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    Statement, TransactionTrait,
};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

type Document = ai_agent_document::Model;
type Revision = ai_agent_document_revision::Model;

fn bl(message: impl Into<String>) -> AppError {
    AppError::BL {
        msg: message.into(),
    }
}

fn millis(value: chrono::NaiveDateTime) -> i64 {
    value.and_utc().timestamp_millis()
}

fn bounded(value: Option<&str>, max_chars: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max_chars).collect())
}

pub(super) fn summary(
    document: &Document,
    head: &Revision,
) -> AiAgentDocumentSummary {
    AiAgentDocumentSummary {
        id: document.id.to_string(),
        conversation_id: document.conversation_id.to_string(),
        title: document.title.clone(),
        file_name: document.file_name.clone(),
        head_revision: document.head_revision,
        size_bytes: head.size_bytes,
        source_upload_id: document.source_upload_id.map(|id| id.to_string()),
        created_at: millis(document.created_at),
        updated_at: millis(document.updated_at),
    }
}

fn artifact(
    document: &Document,
    revision: &Revision,
) -> AiAgentDocumentArtifact {
    AiAgentDocumentArtifact {
        document_id: document.id.to_string(),
        revision: revision.revision,
        title: document.title.clone(),
        file_name: document.file_name.clone(),
        size_bytes: revision.size_bytes,
    }
}

pub(super) async fn revision(
    db: &impl ConnectionTrait,
    document_id: Uuid,
    revision: i32,
) -> Result<Revision, AppError> {
    ai_agent_document_revision::Entity::find_by_id((document_id, revision))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// The conversation's documents with their head revisions, most recently
/// changed first.
pub(super) async fn conversation_documents(
    db: &impl ConnectionTrait,
    conversation_id: Uuid,
) -> Result<Vec<(Document, Revision)>, AppError> {
    let documents = ai_agent_document::Entity::find()
        .filter(ai_agent_document::Column::ConversationId.eq(conversation_id))
        .order_by_desc(ai_agent_document::Column::UpdatedAt)
        .order_by_desc(ai_agent_document::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let mut rows = Vec::with_capacity(documents.len());
    for document in documents {
        let head = revision(db, document.id, document.head_revision)
            .await
            .c(h!())?;
        rows.push((document, head));
    }
    Ok(rows)
}

pub(crate) async fn runner_documents(
    db: &impl ConnectionTrait,
    conversation_id: Uuid,
) -> Result<Vec<AgentDocument>, AppError> {
    Ok(conversation_documents(db, conversation_id)
        .await
        .c(h!())?
        .iter()
        .map(|(document, head)| AgentDocument {
            document_id: document.id.to_string(),
            title: document.title.clone(),
            file_name: document.file_name.clone(),
            head_revision: document.head_revision,
            size_bytes: head.size_bytes,
            updated_at: document.updated_at.and_utc().to_rfc3339(),
            source_upload_id: document
                .source_upload_id
                .map(|id| id.to_string()),
        })
        .collect())
}

pub(super) async fn workspace(
    db: &impl ConnectionTrait,
    document: &Document,
) -> Result<AiAgentDocumentWorkspaceRsp, AppError> {
    let revisions = ai_agent_document_revision::Entity::find()
        .filter(ai_agent_document_revision::Column::DocumentId.eq(document.id))
        .order_by_desc(ai_agent_document_revision::Column::Revision)
        .all(db)
        .await
        .c(h!())?;
    let head = revisions
        .iter()
        .find(|revision| revision.revision == document.head_revision)
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let redo_revision = revisions
        .iter()
        .filter(|revision| revision.parent_revision == Some(head.revision))
        .map(|revision| revision.revision)
        .max();
    Ok(AiAgentDocumentWorkspaceRsp {
        document: summary(document, head),
        undo_revision: head.parent_revision,
        redo_revision,
        revisions: revisions
            .iter()
            .map(|revision| AiAgentDocumentRevisionInfo {
                revision: revision.revision,
                parent_revision: revision.parent_revision,
                origin: revision.origin.clone(),
                summary: revision.summary.clone(),
                request_id: revision.request_id.map(|id| id.to_string()),
                size_bytes: revision.size_bytes,
                created_at: millis(revision.created_at),
            })
            .collect(),
    })
}

fn stale(current_revision: i32) -> AppError {
    AppError::ConflictJson {
        body: serde_json::json!({
            "message": "Документ змінився. Відкрийте його поточну версію і повторіть дію.",
            "currentRevision": current_revision,
        }),
    }
}

async fn lock_document(
    txn: &sea_orm::DatabaseTransaction,
    document_id: Uuid,
) -> Result<Document, AppError> {
    ai_agent_document::Entity::find_by_id(document_id)
        .lock_exclusive()
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Moves the head of a document the human owns.
pub(super) async fn set_head(
    env: &Env,
    document_id: Uuid,
    req: &AiAgentDocumentHeadReq,
) -> Result<AiAgentDocumentWorkspaceRsp, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let document = lock_document(&txn, document_id).await.c(h!())?;
    if document.head_revision != req.expected_revision {
        return Err(stale(document.head_revision));
    }
    revision(&txn, document.id, req.revision).await.c(h!())?;
    let mut active: ai_agent_document::ActiveModel = document.into();
    active.head_revision = Set(req.revision);
    active.updated_at = Set(Utc::now().naive_utc());
    let document = active.update(&txn).await.c(h!())?;
    let response = workspace(&txn, &document).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(response)
}

/// Validated save parameters of one agent output.
struct SaveRequest {
    key: String,
    document_id: Option<Uuid>,
    expected_revision: Option<i32>,
    title: Option<String>,
    file_name: Option<String>,
    summary: Option<String>,
    source_upload_id: Option<Uuid>,
}

fn optional_uuid(value: Option<&str>) -> Result<Option<Uuid>, AppError> {
    value
        .filter(|value| !value.is_empty())
        .map(crate::ai_agent::access::parse_uuid)
        .transpose()
}

fn save_request(
    query: &AgentDocumentSaveQuery,
) -> Result<SaveRequest, AppError> {
    let key = query.idempotency_key.trim();
    if Uuid::parse_str(key).is_err() {
        return Err(bl("idempotencyKey must be a UUID"));
    }
    let document_id = optional_uuid(query.document_id.as_deref()).c(h!())?;
    if document_id.is_some() && query.expected_revision.is_none() {
        return Err(bl("expectedRevision is required to update a document"));
    }
    Ok(SaveRequest {
        key: key.to_string(),
        document_id,
        expected_revision: query.expected_revision,
        title: bounded(
            query.title.as_deref(),
            AI_AGENT_DOCUMENT_TITLE_MAX_CHARS,
        ),
        file_name: bounded(query.file_name.as_deref(), 255),
        summary: bounded(
            query.summary.as_deref(),
            AI_AGENT_DOCUMENT_SUMMARY_MAX_CHARS,
        ),
        source_upload_id: optional_uuid(query.source_upload_id.as_deref())
            .c(h!())?,
    })
}

async fn replayed(
    db: &impl ConnectionTrait,
    request_id: Uuid,
    key: &str,
) -> Result<Option<AgentSavedDocument>, AppError> {
    let stored = ai_agent_document_revision::Entity::find()
        .filter(ai_agent_document_revision::Column::RequestId.eq(request_id))
        .filter(ai_agent_document_revision::Column::IdempotencyKey.eq(key))
        .one(db)
        .await
        .c(h!())?;
    Ok(stored
        .and_then(|revision| revision.result)
        .map(serde_json::from_value)
        .transpose()
        .c(h!())?)
}

async fn ensure_save_budget(
    db: &impl ConnectionTrait,
    request_id: Uuid,
) -> Result<(), AppError> {
    let saves = ai_agent_document_revision::Entity::find()
        .filter(ai_agent_document_revision::Column::RequestId.eq(request_id))
        .count(db)
        .await
        .c(h!())?;
    if saves >= AI_AGENT_DOCUMENT_MAX_SAVES_PER_REQUEST {
        return Err(bl(format!(
            "Один запит може зберегти щонайбільше {AI_AGENT_DOCUMENT_MAX_SAVES_PER_REQUEST} версій документів"
        )));
    }
    Ok(())
}

/// Stores one generated file for the running request: a new document, or a
/// new revision of a document of the same conversation when `documentId` and
/// the expected head revision are given.
pub(super) async fn save_agent_output(
    env: &Env,
    request: &ai_agent_request::Model,
    query: &AgentDocumentSaveQuery,
    bytes: Bytes,
) -> Result<AgentSavedDocument, AppError> {
    let save = save_request(query).c(h!())?;
    if let Some(saved) =
        replayed(&env.dbx, request.id, &save.key).await.c(h!())?
    {
        return Ok(saved);
    }
    validate::validate_docx(&bytes).c(h!())?;
    let destination = destination(&env.dbx, request, &save).await.c(h!())?;
    let stored = StoredFile {
        sha256: sha256::digest(bytes.as_ref()),
        size_bytes: bytes.len() as i64,
        storage_key: store::put(env, bytes, &destination.file_name)
            .await
            .c(h!())?,
    };
    let storage_key = stored.storage_key.clone();
    match record(env, request, &save, destination, stored).await {
        Ok(Recorded::Saved(saved)) => Ok(saved),
        Ok(Recorded::Replayed(saved)) => {
            store::delete(env, &storage_key).await;
            Ok(saved)
        }
        Err(error) => {
            store::delete(env, &storage_key).await;
            Err(error)
        }
    }
}

/// The database part of a save, for a file already in storage.
#[cfg(test)]
pub(super) async fn save_stored(
    env: &Env,
    request: &ai_agent_request::Model,
    query: &AgentDocumentSaveQuery,
    stored: StoredFile,
) -> Result<AgentSavedDocument, AppError> {
    let save = save_request(query).c(h!())?;
    if let Some(saved) =
        replayed(&env.dbx, request.id, &save.key).await.c(h!())?
    {
        return Ok(saved);
    }
    let destination = destination(&env.dbx, request, &save).await.c(h!())?;
    match record(env, request, &save, destination, stored).await? {
        Recorded::Saved(saved) | Recorded::Replayed(saved) => Ok(saved),
    }
}

pub(super) struct StoredFile {
    pub storage_key: String,
    pub sha256: String,
    pub size_bytes: i64,
}

/// An existing document of the request's conversation, or a new one, with
/// the title and file name the saved revision will carry.
struct Destination {
    document_id: Option<Uuid>,
    title: String,
    file_name: String,
}

async fn destination(
    db: &impl ConnectionTrait,
    request: &ai_agent_request::Model,
    save: &SaveRequest,
) -> Result<Destination, AppError> {
    ensure_save_budget(db, request.id).await.c(h!())?;
    let existing = match save.document_id {
        Some(id) => Some(
            ai_agent_document::Entity::find_by_id(id)
                .filter(
                    ai_agent_document::Column::ConversationId
                        .eq(request.conversation_id),
                )
                .one(db)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)?,
        ),
        None => None,
    };
    let title = match (&existing, &save.title) {
        (_, Some(title)) => title.clone(),
        (Some(document), None) => document.title.clone(),
        (None, None) => return Err(bl("title is required for a new document")),
    };
    // A renamed document without a requested file name downloads under its new title.
    let file_name = match (&existing, &save.file_name) {
        (Some(document), None) if document.title == title => {
            document.file_name.clone()
        }
        (_, requested) => validate::file_name(requested.as_deref(), &title),
    };
    Ok(Destination {
        document_id: existing.map(|document| document.id),
        title,
        file_name,
    })
}

async fn advisory_lock(
    txn: &sea_orm::DatabaseTransaction,
    key: String,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtext($1))",
        [key.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

enum Recorded {
    Saved(AgentSavedDocument),
    /// A retry of a save that committed meanwhile; the new file is unused.
    Replayed(AgentSavedDocument),
}

/// Saves of one request are serialized, so a retry racing its first attempt
/// replays that attempt's result instead of saving twice.
async fn record(
    env: &Env,
    request: &ai_agent_request::Model,
    save: &SaveRequest,
    destination: Destination,
    stored: StoredFile,
) -> Result<Recorded, AppError> {
    let source_upload_id =
        match (destination.document_id, save.source_upload_id) {
            (None, Some(id)) => {
                crate::ai_agent::uploads::agent_api::visible_uploads(
                    env, request,
                )
                .await
                .c(h!())?
                .iter()
                .any(|upload| upload.id == id)
                .then_some(id)
            }
            _ => None,
        };
    let txn = env.dbx.begin().await.c(h!())?;
    advisory_lock(&txn, format!("ai_agent_document_save:{}", request.id))
        .await
        .c(h!())?;
    if let Some(saved) = replayed(&txn, request.id, &save.key).await.c(h!())? {
        return Ok(Recorded::Replayed(saved));
    }
    ensure_save_budget(&txn, request.id).await.c(h!())?;
    let saved = match destination.document_id {
        Some(document_id) => append_revision(
            &txn,
            request,
            save,
            document_id,
            destination,
            stored,
        )
        .await
        .c(h!())?,
        None => create_document(
            &txn,
            request,
            save,
            source_upload_id,
            destination,
            stored,
        )
        .await
        .c(h!())?,
    };
    txn.commit().await.c(h!())?;
    Ok(Recorded::Saved(saved))
}

#[allow(clippy::too_many_arguments)]
async fn insert_revision(
    txn: &sea_orm::DatabaseTransaction,
    request: &ai_agent_request::Model,
    save: &SaveRequest,
    document: &Document,
    revision: i32,
    parent_revision: Option<i32>,
    stored: StoredFile,
    created: bool,
) -> Result<AgentSavedDocument, AppError> {
    let saved = AgentSavedDocument {
        document_id: document.id.to_string(),
        revision,
        title: document.title.clone(),
        file_name: document.file_name.clone(),
        size_bytes: stored.size_bytes,
        created,
    };
    ai_agent_document_revision::ActiveModel {
        document_id: Set(document.id),
        revision: Set(revision),
        parent_revision: Set(parent_revision),
        storage_key: Set(stored.storage_key),
        size_bytes: Set(stored.size_bytes),
        sha256: Set(stored.sha256),
        origin: Set("agent".to_string()),
        request_id: Set(Some(request.id)),
        summary: Set(save.summary.clone()),
        idempotency_key: Set(Some(save.key.clone())),
        result: Set(Some(serde_json::to_value(&saved).c(h!())?)),
        created_at: Set(Utc::now().naive_utc()),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(saved)
}

async fn create_document(
    txn: &sea_orm::DatabaseTransaction,
    request: &ai_agent_request::Model,
    save: &SaveRequest,
    source_upload_id: Option<Uuid>,
    destination: Destination,
    stored: StoredFile,
) -> Result<AgentSavedDocument, AppError> {
    advisory_lock(
        txn,
        format!("ai_agent_document:{}", request.conversation_id),
    )
    .await
    .c(h!())?;
    let count = ai_agent_document::Entity::find()
        .filter(
            ai_agent_document::Column::ConversationId
                .eq(request.conversation_id),
        )
        .count(txn)
        .await
        .c(h!())?;
    if count >= AI_AGENT_DOCUMENT_MAX_PER_CONVERSATION {
        return Err(bl(format!(
            "У розмові може бути щонайбільше {AI_AGENT_DOCUMENT_MAX_PER_CONVERSATION} документів"
        )));
    }
    let now = Utc::now().naive_utc();
    let document = ai_agent_document::ActiveModel {
        id: Set(Uuid::now_v7()),
        conversation_id: Set(request.conversation_id),
        human_login_id: Set(request.human_login_id),
        source_request_id: Set(request.id),
        source_upload_id: Set(source_upload_id),
        title: Set(destination.title),
        file_name: Set(destination.file_name),
        head_revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await
    .c(h!())?;
    insert_revision(txn, request, save, &document, 1, None, stored, true).await
}

async fn append_revision(
    txn: &sea_orm::DatabaseTransaction,
    request: &ai_agent_request::Model,
    save: &SaveRequest,
    document_id: Uuid,
    destination: Destination,
    stored: StoredFile,
) -> Result<AgentSavedDocument, AppError> {
    let document = lock_document(txn, document_id).await.c(h!())?;
    if Some(document.head_revision) != save.expected_revision {
        return Err(stale(document.head_revision));
    }
    let latest = ai_agent_document_revision::Entity::find()
        .select_only()
        .column_as(ai_agent_document_revision::Column::Revision.max(), "latest")
        .filter(ai_agent_document_revision::Column::DocumentId.eq(document.id))
        .into_tuple::<Option<i32>>()
        .one(txn)
        .await
        .c(h!())?
        .flatten()
        .unwrap_or(0);
    if latest >= AI_AGENT_DOCUMENT_MAX_REVISIONS {
        return Err(bl(format!(
            "Документ може мати щонайбільше {AI_AGENT_DOCUMENT_MAX_REVISIONS} версій"
        )));
    }
    let parent_revision = document.head_revision;
    let mut active: ai_agent_document::ActiveModel = document.into();
    active.head_revision = Set(latest + 1);
    active.title = Set(destination.title);
    active.file_name = Set(destination.file_name);
    active.updated_at = Set(Utc::now().naive_utc());
    let document = active.update(txn).await.c(h!())?;
    insert_revision(
        txn,
        request,
        save,
        &document,
        latest + 1,
        Some(parent_revision),
        stored,
        false,
    )
    .await
}

/// Validates the document the user had open and records it for the worker.
pub(crate) async fn store_request_target(
    txn: &sea_orm::DatabaseTransaction,
    human_login_id: Uuid,
    conversation_id: Uuid,
    request_id: Uuid,
    target: &AiAgentDocumentTarget,
) -> Result<(), AppError> {
    let document_id =
        crate::ai_agent::access::parse_uuid(&target.document_id).c(h!())?;
    let document = ai_agent_document::Entity::find_by_id(document_id)
        .filter(ai_agent_document::Column::HumanLoginId.eq(human_login_id))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if document.conversation_id != conversation_id {
        return Err(bl("Документ належить іншій розмові."));
    }
    revision(txn, document.id, target.revision).await.c(h!())?;
    ai_agent_request_document_target::ActiveModel {
        request_id: Set(request_id),
        target: Set(serde_json::to_value(target).c(h!())?),
        created_at: Set(Utc::now().naive_utc()),
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn load_request_target(
    db: &impl ConnectionTrait,
    request_id: Uuid,
) -> Result<Option<AiAgentDocumentTarget>, AppError> {
    Ok(
        ai_agent_request_document_target::Entity::find_by_id(request_id)
            .one(db)
            .await
            .c(h!())?
            .map(|row| serde_json::from_value(row.target))
            .transpose()
            .c(h!())?,
    )
}

/// The canonical event payload for a runner's `document_artifact`: only a
/// revision saved by this very request is accepted.
pub(crate) async fn artifact_event_payload(
    db: &impl ConnectionTrait,
    request_id: Uuid,
    payload: &Value,
) -> Result<Value, AppError> {
    let invalid = || bl("Invalid document artifact");
    let document_id = payload
        .get("documentId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(invalid)?;
    let revision_number = payload
        .get("revision")
        .and_then(Value::as_i64)
        .and_then(|revision| i32::try_from(revision).ok())
        .ok_or_else(invalid)?;
    let saved = revision(db, document_id, revision_number)
        .await
        .map_err(|_| invalid())?;
    if saved.request_id != Some(request_id) {
        return Err(invalid());
    }
    let document = ai_agent_document::Entity::find_by_id(document_id)
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(invalid)?;
    Ok(serde_json::json!({ "document": artifact(&document, &saved) }))
}

/// Documents announced by each request, one entry per document with the
/// latest revision that request saved, in order of first save.
pub(crate) async fn load_artifacts(
    db: &impl ConnectionTrait,
    request_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Vec<AiAgentDocumentArtifact>>> {
    let mut artifacts: HashMap<Uuid, Vec<AiAgentDocumentArtifact>> =
        HashMap::new();
    if request_ids.is_empty() {
        return Ok(artifacts);
    }
    let events = ai_agent_request_event::Entity::find()
        .select_only()
        .column(ai_agent_request_event::Column::RequestId)
        .column(ai_agent_request_event::Column::Payload)
        .filter(
            ai_agent_request_event::Column::RequestId
                .is_in(request_ids.iter().copied()),
        )
        .filter(
            ai_agent_request_event::Column::EventType.eq("document_artifact"),
        )
        .order_by_asc(ai_agent_request_event::Column::Sequence)
        .into_tuple::<(Uuid, Value)>()
        .all(db)
        .await
        .c(h!())?;
    for (request_id, payload) in events {
        let Some(artifact) =
            payload.get("document").cloned().and_then(|value| {
                serde_json::from_value::<AiAgentDocumentArtifact>(value).ok()
            })
        else {
            continue;
        };
        let entries = artifacts.entry(request_id).or_default();
        match entries
            .iter_mut()
            .find(|entry| entry.document_id == artifact.document_id)
        {
            Some(entry) if entry.revision < artifact.revision => {
                *entry = artifact
            }
            Some(_) => {}
            None => entries.push(artifact),
        }
    }
    Ok(artifacts)
}

/// Deletes documents of deleted conversations and their stored files.
pub(crate) async fn cleanup(env: &Env) -> anyhow::Result<()> {
    let rows = env
        .dbx
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with doomed as (
  select document.id from ai_agent_document document
  join ai_agent_conversation conversation on conversation.id = document.conversation_id
  where conversation.deleted_at is not null
  order by document.created_at
  limit $1
  for update of document skip locked
), stored as (
  select revision.storage_key from ai_agent_document_revision revision
  where revision.document_id in (select id from doomed)
), removed as (
  delete from ai_agent_document where id in (select id from doomed)
)
select storage_key from stored
            "#,
            [AI_AGENT_DOCUMENT_CLEANUP_BATCH.into()],
        ))
        .await
        .c(h!())?;
    for row in rows {
        let key: String = row.try_get("", "storage_key").c(h!())?;
        store::delete(env, &key).await;
    }
    Ok(())
}
