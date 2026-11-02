//! Locking: `device_content_stat` and `device_tree_stat` rows act as per-device
//! mutexes. Writers take them last in the transaction that changes the source
//! rows, so increments commit atomically with the data they count. An upload
//! counts in the current stats iff `stats_epoch = device_content_stat.epoch`.

use crate::devices::config::{
    DEVICE_STATS_BACKFILL_BATCH_SIZE, DEVICE_STATS_LIVE_LOCK_TIMEOUT_MS,
    DEVICE_STATS_TIMEZONE,
};
use crate::devices::files::types::{
    DeviceDayStat, DeviceExtensionStat, DeviceStats,
};
use crate::h;
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, FixedOffset, NaiveDate, SecondsFormat, Utc};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseBackend, DatabaseConnection,
    DatabaseTransaction, EntityTrait, IsolationLevel, QueryOrder, QueryResult,
    QuerySelect, Statement, TransactionTrait,
};
use std::collections::HashMap;
use uuid::Uuid;

// Starts a missing row above every stamped upload (see RESET_CONTENT_STAT_SQL),
// so uploads counted before a wipe show up as `content_pending`.
const LOCK_CONTENT_STAT_SQL: &str = r#"
insert into device_content_stat (device_id, epoch, updated_at)
select $1, coalesce(max(stats_epoch), 0) + 1, $2
from file_content_upload
where device_id = $1 and status = 'completed'
on conflict (device_id) do update set updated_at = excluded.updated_at
returning epoch
"#;

const APPLY_CONTENT_TOTALS_SQL: &str = r#"
with applied as (
    select count(*) as content_count,
           coalesce(sum(u.upload_length), 0)::bigint as content_bytes,
           min(c.created_at) as first_content_at,
           max(c.created_at) as last_content_at
    from file_content_upload u
    join file_content c
      on c.file_id = u.file_id and c.revision = u.revision and c.upload_id = u.id
    where u.device_id = $1
      and u.id = any($2)
      and u.status = 'completed'
      and u.stats_epoch < $3
)
update device_content_stat as stat
set content_count = stat.content_count + applied.content_count,
    content_bytes = stat.content_bytes + applied.content_bytes,
    first_content_at = least(stat.first_content_at, applied.first_content_at),
    last_content_at = greatest(stat.last_content_at, applied.last_content_at),
    updated_at = $4
from applied
where stat.device_id = $1 and stat.epoch = $3
returning applied.content_count
"#;

const APPLY_CONTENT_EXTENSIONS_SQL: &str = r#"
insert into device_content_stat_extension as stat (
    device_id, extension, content_count, content_bytes, last_content_at
)
select u.device_id,
       lower(coalesce(r.extension, '')),
       count(*),
       sum(u.upload_length)::bigint,
       max(c.created_at)
from file_content_upload u
join file_content c
  on c.file_id = u.file_id and c.revision = u.revision and c.upload_id = u.id
join file_revision r on r.id = u.file_id and r.revision = u.revision
where u.device_id = $1
  and u.id = any($2)
  and u.status = 'completed'
  and u.stats_epoch < $3
group by 1, 2
order by 2
on conflict (device_id, extension) do update
set content_count = stat.content_count + excluded.content_count,
    content_bytes = stat.content_bytes + excluded.content_bytes,
    last_content_at = greatest(stat.last_content_at, excluded.last_content_at)
"#;

const APPLY_CONTENT_DAYS_SQL: &str = r#"
insert into device_content_stat_day as stat (
    device_id, day, extension, content_count, content_bytes
)
select u.device_id,
       (c.created_at at time zone $4)::date,
       lower(coalesce(r.extension, '')),
       count(*),
       sum(u.upload_length)::bigint
from file_content_upload u
join file_content c
  on c.file_id = u.file_id and c.revision = u.revision and c.upload_id = u.id
join file_revision r on r.id = u.file_id and r.revision = u.revision
where u.device_id = $1
  and u.id = any($2)
  and u.status = 'completed'
  and u.stats_epoch < $3
group by 1, 2, 3
order by 2, 3
on conflict (device_id, day, extension) do update
set content_count = stat.content_count + excluded.content_count,
    content_bytes = stat.content_bytes + excluded.content_bytes
"#;

const MARK_CONTENT_COUNTED_SQL: &str = r#"
update file_content_upload
set stats_epoch = $3
where device_id = $1
  and id = any($2)
  and status = 'completed'
  and stats_epoch < $3
"#;

const RECORD_TREE_INSERTED_SQL: &str = r#"
insert into device_tree_stat as stat (
    device_id, directory_count, file_count, updated_at
)
values ($1, $2, $3, now())
on conflict (device_id) do update
set directory_count = stat.directory_count + excluded.directory_count,
    file_count = stat.file_count + excluded.file_count,
    updated_at = excluded.updated_at
"#;

pub(in crate::devices) async fn record_content_completed_in(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    upload_id: Uuid,
    now: DateTime<FixedOffset>,
) -> Result<()> {
    // Stats never block or fail an upload: the savepoint bounds the wait for
    // the stats row lock and undoes partial writes on any error. A skipped
    // upload stays pending (`content_pending`) until the next rebuild.
    let savepoint = transaction.begin().await.context(h!())?;
    let result = async {
        savepoint
            .execute_unprepared(&format!(
                "set local lock_timeout = '{DEVICE_STATS_LIVE_LOCK_TIMEOUT_MS}ms'"
            ))
            .await
            .context(h!())?;
        let epoch = lock_content_stat(&savepoint, device_id, now)
            .await
            .context(h!())?;
        apply_uploads_in(&savepoint, device_id, epoch, &[upload_id], now)
            .await
            .context(h!())
    }
    .await;
    match result {
        Ok(()) => savepoint.commit().await.context(h!()),
        Err(error) => {
            savepoint.rollback().await.context(h!())?;
            crate::types::warn!(
                "Device stats skipped for upload {upload_id}: {error:#}"
            );
            Ok(())
        }
    }
}

/// Errors are contained in a savepoint so stats never fail a sync batch. No
/// lock timeout: a skipped increment has no pending marker and would be lost,
/// and the only long holder is an admin-triggered tree recount.
pub(in crate::devices) async fn record_tree_inserted_in(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    directory_count: u64,
    file_count: u64,
) -> Result<()> {
    if directory_count == 0 && file_count == 0 {
        return Ok(());
    }
    let savepoint = transaction.begin().await.context(h!())?;
    let result =
        increment_tree_in(&savepoint, device_id, directory_count, file_count)
            .await;
    match result {
        Ok(()) => savepoint.commit().await.context(h!()),
        Err(error) => {
            savepoint.rollback().await.context(h!())?;
            crate::types::warn!(
                "Device tree stats skipped for device {device_id}: {error:#}"
            );
            Ok(())
        }
    }
}

async fn increment_tree_in(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    directory_count: u64,
    file_count: u64,
) -> Result<()> {
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            RECORD_TREE_INSERTED_SQL,
            [
                device_id.into(),
                i64::try_from(directory_count).context(h!())?.into(),
                i64::try_from(file_count).context(h!())?.into(),
            ],
        ))
        .await
        .context("record device tree stats")
        .context(h!())?;
    Ok(())
}

async fn lock_content_stat(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    now: DateTime<FixedOffset>,
) -> Result<i64> {
    transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            LOCK_CONTENT_STAT_SQL,
            [device_id.into(), now.into()],
        ))
        .await
        .context("lock device content stats")
        .context(h!())?
        .context("device content stats row missing")
        .context(h!())?
        .try_get("", "epoch")
        .context(h!())
}

async fn apply_uploads_in(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    epoch: i64,
    upload_ids: &[Uuid],
    now: DateTime<FixedOffset>,
) -> Result<()> {
    if upload_ids.is_empty() {
        return Ok(());
    }
    let expected = u64::try_from(upload_ids.len()).context(h!())?;
    let applied: i64 = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            APPLY_CONTENT_TOTALS_SQL,
            [
                device_id.into(),
                upload_ids.to_vec().into(),
                epoch.into(),
                now.into(),
            ],
        ))
        .await
        .context("apply device content stat totals")
        .context(h!())?
        .context("device content stats epoch changed")
        .context(h!())?
        .try_get("", "content_count")
        .context(h!())?;
    ensure!(
        u64::try_from(applied).context(h!())? == expected,
        "device content stats applied {applied} of {expected} uploads"
    );
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            APPLY_CONTENT_EXTENSIONS_SQL,
            [device_id.into(), upload_ids.to_vec().into(), epoch.into()],
        ))
        .await
        .context("apply device content stat extensions")
        .context(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            APPLY_CONTENT_DAYS_SQL,
            [
                device_id.into(),
                upload_ids.to_vec().into(),
                epoch.into(),
                DEVICE_STATS_TIMEZONE.into(),
            ],
        ))
        .await
        .context("apply device content stat days")
        .context(h!())?;
    let marked = transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            MARK_CONTENT_COUNTED_SQL,
            [device_id.into(), upload_ids.to_vec().into(), epoch.into()],
        ))
        .await
        .context("mark uploads counted in device content stats")
        .context(h!())?
        .rows_affected();
    ensure!(
        marked == expected,
        "device content stats marked {marked} of {expected} uploads"
    );
    Ok(())
}

// A missing stats row (wiped by hand) must not restart the epoch below what
// uploads were already stamped with, or they would never count as pending.
const RESET_CONTENT_STAT_SQL: &str = r#"
insert into device_content_stat as stat (
    device_id, epoch, backfill_started_at, updated_at
)
select $1, coalesce(max(stats_epoch), 0) + 1, $2, $2
from file_content_upload
where device_id = $1 and status = 'completed'
on conflict (device_id) do update
set epoch = greatest(stat.epoch + 1, excluded.epoch),
    content_count = 0,
    content_bytes = 0,
    first_content_at = null,
    last_content_at = null,
    backfill_started_at = excluded.backfill_started_at,
    backfilled_at = null,
    updated_at = excluded.updated_at
returning epoch
"#;

const BACKFILL_LOCK_SQL: &str = "select pg_advisory_xact_lock(hashtextextended('echo:device-stats-backfill:' || $1::text, 0))";

const READ_CONTENT_EPOCH_SQL: &str =
    "select epoch from device_content_stat where device_id = $1";

const LOCK_CONTENT_EPOCH_SQL: &str =
    "select epoch from device_content_stat where device_id = $1 for update";

const PICK_PENDING_UPLOADS_SQL: &str = r#"
select id
from file_content_upload
where device_id = $1 and status = 'completed' and stats_epoch < $2
order by stats_epoch
limit $3
for update
"#;

const FINISH_BACKFILL_SQL: &str = r#"
update device_content_stat
set backfilled_at = $3, updated_at = $3
where device_id = $1 and epoch = $2 and backfilled_at is null
returning content_count, content_bytes
"#;

const LOCK_TREE_STAT_SQL: &str = r#"
insert into device_tree_stat (device_id, updated_at)
values ($1, now())
on conflict (device_id) do update set updated_at = excluded.updated_at
"#;

const REBUILD_TREE_STAT_SQL: &str = r#"
update device_tree_stat as stat
set directory_count = entries.directory_count,
    file_count = entries.file_count,
    rebuilt_at = now(),
    updated_at = now()
from (
    select count(*) filter (where kind = 'directory') as directory_count,
           count(*) filter (where kind = 'file') as file_count
    from file_entry
    where device_id = $1 and archive_file_id is null
) as entries
where stat.device_id = $1
returning stat.directory_count, stat.file_count
"#;

pub(in crate::devices) struct RebuiltDeviceStats {
    pub(in crate::devices) directory_count: u64,
    pub(in crate::devices) file_count: u64,
    pub(in crate::devices) content_count: u64,
    pub(in crate::devices) content_bytes: u64,
    pub(in crate::devices) batch_count: u64,
}

enum BackfillBatch {
    Applied,
    Finished {
        content_count: u64,
        content_bytes: u64,
    },
    EpochChanged,
}

/// Reset + batched backfill: uploads are never blocked for longer than one
/// short transaction, and new completions keep counting themselves meanwhile.
pub(in crate::devices) async fn rebuild(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<RebuiltDeviceStats> {
    reset_content(db, device_id).await.context(h!())?;
    let mut batch_count = 0;
    let (content_count, content_bytes) = loop {
        match backfill_batch(db, device_id).await.context(h!())? {
            BackfillBatch::Applied => batch_count += 1,
            // A concurrent reset bumped the epoch; continue on the new one.
            BackfillBatch::EpochChanged => {}
            BackfillBatch::Finished {
                content_count,
                content_bytes,
            } => break (content_count, content_bytes),
        }
    };
    let (directory_count, file_count) =
        rebuild_tree(db, device_id).await.context(h!())?;
    Ok(RebuiltDeviceStats {
        directory_count,
        file_count,
        content_count,
        content_bytes,
        batch_count,
    })
}

/// Bumping the epoch makes every previously counted upload pending again.
/// Holds the stats row lock only for the reset itself.
async fn reset_content(db: &DatabaseConnection, device_id: Uuid) -> Result<()> {
    let transaction = db.begin().await.context(h!())?;
    transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            RESET_CONTENT_STAT_SQL,
            [device_id.into(), Utc::now().fixed_offset().into()],
        ))
        .await
        .context("reset device content stats")
        .context(h!())?
        .context("device content stats row missing")
        .context(h!())?;
    for table in ["device_content_stat_extension", "device_content_stat_day"] {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                format!("delete from {table} where device_id = $1"),
                [device_id.into()],
            ))
            .await
            .context("clear device content stat breakdown")
            .context(h!())?;
    }
    transaction.commit().await.context(h!())
}

/// Lock order matches live completion (upload rows, then stats row), so the
/// batch can wait on upload row locks without deadlocking and without holding
/// the stats lock meanwhile. Uploads still being completed are invisible here
/// (status `open`) and get counted by their own transaction.
async fn backfill_batch(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<BackfillBatch> {
    let transaction = db.begin().await.context(h!())?;
    // Serializes concurrent backfills of one device; live writers skip it.
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            BACKFILL_LOCK_SQL,
            [device_id.into()],
        ))
        .await
        .context("lock device stats backfill")
        .context(h!())?;
    let epoch = read_epoch(&transaction, READ_CONTENT_EPOCH_SQL, device_id)
        .await
        .context(h!())?;
    let upload_ids: Vec<Uuid> = transaction
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            PICK_PENDING_UPLOADS_SQL,
            [
                device_id.into(),
                epoch.into(),
                i64::try_from(DEVICE_STATS_BACKFILL_BATCH_SIZE)
                    .context(h!())?
                    .into(),
            ],
        ))
        .await
        .context("pick pending device stats uploads")
        .context(h!())?
        .iter()
        .map(|row| row.try_get("", "id").context(h!()))
        .collect::<Result<_>>()
        .context(h!())?;
    // Stats row lock is held from here until commit.
    let locked_epoch =
        read_epoch(&transaction, LOCK_CONTENT_EPOCH_SQL, device_id)
            .await
            .context(h!())?;
    if locked_epoch != epoch {
        transaction.rollback().await.context(h!())?;
        return Ok(BackfillBatch::EpochChanged);
    }
    let now = Utc::now().fixed_offset();
    let batch = if upload_ids.is_empty() {
        let row = transaction
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                FINISH_BACKFILL_SQL,
                [device_id.into(), epoch.into(), now.into()],
            ))
            .await
            .context("finish device stats backfill")
            .context(h!())?;
        match row {
            Some(row) => BackfillBatch::Finished {
                content_count: u64::try_from(
                    row.try_get::<i64>("", "content_count").context(h!())?,
                )
                .context(h!())?,
                content_bytes: u64::try_from(
                    row.try_get::<i64>("", "content_bytes").context(h!())?,
                )
                .context(h!())?,
            },
            // Another backfill already finished this epoch.
            None => finished_totals(&transaction, device_id)
                .await
                .context(h!())?,
        }
    } else {
        apply_uploads_in(&transaction, device_id, epoch, &upload_ids, now)
            .await
            .context(h!())?;
        BackfillBatch::Applied
    };
    transaction.commit().await.context(h!())?;
    Ok(batch)
}

async fn read_epoch(
    transaction: &DatabaseTransaction,
    sql: &str,
    device_id: Uuid,
) -> Result<i64> {
    transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [device_id.into()],
        ))
        .await
        .context("read device content stats epoch")
        .context(h!())?
        .context("device content stats row missing")
        .context(h!())?
        .try_get("", "epoch")
        .context(h!())
}

async fn finished_totals(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
) -> Result<BackfillBatch> {
    let row = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select content_count, content_bytes from device_content_stat where device_id = $1",
            [device_id.into()],
        ))
        .await
        .context(h!())?
        .context("device content stats row missing")
        .context(h!())?;
    Ok(BackfillBatch::Finished {
        content_count: u64::try_from(
            row.try_get::<i64>("", "content_count").context(h!())?,
        )
        .context(h!())?,
        content_bytes: u64::try_from(
            row.try_get::<i64>("", "content_bytes").context(h!())?,
        )
        .context(h!())?,
    })
}

/// Blocks only sync batches of this device for one count query; completions
/// never touch `device_tree_stat`. Syncs committed before the lock are counted
/// here, later ones add their increment on top after this commits.
async fn rebuild_tree(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<(u64, u64)> {
    let transaction = db.begin().await.context(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            LOCK_TREE_STAT_SQL,
            [device_id.into()],
        ))
        .await
        .context("lock device tree stats")
        .context(h!())?;
    let row = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            REBUILD_TREE_STAT_SQL,
            [device_id.into()],
        ))
        .await
        .context("rebuild device tree stats")
        .context(h!())?
        .context("device tree stats row missing")
        .context(h!())?;
    let counts = (
        u64::try_from(row.try_get::<i64>("", "directory_count").context(h!())?)
            .context(h!())?,
        u64::try_from(row.try_get::<i64>("", "file_count").context(h!())?)
            .context(h!())?,
    );
    transaction.commit().await.context(h!())?;
    Ok(counts)
}

const READ_TOTALS_SQL: &str = r#"
select d.device_id,
       coalesce(t.directory_count, 0) as directory_count,
       coalesce(t.file_count, 0) as file_count,
       coalesce(s.content_count, 0) as content_count,
       coalesce(s.content_bytes, 0) as content_bytes,
       s.first_content_at,
       s.last_content_at,
       s.backfilled_at,
       exists (
           select 1 from file_content_upload u
           where u.device_id = d.device_id
             and u.status = 'completed'
             and u.stats_epoch < coalesce(s.epoch, 1)
       ) as content_pending
from unnest($1::uuid[]) as d (device_id)
left join device_content_stat s on s.device_id = d.device_id
left join device_tree_stat t on t.device_id = d.device_id
"#;

pub(in crate::devices) async fn read_sort_values(
    db: &DatabaseConnection,
    device_ids: &[Uuid],
    include_audio: bool,
) -> Result<(serde_json::Value, serde_json::Value)> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"select d.device_id, coalesce(s.content_bytes, 0) as content_bytes,
                   case when $2::boolean then greatest(s.last_content_at, s.last_audio_at)
                   else s.last_content_at end as last_content_at
               from unnest($1::uuid[]) d(device_id)
               left join device_content_stat s on s.device_id = d.device_id"#,
            [device_ids.to_vec().into(), include_audio.into()],
        ))
        .await
        .context(h!())?;
    let mut sizes = serde_json::Map::new();
    let mut activity = serde_json::Map::new();
    for row in rows {
        let id = row
            .try_get::<Uuid>("", "device_id")
            .context(h!())?
            .to_string();
        sizes.insert(
            id.clone(),
            serde_json::json!(row
                .try_get::<i64>("", "content_bytes")
                .context(h!())?),
        );
        activity.insert(
            id,
            serde_json::json!(
                get_datetime(&row, "last_content_at").context(h!())?
            ),
        );
    }
    Ok((sizes.into(), activity.into()))
}

pub(in crate::devices) async fn read_activity_page(
    db: &DatabaseConnection,
    cursor: Option<(Uuid, DateTime<FixedOffset>)>,
    limit: u64,
    include_audio: bool,
) -> Result<Vec<(Uuid, DateTime<FixedOffset>)>> {
    let activity = if include_audio {
        "greatest(last_content_at, last_audio_at)"
    } else {
        "last_content_at"
    };
    let projection = format!("device_id, {activity} as activity");
    let order = format!("{activity} desc, device_id");
    let (sql, values) = if let Some((id, at)) = cursor {
        (
            format!(
                r#"
select device_id, activity from (
    (select {projection} from device_content_stat
     where {activity} = $1 and device_id > $2
     order by {order} limit $3)
    union all
    (select {projection} from device_content_stat
     where {activity} < $1
     order by {order} limit $3)
) batch order by activity desc, device_id limit $3
"#
            ),
            vec![
                at.into(),
                id.into(),
                i64::try_from(limit).context(h!())?.into(),
            ],
        )
    } else {
        (
            format!("select {projection} from device_content_stat where {activity} is not null order by {order} limit $1"),
            vec![i64::try_from(limit).context(h!())?.into()],
        )
    };
    db.query_all_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .await
    .context(h!())?
    .into_iter()
    .map(|row| {
        Ok((
            row.try_get("", "device_id").context(h!())?,
            row.try_get("", "activity").context(h!())?,
        ))
    })
    .collect()
}

const READ_EXTENSIONS_SQL: &str = r#"
select device_id, extension, content_count, content_bytes, last_content_at
from device_content_stat_extension
where device_id = any($1)
order by device_id, content_bytes desc, extension
"#;

const READ_DAYS_SQL: &str = r#"
select device_id, day, extension, content_count, content_bytes
from device_content_stat_day
where device_id = any($1)
order by device_id, day, extension
"#;

const READ_RECENT_DAYS_SQL: &str = r#"
select d.device_id, d.day, d.extension, d.content_count, d.content_bytes
from unnest($1::uuid[]) as l (device_id)
cross join lateral (
    select max(day) as last_day
    from device_content_stat_day
    where device_id = l.device_id
) as last
join device_content_stat_day d
  on d.device_id = l.device_id
 and d.day >= least(
     last.last_day,
     (now() at time zone $2)::date - ($3::integer - 1)
 )
order by d.device_id, d.day, d.extension
"#;

#[derive(Clone, Copy)]
pub(in crate::devices) enum DayHistory {
    /// Every recorded day, for the single-device view.
    Full,
    /// The last `days` calendar days up to today in `DEVICE_STATS_TIMEZONE`;
    /// a device idle for that whole window gets its latest upload day instead,
    /// so list previews stay bounded but can still show when it was active.
    Recent { days: i32 },
}

/// Reads stats for many devices from one repeatable-read snapshot, so totals
/// and breakdowns agree. Devices without stats rows get zeroes.
pub(in crate::devices) async fn read_many(
    db: &DatabaseConnection,
    device_ids: &[Uuid],
    history: DayHistory,
) -> Result<HashMap<Uuid, DeviceStats>> {
    if device_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let transaction = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .context(h!())?;
    let query = |sql: &str| {
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [device_ids.to_vec().into()],
        )
    };

    let mut stats = HashMap::with_capacity(device_ids.len());
    for row in transaction
        .query_all_raw(query(READ_TOTALS_SQL))
        .await
        .context(h!())?
    {
        stats.insert(
            row.try_get::<Uuid>("", "device_id").context(h!())?,
            DeviceStats {
                directory_count: get_u64(&row, "directory_count")
                    .context(h!())?,
                file_count: get_u64(&row, "file_count").context(h!())?,
                content_count: get_u64(&row, "content_count").context(h!())?,
                content_bytes: get_u64(&row, "content_bytes").context(h!())?,
                first_content_at: get_datetime(&row, "first_content_at")
                    .context(h!())?,
                last_content_at: get_datetime(&row, "last_content_at")
                    .context(h!())?,
                content_pending: row
                    .try_get("", "content_pending")
                    .context(h!())?,
                backfilled_at: get_datetime(&row, "backfilled_at")
                    .context(h!())?,
                extensions: Vec::new(),
                days: Vec::new(),
            },
        );
    }
    for row in transaction
        .query_all_raw(query(READ_EXTENSIONS_SQL))
        .await
        .context(h!())?
    {
        let device_id: Uuid = row.try_get("", "device_id").context(h!())?;
        stats.get_mut(&device_id).context(h!())?.extensions.push(
            DeviceExtensionStat {
                extension: row.try_get("", "extension").context(h!())?,
                content_count: get_u64(&row, "content_count").context(h!())?,
                content_bytes: get_u64(&row, "content_bytes").context(h!())?,
                last_content_at: get_datetime(&row, "last_content_at")
                    .context(h!())?
                    .context(h!())?,
            },
        );
    }
    let days_query = match history {
        DayHistory::Full => query(READ_DAYS_SQL),
        DayHistory::Recent { days } => Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            READ_RECENT_DAYS_SQL,
            [
                device_ids.to_vec().into(),
                DEVICE_STATS_TIMEZONE.into(),
                days.into(),
            ],
        ),
    };
    for row in transaction.query_all_raw(days_query).await.context(h!())? {
        let device_id: Uuid = row.try_get("", "device_id").context(h!())?;
        stats
            .get_mut(&device_id)
            .context(h!())?
            .days
            .push(DeviceDayStat {
                day: row
                    .try_get::<NaiveDate>("", "day")
                    .context(h!())?
                    .to_string(),
                extension: row.try_get("", "extension").context(h!())?,
                content_count: get_u64(&row, "content_count").context(h!())?,
                content_bytes: get_u64(&row, "content_bytes").context(h!())?,
            });
    }
    transaction.commit().await.context(h!())?;
    Ok(stats)
}

/// Stats are decorative on read paths: a failure is logged and yields `None`
/// so device listing and summaries keep working.
pub(in crate::devices) async fn read_many_or_none(
    db: &DatabaseConnection,
    device_ids: &[Uuid],
    history: DayHistory,
) -> Option<HashMap<Uuid, DeviceStats>> {
    match read_many(db, device_ids, history).await {
        Ok(stats) => Some(stats),
        Err(error) => {
            crate::types::warn!("Device stats unavailable: {error:#}");
            None
        }
    }
}

fn get_u64(row: &QueryResult, column: &str) -> Result<u64> {
    u64::try_from(row.try_get::<i64>("", column).context(h!())?).context(h!())
}

fn get_datetime(row: &QueryResult, column: &str) -> Result<Option<String>> {
    Ok(row
        .try_get::<Option<DateTime<Utc>>>("", column)
        .context(h!())?
        .map(|value| value.to_rfc3339_opts(SecondsFormat::AutoSi, true)))
}

/// Rebuilds devices sequentially with the same reset → backfill → tree
/// recount as the endpoint, so it never blocks uploads beyond one batch.
/// Failures are logged per device and reported at the end.
pub(crate) async fn rebuild_oneoff(
    mode: crate::types::Mode,
    ps: crate::OneoffRebuildDeviceStatsPs,
) -> Result<(), crate::error::AppError> {
    let config = crate::config::read_config(mode).context(h!())?;
    let main_db = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let file_registry_db = crate::file_registry::connect_runtime(&config, mode)
        .await
        .context(h!())?
        .context("[file_registry] configuration section is missing")
        .context(h!())?;
    let device_ids = if ps.device_ids.is_empty() {
        crate::entities::device::Entity::find()
            .select_only()
            .column(crate::entities::device::Column::Id)
            .order_by_asc(crate::entities::device::Column::Id)
            .into_tuple::<Uuid>()
            .all(&main_db)
            .await
            .context(h!())?
    } else {
        ps.device_ids
    };

    let total = device_ids.len();
    let mut failed = Vec::new();
    for (index, device_id) in device_ids.into_iter().enumerate() {
        let started = std::time::Instant::now();
        match rebuild(file_registry_db.connection(), device_id).await {
            Ok(stats) => log::info!(
                "[{}/{total}] device {device_id}: {} dirs, {} files, {} uploads, {} bytes, {} batches in {:.1?}",
                index + 1,
                stats.directory_count,
                stats.file_count,
                stats.content_count,
                stats.content_bytes,
                stats.batch_count,
                started.elapsed(),
            ),
            Err(error) => {
                log::error!(
                    "[{}/{total}] device {device_id} failed: {error:#}",
                    index + 1
                );
                failed.push(device_id);
            }
        }
    }
    if !failed.is_empty() {
        return Err(anyhow::anyhow!(
            "device stats rebuild failed for {} of {total} devices: {failed:?}",
            failed.len()
        )
        .into());
    }
    log::info!("device stats rebuilt for {total} devices");
    Ok(())
}
