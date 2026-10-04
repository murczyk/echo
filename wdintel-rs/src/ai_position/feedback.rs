//! Reviewer feedback on extracted mentions and consolidated locations, the
//! re-run of extraction for reviewed sources, and the evaluation export.

use super::list::{admin_groups, knowledge_visible, load_coordinates};
use super::types::{
    AiPositionFeedbackItem, AiPositionFeedbackListItem,
    AiPositionFeedbackListReq, AiPositionFeedbackListRsp, AiPositionIdReq,
    AiPositionReparseReq, AiPositionReparseRsp, SaveAiPositionFeedbackReq,
};
use crate::config::{
    AI_POSITION_FEEDBACK_TEXT_MAX_CHARS, AI_POSITION_FEEDBACK_VERDICTS,
    AI_POSITION_KINDS, AI_POSITION_LIST_DEFAULT_LIMIT,
    AI_POSITION_LIST_MAX_LIMIT,
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

#[post("/api/admin/ai-positions/feedback/list")]
pub async fn list_ai_position_feedback(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionFeedbackListReq>,
) -> Result<Json<AiPositionFeedbackListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let allowed: Vec<String> = admin_groups(&env, &user).await.context(h!())?;
    let req = req.into_inner();
    let limit = req
        .limit
        .unwrap_or(AI_POSITION_LIST_DEFAULT_LIMIT as i64)
        .clamp(1, AI_POSITION_LIST_MAX_LIMIT as i64);
    // Private groups the admin cannot read stay hidden, as on the lists.
    let rows = ai_position_feedback::Model::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select f.* from ai_position_feedback f
         left join signal_message_media media on media.id = f.media_id
         -- The source's group now: a message moved into a private group
         -- takes its feedback with it.
         left join lateral (
             select smg.group_master_key
             from signal_message_group smg
             where smg.signal_message_id = coalesce(f.sigint_inbox_item_id, media.signal_message_id)
               and smg.group_master_key is not null
             order by smg.id
             limit 1
         ) current_group on true
         left join signal_group sg
             on sg.master_key = coalesce(current_group.group_master_key, f.group_master_key,
                 case when f.scope_kind = 'group' then f.scope_key end)
         where (not coalesce(sg.is_secret, false) or sg.master_key = any($1))
           -- Location feedback: every group that fed the location, as private
           -- as it is now.
           and not exists (
               select 1
               from jsonb_array_elements_text(
                   coalesce(f.known_location -> 'sourceGroupKeys', '[]'::jsonb)
               ) source_group
               join signal_group source_sg on source_sg.master_key = source_group
               where source_sg.is_secret and not (source_group = any($1))
           )
           and ($2::text is null or f.verdict = $2)
         order by f.created_at desc, f.id desc
         limit $3",
            [allowed.into(), req.verdict.into(), limit.into()],
        ),
    )
    .all(&env.dbx)
    .await
    .c(h!())?;
    let uuids: HashMap<i64, uuid::Uuid> =
        crate::entities::signal_message::Entity::find()
            .filter(
                crate::entities::signal_message::Column::Id.is_in(
                    rows.iter().filter_map(|row| row.sigint_inbox_item_id),
                ),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .filter_map(|message| Some((message.id, message.id_uuid?)))
            .collect();
    let details: Vec<(String, String, Option<String>, Option<i64>)> = rows
        .iter()
        .map(|row| {
            (
                row.name.clone(),
                row.name_key.clone(),
                row.kind.clone(),
                row.sigint_inbox_item_id,
            )
        })
        .collect();
    let items = feedback_items(&env.dbx, rows).await.c(h!())?;
    Ok(Json(AiPositionFeedbackListRsp {
        items: items
            .into_iter()
            .zip(details)
            .map(|(feedback, (name, name_key, kind, message_id))| {
                AiPositionFeedbackListItem {
                    feedback,
                    name,
                    name_key,
                    kind,
                    message_uuid: message_id
                        .and_then(|id| uuids.get(&id))
                        .map(ToString::to_string),
                    message_id,
                }
            })
            .collect(),
    }))
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
    mention_id: Option<uuid::Uuid>,
    knowledge_id: Option<uuid::Uuid>,
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
    mention_id: uuid::Uuid,
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
    knowledge_id: uuid::Uuid,
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
        // Which groups fed it, so the feedback stays as private as they are.
        "sourceGroupKeys": known.source_group_keys,
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
    // Feedback outlives its source: skip messages and attachments that are
    // gone, they have nothing to re-run.
    let mut queued = 0;
    for (item_id, media_id) in &sources {
        if source_exists(dbx, *item_id, *media_id).await.c(h!())? {
            enqueue_source(dbx, *item_id, *media_id).await.c(h!())?;
            queued += 1;
        }
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
    Ok(queued)
}

async fn source_exists(
    dbx: &DatabaseConnection,
    sigint_inbox_item_id: Option<i64>,
    media_id: Option<uuid::Uuid>,
) -> anyhow::Result<bool> {
    Ok(match (sigint_inbox_item_id, media_id) {
        (Some(item_id), _) => {
            crate::entities::sigint_inbox_item::Entity::find_by_id(item_id)
                .one(dbx)
                .await
                .c(h!())?
                .is_some()
        }
        (None, Some(media_id)) => {
            crate::entities::signal_message_media::Entity::find_by_id(media_id)
                .one(dbx)
                .await
                .c(h!())?
                .is_some()
        }
        (None, None) => false,
    })
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
    mention_ids: Vec<uuid::Uuid>,
) -> anyhow::Result<HashMap<uuid::Uuid, Vec<AiPositionFeedbackItem>>> {
    let rows = ai_position_feedback::Entity::find()
        .filter(ai_position_feedback::Column::MentionId.is_in(mention_ids))
        .order_by_desc(ai_position_feedback::Column::CreatedAt)
        .all(dbx)
        .await
        .c(h!())?;
    let mention_ids: Vec<Option<uuid::Uuid>> =
        rows.iter().map(|row| row.mention_id).collect();
    let items = feedback_items(dbx, rows).await.c(h!())?;
    let mut by_mention: HashMap<uuid::Uuid, Vec<AiPositionFeedbackItem>> =
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
    allowed_groups: &[String],
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
    // The location reviewed may have come from groups now private, even when
    // what the position is built from today is readable.
    let snapshot_groups = |row: &ai_position_feedback::Model| -> Vec<String> {
        row.known_location
            .as_ref()
            .and_then(|location| location.get("sourceGroupKeys"))
            .and_then(|keys| serde_json::from_value(keys.clone()).ok())
            .unwrap_or_default()
    };
    let secret: HashSet<String> = crate::entities::signal_group::Entity::find()
        .filter(crate::entities::signal_group::Column::IsSecret.eq(true))
        .filter(
            crate::entities::signal_group::Column::MasterKey
                .is_in(rows.iter().flat_map(snapshot_groups)),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|group| group.master_key)
        .collect();
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            snapshot_groups(row).iter().all(|key| {
                !secret.contains(key) || allowed_groups.contains(key)
            })
        })
        .collect();
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
    use super::{reparse_open_feedback, save_ai_position_feedback};
    use crate::ai_position::types::SaveAiPositionFeedbackReq;
    use crate::entities::{
        ai_position_feedback, ai_position_mention, sigint_inbox_item,
        signal_message,
    };
    use actix_web::{
        test as web_test, web, App, HttpMessage, HttpRequest, HttpResponse,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};

    async fn test_login(
        req: HttpRequest,
        login_id: web::Json<uuid::Uuid>,
    ) -> HttpResponse {
        actix_identity::Identity::login(
            &req.extensions(),
            login_id.to_string(),
        )
        .unwrap();
        HttpResponse::NoContent().finish()
    }

    fn request(verdict: &str) -> SaveAiPositionFeedbackReq {
        SaveAiPositionFeedbackReq {
            mention_id: Some(uuid::Uuid::now_v7()),
            knowledge_id: None,
            verdict: verdict.to_string(),
            expected: "  Береза 4 ".to_string(),
            comment: String::new(),
        }
    }

    async fn seed_mention(
        dbx: &sea_orm::DatabaseConnection,
        body: &str,
    ) -> ai_position_mention::Model {
        let message = crate::functest::tests::mk_signal_message(
            dbx,
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
        .insert(dbx)
        .await
        .unwrap();
        let begin =
            body[..body.find("Циркон 9").unwrap()].chars().count() as i32;
        ai_position_mention::ActiveModel {
            sigint_inbox_item_id: Set(Some(message.id)),
            name: Set("Циркон 9".to_string()),
            name_key: Set("циркон 9".to_string()),
            begin_char: Set(begin),
            end_char: Set(begin + 8),
            message_at: Set(message.created_at),
            group_is_secret: Set(false),
            aor_ids: Set(vec![]),
            model_name: Set("test".to_string()),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn feedback_app(
        env: std::sync::Arc<crate::types::Env>,
    ) -> App<
        impl actix_web::dev::ServiceFactory<
            actix_web::dev::ServiceRequest,
            Config = (),
            Response = actix_web::dev::ServiceResponse,
            Error = actix_web::Error,
            InitError = (),
        >,
    > {
        let store = actix_session::storage::RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        App::new()
            .wrap(actix_identity::IdentityMiddleware::default())
            .wrap(actix_session::SessionMiddleware::new(
                store,
                actix_web::cookie::Key::generate(),
            ))
            .app_data(web::Data::from(env.clone()))
            .route("/test-login", web::post().to(test_login))
            .service(save_ai_position_feedback)
    }

    async fn review_mention(
        env: &std::sync::Arc<crate::types::Env>,
        mention_id: uuid::Uuid,
    ) -> crate::ai_position::types::AiPositionFeedbackItem {
        let admin = crate::functest::tests::mk_login(
            &env.dbx,
            crate::entities::login::ActiveModel {
                roles: Set(serde_json::json!(["Admin"])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let app = web_test::init_service(feedback_app(env.clone()).await).await;
        let response = web_test::call_service(
            &app,
            web_test::TestRequest::post()
                .uri("/test-login")
                .set_json(admin.id)
                .to_request(),
        )
        .await;
        let cookie = response.response().cookies().next().unwrap().into_owned();
        let response = web_test::call_service(
            &app,
            web_test::TestRequest::post()
                .uri("/api/admin/ai-positions/feedback/save")
                .cookie(cookie)
                .set_json(SaveAiPositionFeedbackReq {
                    mention_id: Some(mention_id),
                    ..request("not_position")
                })
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        web_test::read_body_json(response).await
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn snapshots_the_case_and_marks_it_reparsed_3064() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let body = "Переміщення до \"Циркон 9\"";
        let mention = seed_mention(&env.dbx, body).await;
        let other_mention = seed_mention(&env.dbx, "Циркон 9, на связь").await;
        let saved = review_mention(&env, mention.id).await;
        assert_eq!(saved.id.get_version_num(), 7);
        for id in [mention.id, other_mention.id] {
            assert_eq!(id.get_version_num(), 7);
            assert!(ai_position_mention::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .is_some());
        }
        let saved = ai_position_feedback::Entity::find_by_id(saved.id)
            .one(&env.dbx)
            .await
            .unwrap()
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
