use crate::config::{
    ANALYSIS_STATS_UNDEFINED_UNIT_ID, DAILY_MESSAGE_STATS_MAX_DAYS,
    DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE,
    DAILY_MESSAGE_STATS_SERIES_PAGE_SIZE,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::group::get_identity_sigint_groups;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_base_role, login_id_from_identity};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{
    DatabaseConnection, DbBackend, FromQueryResult, Statement, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

mod api;
mod cache;
mod catalog;
mod facets;
mod filter_counts;
mod filters;
pub(super) use filters::Access as DailyMessageStatsAccess;
mod panels;
#[cfg(test)]
pub(super) use panels::load as load_panels;
mod types;
pub use api::{daily_catalog, daily_facet_counts, daily_senders};
#[cfg(test)]
pub(super) use catalog::load as load_catalog;
#[cfg(test)]
pub(super) use facets::{
    groups as load_group_counts, senders as load_sender_page,
};
pub(super) use filter_counts::load as load_unit_options;
pub use panels::{
    daily_panels, DailyMessageStatsPanel, DailyMessageStatsPanelsRsp,
};
pub use types::*;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    Copy,
)]
pub enum DailyMessageStatsGrouping {
    #[serde(rename = "Groups")]
    DailyStatsGroups,
    #[serde(rename = "Senders")]
    DailyStatsSenders,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageSenderKey {
    pub sender: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsReq {
    pub user_label_id: Option<i64>,
    pub from_date: String,
    pub to_date: String,
    pub grouping: DailyMessageStatsGrouping,
    pub selected_groups: Option<Vec<String>>,
    pub selected_senders: Option<Vec<DailyMessageSenderKey>>,
    pub selected_unit_ids: Option<Vec<i64>>,
    pub cursor: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsPoint {
    pub messages: i64,
    pub counterparts: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsSeries {
    pub key: Option<String>,
    pub label: String,
    pub points: Vec<DailyMessageStatsPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsRsp {
    pub days: Vec<String>,
    pub series: Vec<DailyMessageStatsSeries>,
    pub total_series: i64,
    pub next_cursor: Option<String>,
    pub generated_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsOptionsReq {
    pub filter: DailyMessageStatsReq,
    pub search: Option<String>,
    pub include_children: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsOption {
    pub key: Option<String>,
    pub label: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsOptionsRsp {
    pub options: Vec<DailyMessageStatsOption>,
    pub next_cursor: Option<String>,
    pub total: i64,
    pub unit_options: Vec<crate::rer_importer::types::UnitStatsOption>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    label: String,
    key: Option<String>,
}

#[derive(FromQueryResult)]
struct Row {
    key: Option<String>,
    label: String,
    total: i64,
    day: Option<String>,
    messages: i64,
    counterparts: i64,
}

fn invalid(message: &str) -> AppError {
    AppError::BL {
        msg: message.to_string(),
    }
}

fn date_range(
    req: &DailyMessageStatsReq,
) -> anyhow::Result<(Vec<String>, NaiveDateTime, NaiveDateTime)> {
    let parse = |value: &str| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| invalid("Вкажіть коректні дати періоду."))
            .c(h!())
    };
    let from = parse(&req.from_date).c(h!())?;
    let to = parse(&req.to_date).c(h!())?;
    let today = Utc::now()
        .with_timezone(&chrono_tz::Europe::Kyiv)
        .date_naive();
    let length = (to - from).num_days() + 1;
    if !(1..=DAILY_MESSAGE_STATS_MAX_DAYS).contains(&length) || to > today {
        return Err(invalid("Оберіть від 1 до 90 днів, не пізніше сьогодні."))
            .c(h!());
    }
    let days = from
        .iter_days()
        .take(length as usize)
        .map(|day| day.to_string())
        .collect();
    let midnight = |day: NaiveDate| -> anyhow::Result<NaiveDateTime> {
        Ok(chrono_tz::Europe::Kyiv
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).c(h!())?)
            .single()
            .c(h!())?
            .with_timezone(&Utc)
            .naive_utc())
    };
    Ok((
        days,
        midnight(from).c(h!())?,
        midnight(to.succ_opt().c(h!())?).c(h!())?,
    ))
}

fn encode_cursor(series: &DailyMessageStatsOption) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            label: series.label.clone(),
            key: series.key.clone(),
        })
        .c(h!())?,
    ))
}

fn decode_cursor(value: &Option<String>) -> anyhow::Result<Option<Cursor>> {
    value
        .as_ref()
        .map(|value| {
            if value.len() > 8192 {
                return Err(invalid("Некоректний курсор статистики.")).c(h!());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| invalid("Некоректний курсор статистики."))
                .c(h!())?;
            serde_json::from_slice(&bytes)
                .map_err(|_| invalid("Некоректний курсор статистики."))
                .c(h!())
        })
        .transpose()
}

fn query_sql(grouping: DailyMessageStatsGrouping, options: bool) -> String {
    let entities = match grouping {
        DailyMessageStatsGrouping::DailyStatsGroups => "select master_key as key, coalesce(nullif(name, ''), master_key) as label from signal_group where master_key = any($1::text[])".to_string(),
        DailyMessageStatsGrouping::DailyStatsSenders => r#"select e.key, coalesce(nullif(l.display_name, ''), l.login, nullif(trim(concat_ws(' ', p.given_name, p.family_name)), ''), s.name, e.key, 'Невідомий відправник') as label
            from (select distinct sender as key from eligible) e
            left join login l on l.id::text = e.key
            left join signal_profile p on p.uuid = e.key
            left join (select uuid, min(nullif(name, '')) as name from echo_sender
                where uuid in (select sender from eligible) group by uuid) s on s.uuid = e.key"#.to_string(),
    };
    let association = match grouping {
        DailyMessageStatsGrouping::DailyStatsGroups => "e.group_key = p.key",
        DailyMessageStatsGrouping::DailyStatsSenders => {
            "(e.sender is null) = (p.key is null) and coalesce(e.sender, '') = coalesce(p.key, '')"
        }
    };
    let counterparts = match grouping {
        DailyMessageStatsGrouping::DailyStatsGroups => "count(distinct row(e.sender is null, e.sender)) filter (where e.id is not null)",
        DailyMessageStatsGrouping::DailyStatsSenders => "count(distinct e.group_key)",
    };
    let selection = if options {
        format!("select p.key, p.label, p.total, null::text as day, count(distinct e.id)::bigint as messages, 0::bigint as counterparts from page p left join eligible e on {association} group by p.key, p.label, p.total order by p.label collate \"C\", p.key is null, coalesce(p.key, '') collate \"C\"")
    } else {
        format!("select p.key, p.label, p.total, e.day, count(distinct e.id)::bigint as messages, {counterparts}::bigint as counterparts from page p left join eligible e on {association} group by p.key, p.label, p.total, e.day order by p.label collate \"C\", p.key is null, coalesce(p.key, '') collate \"C\", e.day")
    };
    let eligible = eligible_sql();
    let page = format!(
        r#"entities as ({entities}), counted as (
        select key, label, count(*) over ()::bigint as total from entities
        where $13::text is null or strpos(lower(label), lower($13::text)) > 0
    ), page as (
        select * from counted where $9::text is null or
          (label collate "C", key is null, coalesce(key, '') collate "C") > ($9::text collate "C", $10::boolean, $11::text collate "C")
        order by label collate "C", key is null, coalesce(key, '') collate "C" limit $12
    )"#
    );
    match grouping {
        DailyMessageStatsGrouping::DailyStatsGroups => {
            let eligible = eligible.replace(
                "and g.group_master_key = any($1::text[])",
                "and g.group_master_key in (select key from page)",
            );
            format!("with {page}, {eligible} {selection}")
        }
        _ => format!("with {eligible}, {page} {selection}"),
    }
}

fn eligible_sql() -> String {
    let sender = "coalesce(g.sender, g.login_id::text)";
    let label_mapping = crate::organism::labels::sender_mapping_sql();
    format!(
        r#"sender_identities as materialized ({label_mapping}), eligible as materialized (
        select distinct m.id, (m.created_at at time zone 'UTC' at time zone 'Europe/Kyiv')::date::text as day,
            g.group_master_key as group_key, {sender} as sender
        from signal_message m join sigint_inbox_item i on i.id = m.id
        join signal_message_group g on g.signal_message_id = m.id
        where not m.deleted and m.created_at >= $2 and m.created_at < $3
          and g.group_master_key = any($1::text[])
          and (not $5 or exists (select 1 from sigint_inbox_item_unit iu join sigint_unit u on u.id = iu.unit_id
               where iu.item_id = m.id and not u.deleted and iu.unit_id = any($4::bigint[]))
               or ({ANALYSIS_STATS_UNDEFINED_UNIT_ID} = any($4::bigint[]) and not exists (
                   select 1 from sigint_inbox_item_unit iu join sigint_unit u on u.id = iu.unit_id
                   where iu.item_id = m.id and not u.deleted)))
          and (not $8 or {sender} = any($6::text[]) or ($7 and {sender} is null))
          and (not $14 or case when $15::bigint = -1 then ({sender} is null or {sender} not in (select ls.sender from sender_identities ls where ls.label_id is not null))
            else {sender} in (select ls.sender from sender_identities ls where ls.label_id=$15::bigint) end)
          and ($16::bigint is null or {sender} in (select sender from sender_identities where organism_id=$16::bigint))
    )"#
    )
}

fn query(
    req: &DailyMessageStatsReq,
    access: DailyMessageStatsAccess,
    since: NaiveDateTime,
    till: NaiveDateTime,
    search: Option<String>,
    options: bool,
) -> anyhow::Result<Statement> {
    let cursor = decode_cursor(&req.cursor).c(h!())?;
    let sql = query_sql(req.grouping, options);
    let limit = if options {
        DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE
    } else {
        DAILY_MESSAGE_STATS_SERIES_PAGE_SIZE
    };
    let mut values = filter_values(req, access.groups, since, till);
    values.extend([
        cursor.as_ref().map(|c| c.label.clone()).into(),
        cursor.as_ref().is_some_and(|c| c.key.is_none()).into(),
        cursor
            .as_ref()
            .and_then(|c| c.key.clone())
            .unwrap_or_default()
            .into(),
        (limit + 1).into(),
        search.into(),
        req.user_label_id.is_some().into(),
        req.user_label_id
            .unwrap_or(crate::config::USER_LABEL_UNASSIGNED_ID)
            .into(),
        access.organism_id.into(),
    ]);
    Ok(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        values,
    ))
}

fn filter_values(
    req: &DailyMessageStatsReq,
    groups: Vec<String>,
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> Vec<Value> {
    let senders = req
        .selected_senders
        .as_ref()
        .map(|values| {
            values
                .iter()
                .filter_map(|key| key.sender.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let unknown = req
        .selected_senders
        .as_ref()
        .is_some_and(|values| values.iter().any(|key| key.sender.is_none()));
    vec![
        groups.into(),
        since.into(),
        till.into(),
        req.selected_unit_ids.clone().unwrap_or_default().into(),
        req.selected_unit_ids.is_some().into(),
        senders.into(),
        unknown.into(),
        req.selected_senders.is_some().into(),
    ]
}

async fn rows(
    db: &DatabaseConnection,
    req: &DailyMessageStatsReq,
    access: DailyMessageStatsAccess,
    search: Option<String>,
    options: bool,
) -> anyhow::Result<(Vec<String>, Vec<Row>)> {
    let (days, since, till) = date_range(req).c(h!())?;
    let statement = query(req, access, since, till, search, options).c(h!())?;
    let rows = Row::find_by_statement(statement)
        .all(&crate::read_query::connection(db))
        .await
        .c(h!())?;
    Ok((days, rows))
}

pub(super) async fn load(
    db: &DatabaseConnection,
    req: &DailyMessageStatsReq,
    allowed: impl Into<DailyMessageStatsAccess>,
) -> anyhow::Result<DailyMessageStatsRsp> {
    let allowed = allowed.into();
    let groups = super::stats::effective_groups_with_access(
        &req.selected_groups,
        &allowed.groups,
    );
    // An explicit empty selection must stay empty after access intersection.
    let groups = if req.selected_groups.as_ref().is_some_and(Vec::is_empty) {
        vec![]
    } else {
        groups
    };
    let (days, rows) = rows(db, req, allowed.with_groups(groups), None, false)
        .await
        .c(h!())?;
    let total_series = rows.first().map_or(0, |row| row.total);
    let mut series = Vec::<DailyMessageStatsSeries>::new();
    let indices: BTreeMap<_, _> = days
        .iter()
        .enumerate()
        .map(|(index, day)| (day.as_str(), index))
        .collect();
    for row in rows {
        if series.last().is_none_or(|entry| entry.key != row.key) {
            series.push(DailyMessageStatsSeries {
                key: row.key,
                label: row.label,
                points: days
                    .iter()
                    .map(|_| DailyMessageStatsPoint {
                        messages: 0,
                        counterparts: 0,
                    })
                    .collect(),
            });
        }
        if let Some(index) = row.day.as_deref().and_then(|day| indices.get(day))
        {
            let entry = series.last_mut().c(h!())?;
            entry.points[*index] = DailyMessageStatsPoint {
                messages: row.messages,
                counterparts: row.counterparts,
            };
        }
    }
    let has_more = series.len() > DAILY_MESSAGE_STATS_SERIES_PAGE_SIZE as usize;
    series.truncate(DAILY_MESSAGE_STATS_SERIES_PAGE_SIZE as usize);
    let next_cursor = if has_more {
        series
            .last()
            .map(|entry| {
                encode_cursor(&DailyMessageStatsOption {
                    key: entry.key.clone(),
                    label: entry.label.clone(),
                    count: 0,
                })
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    Ok(DailyMessageStatsRsp {
        days,
        series,
        total_series,
        next_cursor,
        generated_at_ms: Utc::now().timestamp_millis(),
    })
}

#[post("/api/rer/analysis/stats/daily-messages")]
pub async fn daily_messages(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsReq>,
) -> Result<Json<DailyMessageStatsRsp>, AppError> {
    let (_, allowed, _) = api::access(&user, &env).await.c(h!())?;
    Ok(Json(load(&env.dbx, &req, allowed).await.c(h!())?))
}

#[post("/api/rer/analysis/stats/daily-messages/options")]
pub async fn daily_message_options(
    user: Identity,
    env: Data<Env>,
    req: Json<DailyMessageStatsOptionsReq>,
) -> Result<Json<DailyMessageStatsOptionsRsp>, AppError> {
    let (_, allowed, _) = api::access(&user, &env).await.c(h!())?;
    let mut response = load_options(&env.dbx, &req, allowed.clone())
        .await
        .c(h!())?;
    if req.filter.grouping == DailyMessageStatsGrouping::DailyStatsGroups
        && req.filter.cursor.is_none()
    {
        let hierarchy =
            crate::sigint::unit::hierarchy::load(&env).await.c(h!())?;
        response.unit_options = load_unit_options(
            &env.dbx,
            &req.filter,
            allowed,
            &hierarchy,
            req.include_children.unwrap_or(true),
        )
        .await
        .c(h!())?;
    }
    Ok(Json(response))
}

pub(super) async fn load_options(
    db: &DatabaseConnection,
    req: &DailyMessageStatsOptionsReq,
    allowed: impl Into<DailyMessageStatsAccess>,
) -> anyhow::Result<DailyMessageStatsOptionsRsp> {
    let allowed = allowed.into();
    let mut filter = req.filter.clone();
    let groups = match filter.grouping {
        DailyMessageStatsGrouping::DailyStatsGroups => allowed.groups.clone(),
        DailyMessageStatsGrouping::DailyStatsSenders => {
            filter.selected_senders = None;
            if filter.selected_groups.as_ref().is_some_and(Vec::is_empty) {
                vec![]
            } else {
                super::stats::effective_groups_with_access(
                    &filter.selected_groups,
                    &allowed.groups,
                )
            }
        }
    };
    let (_, rows) = rows(
        db,
        &filter,
        allowed.with_groups(groups),
        req.search
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .cloned(),
        true,
    )
    .await
    .c(h!())?;
    let total = rows.first().map_or(0, |row| row.total);
    let has_more = rows.len() > DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE as usize;
    let options = rows
        .into_iter()
        .take(DAILY_MESSAGE_STATS_OPTIONS_PAGE_SIZE as usize)
        .map(|row| DailyMessageStatsOption {
            key: row.key,
            label: row.label,
            count: row.messages,
        })
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        options.last().map(encode_cursor).transpose().c(h!())?
    } else {
        None
    };
    Ok(DailyMessageStatsOptionsRsp {
        options,
        next_cursor,
        total,
        unit_options: vec![],
    })
}
