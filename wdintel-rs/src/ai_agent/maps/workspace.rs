use super::edit::{
    apply_patch, assign_stable_ids, capped_changes, diff_documents, recount,
    valid_idempotency_key, EditFailure, PatchOutcome,
};
use super::types::*;
use crate::ai_agent::auth::AgentSessionBinding;
use crate::config::AI_AGENT_MAP_EDIT_CHANGE_LIMIT;
use crate::config::AI_AGENT_MAP_EDIT_MAX_OPERATIONS;
use crate::config::AI_AGENT_MAP_MAX_RECORDS;
use crate::config::AI_AGENT_MAP_REVISION_LIST_LIMIT;
use crate::config::AI_AGENT_SESSION_BINDING_KEY;
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_session::SessionExt;
use actix_web::web::{Data, Json};
use actix_web::{post, HttpRequest};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseTransaction, Statement,
    TransactionTrait,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

const INITIAL_REVISION_SUMMARY: &str = "Опублікована мапа";

struct MapRow {
    id: Uuid,
    head_revision: i32,
}

/// Who produced a revision: the agent (inside its request) or the human.
struct Author {
    origin: &'static str,
    request_id: Option<Uuid>,
}

fn bl(message: impl Into<String>) -> AppError {
    AppError::BL {
        msg: message.into(),
    }
}

fn failure(error: EditFailure) -> AppError {
    match error {
        EditFailure::Clarify(message) | EditFailure::Reject(message) => {
            bl(message)
        }
    }
}

fn stale(map: &MapRow) -> AppError {
    AppError::ConflictJson {
        body: serde_json::json!({
            "message": "Мапа змінилася. Оновіть перегляд і повторіть дію.",
            "revision": map.head_revision,
        }),
    }
}

fn statement(sql: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values)
}

fn json_text(value: &impl Serialize) -> Result<String, AppError> {
    Ok(serde_json::to_string(value).c(h!())?)
}

fn parsed_json<T: DeserializeOwned>(value: Value) -> Result<T, AppError> {
    Ok(serde_json::from_value(value).c(h!())?)
}

fn column<T: sea_orm::TryGetable>(
    row: &sea_orm::QueryResult,
    name: &str,
) -> Result<T, AppError> {
    Ok(row.try_get("", name).c(h!())?)
}

fn require_key(key: &str) -> Result<(), AppError> {
    if valid_idempotency_key(key) {
        Ok(())
    } else {
        Err(bl(
            "Ключ ідемпотентності має містити від 8 до 128 символів: літери, цифри, _ або -.",
        ))
    }
}

fn map_ids(request_id: &str, map_id: &str) -> Result<(Uuid, Uuid), AppError> {
    Ok((
        super::super::access::parse_uuid(request_id)?,
        super::super::access::parse_uuid(map_id)?,
    ))
}

fn same_map(document_id: &str, map_id: Uuid) -> bool {
    Uuid::parse_str(document_id).ok() == Some(map_id)
}

pub(super) fn validate_edit_target(
    target: &AiAgentMapEditTarget,
) -> Result<(), AppError> {
    let _ = map_ids(&target.request_id, &target.map_id)?;
    if target.revision <= 0 {
        return Err(bl("Номер ревізії має бути додатним."));
    }
    if target.selected_point_ids.len() > AI_AGENT_MAP_MAX_RECORDS {
        return Err(bl(format!(
            "Можна вибрати щонайбільше {AI_AGENT_MAP_MAX_RECORDS} точок."
        )));
    }
    let mut seen = HashSet::new();
    for id in &target.selected_point_ids {
        super::super::access::parse_uuid(id)?;
        if !seen.insert(id.as_str()) {
            return Err(bl("Вибрані точки повторюються."));
        }
    }
    Ok(())
}

fn initial_document(artifact: &AiAgentMapDocument) -> AiAgentMapDocument {
    let mut document = artifact.clone();
    let map_id = document.id.clone();
    assign_stable_ids(&map_id, &mut document);
    recount(&mut document);
    document
}

async fn artifact_document(
    db: &impl ConnectionTrait,
    request_id: Uuid,
    map_id: Uuid,
) -> Result<AiAgentMapDocument, AppError> {
    super::load_documents(db, &[request_id])
        .await
        .c(h!())?
        .remove(&request_id)
        .unwrap_or_default()
        .into_iter()
        .find(|document| same_map(&document.id, map_id))
        .ok_or(AppError::NotFound)
}

async fn find_map(
    db: &impl ConnectionTrait,
    owner_id: Uuid,
    request_id: Uuid,
    map_id: Uuid,
    lock: bool,
) -> Result<Option<MapRow>, AppError> {
    let sql = format!(
        r#"
select id, head_revision
from ai_agent_map
where human_login_id = $1
  and source_request_id = $2
  and source_map_id = $3
{}
        "#,
        if lock { "for update" } else { "" }
    );
    let row = db
        .query_one_raw(statement(
            &sql,
            vec![owner_id.into(), request_id.into(), map_id.into()],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(MapRow {
        id: column(&row, "id")?,
        head_revision: column(&row, "head_revision")?,
    }))
}

async fn require_live_source(
    env: &Env,
    owner_id: Uuid,
    request_id: Uuid,
) -> Result<Uuid, AppError> {
    let request = super::super::owned_request(&env.dbx, owner_id, request_id)
        .await
        .c(h!())?;
    super::super::owned_conversation(
        &env.dbx,
        owner_id,
        request.conversation_id,
    )
    .await
    .c(h!())?;
    Ok(request.conversation_id)
}

/// Creates the editable map with its published artifact as revision 1, or
/// locks the existing one.
async fn ensure_map(
    txn: &DatabaseTransaction,
    env: &Env,
    owner_id: Uuid,
    request_id: Uuid,
    map_id: Uuid,
) -> Result<MapRow, AppError> {
    let conversation_id = require_live_source(env, owner_id, request_id)
        .await
        .c(h!())?;
    if let Some(map) = find_map(txn, owner_id, request_id, map_id, true)
        .await
        .c(h!())?
    {
        return Ok(map);
    }
    let artifact = artifact_document(txn, request_id, map_id).await.c(h!())?;
    let inserted = txn
        .query_one_raw(statement(
            r#"
insert into ai_agent_map (
    id, conversation_id, human_login_id, source_request_id, source_map_id,
    head_revision, created_at, updated_at
) values (
    $1, $2, $3, $4, $5, 1, now() at time zone 'utc', now() at time zone 'utc'
)
on conflict (human_login_id, source_request_id, source_map_id) do nothing
returning id
            "#,
            vec![
                Uuid::now_v7().into(),
                conversation_id.into(),
                owner_id.into(),
                request_id.into(),
                map_id.into(),
            ],
        ))
        .await
        .c(h!())?;
    if let Some(row) = inserted {
        let id: Uuid = column(&row, "id")?;
        let revision = NewRevision {
            revision: 1,
            parent_revision: None,
            document: &initial_document(&artifact),
            author: &Author {
                origin: "artifact",
                request_id: Some(request_id),
            },
            summary: INITIAL_REVISION_SUMMARY,
            idempotency_key: None,
            result: None,
        };
        insert_revision(txn, id, &revision).await.c(h!())?;
    }
    find_map(txn, owner_id, request_id, map_id, true)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

struct NewRevision<'a> {
    revision: i32,
    parent_revision: Option<i32>,
    document: &'a AiAgentMapDocument,
    author: &'a Author,
    summary: &'a str,
    idempotency_key: Option<&'a str>,
    result: Option<&'a AiAgentMapEditRsp>,
}

async fn insert_revision(
    txn: &DatabaseTransaction,
    map_id: Uuid,
    revision: &NewRevision<'_>,
) -> Result<(), AppError> {
    let result = match revision.result {
        Some(result) => Some(json_text(result)?),
        None => None,
    };
    txn.execute_raw(statement(
        r#"
insert into ai_agent_map_revision (
    map_id, revision, parent_revision, document, origin, request_id,
    summary, idempotency_key, result, created_at
) values (
    $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb,
    now() at time zone 'utc'
)
        "#,
        vec![
            map_id.into(),
            revision.revision.into(),
            revision.parent_revision.into(),
            json_text(revision.document)?.into(),
            revision.author.origin.into(),
            revision.author.request_id.into(),
            revision.summary.into(),
            revision.idempotency_key.map(str::to_string).into(),
            result.into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn set_head(
    txn: &DatabaseTransaction,
    map_id: Uuid,
    revision: i32,
) -> Result<(), AppError> {
    txn.execute_raw(statement(
        r#"
update ai_agent_map
set head_revision = $2, updated_at = now() at time zone 'utc'
where id = $1
        "#,
        vec![map_id.into(), revision.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_document(
    db: &impl ConnectionTrait,
    map_id: Uuid,
    revision: i32,
) -> Result<AiAgentMapDocument, AppError> {
    let row = db
        .query_one_raw(statement(
            r#"
select document
from ai_agent_map_revision
where map_id = $1 and revision = $2
            "#,
            vec![map_id.into(), revision.into()],
        ))
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    parsed_json(column(&row, "document")?)
}

async fn parent_of(
    db: &impl ConnectionTrait,
    map_id: Uuid,
    revision: i32,
) -> Result<Option<i32>, AppError> {
    let row = db
        .query_one_raw(statement(
            r#"
select parent_revision
from ai_agent_map_revision
where map_id = $1 and revision = $2
            "#,
            vec![map_id.into(), revision.into()],
        ))
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    column(&row, "parent_revision")
}

/// Redo follows the most recent revision created on top of `revision`.
async fn newest_child(
    db: &impl ConnectionTrait,
    map_id: Uuid,
    revision: i32,
) -> Result<Option<i32>, AppError> {
    let row = db
        .query_one_raw(statement(
            r#"
select max(revision)::int4 as revision
from ai_agent_map_revision
where map_id = $1 and parent_revision = $2
            "#,
            vec![map_id.into(), revision.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    column(&row, "revision")
}

async fn next_revision(
    txn: &DatabaseTransaction,
    map_id: Uuid,
) -> Result<i32, AppError> {
    let row = txn
        .query_one_raw(statement(
            r#"
select coalesce(max(revision), 0)::int4 + 1 as revision
from ai_agent_map_revision
where map_id = $1
            "#,
            vec![map_id.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    column(&row, "revision")
}

async fn list_revisions(
    db: &impl ConnectionTrait,
    map_id: Uuid,
) -> Result<Vec<AiAgentMapRevisionInfo>, AppError> {
    let rows = db
        .query_all_raw(statement(
            r#"
select revision, parent_revision, origin, summary,
       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at
from ai_agent_map_revision
where map_id = $1
order by revision desc
limit $2
            "#,
            vec![
                map_id.into(),
                (AI_AGENT_MAP_REVISION_LIST_LIMIT as i64).into(),
            ],
        ))
        .await
        .c(h!())?;
    rows.iter()
        .map(|row| {
            Ok(AiAgentMapRevisionInfo {
                revision: column(row, "revision")?,
                parent_revision: column(row, "parent_revision")?,
                origin: column(row, "origin")?,
                summary: column(row, "summary")?,
                created_at: column(row, "created_at")?,
            })
        })
        .collect()
}

async fn stored_result(
    txn: &DatabaseTransaction,
    map_id: Uuid,
    key: &str,
) -> Result<Option<AiAgentMapEditRsp>, AppError> {
    let row = txn
        .query_one_raw(statement(
            r#"
select result
from ai_agent_map_revision
where map_id = $1 and idempotency_key = $2
            "#,
            vec![map_id.into(), key.into()],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    let result: Option<Value> = column(&row, "result")?;
    result.map(parsed_json).transpose()
}

async fn history_flags(
    db: &impl ConnectionTrait,
    map: &MapRow,
) -> Result<(bool, bool), AppError> {
    let parent = parent_of(db, map.id, map.head_revision).await.c(h!())?;
    let child = newest_child(db, map.id, map.head_revision).await.c(h!())?;
    Ok((parent.is_some(), child.is_some()))
}

async fn workspace_response(
    env: &Env,
    owner_id: Uuid,
    db: &impl ConnectionTrait,
    map: &MapRow,
) -> Result<AiAgentMapWorkspaceRsp, AppError> {
    let document =
        load_document(db, map.id, map.head_revision).await.c(h!())?;
    super::check_sources(env, owner_id, &document)
        .await
        .c(h!())?;
    let changes =
        match parent_of(db, map.id, map.head_revision).await.c(h!())? {
            Some(parent) => {
                let before = load_document(db, map.id, parent).await.c(h!())?;
                diff_documents(&before, &document)
            }
            None => AiAgentMapEditDiff::default(),
        };
    let (can_undo, can_redo) = history_flags(db, map).await.c(h!())?;
    Ok(AiAgentMapWorkspaceRsp {
        revision: map.head_revision,
        can_undo,
        can_redo,
        document,
        changes,
        revisions: list_revisions(db, map.id).await.c(h!())?,
    })
}

fn edit_response(
    revision: i32,
    outcome: &PatchOutcome,
    flags: (bool, bool),
) -> AiAgentMapEditRsp {
    let (changes, truncated) =
        capped_changes(&outcome.diff, AI_AGENT_MAP_EDIT_CHANGE_LIMIT);
    AiAgentMapEditRsp {
        revision,
        matched_ids: outcome.matched_ids.clone(),
        added_count: outcome.diff.added_count,
        updated_count: outcome.diff.updated_count,
        removed_count: outcome.diff.removed_count,
        total_count: outcome.document.total_count,
        truncated,
        changes,
        can_undo: flags.0,
        can_redo: flags.1,
    }
}

/// A short human-readable description of a revision, used in the timeline.
fn default_summary(
    before: &AiAgentMapDocument,
    outcome: &PatchOutcome,
) -> String {
    let diff = &outcome.diff;
    let mut parts = Vec::new();
    if before.title != outcome.document.title {
        parts.push(format!("назва «{}»", outcome.document.title));
    }
    if diff.added_count > 0 {
        parts.push(format!("додано {}", diff.added_count));
    }
    if diff.updated_count > 0 {
        parts.push(format!("змінено {}", diff.updated_count));
    }
    if diff.removed_count > 0 {
        parts.push(format!("видалено {}", diff.removed_count));
    }
    if parts.is_empty() {
        "Без змін".to_string()
    } else {
        parts.join(", ")
    }
}

fn revision_summary(
    requested: Option<&str>,
    before: &AiAgentMapDocument,
    outcome: &PatchOutcome,
) -> String {
    match requested
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
        Some(summary) => summary.chars().take(200).collect(),
        None => default_summary(before, outcome),
    }
}

/// Resolves which saved document a get/export reads: a named revision, the
/// head of an existing editable map, or the published artifact. Reading never
/// creates the editable map.
pub(super) async fn document_for_view(
    env: &Env,
    owner_id: Uuid,
    req: &AiAgentMapGetReq,
) -> Result<AiAgentMapDocument, AppError> {
    if req.revision.is_some_and(|revision| revision <= 0) {
        return Err(bl("Номер ревізії має бути додатним."));
    }
    let (request_id, map_id) = map_ids(&req.request_id, &req.map_id)?;
    require_live_source(env, owner_id, request_id)
        .await
        .c(h!())?;
    let map = find_map(&env.dbx, owner_id, request_id, map_id, false)
        .await
        .c(h!())?;
    let document = match (map, req.revision) {
        (Some(map), revision) => load_document(
            &env.dbx,
            map.id,
            revision.unwrap_or(map.head_revision),
        )
        .await
        .c(h!())?,
        (None, None | Some(1)) => {
            return super::document_for_owner(env, owner_id, req).await
        }
        (None, Some(_)) => return Err(AppError::NotFound),
    };
    super::check_sources(env, owner_id, &document)
        .await
        .c(h!())?;
    Ok(document)
}

pub(crate) async fn store_request_target(
    txn: &DatabaseTransaction,
    human_login_id: Uuid,
    conversation_id: Uuid,
    request_id: Uuid,
    target: &AiAgentMapEditTarget,
) -> Result<(), AppError> {
    validate_edit_target(target)?;
    let (source_request_id, map_id) =
        map_ids(&target.request_id, &target.map_id)?;
    if source_request_id == request_id {
        return Err(bl("Запит не може редагувати власну мапу."));
    }
    let row = txn
        .query_one_raw(statement(
            r#"
select conversation_id
from ai_agent_request
where id = $1 and human_login_id = $2
            "#,
            vec![source_request_id.into(), human_login_id.into()],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Err(AppError::NotFound);
    };
    let source_conversation: Uuid = column(&row, "conversation_id")?;
    if source_conversation != conversation_id {
        return Err(bl("Мапа належить іншій розмові."));
    }
    artifact_document(txn, source_request_id, map_id)
        .await
        .c(h!())?;
    txn.execute_raw(statement(
        r#"
insert into ai_agent_request_map_target (request_id, target, created_at)
values ($1, $2::jsonb, now() at time zone 'utc')
        "#,
        vec![request_id.into(), json_text(target)?.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn load_request_target(
    db: &impl ConnectionTrait,
    request_id: Uuid,
) -> Result<Option<AiAgentMapEditTarget>, AppError> {
    let row = db
        .query_one_raw(statement(
            r#"
select target
from ai_agent_request_map_target
where request_id = $1
            "#,
            vec![request_id.into()],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    parsed_json(column(&row, "target")?).map(Some)
}

/// Runner sessions may only edit the map their request declared as target;
/// humans edit any map they own.
async fn edit_author(
    http: &HttpRequest,
    env: &Env,
    source_request_id: &str,
    map_id: &str,
) -> Result<Author, AppError> {
    let binding = http
        .get_session()
        .get::<AgentSessionBinding>(AI_AGENT_SESSION_BINDING_KEY)
        .c(h!())?;
    let Some(binding) = binding else {
        return Ok(Author {
            origin: "user",
            request_id: None,
        });
    };
    let forbidden = || {
        AppError::Forbidden("Запит не має цілі редагування мапи.".to_string())
    };
    let agent_request_id = binding.request_id.ok_or_else(forbidden)?;
    let target = load_request_target(&env.dbx, agent_request_id)
        .await
        .c(h!())?
        .ok_or_else(forbidden)?;
    let expected = map_ids(&target.request_id, &target.map_id)?;
    if expected != map_ids(source_request_id, map_id)? {
        return Err(AppError::Forbidden(
            "Запит редагує іншу мапу.".to_string(),
        ));
    }
    Ok(Author {
        origin: "agent",
        request_id: Some(agent_request_id),
    })
}

#[post("/api/ai-agent/maps/workspace")]
pub async fn open_workspace(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapWorkspaceReq>,
) -> Result<Json<AiAgentMapWorkspaceRsp>, AppError> {
    let owner_id = super::owner_id(&env, &user).await.c(h!())?;
    let (request_id, map_id) = map_ids(&req.request_id, &req.map_id)?;
    let txn = env.dbx.begin().await.c(h!())?;
    let map = ensure_map(&txn, &env, owner_id, request_id, map_id)
        .await
        .c(h!())?;
    let response = workspace_response(&env, owner_id, &txn, &map)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(response))
}

fn validate_operations(req: &AiAgentMapEditReq) -> Result<(), AppError> {
    if req.operations.is_empty() {
        return Err(bl("Потрібна хоча б одна зміна"));
    }
    if req.operations.len() > AI_AGENT_MAP_EDIT_MAX_OPERATIONS {
        return Err(bl(format!(
            "За один запит можна виконати щонайбільше {AI_AGENT_MAP_EDIT_MAX_OPERATIONS} операцій"
        )));
    }
    require_key(&req.idempotency_key)
}

#[post("/api/ai-agent/maps/edit")]
pub async fn edit_map(
    http: HttpRequest,
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapEditReq>,
) -> Result<Json<AiAgentMapEditRsp>, AppError> {
    let owner_id = super::owner_id(&env, &user).await.c(h!())?;
    validate_operations(&req)?;
    let author = edit_author(&http, &env, &req.request_id, &req.map_id)
        .await
        .c(h!())?;
    let (request_id, map_id) = map_ids(&req.request_id, &req.map_id)?;
    let txn = env.dbx.begin().await.c(h!())?;
    let map = ensure_map(&txn, &env, owner_id, request_id, map_id)
        .await
        .c(h!())?;
    if let Some(stored) = stored_result(&txn, map.id, &req.idempotency_key)
        .await
        .c(h!())?
    {
        txn.commit().await.c(h!())?;
        return Ok(Json(stored));
    }
    if map.head_revision != req.expected_revision {
        return Err(stale(&map));
    }
    let before = load_document(&txn, map.id, map.head_revision)
        .await
        .c(h!())?;
    let outcome = apply_patch(&before, &req.operations).map_err(failure)?;
    super::check_sources(&env, owner_id, &outcome.document)
        .await
        .c(h!())?;
    if outcome.document == before {
        let flags = history_flags(&txn, &map).await.c(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(Json(edit_response(map.head_revision, &outcome, flags)));
    }
    let revision = next_revision(&txn, map.id).await.c(h!())?;
    let response = edit_response(revision, &outcome, (true, false));
    let summary = revision_summary(req.summary.as_deref(), &before, &outcome);
    let new_revision = NewRevision {
        revision,
        parent_revision: Some(map.head_revision),
        document: &outcome.document,
        author: &author,
        summary: &summary,
        idempotency_key: Some(&req.idempotency_key),
        result: Some(&response),
    };
    insert_revision(&txn, map.id, &new_revision).await.c(h!())?;
    set_head(&txn, map.id, revision).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(response))
}

#[post("/api/ai-agent/maps/undo")]
pub async fn undo_map(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapRevisionReq>,
) -> Result<Json<AiAgentMapWorkspaceRsp>, AppError> {
    Ok(Json(move_head(&env, &user, &req, false).await.c(h!())?))
}

#[post("/api/ai-agent/maps/redo")]
pub async fn redo_map(
    user: Identity,
    env: Data<Env>,
    req: Json<AiAgentMapRevisionReq>,
) -> Result<Json<AiAgentMapWorkspaceRsp>, AppError> {
    Ok(Json(move_head(&env, &user, &req, true).await.c(h!())?))
}

async fn move_head(
    env: &Env,
    user: &Identity,
    req: &AiAgentMapRevisionReq,
    forward: bool,
) -> Result<AiAgentMapWorkspaceRsp, AppError> {
    let owner_id = super::owner_id(env, user).await.c(h!())?;
    let (request_id, map_id) = map_ids(&req.request_id, &req.map_id)?;
    require_live_source(env, owner_id, request_id)
        .await
        .c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let mut map = find_map(&txn, owner_id, request_id, map_id, true)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    if map.head_revision != req.expected_revision {
        return Err(stale(&map));
    }
    let target = if forward {
        newest_child(&txn, map.id, map.head_revision)
            .await
            .c(h!())?
            .ok_or_else(|| bl("Немає скасованої зміни для повтору."))?
    } else {
        parent_of(&txn, map.id, map.head_revision)
            .await
            .c(h!())?
            .ok_or_else(|| bl("Немає змін для скасування."))?
    };
    set_head(&txn, map.id, target).await.c(h!())?;
    map.head_revision = target;
    let response = workspace_response(env, owner_id, &txn, &map)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_agent::maps::edit::apply_patch;

    fn document(title: &str) -> AiAgentMapDocument {
        AiAgentMapDocument {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            title: title.to_string(),
            is_main: true,
            records: Vec::new(),
            warnings: Vec::new(),
            total_count: 0,
            valid_count: 0,
            invalid_count: 0,
        }
    }

    #[test]
    fn summaries_prefer_the_requested_text_and_describe_title_changes() {
        let before = document("Стара");
        let op = AiAgentMapPatchOp {
            op: "setTitle".to_string(),
            selector: None,
            record: None,
            fields: None,
            components: None,
            sidc: None,
            title: Some("Нова".to_string()),
        };
        let outcome = apply_patch(&before, &[op]).unwrap();
        assert_eq!(revision_summary(None, &before, &outcome), "назва «Нова»");
        assert_eq!(
            revision_summary(Some("  Перейменовано "), &before, &outcome),
            "Перейменовано"
        );
    }
}
