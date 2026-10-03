//! The admin mention list: server-side filters, newest first, keyset pages.

use super::knowledge::{self, SCOPE_AOR};
use super::normalize::position_key;
use super::types::{
    AiPositionColumnFilter, AiPositionCoordinateItem, AiPositionKnowledgeItem,
    AiPositionKnowledgeListReq, AiPositionKnowledgeListRsp,
    AiPositionListCursor, AiPositionMentionItem, AiPositionMentionListReq,
    AiPositionMentionListRsp, AiPositionSpan,
};
use crate::config::{
    AI_POSITION_FEEDBACK_VERDICTS, AI_POSITION_KINDS,
    AI_POSITION_KNOWLEDGE_WINDOW_DAYS,
};
use crate::config::{
    AI_POSITION_LIST_DEFAULT_LIMIT, AI_POSITION_LIST_FILTER_MAX_CHARS,
    AI_POSITION_LIST_MAX_FILTERS, AI_POSITION_LIST_MAX_LIMIT,
    AI_POSITION_NEAR_DEFAULT_METERS, AI_POSITION_NEAR_MAX_METERS,
};
use crate::entities::{ai_position_coordinate, ai_position_knowledge};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use anyhow::Context;
use chrono::NaiveDateTime;
use sea_orm::{
    ColumnTrait, DatabaseBackend, DatabaseConnection, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, Statement, Value,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Characters of source text shown on each side of a mention.
const CONTEXT_CHARS: i32 = 80;

#[post("/api/admin/ai-positions/mentions/list")]
pub async fn list_ai_position_mentions(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionMentionListReq>,
) -> Result<Json<AiPositionMentionListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let allowed = admin_groups(&env, &user).await.context(h!())?;
    Ok(Json(
        list(&env.dbx, req.into_inner(), allowed, Access::Admin)
            .await
            .context(h!())?,
    ))
}

#[post("/api/admin/ai-positions/knowledge/list")]
pub async fn list_ai_position_knowledge(
    env: actix_web::web::Data<Env>,
    user: Identity,
    req: Json<AiPositionKnowledgeListReq>,
) -> Result<Json<AiPositionKnowledgeListRsp>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let allowed = admin_groups(&env, &user).await.context(h!())?;
    Ok(Json(
        list_knowledge(&env.dbx, req.into_inner(), allowed, Access::Admin)
            .await
            .context(h!())?,
    ))
}

/// Groups the admin can read; private groups outside them stay hidden even
/// on admin pages. An admin without a zone sees no private group.
pub(crate) async fn admin_groups(
    env: &Env,
    user: &Identity,
) -> Result<Vec<String>, AppError> {
    let login = crate::users::login_id_from_identity(user).context(h!())?;
    Ok(
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .unwrap_or_default(),
    )
}

/// Knowledge is visible only to someone who can read every group whose facts
/// it was built from.
pub(crate) fn knowledge_visible(
    source_group_keys: &[String],
    allowed: &HashSet<String>,
) -> bool {
    !source_group_keys.is_empty()
        && source_group_keys.iter().all(|key| allowed.contains(key))
}

#[derive(Debug, FromQueryResult)]
struct MentionRow {
    id: i64,
    sigint_inbox_item_id: Option<i64>,
    media_id: Option<Uuid>,
    media_name: Option<String>,
    message_id: Option<i64>,
    message_uuid: Option<Uuid>,
    name: String,
    name_key: String,
    kind: String,
    message_at: NaiveDateTime,
    model_name: String,
    group_is_secret: bool,
    context_before: Option<String>,
    context_match: Option<String>,
    context_after: Option<String>,
}

/// SQL conditions for the whitelisted column filters, numbered from `$next`.
pub(crate) fn filter_conditions(
    global_filter: Option<&str>,
    filters: &[AiPositionColumnFilter],
    values: &mut Vec<Value>,
) -> Result<Vec<String>, AppError> {
    if filters.len() > AI_POSITION_LIST_MAX_FILTERS {
        return Err(AppError::BL {
            msg: "Забагато фільтрів".to_string(),
        });
    }
    let mut conditions = Vec::new();
    let name_condition = |value: &str, values: &mut Vec<Value>| {
        values.push(format!("%{}%", escape_like(&position_key(value))).into());
        format!("m.name_key like ${} escape '\\'", values.len())
    };
    if let Some(global) = global_filter.map(str::trim).filter(|v| !v.is_empty())
    {
        conditions
            .push(name_condition(&bounded(global).context(h!())?, values));
    }
    for filter in filters {
        let value = bounded(filter.value.trim()).context(h!())?;
        if value.is_empty() {
            continue;
        }
        let condition = match (filter.id.as_str(), value.as_str()) {
            ("name", value) => name_condition(value, values),
            ("source", "message") => "m.sigint_inbox_item_id is not null".to_string(),
            ("source", "document") => "m.media_id is not null".to_string(),
            ("hasCoordinates", "так") => {
                "exists (select 1 from ai_position_coordinate c where c.mention_id = m.id)"
                    .to_string()
            }
            ("hasCoordinates", "ні") => {
                "not exists (select 1 from ai_position_coordinate c where c.mention_id = m.id)"
                    .to_string()
            }
            ("certainty", value) if super::extract::CERTAINTIES.contains(&value) => {
                values.push(value.to_string().into());
                format!(
                    "exists (select 1 from ai_position_coordinate c where c.mention_id = m.id and c.certainty = ${})",
                    values.len()
                )
            }
            ("feedback", "є") => {
                "exists (select 1 from ai_position_feedback f where f.mention_id = m.id)".to_string()
            }
            ("feedback", "немає") => {
                "not exists (select 1 from ai_position_feedback f where f.mention_id = m.id)"
                    .to_string()
            }
            ("feedback", value) if AI_POSITION_FEEDBACK_VERDICTS.contains(&value) => {
                values.push(value.to_string().into());
                format!(
                    "exists (select 1 from ai_position_feedback f where f.mention_id = m.id and f.verdict = ${})",
                    values.len()
                )
            }
            ("kind", value) if AI_POSITION_KINDS.contains(&value) => {
                values.push(value.to_string().into());
                format!("m.kind = ${}", values.len())
            }
            // A position's interceptions: its exact key within one scope.
            ("positionKey", value) => {
                values.push(value.to_string().into());
                format!("m.name_key = ${}", values.len())
            }
            ("near", value) => {
                let near = near_condition("c.lat", "c.lng", value, values).context(h!())?;
                format!(
                    "exists (select 1 from ai_position_coordinate c where c.mention_id = m.id and {near})"
                )
            }
            (id @ ("from" | "to"), value) => {
                date_condition("m.message_at", id, value, values).context(h!())?
            }
            ("positionScope", value) => {
                scope_condition(value, values).context(h!())?
            }
            _ => {
                return Err(AppError::BL {
                    msg: format!("Невідомий фільтр {}", filter.id),
                })
            }
        };
        conditions.push(condition);
    }
    Ok(conditions)
}

fn push_cursor(
    conditions: &mut Vec<String>,
    values: &mut Vec<Value>,
    after: Option<&AiPositionListCursor>,
    at_column: &str,
    id_column: &str,
) -> Result<(), AppError> {
    let Some(after) = after else {
        return Ok(());
    };
    let after_at = chrono::DateTime::from_timestamp_micros(after.at_micros)
        .c(h!())?
        .naive_utc();
    values.push(after_at.into());
    values.push(after.id.into());
    conditions.push(format!(
        "({at_column}, {id_column}) < (${}, ${})",
        values.len() - 1,
        values.len()
    ));
    Ok(())
}

/// Resolves `near` filters («<coordinates>» or «<coordinates>|<metres>») to
/// `lat,lng,metres`, so the SQL builders stay synchronous.
pub(crate) async fn resolve_near_filters(
    filters: Vec<AiPositionColumnFilter>,
) -> Result<Vec<AiPositionColumnFilter>, AppError> {
    let mut resolved = Vec::with_capacity(filters.len());
    for filter in filters {
        if filter.id != "near" {
            resolved.push(filter);
            continue;
        }
        let (place, radius) = match filter.value.rsplit_once('|') {
            Some((place, radius)) => (place, radius.trim().parse::<f64>().ok()),
            None => (filter.value.as_str(), None),
        };
        let radius = radius
            .unwrap_or(AI_POSITION_NEAR_DEFAULT_METERS)
            .clamp(1.0, AI_POSITION_NEAR_MAX_METERS);
        let coordinates = super::extract::all_coords(place).await;
        let Some((point, _)) = coordinates.first() else {
            return Err(AppError::BL {
                msg: format!("Не вдалося розпізнати координати «{place}»"),
            });
        };
        resolved.push(AiPositionColumnFilter {
            id: "near".to_string(),
            value: format!("{},{},{radius}", point.lat, point.lng),
        });
    }
    Ok(resolved)
}

/// Rows whose `lat_expr`/`lng_expr` lie within the resolved `near` radius:
/// a bounding box for the indexes, then the great-circle distance.
fn near_condition(
    lat_expr: &str,
    lng_expr: &str,
    value: &str,
    values: &mut Vec<Value>,
) -> Result<String, AppError> {
    let parts: Vec<f64> = value
        .split(',')
        .filter_map(|part| part.trim().parse().ok())
        .collect();
    let [lat, lng, radius] = parts[..] else {
        return Err(AppError::BL {
            msg: "Невідомі координати фільтра".to_string(),
        });
    };
    let lat_delta = radius / 111_320.0;
    let lng_delta = lat_delta / lat.to_radians().cos().max(0.01);
    values.push(lat.into());
    let lat_n = values.len();
    values.push(lng.into());
    let lng_n = values.len();
    values.push(lat_delta.into());
    let dlat_n = values.len();
    values.push(lng_delta.into());
    let dlng_n = values.len();
    values.push(radius.into());
    let radius_n = values.len();
    Ok(format!(
        "{lat_expr} between ${lat_n} - ${dlat_n} and ${lat_n} + ${dlat_n}
         and {lng_expr} between ${lng_n} - ${dlng_n} and ${lng_n} + ${dlng_n}
         and 2 * 6371000 * asin(sqrt(
             power(sin(radians({lat_expr} - ${lat_n}) / 2), 2)
             + cos(radians(${lat_n})) * cos(radians({lat_expr}))
               * power(sin(radians({lng_expr} - ${lng_n}) / 2), 2)
         )) <= ${radius_n}"
    ))
}

/// `from`/`to` dates (`YYYY-MM-DD`, `to` inclusive) on a timestamp column.
fn date_condition(
    column: &str,
    id: &str,
    value: &str,
    values: &mut Vec<Value>,
) -> Result<String, AppError> {
    let date =
        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
            AppError::BL {
                msg: "Дата має бути у форматі РРРР-ММ-ДД".to_string(),
            }
        })?;
    let (operator, date) = if id == "from" {
        (">=", date)
    } else {
        ("<", date.succ_opt().unwrap_or(date))
    };
    values.push(date.and_hms_opt(0, 0, 0).unwrap_or_default().into());
    Ok(format!("{column} {operator} ${}", values.len()))
}

/// `aor:<id>`: the AOR's current non-private groups; `group:<key>`.
fn scope_condition(
    value: &str,
    values: &mut Vec<Value>,
) -> Result<String, AppError> {
    match value.split_once(':') {
        Some(("aor", aor_id)) => {
            let aor_id: i64 = aor_id.parse().map_err(|_| AppError::BL {
                msg: "Невідомий район відповідальності".to_string(),
            })?;
            values.push(aor_id.into());
            Ok(format!(
                "not coalesce(sg.is_secret, false) and exists (
                     select 1 from signal_group_aor sga
                     join area_of_responsibility aor on aor.id = sga.aor_id and not aor.deleted
                     where sga.master_key = m.group_master_key and sga.aor_id = ${}
                 )",
                values.len()
            ))
        }
        Some(("group", key)) => {
            values.push(key.to_string().into());
            Ok(format!("m.group_master_key = ${}", values.len()))
        }
        _ => Err(AppError::BL {
            msg: "Невідома область позиції".to_string(),
        }),
    }
}

fn bounded(value: &str) -> Result<String, AppError> {
    if value.chars().count() > AI_POSITION_LIST_FILTER_MAX_CHARS {
        return Err(AppError::BL {
            msg: "Задовге значення фільтра".to_string(),
        });
    }
    Ok(value.to_string())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Who is reading: admins see everything but private groups they cannot
/// read; users (and the AI agent acting for them) only their groups.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Access {
    Admin,
    User,
}

pub(crate) async fn list(
    dbx: &DatabaseConnection,
    req: AiPositionMentionListReq,
    allowed_groups: Vec<String>,
    access: Access,
) -> Result<AiPositionMentionListRsp, AppError> {
    let limit = req
        .limit
        .map_or(AI_POSITION_LIST_DEFAULT_LIMIT, |limit| limit.max(1) as u64)
        .min(AI_POSITION_LIST_MAX_LIMIT);
    let mut values: Vec<Value> = vec![CONTEXT_CHARS.into()];
    let column_filters = resolve_near_filters(req.column_filters.clone())
        .await
        .context(h!())?;
    let mut conditions = filter_conditions(
        req.global_filter.as_deref(),
        &column_filters,
        &mut values,
    )
    .context(h!())?;
    values.push(allowed_groups.into());
    conditions.push(match access {
        Access::Admin => format!(
            "(not coalesce(sg.is_secret, false) or m.group_master_key = any(${}))",
            values.len()
        ),
        Access::User => format!("m.group_master_key = any(${})", values.len()),
    });
    push_cursor(
        &mut conditions,
        &mut values,
        req.after.as_ref(),
        "m.message_at",
        "m.id",
    )
    .context(h!())?;
    values.push(((limit + 1) as i64).into());
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("where {}", conditions.join(" and "))
    };
    let sql = format!(
        "select m.id, m.sigint_inbox_item_id, m.media_id, media.file_name as media_name,
                message.id as message_id, message.id_uuid as message_uuid,
                m.name, m.name_key, m.kind, m.message_at, m.model_name,
                coalesce(sg.is_secret, false) as group_is_secret,
                substr(source.text, greatest(m.begin_char - $1, 0) + 1, least(m.begin_char, $1)) as context_before,
                substr(source.text, m.begin_char + 1, m.end_char - m.begin_char) as context_match,
                substr(source.text, m.end_char + 1, $1) as context_after
         from ai_position_mention m
         left join signal_message_media media on media.id = m.media_id
         join signal_message message
             on message.id = coalesce(m.sigint_inbox_item_id, media.signal_message_id)
             and not message.deleted
         left join signal_group sg on sg.master_key = m.group_master_key
         left join lateral (
             select coalesce(
                 case when m.sigint_inbox_item_id is not null then message.body end,
                 (select summary from media_summary where media_id = m.media_id)
             ) as text
         ) source on true
         {where_sql}
         order by m.message_at desc, m.id desc
         limit ${}",
        values.len()
    );
    let mut rows = MentionRow::find_by_statement(
        Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let next_cursor = if rows.len() as u64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|row| AiPositionListCursor {
            at_micros: row.message_at.and_utc().timestamp_micros(),
            id: row.id,
        })
    } else {
        None
    };
    let mut coordinates =
        load_coordinates(dbx, rows.iter().map(|row| row.id).collect())
            .await
            .c(h!())?;
    let mut feedback = super::feedback::mention_feedback_items(
        dbx,
        rows.iter().map(|row| row.id).collect(),
    )
    .await
    .c(h!())?;
    Ok(AiPositionMentionListRsp {
        items: rows
            .into_iter()
            .map(|row| AiPositionMentionItem {
                id: row.id,
                source_kind: if row.sigint_inbox_item_id.is_some() {
                    "message"
                } else {
                    "document"
                }
                .to_string(),
                message_id: row.message_id,
                message_uuid: row.message_uuid.map(|uuid| uuid.to_string()),
                media_id: row.media_id.map(|id| id.to_string()),
                media_name: row.media_name,
                coordinates: coordinates.remove(&row.id).unwrap_or_default(),
                feedback: feedback.remove(&row.id).unwrap_or_default(),
                name: row.name,
                name_key: row.name_key,
                kind: row.kind,
                context_before: row.context_before.unwrap_or_default(),
                context_match: row.context_match.unwrap_or_default(),
                context_after: row.context_after.unwrap_or_default(),
                message_at: row.message_at.and_utc().timestamp_millis(),
                model_name: row.model_name,
                group_is_secret: row.group_is_secret,
            })
            .collect(),
        next_cursor,
    })
}

pub(crate) async fn load_coordinates(
    dbx: &DatabaseConnection,
    mention_ids: Vec<i64>,
) -> anyhow::Result<HashMap<i64, Vec<AiPositionCoordinateItem>>> {
    let mut result: HashMap<i64, Vec<AiPositionCoordinateItem>> =
        HashMap::new();
    if mention_ids.is_empty() {
        return Ok(result);
    }
    let coordinates = ai_position_coordinate::Entity::find()
        .filter(ai_position_coordinate::Column::MentionId.is_in(mention_ids))
        .order_by_asc(ai_position_coordinate::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    for coordinate in coordinates {
        let span = coordinate
            .coord_begin_char
            .zip(coordinate.coord_end_char)
            .map(|(begin, end)| AiPositionSpan { begin, end });
        result.entry(coordinate.mention_id).or_default().push(
            AiPositionCoordinateItem {
                text: coordinate.coordinate_text,
                system: coordinate.coordinate_system,
                mgrs: coordinate.mgrs,
                lat: coordinate.lat,
                lng: coordinate.lng,
                certainty: coordinate.certainty,
                evidence: coordinate.evidence,
                span,
            },
        );
    }
    Ok(result)
}

#[derive(Debug, FromQueryResult)]
struct KnowledgeRow {
    id: i64,
    scope_kind: String,
    scope_key: String,
    scope_name: Option<String>,
    scope_is_secret: bool,
    name: String,
    name_key: String,
    kind: String,
    mgrs: String,
    lat: f64,
    lng: f64,
    certainty: String,
    fact_count: i32,
    conflicting: bool,
    first_fact_at: NaiveDateTime,
    last_fact_at: NaiveDateTime,
}

fn knowledge_conditions(
    global_filter: Option<&str>,
    filters: &[AiPositionColumnFilter],
    values: &mut Vec<Value>,
) -> Result<Vec<String>, AppError> {
    if filters.len() > AI_POSITION_LIST_MAX_FILTERS {
        return Err(AppError::BL {
            msg: "Забагато фільтрів".to_string(),
        });
    }
    let mut conditions = Vec::new();
    let pairs = global_filter
        .map(|value| ("name", value))
        .into_iter()
        .chain(
            filters
                .iter()
                .map(|filter| (filter.id.as_str(), filter.value.as_str())),
        );
    for (id, value) in pairs {
        let value = bounded(value.trim()).context(h!())?;
        if value.is_empty() {
            continue;
        }
        let condition = match (id, value.as_str()) {
            ("name", value) => {
                values.push(
                    format!("%{}%", escape_like(&position_key(value))).into(),
                );
                format!("k.name_key like ${} escape '\\'", values.len())
            }
            ("scope", "aor") => "k.scope_kind = 'aor'".to_string(),
            ("scope", "group") => "k.scope_kind = 'group'".to_string(),
            ("id", value) => {
                let id: i64 = value.parse().map_err(|_| AppError::BL {
                    msg: "Невідома позиція".to_string(),
                })?;
                values.push(id.into());
                format!("k.id = ${}", values.len())
            }
            ("feedback", "є") => "exists (
                 select 1 from ai_position_feedback f
                 where f.target_kind = 'knowledge' and f.name_key = k.name_key
                   and f.scope_kind = k.scope_kind and f.scope_key = k.scope_key
             )"
            .to_string(),
            ("feedback", "немає") => "not exists (
                 select 1 from ai_position_feedback f
                 where f.target_kind = 'knowledge' and f.name_key = k.name_key
                   and f.scope_kind = k.scope_kind and f.scope_key = k.scope_key
             )"
            .to_string(),
            ("kind", value) if AI_POSITION_KINDS.contains(&value) => {
                values.push(value.to_string().into());
                format!("k.kind = ${}", values.len())
            }
            ("near", value) => {
                near_condition("k.lat", "k.lng", value, values).context(h!())?
            }
            (id @ ("from" | "to"), value) => {
                date_condition("k.last_fact_at", id, value, values)
                    .context(h!())?
            }
            ("conflicting", "так") => "k.conflicting".to_string(),
            ("conflicting", "ні") => "not k.conflicting".to_string(),
            ("certainty", value)
                if super::extract::CERTAINTIES.contains(&value) =>
            {
                values.push(value.to_string().into());
                format!("k.certainty = ${}", values.len())
            }
            _ => {
                return Err(AppError::BL {
                    msg: format!("Невідомий фільтр {id}"),
                })
            }
        };
        conditions.push(condition);
    }
    Ok(conditions)
}

pub(crate) async fn list_knowledge(
    dbx: &DatabaseConnection,
    req: AiPositionKnowledgeListReq,
    allowed_groups: Vec<String>,
    access: Access,
) -> Result<AiPositionKnowledgeListRsp, AppError> {
    let limit = req
        .limit
        .map_or(AI_POSITION_LIST_DEFAULT_LIMIT, |limit| limit.max(1) as u64)
        .min(AI_POSITION_LIST_MAX_LIMIT);
    let mut values: Vec<Value> = vec![allowed_groups.into()];
    // Knowledge built from a private group only for admins who can read it.
    let mut conditions = vec![match access {
        // Knowledge built from a private group only for admins who can read it.
        Access::Admin => {
            "not exists (
             select 1 from unnest(k.source_group_keys) source_group
             join signal_group source_sg on source_sg.master_key = source_group
             where source_sg.is_secret and not (source_group = any($1))
         )"
        }
        // Users: only knowledge built entirely from groups they can read.
        Access::User => {
            "cardinality(k.source_group_keys) > 0 and k.source_group_keys <@ $1"
        }
    }
    .to_string()];
    conditions.extend(
        knowledge_conditions(
            req.global_filter.as_deref(),
            &resolve_near_filters(req.column_filters.clone())
                .await
                .context(h!())?,
            &mut values,
        )
        .context(h!())?,
    );
    push_cursor(
        &mut conditions,
        &mut values,
        req.after.as_ref(),
        "k.last_fact_at",
        "k.id",
    )
    .context(h!())?;
    values.push(((limit + 1) as i64).into());
    let sql = format!(
        "select k.id, k.scope_kind, k.scope_key,
                case when k.scope_kind = 'aor' then aor.name else sg.name end as scope_name,
                coalesce(sg.is_secret, false) as scope_is_secret,
                k.name, k.name_key, k.kind, k.mgrs, k.lat, k.lng, k.certainty, k.fact_count,
                k.conflicting, k.first_fact_at, k.last_fact_at
         from ai_position_knowledge k
         left join area_of_responsibility aor
             on k.scope_kind = 'aor' and aor.id::text = k.scope_key
         left join signal_group sg
             on k.scope_kind = 'group' and sg.master_key = k.scope_key
         where {}
         order by k.last_fact_at desc, k.id desc
         limit ${}",
        conditions.join(" and "),
        values.len()
    );
    let mut rows = KnowledgeRow::find_by_statement(
        Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let next_cursor = if rows.len() as u64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|row| AiPositionListCursor {
            at_micros: row.last_fact_at.and_utc().timestamp_micros(),
            id: row.id,
        })
    } else {
        None
    };
    let keys: Vec<(String, String, String)> = rows
        .iter()
        .map(|row| {
            (
                row.scope_kind.clone(),
                row.scope_key.clone(),
                row.name_key.clone(),
            )
        })
        .collect();
    let mut feedback = super::feedback::knowledge_feedback_items(dbx, &keys)
        .await
        .c(h!())?;
    Ok(AiPositionKnowledgeListRsp {
        items: rows
            .into_iter()
            .map(|row| AiPositionKnowledgeItem {
                feedback: feedback
                    .remove(&(
                        row.scope_kind.clone(),
                        row.scope_key.clone(),
                        row.name_key.clone(),
                    ))
                    .unwrap_or_default(),
                id: row.id,
                scope_kind: row.scope_kind,
                scope_key: row.scope_key,
                scope_name: row.scope_name.unwrap_or_default(),
                scope_is_secret: row.scope_is_secret,
                name: row.name,
                name_key: row.name_key,
                kind: row.kind,
                mgrs: row.mgrs,
                lat: row.lat,
                lng: row.lng,
                certainty: row.certainty,
                fact_count: row.fact_count,
                conflicting: row.conflicting,
                first_fact_at: row.first_fact_at.and_utc().timestamp_millis(),
                last_fact_at: row.last_fact_at.and_utc().timestamp_millis(),
            })
            .collect(),
        next_cursor,
    })
}

/// Highlight spans for message cards, by message id. A mention without
/// coordinates of its own shows where the position is known to be, from
/// knowledge the viewer may see and facts near the message's time.
pub(crate) async fn positions_by_message(
    dbx: &DatabaseConnection,
    message_ids: Vec<i64>,
    allowed_groups: &HashSet<String>,
) -> anyhow::Result<HashMap<i64, Vec<crate::rer_importer::highlight::CNPosition>>>
{
    use crate::entities::ai_position_mention;
    let mut result: HashMap<i64, Vec<_>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(result);
    }
    let mentions = ai_position_mention::Entity::find()
        .filter(
            ai_position_mention::Column::SigintInboxItemId.is_in(message_ids),
        )
        .order_by_asc(ai_position_mention::Column::BeginChar)
        .all(dbx)
        .await
        .c(h!())?;
    let mut coordinates = load_coordinates(
        dbx,
        mentions.iter().map(|mention| mention.id).collect(),
    )
    .await
    .c(h!())?;
    let scopes = knowledge::current_scopes(
        dbx,
        mentions
            .iter()
            .filter_map(|mention| mention.group_master_key.clone())
            .collect(),
    )
    .await
    .c(h!())?;
    let known = load_knowledge_for(
        dbx,
        &mentions,
        &coordinates,
        &scopes,
        allowed_groups,
    )
    .await
    .c(h!())?;
    for mention in mentions {
        let Some(message_id) = mention.sigint_inbox_item_id else {
            continue;
        };
        let own: Vec<String> = coordinates
            .remove(&mention.id)
            .unwrap_or_default()
            .into_iter()
            .map(|coordinate| coordinate.mgrs)
            .collect();
        let knowledge = if own.is_empty() {
            best_knowledge(&known, &scopes, &mention)
        } else {
            None
        };
        result.entry(message_id).or_default().push(
            crate::rer_importer::highlight::CNPosition {
                begin: mention.begin_char as usize,
                end: mention.end_char as usize,
                known_mgrs: knowledge.map(|known| known.mgrs.clone()),
                known_at: knowledge.map(|known| {
                    known.last_fact_at.and_utc().timestamp_millis()
                }),
                known_conflicting: knowledge
                    .is_some_and(|known| known.conflicting),
                kind: mention.kind.clone(),
                callsign: None,
                etalon: mention.name_key,
                text: mention.name,
                mgrs: own,
            },
        );
    }
    Ok(result)
}

/// Visible knowledge for the mentions without coordinates of their own.
async fn load_knowledge_for(
    dbx: &DatabaseConnection,
    mentions: &[crate::entities::ai_position_mention::Model],
    coordinates: &HashMap<i64, Vec<AiPositionCoordinateItem>>,
    scopes: &HashMap<String, Vec<knowledge::Scope>>,
    allowed_groups: &HashSet<String>,
) -> anyhow::Result<Vec<ai_position_knowledge::Model>> {
    let mut wanted = sea_orm::Condition::any();
    let mut any = false;
    for mention in mentions
        .iter()
        .filter(|mention| !coordinates.contains_key(&mention.id))
    {
        for scope in mention_scopes(scopes, mention) {
            any = true;
            wanted = wanted.add(
                sea_orm::Condition::all()
                    .add(
                        ai_position_knowledge::Column::ScopeKind.eq(scope.kind),
                    )
                    .add(
                        ai_position_knowledge::Column::ScopeKey
                            .eq(scope.key.clone()),
                    )
                    .add(
                        ai_position_knowledge::Column::NameKey
                            .eq(mention.name_key.clone()),
                    ),
            );
        }
    }
    if !any {
        return Ok(Vec::new());
    }
    let rows = ai_position_knowledge::Entity::find()
        .filter(wanted)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(rows
        .into_iter()
        .filter(|row| knowledge_visible(&row.source_group_keys, allowed_groups))
        .collect())
}

/// A mention's knowledge: one of its scopes, built from facts within the
/// window of the mention's time; the area of responsibility before the
/// single group, then the most recent.
fn best_knowledge<'a>(
    known: &'a [ai_position_knowledge::Model],
    scopes: &HashMap<String, Vec<knowledge::Scope>>,
    mention: &crate::entities::ai_position_mention::Model,
) -> Option<&'a ai_position_knowledge::Model> {
    let window = chrono::Duration::days(AI_POSITION_KNOWLEDGE_WINDOW_DAYS);
    let scopes = mention_scopes(scopes, mention);
    known
        .iter()
        .filter(|row| {
            row.name_key == mention.name_key
                && scopes.iter().any(|scope| {
                    scope.kind == row.scope_kind && scope.key == row.scope_key
                })
                && mention.message_at >= row.first_fact_at - window
                && mention.message_at <= row.last_fact_at + window
        })
        .max_by_key(|row| (row.scope_kind == SCOPE_AOR, row.last_fact_at))
}

/// The scopes a mention's group belongs to now (privacy and AORs as they
/// are, not as they were at parse time).
fn mention_scopes<'a>(
    scopes: &'a HashMap<String, Vec<knowledge::Scope>>,
    mention: &crate::entities::ai_position_mention::Model,
) -> &'a [knowledge::Scope] {
    mention
        .group_master_key
        .as_ref()
        .and_then(|group| scopes.get(group))
        .map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::{filter_conditions, knowledge_visible};
    use crate::ai_position::types::AiPositionColumnFilter;

    fn filter(id: &str, value: &str) -> AiPositionColumnFilter {
        AiPositionColumnFilter {
            id: id.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn builds_whitelisted_filters() {
        let mut values = Vec::new();
        let conditions = filter_conditions(
            Some("ЦИРКОН-9"),
            &[filter("hasCoordinates", "так"), filter("certainty", "high")],
            &mut values,
        )
        .unwrap();
        assert_eq!(conditions.len(), 3);
        assert!(conditions[1].starts_with("exists"));
        assert_eq!(values[0], "%циркон 9%".to_string().into());
        assert!(filter_conditions(
            None,
            &[filter("evil; drop", "x")],
            &mut values
        )
        .is_err());
        assert!(filter_conditions(
            None,
            &[filter("certainty", "x' or 1=1")],
            &mut values
        )
        .is_err());
    }

    #[test]
    fn knowledge_needs_every_source_group() {
        let allowed = ["a".to_string(), "b".to_string()].into_iter().collect();
        assert!(knowledge_visible(&["a".to_string()], &allowed));
        assert!(!knowledge_visible(
            &["a".to_string(), "secret".to_string()],
            &allowed
        ));
        assert!(!knowledge_visible(&[], &allowed));
    }
}
