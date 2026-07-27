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
use crate::utils::parse_local_datetime;
use crate::{h, OneoffCalculateHistoricStatsPs, OneoffCalculateStatsPs};
use anyhow::Context;
use chrono::*;
use echo_migration::{Expr, IntoCondition};
use itertools::Itertools;
use sea_orm::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::time::sleep;

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
    recalculate_group_stats(&dbx, since_ts, till_ts, true, true)
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
    let min_since_ts =
        Utc::now().naive_utc() - Duration::days(STATS_MIN_DATETIME_DAYS);
    let min_since_ts = signal_message::Entity::find()
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_asc(signal_message::Column::CreatedAt)
        .one(&dbx)
        .await
        .c(h!())?
        .map(|x| x.created_at)
        .filter(|ts| min_since_ts.lt(ts))
        .unwrap_or(min_since_ts);
    let mut till_ts = Utc::now().naive_utc();
    if !force {
        till_ts = stats_group_5min::Entity::find()
            .order_by_asc(stats_group_5min::Column::Dt)
            .one(&dbx)
            .await
            .c(h!())?
            .map(|x| x.dt)
            .unwrap_or(Utc::now().naive_utc())
    };

    // calculate for part of the day today in order to proceed with rest of the days from start to finish
    let date_till_dt = get_local_date(till_ts);
    let dt_till_sod = start_of_day(date_till_dt).c(h!())?;
    recalculate_group_stats(
        &dbx,
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
        let since_ts = till_ts - Duration::days(1);
        let duration = (since_ts - min_since_ts).num_days();
        info!("oneoff_calculate_historic_stats: from {since_ts} to {till_ts}, remaining {duration} days");
        recalculate_group_stats(
            &dbx,
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

    if merge_pending_group_stats_task(dbx, master_key, since_ts, till_ts)
        .await
        .c(h!())?
    {
        return Ok(true);
    }

    group_stats_recalculation_task::ActiveModel {
        id: NotSet,
        group_master_key: Set(master_key.to_string()),
        since_ts: Set(since_ts),
        till_ts: Set(till_ts),
        started_at: Set(None),
        completed_at: Set(None),
        created_at: NotSet,
        reason: Set(reason),
    }
    .insert(dbx)
    .await
    .c(h!())?;

    Ok(true)
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
    let Some(_raw_till_ts) = window.till_ts else {
        return Ok(None);
    };

    let since_ts = start_of_day(get_local_date(raw_since_ts)).c(h!())?;
    let till_ts = Utc::now().naive_utc();
    if till_ts <= since_ts {
        return Ok(None);
    }
    Ok(Some((since_ts, till_ts)))
}

async fn merge_pending_group_stats_task<'a, C>(
    dbx: &'a C,
    master_key: &str,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<bool, AppError>
where
    C: ConnectionTrait + 'a,
{
    let task = group_stats_recalculation_task::Entity::find()
        .filter(
            group_stats_recalculation_task::Column::GroupMasterKey
                .eq(master_key),
        )
        .filter(group_stats_recalculation_task::Column::CompletedAt.is_null())
        .filter(group_stats_recalculation_task::Column::StartedAt.is_null())
        .order_by_asc(group_stats_recalculation_task::Column::SinceTs)
        .one(dbx)
        .await
        .c(h!())?;

    if let Some(task) = task {
        let merged_since_ts = task.since_ts.min(since_ts);
        let merged_till_ts = task.till_ts.max(till_ts);
        if merged_since_ts != task.since_ts || merged_till_ts != task.till_ts {
            let mut task = task.into_active_model();
            task.since_ts = Set(merged_since_ts);
            task.till_ts = Set(merged_till_ts);
            task.update(dbx).await.c(h!())?;
        }
        return Ok(true);
    }

    Ok(group_stats_recalculation_task::Entity::find()
        .filter(
            group_stats_recalculation_task::Column::GroupMasterKey
                .eq(master_key),
        )
        .filter(group_stats_recalculation_task::Column::CompletedAt.is_null())
        .filter(group_stats_recalculation_task::Column::SinceTs.lte(since_ts))
        .filter(group_stats_recalculation_task::Column::TillTs.gte(till_ts))
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

pub async fn process_pending_group_stats_recalculation_task(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    let Some(task) = claim_pending_group_stats_recalculation_task(dbx)
        .await
        .c(h!())?
    else {
        return Ok(false);
    };

    info!(
        "recalculating queued group stats task id={} group={} from={} till={} reason={}",
        task.id, task.group_master_key, task.since_ts, task.till_ts, task.reason
    );
    let result = recalculate_group_stats_task_by_day(dbx, &task).await;
    match result {
        Ok(()) => {
            let mut task = task.into_active_model();
            task.completed_at = Set(Some(Utc::now().naive_utc()));
            task.update(dbx).await.c(h!())?;
            Ok(true)
        }
        Err(e) => {
            let mut task = task.into_active_model();
            task.started_at = Set(None);
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

async fn recalculate_group_stats_task_by_day(
    dbx: &DatabaseConnection,
    task: &group_stats_recalculation_task::Model,
) -> Result<(), AppError> {
    let mut since_ts = task.since_ts;
    while since_ts < task.till_ts {
        let next_day =
            start_of_day(get_local_date(since_ts) + Duration::days(1))
                .c(h!())?;
        let till_ts = next_day.min(task.till_ts);
        if till_ts <= since_ts {
            break;
        }
        recalculate_group_stats(dbx, since_ts, till_ts, true, true)
            .await
            .c(h!())?;
        since_ts = till_ts;
    }
    Ok(())
}

pub fn can_read_stats_aggregated(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    if dt_till - dt_since < Duration::minutes(STATS_READ_FROM_TABLE_MINIMUM_MIN)
    {
        return false;
    }
    config
        .feature_group_stats_aggregated
        .unwrap_or(FEATURE_GROUP_STATS_AGGREGATED_DEFAULT)
}

pub fn should_read_stats_aggregated(
    req: &actix_web::web::Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<bool> {
    Ok(should_read_stats_aggregated_for_config(
        req,
        &env.config,
        dt_since,
        dt_till,
    ))
}

pub fn should_read_stats_aggregated_for_config(
    req: &AnalysisStatsReq,
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    can_read_stats_aggregated(config, dt_since, dt_till)
        && is_5min_stats_bucket_range_aligned(dt_since, dt_till)
        && req_allows_stats_aggregated(req)
}

fn req_allows_stats_aggregated(req: &AnalysisStatsReq) -> bool {
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
    dbx: &DatabaseConnection,
    batch_ids: Vec<i64>,
) -> anyhow::Result<Vec<(NaiveDateTime, HashMap<i64, i32>)>> {
    let now = round_to_5min(Utc::now().naive_utc()).c(h!())?;
    let stats = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::SignalGroupBatchId.eq_any(batch_ids))
        .filter(stats_group_5min::Column::Dt.lte(now))
        .filter(stats_group_5min::Column::Dt.gt(now - Duration::hours(1)))
        .all(dbx)
        .await
        .c(h!())?;
    let mut ts = now - Duration::hours(1);
    let mut result = vec![];
    while ts < now {
        ts += Duration::minutes(5);
        let group_stats = stats
            .clone()
            .into_iter()
            .filter(|x| x.dt.eq(&ts))
            .fold(HashMap::new(), |mut acc, m| {
                *acc.entry(m.signal_group_batch_id).or_insert(0) += m.quantity;
                acc
            });
        result.push((ts, group_stats));
    }
    Ok(result)
}

pub async fn read_group_stats_timeline_cached(
    dbx: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<SignalGroupStatsTimelineEntry>> {
    let master_keys = master_keys.into_iter().unique().collect_vec();
    if master_keys.is_empty() {
        return Ok(vec![]);
    }

    let allowed_keys = master_keys.iter().cloned().collect::<HashSet<_>>();
    let batches = collect_signal_group_batches(master_keys.clone(), dbx)
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
        let stats = stats_group_5min::Entity::find()
            .filter(
                stats_group_5min::Column::SignalGroupBatchId.eq_any(batch_ids),
            )
            .filter(stats_group_5min::Column::Dt.gte(dt_since))
            .filter(stats_group_5min::Column::Dt.lt(dt_till))
            .all(dbx)
            .await
            .c(h!())?;

        for stat in stats {
            let group_keys = batches_map
                .get(&stat.signal_group_batch_id)
                .cloned()
                .unwrap_or_default();
            for key in group_keys {
                if !allowed_keys.contains(&key) {
                    continue;
                }
                let points = grouped_points.entry(key).or_default();
                *points.entry(stat.dt).or_insert(0) += stat.quantity as i64;
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

pub async fn read_group_stats_aggregated(
    dbx: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsGroup>> {
    let allowed_keys = master_keys.iter().cloned().collect::<HashSet<_>>();
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_5min::Column::Dt
            .gte(since)
            .and(stats_group_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    let batches_map = batches
        .into_iter()
        .map(|b| (b.id, batch_key_to_group_keys(b.group_master_keys)))
        .collect::<HashMap<i64, Vec<_>>>();

    let mut stats: HashMap<String, i64> = stats_group_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .flat_map(|m| {
            collect_group_keys_for_batch_filtered(
                m.signal_group_batch_id,
                &batches_map,
                &allowed_keys,
                m,
            )
        })
        .fold(HashMap::new(), |mut acc, (s, key)| {
            *acc.entry(key).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        let day_stats = stats_group_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .flat_map(|m| {
                collect_group_keys_for_batch_filtered(
                    m.signal_group_batch_id,
                    &batches_map,
                    &allowed_keys,
                    m,
                )
            });
        add_group_stats(
            &mut stats,
            day_stats
                .into_iter()
                .map(|(s, key)| (s.quantity as i64, key)),
        );
    };
    let mut result = vec![];
    for (master_key, count) in stats {
        result.push(AnalysisStatsGroup { master_key, count });
    }
    Ok(result)
}

pub async fn read_total_stats_aggregated(
    dbx: &DatabaseConnection,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<i64> {
    if master_keys.is_empty() {
        return Ok(0);
    }

    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;
    let batches = collect_signal_group_batches(master_keys, dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect_vec();
    if batch_ids.is_empty() {
        return Ok(0);
    }

    let count_5min =
        read_stats_group_5min_total(dbx, &batch_ids, intervals_5min)
            .await
            .c(h!())?;
    let count_day = read_stats_group_day_total(dbx, &batch_ids, days)
        .await
        .c(h!())?;
    Ok(count_5min + count_day)
}

#[derive(FromQueryResult)]
struct StatsCountRes {
    count: i64,
}

async fn read_stats_group_5min_total(
    dbx: &DatabaseConnection,
    batch_ids: &[i64],
    intervals_5min: Vec<(NaiveDateTime, NaiveDateTime)>,
) -> anyhow::Result<i64> {
    if intervals_5min.is_empty() {
        return Ok(0);
    }

    let mut interval_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_5min::Column::Dt
            .gte(since)
            .and(stats_group_5min::Column::Dt.lt(till));
        interval_filter = interval_filter.add(filter);
    }

    let count = stats_group_5min::Entity::find()
        .select_only()
        .expr_as(Expr::cust("COALESCE(SUM(quantity), 0)"), "count")
        .filter(interval_filter)
        .filter(
            stats_group_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.to_vec()),
        )
        .into_model::<StatsCountRes>()
        .one(dbx)
        .await
        .c(h!())?
        .map(|row| row.count)
        .unwrap_or(0);

    Ok(count)
}

async fn read_stats_group_day_total(
    dbx: &DatabaseConnection,
    batch_ids: &[i64],
    days: Vec<NaiveDate>,
) -> anyhow::Result<i64> {
    if days.is_empty() {
        return Ok(0);
    }

    let mut day_filter = Condition::any();
    for day in days {
        day_filter = day_filter.add(stats_group_day::Column::Dt.eq(day));
    }

    let count = stats_group_day::Entity::find()
        .select_only()
        .expr_as(Expr::cust("COALESCE(SUM(quantity), 0)"), "count")
        .filter(day_filter)
        .filter(
            stats_group_day::Column::SignalGroupBatchId
                .eq_any(batch_ids.to_vec()),
        )
        .into_model::<StatsCountRes>()
        .one(dbx)
        .await
        .c(h!())?
        .map(|row| row.count)
        .unwrap_or(0);

    Ok(count)
}

pub async fn read_aor_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsAor>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_aor_id_5min::Column::Dt
            .gte(since)
            .and(stats_group_aor_id_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<i64, i64> = stats_group_aor_id_5min::Entity::find()
        .join(
            JoinType::InnerJoin,
            stats_group_aor_id_5min::Relation::AreaOfResponsibility.def(),
        )
        .filter(interval_5mins_filter)
        .filter(
            stats_group_aor_id_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.aor_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_aor_id_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_aor_id_day::Entity::find()
            .join(
                JoinType::InnerJoin,
                stats_group_aor_id_day::Relation::AreaOfResponsibility.def(),
            )
            .filter(interval_day_filter)
            .filter(
                stats_group_aor_id_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .filter(area_of_responsibility::Column::Deleted.eq(false))
            .filter(area_of_responsibility::Column::IsTopLevel.eq(true))
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.aor_id).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (aor_id, count) in stats {
        result.push(AnalysisStatsAor { aor_id, count });
    }
    Ok(result)
}

pub async fn read_sender_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsSender>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_sender_5min::Column::Dt
            .gte(since)
            .and(stats_group_sender_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<String, i64> =
        stats_group_sender_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_sender_5min::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.sender).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_sender_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_sender_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_sender_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.sender).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (uuid, count) in stats {
        result.push(AnalysisStatsSender {
            uuid,
            count,
            freq_breakdown: vec![],
            per_day: BTreeMap::new(),
        });
    }
    Ok(result)
}

pub async fn read_post_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsPost>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_post_id_5min::Column::Dt
            .gte(since)
            .and(stats_group_post_id_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<i64, i64> = stats_group_post_id_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_post_id_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.post_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_post_id_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_post_id_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_post_id_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.post_id).or_insert(0) += s.quantity as i64;
            });
    };
    let posts = sigint_post::Entity::find()
        .filter(sigint_post::Column::Id.eq_any(stats.keys().copied().collect()))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|m| (m.id, m.name))
        .collect::<HashMap<_, _>>();

    let mut result = vec![];
    for (post_id, count) in stats {
        let post = posts.get(&post_id).cloned().unwrap_or("".to_string());
        result.push(AnalysisStatsPost { post, count });
    }
    Ok(result)
}

pub async fn read_frequency_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsFreq>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_freq_5min::Column::Dt
            .gte(since)
            .and(stats_group_freq_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<String, i64> = stats_group_freq_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_freq_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.frequency).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_freq_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_freq_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_freq_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.frequency).or_insert(0) += s.quantity as i64;
            });
    };

    let new_freqs = crate::rer_importer::analysis::stats::get_new_freqs(
        &env.dbx, dt_since, dt_till,
    )
    .await
    .context(h!())?;
    let mut result = vec![];
    for (freq, count) in stats {
        let is_new = new_freqs.contains(&freq);
        result.push(AnalysisStatsFreq {
            is_new,
            freq,
            count,
        });
    }
    Ok(result)
}

pub async fn read_frequency_stats_day(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<FreqGroupsMessageCountByDay>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_freq_5min::Column::Dt
            .gte(since)
            .and(stats_group_freq_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let stats = stats_group_freq_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_freq_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;

    #[derive(Hash, Eq, PartialEq)]
    pub struct Key {
        pub freq: String,
        pub signal_group_batch_id: i64,
        pub day: i64,
    }

    let mut result = HashMap::new();
    for s in stats {
        let key = Key {
            freq: s.frequency,
            signal_group_batch_id: s.signal_group_batch_id,
            day: start_of_day(get_local_date(s.dt))
                .c(h!())?
                .and_utc()
                .timestamp_millis(),
        };
        *result.entry(key).or_insert(0) += s.quantity;
    }

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_freq_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        let day_stats = stats_group_freq_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_freq_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?;
        for s in day_stats {
            let key = Key {
                freq: s.frequency,
                signal_group_batch_id: s.signal_group_batch_id,
                day: start_of_day(s.dt).c(h!())?.and_utc().timestamp_millis(),
            };
            *result.entry(key).or_insert(0) += s.quantity;
        }
    };

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

pub async fn read_callsign_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsCallsign>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_callsign_5min::Column::Dt
            .gte(since)
            .and(stats_group_callsign_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<String, i64> =
        stats_group_callsign_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_callsign_5min::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.callsign).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_callsign_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_callsign_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_callsign_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.callsign).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (callsign, count) in stats {
        result.push(AnalysisStatsCallsign { callsign, count });
    }
    Ok(result)
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

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_tag_5min::Column::Dt
            .gte(since)
            .and(stats_group_tag_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

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

    let mut stats: HashMap<i64, i64> = stats_group_tag_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_tag_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.tag_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_tag_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_tag_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_tag_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.tag_id).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (tag_id, count) in stats {
        if accessible_tag_ids.contains(&tag_id) {
            result.push(AnalysisStatsTag { tag_id, count });
        }
    }
    Ok(result)
}

pub async fn read_unit_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsUnit>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_unit_5min::Column::Dt
            .gte(since)
            .and(stats_group_unit_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<String, i64> = stats_group_unit_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_unit_5min::Column::SignalGroupBatchId
                .eq_any(batch_ids.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.unit).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_unit_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_unit_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_unit_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.unit).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (unit, count) in stats {
        result.push(AnalysisStatsUnit { unit, count });
    }
    Ok(result)
}

pub async fn read_location_stats_aggregated(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsLocation>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_location_5min::Column::Dt
            .gte(since)
            .and(stats_group_location_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let batches = collect_signal_group_batches(master_keys.clone(), &env.dbx)
        .await
        .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();

    let mut stats: HashMap<String, i64> =
        stats_group_location_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_location_5min::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.location).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_location_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_location_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_location_day::Column::SignalGroupBatchId
                    .eq_any(batch_ids.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.location).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (location, count) in stats {
        result.push(AnalysisStatsLocation { location, count });
    }
    Ok(result)
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
        .map(|b| (b.group_master_keys, b.id))
        .collect::<HashMap<String, i64>>();

    if recalculate_5min_stats {
        let generic_stats =
            load_generic_stats(dbx, since_ts, till_ts).await.c(h!())?;
        let network_stats = load_network_stats(dbx, since_ts, till_ts, None)
            .await
            .c(h!())?;
        let network_ids = network_stats
            .iter()
            .map(|row| row.network_id)
            .collect::<HashSet<_>>();
        let network_aors =
            load_network_aor_map(dbx, &network_ids).await.c(h!())?;

        let group_stats = generic_stats
            .clone()
            .into_iter()
            .map(|x| {
                (x.id, x.group_master_key, x.datetime.unwrap_or(x.created_at))
            })
            .collect_vec();
        let freq_stats = generic_stats
            .clone()
            .into_iter()
            .map(|x| {
                (
                    x.group_master_key,
                    (x.id, x.freq.unwrap_or("".to_string())),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
            .collect_vec();
        let sender_stats = generic_stats
            .clone()
            .into_iter()
            .map(|x| {
                (
                    x.group_master_key,
                    (x.id, x.sender.unwrap_or("".to_string())),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
            .collect_vec();
        let unit_stats = generic_stats
            .clone()
            .into_iter()
            .map(|x| {
                (
                    x.group_master_key,
                    (x.id, x.unit_v2.unwrap_or("".to_string())),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
            .collect_vec();
        let group_aor_stats = generic_stats
            .clone()
            .into_iter()
            .filter_map(|x| {
                x.aor_id.map(|aor_id| {
                    (
                        x.group_master_key,
                        (x.id, aor_id),
                        x.datetime.unwrap_or(x.created_at),
                    )
                })
            })
            .collect_vec();
        let network_aor_stats = network_stats
            .into_iter()
            .flat_map(|row| {
                let ts =
                    row.datetime.or(row.timestamp).unwrap_or(row.created_at);
                network_aors
                    .get(&row.network_id)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |aor_id| {
                        (row.group_master_key.clone(), (row.id, aor_id), ts)
                    })
            })
            .collect_vec();
        let aor_stats = group_aor_stats
            .into_iter()
            .chain(network_aor_stats)
            .collect_vec();
        let post_stats = generic_stats
            .clone()
            .into_iter()
            .filter_map(|x| {
                x.post_id.map(|post_id| {
                    (
                        x.group_master_key,
                        (x.id, post_id),
                        x.datetime.unwrap_or(x.created_at),
                    )
                })
            })
            .collect_vec();
        let callsign_stats = generic_stats
            .clone()
            .into_iter()
            .flat_map(|x| {
                let callsign: Vec<String> = x
                    .callsigns
                    .and_then(move |c| serde_json::from_value(c).ok())
                    .unwrap_or_default();
                callsign.into_iter().map(move |c| {
                    (
                        x.group_master_key.clone(),
                        (x.id, c),
                        x.datetime.unwrap_or(x.created_at),
                    )
                })
            })
            .collect_vec();
        let tag_stats = generic_stats
            .clone()
            .into_iter()
            .flat_map(|x| {
                let tags: Vec<i64> = x.tags.unwrap_or_default();
                tags.into_iter().map(move |t| {
                    (
                        x.group_master_key.clone(),
                        (x.id, t),
                        x.datetime.unwrap_or(x.created_at),
                    )
                })
            })
            .collect_vec();
        let location_stats = generic_stats
            .clone()
            .into_iter()
            .flat_map(|x| {
                let locations = x
                    .location_v2
                    .map(|x| {
                        x.split("|")
                            .map(|x| x.trim().to_string())
                            .collect::<HashSet<_>>()
                    })
                    .unwrap_or_default();
                locations.into_iter().map(move |l| {
                    (
                        x.group_master_key.clone(),
                        (x.id, l),
                        x.datetime.unwrap_or(x.created_at),
                    )
                })
            })
            .collect_vec();

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_group(
            &txn,
            group_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_freq(
            &txn,
            freq_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_aor_id(
            &txn,
            aor_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_post_id(
            &txn,
            post_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_sender(
            &txn,
            sender_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_callsign(
            &txn,
            callsign_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_unit(
            &txn,
            unit_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_location(
            &txn,
            location_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        update_5min_stats_tag(
            &txn,
            tag_stats,
            since_ts,
            till_ts,
            &mut batches_map,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
    }

    if recalculate_day_stats {
        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_freq(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_group(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_aor_id(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_post_id(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_sender(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_callsign(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_unit(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_location(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;

        let txn = dbx.begin().await.c(h!())?;
        recalculate_day_stats_tag(&txn, since_ts, till_ts)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;
    }

    if recalculate_day_stats {
        recalculate_network_stats(dbx, since_ts, till_ts, None)
            .await
            .c(h!())?;
    }
    Ok(())
}

pub async fn recalculate_network_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    network_ids: Option<&HashSet<i64>>,
) -> Result<(), AppError> {
    if till_ts <= since_ts {
        warn!(
            "skip recalculate_network_stats: non-positive window [{since_ts}..{till_ts})"
        );
        return Ok(());
    }

    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_day_ts = start_of_day(since_date).c(h!())?;
    let till_day_ts = start_of_day(till_date + Duration::days(1)).c(h!())?;

    let stats = load_network_stats(dbx, since_day_ts, till_day_ts, network_ids)
        .await
        .c(h!())?;

    let batches = signal_group_batch::Entity::find().all(dbx).await.c(h!())?;
    let mut batches_map = batches
        .into_iter()
        .map(|b| (b.group_master_keys, b.id))
        .collect::<HashMap<String, i64>>();

    let mut msg_groups: HashMap<i64, HashSet<String>> = HashMap::new();
    for row in &stats {
        msg_groups
            .entry(row.id)
            .or_default()
            .insert(row.group_master_key.clone());
    }

    let txn = dbx.begin().await.c(h!())?;
    let mut message_batch_map: HashMap<i64, i64> = HashMap::new();
    for (msg_id, keys) in msg_groups {
        let batch_key = all_to_batch_key(keys);
        ensure_batch_key(&txn, &mut batches_map, &batch_key)
            .await
            .c(h!())?;
        let batch_id = *batches_map.get(&batch_key).c(h!())?;
        message_batch_map.insert(msg_id, batch_id);
    }
    txn.commit().await.c(h!())?;

    let mut network_day: HashMap<(NaiveDate, i64, i64), i32> = HashMap::new();
    let mut network_freq_day: HashMap<(NaiveDate, i64, i64, String), i32> =
        HashMap::new();
    let mut network_callsign_day: HashMap<(NaiveDate, i64, i64, String), i32> =
        HashMap::new();
    let network_freq_ranges =
        load_network_freq_ranges(dbx, network_ids).await.c(h!())?;
    let mut network_freq_last_seen: HashMap<i64, NaiveDateTime> =
        HashMap::new();
    let mut processed_message_networks: HashSet<(i64, i64)> = HashSet::new();

    for row in stats {
        if !processed_message_networks.insert((row.id, row.network_id)) {
            continue;
        }
        let ts = row.datetime.or(row.timestamp).unwrap_or(row.created_at);
        let day = get_local_date(ts);
        let batch_id = *message_batch_map.get(&row.id).c(h!())?;

        *network_day
            .entry((day, batch_id, row.network_id))
            .or_insert(0) += 1;

        if let Some(freq) = row.freq.clone() {
            let freq = freq.trim().to_string();
            if !freq.is_empty() {
                *network_freq_day
                    .entry((day, batch_id, row.network_id, freq.clone()))
                    .or_insert(0) += 1;

                if let Some(freq_ranges) =
                    network_freq_ranges.get(&(row.network_id, freq.clone()))
                {
                    for freq_range in freq_ranges {
                        if is_network_freq_active_at(freq_range, ts) {
                            network_freq_last_seen
                                .entry(freq_range.id)
                                .and_modify(|current| {
                                    if ts > *current {
                                        *current = ts;
                                    }
                                })
                                .or_insert(ts);
                        }
                    }
                }
            }
        }

        let callsigns: Vec<String> = row
            .callsigns
            .and_then(|c| serde_json::from_value(c).ok())
            .unwrap_or_default();
        for callsign in callsigns {
            let callsign = callsign.trim().to_string();
            if callsign.is_empty() {
                continue;
            }
            *network_callsign_day
                .entry((day, batch_id, row.network_id, callsign))
                .or_insert(0) += 1;
        }
    }

    let txn = dbx.begin().await.c(h!())?;
    let mut network_day_delete = stats_group_network_day::Entity::delete_many()
        .filter(stats_group_network_day::Column::Dt.gte(since_date))
        .filter(stats_group_network_day::Column::Dt.lte(till_date));
    if let Some(network_ids) = network_ids {
        network_day_delete = network_day_delete.filter(
            stats_group_network_day::Column::NetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    network_day_delete.exec(&txn).await.c(h!())?;

    let mut network_freq_day_delete =
        stats_group_network_freq_day::Entity::delete_many()
            .filter(stats_group_network_freq_day::Column::Dt.gte(since_date))
            .filter(stats_group_network_freq_day::Column::Dt.lte(till_date));
    if let Some(network_ids) = network_ids {
        network_freq_day_delete = network_freq_day_delete.filter(
            stats_group_network_freq_day::Column::NetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    network_freq_day_delete.exec(&txn).await.c(h!())?;

    let mut network_callsign_day_delete =
        stats_group_network_callsign_day::Entity::delete_many()
            .filter(
                stats_group_network_callsign_day::Column::Dt.gte(since_date),
            )
            .filter(
                stats_group_network_callsign_day::Column::Dt.lte(till_date),
            );
    if let Some(network_ids) = network_ids {
        network_callsign_day_delete = network_callsign_day_delete.filter(
            stats_group_network_callsign_day::Column::NetworkId
                .eq_any(network_ids.iter().copied().collect_vec()),
        );
    }
    network_callsign_day_delete.exec(&txn).await.c(h!())?;

    for ((day, batch_id, network_id), quantity) in network_day {
        stats_group_network_day::ActiveModel {
            id: NotSet,
            dt: Set(day),
            network_id: Set(network_id),
            quantity: Set(quantity),
            created_at: NotSet,
            signal_group_batch_id: Set(batch_id),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for ((day, batch_id, network_id, freq), quantity) in network_freq_day {
        stats_group_network_freq_day::ActiveModel {
            id: NotSet,
            dt: Set(day),
            network_id: Set(network_id),
            frequency: Set(freq),
            quantity: Set(quantity),
            created_at: NotSet,
            signal_group_batch_id: Set(batch_id),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for ((day, batch_id, network_id, callsign), quantity) in
        network_callsign_day
    {
        stats_group_network_callsign_day::ActiveModel {
            id: NotSet,
            dt: Set(day),
            network_id: Set(network_id),
            callsign: Set(callsign),
            quantity: Set(quantity),
            created_at: NotSet,
            signal_group_batch_id: Set(batch_id),
        }
        .insert(&txn)
        .await
        .c(h!())?;
    }

    for (network_freq_id, last_seen_dt) in network_freq_last_seen {
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

pub async fn recalculate_last_seen_for_active_network_freqs_on_startup(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let network_ids = sigint_network::Entity::find()
        .select_only()
        .column(sigint_network::Column::Id)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    if network_ids.is_empty() {
        return Ok(());
    }

    let network_ids = network_ids.into_iter().collect::<HashSet<_>>();
    recalculate_last_seen_for_networks_exact(dbx, &network_ids, true).await
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
    Ok(stats_by_datetime
        .into_iter()
        .chain(stats_by_created_at)
        .collect_vec())
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
        .column(sigint_inbox_item::Column::Callsigns)
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
    Ok(stats_by_datetime
        .into_iter()
        .chain(stats_by_created_at)
        .collect_vec())
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
        .column(sigint_inbox_item::Column::Callsigns)
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

async fn update_5min_stats_group(
    dbx: &DatabaseTransaction,
    stats: Vec<(i64, String, NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_5min::Entity::delete_many()
        .filter(stats_group_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<i64, HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key.clone()))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let keys = acc.entry(*id).or_default();
                keys.insert(key);
                acc
            });
        let mut batch_stats: HashMap<i64, i32> = HashMap::new();
        for (_, keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let count = *batch_stats.entry(batch_id).or_default();
            batch_stats.insert(batch_id, count + 1);
        }
        for (signal_group_batch_id, count) in batch_stats {
            stats_group_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_group(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.signal_group_batch_id, rec.quantity));
    }

    stats_group_day::Entity::delete_many()
        .filter(stats_group_day::Column::Dt.gte(since_date))
        .filter(stats_group_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<i64, i32> = stats
            .iter()
            .filter_map(|(date, key, count)| {
                if current_date.eq(date) {
                    Some((*key, count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for (signal_group_batch_id, count) in group_stats {
            stats_group_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_freq(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_freq_5min::Entity::delete_many()
        .filter(stats_group_freq_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_freq_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, String), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key.clone()))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });

        let mut batch_stats: HashMap<(i64, String), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key.clone()).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, frequency), count) in batch_stats {
            stats_group_freq_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                frequency: Set(frequency),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_freq(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_freq_5min::Entity::find()
        .filter(stats_group_freq_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_freq_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((
            date,
            rec.signal_group_batch_id,
            rec.frequency,
            rec.quantity,
        ));
    }

    stats_group_freq_day::Entity::delete_many()
        .filter(stats_group_freq_day::Column::Dt.gte(since_date))
        .filter(stats_group_freq_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, frequency), count) in group_stats {
            stats_group_freq_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                frequency: Set(frequency),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_aor_id(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_aor_id_5min::Entity::delete_many()
        .filter(stats_group_aor_id_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_aor_id_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, i64), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, *key))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });
        let mut batch_stats: HashMap<(i64, i64), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, aor_id), count) in batch_stats {
            stats_group_aor_id_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                aor_id: Set(aor_id),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_aor_id(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_aor_id_5min::Entity::find()
        .filter(stats_group_aor_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_aor_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.signal_group_batch_id, rec.aor_id, rec.quantity));
    }

    stats_group_aor_id_day::Entity::delete_many()
        .filter(stats_group_aor_id_day::Column::Dt.gte(since_date))
        .filter(stats_group_aor_id_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, aor_id), count) in group_stats {
            stats_group_aor_id_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                aor_id: Set(aor_id),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_post_id(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_post_id_5min::Entity::delete_many()
        .filter(stats_group_post_id_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_post_id_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, i64), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, *key))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });
        let mut batch_stats: HashMap<(i64, i64), i32> = HashMap::new();
        for ((_, post_id), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, post_id);
            let count = *batch_stats.entry(key).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, post_id), count) in batch_stats {
            stats_group_post_id_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                post_id: Set(post_id),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_post_id(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_post_id_5min::Entity::find()
        .filter(stats_group_post_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_post_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((
            date,
            rec.signal_group_batch_id,
            rec.post_id,
            rec.quantity,
        ));
    }

    stats_group_post_id_day::Entity::delete_many()
        .filter(stats_group_post_id_day::Column::Dt.gte(since_date))
        .filter(stats_group_post_id_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, post_id), count) in group_stats {
            stats_group_post_id_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                post_id: Set(post_id),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_location(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_location_5min::Entity::delete_many()
        .filter(stats_group_location_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_location_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, String), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key.clone()).or_default();
                ids.insert(id.clone());
                acc
            });

        let mut batch_stats: HashMap<(i64, String), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key.clone()).or_default();
            batch_stats.insert(key.clone(), count + 1);
        }
        for ((signal_group_batch_id, location), count) in batch_stats {
            stats_group_location_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                location: Set(location),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_location(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_location_5min::Entity::find()
        .filter(
            stats_group_location_5min::Column::Dt.gte(since_start_of_day_ts),
        )
        .filter(stats_group_location_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((
            date,
            rec.signal_group_batch_id,
            rec.location,
            rec.quantity,
        ));
    }

    stats_group_location_day::Entity::delete_many()
        .filter(stats_group_location_day::Column::Dt.gte(since_date))
        .filter(stats_group_location_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, location), count) in group_stats {
            stats_group_location_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                location: Set(location),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_sender(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_sender_5min::Entity::delete_many()
        .filter(stats_group_sender_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_sender_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, String), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key.clone()))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });

        let mut batch_stats: HashMap<(i64, String), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key.clone()).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, sender), count) in batch_stats {
            stats_group_sender_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                sender: Set(sender),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_sender(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_sender_5min::Entity::find()
        .filter(stats_group_sender_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_sender_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.signal_group_batch_id, rec.sender, rec.quantity));
    }

    stats_group_sender_day::Entity::delete_many()
        .filter(stats_group_sender_day::Column::Dt.gte(since_date))
        .filter(stats_group_sender_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, sender), count) in group_stats {
            stats_group_sender_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                sender: Set(sender),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_tag(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_tag_5min::Entity::delete_many()
        .filter(stats_group_tag_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_tag_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, i64), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(*key).or_default();
                ids.insert(id.clone());
                acc
            });

        let mut batch_stats: HashMap<(i64, i64), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, tag_id), count) in batch_stats {
            stats_group_tag_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                tag_id: Set(tag_id),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_tag(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_tag_5min::Entity::find()
        .filter(stats_group_tag_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_tag_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.signal_group_batch_id, rec.tag_id, rec.quantity));
    }

    stats_group_tag_day::Entity::delete_many()
        .filter(stats_group_tag_day::Column::Dt.gte(since_date))
        .filter(stats_group_tag_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, tag), count) in group_stats {
            stats_group_tag_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                tag_id: Set(tag),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_callsign(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_callsign_5min::Entity::delete_many()
        .filter(stats_group_callsign_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_callsign_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, String), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key.clone()))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });
        let mut batch_stats: HashMap<(i64, String), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key.clone()).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, callsign), count) in batch_stats {
            stats_group_callsign_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                callsign: Set(callsign),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_callsign(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_callsign_5min::Entity::find()
        .filter(
            stats_group_callsign_5min::Column::Dt.gte(since_start_of_day_ts),
        )
        .filter(stats_group_callsign_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((
            date,
            rec.signal_group_batch_id,
            rec.callsign,
            rec.quantity,
        ));
    }
    stats_group_callsign_day::Entity::delete_many()
        .filter(stats_group_callsign_day::Column::Dt.gte(since_date))
        .filter(stats_group_callsign_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, callsign), count) in group_stats {
            stats_group_callsign_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                callsign: Set(callsign),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }
    Ok(())
}

async fn update_5min_stats_unit(
    dbx: &DatabaseTransaction,
    stats: Vec<(String, (i64, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    batches_map: &mut HashMap<String, i64>,
) -> Result<(), AppError> {
    stats_group_unit_5min::Entity::delete_many()
        .filter(stats_group_unit_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_unit_5min::Column::Dt.lt(till_ts))
        .exec(dbx)
        .await
        .context(h!())?;

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(i64, String), HashSet<String>> = stats
            .iter()
            .filter_map(|(id, key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some((id, key.clone()))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (id, key)| {
                let ids = acc.entry(key).or_default();
                ids.insert(id.clone());
                acc
            });

        let mut batch_stats: HashMap<(i64, String), i32> = HashMap::new();
        for ((_, freq), keys) in group_stats {
            let batch_key = all_to_batch_key(keys);
            ensure_batch_key(dbx, batches_map, &batch_key)
                .await
                .c(h!())?;
            let batch_id = *batches_map.get(&batch_key).c(h!())?;
            let key = (batch_id, freq);
            let count = *batch_stats.entry(key.clone()).or_default();
            batch_stats.insert(key, count + 1);
        }
        for ((signal_group_batch_id, unit), count) in batch_stats {
            stats_group_unit_5min::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                unit: Set(unit),
                dt: Set(since_ts),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_ts = till_ts;
    }
    Ok(())
}

async fn recalculate_day_stats_unit(
    dbx: &DatabaseTransaction,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = till_date_inclusive_for_exclusive_till(till_ts).c(h!())?;
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_unit_5min::Entity::find()
        .filter(stats_group_unit_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_unit_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.signal_group_batch_id, rec.unit, rec.quantity));
    }

    stats_group_unit_day::Entity::delete_many()
        .filter(stats_group_unit_day::Column::Dt.gte(since_date))
        .filter(stats_group_unit_day::Column::Dt.lte(till_date))
        .exec(dbx)
        .await
        .context(h!())?;
    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(i64, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((*key_1, key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((signal_group_batch_id, unit), count) in group_stats {
            stats_group_unit_day::ActiveModel {
                id: NotSet,
                quantity: Set(count),
                signal_group_batch_id: Set(signal_group_batch_id),
                unit: Set(unit),
                dt: Set(current_date),
                created_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
        current_date += Duration::days(1);
    }

    Ok(())
}

fn collect_time_intervals_for_stats(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<(Vec<(NaiveDateTime, NaiveDateTime)>, Vec<NaiveDate>)> {
    let mut intervals_5min = vec![];
    let mut days = vec![];
    if dt_till - dt_since < Duration::days(STATS_5MIN_MAX_NUM_DAYS) {
        intervals_5min.push((dt_since, dt_till));
    } else {
        let date_after_since_dt = get_local_date(dt_since) + Duration::days(1);
        let dt_since_eod = start_of_day(date_after_since_dt).c(h!())?;
        intervals_5min.push((dt_since, dt_since_eod));

        let date_till_dt = get_local_date(dt_till);
        let dt_till_sod = start_of_day(date_till_dt).c(h!())?;
        intervals_5min.push((dt_till_sod, dt_till));

        let mut date = date_after_since_dt;
        while date < date_till_dt {
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

fn collect_group_keys_for_batch_filtered<T: Clone>(
    batch_id: i64,
    batches: &HashMap<i64, Vec<String>>,
    allowed_keys: &HashSet<String>,
    m: T,
) -> Vec<(T, String)> {
    let keys = batches.get(&batch_id).cloned().unwrap_or_default();
    let mut result = vec![];
    for key in keys {
        if allowed_keys.contains(&key) {
            result.push((m.clone(), key));
        }
    }
    result
}

fn add_group_stats(
    stats: &mut HashMap<String, i64>,
    rows: impl IntoIterator<Item = (i64, String)>,
) {
    for (quantity, key) in rows {
        *stats.entry(key).or_insert(0) += quantity;
    }
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
    fn test_should_read_stats_aggregated_false_for_unaligned_range() {
        let req = analysis_stats_req0();
        let config = stats_aggregated_config();

        assert!(should_read_stats_aggregated_for_config(
            &req,
            &config,
            ndt(2025, 10, 10, 10, 0),
            ndt(2025, 10, 10, 10, 15),
        ));
        assert!(!should_read_stats_aggregated_for_config(
            &req,
            &config,
            ndt(2025, 10, 10, 10, 1),
            ndt(2025, 10, 10, 10, 16),
        ));
    }

    #[test]
    fn test_collect_time_intervals_for_stats_short_duration_if_branch() {
        // 2 days and 1 second
        let dt_since = ndt(2025, 10, 10, 10, 0);
        let dt_till = ndt(2025, 10, 12, 9, 59);

        assert!(dt_till - dt_since < Duration::days(STATS_5MIN_MAX_NUM_DAYS));

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
        assert!(dt_till - dt_since >= Duration::days(STATS_5MIN_MAX_NUM_DAYS));
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
    }

    #[test]
    fn test_collect_group_keys_for_batch_filtered() {
        let mut batches = HashMap::new();
        batches.insert(1, vec!["a".to_string(), "b".to_string()]);
        let allowed = HashSet::from(["a".to_string()]);
        let res =
            collect_group_keys_for_batch_filtered(1, &batches, &allowed, 10);
        assert_eq!(res, vec![(10, "a".to_string())]);
    }

    #[serial]
    #[tokio::test]
    async fn test_enqueue_group_stats_recalculation_for_group_history_uses_message_day(
    ) {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();

        let group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set("stats-recalc-group".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_ts = Utc::now().naive_utc() - Duration::days(3);
        let msg = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                created_at: Set(message_ts),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(msg.id),
                group_master_key: Set(Some(group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message_ts_kyiv =
            message_ts.and_utc().with_timezone(&chrono_tz::Europe::Kyiv);
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(msg.id),
                date: Set(Some(message_ts_kyiv.format("%Y-%m-%d").to_string())),
                time: Set(Some(message_ts_kyiv.format("%H:%M:%S").to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

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
        assert!(task.till_ts > message_ts);

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn test_read_group_stats_aggregated_filters_orphan_keys() {
        let env = cleanup().await.unwrap();

        let allowed_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set("allowed-group".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orphan_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                master_key: Set("orphan-group".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let batch_key = all_to_batch_key(HashSet::from([
            allowed_group.master_key.clone(),
            orphan_group.master_key.clone(),
        ]));
        let batch = signal_group_batch::ActiveModel {
            group_master_keys: Set(batch_key),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let now = Utc::now().naive_utc();
        stats_group_5min::ActiveModel {
            dt: Set(now),
            quantity: Set(3),
            signal_group_batch_id: Set(batch.id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let dt_since = now - Duration::minutes(10);
        let dt_till = now + Duration::minutes(10);
        let stats = read_group_stats_aggregated(
            &env.dbx,
            vec![allowed_group.master_key.clone()],
            dt_since,
            dt_till,
        )
        .await
        .unwrap();

        let keys = stats
            .into_iter()
            .map(|entry| entry.master_key)
            .collect::<HashSet<_>>();
        assert_eq!(keys, HashSet::from([allowed_group.master_key]));
    }

    #[test]
    fn test_add_group_stats_merges_daily_rows() {
        let mut stats = HashMap::from([("existing".to_string(), 2)]);

        add_group_stats(
            &mut stats,
            vec![(4, "existing".to_string()), (3, "daily-only".to_string())],
        );

        assert_eq!(
            stats,
            HashMap::from([
                ("existing".to_string(), 6),
                ("daily-only".to_string(), 3),
            ])
        );
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
