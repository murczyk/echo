use anyhow::Context;
use chrono::{
    Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone,
};
use chrono_tz::Europe::Kyiv;
use indicatif::ProgressBar;
use sea_orm::*;

use crate::config::{
    SIGINT_INBOX_DATETIME_NEO_BACKFILL_BATCH_SIZE,
    SIGINT_INBOX_DATETIME_NEO_BACKFILL_SLEEP_SECS,
};
use crate::entities::sigint_inbox_item;
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};

pub fn from_date_time_text(
    date: Option<&str>,
    time: Option<&str>,
) -> anyhow::Result<Option<NaiveDateTime>> {
    let (Some(date), Some(time)) = (date, time) else {
        return Ok(None);
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
    let time = NaiveTime::parse_from_str(time, "%H:%M:%S%.f")
        .or_else(|_| NaiveTime::parse_from_str(time, "%H:%M"))?;
    let local_datetime = date.and_time(time);
    Ok(Some(kyiv_local_to_utc(local_datetime)?))
}

fn kyiv_local_to_utc(
    local_datetime: NaiveDateTime,
) -> anyhow::Result<NaiveDateTime> {
    match Kyiv.from_local_datetime(&local_datetime) {
        LocalResult::Single(datetime) => Ok(datetime.naive_utc()),
        LocalResult::Ambiguous(first, second) => {
            Ok(std::cmp::Ord::max(first.naive_utc(), second.naive_utc()))
        }
        LocalResult::None => {
            let previous_day = local_datetime - Duration::days(1);
            let previous_offset = Kyiv
                .offset_from_local_datetime(&previous_day)
                .latest()
                .context("missing Kyiv UTC offset")?
                .fix()
                .local_minus_utc();
            Ok(local_datetime - Duration::seconds(i64::from(previous_offset)))
        }
    }
}

pub async fn oneoff_backfill(mode: Mode) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let total = missing_count(&dbx).await.c(h!())?;
    let progress = ProgressBar::new(total);
    progress.set_style(crate::utils::get_pb_style()?);
    println!("> backfilling {total} sigint inbox item datetime values");

    let mut cursor = None;
    loop {
        let txn = dbx.begin().await.c(h!())?;
        let batch = backfill_batch(
            &txn,
            cursor,
            SIGINT_INBOX_DATETIME_NEO_BACKFILL_BATCH_SIZE,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        if batch.selected == 0 {
            break;
        }
        progress.inc(batch.updated);
        cursor = batch.cursor;
        if batch.selected < SIGINT_INBOX_DATETIME_NEO_BACKFILL_BATCH_SIZE {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(
            SIGINT_INBOX_DATETIME_NEO_BACKFILL_SLEEP_SECS,
        ))
        .await;
    }

    progress.finish_with_message("done");
    let remaining = missing_count(&dbx).await.c(h!())?;
    if remaining != 0 {
        return Err(AppError::BL {
            msg: format!(
                "{remaining} sigint inbox item datetime values are still missing"
            ),
        });
    }
    Ok(())
}

async fn missing_count<C>(dbx: &C) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    sigint_inbox_item::Entity::find()
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::DatetimeNeo.is_null())
        .count(dbx)
        .await
        .context(h!())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BackfillCursor {
    datetime: NaiveDateTime,
    id: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BackfillBatch {
    selected: u64,
    updated: u64,
    cursor: Option<BackfillCursor>,
}

async fn backfill_batch(
    txn: &DatabaseTransaction,
    cursor: Option<BackfillCursor>,
    batch_size: u64,
) -> anyhow::Result<BackfillBatch> {
    let batch_size = i64::try_from(batch_size).context(h!())?;
    let (cursor_datetime, cursor_id) = cursor
        .map(|cursor| (Some(cursor.datetime), Some(cursor.id)))
        .unwrap_or_default();
    let result = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            echo_migration::DATETIME_NEO_BACKFILL_BATCH_SQL,
            [cursor_datetime.into(), cursor_id.into(), batch_size.into()],
        ))
        .await
        .context(h!())?
        .context(h!())?;
    let selected: i64 = result.try_get("", "selected_count").context(h!())?;
    let updated: i64 = result.try_get("", "updated_count").context(h!())?;
    let cursor_datetime: Option<NaiveDateTime> =
        result.try_get("", "cursor_datetime").context(h!())?;
    let cursor_id: Option<i64> =
        result.try_get("", "cursor_id").context(h!())?;
    let cursor = match (cursor_datetime, cursor_id) {
        (Some(datetime), Some(id)) => Some(BackfillCursor { datetime, id }),
        (None, None) => None,
        _ => anyhow::bail!("incomplete sigint inbox datetime backfill cursor"),
    };
    Ok(BackfillBatch {
        selected: u64::try_from(selected).context(h!())?,
        updated: u64::try_from(updated).context(h!())?,
        cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup_locked, mk_sigint_inbox_item};
    use serial_test::serial;

    #[test]
    fn date_time_text_matches_postgres_kyiv_conversion() {
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), Some("12:34:56")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 56)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2026-07-15"), Some("12:34:56")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 7, 15)
                    .unwrap()
                    .and_hms_opt(9, 34, 56)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2024-03-31"), Some("03:30:00")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2024, 3, 31)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap()
            )
        );
        assert_eq!(
            from_date_time_text(Some("2024-10-27"), Some("03:30:00")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2024, 10, 27)
                    .unwrap()
                    .and_hms_opt(1, 30, 0)
                    .unwrap()
            )
        );
    }

    #[test]
    fn date_time_text_requires_both_values() {
        assert_eq!(from_date_time_text(None, Some("12:34:56")).unwrap(), None);
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), None).unwrap(),
            None
        );
    }

    #[test]
    fn date_time_text_accepts_minute_precision() {
        assert_eq!(
            from_date_time_text(Some("2026-01-15"), Some("12:34")).unwrap(),
            Some(
                NaiveDate::from_ymd_opt(2026, 1, 15)
                    .unwrap()
                    .and_hms_opt(10, 34, 0)
                    .unwrap()
            )
        );
    }

    #[serial]
    #[tokio::test]
    async fn backfill_updates_oldest_missing_rows_and_is_idempotent() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let mut ids = Vec::new();
        for date in [
            "2026-01-03",
            "2026-01-01",
            "2026-01-01",
            "2026-01-01",
            "2026-01-02",
        ] {
            let inbox_item = mk_sigint_inbox_item(
                &env.dbx,
                sigint_inbox_item::ActiveModel {
                    date: Set(Some(date.to_string())),
                    time: Set(Some("12:00:00".to_string())),
                    datetime_neo: Set(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            ids.push(inbox_item.id);
        }
        assert_eq!(missing_count(&env.dbx).await.unwrap(), 5);

        let txn = env.dbx.begin().await.unwrap();
        let first_batch = backfill_batch(&txn, None, 2).await.unwrap();
        assert_eq!(first_batch.selected, 2);
        assert_eq!(first_batch.updated, 2);
        txn.commit().await.unwrap();
        let inbox_items = sigint_inbox_item::Entity::find()
            .filter(sigint_inbox_item::Column::Id.is_in(ids))
            .order_by_asc(sigint_inbox_item::Column::Datetime)
            .order_by_asc(sigint_inbox_item::Column::Id)
            .all(&env.dbx)
            .await
            .unwrap();
        assert!(inbox_items[0].datetime_neo.is_some());
        assert!(inbox_items[1].datetime_neo.is_some());
        assert!(inbox_items[2].datetime_neo.is_none());
        assert!(inbox_items[3].datetime_neo.is_none());
        assert!(inbox_items[4].datetime_neo.is_none());

        let txn = env.dbx.begin().await.unwrap();
        let second_batch =
            backfill_batch(&txn, first_batch.cursor, 2).await.unwrap();
        assert_eq!(second_batch.selected, 2);
        assert_eq!(second_batch.updated, 2);
        txn.commit().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let third_batch =
            backfill_batch(&txn, second_batch.cursor, 2).await.unwrap();
        assert_eq!(third_batch.selected, 1);
        assert_eq!(third_batch.updated, 1);
        txn.commit().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let final_batch =
            backfill_batch(&txn, third_batch.cursor, 2).await.unwrap();
        assert_eq!(final_batch.selected, 0);
        assert_eq!(final_batch.updated, 0);
        txn.commit().await.unwrap();
        assert_eq!(missing_count(&env.dbx).await.unwrap(), 0);

        let txn = env.dbx.begin().await.unwrap();
        let rerun_batch = backfill_batch(&txn, None, 2).await.unwrap();
        assert_eq!(rerun_batch.selected, 0);
        assert_eq!(rerun_batch.updated, 0);
        txn.commit().await.unwrap();
    }
}
