use crate::config::{
    ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE,
    ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE,
    ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS,
    ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
    ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS,
    ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC,
    ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX,
};
use crate::entities::{
    datasource_group, goi_association, signal_message, signal_message_group,
};
use crate::error::AppError;
use crate::types::{info, warn, Env, Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::{h, new_pg_pool_from_mode};
use chrono::{
    DateTime, Duration as ChronoDuration, FixedOffset, NaiveDateTime, Utc,
};
use sea_orm::*;
use sea_query::{Expr, Query};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Default, Eq, PartialEq)]
struct BackfillStats {
    scanned: u64,
    filled: u64,
}

#[derive(Debug, FromQueryResult)]
struct MessageCandidate {
    id: i64,
    body: Option<String>,
    message_uid: Option<String>,
}

type OrganismGroupCache = HashMap<i64, Arc<Vec<String>>>;

pub async fn oneoff_backfill_goi_association_message_uids(
    mode: Mode,
    since_ts: Option<&str>,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    info!("starting GOI association message UID backfill");
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let stats = match since_ts {
        Some(since_ts) => {
            let since_ts = parse_since_ts(since_ts).c(h!())?;
            backfill_goi_association_message_uids(&db, Some(&since_ts))
                .await
                .c(h!())?
        }
        None => backfill_latest_goi_association_message_uids(
            &db,
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
        )
        .await
        .c(h!())?,
    };
    info!(
        "GOI association message UID backfill completed: scanned={}, filled={}, elapsed={:?}",
        stats.scanned,
        stats.filled,
        started_at.elapsed()
    );
    if since_ts.is_none() {
        println!(
            "Only the {} newest GOI associations were processed. Pass --since-ts to process the intended range. Example: wdintel-rs --mode live oneoff-backfill-goi-association-message-uids --since-ts 2026-06-15T00:00:00Z",
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT
        );
    }
    Ok(())
}

fn parse_since_ts(value: &str) -> Result<DateTime<FixedOffset>, AppError> {
    DateTime::parse_from_rfc3339(value).map_err(|err| AppError::BL {
        msg: format!(
            "invalid since_ts `{value}`; expected RFC3339, for example `2026-06-15T00:00:00Z`: {err}"
        ),
    })
}

pub async fn goi_association_message_uid_worker_nofail(env: Arc<Env>) {
    loop {
        match goi_association_message_uid_worker_pass(&env).await {
            Ok(Some(stats)) => info!(
                "GOI association message UID worker pass completed: scanned={}, filled={}",
                stats.scanned, stats.filled
            ),
            Ok(None) => {},
            Err(err) => warn!(
                "GOI association message UID worker pass failed: {err:#}"
            ),
        }
        tokio::time::sleep(Duration::from_secs(
            ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC,
        ))
        .await;
    }
}

async fn goi_association_message_uid_worker_pass(
    env: &Env,
) -> Result<Option<BackfillStats>, AppError> {
    if !crate::system_settings::goi_association_message_uid_worker_enabled(
        &env.dbx,
    )
    .await
    .c(h!())?
    {
        return Ok(None);
    }

    Ok(Some(
        backfill_goi_association_message_uids(&env.dbx, None)
            .await
            .c(h!())?,
    ))
}

async fn backfill_goi_association_message_uids(
    db: &DatabaseConnection,
    since_ts: Option<&DateTime<FixedOffset>>,
) -> Result<BackfillStats, AppError> {
    let mut stats = BackfillStats::default();
    let mut group_cache = OrganismGroupCache::new();
    let mut after_id = 0;
    loop {
        let associations = load_association_batch(db, after_id, since_ts)
            .await
            .c(h!())?;
        let Some(last_association) = associations.last() else {
            break;
        };
        after_id = last_association.id;
        fill_association_message_uids(
            db,
            associations,
            &mut group_cache,
            &mut stats,
        )
        .await
        .c(h!())?;
    }
    Ok(stats)
}

async fn backfill_latest_goi_association_message_uids(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<BackfillStats, AppError> {
    let associations =
        latest_associations_query(limit).all(db).await.c(h!())?;
    let mut stats = BackfillStats::default();
    let mut group_cache = OrganismGroupCache::new();
    fill_association_message_uids(
        db,
        associations,
        &mut group_cache,
        &mut stats,
    )
    .await
    .c(h!())?;
    Ok(stats)
}

fn latest_associations_query(limit: u64) -> Select<goi_association::Entity> {
    goi_association::Entity::find()
        .order_by_desc(goi_association::Column::Id)
        .limit(limit)
}

async fn fill_association_message_uids(
    db: &DatabaseConnection,
    associations: Vec<goi_association::Model>,
    group_cache: &mut OrganismGroupCache,
    stats: &mut BackfillStats,
) -> Result<(), AppError> {
    stats.scanned += associations.len() as u64;
    for association in associations {
        if association.message_uid.is_some() {
            continue;
        }
        let group_keys = organism_signal_group_keys(
            db,
            association.organism_id,
            group_cache,
        )
        .await
        .c(h!())?;
        if group_keys.is_empty() {
            continue;
        }
        let Some(message_uid) =
            find_association_message_uid(db, &association, &group_keys)
                .await
                .c(h!())?
        else {
            continue;
        };
        let update = goi_association::Entity::update_many()
            .col_expr(
                goi_association::Column::MessageUid,
                Expr::value(message_uid),
            )
            .filter(goi_association::Column::Id.eq(association.id))
            .filter(goi_association::Column::MessageUid.is_null())
            .exec(db)
            .await
            .c(h!())?;
        stats.filled += update.rows_affected;
    }
    Ok(())
}

async fn organism_signal_group_keys(
    db: &DatabaseConnection,
    organism_id: i64,
    group_cache: &mut OrganismGroupCache,
) -> Result<Arc<Vec<String>>, AppError> {
    if let Some(group_keys) = group_cache.get(&organism_id) {
        return Ok(group_keys.clone());
    }
    let group_keys = Arc::new(
        crate::organism::bl::load_organism_group_ids(db, organism_id)
            .await
            .c(h!())?
            .available_keys,
    );
    group_cache.insert(organism_id, group_keys.clone());
    Ok(group_keys)
}

async fn load_association_batch(
    db: &DatabaseConnection,
    after_id: i64,
    since_ts: Option<&DateTime<FixedOffset>>,
) -> Result<Vec<goi_association::Model>, AppError> {
    let mut query = goi_association::Entity::find()
        .filter(goi_association::Column::Id.gt(after_id))
        .filter(goi_association::Column::MessageUid.is_null())
        .order_by_asc(goi_association::Column::Id)
        .limit(ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE);
    if let Some(since_ts) = since_ts {
        query = query.filter(
            goi_association::Column::SourceCreatedAt.gte(since_ts.to_owned()),
        );
    }
    Ok(query.all(db).await.c(h!())?)
}

async fn find_association_message_uid(
    db: &DatabaseConnection,
    association: &goi_association::Model,
    group_keys: &[String],
) -> Result<Option<String>, AppError> {
    let Some(association_message) =
        association_original_message(&association.row)
    else {
        return Ok(None);
    };
    let Some(probe) = message_probe(association_message) else {
        return Ok(None);
    };
    let window_anchor = message_window_anchor(
        association.source_date.as_ref(),
        &association.source_created_at,
    );
    let (window_start, window_end) = signal_message_window(window_anchor);
    let mut offset = 0;
    let mut newest_duplicate_uid = None;
    loop {
        let candidates = load_message_candidate_batch(
            db,
            &probe,
            window_start,
            window_end,
            group_keys,
            offset,
        )
        .await
        .c(h!())?;
        let candidate_count = candidates.len() as u64;
        if let Some(message_uid) = select_matching_original_message_uid(
            association_message,
            candidates,
            &mut newest_duplicate_uid,
        ) {
            return Ok(Some(message_uid));
        }
        if candidate_count < ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE {
            return Ok(newest_duplicate_uid);
        }
        offset += candidate_count;
    }
}

async fn load_message_candidate_batch(
    db: &DatabaseConnection,
    probe: &str,
    window_start: NaiveDateTime,
    window_end: NaiveDateTime,
    group_keys: &[String],
    offset: u64,
) -> Result<Vec<MessageCandidate>, AppError> {
    Ok(signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::Body)
        .column(signal_message::Column::MessageUid)
        .filter(signal_message::Column::Timestamp.gte(window_start))
        .filter(signal_message::Column::Timestamp.lte(window_end))
        .filter(signal_message::Column::MessageUid.is_not_null())
        .filter(signal_message::Column::MessageUid.ne(""))
        .filter(message_in_organism_groups(group_keys))
        .filter(
            Expr::col(signal_message::Column::Body)
                .like(format!("%{}%", escape_like(probe))),
        )
        .order_by_desc(signal_message::Column::Timestamp)
        .order_by_desc(signal_message::Column::Id)
        .limit(ORGANISM_GOI_MESSAGE_UID_CANDIDATE_BATCH_SIZE)
        .offset(offset)
        .into_model::<MessageCandidate>()
        .all(db)
        .await
        .c(h!())?)
}

fn message_in_organism_groups(group_keys: &[String]) -> Condition {
    let linked_message_ids = Query::select()
        .column(signal_message_group::Column::SignalMessageId)
        .from(signal_message_group::Entity)
        .and_where(
            signal_message_group::Column::GroupMasterKey
                .eq_any(group_keys.to_vec()),
        )
        .to_owned();
    let datasource_group_ids = Query::select()
        .column(datasource_group::Column::Id)
        .from(datasource_group::Entity)
        .and_where(
            datasource_group::Column::GroupMasterKey
                .eq_any(group_keys.to_vec()),
        )
        .to_owned();

    Condition::any()
        .add(signal_message::Column::Id.in_subquery(linked_message_ids))
        .add(
            signal_message::Column::DatasourceGroupId
                .in_subquery(datasource_group_ids),
        )
}

fn association_original_message(row: &serde_json::Value) -> Option<&str> {
    row.get("cells")?
        .get(ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX)?
        .get("value")?
        .as_str()
        .map(str::trim)
        .filter(|message| !message.is_empty())
}

fn message_probe(message: &str) -> Option<String> {
    let message = message.trim();
    if message.is_empty() {
        return None;
    }
    let characters = message.chars().collect::<Vec<_>>();
    if characters.len() <= ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS {
        return Some(message.to_string());
    }
    let start = (characters.len() - ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS) / 2;
    Some(
        characters[start..start + ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS]
            .iter()
            .collect(),
    )
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn signal_message_window(
    window_anchor: &DateTime<FixedOffset>,
) -> (NaiveDateTime, NaiveDateTime) {
    let window_end = window_anchor.with_timezone(&Utc).naive_utc();
    let window_start = window_end
        - ChronoDuration::hours(ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS);
    (window_start, window_end)
}

fn message_window_anchor<'a>(
    source_date: Option<&'a DateTime<FixedOffset>>,
    source_created_at: &'a DateTime<FixedOffset>,
) -> &'a DateTime<FixedOffset> {
    source_date.unwrap_or(source_created_at)
}

fn select_matching_original_message_uid(
    association_message: &str,
    candidates: Vec<MessageCandidate>,
    newest_duplicate_uid: &mut Option<String>,
) -> Option<String> {
    for candidate in candidates {
        let Some(candidate_body) = candidate.body.as_deref() else {
            continue;
        };
        if !message_bodies_match(association_message, candidate_body) {
            continue;
        }
        let Some(message_uid) = candidate.message_uid else {
            continue;
        };
        if !is_duplicate_trace(candidate.id, &message_uid) {
            return Some(message_uid);
        }
        if newest_duplicate_uid.is_none() {
            *newest_duplicate_uid = Some(message_uid);
        }
    }
    None
}

fn message_bodies_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    !left.is_empty()
        && !right.is_empty()
        && (left.contains(right) || right.contains(left))
}

fn is_duplicate_trace(message_id: i64, message_uid: &str) -> bool {
    message_uid
        .strip_prefix("duplicate-trace-")
        .and_then(|message_id| message_id.parse::<i64>().ok())
        == Some(message_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_since_ts_as_rfc3339() {
        assert_eq!(
            parse_since_ts("2026-06-15T08:00:00Z").unwrap(),
            DateTime::parse_from_rfc3339("2026-06-15T08:00:00Z").unwrap()
        );
        assert!(parse_since_ts("2026-06-15").is_err());
    }

    #[test]
    fn default_oneoff_query_selects_ten_newest_associations() {
        let sql = latest_associations_query(
            ORGANISM_GOI_MESSAGE_UID_ONEOFF_DEFAULT_LIMIT,
        )
        .build(DbBackend::Postgres)
        .to_string();

        assert!(sql.contains("ORDER BY \"goi_association\".\"id\" DESC"));
        assert!(sql.contains("LIMIT 10"));
    }

    #[test]
    fn candidate_scope_uses_organism_signal_groups() {
        let sql = signal_message::Entity::find()
            .filter(message_in_organism_groups(&["allowed-group".to_string()]))
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("signal_message_group"));
        assert!(sql.contains("datasource_group"));
        assert!(sql.contains("group_master_key"));
    }

    #[test]
    fn association_original_message_decodes_json_escaping() {
        let mut cells = vec![
            serde_json::Value::Null;
            ORGANISM_GOI_ORIGINAL_MESSAGE_CELL_INDEX
        ];
        cells.push(serde_json::json!({
            "kind": "string",
            "value": "first line\nquoted \"message\""
        }));
        let encoded = serde_json::to_string(&serde_json::json!({
            "cells": cells
        }))
        .unwrap();
        assert!(encoded.contains("\\n"));
        let row = serde_json::from_str(&encoded).unwrap();

        assert_eq!(
            association_original_message(&row),
            Some("first line\nquoted \"message\"")
        );
    }

    #[test]
    fn message_probe_escapes_like_wildcards() {
        assert_eq!(escape_like(r"a\\b%c_d"), r"a\\\\b\%c\_d");
    }

    #[test]
    fn message_probe_uses_middle_twenty_unicode_characters() {
        let message = "початок-1234567890ABCDEFGHIJ-кінець";
        let probe = message_probe(message).unwrap();

        assert_eq!(probe.chars().count(), 20);
        assert!(message.contains(&probe));
        assert_eq!(message_probe("коротке"), Some("коротке".to_string()));
    }

    #[test]
    fn message_bodies_match_in_both_directions() {
        assert!(message_bodies_match("prefix message suffix", "message"));
        assert!(message_bodies_match("message", "prefix message suffix"));
        assert!(!message_bodies_match("message one", "message two"));
    }

    #[test]
    fn signal_message_window_is_previous_twenty_four_hours() {
        let window_anchor = FixedOffset::east_opt(2 * 60 * 60)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 21, 12, 0, 0)
            .unwrap();

        let (start, end) = signal_message_window(&window_anchor);

        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 7, 21, 10, 0, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(start, end - ChronoDuration::hours(24));
    }

    #[test]
    fn message_window_anchor_prefers_source_date_and_falls_back_to_created_at()
    {
        let source_date =
            DateTime::parse_from_rfc3339("2026-06-15T08:00:00Z").unwrap();
        let source_created_at =
            DateTime::parse_from_rfc3339("2026-07-21T10:00:00Z").unwrap();

        assert_eq!(
            message_window_anchor(Some(&source_date), &source_created_at),
            &source_date
        );
        assert_eq!(
            message_window_anchor(None, &source_created_at),
            &source_created_at
        );
    }

    #[test]
    fn matching_prefers_original_then_falls_back_to_newest_duplicate() {
        let duplicate = test_message(3, "duplicate-trace-3", "message");
        let original = test_message(2, "original-uid", "prefix message suffix");
        let older_duplicate =
            test_message(1, "duplicate-trace-1", "prefix message suffix");

        let mut newest_duplicate_uid = None;
        let selected = select_matching_original_message_uid(
            "message",
            vec![duplicate, original, older_duplicate],
            &mut newest_duplicate_uid,
        )
        .unwrap();
        assert_eq!(selected, "original-uid");

        let mut newest_duplicate_uid = None;
        let selected = select_matching_original_message_uid(
            "message",
            vec![
                test_message(3, "duplicate-trace-3", "message"),
                test_message(1, "duplicate-trace-1", "prefix message suffix"),
            ],
            &mut newest_duplicate_uid,
        );
        assert_eq!(selected, None);
        assert_eq!(newest_duplicate_uid.as_deref(), Some("duplicate-trace-3"));
    }

    fn test_message(
        id: i64,
        message_uid: &str,
        body: &str,
    ) -> MessageCandidate {
        MessageCandidate {
            id,
            body: Some(body.to_string()),
            message_uid: Some(message_uid.to_string()),
        }
    }
}
