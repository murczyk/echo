use crate::error::AppError;

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
        })?;
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
