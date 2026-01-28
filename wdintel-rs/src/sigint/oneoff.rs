use crate::config::{get_tz, TAG_SUGGEST_WORKER_BATCH_SIZE};
use crate::entities::{sigint_inbox_item, sigint_inbox_item_tag};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{h, OneoffSuggestInboxMessageTagsPs};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use csv::Writer;
use log::{info, warn};
use sea_orm::prelude::*;
use sea_orm::*;
use std::collections::BTreeMap;

pub async fn oneoff_fill_sigint_inbox_item_tags(
    mode: Mode,
) -> Result<(), AppError> {
    info!("starting oneoff_fill_sigint_inbox_item_tags...");
    let config = crate::config::read_config(mode)?;
    let db = crate::new_pg_pool_from_config(&config).await?;

    db.execute_unprepared(
        r#"
            insert into sigint_inbox_item_tag (
                sigint_inbox_item_id,
                tag_id
            )
            select distinct
                x.sigint_inbox_item_id,
                x.tag_id::bigint
            from (
                select
                    id as sigint_inbox_item_id,
                    jsonb_array_elements(tags) as tag_id
                from
                    sigint_inbox_item i
                where
                    i.tags is not null
                    and not exists (
                        select 1 from sigint_inbox_item_tag it
                        where it.sigint_inbox_item_id = i.id
                    )
            ) as x;
    "#,
    )
    .await
    .c(h!())?;
    info!("done oneoff_fill_sigint_inbox_item_tags");
    Ok(())
}

pub async fn oneoff_suggest_inbox_message_tags(
    mode: Mode,
    ps: &OneoffSuggestInboxMessageTagsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_suggest_inbox_message_tags...");
    let env = crate::server::new_env(mode).await.c(h!())?;

    let dbx = env.dbx.clone();
    let start = parse_local_datetime(&ps.start).c(h!())?;
    let end = parse_local_datetime(&ps.end).c(h!())?;

    let q = sigint_inbox_item_tag::Entity::find()
        .filter(
            Expr::col((
                sigint_inbox_item_tag::Entity,
                sigint_inbox_item_tag::Column::SigintInboxItemId,
            ))
            .equals((sigint_inbox_item::Entity, sigint_inbox_item::Column::Id)),
        )
        .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
        .select_only();
    let exists = Expr::exists(q.expr(Expr::value(1)).into_query());

    let message_ids: Vec<i64> = sigint_inbox_item::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemTag.def(),
        )
        .select_only()
        .filter(sigint_inbox_item::Column::BodyNoheader.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(start))
        .filter(sigint_inbox_item::Column::Datetime.lte(end))
        .filter(exists.not())
        .column(sigint_inbox_item::Column::Id)
        .into_tuple::<i64>()
        .all(&dbx)
        .await
        .c(h!())?;

    let total_len = message_ids.len();
    info!("oneoff_suggest_inbox_message_tags, about to process {total_len} messages");
    let mut processed = 0;
    let mut suggested = 0;
    let batch_size = ps
        .batch_size
        .filter(|sz| *sz > 0)
        .unwrap_or(TAG_SUGGEST_WORKER_BATCH_SIZE);
    for chunk in message_ids.chunks(batch_size) {
        let txn: DatabaseTransaction = dbx.begin().await.c(h!())?;

        let result = crate::tags::worker::process_messages(
            chunk.to_vec(),
            &env.rq,
            &txn,
            &env.tag_keyword_regex_cache,
        )
        .await
        .c(h!())?;

        processed += chunk.len();
        suggested += result.inserted_count;

        info!("oneoff_suggest_inbox_message_tags, {suggested} tags suggested for {processed}/{total_len} messages");

        txn.commit().await.c(h!())?;
    }

    if suggested == 0 {
        warn!("no tags suggested for {processed} messages, did you forget to set up tag keywords or run `just ai-sync-from-cloud`?")
    } else {
        info!("done oneoff_suggest_inbox_message_tags, total {suggested} tags suggested for {processed} messages");
    }

    Ok(())
}

pub async fn oneoff_tag_messages_report(
    mode: Mode,
    ps: &crate::OneoffTagMessagesReportPs,
) -> Result<(), AppError> {
    info!("starting oneoff_tag_messages_report...");
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let start_date = parse_local_date(&ps.start).c(h!())?;
    let end_date = parse_local_date(&ps.end).c(h!())?;
    if end_date < start_date {
        return Err(AppError::BL {
            msg: format!(
                "end date {} must be on or after start date {}",
                ps.end, ps.start
            ),
        });
    }

    let end_date_exclusive = next_date(end_date).c(h!())?;
    let start_utc = local_midnight_to_utc(start_date).c(h!())?;
    let end_utc = local_midnight_to_utc(end_date_exclusive).c(h!())?;

    let tz = get_tz().to_string();
    let total_counts =
        load_total_message_counts(&db, start_utc, end_utc, &tz).await?;
    let tag_counts =
        load_tagged_message_counts(&db, start_utc, end_utc, &tz).await?;

    let days = collect_days(start_date, end_date).c(h!())?;
    write_report_csv(&ps.output, &days, &total_counts, &tag_counts).c(h!())?;
    info!("done oneoff_tag_messages_report");
    Ok(())
}

fn parse_local_date(val: &str) -> Result<NaiveDate, AppError> {
    Ok(NaiveDate::parse_from_str(val, "%Y-%m-%d").c(h!())?)
}

fn next_date(date: NaiveDate) -> Result<NaiveDate, AppError> {
    date.checked_add_signed(Duration::days(1))
        .ok_or(AppError::BL {
            msg: format!("date overflow while adding a day to {date}"),
        })
}

fn local_midnight_to_utc(date: NaiveDate) -> Result<NaiveDateTime, AppError> {
    let local_midnight = date.and_hms_opt(0, 0, 0).ok_or(AppError::BL {
        msg: format!("invalid local midnight for date {date}"),
    })?;
    let zoned = local_midnight.and_local_timezone(get_tz()).single().ok_or(
        AppError::BL {
            msg: format!("ambiguous local datetime: {local_midnight}"),
        },
    )?;
    Ok(zoned.to_utc().naive_utc())
}

fn collect_days(
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Result<Vec<NaiveDate>, AppError> {
    let mut days = Vec::new();
    let mut current = start_date;
    while current <= end_date {
        days.push(current);
        current = next_date(current).c(h!())?;
    }
    Ok(days)
}

async fn load_total_message_counts(
    db: &DatabaseConnection,
    start_utc: NaiveDateTime,
    end_utc: NaiveDateTime,
    tz: &str,
) -> Result<BTreeMap<NaiveDate, u64>, AppError> {
    let sql = format!(
        r#"
        SELECT
            (datetime AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            count(*) AS message_count
        FROM sigint_inbox_item
        WHERE datetime >= $1 AND datetime < $2
        GROUP BY day
        ORDER BY day
        "#
    );

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [start_utc.into(), end_utc.into()],
        ))
        .await
        .c(h!())?;

    let mut counts = BTreeMap::new();
    for row in rows {
        let day: NaiveDate = row.try_get("", "day")?;
        let message_count: i64 = row.try_get("", "message_count")?;
        counts.insert(day, message_count as u64);
    }

    Ok(counts)
}

async fn load_tagged_message_counts(
    db: &DatabaseConnection,
    start_utc: NaiveDateTime,
    end_utc: NaiveDateTime,
    tz: &str,
) -> Result<BTreeMap<NaiveDate, (u64, u64)>, AppError> {
    let sql = format!(
        r#"
        SELECT
            (i.datetime AT TIME ZONE 'UTC' AT TIME ZONE '{tz}')::date AS day,
            count(DISTINCT i.id) FILTER (WHERE t.model IS NULL) AS human_count,
            count(DISTINCT i.id) FILTER (WHERE t.model IS NOT NULL) AS robot_count
        FROM sigint_inbox_item i
        INNER JOIN sigint_inbox_item_tag t
            ON t.sigint_inbox_item_id = i.id
        WHERE i.datetime >= $1 AND i.datetime < $2
        GROUP BY day
        ORDER BY day
        "#
    );

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [start_utc.into(), end_utc.into()],
        ))
        .await
        .c(h!())?;

    let mut counts = BTreeMap::new();
    for row in rows {
        let day: NaiveDate = row.try_get("", "day")?;
        let human_count: i64 = row.try_get("", "human_count")?;
        let robot_count: i64 = row.try_get("", "robot_count")?;
        counts.insert(day, (human_count as u64, robot_count as u64));
    }

    Ok(counts)
}

fn write_report_csv(
    output: &str,
    days: &[NaiveDate],
    total_counts: &BTreeMap<NaiveDate, u64>,
    tag_counts: &BTreeMap<NaiveDate, (u64, u64)>,
) -> Result<(), AppError> {
    let mut writer = Writer::from_path(output).c(h!())?;
    writer
        .write_record([
            "day",
            "number of messages",
            "number of tagged messages made by human",
            "number of tagged messages made by robots",
        ])
        .c(h!())?;

    for day in days {
        let total = total_counts.get(day).copied().unwrap_or(0);
        let (human_count, robot_count) =
            tag_counts.get(day).copied().unwrap_or((0, 0));
        writer
            .write_record([
                day.format("%Y-%m-%d").to_string(),
                total.to_string(),
                human_count.to_string(),
                robot_count.to_string(),
            ])
            .c(h!())?;
    }

    writer.flush().c(h!())?;
    Ok(())
}
