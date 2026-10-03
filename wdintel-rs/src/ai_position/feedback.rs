//! Reviewer feedback on extracted mentions and consolidated locations, the
//! re-run of extraction for reviewed sources, and the evaluation export.

use super::list::{admin_groups, knowledge_visible, load_coordinates};
use super::types::{
    AiPositionFeedbackItem, AiPositionIdReq, AiPositionReparseReq,
    AiPositionReparseRsp, SaveAiPositionFeedbackReq,
};
use crate::config::{
    AI_POSITION_FEEDBACK_TEXT_MAX_CHARS, AI_POSITION_FEEDBACK_VERDICTS,
    AI_POSITION_KINDS,
};
use crate::entities::{
    ai_position_feedback, ai_position_knowledge, ai_position_mention, login,
    signal_group,
};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    EntityTrait, FromQueryResult, QueryFilter, QueryOrder, Statement,
    TransactionTrait,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};

#[post("/api/admin/ai-positions/feedback/save")]
pub async fn save_ai_position_feedback(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<SaveAiPositionFeedbackReq>,
) -> Result<Json<AiPositionFeedbackItem>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let login_id = crate::users::login_id_from_identity(&user).context(h!())?;
    let allowed: HashSet<String> = admin_groups(&env, &user)
        .await
        .context(h!())?
        .into_iter()
        .collect();
    let req = validate(req.into_inner()).context(h!())?;
    let feedback = match (req.mention_id, req.knowledge_id) {
        (Some(mention_id), None) => {
            mention_feedback(&env.dbx, mention_id, &allowed, &req)
                .await
                .context(h!())?
        }
        (None, Some(knowledge_id)) => {
            knowledge_feedback(&env.dbx, knowledge_id, &allowed, &req)
                .await
                .context(h!())?
        }
        _ => {
            return Err(AppError::BL {
                msg: "Вкажіть згадку або відому позицію".to_string(),
            })
        }
    };
    let feedback = ai_position_feedback::ActiveModel {
        created_by_id: Set(Some(login_id)),
        ..feedback
    };
    let transaction = env.dbx.begin().await.c(h!())?;
    let saved = ai_position_feedback::Entity::insert(feedback)
        .exec_with_returning(&transaction)
        .await
        .c(h!())?;
    if saved.verdict == "not_position" {
        // The name disappears everywhere at once; the mention delete trigger
        // recomputes the knowledge it fed. Deleting this feedback and
        // reparsing brings it back.
        ai_position_mention::Entity::delete_many()
            .filter(
                ai_position_mention::Column::NameKey.eq(saved.name_key.clone()),
            )
            .exec(&transaction)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    let mut items = feedback_items(&env.dbx, vec![saved]).await.c(h!())?;
    Ok(Json(items.remove(0)))
}

#[post("/api/admin/ai-positions/feedback/delete")]
pub async fn delete_ai_position_feedback(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionIdReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    ai_position_feedback::Entity::delete_by_id(req.id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

/// Re-runs extraction for one mention's source, or for every source with
/// mention feedback not yet re-run (after the prompt or parsing improved).
#[post("/api/admin/ai-positions/feedback/reparse")]
pub async fn reparse_ai_position_feedback(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionReparseReq>,
) -> Result<Json<AiPositionReparseRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let worker_enabled = super::settings(&env.dbx)
        .await
        .c(h!())?
        .is_some_and(|settings| settings.worker_enabled);
    if !worker_enabled {
        return Err(AppError::BL {
            msg: "Спершу увімкніть воркер".to_string(),
        });
    }
    let queued = match req.mention_id {
        Some(mention_id) => {
            let mention = ai_position_mention::Entity::find_by_id(mention_id)
                .one(&env.dbx)
                .await
                .c(h!())?
                .ok_or(AppError::NotFound)
                .context(h!())?;
            enqueue_source(
                &env.dbx,
                mention.sigint_inbox_item_id,
                mention.media_id,
            )
            .await
            .c(h!())?;
            1
        }
        None => reparse_open_feedback(&env.dbx).await.c(h!())?,
    };
    Ok(Json(AiPositionReparseRsp { queued }))
}

struct ValidReq {
    mention_id: Option<i64>,
    knowledge_id: Option<i64>,
    verdict: String,
    expected: String,
    comment: String,
}

fn validate(req: SaveAiPositionFeedbackReq) -> Result<ValidReq, AppError> {
    if !AI_POSITION_FEEDBACK_VERDICTS.contains(&req.verdict.as_str()) {
        return Err(AppError::BL {
            msg: "Невідома оцінка".to_string(),
        });
    }
    if req.verdict == "wrong_kind"
        && !AI_POSITION_KINDS.contains(&req.expected.trim())
    {
        return Err(AppError::BL {
            msg: "Оберіть правильний тип".to_string(),
        });
    }
    let bounded = |value: String| -> Result<String, AppError> {
        let value = value.trim().to_string();
        if value.chars().count() > AI_POSITION_FEEDBACK_TEXT_MAX_CHARS {
            return Err(AppError::BL {
                msg: "Задовгий текст відгуку".to_string(),
            });
        }
        Ok(value)
    };
    Ok(ValidReq {
        mention_id: req.mention_id,
        knowledge_id: req.knowledge_id,
        verdict: req.verdict,
        expected: bounded(req.expected).context(h!())?,
        comment: bounded(req.comment).context(h!())?,
    })
}

/// Private groups the admin cannot read are treated as missing.
async fn group_visible(
    dbx: &DatabaseConnection,
    group_master_key: Option<&str>,
    allowed: &HashSet<String>,
) -> anyhow::Result<bool> {
    let Some(group_master_key) = group_master_key else {
        return Ok(true);
    };
    let secret = signal_group::Entity::find_by_id(group_master_key.to_string())
        .one(dbx)
        .await
        .c(h!())?
        .is_some_and(|group| group.is_secret);
    Ok(!secret || allowed.contains(group_master_key))
}

#[derive(FromQueryResult)]
struct SourceText {
    text: Option<String>,
}

async fn mention_feedback(
    dbx: &DatabaseConnection,
    mention_id: i64,
    allowed: &HashSet<String>,
    req: &ValidReq,
) -> Result<ai_position_feedback::ActiveModel, AppError> {
    let mention = ai_position_mention::Entity::find_by_id(mention_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    if !group_visible(dbx, mention.group_master_key.as_deref(), allowed)
        .await
        .c(h!())?
    {
        return Err(AppError::NotFound);
    }
    let text = SourceText::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select coalesce(
             (select body from signal_message where id = $1),
             (select summary from media_summary where media_id = $2)
         ) as text",
        [mention.sigint_inbox_item_id.into(), mention.media_id.into()],
    ))
    .one(dbx)
    .await
    .c(h!())?
    .and_then(|source| source.text);
    let coordinates = load_coordinates(dbx, vec![mention.id])
        .await
        .c(h!())?
        .remove(&mention.id)
        .unwrap_or_default();
    Ok(ai_position_feedback::ActiveModel {
        id: NotSet,
        target_kind: Set("mention".to_string()),
        mention_id: Set(Some(mention.id)),
        scope_kind: Set(None),
        scope_key: Set(None),
        sigint_inbox_item_id: Set(mention.sigint_inbox_item_id),
        media_id: Set(mention.media_id),
        group_master_key: Set(mention.group_master_key),
        name: Set(mention.name),
        name_key: Set(mention.name_key),
        kind: Set(Some(mention.kind)),
        source_text: Set(text),
        begin_char: Set(Some(mention.begin_char)),
        end_char: Set(Some(mention.end_char)),
        coordinates: Set(serde_json::to_value(coordinates).c(h!())?),
        known_location: Set(None),
        model_name: Set(Some(mention.model_name)),
        verdict: Set(req.verdict.clone()),
        expected: Set(req.expected.clone()),
        comment: Set(req.comment.clone()),
        created_by_id: NotSet,
        created_at: NotSet,
        reparsed_at: Set(None),
    })
}

async fn knowledge_feedback(
    dbx: &DatabaseConnection,
    knowledge_id: i64,
    allowed: &HashSet<String>,
    req: &ValidReq,
) -> Result<ai_position_feedback::ActiveModel, AppError> {
    let known = ai_position_knowledge::Entity::find_by_id(knowledge_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    if !admin_may_see_knowledge(dbx, &known.source_group_keys, allowed)
        .await
        .c(h!())?
    {
        return Err(AppError::NotFound);
    }
    let known_location = json!({
        "mgrs": known.mgrs,
        "lat": known.lat,
        "lng": known.lng,
        "certainty": known.certainty,
        "factCount": known.fact_count,
        "conflicting": known.conflicting,
        "firstFactAt": known.first_fact_at.and_utc().timestamp_millis(),
        "lastFactAt": known.last_fact_at.and_utc().timestamp_millis(),
    });
    Ok(ai_position_feedback::ActiveModel {
        id: NotSet,
        target_kind: Set("knowledge".to_string()),
        mention_id: Set(None),
        scope_kind: Set(Some(known.scope_kind)),
        scope_key: Set(Some(known.scope_key)),
        sigint_inbox_item_id: Set(None),
        media_id: Set(None),
        group_master_key: Set(None),
        name: Set(known.name),
        name_key: Set(known.name_key),
        kind: Set(Some(known.kind)),
        source_text: Set(None),
        begin_char: Set(None),
        end_char: Set(None),
        coordinates: Set(json!([])),
        known_location: Set(Some(known_location)),
        model_name: Set(None),
        verdict: Set(req.verdict.clone()),
        expected: Set(req.expected.clone()),
        comment: Set(req.comment.clone()),
        created_by_id: NotSet,
        created_at: NotSet,
        reparsed_at: Set(None),
    })
}

/// Admins see knowledge unless a private group they cannot read fed it.
async fn admin_may_see_knowledge(
    dbx: &DatabaseConnection,
    source_group_keys: &[String],
    allowed: &HashSet<String>,
) -> anyhow::Result<bool> {
    if knowledge_visible(source_group_keys, allowed) {
        return Ok(true);
    }
    let hidden: Vec<String> = source_group_keys
        .iter()
        .filter(|key| !allowed.contains(*key))
        .cloned()
        .collect();
    let secret = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(hidden))
        .filter(signal_group::Column::IsSecret.eq(true))
        .one(dbx)
        .await
        .c(h!())?;
    Ok(secret.is_none())
}

async fn enqueue_source(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: Option<i64>,
    media_id: Option<uuid::Uuid>,
) -> anyhow::Result<()> {
    match (sigint_inbox_item_id, media_id) {
        (Some(item_id), _) => {
            super::worker::enqueue_message_if_enabled(dbx, item_id).await
        }
        (None, Some(media_id)) => {
            super::worker::enqueue_media_if_enabled(dbx, media_id).await
        }
        (None, None) => Ok(()),
    }
}

/// Queues every source with mention feedback not re-run yet and marks it.
async fn reparse_open_feedback(
    dbx: &DatabaseConnection,
) -> anyhow::Result<i64> {
    let open = ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::TargetKind.eq("mention"))
        .filter(ai_position_feedback::Column::ReparsedAt.is_null())
        .all(dbx)
        .await
        .c(h!())?;
    let sources: HashSet<(Option<i64>, Option<uuid::Uuid>)> = open
        .iter()
        .map(|feedback| (feedback.sigint_inbox_item_id, feedback.media_id))
        .collect();
    for (item_id, media_id) in &sources {
        enqueue_source(dbx, *item_id, *media_id).await.c(h!())?;
    }
    ai_position_feedback::Entity::update_many()
        .col_expr(
            ai_position_feedback::Column::ReparsedAt,
            Some(Utc::now().naive_utc()).into(),
        )
        .filter(
            ai_position_feedback::Column::Id
                .is_in(open.iter().map(|feedback| feedback.id)),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(sources.len() as i64)
}

/// Names reviewers marked «not a position»: never extracted, linked or
/// consolidated again while the mark exists.
pub(crate) async fn rejected_name_keys<C>(
    dbx: &C,
) -> anyhow::Result<HashSet<String>>
where
    C: ConnectionTrait,
{
    use sea_orm::QuerySelect;
    let keys: Vec<String> = ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::Verdict.eq("not_position"))
        .select_only()
        .column(ai_position_feedback::Column::NameKey)
        .distinct()
        .into_tuple()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(keys.into_iter().collect())
}

pub(crate) async fn open_feedback_count(
    dbx: &DatabaseConnection,
) -> anyhow::Result<i64> {
    use sea_orm::PaginatorTrait;
    Ok(ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::TargetKind.eq("mention"))
        .filter(ai_position_feedback::Column::ReparsedAt.is_null())
        .count(dbx)
        .await
        .c(h!())? as i64)
}

pub(crate) async fn feedback_items<C>(
    dbx: &C,
    rows: Vec<ai_position_feedback::Model>,
) -> anyhow::Result<Vec<AiPositionFeedbackItem>>
where
    C: ConnectionTrait,
{
    let login_ids: Vec<uuid::Uuid> =
        rows.iter().filter_map(|row| row.created_by_id).collect();
    let names: HashMap<uuid::Uuid, String> = login::Entity::find()
        .filter(login::Column::Id.is_in(login_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|login| (login.id, login.login))
        .collect();
    Ok(rows
        .into_iter()
        .map(|row| AiPositionFeedbackItem {
            id: row.id,
            target_kind: row.target_kind,
            verdict: row.verdict,
            expected: row.expected,
            comment: row.comment,
            created_by: row
                .created_by_id
                .and_then(|id| names.get(&id).cloned()),
            created_at: row.created_at.and_utc().timestamp_millis(),
            reparsed_at: row
                .reparsed_at
                .map(|at| at.and_utc().timestamp_millis()),
        })
        .collect())
}

/// Feedback on these mentions, newest first, by mention id.
pub(crate) async fn mention_feedback_items(
    dbx: &DatabaseConnection,
    mention_ids: Vec<i64>,
) -> anyhow::Result<HashMap<i64, Vec<AiPositionFeedbackItem>>> {
    let rows = ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::MentionId.is_in(mention_ids))
        .order_by_desc(ai_position_feedback::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    let mention_ids: Vec<Option<i64>> =
        rows.iter().map(|row| row.mention_id).collect();
    let items = feedback_items(dbx, rows).await.c(h!())?;
    let mut by_mention: HashMap<i64, Vec<AiPositionFeedbackItem>> =
        HashMap::new();
    for (mention_id, item) in mention_ids.into_iter().zip(items) {
        if let Some(mention_id) = mention_id {
            by_mention.entry(mention_id).or_default().push(item);
        }
    }
    Ok(by_mention)
}

/// Feedback on these positions' locations, newest first, keyed by
/// `(scope_kind, scope_key, name_key)`.
pub(crate) async fn knowledge_feedback_items(
    dbx: &DatabaseConnection,
    keys: &[(String, String, String)],
) -> anyhow::Result<
    HashMap<(String, String, String), Vec<AiPositionFeedbackItem>>,
> {
    let mut result: HashMap<
        (String, String, String),
        Vec<AiPositionFeedbackItem>,
    > = HashMap::new();
    if keys.is_empty() {
        return Ok(result);
    }
    let rows = ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::TargetKind.eq("knowledge"))
        .filter(
            ai_position_feedback::Column::NameKey
                .is_in(keys.iter().map(|key| key.2.clone())),
        )
        .order_by_desc(ai_position_feedback::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    let row_keys: Vec<(String, String, String)> = rows
        .iter()
        .map(|row| {
            (
                row.scope_kind.clone().unwrap_or_default(),
                row.scope_key.clone().unwrap_or_default(),
                row.name_key.clone(),
            )
        })
        .collect();
    let items = feedback_items(dbx, rows).await.c(h!())?;
    for (key, item) in row_keys.into_iter().zip(items) {
        if keys.contains(&key) {
            result.entry(key).or_default().push(item);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{mention_feedback, reparse_open_feedback, validate, ValidReq};
    use crate::ai_position::types::SaveAiPositionFeedbackReq;
    use crate::entities::{
        ai_position_feedback, ai_position_mention, sigint_inbox_item,
        signal_message,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
    use std::collections::HashSet;

    fn request(verdict: &str) -> SaveAiPositionFeedbackReq {
        SaveAiPositionFeedbackReq {
            mention_id: Some(1),
            knowledge_id: None,
            verdict: verdict.to_string(),
            expected: "  Береза 4 ".to_string(),
            comment: String::new(),
        }
    }

    #[test]
    fn validates_verdicts() {
        assert!(validate(request("bogus")).is_err());
        let valid: ValidReq = validate(request("wrong_name")).ok().unwrap();
        assert_eq!(valid.expected, "Береза 4");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn snapshots_the_case_and_marks_it_reparsed_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let body = "Переміщення до \"Циркон 9\"";
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some(body.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let mention = ai_position_mention::ActiveModel {
            sigint_inbox_item_id: Set(Some(message.id)),
            name: Set("Циркон 9".to_string()),
            name_key: Set("циркон 9".to_string()),
            begin_char: Set(16),
            end_char: Set(24),
            message_at: Set(message.created_at),
            group_is_secret: Set(false),
            aor_ids: Set(vec![]),
            model_name: Set("test".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let valid = validate(request("not_position")).ok().unwrap();
        let feedback =
            mention_feedback(&env.dbx, mention.id, &HashSet::new(), &valid)
                .await
                .ok()
                .unwrap();
        let saved = ai_position_feedback::Entity::insert(feedback)
            .exec_with_returning(&env.dbx)
            .await
            .unwrap();
        assert_eq!(saved.source_text.as_deref(), Some(body));
        assert_eq!(saved.name_key, "циркон 9");
        assert!(saved.reparsed_at.is_none());

        assert_eq!(reparse_open_feedback(&env.dbx).await.unwrap(), 1);
        let saved = ai_position_feedback::Entity::find_by_id(saved.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(saved.reparsed_at.is_some());
        assert_eq!(reparse_open_feedback(&env.dbx).await.unwrap(), 0);
    }
}
