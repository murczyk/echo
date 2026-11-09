use super::auth::AgentSessionBinding;
use super::types::AiAgentMessageCitation;
use crate::attachments::store::{execute, rows};
use crate::config::*;
use crate::devices::documents::types::AiAgentFileCitation;
use crate::entities::{ai_agent_conversation, ai_agent_request};
use crate::{
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_session::SessionExt;
use actix_web::{
    post,
    web::{Data, Json},
    HttpRequest,
};
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, QuerySelect, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkRecord {
    pub version: u32,
    pub sequence: i64,
    pub kind: String,
    pub tool: Option<String>,
    #[serde(default)]
    pub query: Value,
    pub content: String,
    #[serde(default)]
    pub citations: Vec<AiAgentMessageCitation>,
    #[serde(default)]
    pub file_citations: Vec<AiAgentFileCitation>,
    pub covers_through: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListWork {
    pub before_request_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadWork {
    pub request_id: Uuid,
    #[serde(default)]
    pub after: i64,
    #[serde(default)]
    pub offset: usize,
}

#[derive(sea_orm::FromQueryResult)]
struct StoredRecord {
    sequence: i64,
    payload: Value,
    access_scope: String,
}

#[derive(Serialize, sea_orm::FromQueryResult)]
#[serde(rename_all = "camelCase")]
struct WorkSummary {
    request_id: Uuid,
    prompt: String,
    state: String,
    queued_at: chrono::NaiveDateTime,
    records: i64,
}

fn enabled(env: &Env) -> anyhow::Result<()> {
    anyhow::ensure!(
        env.config.ai_agent_work_memory_enabled == Some(true),
        "Work memory is disabled"
    );
    Ok(())
}

async fn current_request(
    env: &Env,
    http: &HttpRequest,
) -> anyhow::Result<ai_agent_request::Model> {
    enabled(env).c(h!())?;
    running_request(env, http).await.c(h!())
}

/// The running request bound to the calling agent session.
pub(crate) async fn running_request(
    env: &Env,
    http: &HttpRequest,
) -> anyhow::Result<ai_agent_request::Model> {
    let binding = http
        .get_session()
        .get::<AgentSessionBinding>(AI_AGENT_SESSION_BINDING_KEY)
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
        .c(h!())?;
    let id = binding
        .request_id
        .ok_or(AppError::Unauthenticated)
        .c(h!())?;
    ai_agent_request::Entity::find_by_id(id)
        .filter(ai_agent_request::Column::State.eq("running"))
        .filter(ai_agent_request::Column::CancellationRequested.eq(false))
        .filter(ai_agent_request::Column::AgentLoginId.eq(binding.login_id))
        .filter(
            ai_agent_request::Column::CorrelationId.eq(binding.correlation_id),
        )
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::Unauthenticated)
        .c(h!())
}

async fn access_scope(env: &Env, human: Uuid) -> anyhow::Result<String> {
    let login = crate::users::load_active_login(&env.dbx, &human)
        .await
        .c(h!())?;
    let mut groups = if login.organism_id.is_some()
        && login.sigint_zone_id.is_some()
    {
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &human)
            .await
            .c(h!())?
    } else {
        Vec::new()
    };
    groups.sort();
    let mut devices =
        match crate::devices::documents::access::reader(env, human).await {
            Ok(login) => crate::devices::documents::access::visible_ids(
                env, &login, true,
            )
            .await
            .c(h!())?,
            Err(AppError::Forbidden(_) | AppError::Unauthenticated) => {
                Vec::new()
            }
            Err(error) => return Err(error).c(h!()),
        };
    devices.sort();
    Ok(sha256::digest(
        json!({"human":human,"roles":login.roles,"organism":login.organism_id,
        "zone":login.sigint_zone_id,"groups":groups,"devices":devices})
        .to_string(),
    ))
}

fn validated_payload(record: &WorkRecord) -> anyhow::Result<(Value, i32)> {
    anyhow::ensure!(
        record.version == 1
            && record.sequence > 0
            && record.sequence <= AI_AGENT_WORK_MAX_RECORDS,
        "Invalid work record version or sequence"
    );
    anyhow::ensure!(!record.content.trim().is_empty(), "Work record is empty");
    match record.kind.as_str() {
        "tool" => {
            anyhow::ensure!(
                record.covers_through.is_none(),
                "Tool record cannot cover other records"
            );
            let tool = record.tool.as_deref().unwrap_or_default();
            anyhow::ensure!(
                super::route_registry::ROUTES
                    .iter()
                    .any(|route| tool == format!("echo_{}", route.skill)),
                "Unknown work record tool"
            );
        }
        "checkpoint" => anyhow::ensure!(
            record.tool.is_none()
                && record.covers_through == Some(record.sequence - 1),
            "Invalid checkpoint coverage"
        ),
        _ => anyhow::bail!("Invalid work record kind"),
    }
    anyhow::ensure!(
        super::citations::parse(&json!({"citations":record.citations}))
            .is_some(),
        "Invalid work citations"
    );
    for chunk in record.file_citations.chunks(100) {
        anyhow::ensure!(
            super::file_citations::parse(&json!({"citations":chunk})).is_some(),
            "Invalid work file citations"
        );
    }
    let payload = serde_json::to_value(record).c(h!())?;
    let size = serde_json::to_vec(&payload).c(h!())?.len();
    anyhow::ensure!(
        size <= AI_AGENT_WORK_RECORD_MAX_BYTES,
        "Work record exceeds storage limit"
    );
    Ok((payload, size as i32))
}

pub(super) async fn append_record(
    env: &Env,
    request: &ai_agent_request::Model,
    record: &WorkRecord,
) -> anyhow::Result<()> {
    let (payload, size) = validated_payload(record).c(h!())?;
    let scope = access_scope(env, request.human_login_id).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let active = ai_agent_request::Entity::find_by_id(request.id)
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    anyhow::ensure!(
        active.state == "running"
            && !active.cancellation_requested
            && active.correlation_id == request.correlation_id,
        "Work request is no longer active"
    );
    let existing = rows::<StoredRecord,_>(&txn,
        "select sequence,payload,access_scope from ai_agent_work_record where request_id=$1 and sequence=$2",
        vec![request.id.into(),record.sequence.into()]).await.c(h!())?;
    if let Some(existing) = existing.first() {
        anyhow::ensure!(
            existing.payload == payload,
            "Work sequence already has different content"
        );
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    #[derive(sea_orm::FromQueryResult)]
    struct Totals {
        last: i64,
        bytes: i64,
    }
    let totals = rows::<Totals,_>(&txn,
        "select coalesce(max(sequence),0) as last,coalesce(sum(payload_bytes),0)::bigint as bytes from ai_agent_work_record where request_id=$1",
        vec![request.id.into()]).await.c(h!())?;
    let totals = totals.first().c(h!())?;
    anyhow::ensure!(
        record.sequence == totals.last + 1,
        "Work sequence is not contiguous"
    );
    anyhow::ensure!(
        totals.bytes + i64::from(size) <= AI_AGENT_WORK_REQUEST_MAX_BYTES,
        "Work request exceeds storage limit"
    );
    execute(&txn, "insert into ai_agent_work_record(request_id,sequence,kind,payload,payload_bytes,access_scope) values($1,$2,$3,$4,$5,$6)",
        vec![request.id.into(),record.sequence.into(),record.kind.clone().into(),payload.into(),size.into(),scope.into()]).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

#[post("/api/ai-agent/work/append")]
pub async fn append(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<WorkRecord>,
) -> Result<Json<Value>, AppError> {
    let request = current_request(&env, &http).await.c(h!())?;
    append_record(&env, &request, &req).await.c(h!())?;
    Ok(Json(json!({"sequence":req.sequence})))
}

async fn prior_request(
    env: &Env,
    current: &ai_agent_request::Model,
    id: Uuid,
) -> anyhow::Result<ai_agent_request::Model> {
    let prior = ai_agent_request::Entity::find_by_id(id)
        .filter(
            ai_agent_request::Column::ConversationId
                .eq(current.conversation_id),
        )
        .filter(
            ai_agent_request::Column::HumanLoginId.eq(current.human_login_id),
        )
        .filter(ai_agent_request::Column::State.is_in([
            "completed",
            "failed",
            "cancelled",
        ]))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    anyhow::ensure!(
        (prior.queued_at, prior.id) < (current.queued_at, current.id),
        "Work request is not earlier in this conversation"
    );
    let visible =
        ai_agent_conversation::Entity::find_by_id(current.conversation_id)
            .filter(ai_agent_conversation::Column::DeletedAt.is_null())
            .one(&env.dbx)
            .await
            .c(h!())?
            .is_some();
    anyhow::ensure!(visible, "Conversation is unavailable");
    Ok(prior)
}

async fn summaries(
    env: &Env,
    current: &ai_agent_request::Model,
    before: Option<Uuid>,
) -> anyhow::Result<Vec<WorkSummary>> {
    let boundary = match before {
        Some(id) => prior_request(env, current, id).await.c(h!())?,
        None => current.clone(),
    };
    rows(&env.dbx, r#"
select r.id as request_id,left(r.prompt,$6) as prompt,r.state,r.queued_at,
       (select count(*) from ai_agent_work_record w where w.request_id=r.id) as records
from ai_agent_request r join ai_agent_conversation c on c.id=r.conversation_id
where r.conversation_id=$1 and r.human_login_id=$2 and c.deleted_at is null
  and (r.queued_at,r.id)<($3,$4) and r.state in ('completed','failed','cancelled')
  and exists(select 1 from ai_agent_work_record w where w.request_id=r.id)
order by r.queued_at desc,r.id desc limit $5
"#, vec![current.conversation_id.into(),current.human_login_id.into(),boundary.queued_at.into(),boundary.id.into(),AI_AGENT_WORK_LIST_REQUESTS.into(),(AI_AGENT_WORK_PROMPT_CHARS as i32).into()]).await.c(h!())
}

#[post("/api/ai-agent/work/list")]
pub async fn list(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<ListWork>,
) -> Result<Json<Value>, AppError> {
    let current = current_request(&env, &http).await.c(h!())?;
    let items = summaries(&env, &current, req.before_request_id)
        .await
        .c(h!())?;
    let next = (items.len() == AI_AGENT_WORK_LIST_REQUESTS as usize)
        .then(|| items.last().map(|item| item.request_id))
        .flatten();
    Ok(Json(json!({"items":items,"nextBeforeRequestId":next})))
}

async fn sources_readable(
    env: &Env,
    human: Uuid,
    records: &[WorkRecord],
) -> anyhow::Result<bool> {
    if records.iter().any(|record| {
        record.kind == "tool"
            && record.citations.is_empty()
            && record.file_citations.is_empty()
            && record.tool.as_deref() != Some("echo_current_user")
    }) {
        return Ok(false);
    }
    let ids: std::collections::HashSet<_> = records
        .iter()
        .flat_map(|record| &record.citations)
        .map(|source| source.message_id)
        .collect();
    let readable = super::citations::readable_message_ids(
        &env.dbx,
        human,
        &ids.iter().copied().collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    if readable.len() != ids.len() {
        return Ok(false);
    }
    let files = records
        .iter()
        .flat_map(|record| record.file_citations.clone())
        .collect::<Vec<_>>();
    super::file_citations::readable(env, human, &files)
        .await
        .c(h!())
}

async fn readable_record(
    env: &Env,
    human: Uuid,
    request_id: Uuid,
    stored: &StoredRecord,
    scope: &str,
) -> anyhow::Result<bool> {
    if stored.access_scope != scope {
        return Ok(false);
    }
    let record: WorkRecord =
        serde_json::from_value(stored.payload.clone()).c(h!())?;
    let through = record.covers_through;
    let mut records = vec![record];
    if let Some(through) = through {
        let dependencies = rows::<StoredRecord,_>(&env.dbx, r#"
select sequence,access_scope,jsonb_build_object('version',1,'sequence',sequence,'kind',kind,
 'tool',payload->'tool','content','dependency','coversThrough',null,
 'citations',payload->'citations','fileCitations',payload->'fileCitations') as payload
from ai_agent_work_record where request_id=$1 and sequence <= $2 order by sequence
"#, vec![request_id.into(),through.into()]).await.c(h!())?;
        for dependency in dependencies {
            if dependency.access_scope != scope {
                return Ok(false);
            }
            records.push(serde_json::from_value(dependency.payload).c(h!())?);
        }
    }
    sources_readable(env, human, &records).await.c(h!())
}

pub(super) async fn read_records(
    env: &Env,
    current: &ai_agent_request::Model,
    req: &ReadWork,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        req.after >= 0 && req.after <= AI_AGENT_WORK_MAX_RECORDS,
        "Invalid work cursor"
    );
    prior_request(env, current, req.request_id).await.c(h!())?;
    let scope = access_scope(env, current.human_login_id).await.c(h!())?;
    let stored = rows::<StoredRecord,_>(&env.dbx,
        "select sequence,payload,access_scope from ai_agent_work_record where request_id=$1 and sequence>$2 order by sequence limit $3",
        vec![req.request_id.into(),req.after.into(),AI_AGENT_WORK_PAGE_RECORDS.into()]).await.c(h!())?;
    #[derive(sea_orm::FromQueryResult)]
    struct LastSequence {
        last: i64,
    }
    let last = rows::<LastSequence,_>(&env.dbx,
        "select coalesce(max(sequence),0) as last from ai_agent_work_record where request_id=$1",
        vec![req.request_id.into()]).await.c(h!())?;
    let last = last.first().c(h!())?.last;
    let mut next = stored
        .last()
        .filter(|record| record.sequence < last)
        .map(|record| record.sequence);
    let mut next_offset = 0;
    let mut records = Vec::new();
    for record in stored {
        if readable_record(
            env,
            current.human_login_id,
            req.request_id,
            &record,
            &scope,
        )
        .await
        .c(h!())?
        {
            let mut payload = record.payload;
            let content = payload["content"].as_str().c(h!())?;
            let length = content.chars().count();
            anyhow::ensure!(
                req.offset <= length,
                "Invalid work content offset"
            );
            let part: String = content
                .chars()
                .skip(req.offset)
                .take(AI_AGENT_WORK_READ_CHARS)
                .collect();
            let end = req.offset + part.chars().count();
            if end < length {
                next = Some(req.after);
                next_offset = end;
            }
            payload["content"] = json!(part);
            payload["contentOffset"] = json!(req.offset);
            payload["contentComplete"] = json!(end == length);
            records.push(payload);
        } else {
            records
                .push(json!({"sequence":record.sequence,"unavailable":true}));
        }
    }
    Ok(
        json!({"requestId":req.request_id,"records":records,"nextAfter":next,"nextOffset":next_offset}),
    )
}

#[post("/api/ai-agent/work/read")]
pub async fn read(
    env: Data<Env>,
    http: HttpRequest,
    req: Json<ReadWork>,
) -> Result<Json<Value>, AppError> {
    let current = current_request(&env, &http).await.c(h!())?;
    Ok(Json(read_records(&env, &current, &req).await.c(h!())?))
}

pub(super) async fn initial_context(
    env: &Env,
    current: &ai_agent_request::Model,
) -> anyhow::Result<Value> {
    let mut context = json!({"version":1});
    let items = summaries(env, current, None).await.c(h!())?;
    let Some(latest) = items.first() else {
        return Ok(context);
    };
    let scope = access_scope(env, current.human_login_id).await.c(h!())?;
    let checkpoint = rows::<StoredRecord,_>(&env.dbx,
        "select sequence,payload,access_scope from ai_agent_work_record where request_id=$1 and kind='checkpoint' order by sequence desc limit 1",
        vec![latest.request_id.into()]).await.c(h!())?;
    let mut recap = format!("Saved work from request {} ({}). Original question: {}\nEvidence is dated and may be incomplete. Use echo_work_list and echo_work_read to inspect details; decide whether to reuse or verify them.\n",
        latest.request_id,latest.state,super::access::truncate(&latest.prompt,AI_AGENT_WORK_PROMPT_CHARS));
    let mut after = 0;
    let mut citations = Vec::new();
    let mut files = Vec::new();
    if let Some(checkpoint) = checkpoint.first() {
        if readable_record(
            env,
            current.human_login_id,
            latest.request_id,
            checkpoint,
            &scope,
        )
        .await
        .c(h!())?
        {
            let record: WorkRecord =
                serde_json::from_value(checkpoint.payload.clone()).c(h!())?;
            recap.push_str(&super::access::truncate(
                record.content,
                AI_AGENT_WORK_CHECKPOINT_CHARS,
            ));
            recap.push('\n');
            after = record.sequence;
            citations.extend(record.citations);
            files.extend(record.file_citations);
        }
    }
    let after = if latest.records > after {
        latest.records - 1
    } else {
        after
    };
    let page = read_records(
        env,
        current,
        &ReadWork {
            request_id: latest.request_id,
            after,
            offset: 0,
        },
    )
    .await
    .c(h!())?;
    for value in page["records"].as_array().c(h!())? {
        if value.get("unavailable") == Some(&Value::Bool(true)) {
            continue;
        }
        let mut value = value.clone();
        let fields = value.as_object_mut().c(h!())?;
        fields.remove("contentOffset");
        fields.remove("contentComplete");
        let record: WorkRecord = serde_json::from_value(value).c(h!())?;
        recap.push_str(&format!(
            "\nRecord {} ({}): {}\n",
            record.sequence,
            record.tool.as_deref().unwrap_or("checkpoint"),
            super::access::truncate(
                record.content,
                AI_AGENT_WORK_EXCERPT_CHARS
            )
        ));
        citations.extend(record.citations);
        files.extend(record.file_citations);
    }
    recap.push_str(&format!("\n{} records saved; remaining records can be read with echo_work_read.\n",latest.records));
    context["recap"] = json!(super::access::truncate(
        recap,
        AI_AGENT_WORK_RECAP_MAX_CHARS
    ));
    context["citations"] = json!(super::citations::referenced(
        citations,
        context["recap"].as_str().unwrap_or_default()
    ));
    files.retain(|source| {
        context["recap"]
            .as_str()
            .unwrap_or_default()
            .contains(&source.href())
    });
    context["fileCitations"] = json!(files);
    Ok(context)
}
