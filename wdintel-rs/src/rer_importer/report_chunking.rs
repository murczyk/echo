use crate::error::AppError;
use crate::h;
use crate::rer_importer::types::{InboxMessagesReq, InboxMessagesSortBy};
use crate::types::Env;
use crate::utils::dt_from_millis;
use anyhow::Context;
use chrono::NaiveDateTime;
use sea_orm::prelude::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
    QueryTrait, Select,
};
use std::cmp::Ordering;

use crate::entities::{intel_product, sigint_inbox_item, signal_message};

const MILLIS_PER_HOUR: i64 = 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportPeriodEnd {
    Inclusive,
    NonInclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReportPeriodChunk {
    pub since_ms: i64,
    pub till_ms: i64,
    pub end: ReportPeriodEnd,
}

pub fn report_period_chunks(
    since_ms: i64,
    till_ms: i64,
    chunking_hours: i64,
    final_end: ReportPeriodEnd,
) -> Result<Vec<ReportPeriodChunk>, AppError> {
    let window_ms = chunking_hours
        .checked_mul(MILLIS_PER_HOUR)
        .filter(|window_ms| *window_ms > 0)
        .ok_or_else(|| AppError::BL {
            msg: "Некоректне вікно обробки звіту".to_string(),
        })
        .context(h!())?;
    let period_is_valid = match final_end {
        ReportPeriodEnd::Inclusive => since_ms <= till_ms,
        ReportPeriodEnd::NonInclusive => since_ms < till_ms,
    };
    if !period_is_valid {
        return Err(AppError::BL {
            msg: "Некоректний період звіту".to_string(),
        });
    }
    let period_ms = i128::from(till_ms) - i128::from(since_ms);
    let window_ms_i128 = i128::from(window_ms);
    let chunk_count = if period_ms == 0 {
        1
    } else {
        (period_ms + window_ms_i128 - 1) / window_ms_i128
    };
    if chunk_count > crate::config::RER_REPORT_CHUNKS_MAX as i128 {
        return Err(AppError::BL {
            msg: "Період звіту утворює забагато частин".to_string(),
        });
    }

    let mut chunks = Vec::with_capacity(chunk_count as usize);
    let mut chunk_since = since_ms;
    loop {
        let chunk_limit = chunk_since.checked_add(window_ms).unwrap_or(till_ms);
        if chunk_limit >= till_ms {
            chunks.push(ReportPeriodChunk {
                since_ms: chunk_since,
                till_ms,
                end: final_end,
            });
            break;
        }
        chunks.push(ReportPeriodChunk {
            since_ms: chunk_since,
            till_ms: chunk_limit,
            end: ReportPeriodEnd::NonInclusive,
        });
        chunk_since = chunk_limit;
    }
    Ok(chunks)
}

pub fn inbox_report_period_chunks(
    req: &InboxMessagesReq,
    chunking_hours: i64,
) -> Result<Vec<ReportPeriodChunk>, AppError> {
    let since_ms = req
        .since_date_inclusive_ms
        .ok_or_else(|| AppError::BL {
            msg: "Since date must be specified".to_string(),
        })
        .context(h!())?;
    let till_ms = req
        .till_date_inclusive_ms
        .ok_or_else(|| AppError::BL {
            msg: "Until date must be specified".to_string(),
        })
        .context(h!())?;
    Ok(report_period_chunks(
        since_ms,
        till_ms,
        chunking_hours,
        ReportPeriodEnd::Inclusive,
    )
    .context(h!())?)
}

pub fn inbox_report_chunk_req(
    req: &InboxMessagesReq,
    chunk: ReportPeriodChunk,
) -> InboxMessagesReq {
    let mut chunk_req = req.clone();
    chunk_req.since_date_inclusive_ms = Some(chunk.since_ms);
    chunk_req.till_date_inclusive_ms = Some(chunk.till_ms);
    chunk_req
}

pub fn restrict_inbox_report_to_message_ids<Q>(query: Q, ids: &[i64]) -> Q
where
    Q: QueryFilter,
{
    if ids.is_empty() {
        return query.filter(Expr::cust("FALSE"));
    }
    query.filter(signal_message::Column::Id.eq_any(ids.to_vec()))
}

pub fn exclude_inbox_report_linked_intel_products<Q>(query: Q) -> Q
where
    Q: QueryFilter,
{
    let linked_message_ids = intel_product::Entity::find()
        .select_only()
        .column(intel_product::Column::IntelMessageId)
        .filter(intel_product::relation_kind_is_in([
            intel_product::RELATION_KIND_COMMENT,
            intel_product::RELATION_KIND_REPORT,
        ]))
        .into_query();
    query.filter(signal_message::Column::Id.not_in_subquery(linked_message_ids))
}

pub fn report_chunk_exclusive_till(
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Option<NaiveDateTime>, AppError> {
    match period_end {
        ReportPeriodEnd::Inclusive => Ok(None),
        ReportPeriodEnd::NonInclusive => {
            let till_ms = req
                .till_date_inclusive_ms
                .ok_or_else(|| AppError::BL {
                    msg: "Until date must be specified".to_string(),
                })
                .context(h!())?;
            Ok(Some(dt_from_millis(till_ms).context(h!())?))
        }
    }
}

pub fn oldest_first_inbox_report_req(
    req: &InboxMessagesReq,
) -> InboxMessagesReq {
    let mut req = req.clone();
    req.load_latest = Some(false);
    req.newest_first = Some(false);
    req
}

pub fn compare_inbox_report_message_oldest_first(
    req: &InboxMessagesReq,
    left_datetime: Option<NaiveDateTime>,
    left_timestamp: Option<NaiveDateTime>,
    left_id: i64,
    right_datetime: Option<NaiveDateTime>,
    right_timestamp: Option<NaiveDateTime>,
    right_id: i64,
) -> Ordering {
    let (left, right) = match req
        .sort_by
        .unwrap_or(InboxMessagesSortBy::IMSDatetime)
    {
        InboxMessagesSortBy::IMSDatetime => (left_datetime, right_datetime),
        InboxMessagesSortBy::IMSTimestamp => (left_timestamp, right_timestamp),
    };
    compare_optional_datetime(left, right).then_with(|| left_id.cmp(&right_id))
}

fn compare_optional_datetime(
    left: Option<NaiveDateTime>,
    right: Option<NaiveDateTime>,
) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
    }
}

pub async fn build_filtered_inbox_report_chunk_query<'a, 'async_trait, C>(
    dbx: &'a C,
    login: &uuid::Uuid,
    env: &Env,
    req: &InboxMessagesReq,
    period_end: ReportPeriodEnd,
) -> Result<Select<signal_message::Entity>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut query_req = req.clone();
    if period_end == ReportPeriodEnd::NonInclusive {
        query_req.till_date_inclusive_ms = None;
    }
    let query = crate::rer_importer::inbox::query::build_filtered_inbox_query(
        dbx, login, env, &query_req,
    )
    .await
    .context(h!())?;
    if period_end == ReportPeriodEnd::Inclusive {
        return Ok(query);
    }

    let till = req
        .till_date_inclusive_ms
        .ok_or_else(|| AppError::BL {
            msg: "Until date must be specified".to_string(),
        })
        .context(h!())?;
    let till = dt_from_millis(till).context(h!())?;
    Ok(
        match req.sort_by.unwrap_or(InboxMessagesSortBy::IMSDatetime) {
            InboxMessagesSortBy::IMSDatetime => {
                query.filter(sigint_inbox_item::Column::Datetime.lt(till))
            }
            InboxMessagesSortBy::IMSTimestamp => {
                query.filter(signal_message::Column::Timestamp.lt(till))
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = MILLIS_PER_HOUR;

    #[test]
    fn keeps_short_and_exact_periods_in_one_chunk() {
        assert_eq!(
            report_period_chunks(
                0,
                12 * HOUR - 1,
                12,
                ReportPeriodEnd::Inclusive
            )
            .unwrap(),
            vec![ReportPeriodChunk {
                since_ms: 0,
                till_ms: 12 * HOUR - 1,
                end: ReportPeriodEnd::Inclusive,
            }]
        );
        assert_eq!(
            report_period_chunks(
                0,
                12 * HOUR,
                12,
                ReportPeriodEnd::NonInclusive
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn splits_multi_window_period_without_gaps() {
        assert_eq!(
            report_period_chunks(
                0,
                25 * HOUR,
                12,
                ReportPeriodEnd::NonInclusive
            )
            .unwrap(),
            vec![
                ReportPeriodChunk {
                    since_ms: 0,
                    till_ms: 12 * HOUR,
                    end: ReportPeriodEnd::NonInclusive,
                },
                ReportPeriodChunk {
                    since_ms: 12 * HOUR,
                    till_ms: 24 * HOUR,
                    end: ReportPeriodEnd::NonInclusive,
                },
                ReportPeriodChunk {
                    since_ms: 24 * HOUR,
                    till_ms: 25 * HOUR,
                    end: ReportPeriodEnd::NonInclusive,
                },
            ]
        );
    }

    #[test]
    fn only_inclusive_report_final_chunk_is_inclusive() {
        let chunks =
            report_period_chunks(0, 25 * HOUR, 12, ReportPeriodEnd::Inclusive)
                .unwrap();
        assert_eq!(chunks[0].end, ReportPeriodEnd::NonInclusive);
        assert_eq!(chunks[1].end, ReportPeriodEnd::NonInclusive);
        assert_eq!(chunks[2].end, ReportPeriodEnd::Inclusive);
    }

    #[test]
    fn builds_inbox_requests_for_each_period_chunk() {
        let req = InboxMessagesReq {
            since_date_inclusive_ms: Some(0),
            till_date_inclusive_ms: Some(25 * HOUR),
            selected_freqs: Some(vec!["100.000".to_string()]),
            ..Default::default()
        };

        let chunks = inbox_report_period_chunks(&req, 12).unwrap();
        let requests = chunks
            .iter()
            .copied()
            .map(|chunk| inbox_report_chunk_req(&req, chunk))
            .collect::<Vec<_>>();

        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].end, ReportPeriodEnd::NonInclusive);
        assert_eq!(chunks[2].end, ReportPeriodEnd::Inclusive);
        assert_eq!(requests[0].since_date_inclusive_ms, Some(0));
        assert_eq!(requests[0].till_date_inclusive_ms, Some(12 * HOUR));
        assert_eq!(requests[1].since_date_inclusive_ms, Some(12 * HOUR));
        assert_eq!(requests[2].till_date_inclusive_ms, Some(25 * HOUR));
        assert_eq!(requests[2].selected_freqs, req.selected_freqs);
    }

    #[test]
    fn rejects_invalid_window_and_periods() {
        assert!(report_period_chunks(0, HOUR, 0, ReportPeriodEnd::Inclusive)
            .is_err());
        assert!(report_period_chunks(
            0,
            HOUR,
            i64::MAX,
            ReportPeriodEnd::Inclusive
        )
        .is_err());
        assert!(report_period_chunks(HOUR, 0, 1, ReportPeriodEnd::Inclusive)
            .is_err());
        assert!(report_period_chunks(
            HOUR,
            HOUR,
            1,
            ReportPeriodEnd::NonInclusive
        )
        .is_err());
        assert!(report_period_chunks(
            0,
            (crate::config::RER_REPORT_CHUNKS_MAX as i64 + 1) * HOUR,
            1,
            ReportPeriodEnd::NonInclusive,
        )
        .is_err());
    }

    #[test]
    fn compares_collected_messages_oldest_first() {
        let older_datetime =
            NaiveDateTime::parse_from_str("2026-08-14 10:00:00", "%F %T")
                .unwrap();
        let newer_datetime =
            NaiveDateTime::parse_from_str("2026-08-14 11:00:00", "%F %T")
                .unwrap();

        assert_eq!(
            compare_inbox_report_message_oldest_first(
                &InboxMessagesReq::default(),
                Some(older_datetime),
                Some(newer_datetime),
                1,
                Some(newer_datetime),
                Some(older_datetime),
                2,
            ),
            Ordering::Less,
        );
        assert_eq!(
            compare_inbox_report_message_oldest_first(
                &InboxMessagesReq {
                    sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
                    newest_first: Some(true),
                    ..Default::default()
                },
                Some(older_datetime),
                Some(newer_datetime),
                1,
                Some(newer_datetime),
                Some(older_datetime),
                2,
            ),
            Ordering::Greater,
        );
    }

    #[test]
    fn report_request_ignores_analysis_list_direction() {
        let req = oldest_first_inbox_report_req(&InboxMessagesReq {
            load_latest: Some(true),
            newest_first: Some(true),
            ..Default::default()
        });

        assert_eq!(req.load_latest, Some(false));
        assert_eq!(req.newest_first, Some(false));
    }

    #[test]
    fn restrict_inbox_report_to_message_ids_uses_id_list() {
        use sea_orm::{DbBackend, EntityTrait, QueryTrait};

        let sql = restrict_inbox_report_to_message_ids(
            signal_message::Entity::find(),
            &[10, 20, 30],
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert!(
            sql.contains(r#""signal_message"."id""#)
                && (sql.contains(" IN (") || sql.contains(" = ANY(")),
            "{sql}"
        );
        assert!(!sql.contains("matching_unit_network_ids"), "{sql}");
    }

    #[test]
    fn restrict_inbox_report_to_message_ids_empty_is_false() {
        use sea_orm::{DbBackend, EntityTrait, QueryTrait};

        let sql = restrict_inbox_report_to_message_ids(
            signal_message::Entity::find(),
            &[],
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert!(sql.contains("FALSE"), "{sql}");
    }

    #[test]
    fn exclude_linked_intel_products_uses_not_in_subquery() {
        use sea_orm::{DbBackend, EntityTrait, QueryTrait};

        let sql = exclude_inbox_report_linked_intel_products(
            signal_message::Entity::find(),
        )
        .build(DbBackend::Postgres)
        .to_string();
        assert!(sql.contains("intel_product"), "{sql}");
        assert!(sql.contains("NOT IN"), "{sql}");
        assert!(!sql.contains("ANY($1::text[])"), "{sql}");
    }
}
