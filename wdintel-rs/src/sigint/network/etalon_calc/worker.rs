use crate::config::*;
use crate::entities::network_invalidation_task;
use crate::entities::sea_orm_active_enums::NetworkInvalidationWorkerStatus;
use crate::entities::*;
use crate::types::{debug, error, info, warn};
use crate::types::{Mode, ShortContext};
use crate::utils::worker_watch;
use crate::{h, new_pg_pool_from_mode};
use chrono::{NaiveDateTime, Timelike, Utc};
use echo_migration::Expr;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::thread;
use std::time::{Duration, Instant};
// Worker that keeps recent inbox items aligned with network definitions by
// picking pending invalidation tasks, normalizing them (split/merge), and
// executing them in a stable order.

// No-fail worker loop: keep reconnecting, then run tasks every hour.
pub async fn run_recent_inbox_network_worker_nofail(mode: Mode) {
    loop {
        let _loop_guard =
            worker_watch::loop_guard("run_recent_inbox_network_worker_nofail");
        if let Err(e) = run_recent_inbox_network_worker_inner(mode).await {
            error!("run_recent_inbox_network_worker_nofail failed: {:#?}", e);
        }
        tokio::time::sleep(Duration::from_secs(
            NETWORK_INBOX_WORKER_DEFAULT_SLEEP,
        ))
        .await;
    }
}

async fn run_recent_inbox_network_worker_inner(
    mode: Mode,
) -> anyhow::Result<()> {
    let config = read_config(mode).c(h!())?;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!("run_recent_inbox_network_worker_nofail disabled, sleeping...");
        return Ok(());
    }
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    info!("run_inbox_network_worker_once started");
    if let Err(e) = run_inbox_network_worker_once(&db, false, &config).await {
        error!("run_inbox_network_worker_once failed: {:#?}", e);
    } else {
        info!("run_inbox_network_worker_once completed");
    }
    update_worker_status(
        &db,
        NetworkInvalidationWorkerStatus::Sleep,
        NETWORK_INVALIDATION_TASK_TAG_RECENT,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn update_worker_status(
    db: &DatabaseConnection,
    new_status: NetworkInvalidationWorkerStatus,
    tag: &str,
) -> anyhow::Result<network_invalidation_worker::Model> {
    let worker = ensure_worker(db, tag).await.c(h!())?;
    let mut rec = worker.into_active_model();
    rec.status = Set(new_status);
    rec.updated_at = Set(Utc::now().naive_utc());
    let worker = rec.update(db).await.c(h!())?;
    Ok(worker)
}

async fn ensure_worker(
    dbx: &DatabaseConnection,
    tag: &str,
) -> anyhow::Result<network_invalidation_worker::Model> {
    let worker = network_invalidation_worker::Entity::find()
        .filter(network_invalidation_worker::Column::Tag.eq(tag.to_string()))
        .one(dbx)
        .await
        .c(h!())?;
    if let Some(worker) = worker {
        Ok(worker)
    } else {
        network_invalidation_worker::ActiveModel {
            id: NotSet,
            tag: Set(tag.to_string()),
            status: Set(NetworkInvalidationWorkerStatus::Sleep),
            updated_at: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())
    }
}

// Old worker: only handles tasks marked as is_for_old_worker and workers at worker hours (in config.rs).
pub async fn run_old_inbox_network_worker_nofail(mode: Mode) {
    loop {
        let _loop_guard =
            worker_watch::loop_guard("run_old_inbox_network_worker_nofail");
        if let Err(e) = run_old_inbox_network_worker_inner(mode).await {
            error!("run_old_inbox_network_worker_nofail failed: {:#?}", e);
        }
        tokio::time::sleep(Duration::from_secs(
            NETWORK_INBOX_WORKER_DEFAULT_SLEEP,
        ))
        .await;
    }
}

async fn run_old_inbox_network_worker_inner(mode: Mode) -> anyhow::Result<()> {
    let config = read_config(mode).c(h!())?;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!(
            "run_inbox_network_daily_consistency_worker_nofail disabled, sleeping..."
        );

        return Ok(());
    }

    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    wait_until_worker_shift_start(&config).await;
    try_cleanup(&db).await.c(h!())?;
    info!("run_old_inbox_network_worker_once started");
    if let Err(e) = run_inbox_network_worker_once(&db, true, &config).await {
        error!("run_old_inbox_network_worker_once failed: {:#?}", e);
    } else {
        info!("run_old_inbox_network_worker_once completed");
    }
    update_worker_status(
        &db,
        NetworkInvalidationWorkerStatus::Sleep,
        NETWORK_INVALIDATION_TASK_TAG_OLD,
    )
    .await
    .c(h!())?;
    Ok(())
}

// if we have too much tasks for some reason - drop them all, wait 5 min for the triage and then proceed
async fn try_cleanup(db: &DatabaseConnection) -> anyhow::Result<()> {
    if network_invalidation_task::Entity::find()
        .count(db)
        .await
        .c(h!())?
        > NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC
    {
        network_invalidation_task::Entity::delete_many()
            .exec(db)
            .await
            .c(h!())?;
        crate::sigint::network::etalon_calc::oneoff::backfill_inbox_networks(
            db, None, None,
        )
        .await
        .c(h!())?;
        thread::sleep(Duration::from_secs(120));
    }
    Ok(())
}

// Daily checker: compare calculated networks to stored ones for today's messages.
pub async fn run_inbox_network_daily_consistency_worker_nofail(mode: Mode) {
    loop {
        let _loop_guard = worker_watch::loop_guard(
            "run_inbox_network_daily_consistency_worker_nofail",
        );
        if let Err(e) =
            run_inbox_network_daily_consistency_worker_inner(mode).await
        {
            error!("run_inbox_network_daily_consistency_worker_inner failed: {:#?}", e);
        }
        tokio::time::sleep(Duration::from_secs(
            SIGINT_INBOX_NETWORK_CHECK_SLEEP_SECS,
        ))
        .await;
    }
}

async fn run_inbox_network_daily_consistency_worker_inner(
    mode: Mode,
) -> anyhow::Result<()> {
    let config = read_config(mode).c(h!())?;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!(
            "run_inbox_network_daily_consistency_worker_nofail disabled, sleeping..."
        );

        return Ok(());
    }

    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    info!("run_inbox_network_daily_consistency_worker_once started");
    if let Err(e) =
        super::consistency::run_inbox_network_daily_consistency_worker_once(&db)
            .await
    {
        error!(
            "run_inbox_network_daily_consistency_worker_once failed: {:#?}",
            e
        );
    } else {
        info!("run_inbox_network_daily_consistency_worker_once completed");
    }
    Ok(())
}

// Single worker pass: fetch pending tasks, triage, execute, then sleep to the next run.
async fn run_inbox_network_worker_once(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
    config: &Config,
) -> anyhow::Result<()> {
    let (tag, cutoff_days) = if is_for_old_worker {
        (
            NETWORK_INVALIDATION_TASK_TAG_OLD,
            NETWORK_INBOX_OLD_WORKER_CUTOFF_DAYS,
        )
    } else {
        (
            NETWORK_INVALIDATION_TASK_TAG_RECENT,
            NETWORK_INBOX_FRESH_WORKER_CUTOFF_DAYS,
        )
    };
    update_worker_status(db, NetworkInvalidationWorkerStatus::Triage, tag)
        .await
        .c(h!())?;
    let cutoff = Utc::now().naive_utc() - chrono::Duration::days(cutoff_days);
    let max_pending_task_id = load_max_pending_task_id(db, is_for_old_worker)
        .await
        .c(h!())?;
    let mut task_list = load_and_triage_tasks_batch(
        db,
        is_for_old_worker,
        cutoff,
        tag,
        max_pending_task_id,
    )
    .await
    .c(h!())?;
    if task_list.is_empty() {
        info!("[{tag} worker] task_list is empty after triage, skipping...");
        return Ok(());
    }

    update_worker_status(db, NetworkInvalidationWorkerStatus::Working, tag)
        .await
        .c(h!())?;
    let signal_group_aors = load_signal_group_aors(db).await.c(h!())?;

    let max_till_ts_raw = task_list.iter().map(|x| x.till_ts).max().c(h!())?;
    let mut max_till_ts = next_hour_boundary(max_till_ts_raw);

    let mut work_started = Instant::now();
    let mut fuel = 1_000_000;
    let mut processed_items = HashSet::new();
    let total_counter = task_list.len();
    let mut counter = 0;
    while !task_list.is_empty() {
        if is_for_old_worker && !check_is_worker_night_shift(config) {
            return Ok(());
        }
        let min_till_ts = max_till_ts - chrono::Duration::hours(1);
        let mut next_tasks: Vec<network_invalidation_task::Model> = task_list
            .extract_if(.., |t| {
                t.till_ts <= max_till_ts && t.till_ts >= min_till_ts
            })
            .collect();
        max_till_ts = min_till_ts;
        fuel -= 1;
        if fuel < 0 {
            error!("run_inbox_network_worker_once loop error -- unexpected task list: {:?}", task_list);
            for task in task_list {
                // process all remaining tasks at once
                next_tasks.push(task);
            }
            task_list = vec![];
        }
        if next_tasks.is_empty() {
            continue;
        }
        if is_for_old_worker
            && work_started.elapsed()
                >= Duration::from_secs(
                    NETWORK_INBOX_OLD_WORKER_ACTIVE_WINDOW_SECS,
                )
        {
            tokio::time::sleep(Duration::from_secs(
                NETWORK_INBOX_OLD_WORKER_ACTIVE_REST_SECS,
            ))
            .await;
            work_started = Instant::now();
        }

        counter += next_tasks.len();

        debug!(
            "[{tag} worker] run_network_invalidation_tasks: processing next tasks batch - {counter}/{total_counter}"
        );
        run_network_invalidation_tasks(
            next_tasks,
            &signal_group_aors,
            &mut processed_items,
            db,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn load_and_triage_tasks_batch(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
    cutoff: NaiveDateTime,
    tag: &str,
    max_pending_task_id: Option<i64>,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let mut result = vec![];
    loop {
        let pending_tasks = load_pending_tasks_batch(
            db,
            is_for_old_worker,
            tag,
            max_pending_task_id,
        )
        .await
        .c(h!())?;
        if pending_tasks.is_empty() {
            break;
        }
        let triaged_tasks = triage_pending_tasks_batch(
            db,
            pending_tasks,
            is_for_old_worker,
            cutoff,
            tag,
        )
        .await
        .c(h!())?;
        if !triaged_tasks.is_empty() {
            for t in triaged_tasks {
                result.push(t);
            }
        }
    }
    Ok(result)
}

async fn load_pending_tasks_batch(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
    tag: &str,
    max_pending_task_id: Option<i64>,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let mut pending_tasks_query = network_invalidation_task::Entity::find()
        .filter(network_invalidation_task::Column::CompletedAt.is_null())
        .order_by_desc(network_invalidation_task::Column::Id)
        .limit(NETWORK_INVALIDATION_TASK_FETCH_BATCH_SIZE);
    if let Some(max_id) = max_pending_task_id {
        pending_tasks_query = pending_tasks_query
            .filter(network_invalidation_task::Column::Id.lte(max_id));
    }
    if is_for_old_worker {
        pending_tasks_query = pending_tasks_query.filter(
            network_invalidation_task::Column::Tag
                .eq(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string()),
        );
    } else {
        pending_tasks_query = pending_tasks_query.filter(
            network_invalidation_task::Column::TillTs
                .lte(Utc::now().naive_utc()),
        );
        pending_tasks_query = pending_tasks_query.filter(
            network_invalidation_task::Column::Tag
                .ne(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string()),
        );
    }
    let pending_tasks = pending_tasks_query.all(db).await.c(h!())?;
    if pending_tasks.len()
        == NETWORK_INVALIDATION_TASK_FETCH_BATCH_SIZE as usize
    {
        info!(
            "[{tag} worker] fetched max pending tasks batch: {}",
            NETWORK_INVALIDATION_TASK_FETCH_BATCH_SIZE
        );
    }
    Ok(pending_tasks)
}

async fn load_max_pending_task_id(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
) -> anyhow::Result<Option<i64>> {
    let mut query = network_invalidation_task::Entity::find()
        .select_only()
        .column(network_invalidation_task::Column::Id)
        .filter(network_invalidation_task::Column::CompletedAt.is_null())
        .order_by_desc(network_invalidation_task::Column::Id);
    if is_for_old_worker {
        query = query.filter(
            network_invalidation_task::Column::Tag
                .eq(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string()),
        );
    } else {
        query = query.filter(
            network_invalidation_task::Column::TillTs
                .lte(Utc::now().naive_utc()),
        );
        query = query.filter(
            network_invalidation_task::Column::Tag
                .ne(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string()),
        );
    }
    query.into_tuple::<i64>().one(db).await.c(h!())
}

async fn triage_pending_tasks_batch(
    db: &DatabaseConnection,
    pending_tasks: Vec<network_invalidation_task::Model>,
    is_for_old_worker: bool,
    cutoff: NaiveDateTime,
    tag: &str,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let txn = db.begin().await.c(h!())?;
    network_invalidation_task::Entity::delete_many() // delete completed tasks before triage
        .filter(network_invalidation_task::Column::CompletedAt.is_not_null())
        .filter(network_invalidation_task::Column::Tag.eq(tag))
        .exec(&txn)
        .await
        .c(h!())?;
    let task_list = if is_for_old_worker {
        triage_tasks_for_old_worker(pending_tasks, &txn)
            .await
            .c(h!())?
    } else {
        triage_tasks(pending_tasks, cutoff, &txn).await.c(h!())?
    };
    txn.commit().await.c(h!())?;
    Ok(task_list)
}

async fn load_signal_group_aors(
    db: &DatabaseConnection,
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let recs = signal_group_aor::Entity::find()
        .select_only()
        .column(signal_group_aor::Column::AorId)
        .column(signal_group_aor::Column::MasterKey)
        .into_tuple::<(i64, String)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::<i64, Vec<String>>::new(), |mut acc, (k, v)| {
            acc.entry(k).or_default().push(v);
            acc
        });
    Ok(recs)
}

// Split tasks by cutoff (moving the newer part to old worker), then split remaining tasks
// into 1-hour windows and persist the new task set while removing the original pending tasks.
async fn triage_tasks(
    input_tasks: Vec<network_invalidation_task::Model>,
    cutoff: NaiveDateTime,
    db: &DatabaseTransaction,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let mut existing_tasks = vec![];
    let mut recent_tasks = Vec::new();
    let mut old_worker_ids = BTreeSet::new();
    let mut ids_to_mark_old = Vec::new();
    for task in input_tasks {
        if task.since_ts < cutoff && task.till_ts > cutoff {
            split_task_by_cutoff(
                cutoff,
                db,
                &mut existing_tasks,
                &mut recent_tasks,
                &mut old_worker_ids,
                task,
            )
            .await
            .c(h!())?;
        } else if task.till_ts <= cutoff {
            old_worker_ids.insert(task.id);
            if task.tag != NETWORK_INVALIDATION_TASK_TAG_OLD {
                ids_to_mark_old.push(task.id);
            }
        } else {
            existing_tasks.push(task.clone());
            recent_tasks.push(task);
        }
    }

    let all_tasks = recent_tasks
        .into_iter()
        .flat_map(split_task)
        .collect::<Vec<_>>();

    let txn = db.begin().await.c(h!())?;
    mark_tasks_old(ids_to_mark_old, &txn).await.c(h!())?;
    let mut triaged_recent_tasks =
        insert_triaged_tasks(all_tasks, false, &txn).await.c(h!())?;
    delete_original_tasks(&existing_tasks, &old_worker_ids, &txn)
        .await
        .c(h!())?;
    triaged_recent_tasks.sort_by(|a, b| {
        b.till_ts.cmp(&a.till_ts).then_with(|| b.id.cmp(&a.id))
    });
    txn.commit().await.c(h!())?;
    Ok(triaged_recent_tasks)
}

async fn mark_tasks_old(
    task_ids: Vec<i64>,
    db: &DatabaseTransaction,
) -> anyhow::Result<()> {
    if task_ids.is_empty() {
        return Ok(());
    }
    for id_chunk in task_ids.chunks(NETWORK_INVALIDATION_DELETE_MAX_IDS) {
        network_invalidation_task::Entity::update_many()
            .col_expr(
                network_invalidation_task::Column::Tag,
                Expr::value(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string()),
            )
            .filter(
                network_invalidation_task::Column::Id.is_in(id_chunk.to_vec()),
            )
            .exec(db)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn split_task_by_cutoff(
    cutoff: NaiveDateTime,
    db: &DatabaseTransaction,
    existing_tasks: &mut Vec<network_invalidation_task::Model>,
    recent_tasks: &mut Vec<network_invalidation_task::Model>,
    old_worker_ids: &mut BTreeSet<i64>,
    task: network_invalidation_task::Model,
) -> anyhow::Result<()> {
    let mut task1 = task.clone().into_active_model();
    let mut task2 = task.clone().into_active_model();
    let txn = db.begin().await.c(h!())?;
    task1.till_ts = Set(cutoff);
    task1.tag = Set(NETWORK_INVALIDATION_TASK_TAG_OLD.to_string());
    task1.id = NotSet;
    task1.created_at = NotSet;

    task2.since_ts = Set(cutoff);
    task2.tag = Set(NETWORK_INVALIDATION_TASK_TAG_RECENT.to_string());
    task2.id = NotSet;
    task2.created_at = NotSet;

    task.delete(&txn).await.c(h!())?;
    let old_task = task1.insert(&txn).await.c(h!())?;
    let new_task = task2.insert(&txn).await.c(h!())?;

    recent_tasks.push(new_task.clone());
    old_worker_ids.insert(old_task.id);
    existing_tasks.push(old_task);
    existing_tasks.push(new_task);
    txn.commit().await.c(h!())?;
    Ok(())
}

// Old worker triage: split into 1-hour windows, drop redundant tasks, merge overlaps,
// then replace the original tasks with the normalized set.
async fn triage_tasks_for_old_worker(
    existing_tasks: Vec<network_invalidation_task::Model>,
    db: &DatabaseTransaction,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let all_tasks = existing_tasks
        .iter()
        .cloned()
        .flat_map(split_task)
        .collect::<Vec<_>>();
    let mut triaged_old_tasks =
        insert_triaged_tasks(all_tasks, true, db).await.c(h!())?;
    delete_original_tasks(&existing_tasks, &BTreeSet::new(), db)
        .await
        .c(h!())?;
    triaged_old_tasks.sort_by(|a, b| {
        b.till_ts.cmp(&a.till_ts).then_with(|| b.id.cmp(&a.id))
    });
    Ok(triaged_old_tasks)
}

// Split a task into hour-aligned windows to limit per-task processing size.
fn split_task(
    task: network_invalidation_task::Model,
) -> Vec<network_invalidation_task::Model> {
    if task.till_ts <= task.since_ts {
        return vec![task];
    }
    let mut tasks = Vec::new();
    let mut cursor = task;
    loop {
        let cutoff = next_hour_boundary(cursor.since_ts);
        if cutoff >= cursor.till_ts {
            tasks.push(cursor);
            break;
        }
        let mut first = cursor.clone();
        first.till_ts = cutoff;
        tasks.push(first);
        cursor.since_ts = cutoff;
    }
    tasks
}

// Returns the next hour boundary strictly after the input timestamp.
fn next_hour_boundary(ts: NaiveDateTime) -> NaiveDateTime {
    let hour_start = ts.date().and_hms_opt(ts.hour(), 0, 0).unwrap();
    hour_start + chrono::Duration::hours(1)
}

// Insert triaged tasks as fresh rows for the recent worker.
async fn insert_triaged_tasks(
    tasks: Vec<network_invalidation_task::Model>,
    is_for_old_worker: bool,
    db: &DatabaseTransaction,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let task_count_before_dedupe = tasks.len();
    let mut seen_tasks = HashSet::new();
    let mut inserted = Vec::new();
    let tag = if is_for_old_worker {
        NETWORK_INVALIDATION_TASK_TAG_OLD
    } else {
        NETWORK_INVALIDATION_TASK_TAG_RECENT
    };
    for task in tasks {
        let task_key = (
            task.frequency.clone(),
            task.since_ts,
            task.till_ts,
            task.sigint_network_id,
            task.aor_id,
            task.group_master_key.clone(),
        );
        if !seen_tasks.insert(task_key) {
            continue;
        }
        let active = network_invalidation_task::ActiveModel {
            id: NotSet,
            frequency: Set(task.frequency.clone()),
            since_ts: Set(task.since_ts),
            till_ts: Set(task.till_ts),
            started_at: NotSet,
            completed_at: NotSet,
            created_at: NotSet,
            aor_id: NotSet,
            group_master_key: NotSet,
            sigint_network_id: Set(task.sigint_network_id),
            tag: Set(tag.to_string()),
        };
        let task = active.insert(db).await.c(h!())?;
        inserted.push(task);
    }
    info!(
        "inserted {} tasks (from {} triaged candidates)",
        inserted.len(),
        task_count_before_dedupe
    );
    Ok(inserted)
}

// Remove the original pending tasks after triage, keeping any task reassigned to old worker.
async fn delete_original_tasks(
    existing_tasks: &[network_invalidation_task::Model],
    old_worker_ids: &BTreeSet<i64>,
    db: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let ids_to_delete = existing_tasks
        .iter()
        .map(|task| task.id)
        .filter(|id| !old_worker_ids.contains(id))
        .collect::<BTreeSet<_>>();
    if ids_to_delete.is_empty() {
        return Ok(());
    }
    let ids_to_delete = ids_to_delete.into_iter().collect::<Vec<_>>();
    for id_chunk in ids_to_delete.chunks(NETWORK_INVALIDATION_DELETE_MAX_IDS) {
        network_invalidation_task::Entity::delete_many()
            .filter(
                network_invalidation_task::Column::Id.is_in(id_chunk.to_vec()),
            )
            .exec(db)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn run_network_invalidation_tasks(
    tasks: Vec<network_invalidation_task::Model>,
    signal_group_aors: &HashMap<i64, Vec<String>>,
    processed_items: &mut HashSet<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let mut started_tasks = vec![];
    let mut task_filters = Vec::new();
    let mut network_ids = HashSet::new();
    let mut needs_all_networks = false;
    let mut min_since_ts: Option<NaiveDateTime> = None;
    let mut max_till_ts: Option<NaiveDateTime> = None;
    for task in tasks {
        if task.started_at.is_some() {
            warn!("task {} was already started!", task.id);
        }
        let task = mark_task_started(&task, dbx).await.c(h!())?;
        min_since_ts = match min_since_ts {
            Some(prev) => Some(prev.min(task.since_ts)),
            None => Some(task.since_ts),
        };
        max_till_ts = match max_till_ts {
            Some(prev) => Some(prev.max(task.till_ts)),
            None => Some(task.till_ts),
        };
        if let Some(network_id) = task.sigint_network_id {
            network_ids.insert(network_id);
        } else {
            needs_all_networks = true;
        }
        started_tasks.push(task.clone());
        task_filters.extend(build_task_filters(&task, signal_group_aors));
    }

    process_task_filters(task_filters, processed_items, dbx)
        .await
        .c(h!())?;

    if let (Some(since_ts), Some(till_ts)) = (min_since_ts, max_till_ts) {
        let since_date = crate::stats::get_local_date(since_ts);
        let till_date = crate::stats::get_local_date(till_ts);
        let since_ts = crate::stats::start_of_day(since_date).c(h!())?;
        let till_ts =
            crate::stats::start_of_day(till_date + chrono::Duration::days(1))
                .c(h!())?;
        let network_ids = if needs_all_networks {
            None
        } else {
            Some(&network_ids)
        };
        crate::stats::recalculate_network_stats(
            dbx,
            since_ts,
            till_ts,
            network_ids,
        )
        .await
        .c(h!())?;
    }

    let completed_at = Some(Utc::now().naive_utc());
    mark_tasks_completed(started_tasks, completed_at, dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn mark_task_started(
    task: &network_invalidation_task::Model,
    dbx: &DatabaseConnection,
) -> anyhow::Result<network_invalidation_task::Model> {
    let mut task_rec = task.clone().into_active_model();
    task_rec.started_at = Set(Some(Utc::now().naive_utc()));
    let task = task_rec.update(dbx).await.c(h!())?;
    Ok(task)
}

struct TaskFilter {
    condition: Condition,
    param_count: usize,
}

fn base_task_param_count(task: &network_invalidation_task::Model) -> usize {
    let mut count = 2; // since_ts + till_ts
    if task.frequency.is_some() {
        count += 1;
    }
    if task.sigint_network_id.is_some() {
        count += 1;
    }
    if task.group_master_key.is_some() {
        count += 1;
    }
    count
}

fn build_base_task_filter(
    task: &network_invalidation_task::Model,
) -> Condition {
    let mut task_filter = Condition::all()
        .add(sigint_inbox_item::Column::Datetime.gte(task.since_ts))
        .add(sigint_inbox_item::Column::Datetime.lte(task.till_ts));
    if let Some(freq) = task.frequency.clone() {
        task_filter = task_filter.add(sigint_inbox_item::Column::Freq.eq(freq))
    }
    if let Some(id) = task.sigint_network_id {
        task_filter = task_filter
            .add(sigint_inbox_item_network::Column::SigintNetworkId.eq(id))
    }
    if let Some(master_key) = task.group_master_key.clone() {
        task_filter = task_filter
            .add(signal_message_group::Column::GroupMasterKey.eq(master_key))
    }
    task_filter
}

fn build_task_filters(
    task: &network_invalidation_task::Model,
    signal_group_aors: &HashMap<i64, Vec<String>>,
) -> Vec<TaskFilter> {
    let base_params = base_task_param_count(task);
    let max_keys_per_filter = NETWORK_INVALIDATION_QUERY_MAX_PARAMS
        .saturating_sub(base_params)
        .max(1);
    let Some(aor_id) = &task.aor_id else {
        return vec![TaskFilter {
            condition: build_base_task_filter(task),
            param_count: base_params,
        }];
    };
    let Some(master_keys) = signal_group_aors.get(aor_id) else {
        return vec![TaskFilter {
            condition: build_base_task_filter(task),
            param_count: base_params,
        }];
    };
    if master_keys.is_empty() {
        return vec![TaskFilter {
            condition: build_base_task_filter(task),
            param_count: base_params,
        }];
    }

    let mut filters = Vec::new();
    for master_key_chunk in master_keys.chunks(max_keys_per_filter) {
        let mut task_filter = build_base_task_filter(task);
        let mut key_filter = Condition::any();
        for master_key in master_key_chunk {
            key_filter = key_filter.add(
                signal_message_group::Column::GroupMasterKey
                    .eq(master_key.clone()),
            );
        }
        task_filter = task_filter.add(key_filter);
        filters.push(TaskFilter {
            condition: task_filter,
            param_count: base_params + master_key_chunk.len(),
        });
    }
    filters
}

async fn process_task_filters(
    task_filters: Vec<TaskFilter>,
    processed_items: &mut HashSet<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let mut chunk_filters = Vec::new();
    let mut chunk_params = 0usize;
    for task_filter in task_filters {
        let would_exceed_params = chunk_params + task_filter.param_count
            > NETWORK_INVALIDATION_QUERY_MAX_PARAMS;
        let would_exceed_count =
            chunk_filters.len() >= NETWORK_INVALIDATION_TASKS_FILTER_CHUNK;
        if (would_exceed_params || would_exceed_count)
            && !chunk_filters.is_empty()
        {
            process_task_filter_chunk(
                std::mem::take(&mut chunk_filters),
                processed_items,
                dbx,
            )
            .await
            .c(h!())?;
            chunk_params = 0;
        }
        chunk_params += task_filter.param_count;
        chunk_filters.push(task_filter.condition);
    }
    if !chunk_filters.is_empty() {
        process_task_filter_chunk(chunk_filters, processed_items, dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn process_task_filter_chunk(
    filters: Vec<Condition>,
    processed_items: &mut HashSet<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let mut main_filter = Condition::any();
    for task_filter in filters {
        main_filter = main_filter.add(task_filter);
    }
    process_invalidation_filter(main_filter, processed_items, dbx)
        .await
        .c(h!())?;
    Ok(())
}

async fn process_invalidation_filter(
    main_filter: Condition,
    processed_items: &mut HashSet<i64>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let mut last_id = None;
    loop {
        let mut id_filter = main_filter.clone();
        if let Some(last_id) = last_id {
            id_filter = Condition::all()
                .add(id_filter)
                .add(sigint_inbox_item::Column::Id.lt(last_id));
        }
        let txn = dbx.begin().await.c(h!())?;
        let sigint_inbox_items = sigint_inbox_item::Entity::find()
            .join(
                JoinType::LeftJoin,
                sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SignalMessageGroup.def(),
            )
            .filter(id_filter.clone())
            .order_by_desc(sigint_inbox_item::Column::Id)
            .limit(NETWORK_INVALIDATION_BATCH_SIZE)
            .all(&txn)
            .await
            .c(h!())?;
        if sigint_inbox_items.is_empty() {
            break;
        }
        let mut new_processed_item_ids = Vec::new();
        last_id = sigint_inbox_items.iter().map(|i| i.id).min();
        let mut items_to_process = vec![];
        for item in sigint_inbox_items {
            if processed_items.contains(&item.id) {
                continue;
            }
            new_processed_item_ids.push(item.id);
            items_to_process.push(item);
        }
        if items_to_process.is_empty() {
            continue;
        }
        crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
            items_to_process,
            &txn,
        )
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;
        for id in new_processed_item_ids {
            processed_items.insert(id);
        }
    }
    Ok(())
}

async fn mark_tasks_completed(
    started_tasks: Vec<network_invalidation_task::Model>,
    completed_at: Option<NaiveDateTime>,
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    for task in started_tasks {
        let mut task_rec = task.clone().into_active_model();
        task_rec.completed_at = Set(completed_at);
        task_rec.update(dbx).await.c(h!())?;
    }
    Ok(())
}
