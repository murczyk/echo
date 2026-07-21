use crate::config::{
    ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE,
    ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS,
    ORGANISM_GOI_MESSAGE_UID_PROBE_CHARS,
    ORGANISM_GOI_MESSAGE_UID_WORKER_SLEEP_SEC,
};
use crate::entities::{goi_association, signal_message};
use crate::error::AppError;
use crate::types::{info, warn, Env, Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use chrono::{
    DateTime, Duration as ChronoDuration, FixedOffset, NaiveDateTime, Utc,
};
use sea_orm::*;
use sea_query::Expr;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Default, Eq, PartialEq)]
struct BackfillStats {
    scanned: u64,
    filled: u64,
}

pub async fn oneoff_backfill_goi_association_message_uids(
    mode: Mode,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    info!("starting GOI association message UID backfill");
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let stats = backfill_goi_association_message_uids(&db).await.c(h!())?;
    info!(
        "GOI association message UID backfill completed: scanned={}, filled={}, elapsed={:?}",
        stats.scanned,
        stats.filled,
        started_at.elapsed()
    );
    Ok(())
}

pub async fn goi_association_message_uid_worker_nofail(env: Arc<Env>) {
    loop {
        match backfill_goi_association_message_uids(&env.dbx).await {
            Ok(stats) => info!(
                "GOI association message UID worker pass completed: scanned={}, filled={}",
                stats.scanned, stats.filled
            ),
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

async fn backfill_goi_association_message_uids(
    db: &DatabaseConnection,
) -> Result<BackfillStats, AppError> {
    let mut stats = BackfillStats::default();
    let mut after_id = 0;
    loop {
        let associations =
            load_association_batch(db, after_id).await.c(h!())?;
        let Some(last_association) = associations.last() else {
            break;
        };
        after_id = last_association.id;
        stats.scanned += associations.len() as u64;

        for association in associations {
            let Some(message_uid) =
                find_association_message_uid(db, &association)
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
    }
    Ok(stats)
}

async fn load_association_batch(
    db: &DatabaseConnection,
    after_id: i64,
) -> Result<Vec<goi_association::Model>, AppError> {
    Ok(goi_association::Entity::find()
        .filter(goi_association::Column::Id.gt(after_id))
        .filter(goi_association::Column::MessageUid.is_null())
        .order_by_asc(goi_association::Column::Id)
        .limit(ORGANISM_GOI_MESSAGE_UID_BATCH_SIZE)
        .all(db)
        .await
        .c(h!())?)
}

async fn find_association_message_uid(
    db: &DatabaseConnection,
    association: &goi_association::Model,
) -> Result<Option<String>, AppError> {
    let Some(association_message) =
        association_original_message(&association.row)
    else {
        return Ok(None);
    };
    let Some(probe) = message_probe(association_message) else {
        return Ok(None);
    };
    let (window_start, window_end) =
        signal_message_window(&association.source_created_at);
    let candidates = signal_message::Entity::find()
        .filter(signal_message::Column::Timestamp.gte(window_start))
        .filter(signal_message::Column::Timestamp.lte(window_end))
        .filter(signal_message::Column::MessageUid.is_not_null())
        .filter(signal_message::Column::MessageUid.ne(""))
        .filter(
            Expr::col(signal_message::Column::Body)
                .like(format!("%{}%", escape_like(&probe))),
        )
        .order_by_desc(signal_message::Column::Timestamp)
        .order_by_desc(signal_message::Column::Id)
        .all(db)
        .await
        .c(h!())?;

    Ok(select_matching_message(association_message, candidates)
        .and_then(|message| message.message_uid))
}

fn association_original_message(row: &serde_json::Value) -> Option<&str> {
    row.get("cells")?
        .get(13)?
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
    association_created_at: &DateTime<FixedOffset>,
) -> (NaiveDateTime, NaiveDateTime) {
    let window_end = association_created_at.with_timezone(&Utc).naive_utc();
    let window_start = window_end
        - ChronoDuration::hours(ORGANISM_GOI_MESSAGE_UID_LOOKBACK_HOURS);
    (window_start, window_end)
}

fn select_matching_message(
    association_message: &str,
    candidates: Vec<signal_message::Model>,
) -> Option<signal_message::Model> {
    let mut newest_duplicate = None;
    for candidate in candidates {
        let Some(candidate_body) = candidate.body.as_deref() else {
            continue;
        };
        if !message_bodies_match(association_message, candidate_body) {
            continue;
        }
        if !is_duplicate_trace(&candidate) {
            return Some(candidate);
        }
        if newest_duplicate.is_none() {
            newest_duplicate = Some(candidate);
        }
    }
    newest_duplicate
}

fn message_bodies_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    !left.is_empty()
        && !right.is_empty()
        && (left.contains(right) || right.contains(left))
}

fn is_duplicate_trace(message: &signal_message::Model) -> bool {
    message
        .message_uid
        .as_deref()
        .and_then(|message_uid| message_uid.strip_prefix("duplicate-trace-"))
        .and_then(|message_id| message_id.parse::<i64>().ok())
        == Some(message.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn association_original_message_decodes_json_escaping() {
        let mut cells = vec![serde_json::Value::Null; 13];
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
        let association_created_at = FixedOffset::east_opt(2 * 60 * 60)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 21, 12, 0, 0)
            .unwrap();

        let (start, end) = signal_message_window(&association_created_at);

        assert_eq!(
            end,
            Utc.with_ymd_and_hms(2026, 7, 21, 10, 0, 0)
                .unwrap()
                .naive_utc()
        );
        assert_eq!(start, end - ChronoDuration::hours(24));
    }

    #[test]
    fn matching_prefers_original_then_falls_back_to_newest_duplicate() {
        let duplicate = test_message(3, "duplicate-trace-3", "message");
        let original = test_message(2, "original-uid", "prefix message suffix");
        let older_duplicate =
            test_message(1, "duplicate-trace-1", "prefix message suffix");

        let selected = select_matching_message(
            "message",
            vec![duplicate.clone(), original.clone(), older_duplicate.clone()],
        )
        .unwrap();
        assert_eq!(selected.id, original.id);

        let selected = select_matching_message(
            "message",
            vec![duplicate.clone(), older_duplicate],
        )
        .unwrap();
        assert_eq!(selected.id, duplicate.id);
    }

    fn test_message(
        id: i64,
        message_uid: &str,
        body: &str,
    ) -> signal_message::Model {
        signal_message::Model {
            id,
            body: Some(body.to_string()),
            created_at: NaiveDateTime::default(),
            timestamp: Some(NaiveDateTime::default()),
            sender: None,
            format: None,
            deleted: message_uid.starts_with("duplicate-trace-"),
            external_id: None,
            message_uid: Some(message_uid.to_string()),
            datasource_group_id: None,
            operator_tags: None,
            echo_inbox_message_id: None,
            attachments_hash: None,
        }
    }
}
