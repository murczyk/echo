use crate::config::*;
use crate::entities::ai_engine;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, FromQueryResult, Statement, Value,
};
use serde::Serialize;
use std::collections::HashSet;
use uuid::Uuid;

pub(crate) fn sql(query: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, query, values)
}

#[derive(
    Clone,
    Debug,
    Default,
    PartialEq,
    serde::Serialize,
    serde::Deserialize,
    elm_rs::Elm,
    elm_rs::ElmEncode,
    elm_rs::ElmDecode,
)]
#[serde(rename_all = "camelCase")]
pub struct CallsignEdit {
    pub message_id: i64,
    pub action_id: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(FromQueryResult)]
struct Override {
    callsign: String,
    included: bool,
}

pub(crate) async fn apply_overrides<C: ConnectionTrait>(
    db: &C,
    id: i64,
    mut callsigns: Vec<String>,
) -> anyhow::Result<Vec<String>> {
    let overrides = Override::find_by_statement(sql(
        r#"
select distinct on (callsign) callsign, included
from (
    select callsign, included, 1 as priority, null::timestamp as changed_at
    from ai_callsign_override where inbox_item_id = $1
    union all
    select callsign, not deleted, 0,
        case when deleted then deleted_at else created_at end
    from sigint_inbox_item_callsign
    where sigint_inbox_item_id = $1
      and ((not deleted and created_by_id <> (select id from login where login = $2))
        or (deleted and deleted_by_id <> (select id from login where login = $2)))
) actions order by callsign, priority desc, changed_at desc nulls last, included
"#,
        vec![id.into(), crate::config::SYSTEM_LOGIN_NAME.into()],
    )).all(db).await.c(h!())?;
    for entry in overrides {
        if entry.included {
            callsigns.push(entry.callsign);
        } else {
            callsigns.retain(|callsign| callsign != &entry.callsign);
        }
    }
    Ok(super::worker::normalize_callsigns(callsigns))
}

pub(crate) async fn record_edit<C: ConnectionTrait>(
    db: &C,
    actor: Uuid,
    edit: &CallsignEdit,
    ids: &[i64],
    body: &str,
) -> anyhow::Result<()> {
    let action_id = Uuid::parse_str(&edit.action_id).c(h!())?;
    let added = super::worker::normalize_callsigns(edit.added.clone());
    let removed = super::worker::normalize_callsigns(edit.removed.clone());
    anyhow::ensure!(
        added.len() + removed.len() <= AI_CALLSIGN_MAX_CALLSIGNS,
        "Too many callsign edits"
    );
    anyhow::ensure!(
        added
            .iter()
            .chain(&removed)
            .all(|s| s.chars().count() <= AI_CALLSIGN_MAX_CHARS),
        "Callsign too long"
    );
    anyhow::ensure!(
        !added.iter().any(|s| removed.contains(s)),
        "Conflicting callsign edits"
    );
    if added.is_empty() && removed.is_empty() {
        return Ok(());
    }
    if !claim_action(db, actor, action_id, edit.message_id)
        .await
        .c(h!())?
    {
        return Ok(());
    }
    record_removals(db, actor, action_id, edit.message_id, body, &removed)
        .await
        .c(h!())?;
    for id in ids {
        store_overrides(db, actor, action_id, *id, &added, true)
            .await
            .c(h!())?;
        store_overrides(db, actor, action_id, *id, &removed, false)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn claim_action<C: ConnectionTrait>(
    db: &C,
    actor: Uuid,
    action_id: Uuid,
    message_id: i64,
) -> anyhow::Result<bool> {
    let inserted = db.execute_raw(sql(
        "insert into ai_callsign_action (id, actor_id, inbox_item_id) values ($1, $2, $3) on conflict do nothing",
        vec![action_id.into(), actor.into(), message_id.into()],
    )).await.c(h!())?.rows_affected();
    if inserted == 0 {
        let previous = db.query_one_raw(sql("select id from ai_callsign_action where id = $1 and actor_id = $2 and inbox_item_id = $3", vec![action_id.into(), actor.into(), message_id.into()])).await.c(h!())?;
        anyhow::ensure!(
            previous.is_some(),
            "Callsign action belongs to another message or user"
        );
        return Ok(false);
    }
    Ok(true)
}

async fn record_removals<C: ConnectionTrait>(
    db: &C,
    actor: Uuid,
    action_id: Uuid,
    message_id: i64,
    body: &str,
    removed: &[String],
) -> anyhow::Result<()> {
    let current = crate::inbox::callsigns::load_by_item_ids(db, &[message_id])
        .await
        .c(h!())?;
    let current = current
        .get(&message_id)
        .cloned()
        .unwrap_or_default()
        .effective();
    for callsign in removed {
        if current.contains(callsign) {
            db.execute_raw(sql("insert into ai_callsign_feedback (action_id, callsign, inbox_item_id, inbox_item_uuid, actor_id, body) select $1, $2, id, id_uuid, $3, $4 from sigint_inbox_item where id = $5", vec![action_id.into(), callsign.clone().into(), actor.into(), body.into(), message_id.into()])).await.c(h!())?;
            db.execute_raw(sql("insert into ai_callsign_feedback_summary (callsign, removal_count) values ($1, 1) on conflict (callsign) do update set removal_count = ai_callsign_feedback_summary.removal_count + 1, updated_at = now() at time zone 'utc'", vec![callsign.clone().into()])).await.c(h!())?;
        }
    }
    Ok(())
}

async fn store_overrides<C: ConnectionTrait>(
    db: &C,
    actor: Uuid,
    action_id: Uuid,
    id: i64,
    callsigns: &[String],
    included: bool,
) -> anyhow::Result<()> {
    db.execute_raw(sql(
        "insert into ai_callsign_override (inbox_item_id, callsign, included, actor_id, action_id) select $1, unnest($2::text[]), $3, $4, $5 on conflict (inbox_item_id, callsign) do update set included = excluded.included, actor_id = excluded.actor_id, action_id = excluded.action_id",
        vec![id.into(), callsigns.to_vec().into(), included.into(), actor.into(), action_id.into()],
    )).await.c(h!())?;
    Ok(())
}

#[derive(FromQueryResult, Serialize)]
struct Evidence {
    callsign: String,
    removal_count: i64,
    #[sea_orm(skip)]
    examples: Vec<String>,
}

pub(crate) async fn refine<C: ConnectionTrait>(
    db: &C,
    engine: &ai_engine::Model,
    prompt: &str,
    body: &str,
    initial: Vec<String>,
    templates: &[String],
) -> anyhow::Result<Vec<String>> {
    let mut evidence = Evidence::find_by_statement(sql(
        "select callsign, removal_count from ai_callsign_feedback_summary where callsign = any($1) order by callsign",
        vec![initial.clone().into()],
    )).all(db).await.c(h!())?;
    if evidence.is_empty() {
        return Ok(initial);
    }
    load_examples(db, &mut evidence).await.c(h!())?;
    let system = format!("{prompt}\n\n{AI_CALLSIGN_FEEDBACK_PROMPT}");
    let input = loop {
        let input = serde_json::to_string(&serde_json::json!({"CURRENT_MESSAGE": body, "INITIAL_CALLSIGNS": initial, "TEMPLATE_CALLSIGNS": templates, "FEEDBACK": evidence})).c(h!())?;
        if system.chars().count() + input.chars().count()
            <= AI_CALLSIGN_FEEDBACK_INPUT_CHARS
        {
            break input;
        }
        if let Some(entry) =
            evidence.iter_mut().rev().find(|e| !e.examples.is_empty())
        {
            entry.examples.pop();
        } else {
            anyhow::bail!("Callsign feedback request exceeds input limit");
        }
    };
    let response = crate::ai_engine::request_ai_response(
        engine,
        vec![
            crate::ai_engine::AiEngineMessage {
                role: AI_CHAT_ROLE_SYSTEM.into(),
                content: system,
            },
            crate::ai_engine::AiEngineMessage {
                role: AI_CHAT_ROLE_USER.into(),
                content: input,
            },
        ],
    )
    .await
    .c(h!())?;
    let callsigns = super::parse_callsigns(&response)
        .map_err(anyhow::Error::msg)
        .c(h!())?;
    let mut callsigns = super::worker::normalize_callsigns(callsigns);
    let extra = callsigns
        .iter()
        .filter(|callsign| !initial.contains(callsign))
        .cloned()
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        let grounded = crate::rer_importer::callsigns::highlight_callsigns(
            &reqwest::Client::new(),
            body,
            &extra,
        )
        .await
        .c(h!())?;
        callsigns.retain(|callsign| {
            initial.contains(callsign)
                || grounded
                    .iter()
                    .any(|token| token.etalon.to_lowercase() == *callsign)
        });
    }
    Ok(callsigns)
}

async fn load_examples<C: ConnectionTrait>(
    db: &C,
    evidence: &mut [Evidence],
) -> anyhow::Result<()> {
    let names = evidence
        .iter()
        .map(|entry| entry.callsign.clone())
        .collect::<Vec<_>>();
    let rows = db.query_all_raw(sql(
        "select names.callsign, examples.body from unnest($1::text[]) names(callsign) cross join lateral (select substring(body from greatest(1, strpos(lower(body), names.callsign) - $2 / 3) for $2) as body from ai_callsign_feedback where callsign = names.callsign order by id desc limit $3) examples",
        vec![names.into(), (AI_CALLSIGN_FEEDBACK_EXAMPLE_CHARS as i32).into(), AI_CALLSIGN_FEEDBACK_EXAMPLE_SCAN_LIMIT.into()],
    )).await.c(h!())?;
    let per_callsign =
        AI_CALLSIGN_FEEDBACK_HISTORY_CHARS / evidence.len().max(1);
    for entry in evidence {
        let mut seen = HashSet::new();
        let mut budget = per_callsign;
        for row in &rows {
            let callsign: String = row.try_get("", "callsign").c(h!())?;
            if callsign != entry.callsign {
                continue;
            }
            let example: String = row.try_get("", "body").c(h!())?;
            if !seen.insert(example.clone()) {
                continue;
            }
            let example: String = example
                .chars()
                .take(budget.min(AI_CALLSIGN_FEEDBACK_EXAMPLE_CHARS))
                .collect();
            if example.is_empty() {
                break;
            }
            budget -= example.chars().count();
            entry.examples.push(example);
            if entry.examples.len() == AI_CALLSIGN_FEEDBACK_EXAMPLES {
                break;
            }
        }
    }
    Ok(())
}
