use anyhow::Context;
use chrono::{
    Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone,
};
use chrono_tz::Europe::Kyiv;
use indicatif::ProgressBar;
use sea_orm::prelude::Expr;
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
    let time = NaiveTime::parse_from_str(time, "%H:%M:%S%.f")?;
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

    loop {
        let txn = dbx.begin().await.c(h!())?;
        let updated =
            backfill_batch(&txn, SIGINT_INBOX_DATETIME_NEO_BACKFILL_BATCH_SIZE)
                .await
                .c(h!())?;
        txn.commit().await.c(h!())?;
        if updated == 0 {
            break;
        }
        progress.inc(updated);
        if updated < SIGINT_INBOX_DATETIME_NEO_BACKFILL_BATCH_SIZE
            || progress.position() >= total
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(
            SIGINT_INBOX_DATETIME_NEO_BACKFILL_SLEEP_SECS,
        ))
        .await;
    }

    progress.finish_with_message("done");
    let mismatch_count = mismatch_count(&dbx).await.c(h!())?;
    if mismatch_count != 0 {
        return Err(AppError::BL {
            msg: format!(
                "{mismatch_count} sigint inbox item datetime values still differ"
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

async fn mismatch_count<C>(dbx: &C) -> anyhow::Result<u64>
where
    C: ConnectionTrait,
{
    sigint_inbox_item::Entity::find()
        .filter(Expr::cust("datetime_neo is distinct from datetime"))
        .count(dbx)
        .await
        .context(h!())
}

async fn backfill_batch(
    txn: &DatabaseTransaction,
    batch_size: u64,
) -> anyhow::Result<u64> {
    let batch_size = i64::try_from(batch_size).context(h!())?;
    let result = txn
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
with batch as materialized (
    select id
    from sigint_inbox_item
    where datetime is not null
        and datetime_neo is null
    order by datetime asc, id asc
    limit $1
),
updated as (
    update sigint_inbox_item as item
    set datetime_neo = item.datetime
    from batch
    where item.id = batch.id
        and item.datetime_neo is null
    returning item.id
)
select count(*)::bigint as updated_count
from updated
            "#,
            [batch_size.into()],
        ))
        .await
        .context(h!())?
        .context(h!())?;
    let updated_count: i64 =
        result.try_get("", "updated_count").context(h!())?;
    u64::try_from(updated_count).context(h!())
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

    #[serial]
    #[tokio::test]
    async fn backfill_updates_oldest_missing_rows_and_is_idempotent() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let mut ids = Vec::new();
        for date in ["2026-01-03", "2026-01-01", "2026-01-02"] {
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
        assert_eq!(missing_count(&env.dbx).await.unwrap(), 3);

        let txn = env.dbx.begin().await.unwrap();
        assert_eq!(backfill_batch(&txn, 2).await.unwrap(), 2);
        txn.commit().await.unwrap();
        let inbox_items = sigint_inbox_item::Entity::find()
            .filter(sigint_inbox_item::Column::Id.is_in(ids))
            .order_by_asc(sigint_inbox_item::Column::Datetime)
            .all(&env.dbx)
            .await
            .unwrap();
        assert!(inbox_items[0].datetime_neo.is_some());
        assert!(inbox_items[1].datetime_neo.is_some());
        assert!(inbox_items[2].datetime_neo.is_none());

        let txn = env.dbx.begin().await.unwrap();
        assert_eq!(backfill_batch(&txn, 2).await.unwrap(), 1);
        txn.commit().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        assert_eq!(backfill_batch(&txn, 2).await.unwrap(), 0);
        txn.commit().await.unwrap();
        assert_eq!(missing_count(&env.dbx).await.unwrap(), 0);
        assert_eq!(mismatch_count(&env.dbx).await.unwrap(), 0);
    }
}
