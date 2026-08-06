use anyhow::Context;
use chrono::{
    Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone,
};
use chrono_tz::Europe::Kyiv;
use indicatif::ProgressBar;
use sea_orm::sea_query::{CaseStatement, Expr};
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

#[derive(Clone, Copy, Debug, Eq, FromQueryResult, PartialEq)]
struct BackfillRow {
    id: i64,
    datetime: NaiveDateTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BackfillEntry {
    id: i64,
    datetime_neo: NaiveDateTime,
}

async fn backfill_batch(
    txn: &DatabaseTransaction,
    cursor: Option<BackfillCursor>,
    batch_size: u64,
) -> anyhow::Result<BackfillBatch> {
    let rows = fetch_backfill_rows(txn, cursor, batch_size).await?;
    let selected = u64::try_from(rows.len()).context(h!())?;
    let cursor = rows.last().map(|row| BackfillCursor {
        datetime: row.datetime,
        id: row.id,
    });
    let entries = prepare_backfill_entries(rows);
    let updated = update_backfill_entries(txn, &entries).await?;
    Ok(BackfillBatch {
        selected,
        updated,
        cursor,
    })
}

async fn fetch_backfill_rows<C>(
    dbx: &C,
    cursor: Option<BackfillCursor>,
    batch_size: u64,
) -> anyhow::Result<Vec<BackfillRow>>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::Datetime)
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::DatetimeNeo.is_null());
    if let Some(cursor) = cursor {
        query = query.filter(backfill_cursor_filter(cursor));
    }
    query
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id)
        .limit(batch_size)
        .into_model::<BackfillRow>()
        .all(dbx)
        .await
        .context(h!())
}

fn backfill_cursor_filter(cursor: BackfillCursor) -> Condition {
    Condition::any()
        .add(sigint_inbox_item::Column::Datetime.gt(cursor.datetime))
        .add(
            Condition::all()
                .add(sigint_inbox_item::Column::Datetime.eq(cursor.datetime))
                .add(sigint_inbox_item::Column::Id.gt(cursor.id)),
        )
}

fn prepare_backfill_entries(rows: Vec<BackfillRow>) -> Vec<BackfillEntry> {
    rows.into_iter()
        .map(|row| BackfillEntry {
            id: row.id,
            datetime_neo: row.datetime,
        })
        .collect()
}

fn build_backfill_update(
    entries: &[BackfillEntry],
) -> UpdateMany<sigint_inbox_item::Entity> {
    let datetime_neo = entries
        .iter()
        .fold(CaseStatement::new(), |statement, entry| {
            statement.case(
                sigint_inbox_item::Column::Id.eq(entry.id),
                Expr::value(entry.datetime_neo),
            )
        })
        .finally(Expr::col(sigint_inbox_item::Column::DatetimeNeo));
    sigint_inbox_item::Entity::update_many()
        .col_expr(sigint_inbox_item::Column::DatetimeNeo, datetime_neo.into())
        .filter(
            sigint_inbox_item::Column::Id
                .is_in(entries.iter().map(|entry| entry.id)),
        )
        .filter(sigint_inbox_item::Column::DatetimeNeo.is_null())
}

async fn update_backfill_entries(
    txn: &DatabaseTransaction,
    entries: &[BackfillEntry],
) -> anyhow::Result<u64> {
    if entries.is_empty() {
        return Ok(0);
    }
    Ok(build_backfill_update(entries)
        .exec(txn)
        .await
        .context(h!())?
        .rows_affected)
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
