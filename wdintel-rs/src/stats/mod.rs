use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::messenger::group::types::{
    SignalGroupStatsTimelineEntry, SignalGroupStatsTimelinePoint,
};
use crate::rer_importer::types::*;
use crate::sigint::freq::types::FreqGroupsMessageCountByDay;
use crate::types::*;
use crate::types::{Env, Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::utils::{dt_from_millis, parse_local_datetime};
use crate::{h, OneoffCalculateHistoricStatsPs, OneoffCalculateStatsPs};
use anyhow::Context;
use chrono::*;
use echo_migration::{Expr, IntoCondition};
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use tokio::time::sleep;

pub mod cache_backfill;
pub mod redis;
pub mod worker;

pub async fn oneoff_count_group_batches(mode: Mode) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let mut offset = 0;
    let mut batches = HashSet::new();
    let cutoff = Utc::now().naive_utc() - Duration::days(365);
    let max_created_at = signal_message::Entity::find()
        .order_by_desc(signal_message::Column::CreatedAt)
        .one(&dbx)
        .await
        .c(h!())?
        .c(h!())?
        .created_at;
    loop {
        sleep(std::time::Duration::from_millis(
            ONEOFF_COUNT_BATCHES_SLEEP_MS,
        ))
        .await;
        let messages = signal_message::Entity::find()
            .filter(signal_message::Column::CreatedAt.gte(cutoff))
            .filter(signal_message::Column::CreatedAt.lte(max_created_at))
            .find_with_related(signal_message_group::Entity)
            .order_by_desc(signal_message::Column::Timestamp)
            .limit(ONEOFF_COUNT_BATCHES_SIZE)
            .offset(offset)
            .all(&dbx)
            .await
            .c(h!())?;
        if messages.is_empty() {
            break;
        }
        offset += ONEOFF_COUNT_BATCHES_SIZE;
        let mut ts = None;
        for (m, recs) in messages {
            if recs.is_empty() {
                continue;
            }
            ts = m.timestamp;
            let batch_key = recs
                .into_iter()
                .filter_map(|x| x.group_master_key)
                .sorted()
                .join(",");
            batches.insert(batch_key);
        }
        info!("[{:?}]batches found so far: {}", ts, batches.len());
    }
    info!("\n\n\n> batches found: {}", batches.len());
    for batch_key in batches {
        info!(" - {batch_key}");
    }
    Ok(())
}

pub async fn oneoff_calculate_stats(
    mode: Mode,
    ps: &OneoffCalculateStatsPs,
) -> Result<(), AppError> {
    let till_ts = match ps.end.as_deref() {
        Some(val) => parse_local_datetime(val).c(h!())?,
        None => Utc::now().naive_utc(),
    };
    let since_ts = match ps.start.as_deref() {
        Some(val) => parse_local_datetime(val).c(h!())?,
        None => start_of_day(till_ts.date() - Duration::days(1)).c(h!())?,
    };
    let config = read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let stats_redis =
        crate::new_redis_for_db(&config, config.group_stats_redis_db())
            .await
            .context(h!())?;
    let stats_redis = redis::GroupStatsRedis::new(stats_redis);
    recalculate_group_stats(&dbx, &stats_redis, since_ts, till_ts, true, true)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn oneoff_calculate_historic_stats(
    mode: Mode,
    params: OneoffCalculateHistoricStatsPs,
) -> Result<(), AppError> {
    let force = params.force;
    let recalculate_day_stats = !params.skip_day;
    let recalculate_5min_stats = !params.skip_5min;
    let config = read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let stats_redis =
        crate::new_redis_for_db(&config, config.group_stats_redis_db())
            .await
            .context(h!())?;
    let stats_redis = redis::GroupStatsRedis::new(stats_redis);
    let min_since_ts =
        Utc::now().naive_utc() - Duration::days(STATS_MIN_DATETIME_DAYS);
    let mut till_ts = Utc::now().naive_utc();
    if !force {
        info!(
            "historic Redis stats backfill refreshes the full retention window"
        );
    }

    // calculate for part of the day today in order to proceed with rest of the days from start to finish
    let date_till_dt = get_local_date(till_ts);
    let dt_till_sod = start_of_day(date_till_dt).c(h!())?;
    recalculate_group_stats(
        &dbx,
        &stats_redis,
        dt_till_sod,
        till_ts,
        true,
        recalculate_5min_stats,
    )
    .await
    .context(h!())?;
    till_ts = dt_till_sod;

    //calculate for all the remaining days
    while till_ts > min_since_ts {
        let previous_date = get_local_date(
            till_ts
                .checked_sub_signed(Duration::nanoseconds(1))
                .c(h!())?,
        );
        let since_ts = start_of_day(previous_date).c(h!())?;
        let duration = (since_ts - min_since_ts).num_days();
        info!("oneoff_calculate_historic_stats: from {since_ts} to {till_ts}, remaining {duration} days");
        recalculate_group_stats(
            &dbx,
            &stats_redis,
            since_ts,
            till_ts,
            recalculate_day_stats,
            recalculate_5min_stats,
        )
        .await
        .context(h!())?;
        till_ts = since_ts;
    }
    info!("oneoff_calculate_historic_stats: done");
    Ok(())
}

#[derive(FromQueryResult)]
struct GroupStatsActivityWindow {
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
}

#[derive(FromQueryResult)]
struct GroupStatsMessageRow {
    master_key: String,
    message_ts: NaiveDateTime,
}

pub async fn enqueue_group_stats_recalculation_for_group_history<'a, C>(
    dbx: &'a C,
    master_key: &str,
    reason: String,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'a,
{
    let min_since_ts =
        Utc::now().naive_utc() - Duration::days(STATS_MIN_DATETIME_DAYS);
    let window =
        load_group_stats_activity_window(dbx, master_key, min_since_ts)
            .await
            .c(h!())?;
    let Some((since_ts, till_ts)) = window else {
        return Ok(false);
    };

    enqueue_pending_group_stats_task(
        dbx, master_key, since_ts, till_ts, reason,
    )
    .await
    .c(h!())?;

    Ok(true)
}

pub async fn enqueue_group_stats_recalculation_for_message<'a, C>(
    dbx: &'a C,
    message_id: i64,
    reason: String,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'a,
{
    let min_since_ts =
        Utc::now().naive_utc() - Duration::days(STATS_MIN_DATETIME_DAYS);
    let message_rows = GroupStatsMessageRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                select
                    smg.group_master_key as master_key,
                    coalesce(sii.datetime, sm.created_at) as message_ts
                from signal_message_group smg
                inner join signal_message sm on sm.id = smg.signal_message_id
                inner join sigint_inbox_item sii on sii.id = sm.id
                where smg.signal_message_id = $1
                  and smg.group_master_key is not null
                  and sm.deleted = false
                  and coalesce(sii.datetime, sm.created_at) >= $2
            "#,
            vec![message_id.into(), min_since_ts.into()],
        ),
    )
    .all(dbx)
    .await
    .c(h!())?;
    let message_rows = message_rows
        .into_iter()
        .unique_by(|row| row.master_key.clone());
    let now = Utc::now().naive_utc();
    let mut enqueued = false;
    for row in message_rows {
        let since_ts = start_of_day(get_local_date(row.message_ts)).c(h!())?;
        let till_ts =
            start_of_day(get_local_date(row.message_ts) + Duration::days(1))
                .c(h!())?
                .min(now);
        if till_ts <= since_ts {
            continue;
        }
        enqueue_pending_group_stats_task(
            dbx,
            &row.master_key,
            since_ts,
            till_ts,
            reason.clone(),
        )
        .await
        .c(h!())?;
        enqueued = true;
    }
    Ok(enqueued)
}

async fn load_group_stats_activity_window<'a, C>(
    dbx: &'a C,
    master_key: &str,
    min_since_ts: NaiveDateTime,
) -> Result<Option<(NaiveDateTime, NaiveDateTime)>, AppError>
where
    C: ConnectionTrait + 'a,
{
    let sql = r#"
        select
            min(coalesce(sii.datetime, sm.created_at)) as since_ts,
            max(coalesce(sii.datetime, sm.created_at)) as till_ts
        from signal_message sm
        inner join sigint_inbox_item sii on sii.id = sm.id
        inner join signal_message_group smg on smg.signal_message_id = sm.id
        where sm.deleted = false
          and smg.group_master_key = $1
          and coalesce(sii.datetime, sm.created_at) >= $2
    "#;
    let window = GroupStatsActivityWindow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![master_key.into(), min_since_ts.into()],
        ),
    )
    .one(dbx)
    .await
    .c(h!())?;

    let Some(window) = window else {
        return Ok(None);
    };
    let Some(raw_since_ts) = window.since_ts else {
        return Ok(None);
    };
    let Some(raw_till_ts) = window.till_ts else {
        return Ok(None);
    };

    let since_ts = start_of_day(get_local_date(raw_since_ts)).c(h!())?;
    let till_ts = start_of_day(get_local_date(raw_till_ts) + Duration::days(1))
        .c(h!())?
        .min(Utc::now().naive_utc());
    if till_ts <= since_ts {
        return Ok(None);
    }
    Ok(Some((since_ts, till_ts)))
}

async fn enqueue_pending_group_stats_task<'a, C>(
    dbx: &'a C,
    master_key: &str,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    reason: String,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'a,
{
    let sql = r#"
        insert into group_stats_recalculation_task (
            group_master_key,
            since_ts,
            till_ts,
            reason
        )
        values ($1, $2, $3, $4)
        on conflict ((true))
            where completed_at is null and started_at is null
        do update set
            group_master_key = excluded.group_master_key,
            since_ts = least(
                group_stats_recalculation_task.since_ts,
                excluded.since_ts
            ),
            till_ts = greatest(
                group_stats_recalculation_task.till_ts,
                excluded.till_ts
            ),
            reason = excluded.reason
        where group_stats_recalculation_task.completed_at is null
          and group_stats_recalculation_task.started_at is null
    "#;
    loop {
        let result = dbx
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                vec![
                    master_key.into(),
                    since_ts.into(),
                    till_ts.into(),
                    reason.clone().into(),
                ],
            ))
            .await
            .c(h!())?;
        if result.rows_affected() > 0 {
            return Ok(());
        }
    }
}

pub async fn process_pending_group_stats_recalculation_task(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
) -> Result<bool, AppError> {
    group_stats_recalculation_task::Entity::delete_many()
        .filter(
            group_stats_recalculation_task::Column::CompletedAt.is_not_null(),
        )
        .exec(dbx)
        .await
        .c(h!())?;

    let Some(task) = claim_pending_group_stats_recalculation_task(dbx)
        .await
        .c(h!())?
    else {
        return Ok(false);
    };

    let chunk_till_ts = (task.since_ts
        + Duration::days(GROUP_STATS_RECALCULATION_TASK_CHUNK_DAYS))
    .min(task.till_ts);
    info!(
        "recalculating queued group stats task id={} group={} from={} till={} remaining_till={} reason={}",
        task.id,
        task.group_master_key,
        task.since_ts,
        chunk_till_ts,
        task.till_ts,
        task.reason
    );
    let result =
        recalculate_group_stats_task(dbx, stats_redis, &task, chunk_till_ts)
            .await;
    match result {
        Ok(()) => {
            if chunk_till_ts < task.till_ts {
                enqueue_pending_group_stats_task(
                    dbx,
                    &task.group_master_key,
                    chunk_till_ts,
                    task.till_ts,
                    task.reason.clone(),
                )
                .await
                .c(h!())?;
            }
            let mut task = task.into_active_model();
            task.completed_at = Set(Some(Utc::now().naive_utc()));
            task.update(dbx).await.c(h!())?;
            Ok(true)
        }
        Err(e) => {
            enqueue_pending_group_stats_task(
                dbx,
                &task.group_master_key,
                task.since_ts,
                task.till_ts,
                task.reason.clone(),
            )
            .await
            .c(h!())?;
            let mut task = task.into_active_model();
            task.completed_at = Set(Some(Utc::now().naive_utc()));
            task.update(dbx).await.c(h!())?;
            Err(e)
        }
    }
}

async fn claim_pending_group_stats_recalculation_task(
    dbx: &DatabaseConnection,
) -> Result<Option<group_stats_recalculation_task::Model>, AppError> {
    let now = Utc::now().naive_utc();
    let stale_started_before =
        now - Duration::minutes(GROUP_STATS_RECALCULATION_TASK_STALE_MINUTES);
    let sql = r#"
        update group_stats_recalculation_task
        set started_at = $1
        where id = (
            select id
            from group_stats_recalculation_task
            where completed_at is null
              and (started_at is null or started_at < $2)
            order by created_at asc, id asc
            for update skip locked
            limit 1
        )
        returning
            id,
            group_master_key,
            since_ts,
            till_ts,
            started_at,
            completed_at,
            created_at,
            reason
    "#;
    Ok(group_stats_recalculation_task::Model::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![now.into(), stale_started_before.into()],
        ),
    )
    .one(dbx)
    .await
    .c(h!())?)
}

async fn recalculate_group_stats_task(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    task: &group_stats_recalculation_task::Model,
    chunk_till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    recalculate_group_stats(
        dbx,
        stats_redis,
        task.since_ts,
        chunk_till_ts,
        true,
        true,
    )
    .await
    .c(h!())?;
    Ok(())
}

pub fn can_read_stats_aggregated(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    can_read_stats_aggregated_at(
        config,
        dt_since,
        dt_till,
        Utc::now().naive_utc(),
    )
}

fn can_read_stats_aggregated_at(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    now: NaiveDateTime,
) -> bool {
    if dt_till - dt_since < Duration::minutes(STATS_READ_FROM_TABLE_MINIMUM_MIN)
    {
        return false;
    }
    if dt_since
        < now - Duration::days(GROUP_STATS_REDIS_DETAIL_5MIN_TTL_DAYS - 1)
    {
        let since_is_day_boundary =
            start_of_day(get_local_date(dt_since)).ok() == Some(dt_since);
        let till_is_day_boundary =
            start_of_day(get_local_date(dt_till)).ok() == Some(dt_till);
        if dt_till - dt_since
            < Duration::days(GROUP_STATS_REDIS_FINE_BUCKET_MAX_DAYS)
            || !since_is_day_boundary
            || !till_is_day_boundary
        {
            return false;
        }
    }
    config
        .feature_group_stats_aggregated
        .unwrap_or(FEATURE_GROUP_STATS_AGGREGATED_DEFAULT)
}

pub fn stats_aggregated_range(
    req: &actix_web::web::Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Option<(NaiveDateTime, NaiveDateTime)>> {
    stats_aggregated_range_for_config(
        req,
        &env.config,
        dt_since,
        dt_till,
        Utc::now().naive_utc(),
    )
}

pub fn stats_aggregated_time_range(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Option<(NaiveDateTime, NaiveDateTime)>> {
    stats_aggregated_time_range_for_config(
        config,
        dt_since,
        dt_till,
        Utc::now().naive_utc(),
    )
}

pub fn should_read_stats_aggregated_for_config(
    req: &AnalysisStatsReq,
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    stats_aggregated_range_for_config(
        req,
        config,
        dt_since,
        dt_till,
        Utc::now().naive_utc(),
    )
    .is_ok_and(|range| range.is_some())
}

pub fn should_prefer_redis_stats(
    req: &AnalysisStatsReq,
    config: &Config,
) -> bool {
    let Ok(dt_since) = dt_from_millis(req.since_date_inclusive_ms) else {
        return false;
    };
    let Ok(dt_till) = dt_from_millis(req.till_date_noninclusive_ms) else {
        return false;
    };
    should_read_stats_aggregated_for_config(req, config, dt_since, dt_till)
}

fn stats_aggregated_range_for_config(
    req: &AnalysisStatsReq,
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    now: NaiveDateTime,
) -> anyhow::Result<Option<(NaiveDateTime, NaiveDateTime)>> {
    let range =
        stats_aggregated_time_range_for_config(config, dt_since, dt_till, now)?;
    Ok(range.filter(|_| req_allows_stats_aggregated(req)))
}

fn stats_aggregated_time_range_for_config(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    now: NaiveDateTime,
) -> anyhow::Result<Option<(NaiveDateTime, NaiveDateTime)>> {
    let dt_since = round_up_to_5min(dt_since)?;
    let dt_till = round_up_to_5min(dt_till.min(now))?;
    Ok(can_read_stats_aggregated_at(config, dt_since, dt_till, now)
        .then_some((dt_since, dt_till)))
}

pub(crate) fn req_allows_stats_aggregated(req: &AnalysisStatsReq) -> bool {
    if !is_filter_empty(&req.selected_groups) {
        return false;
    }
    if !is_filter_empty(&req.selected_senders) {
        return false;
    }
    if !is_filter_empty(&req.selected_freqs) {
        return false;
    }
    if !is_filter_empty(&req.selected_posts) {
        return false;
    }
    if !is_filter_empty(&req.selected_callsigns) {
        return false;
    }
    if !is_filter_empty(&req.selected_units) {
        return false;
    }
    if !is_filter_empty(&req.selected_locations) {
        return false;
    }
    if !is_filter_empty(&req.selected_aors) {
        return false;
    }
    if !is_filter_empty(&req.selected_tags) {
        return false;
    }
    if !is_filter_empty(&req.denied_tags) {
        return false;
    }
    if req.tag_presence.is_some() {
        return false;
    }
    if !is_filter_empty(&req.selected_networks) {
        return false;
    }
    if req.without_network.unwrap_or(false) {
        return false;
    }
    if req.without_metadata.unwrap_or(false) {
        return false;
    }
    if req.only_with_metadata.unwrap_or(false) {
        return false;
    }
    if !is_filter_empty(&req.metadata_cc) {
        return false;
    }
    if !is_filter_empty(&req.metadata_sender) {
        return false;
    }
    if !is_filter_empty(&req.metadata_receiver) {
        return false;
    }
    if !is_filter_empty(&req.metadata_hash) {
        return false;
    }
    if req.or_bookmarked.unwrap_or(false) {
        return false;
    }
    if req.or_important.unwrap_or(false) {
        return false;
    }
    if req.or_with_coords.unwrap_or(false) {
        return false;
    }
    if req.or_without_coords.unwrap_or(false) {
        return false;
    }
    if req.or_with_extended_form.unwrap_or(false) {
        return false;
    }
    if req.without_model_tags.unwrap_or(false) {
        return false;
    }
    if req.report_tags_only_this_unit.unwrap_or(false) {
        return false;
    }
    match req.search.clone() {
        None => true,
        Some(q) => q.is_empty(),
    }
}

pub async fn get_last_hour_stats(
    env: &actix_web::web::Data<Env>,
    batch_ids: Vec<i64>,
) -> anyhow::Result<Vec<(NaiveDateTime, HashMap<i64, i32>)>> {
    let now = round_to_5min(Utc::now().naive_utc()).c(h!())?;
    let timestamps = five_minute_timestamps(
        now - Duration::minutes(55),
        now + Duration::minutes(5),
    );
    let buckets = match group_stats_redis(env)
        .read_group_5min(&timestamps)
        .await
    {
        Ok(buckets) => buckets,
        Err(error) => {
            warn!(
                        "Redis last-hour stats missed a bucket; rebuilding from PostgreSQL: {error:#}"
            );
            repair_redis_general_stats(
                env,
                &[(now - Duration::minutes(55), now + Duration::minutes(5))],
                &[],
            )
            .await
            .c(h!())?;
            group_stats_redis(env)
                .read_group_5min(&timestamps)
                .await
                .c(h!())?
        }
    };
    let batch_ids = batch_ids.iter().copied().collect::<HashSet<_>>();
    Ok(timestamps
        .into_iter()
        .zip(buckets)
        .map(|(timestamp, bucket)| {
            let stats = bucket.groups.into_iter().fold(
                HashMap::new(),
                |mut result, row| {
                    if batch_ids.contains(&row.signal_group_batch_id) {
                        *result
                            .entry(row.signal_group_batch_id)
                            .or_default() += row.quantity;
                    }
                    result
                },
            );
            (timestamp, stats)
        })
        .collect())
}

pub async fn read_group_stats_timeline_cached(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<SignalGroupStatsTimelineEntry>> {
    let master_keys = master_keys.into_iter().unique().collect_vec();
    if master_keys.is_empty() {
        return Ok(vec![]);
    }

    let allowed_keys = master_keys.iter().cloned().collect::<HashSet<_>>();
    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect_vec();
    let batches_map = batches
        .into_iter()
        .map(|b| (b.id, batch_key_to_group_keys(b.group_master_keys)))
        .collect::<HashMap<i64, Vec<_>>>();

    let mut grouped_points = master_keys
        .iter()
        .map(|key| (key.clone(), BTreeMap::<NaiveDateTime, i64>::new()))
        .collect::<BTreeMap<_, _>>();

    if !batch_ids.is_empty() {
        let timestamps = five_minute_timestamps(dt_since, dt_till);
        let buckets = match group_stats_redis(env)
            .read_group_5min(&timestamps)
            .await
        {
            Ok(buckets) => buckets,
            Err(error) => {
                warn!(
                    "Redis group timeline missed a bucket; using raw PostgreSQL query: {error:#}"
                );
                return read_group_stats_timeline_raw(
                    &env.dbx,
                    master_keys,
                    dt_since,
                    dt_till,
                )
                .await;
            }
        };
        for (timestamp, bucket) in timestamps.into_iter().zip(buckets) {
            for stat in bucket.groups {
                if !batch_ids.contains(&stat.signal_group_batch_id) {
                    continue;
                }
                let group_keys = batches_map
                    .get(&stat.signal_group_batch_id)
                    .cloned()
                    .unwrap_or_default();
                for key in group_keys {
                    if allowed_keys.contains(&key) {
                        *grouped_points
                            .entry(key)
                            .or_default()
                            .entry(timestamp)
                            .or_insert(0) += stat.quantity as i64;
                    }
                }
            }
        }
    }

    Ok(grouped_points
        .into_iter()
        .map(|(master_key, points)| SignalGroupStatsTimelineEntry {
            master_key,
            points: points
                .into_iter()
                .map(|(ts, count)| SignalGroupStatsTimelinePoint {
                    timestamp: ts.and_utc().timestamp_millis(),
                    count,
                })
                .collect(),
        })
        .collect())
}

#[derive(FromQueryResult)]
struct GroupStatsTimelineRawRow {
    master_key: String,
    bucket: NaiveDateTime,
    count: i64,
}

pub async fn read_group_stats_timeline_raw(
    dbx: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<SignalGroupStatsTimelineEntry>> {
    let master_keys = master_keys.into_iter().unique().collect_vec();
    if master_keys.is_empty() {
        return Ok(vec![]);
    }

    let bucket_expr = Expr::cust(
        "DATE_TRUNC('minute', \
         COALESCE(\"sigint_inbox_item\".\"datetime\", \
         \"signal_message\".\"created_at\"))",
    );
    let rows = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .select_only()
        .column_as(signal_message_group::Column::GroupMasterKey, "master_key")
        .column_as(bucket_expr.clone(), "bucket")
        .column_as(
            Expr::cust(r#"COUNT(DISTINCT "signal_message"."id")"#),
            "count",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq_any(master_keys.clone()),
        )
        .filter(Expr::cust_with_values(
            "COALESCE(\"sigint_inbox_item\".\"datetime\", \
             \"signal_message\".\"created_at\") >= $1 \
             AND COALESCE(\"sigint_inbox_item\".\"datetime\", \
             \"signal_message\".\"created_at\") < $2",
            vec![dt_since, dt_till],
        ))
        .group_by(signal_message_group::Column::GroupMasterKey)
        .group_by(bucket_expr)
        .into_model::<GroupStatsTimelineRawRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut grouped_points = master_keys
        .into_iter()
        .map(|master_key| (master_key, BTreeMap::<NaiveDateTime, i64>::new()))
        .collect::<BTreeMap<_, _>>();
    for row in rows {
        let bucket = round_to_5min(row.bucket).c(h!())?;
        *grouped_points
            .entry(row.master_key)
            .or_default()
            .entry(bucket)
            .or_insert(0) += row.count;
    }

    Ok(grouped_points
        .into_iter()
        .map(|(master_key, points)| SignalGroupStatsTimelineEntry {
            master_key,
            points: points
                .into_iter()
                .map(|(timestamp, count)| SignalGroupStatsTimelinePoint {
                    timestamp: timestamp.and_utc().timestamp_millis(),
                    count,
                })
                .collect(),
        })
        .collect())
}

pub(crate) async fn collect_signal_group_batches(
    master_keys: Vec<String>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<signal_group_batch::Model>> {
    let mut filter = Condition::any();
    for key in master_keys {
        filter = filter.add(
            signal_group_batch::Column::GroupMasterKeys
                .contains(to_batch_key(&key)),
        );
    }
    signal_group_batch::Entity::find()
        .filter(filter)
        .all(dbx)
        .await
        .c(h!())
}

fn group_stats_redis(env: &Env) -> redis::GroupStatsRedis {
    redis::GroupStatsRedis::new(env.stats_redis.clone())
}

async fn load_redis_group_counts(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
) -> anyhow::Result<Vec<redis::GroupCount>> {
    match load_redis_group_counts_once(env, intervals_5min, days).await {
        Ok(result) => Ok(result),
        Err(error) => {
            warn!(
                "Redis group stats read missed a bucket; rebuilding from PostgreSQL: {error:#}"
            );
            repair_redis_general_stats(env, intervals_5min, days).await?;
            load_redis_group_counts_once(env, intervals_5min, days).await
        }
    }
}

async fn load_redis_group_counts_once(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
) -> anyhow::Result<Vec<redis::GroupCount>> {
    let stats_redis = group_stats_redis(env);
    let mut result = Vec::new();
    for (since, till) in intervals_5min.iter().copied() {
        let timestamps = five_minute_timestamps(since, till);
        result.extend(
            stats_redis
                .read_group_5min(&timestamps)
                .await
                .c(h!())?
                .into_iter()
                .flat_map(|bucket| bucket.groups),
        );
    }
    result.extend(
        stats_redis
            .read_general_days(days)
            .await
            .c(h!())?
            .into_iter()
            .flat_map(|bucket| bucket.groups),
    );
    Ok(result)
}

async fn load_redis_detail_buckets(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
) -> anyhow::Result<Vec<redis::DetailBucket>> {
    match load_redis_detail_buckets_once(env, intervals_5min, days).await {
        Ok(result) => Ok(result),
        Err(error) => {
            warn!(
                "Redis detail stats read missed a bucket; rebuilding from PostgreSQL: {error:#}"
            );
            repair_redis_general_stats(env, intervals_5min, days).await?;
            load_redis_detail_buckets_once(env, intervals_5min, days).await
        }
    }
}

async fn load_redis_detail_buckets_once(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
) -> anyhow::Result<Vec<redis::DetailBucket>> {
    let stats_redis = group_stats_redis(env);
    let mut result = Vec::new();
    for (since, till) in intervals_5min.iter().copied() {
        let timestamps = five_minute_timestamps(since, till);
        result.extend(stats_redis.read_detail_5min(&timestamps).await.c(h!())?);
    }
    result.extend(
        stats_redis
            .read_general_days(days)
            .await
            .c(h!())?
            .into_iter()
            .map(|bucket| bucket.details),
    );
    Ok(result)
}

async fn repair_redis_general_stats(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
) -> anyhow::Result<()> {
    let stats_redis = group_stats_redis(env);
    let timestamps = intervals_5min
        .iter()
        .flat_map(|(since, till)| five_minute_timestamps(*since, *till))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let missing_timestamps = stats_redis
        .missing_five_minute_buckets(&timestamps)
        .await
        .c(h!())?;
    let missing_days = stats_redis.missing_general_days(days).await.c(h!())?;
    if missing_timestamps.is_empty() && missing_days.is_empty() {
        return Ok(());
    }

    let batches = signal_group_batch::Entity::find()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut batches_map = batches
        .into_iter()
        .map(|batch| (batch.group_master_keys, batch.id))
        .collect::<HashMap<_, _>>();
    repair_redis_five_minute_buckets(
        env,
        &stats_redis,
        &missing_timestamps,
        &mut batches_map,
    )
    .await?;
    for date in missing_days {
        repair_redis_general_day(env, &stats_redis, date, &mut batches_map)
            .await?;
    }
    Ok(())
}

async fn repair_redis_five_minute_buckets(
    env: &Env,
    stats_redis: &redis::GroupStatsRedis,
    timestamps: &[NaiveDateTime],
    batches_map: &mut HashMap<String, i64>,
) -> anyhow::Result<()> {
    let mut owned = Vec::new();
    let mut contended = Vec::new();
    for timestamp in timestamps.iter().copied() {
        let bucket = redis::RepairBucket::FiveMinute(timestamp);
        if stats_redis.repair_is_complete(bucket).await? {
            continue;
        }
        match stats_redis.try_acquire_repair_lock(bucket).await? {
            Some(repair_lock) => owned.push((timestamp, repair_lock)),
            None => contended.push(bucket),
        }
    }

    let owned_timestamps =
        owned.iter().map(|(timestamp, _)| *timestamp).collect_vec();
    let missing_owned_timestamps = stats_redis
        .missing_five_minute_buckets(&owned_timestamps)
        .await?;
    let repair_result: anyhow::Result<()> = async {
        for (since, till) in
            consecutive_five_minute_ranges(&missing_owned_timestamps)
        {
            write_redis_5min_range(
                &env.dbx,
                stats_redis,
                since,
                till,
                batches_map,
            )
            .await
            .c(h!())?;
        }
        Ok(())
    }
    .await;
    let release_result =
        release_redis_repair_locks(owned.into_iter().map(|(_, lock)| lock))
            .await;
    repair_result?;
    release_result?;

    for bucket in contended {
        stats_redis.wait_for_repair(bucket).await?;
    }
    Ok(())
}

fn consecutive_five_minute_ranges(
    timestamps: &[NaiveDateTime],
) -> Vec<(NaiveDateTime, NaiveDateTime)> {
    let Some(first) = timestamps.first().copied() else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut since = first;
    let mut till = first + Duration::minutes(5);
    for timestamp in timestamps.iter().copied().skip(1) {
        if timestamp == till {
            till += Duration::minutes(5);
        } else {
            result.push((since, till));
            since = timestamp;
            till = timestamp + Duration::minutes(5);
        }
    }
    result.push((since, till));
    result
}

async fn release_redis_repair_locks(
    locks: impl IntoIterator<Item = redis::RepairLock>,
) -> anyhow::Result<()> {
    let mut result = Ok(());
    for lock in locks {
        if let Err(error) = lock.release().await {
            if result.is_ok() {
                result = Err(error);
            }
        }
    }
    result
}

async fn repair_redis_general_day(
    env: &Env,
    stats_redis: &redis::GroupStatsRedis,
    date: NaiveDate,
    batches_map: &mut HashMap<String, i64>,
) -> anyhow::Result<()> {
    let repair_bucket = redis::RepairBucket::GeneralDay(date);
    if stats_redis.repair_is_complete(repair_bucket).await? {
        return Ok(());
    }
    let Some(repair_lock) =
        stats_redis.try_acquire_repair_lock(repair_bucket).await?
    else {
        return stats_redis.wait_for_repair(repair_bucket).await;
    };
    let repair_result = async {
        if stats_redis.repair_is_complete(repair_bucket).await? {
            return Ok(());
        }
        let since = start_of_day(date).c(h!())?;
        let till = start_of_day(date + Duration::days(1)).c(h!())?;
        write_redis_general_days(
            &env.dbx,
            stats_redis,
            since,
            till,
            None,
            batches_map,
        )
        .await
        .c(h!())
    }
    .await;
    let release_result = repair_lock.release().await;
    repair_result?;
    release_result
}

#[derive(Copy, Clone)]
enum RedisIdFacet {
    Aor,
    Post,
    Tag,
}

#[derive(Copy, Clone)]
enum RedisStringFacet {
    Sender,
    Frequency,
    Callsign,
    Unit,
    Location,
}

async fn load_redis_id_stats(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
    batch_ids: &HashSet<i64>,
    facet: RedisIdFacet,
) -> anyhow::Result<HashMap<i64, i64>> {
    let mut result = HashMap::<i64, redis::HllSketch>::new();
    for mut bucket in
        load_redis_detail_buckets(env, intervals_5min, days).await?
    {
        let rows = match facet {
            RedisIdFacet::Aor => std::mem::take(&mut bucket.aor_hlls),
            RedisIdFacet::Post => std::mem::take(&mut bucket.post_hlls),
            RedisIdFacet::Tag => std::mem::take(&mut bucket.tag_hlls),
        };
        for row in rows {
            if batch_ids.contains(&row.signal_group_batch_id) {
                result.entry(row.value).or_default().merge(&row.sketch);
            }
        }
    }
    Ok(result
        .into_iter()
        .map(|(value, sketch)| (value, sketch.estimate()))
        .collect())
}

async fn load_redis_string_stats(
    env: &Env,
    intervals_5min: &[(NaiveDateTime, NaiveDateTime)],
    days: &[NaiveDate],
    batch_ids: &HashSet<i64>,
    facet: RedisStringFacet,
) -> anyhow::Result<HashMap<String, i64>> {
    let mut result = HashMap::<String, redis::HllSketch>::new();
    for mut bucket in
        load_redis_detail_buckets(env, intervals_5min, days).await?
    {
        let rows = match facet {
            RedisStringFacet::Sender => std::mem::take(&mut bucket.sender_hlls),
            RedisStringFacet::Frequency => {
                std::mem::take(&mut bucket.frequency_hlls)
            }
            RedisStringFacet::Callsign => {
                std::mem::take(&mut bucket.callsign_hlls)
            }
            RedisStringFacet::Unit => std::mem::take(&mut bucket.unit_hlls),
            RedisStringFacet::Location => {
                std::mem::take(&mut bucket.location_hlls)
            }
        };
        for row in rows {
            if batch_ids.contains(&row.signal_group_batch_id) {
                result.entry(row.value).or_default().merge(&row.sketch);
            }
        }
    }
    Ok(result
        .into_iter()
        .map(|(value, sketch)| (value, sketch.estimate()))
        .collect())
}

pub async fn read_redis_network_days(
    env: &Env,
    since_date: NaiveDate,
    till_date: NaiveDate,
    network_ids: &HashSet<i64>,
) -> anyhow::Result<Vec<(NaiveDate, redis::NetworkDayBucket)>> {
    if till_date < since_date {
        return Ok(Vec::new());
    }
    let mut dates = Vec::new();
    let mut date = since_date;
    while date <= till_date {
        dates.push(date);
        date += Duration::days(1);
    }
    let stats_redis = group_stats_redis(env);
    let buckets = match stats_redis.read_network_days(&dates, network_ids).await
    {
        Ok(buckets) => buckets,
        Err(error) => {
            warn!(
                "Redis network stats read missed a bucket; rebuilding from PostgreSQL: {error:#}"
            );
            let missing_dates = stats_redis
                .missing_network_days(&dates, network_ids)
                .await
                .c(h!())?;
            let batches = signal_group_batch::Entity::find()
                .all(&env.dbx)
                .await
                .c(h!())?;
            let mut batches_map = batches
                .into_iter()
                .map(|batch| (batch.group_master_keys, batch.id))
                .collect::<HashMap<_, _>>();
            for date in missing_dates {
                repair_redis_network_day(
                    env,
                    &stats_redis,
                    date,
                    network_ids,
                    &mut batches_map,
                )
                .await?;
            }
            stats_redis
                .read_network_days(&dates, network_ids)
                .await
                .c(h!())?
        }
    };
    Ok(dates.into_iter().zip(buckets).collect())
}

async fn repair_redis_network_day(
    env: &Env,
    stats_redis: &redis::GroupStatsRedis,
    date: NaiveDate,
    network_ids: &HashSet<i64>,
    batches_map: &mut HashMap<String, i64>,
) -> anyhow::Result<()> {
    let repair_bucket = redis::RepairBucket::NetworkDay(date);
    if stats_redis
        .network_day_is_readable(date, network_ids)
        .await?
    {
        return Ok(());
    }
    let Some(repair_lock) =
        stats_redis.try_acquire_repair_lock(repair_bucket).await?
    else {
        return stats_redis.wait_for_network_repair(date, network_ids).await;
    };
    let repair_result = async {
        if stats_redis
            .network_day_is_readable(date, network_ids)
            .await?
        {
            return Ok(());
        }
        recalculate_network_stats_redis(
            &env.dbx,
            stats_redis,
            start_of_day(date).c(h!())?,
            start_of_day(date + Duration::days(1)).c(h!())?,
            None,
            batches_map,
        )
        .await
        .c(h!())
    }
    .await;
    let release_result = repair_lock.release().await;
    repair_result?;
    release_result
}

async fn load_network_aor_map(
    dbx: &DatabaseConnection,
    network_ids: &HashSet<i64>,
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sigint_network_aor::Entity::find()
        .filter(
            sigint_network_aor::Column::NetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        )
        .all(dbx)
        .await
        .c(h!())?;

    let mut network_aors = HashMap::new();
    for row in rows {
        network_aors
            .entry(row.network_id)
            .or_insert_with(Vec::new)
            .push(row.aor_id);
    }
    Ok(network_aors)
}

pub async fn read_group_stats_aggregated_for_env(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsGroup>> {
    let allowed_keys = master_keys.iter().cloned().collect::<HashSet<_>>();
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;
    let batches = collect_signal_group_batches(master_keys, &env.dbx)
        .await
        .c(h!())?;
    let batch_ids =
        batches.iter().map(|batch| batch.id).collect::<HashSet<_>>();
    let batches_map = batches
        .into_iter()
        .map(|batch| {
            (batch.id, batch_key_to_group_keys(batch.group_master_keys))
        })
        .collect::<HashMap<_, _>>();
    let mut stats = HashMap::<String, i64>::new();
    for row in load_redis_group_counts(env, &intervals_5min, &days)
        .await
        .c(h!())?
    {
        if !batch_ids.contains(&row.signal_group_batch_id) {
            continue;
        }
        for key in batches_map
            .get(&row.signal_group_batch_id)
            .into_iter()
            .flatten()
            .filter(|key| allowed_keys.contains(*key))
        {
            *stats.entry(key.clone()).or_default() += row.quantity as i64;
        }
    }
    Ok(stats
        .into_iter()
        .map(|(master_key, count)| AnalysisStatsGroup { master_key, count })
        .collect())
}

pub async fn read_total_stats_aggregated_for_env(
    env: &Env,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<i64> {
    if master_keys.is_empty() {
        return Ok(0);
    }
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;
    let batches = collect_signal_group_batches(master_keys, &env.dbx)
        .await
        .c(h!())?;
    let batch_ids =
        batches.iter().map(|batch| batch.id).collect::<HashSet<_>>();
    Ok(load_redis_group_counts(env, &intervals_5min, &days)
        .await
        .c(h!())?
        .into_iter()
        .filter(|row| batch_ids.contains(&row.signal_group_batch_id))
        .map(|row| row.quantity as i64)
        .sum())
}

pub async fn read_aor_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsAor>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let mut stats = load_redis_id_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisIdFacet::Aor,
    )
    .await
    .c(h!())?;
    let active_aors = area_of_responsibility::Entity::find()
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .filter(
            area_of_responsibility::Column::Id
                .eq_any(stats.keys().copied().collect_vec()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .into_tuple::<i64>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    stats.retain(|aor_id, _| active_aors.contains(aor_id));
    Ok(stats
        .into_iter()
        .map(|(aor_id, count)| AnalysisStatsAor { aor_id, count })
        .collect())
}

pub async fn read_sender_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsSender>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Sender,
    )
    .await
    .c(h!())?;
    Ok(stats
        .into_iter()
        .map(|(uuid, count)| AnalysisStatsSender {
            uuid,
            count,
            freq_breakdown: vec![],
            per_day: BTreeMap::new(),
        })
        .collect())
}

pub async fn read_post_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsPost>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_id_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisIdFacet::Post,
    )
    .await
    .c(h!())?;
    let posts = sigint_post::Entity::find()
        .filter(
            sigint_post::Column::Id.eq_any(stats.keys().copied().collect_vec()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|post| (post.id, post.name))
        .collect::<HashMap<_, _>>();
    Ok(stats
        .into_iter()
        .map(|(post_id, count)| AnalysisStatsPost {
            post: posts.get(&post_id).cloned().unwrap_or_default(),
            count,
        })
        .collect())
}

pub async fn read_frequency_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsFreq>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Frequency,
    )
    .await
    .c(h!())?;
    let new_freqs = crate::rer_importer::analysis::stats::get_new_freqs(
        &env.dbx, dt_since, dt_till,
    )
    .await
    .context(h!())?;
    Ok(stats
        .into_iter()
        .map(|(freq, count)| AnalysisStatsFreq {
            is_new: new_freqs.contains(&freq),
            freq,
            count,
        })
        .collect())
}

pub async fn read_frequency_stats_day(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<FreqGroupsMessageCountByDay>> {
    anyhow::ensure!(
        is_5min_stats_bucket_range_aligned(dt_since, dt_till),
        "frequency stats range must be aligned to five-minute buckets"
    );
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    #[derive(Hash, Eq, PartialEq)]
    pub struct Key {
        pub freq: String,
        pub signal_group_batch_id: i64,
        pub day: i64,
    }

    let mut result = HashMap::<Key, i32>::new();

    let allowed_batch_ids = batch_ids.iter().copied().collect::<HashSet<_>>();
    let mut buckets = load_redis_detail_buckets(env, &intervals_5min, &days)
        .await
        .c(h!())?
        .into_iter();
    for (since, till) in &intervals_5min {
        let timestamps = five_minute_timestamps(*since, *till);
        for timestamp in timestamps {
            let bucket = buckets.next().c(h!())?;
            let day = start_of_day(get_local_date(timestamp))
                .c(h!())?
                .and_utc()
                .timestamp_millis();
            for row in bucket.frequencies {
                if allowed_batch_ids.contains(&row.signal_group_batch_id) {
                    let key = Key {
                        freq: row.value,
                        signal_group_batch_id: row.signal_group_batch_id,
                        day,
                    };
                    *result.entry(key).or_default() += row.quantity;
                }
            }
        }
    }
    for date in days.iter().copied() {
        let bucket = buckets.next().c(h!())?;
        let day = start_of_day(date).c(h!())?.and_utc().timestamp_millis();
        for row in bucket.frequencies {
            if allowed_batch_ids.contains(&row.signal_group_batch_id) {
                let key = Key {
                    freq: row.value,
                    signal_group_batch_id: row.signal_group_batch_id,
                    day,
                };
                *result.entry(key).or_default() += row.quantity;
            }
        }
    }

    let batch_groups =
        collect_signal_group_batches(master_keys.clone(), &env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .filter_map(|m| {
                batch_key_to_group_keys(m.group_master_keys)
                    .into_iter()
                    .find(|g| master_keys.contains(g))
                    .map(|key| (m.id, key))
            })
            .collect::<HashMap<_, _>>();

    let result = result
        .into_iter()
        .filter_map(|(key, count)| {
            let m_group = batch_groups.get(&key.signal_group_batch_id).cloned();
            m_group.map(|g| FreqGroupsMessageCountByDay {
                freq: key.freq,
                count: count as i64,
                group: g,
                day: key.day,
            })
        })
        .collect();
    Ok(result)
}

pub async fn read_latest_frequencies_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<String>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;
    let batch_ids = collect_signal_group_batches(master_keys, &env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|batch| batch.id)
        .collect::<HashSet<_>>();
    let mut frequencies = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Frequency,
    )
    .await
    .c(h!())?
    .into_keys()
    .collect::<Vec<_>>();
    frequencies.sort();
    Ok(frequencies)
}

pub async fn read_callsign_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsCallsign>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Callsign,
    )
    .await
    .c(h!())?;
    Ok(stats
        .into_iter()
        .map(|(callsign, count)| AnalysisStatsCallsign { callsign, count })
        .collect())
}

pub async fn read_tag_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    login: &uuid::Uuid,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsTag>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    let owner_organism_id =
        crate::tags::query::current_user_organism_id(&env.dbx, login)
            .await
            .c(h!())?;
    let accessible_tag_ids: HashSet<i64> = tag::Entity::find()
        .filter(crate::tags::query::accessible_tag_condition(
            owner_organism_id,
        ))
        .select_only()
        .column(tag::Column::Id)
        .into_tuple::<i64>()
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let mut stats = load_redis_id_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisIdFacet::Tag,
    )
    .await
    .c(h!())?;
    stats.retain(|tag_id, _| accessible_tag_ids.contains(tag_id));
    Ok(stats
        .into_iter()
        .map(|(tag_id, count)| AnalysisStatsTag { tag_id, count })
        .collect())
}

pub async fn read_unit_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsUnit>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Unit,
    )
    .await
    .c(h!())?;
    Ok(unit_stats_from_counts(stats))
}

fn unit_stats_from_counts(
    stats: HashMap<String, i64>,
) -> Vec<AnalysisStatsUnit> {
    stats
        .into_iter()
        .map(|(unit, count)| AnalysisStatsUnit {
            unit: m_unit_to_unidenfitied(Some(unit)),
            count,
        })
        .collect()
}

pub async fn read_location_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsLocation>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let batch_ids = batch_ids.into_iter().collect::<HashSet<_>>();
    let stats = load_redis_string_stats(
        env,
        &intervals_5min,
        &days,
        &batch_ids,
        RedisStringFacet::Location,
    )
    .await
    .c(h!())?;
    Ok(stats
        .into_iter()
        .map(|(location, count)| AnalysisStatsLocation { location, count })
        .collect())
}

fn is_filter_empty<T>(values: &Option<Vec<T>>) -> bool {
    match values {
        None => true,
        Some(values) => values.is_empty(),
    }
}

#[derive(FromQueryResult, Clone)]
struct StatsRow {
    pub id: i64,
    pub created_at: NaiveDateTime,
    pub datetime: Option<NaiveDateTime>,
    pub group_master_key: String,
    pub freq: Option<String>,
    pub aor_id: Option<i64>,
    pub post_id: Option<i64>,
    pub sender: Option<String>,
    pub callsigns: Option<sea_orm::prelude::Json>,
    pub tags: Option<Vec<i64>>,
    pub location_v2: Option<String>,
    pub unit_v2: Option<String>,
}

#[derive(FromQueryResult, Clone)]
struct NetworkStatsRow {
    pub id: i64,
    pub created_at: NaiveDateTime,
    pub timestamp: Option<NaiveDateTime>,
    pub datetime: Option<NaiveDateTime>,
    pub group_master_key: String,
    pub network_id: i64,
    pub freq: Option<String>,
    pub callsigns: Option<sea_orm::prelude::Json>,
}

pub(crate) fn round_to_5min(
    ts: NaiveDateTime,
) -> anyhow::Result<NaiveDateTime> {
    let hour = ts.time().hour();
    let minute_raw = ts.time().minute();
    let minute = minute_raw - minute_raw % 5;
    let time = NaiveTime::from_hms_opt(hour, minute, 0).c(h!())?;
    Ok(NaiveDateTime::new(ts.date(), time))
}

pub(crate) fn round_up_to_5min(
    ts: NaiveDateTime,
) -> anyhow::Result<NaiveDateTime> {
    let rounded = round_to_5min(ts)?;
    if rounded == ts {
        return Ok(rounded);
    }
    rounded.checked_add_signed(Duration::minutes(5)).c(h!())
}

pub fn is_5min_stats_bucket_range_aligned(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    is_5min_stats_bucket_boundary(dt_since)
        && is_5min_stats_bucket_boundary(dt_till)
}

fn is_5min_stats_bucket_boundary(ts: NaiveDateTime) -> bool {
    ts.time().minute().is_multiple_of(5)
        && ts.time().second() == 0
        && ts.time().nanosecond() == 0
}

pub async fn recalculate_group_stats(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    recalculate_day_stats: bool,
    recalculate_5min_stats: bool,
) -> Result<(), AppError> {
    recalculate_group_stats_redis(
        dbx,
        stats_redis,
        since_ts,
        till_ts,
        recalculate_day_stats,
        recalculate_5min_stats,
    )
    .await
}

async fn recalculate_group_stats_redis(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    recalculate_day_stats: bool,
    recalculate_5min_stats: bool,
) -> Result<(), AppError> {
    let since_ts = round_to_5min(since_ts).c(h!())?;
    let till_ts = round_to_5min(till_ts).c(h!())?;
    let batches = signal_group_batch::Entity::find().all(dbx).await.c(h!())?;
    let mut batches_map = batches
        .into_iter()
        .map(|batch| (batch.group_master_keys, batch.id))
        .collect::<HashMap<_, _>>();

    let buckets = if recalculate_5min_stats {
        let buckets = calculate_redis_5min_range(
            dbx,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        write_redis_5min_buckets(stats_redis, &buckets)
            .await
            .c(h!())?;
        Some(buckets)
    } else {
        None
    };

    if recalculate_day_stats {
        write_redis_general_days(
            dbx,
            stats_redis,
            since_ts,
            till_ts,
            buckets.as_ref(),
            &mut batches_map,
        )
        .await
        .c(h!())?;
        recalculate_network_stats_redis(
            dbx,
            stats_redis,
            since_ts,
            till_ts,
            None,
            &mut batches_map,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn write_redis_5min_range(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    if till_ts <= since_ts {
        return Ok(());
    }
    let buckets =
        calculate_redis_5min_range(dbx, since_ts, till_ts, batches_map)
            .await
            .c(h!())?;
    write_redis_5min_buckets(stats_redis, &buckets).await
}

async fn calculate_redis_5min_range(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<
    BTreeMap<NaiveDateTime, (redis::GroupBucket, redis::DetailBucket)>,
    AppError,
> {
    let generic_stats =
        load_generic_stats(dbx, since_ts, till_ts).await.c(h!())?;
    let network_stats = load_network_stats(dbx, since_ts, till_ts, None)
        .await
        .c(h!())?;
    let network_ids = network_stats
        .iter()
        .map(|row| row.network_id)
        .collect::<HashSet<_>>();
    let network_aors = load_network_aor_map(dbx, &network_ids).await.c(h!())?;
    let buckets = redis::build_5min_buckets(
        dbx,
        &generic_stats,
        &network_stats,
        &network_aors,
        since_ts,
        till_ts,
        batches_map,
    )
    .await
    .c(h!())?;
    Ok(buckets)
}

async fn write_redis_5min_buckets(
    stats_redis: &redis::GroupStatsRedis,
    buckets: &BTreeMap<
        NaiveDateTime,
        (redis::GroupBucket, redis::DetailBucket),
    >,
) -> Result<(), AppError> {
    for (timestamp, (groups, details)) in buckets {
        stats_redis
            .write_5min(*timestamp, groups, details)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn write_redis_general_days(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    calculated_buckets: Option<
        &BTreeMap<NaiveDateTime, (redis::GroupBucket, redis::DetailBucket)>,
    >,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    if till_ts <= since_ts {
        return Ok(());
    }
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let mut date = since_date;
    while date <= till_date {
        let day_since = start_of_day(date).c(h!())?;
        let day_till =
            start_of_day(date + Duration::days(1)).c(h!())?.min(till_ts);
        let timestamps = five_minute_timestamps(day_since, day_till);
        let calculated = calculated_buckets.and_then(|buckets| {
            timestamps
                .iter()
                .map(|timestamp| buckets.get(timestamp).cloned())
                .collect::<Option<Vec<_>>>()
        });
        let (groups, details) = if let Some(calculated) = calculated {
            calculated.into_iter().unzip()
        } else {
            let groups = stats_redis.read_group_5min(&timestamps).await;
            let details = stats_redis.read_detail_5min(&timestamps).await;
            match (groups, details) {
                (Ok(groups), Ok(details)) => (groups, details),
                (group_result, detail_result) => {
                    warn!(
                        "rebuilding missing Redis 5-minute stats for {date}: groups={:?}, details={:?}",
                        group_result.err(),
                        detail_result.err()
                    );
                    let buckets = calculate_redis_5min_range(
                        dbx,
                        day_since,
                        day_till,
                        batches_map,
                    )
                    .await
                    .c(h!())?;
                    write_redis_5min_buckets(stats_redis, &buckets)
                        .await
                        .c(h!())?;
                    (
                        buckets
                            .values()
                            .map(|(groups, _)| groups.clone())
                            .collect(),
                        buckets
                            .into_values()
                            .map(|(_, details)| details)
                            .collect(),
                    )
                }
            }
        };
        let bucket = redis::aggregate_general_day(groups, details);
        stats_redis.write_general_day(date, &bucket).await.c(h!())?;
        date += Duration::days(1);
    }
    Ok(())
}

fn five_minute_timestamps(
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Vec<NaiveDateTime> {
    let mut result = Vec::new();
    let mut timestamp = since_ts;
    while timestamp < till_ts {
        result.push(timestamp);
        timestamp += Duration::minutes(5);
    }
    result
}

async fn recalculate_network_stats_redis(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_day_ts = start_of_day(since_date).c(h!())?;
    let till_day_ts = start_of_day(till_date + Duration::days(1)).c(h!())?;
    let mut can_update_subset = network_ids.is_some();
    let mut date = since_date;
    while can_update_subset && date <= till_date {
        can_update_subset =
            stats_redis.is_network_day_complete(date).await.c(h!())?;
        date += Duration::days(1);
    }
    let calculated_network_ids =
        if can_update_subset { network_ids } else { None };
    let rows = load_network_stats(
        dbx,
        since_day_ts,
        till_day_ts,
        calculated_network_ids,
    )
    .await
    .c(h!())?;
    update_network_freq_last_seen(dbx, &rows, calculated_network_ids)
        .await
        .c(h!())?;
    let mut buckets = redis::build_network_days(dbx, &rows, batches_map)
        .await
        .c(h!())?;

    let mut date = since_date;
    while date <= till_date {
        let calculated = buckets.remove(&date).unwrap_or_default();
        if let Some(network_ids) = calculated_network_ids {
            stats_redis
                .update_network_day(date, network_ids, &calculated)
                .await
                .c(h!())?;
        } else {
            stats_redis
                .replace_network_day(date, &calculated)
                .await
                .c(h!())?;
        }
        date += Duration::days(1);
    }
    Ok(())
}

async fn update_network_freq_last_seen(
    dbx: &DatabaseConnection,
    rows: &[NetworkStatsRow],
    network_ids: Option<&HashSet<i64>>,
) -> Result<(), AppError> {
    let network_freq_ranges =
        load_network_freq_ranges(dbx, network_ids).await.c(h!())?;
    let mut last_seen = HashMap::<i64, NaiveDateTime>::new();
    let mut processed = HashSet::new();
    for row in rows {
        if !processed.insert((row.id, row.network_id)) {
            continue;
        }
        let timestamp =
            row.datetime.or(row.timestamp).unwrap_or(row.created_at);
        let Some(frequency) = row.freq.as_deref().map(str::trim) else {
            continue;
        };
        if frequency.is_empty() {
            continue;
        }
        let key = (row.network_id, frequency.to_string());
        for freq_range in
            network_freq_ranges.get(&key).into_iter().flatten().filter(
                |freq_range| is_network_freq_active_at(freq_range, timestamp),
            )
        {
            last_seen
                .entry(freq_range.id)
                .and_modify(|current| *current = (*current).max(timestamp))
                .or_insert(timestamp);
        }
    }

    let txn = dbx.begin().await.c(h!())?;
    for (network_freq_id, last_seen_dt) in last_seen {
        sigint_network_freq::Entity::update_many()
            .col_expr(
                sigint_network_freq::Column::LastSeenDt,
                Expr::value(Some(last_seen_dt)),
            )
            .filter(sigint_network_freq::Column::Id.eq(network_freq_id))
            .filter(
                sigint_network_freq::Column::LastSeenDt
                    .is_null()
                    .or(sigint_network_freq::Column::LastSeenDt
                        .lt(last_seen_dt)),
            )
            .exec(&txn)
            .await
            .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

pub async fn recalculate_network_stats(
    dbx: &DatabaseConnection,
    stats_redis: &redis::GroupStatsRedis,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
) -> Result<(), AppError> {
    let batches = signal_group_batch::Entity::find().all(dbx).await.c(h!())?;
    let mut batches_map = batches
        .into_iter()
        .map(|batch| (batch.group_master_keys, batch.id))
        .collect::<HashMap<_, _>>();
    recalculate_network_stats_redis(
        dbx,
        stats_redis,
        since_ts,
        till_ts,
        network_ids,
        &mut batches_map,
    )
    .await
}

#[derive(FromQueryResult, Clone)]
struct NetworkFreqRangeRow {
    id: i64,
    network_id: i64,
    freq: String,
    active_from: NaiveDateTime,
    active_to: Option<NaiveDateTime>,
}

async fn load_network_freq_ranges(
    dbx: &DatabaseConnection,
    network_ids: Option<&HashSet<i64>>,
) -> Result<HashMap<(i64, String), Vec<NetworkFreqRangeRow>>, AppError> {
    let mut query = sigint_network_freq::Entity::find()
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .column(sigint_network_freq::Column::NetworkId)
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::ActiveFrom)
        .column(sigint_network_freq::Column::ActiveTo)
        .filter(sigint_network_freq::Column::Deleted.eq(false));
    if let Some(network_ids) = network_ids {
        query = query.filter(
            sigint_network_freq::Column::NetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    let rows = query
        .into_model::<NetworkFreqRangeRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut res: HashMap<(i64, String), Vec<NetworkFreqRangeRow>> =
        HashMap::new();
    for row in rows {
        res.entry((row.network_id, row.freq.clone()))
            .or_default()
            .push(row);
    }
    Ok(res)
}

fn is_network_freq_active_at(
    freq: &NetworkFreqRangeRow,
    ts: NaiveDateTime,
) -> bool {
    freq.active_from <= ts && freq.active_to.map(|dt| dt >= ts).unwrap_or(true)
}

pub async fn recalculate_last_seen_for_networks_exact(
    dbx: &DatabaseConnection,
    network_ids: &HashSet<i64>,
    active_freqs_only: bool,
) -> Result<(), AppError> {
    if network_ids.is_empty() {
        return Ok(());
    }

    let network_ids_sql = network_ids.iter().copied().sorted().join(",");
    let active_freq_filter = if active_freqs_only {
        " and nf.active_to is null"
    } else {
        ""
    };
    let active_freq_filter_inner = if active_freqs_only {
        " and nf_inner.active_to is null"
    } else {
        ""
    };

    let reset_sql = format!(
        "update sigint_network_freq as nf
         set last_seen_dt = null
         where nf.deleted = false
           and nf.network_id in ({network_ids_sql}){active_freq_filter}"
    );

    dbx.execute(Statement::from_string(DatabaseBackend::Postgres, reset_sql))
        .await
        .c(h!())?;

    let update_sql = format!(
        "update sigint_network_freq as nf
         set last_seen_dt = sub.last_seen_dt
         from (
             select
                 nf_inner.id as network_freq_id,
                 max(coalesce(sii.datetime, sm.timestamp, sm.created_at)) as last_seen_dt
             from sigint_network_freq as nf_inner
             join sigint_inbox_item_network as siin
                 on siin.sigint_network_id = nf_inner.network_id
             join sigint_inbox_item as sii
                 on sii.id = siin.sigint_inbox_item_id
             join signal_message as sm
                 on sm.id = sii.id
             where nf_inner.deleted = false
               and nf_inner.network_id in ({network_ids_sql}){active_freq_filter_inner}
               and sm.deleted = false
               and sii.freq = nf_inner.freq
               and coalesce(sii.datetime, sm.timestamp, sm.created_at) >= nf_inner.active_from
               and coalesce(sii.datetime, sm.timestamp, sm.created_at) <= coalesce(nf_inner.active_to, current_timestamp at time zone 'utc')
             group by nf_inner.id
         ) as sub
         where nf.id = sub.network_freq_id"
    );

    dbx.execute(Statement::from_string(
        DatabaseBackend::Postgres,
        update_sql,
    ))
    .await
    .c(h!())?;

    Ok(())
}

async fn load_generic_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<StatsRow>, AppError> {
    let stats_by_datetime =
        generic_stats_by_datetime(dbx, since_ts, till_ts).await?;
    let stats_by_created_at =
        generic_stats_by_created_at(dbx, since_ts, till_ts).await?;
    let mut stats = stats_by_datetime
        .into_iter()
        .chain(stats_by_created_at)
        .collect_vec();
    enrich_stats_callsigns(dbx, &mut stats).await?;
    Ok(stats)
}

async fn generic_stats_by_datetime(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<StatsRow>, AppError> {
    let stats = generic_stats_base_select()
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(since_ts))
        .filter(sigint_inbox_item::Column::Datetime.lt(till_ts))
        .into_model::<StatsRow>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(stats)
}

async fn generic_stats_by_created_at(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<StatsRow>, AppError> {
    let stats = generic_stats_base_select()
        .filter(sigint_inbox_item::Column::Datetime.is_null())
        .filter(signal_message::Column::CreatedAt.gte(since_ts))
        .filter(signal_message::Column::CreatedAt.lt(till_ts))
        .into_model::<StatsRow>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(stats)
}

fn generic_stats_base_select() -> Select<signal_message::Entity> {
    signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item_tag::Relation::SigintInboxItem
                .def()
                .rev()
                .on_condition(|_left, right| {
                    Expr::col((
                        right,
                        sigint_inbox_item_tag::Column::Confidence,
                    ))
                    .gte(TAG_MINIMUM_CONFIDENCE)
                    .into_condition()
                }),
        )
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::CreatedAt)
        .column(sigint_inbox_item::Column::Datetime)
        .column(signal_message_group::Column::GroupMasterKey)
        .column(sigint_inbox_item::Column::Freq)
        .column_as(Expr::cust("'[]'::jsonb"), "callsigns")
        .column(sigint_inbox_item::Column::LocationV2)
        .column(sigint_inbox_item::Column::UnitV2)
        .column(sigint_inbox_item::Column::PostId)
        .column(signal_message::Column::Sender)
        .column(signal_group_aor::Column::AorId)
        .expr_as(
            Expr::cust_with_expr(
                "array_agg($1) filter (where $1 is not null)",
                Expr::col(sigint_inbox_item_tag::Column::TagId),
            ),
            "tags",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .group_by(signal_message_group::Column::GroupMasterKey)
        .group_by(signal_group_aor::Column::Id)
}

async fn load_network_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
) -> Result<Vec<NetworkStatsRow>, AppError> {
    let stats_by_datetime =
        network_stats_by_datetime(dbx, since_ts, till_ts, network_ids).await?;
    let stats_by_created_at =
        network_stats_by_created_at(dbx, since_ts, till_ts, network_ids)
            .await?;
    let mut stats = stats_by_datetime
        .into_iter()
        .chain(stats_by_created_at)
        .collect_vec();
    enrich_network_stats_callsigns(dbx, &mut stats).await?;
    Ok(stats)
}

async fn network_stats_by_datetime(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
) -> Result<Vec<NetworkStatsRow>, AppError> {
    let mut stats = network_stats_base_select()
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .filter(sigint_inbox_item::Column::Datetime.gte(since_ts))
        .filter(sigint_inbox_item::Column::Datetime.lt(till_ts));
    if let Some(network_ids) = network_ids {
        stats = stats.filter(
            sigint_inbox_item_network::Column::SigintNetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    let stats = stats
        .into_model::<NetworkStatsRow>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(stats)
}

async fn network_stats_by_created_at(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
) -> Result<Vec<NetworkStatsRow>, AppError> {
    let ts_filter = Condition::any()
        .add(
            Condition::all()
                .add(signal_message::Column::Timestamp.is_not_null())
                .add(signal_message::Column::Timestamp.gte(since_ts))
                .add(signal_message::Column::Timestamp.lt(till_ts)),
        )
        .add(
            Condition::all()
                .add(signal_message::Column::Timestamp.is_null())
                .add(signal_message::Column::CreatedAt.gte(since_ts))
                .add(signal_message::Column::CreatedAt.lt(till_ts)),
        );
    let mut stats = network_stats_base_select()
        .filter(sigint_inbox_item::Column::Datetime.is_null())
        .filter(ts_filter);
    if let Some(network_ids) = network_ids {
        stats = stats.filter(
            sigint_inbox_item_network::Column::SigintNetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    let stats = stats
        .into_model::<NetworkStatsRow>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(stats)
}

fn network_stats_base_select() -> Select<signal_message::Entity> {
    signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::CreatedAt)
        .column(signal_message::Column::Timestamp)
        .column(sigint_inbox_item::Column::Datetime)
        .column(signal_message_group::Column::GroupMasterKey)
        .column(sigint_inbox_item::Column::Freq)
        .column_as(Expr::cust("'[]'::jsonb"), "callsigns")
        .column_as(
            sigint_inbox_item_network::Column::SigintNetworkId,
            "network_id",
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .group_by(signal_message::Column::Id)
        .group_by(sigint_inbox_item::Column::Id)
        .group_by(signal_message_group::Column::GroupMasterKey)
        .group_by(sigint_inbox_item_network::Column::SigintNetworkId)
}

async fn enrich_stats_callsigns(
    dbx: &DatabaseConnection,
    stats: &mut [StatsRow],
) -> Result<(), AppError> {
    let callsigns = load_stats_callsigns(
        dbx,
        &stats.iter().map(|row| row.id).collect_vec(),
    )
    .await?;
    for row in stats {
        if let Some(callsigns) = callsigns.get(&row.id) {
            row.callsigns = Some(callsigns.clone());
        }
    }
    Ok(())
}

async fn enrich_network_stats_callsigns(
    dbx: &DatabaseConnection,
    stats: &mut [NetworkStatsRow],
) -> Result<(), AppError> {
    let callsigns = load_stats_callsigns(
        dbx,
        &stats.iter().map(|row| row.id).collect_vec(),
    )
    .await?;
    for row in stats {
        if let Some(callsigns) = callsigns.get(&row.id) {
            row.callsigns = Some(callsigns.clone());
        }
    }
    Ok(())
}

async fn load_stats_callsigns(
    dbx: &DatabaseConnection,
    inbox_item_ids: &[i64],
) -> Result<HashMap<i64, sea_orm::prelude::Json>, AppError> {
    let callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, inbox_item_ids).await?;
    callsigns
        .into_iter()
        .map(|(inbox_item_id, callsigns)| {
            Ok((
                inbox_item_id,
                serde_json::to_value(callsigns.effective()).c(h!())?,
            ))
        })
        .collect()
}

fn collect_time_intervals_for_stats(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<(Vec<(NaiveDateTime, NaiveDateTime)>, Vec<NaiveDate>)> {
    collect_time_intervals_for_stats_with_max_days(
        dt_since,
        dt_till,
        GROUP_STATS_REDIS_FINE_BUCKET_MAX_DAYS,
    )
}

fn collect_time_intervals_for_stats_with_max_days(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
    max_days: i64,
) -> anyhow::Result<(Vec<(NaiveDateTime, NaiveDateTime)>, Vec<NaiveDate>)> {
    let mut intervals_5min = vec![];
    let mut days = vec![];
    if dt_till - dt_since < Duration::days(max_days) {
        intervals_5min.push((dt_since, dt_till));
    } else {
        let since_date = get_local_date(dt_since);
        let since_day_start = start_of_day(since_date).c(h!())?;
        let mut date = since_date;
        if dt_since != since_day_start {
            date += Duration::days(1);
            intervals_5min.push((dt_since, start_of_day(date).c(h!())?));
        }

        let till_date = get_local_date(dt_till);
        let till_day_start = start_of_day(till_date).c(h!())?;
        if dt_till != till_day_start {
            intervals_5min.push((till_day_start, dt_till));
        }

        while date < till_date {
            days.push(date);
            date += Duration::days(1);
        }
    }
    Ok((intervals_5min, days))
}

pub fn start_of_day(since_date: NaiveDate) -> Result<NaiveDateTime, AppError> {
    Ok(NaiveDateTime::new(since_date, NaiveTime::MIN)
        .and_local_timezone(get_tz())
        .earliest()
        .c(h!())?
        .naive_utc())
}

fn till_date_inclusive_for_exclusive_till(
    till_ts: NaiveDateTime,
) -> Result<NaiveDate, AppError> {
    let till_ts = till_ts
        .checked_sub_signed(Duration::nanoseconds(1))
        .c(h!())?;
    Ok(get_local_date(till_ts))
}

pub(crate) fn get_local_date(since_ts: NaiveDateTime) -> NaiveDate {
    since_ts.and_utc().with_timezone(&get_tz()).date_naive()
}

pub fn collect_signal_group_batch_ids_by_master_key(
    master_key: &str,
    batches: &Vec<signal_group_batch::Model>,
) -> Vec<i64> {
    let key = &to_batch_key(master_key);
    batches
        .iter()
        .filter(|b| b.group_master_keys.contains(key))
        .map(|x| x.id)
        .collect_vec()
}

fn to_batch_key(key: &str) -> String {
    format!("|{key}|")
}

fn all_to_batch_key(keys: HashSet<String>) -> String {
    if keys.is_empty() {
        return String::default();
    }
    let text = keys.into_iter().sorted().join("|");
    to_batch_key(&text)
}

async fn ensure_batch_key(
    dbx: &DatabaseTransaction,
    batches_map: &mut HashMap<String, i64>,
    batch_key: &String,
) -> anyhow::Result<()> {
    if !batches_map.contains_key(batch_key) {
        let model = signal_group_batch::ActiveModel {
            id: NotSet,
            group_master_keys: Set(batch_key.clone()),
            created_at: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;
        batches_map.insert(batch_key.clone(), model.id);
    }
    Ok(())
}

fn batch_key_to_group_keys(batch_key: String) -> Vec<String> {
    let mut keys = vec![];
    for key in batch_key.split("|") {
        if key.is_empty() {
            continue;
        }
        keys.push(key.trim().to_string())
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregated_unit_stats_normalize_the_unknown_bucket() {
        let units = unit_stats_from_counts(HashMap::from([
            (String::new(), 13),
            ("4 зБпС 50 обрБпС".to_string(), 11),
        ]));

        assert!(units.contains(&AnalysisStatsUnit {
            unit: "Не визначено".to_string(),
            count: 13,
        }));
        assert!(units.contains(&AnalysisStatsUnit {
            unit: "4 зБпС 50 обрБпС".to_string(),
            count: 11,
        }));
    }

    #[test]
    fn consecutive_five_minute_buckets_are_batched() {
        let first = ndt(2026, 7, 29, 12, 0);
        assert_eq!(
            consecutive_five_minute_ranges(&[
                first,
                first + Duration::minutes(5),
                first + Duration::minutes(15),
            ]),
            vec![
                (first, first + Duration::minutes(10)),
                (first + Duration::minutes(15), first + Duration::minutes(20),),
            ]
        );
    }
    use crate::functest::tests::*;
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

    fn analysis_stats_req0() -> AnalysisStatsReq {
        AnalysisStatsReq {
            since_date_inclusive_ms: 0,
            till_date_noninclusive_ms: 0,
            selected_groups: None,
            selected_senders: None,
            selected_freqs: None,
            selected_posts: None,
            selected_callsigns: None,
            selected_units: None,
            selected_locations: None,
            selected_device_names: None,
            selected_aors: None,
            or_with_extended_form: None,
            or_bookmarked: None,
            or_important: None,
            or_with_coords: None,
            or_without_coords: None,
            search: None,
            selected_tags: None,
            denied_tags: None,
            tag_presence: None,
            selected_networks: None,
            without_network: None,
            metadata_cc: None,
            metadata_sender: None,
            metadata_receiver: None,
            metadata_hash: None,
            only_with_metadata: None,
            without_metadata: None,
            include_peleng_locations: None,
            units_exact_match_only: None,
            filter_tags_option: None,
            without_model_tags: None,
            report_tags_only_this_unit: None,
        }
    }

    async fn mk_group_with_stats_message(
        txn: &DatabaseTransaction,
        master_key: &str,
        message_ts: NaiveDateTime,
    ) -> signal_group::Model {
        let group = mk_signal_group(
            txn,
            signal_group::ActiveModel {
                master_key: Set(master_key.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_signal_message(
            txn,
            signal_message::ActiveModel {
                created_at: Set(message_ts),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_ts_kyiv =
            message_ts.and_utc().with_timezone(&chrono_tz::Europe::Kyiv);
        mk_sigint_inbox_item(
            txn,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                date: Set(Some(message_ts_kyiv.format("%Y-%m-%d").to_string())),
                time: Set(Some(message_ts_kyiv.format("%H:%M:%S").to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        group
    }

    #[test]
    fn test_get_local_date() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(11, 5, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date);
    }

    #[test]
    fn test_get_local_date_early() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(1, 55, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date);
    }

    #[test]
    fn test_get_local_date_late() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(21, 5, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date + Duration::days(1));
    }

    #[test]
    fn test_start_of_day() {
        let dt = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let expected_ts = NaiveDateTime::new(
            dt - Duration::days(1),
            NaiveTime::from_hms_opt(21, 0, 0).unwrap(),
        );
        let actual_ts = start_of_day(dt).unwrap();
        assert_eq!(actual_ts, expected_ts);
    }

    #[test]
    fn test_start_of_day_dst() {
        let dt = NaiveDate::from_ymd_opt(2025, 11, 11).unwrap();
        let expected_ts = NaiveDateTime::new(
            dt - Duration::days(1),
            NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
        );
        let actual_ts = start_of_day(dt).unwrap();
        assert_eq!(actual_ts, expected_ts);
    }

    #[test]
    fn test_should_read_stats_aggregated_false_for_only_with_metadata() {
        let req = AnalysisStatsReq {
            only_with_metadata: Some(true),
            ..analysis_stats_req0()
        };

        assert!(!req_allows_stats_aggregated(&req));
    }

    #[test]
    fn test_should_read_stats_aggregated_false_for_checkbox_filters() {
        let reqs = [
            AnalysisStatsReq {
                without_network: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                or_bookmarked: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                or_important: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                or_with_coords: Some(true),
                or_without_coords: None,
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                or_without_coords: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                or_with_extended_form: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                without_model_tags: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                report_tags_only_this_unit: Some(true),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                denied_tags: Some(vec![1]),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                tag_presence: Some(TagPresenceFilter::WithoutTags),
                ..analysis_stats_req0()
            },
            AnalysisStatsReq {
                tag_presence: Some(TagPresenceFilter::WithTags),
                ..analysis_stats_req0()
            },
        ];

        for req in reqs {
            assert!(!req_allows_stats_aggregated(&req));
        }
    }

    #[test]
    fn test_stats_aggregated_range_rounds_up_and_caps_at_current_bucket() {
        let req = analysis_stats_req0();
        let config = stats_aggregated_config();
        let offset = Duration::seconds(27) + Duration::milliseconds(708);
        let dt_since = ndt(2026, 7, 15, 11, 16) + offset;
        let dt_till = ndt(2026, 7, 30, 11, 16) + offset;
        let now = ndt(2026, 7, 29, 11, 16) + Duration::seconds(30);

        assert_eq!(
            stats_aggregated_range_for_config(
                &req, &config, dt_since, dt_till, now,
            )
            .unwrap(),
            Some((ndt(2026, 7, 15, 11, 20), ndt(2026, 7, 29, 11, 20),))
        );
    }

    #[test]
    fn test_stats_aggregated_time_range_rounds_production_timestamp() {
        let mut config = stats_aggregated_config();
        let dt_since = ndt(2026, 7, 20, 8, 44) + Duration::seconds(27);
        let dt_till = ndt(2026, 7, 30, 8, 44) + Duration::seconds(27);
        let now = ndt(2026, 7, 30, 9, 0);

        assert_eq!(
            stats_aggregated_time_range_for_config(
                &config, dt_since, dt_till, now,
            )
            .unwrap(),
            Some((ndt(2026, 7, 20, 8, 45), ndt(2026, 7, 30, 8, 45),))
        );
        assert_eq!(
            stats_aggregated_time_range_for_config(
                &config,
                ndt(2026, 7, 20, 8, 45),
                ndt(2026, 7, 30, 8, 45),
                now,
            )
            .unwrap(),
            Some((ndt(2026, 7, 20, 8, 45), ndt(2026, 7, 30, 8, 45),))
        );

        config.feature_group_stats_aggregated = Some(false);
        assert_eq!(
            stats_aggregated_time_range_for_config(
                &config, dt_since, dt_till, now,
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn test_collect_time_intervals_for_stats_short_duration_if_branch() {
        // 2 days and 1 second
        let dt_since = ndt(2025, 10, 10, 10, 0);
        let dt_till = ndt(2025, 10, 12, 9, 59);

        assert!(
            dt_till - dt_since
                < Duration::days(GROUP_STATS_REDIS_FINE_BUCKET_MAX_DAYS)
        );

        let (intervals, days) =
            collect_time_intervals_for_stats(dt_since, dt_till).unwrap();
        assert_eq!(intervals.len(), 1, "Should have exactly one interval.");
        assert_eq!(
            intervals[0],
            (dt_since, dt_till),
            "The single interval should cover the whole range."
        );
        assert!(days.is_empty(), "The days vector should be empty.");
    }

    #[test]
    fn test_collect_time_intervals_for_stats_long_duration_else_branch() {
        let dt_since = ndt(2015, 10, 10, 10, 30); // TODO fix year to 2025
        let dt_till = ndt(2025, 10, 15, 5, 15);
        assert!(
            dt_till - dt_since
                >= Duration::days(GROUP_STATS_REDIS_FINE_BUCKET_MAX_DAYS)
        );
        let (intervals, days) =
            collect_time_intervals_for_stats(dt_since, dt_till).unwrap();
        let tz = get_tz();
        let date_after_since_dt =
            dt_since.and_utc().with_timezone(&tz).date_naive()
                + Duration::days(1);
        let dt_since_eod = start_of_day(date_after_since_dt).unwrap();
        let date_till_dt = dt_till.and_utc().with_timezone(&tz).date_naive();
        let dt_till_sod = start_of_day(date_till_dt).unwrap();
        assert_eq!(
            intervals.len(),
            2,
            "Should have exactly two intervals (start and end parts)."
        );
        assert_eq!(
            intervals[0],
            (dt_since, dt_since_eod),
            "First interval should be from dt_since to start of the next day."
        );
        assert_eq!(
            intervals[1],
            (dt_till_sod, dt_till),
            "Second interval should be from start of the till day to dt_till."
        );
        assert_eq!(days.first(), Some(&date_after_since_dt));
        assert_eq!(days.last(), Some(&(date_till_dt - Duration::days(1))));
        assert_eq!(
            days.len(),
            date_till_dt
                .signed_duration_since(date_after_since_dt)
                .num_days() as usize
        );
        assert!(!days.contains(&date_till_dt));
    }

    #[test]
    fn test_is_5min_stats_bucket_range_aligned() {
        assert!(is_5min_stats_bucket_range_aligned(
            ndt(2025, 10, 10, 10, 0),
            ndt(2025, 10, 10, 10, 15),
        ));
        assert!(!is_5min_stats_bucket_range_aligned(
            ndt(2025, 10, 10, 10, 1),
            ndt(2025, 10, 10, 10, 15),
        ));
        assert!(!is_5min_stats_bucket_range_aligned(
            ndt(2025, 10, 10, 10, 0),
            ndt(2025, 10, 10, 10, 16),
        ));
        assert!(!is_5min_stats_bucket_range_aligned(
            ndt(2025, 10, 10, 10, 0) + Duration::seconds(27),
            ndt(2025, 10, 10, 10, 15),
        ));
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_for_group_history_uses_message_day(
    ) {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();

        let message_ts = Utc::now().naive_utc() - Duration::days(3);
        let group =
            mk_group_with_stats_message(&txn, "stats-recalc-group", message_ts)
                .await;

        let enqueued = enqueue_group_stats_recalculation_for_group_history(
            &txn,
            &group.master_key,
            "test group stats enqueue".to_string(),
        )
        .await
        .unwrap();
        assert!(enqueued);

        let task = group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::GroupMasterKey
                    .eq(group.master_key.clone()),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            task.since_ts,
            start_of_day(get_local_date(message_ts)).unwrap()
        );
        assert_eq!(
            task.till_ts,
            start_of_day(get_local_date(message_ts) + Duration::days(1))
                .unwrap()
        );

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_for_message() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let message_ts = Utc::now().naive_utc() - Duration::days(3);
        let group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-message",
            message_ts,
        )
        .await;
        let message_id = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq(group.master_key.clone()),
            )
            .select_only()
            .column(signal_message_group::Column::SignalMessageId)
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .unwrap()
            .unwrap();

        assert!(enqueue_group_stats_recalculation_for_message(
            &txn,
            message_id,
            "test message stats enqueue".to_string(),
        )
        .await
        .unwrap());
        let task = group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::GroupMasterKey
                    .eq(group.master_key),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            task.since_ts,
            start_of_day(get_local_date(message_ts)).unwrap()
        );
        assert_eq!(
            task.till_ts,
            start_of_day(get_local_date(message_ts) + Duration::days(1))
                .unwrap()
        );

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_for_expired_message() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let message_ts = Utc::now().naive_utc()
            - Duration::days(STATS_MIN_DATETIME_DAYS + 1);
        let group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-expired-message",
            message_ts,
        )
        .await;
        let message_id = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::GroupMasterKey
                    .eq(group.master_key),
            )
            .select_only()
            .column(signal_message_group::Column::SignalMessageId)
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .unwrap()
            .unwrap();

        assert!(!enqueue_group_stats_recalculation_for_message(
            &txn,
            message_id,
            "test expired message stats enqueue".to_string(),
        )
        .await
        .unwrap());
        assert_eq!(
            group_stats_recalculation_task::Entity::find()
                .count(&txn)
                .await
                .unwrap(),
            0
        );

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_skips_empty_history() {
        let env = cleanup().await.unwrap();
        let group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set("stats-recalc-empty-group".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let enqueued = enqueue_group_stats_recalculation_for_group_history(
            &env.dbx,
            &group.master_key,
            "test empty group stats enqueue".to_string(),
        )
        .await
        .unwrap();

        assert!(!enqueued);
        assert_eq!(
            group_stats_recalculation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_merges_global_window() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let old_message_ts = Utc::now().naive_utc() - Duration::days(4);
        let recent_message_ts = Utc::now().naive_utc() - Duration::days(2);
        let old_group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-old-group",
            old_message_ts,
        )
        .await;
        let recent_group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-recent-group",
            recent_message_ts,
        )
        .await;

        for group in [&old_group, &recent_group] {
            assert!(enqueue_group_stats_recalculation_for_group_history(
                &txn,
                &group.master_key,
                format!("test global merge for {}", group.master_key),
            )
            .await
            .unwrap());
        }

        let tasks = group_stats_recalculation_task::Entity::find()
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(
            tasks[0].since_ts,
            start_of_day(get_local_date(old_message_ts)).unwrap()
        );
        assert_eq!(
            tasks[0].till_ts,
            start_of_day(get_local_date(recent_message_ts) + Duration::days(1))
                .unwrap()
        );

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_follows_running_task() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let message_ts = Utc::now().naive_utc() - Duration::days(3);
        let running_group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-running-group",
            message_ts,
        )
        .await;
        let changed_group = mk_group_with_stats_message(
            &txn,
            "stats-recalc-changed-group",
            message_ts,
        )
        .await;
        let since_ts = start_of_day(get_local_date(message_ts)).unwrap();
        let till_ts =
            start_of_day(get_local_date(message_ts) + Duration::days(1))
                .unwrap();
        group_stats_recalculation_task::ActiveModel {
            group_master_key: Set(running_group.master_key),
            since_ts: Set(since_ts),
            till_ts: Set(till_ts),
            started_at: Set(Some(Utc::now().naive_utc())),
            reason: Set("running task".to_string()),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();

        assert!(enqueue_group_stats_recalculation_for_group_history(
            &txn,
            &changed_group.master_key,
            "change during running task".to_string(),
        )
        .await
        .unwrap());

        let tasks = group_stats_recalculation_task::Entity::find()
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(
            tasks
                .iter()
                .filter(|task| task.started_at.is_none())
                .count(),
            1
        );

        txn.rollback().await.unwrap();
    }

    fn ndt(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
    ) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    fn stats_aggregated_config() -> Config {
        toml::from_str(
            r#"
public_host = ""
cookie_session_secret = ""
storage_dir = ""
signal_api_phone = ""
signal_import_group_name = ""
signal_import_fiven_name = ""
static_path = ""
executable_path = ""
fill_comp_freq_worker = false
feature_group_stats_aggregated = true
"#,
        )
        .unwrap()
    }
}
