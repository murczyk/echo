//! Source message queries. All range queries are bounded on
//! `signal_message.timestamp` and served by `signal_message_timestamp_idx` /
//! `signal_message_timestamp_id_idx`; the cursor is a `(timestamp, id)`
//! keyset, so every worker tick scans only the messages that became due.

use crate::entities::*;
use crate::h;
use crate::message_replay::types::MessageReplayActivityBucket;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::*;

/// A source message with everything needed to push it through ingest.
pub struct ReplaySource {
    pub message: signal_message::Model,
    pub group_master_key: String,
    pub datasource_id: i64,
    pub media: Vec<signal_message_media::Model>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceKey {
    pub timestamp: NaiveDateTime,
    pub id: i64,
}

pub struct WindowCounts {
    pub window_count: i64,
    pub skipped_count: i64,
    pub first_replayed_ts: Option<NaiveDateTime>,
}

/// Replayable sources: live, messenger-group messages that are not
/// replays themselves (replays carry a negative `external_id`).
const REPLAYABLE_FILTER: &str = "deleted = false
         and datasource_group_id is not null
         and (external_id is null or external_id > 0)";

fn statement(sql: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, sql, values)
}

pub async fn next_due_source<C>(
    dbx: &C,
    cursor: SourceKey,
    due_until: NaiveDateTime,
) -> anyhow::Result<Option<SourceKey>>
where
    C: ConnectionTrait,
{
    let sql = format!(
        "select id, timestamp from signal_message
         where (timestamp, id) > ($1, $2) and timestamp <= $3
           and {}
         order by timestamp, id
         limit 1",
        REPLAYABLE_FILTER
    );
    let row = dbx
        .query_one_raw(statement(
            &sql,
            vec![cursor.timestamp.into(), cursor.id.into(), due_until.into()],
        ))
        .await
        .c(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(SourceKey {
        id: row.try_get("", "id").c(h!())?,
        timestamp: row.try_get("", "timestamp").c(h!())?,
    }))
}

pub async fn count_window<C>(
    dbx: &C,
    window_from: NaiveDateTime,
    window_to: NaiveDateTime,
    first_replayed_ts: NaiveDateTime,
) -> anyhow::Result<WindowCounts>
where
    C: ConnectionTrait,
{
    let sql = format!(
        "select count(*)::bigint as window_count,
                (count(*) filter (where timestamp < $3))::bigint as skipped_count,
                min(timestamp) filter (where timestamp >= $3) as first_replayed_ts
         from signal_message
         where timestamp >= $1 and timestamp <= $2
           and {}",
        REPLAYABLE_FILTER
    );
    let row = dbx
        .query_one_raw(statement(
            &sql,
            vec![
                window_from.into(),
                window_to.into(),
                first_replayed_ts.into(),
            ],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    Ok(WindowCounts {
        window_count: row.try_get("", "window_count").c(h!())?,
        skipped_count: row.try_get("", "skipped_count").c(h!())?,
        first_replayed_ts: row.try_get("", "first_replayed_ts").c(h!())?,
    })
}

/// Message counts per bucket, as `(bucket start, count)`. Day buckets are
/// Kyiv days, rolled up from hourly bins so the time zone is converted once
/// per hour instead of once per message (Kyiv offsets are whole hours).
pub async fn activity<C>(
    dbx: &C,
    from: NaiveDateTime,
    to: NaiveDateTime,
    bucket: &MessageReplayActivityBucket,
) -> anyhow::Result<Vec<(NaiveDateTime, i64)>>
where
    C: ConnectionTrait,
{
    let bin_sec = match bucket {
        MessageReplayActivityBucket::Day1 => {
            MessageReplayActivityBucket::Hour1.seconds()
        }
        bucket => bucket.seconds(),
    };
    let bins = format!(
        "select date_bin(make_interval(secs => $3), timestamp,
                         timestamp '2000-01-01') as bucket,
                count(*)::bigint as count
         from signal_message
         where timestamp >= $1 and timestamp < $2
           and {}
         group by 1",
        REPLAYABLE_FILTER
    );
    let mut values = vec![from.into(), to.into(), (bin_sec as f64).into()];
    let sql = match bucket {
        MessageReplayActivityBucket::Day1 => {
            values.push(crate::config::get_tz().name().into());
            format!(
                "select (date_trunc('day', bucket at time zone 'UTC'
                                           at time zone $4::text)
                         at time zone $4::text) at time zone 'UTC' as bucket,
                        sum(count)::bigint as count
                 from ({bins}) bins
                 group by 1
                 order by 1"
            )
        }
        _ => format!("{bins} order by 1"),
    };
    let rows = dbx.query_all_raw(statement(&sql, values)).await.c(h!())?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("", "bucket").c(h!())?,
                row.try_get("", "count").c(h!())?,
            ))
        })
        .collect()
}

/// First and last replayable message timestamps; each is one index probe
/// on `signal_message_timestamp_idx`. The backward probe for the last one
/// steps over stored replays (the newest rows), so it is only cheap with
/// none stored: the planner calls it with no session, after Stop has purged
/// every replay.
pub async fn extent<C>(
    dbx: &C,
) -> anyhow::Result<(Option<NaiveDateTime>, Option<NaiveDateTime>)>
where
    C: ConnectionTrait,
{
    let sql = format!(
        "select min(timestamp) as first_ts, max(timestamp) as last_ts
         from signal_message
         where {}",
        REPLAYABLE_FILTER
    );
    let row = dbx
        .query_one_raw(statement(&sql, vec![]))
        .await
        .c(h!())?
        .c(h!())?;
    Ok((
        row.try_get("", "first_ts").c(h!())?,
        row.try_get("", "last_ts").c(h!())?,
    ))
}

pub async fn load_source<C>(
    dbx: &C,
    source_id: i64,
) -> anyhow::Result<Option<ReplaySource>>
where
    C: ConnectionTrait,
{
    let Some(message) = signal_message::Entity::find_by_id(source_id)
        .one(dbx)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let Some(datasource_group_id) = message.datasource_group_id else {
        return Ok(None);
    };
    let Some(datasource_group) =
        datasource_group::Entity::find_by_id(datasource_group_id)
            .one(dbx)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let media = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(source_id))
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .order_by_asc(signal_message_media::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    Ok(Some(ReplaySource {
        message,
        group_master_key: datasource_group.group_master_key,
        datasource_id: datasource_group.datasource_id,
        media,
    }))
}

/// Replayed messages still stored; served by `signal_message_external_id_idx`.
pub async fn count_stored_replays<C>(dbx: &C) -> anyhow::Result<i64>
where
    C: ConnectionTrait,
{
    Ok(signal_message::Entity::find()
        .filter(signal_message::Column::ExternalId.lt(0))
        .count(dbx)
        .await
        .c(h!())? as i64)
}
