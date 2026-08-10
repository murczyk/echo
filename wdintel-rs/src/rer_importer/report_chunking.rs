use crate::error::AppError;
use crate::rer_importer::types::{InboxMessagesReq, InboxMessagesSortBy};
use crate::types::Env;
use crate::utils::dt_from_millis;
use anyhow::Context;
use sea_orm::{ColumnTrait, ConnectionTrait, QueryFilter, Select};

use crate::entities::{sigint_inbox_item, signal_message};

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
    report_period_chunks(
        since_ms,
        till_ms,
        chunking_hours,
        ReportPeriodEnd::Inclusive,
    )
    .context(h!())
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
}
