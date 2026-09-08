use crate::config::*;
use crate::entities::network_invalidation_task;
use crate::entities::sea_orm_active_enums::NetworkInvalidationWorkerStatus;
use crate::entities::*;
use crate::h;
use crate::types::{debug, error, info, warn};
use crate::types::{Env, ShortContext};
use crate::utils::worker_watch;
use chrono::{NaiveDate, NaiveDateTime, Timelike, Utc};
use echo_migration::Expr;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
// Worker that keeps recent inbox items aligned with network definitions by
// picking pending invalidation tasks, normalizing them (split/merge), and
// executing them in a stable order.

// No-fail worker loop: run tasks every hour and retry errors sooner.
pub async fn run_recent_inbox_network_worker_nofail(env: Arc<Env>) {
    loop {
        let _loop_guard =
            worker_watch::loop_guard("run_recent_inbox_network_worker_nofail");
        let sleep_secs = match run_recent_inbox_network_worker_inner(&env).await
        {
            Ok(()) => NETWORK_INBOX_WORKER_DEFAULT_SLEEP,
            Err(e) => {
                error!(
                    "run_recent_inbox_network_worker_nofail failed; retrying after {} seconds: {:#?}",
                    NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC,
                    e
                );
                NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC
            }
        };
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

async fn run_recent_inbox_network_worker_inner(
    env: &Env,
) -> anyhow::Result<()> {
    let config = &env.config;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!("run_recent_inbox_network_worker_nofail disabled, sleeping...");
        return Ok(());
    }
    info!("run_inbox_network_worker_once started");
    let stats_redis =
        crate::stats::redis::GroupStatsRedis::new(env.stats_redis.clone());
    let result =
        run_inbox_network_worker_once(&env.dbx, false, config, &stats_redis)
            .await;
    if result.is_ok() {
        info!("run_inbox_network_worker_once completed");
    }
    update_worker_status(
        &env.dbx,
        NetworkInvalidationWorkerStatus::Sleep,
        NETWORK_INVALIDATION_TASK_TAG_RECENT,
    )
    .await
    .c(h!())?;
    result.c(h!())
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
pub async fn run_old_inbox_network_worker_nofail(env: Arc<Env>) {
    loop {
        let _loop_guard =
            worker_watch::loop_guard("run_old_inbox_network_worker_nofail");
        let sleep_secs = match run_old_inbox_network_worker_inner(&env).await {
            Ok(()) => NETWORK_INBOX_WORKER_DEFAULT_SLEEP,
            Err(e) => {
                error!(
                    "run_old_inbox_network_worker_nofail failed; retrying after {} seconds: {:#?}",
                    NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC,
                    e
                );
                NETWORK_INVALIDATION_TASK_WAIT_SLEEP_SEC
            }
        };
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

async fn run_old_inbox_network_worker_inner(env: &Env) -> anyhow::Result<()> {
    let config = &env.config;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!(
            "run_inbox_network_daily_consistency_worker_nofail disabled, sleeping..."
        );

        return Ok(());
    }

    wait_until_worker_shift_start(config).await;
    info!("run_old_inbox_network_worker_once started");
    let stats_redis =
        crate::stats::redis::GroupStatsRedis::new(env.stats_redis.clone());
    let result =
        run_inbox_network_worker_once(&env.dbx, true, config, &stats_redis)
            .await;
    if result.is_ok() {
        info!("run_old_inbox_network_worker_once completed");
    }
    update_worker_status(
        &env.dbx,
        NetworkInvalidationWorkerStatus::Sleep,
        NETWORK_INVALIDATION_TASK_TAG_OLD,
    )
    .await
    .c(h!())?;
    result.c(h!())
}

async fn ensure_network_invalidation_queue_within_limit(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    let first_overflow_task_id = network_invalidation_task::Entity::find()
        .select_only()
        .column(network_invalidation_task::Column::Id)
        .order_by_asc(network_invalidation_task::Column::Id)
        .offset(NETWORK_INVALIDATION_TASK_MAX_TASKS)
        .limit(1)
        .into_tuple::<i64>()
        .one(db)
        .await
        .c(h!())?;
    if let Some(first_overflow_task_id) = first_overflow_task_id {
        error!(
            "network invalidation queue exceeds limit: limit={}, first_overflow_task_id={first_overflow_task_id}; refusing to triage or delete tasks",
            NETWORK_INVALIDATION_TASK_MAX_TASKS
        );
        anyhow::bail!(
            "network invalidation queue exceeds {} tasks",
            NETWORK_INVALIDATION_TASK_MAX_TASKS
        );
    }
    Ok(())
}

// Daily checker: compare calculated networks to stored ones for today's messages.
pub async fn run_inbox_network_daily_consistency_worker_nofail(env: Arc<Env>) {
    loop {
        let _loop_guard = worker_watch::loop_guard(
            "run_inbox_network_daily_consistency_worker_nofail",
        );
        if let Err(e) =
            run_inbox_network_daily_consistency_worker_inner(&env).await
        {
            error!(
                "run_inbox_network_daily_consistency_worker_inner failed: {:#?}",
                e
            );
        }
        tokio::time::sleep(Duration::from_secs(
            SIGINT_INBOX_NETWORK_CHECK_SLEEP_SECS,
        ))
        .await;
    }
}

async fn run_inbox_network_daily_consistency_worker_inner(
    env: &Env,
) -> anyhow::Result<()> {
    let config = &env.config;
    if !config
        .feature_calculate_sigint_inbox_item_networks
        .unwrap_or(true)
    {
        info!(
            "run_inbox_network_daily_consistency_worker_nofail disabled, sleeping..."
        );

        return Ok(());
    }

    info!("run_inbox_network_daily_consistency_worker_once started");
    if let Err(e) =
        super::consistency::run_inbox_network_daily_consistency_worker_once(
            &env.dbx,
        )
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
    stats_redis: &crate::stats::redis::GroupStatsRedis,
) -> anyhow::Result<()> {
    ensure_network_invalidation_queue_within_limit(db)
        .await
        .c(h!())?;
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
    let mut task_list = if is_for_old_worker {
        load_and_triage_old_tasks_batch(db, cutoff, tag)
            .await
            .c(h!())?
    } else {
        let max_pending_task_id =
            load_max_pending_task_id(db, false).await.c(h!())?;
        load_and_triage_tasks_batch(db, false, cutoff, tag, max_pending_task_id)
            .await
            .c(h!())?
    };
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
    let mut started_tasks = Vec::new();
    let mut stats_invalidation = NetworkStatsInvalidation::default();
    let total_counter = task_list.len();
    let mut counter = 0;
    while !task_list.is_empty() {
        if is_for_old_worker && !check_is_worker_night_shift(config) {
            finish_network_invalidation_tasks(
                started_tasks,
                stats_invalidation,
                db,
                stats_redis,
            )
            .await
            .c(h!())?;
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
            error!(
                "run_inbox_network_worker_once loop error -- unexpected task list: {:?}",
                task_list
            );
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
        let processed_tasks = run_network_invalidation_tasks(
            next_tasks,
            &signal_group_aors,
            &mut processed_items,
            db,
        )
        .await
        .c(h!())?;
        for task in &processed_tasks {
            stats_invalidation.add_task(task).c(h!())?;
        }
        started_tasks.extend(processed_tasks);
    }
    finish_network_invalidation_tasks(
        started_tasks,
        stats_invalidation,
        db,
        stats_redis,
    )
    .await
    .c(h!())
}

async fn load_and_triage_tasks_batch(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
    cutoff: NaiveDateTime,
    tag: &str,
    max_pending_task_id: Option<i64>,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    delete_completed_tasks(db, tag).await.c(h!())?;
    let pending_tasks = load_pending_tasks_batch(
        db,
        is_for_old_worker,
        tag,
        max_pending_task_id,
    )
    .await
    .c(h!())?;
    if pending_tasks.is_empty() {
        return Ok(vec![]);
    }
    triage_pending_tasks_batch(db, pending_tasks, is_for_old_worker, cutoff)
        .await
}

async fn load_and_triage_old_tasks_batch(
    db: &DatabaseConnection,
    cutoff: NaiveDateTime,
    tag: &str,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    delete_completed_tasks(db, tag).await.c(h!())?;
    let pending_tasks = load_pending_tasks_batch(db, true, tag, None)
        .await
        .c(h!())?;
    if pending_tasks.is_empty() {
        return Ok(vec![]);
    }
    triage_pending_tasks_batch(db, pending_tasks, true, cutoff)
        .await
        .c(h!())
}

async fn delete_completed_tasks(
    db: &DatabaseConnection,
    tag: &str,
) -> anyhow::Result<()> {
    network_invalidation_task::Entity::delete_many()
        .filter(network_invalidation_task::Column::CompletedAt.is_not_null())
        .filter(network_invalidation_task::Column::Tag.eq(tag))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn load_pending_tasks_batch(
    db: &DatabaseConnection,
    is_for_old_worker: bool,
    tag: &str,
    max_pending_task_id: Option<i64>,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let mut pending_tasks_query = network_invalidation_task::Entity::find()
        .filter(network_invalidation_task::Column::CompletedAt.is_null())
        .limit(NETWORK_INVALIDATION_TASK_FETCH_BATCH_SIZE);
    pending_tasks_query = if is_for_old_worker {
        pending_tasks_query.order_by_asc(network_invalidation_task::Column::Id)
    } else {
        pending_tasks_query.order_by_desc(network_invalidation_task::Column::Id)
    };
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
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let pending_tasks = select_tasks_within_triage_budget(
        pending_tasks,
        is_for_old_worker,
        cutoff,
    )
    .c(h!())?;
    let txn = db.begin().await.c(h!())?;
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

fn select_tasks_within_triage_budget(
    pending_tasks: Vec<network_invalidation_task::Model>,
    is_for_old_worker: bool,
    cutoff: NaiveDateTime,
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let fetched_task_count = pending_tasks.len();
    let mut selected_tasks = Vec::new();
    let mut selected_window_count = 0;
    for task in pending_tasks {
        let window_count =
            triaged_task_window_count(&task, is_for_old_worker, cutoff)
                .c(h!())?;
        if window_count > NETWORK_INVALIDATION_TRIAGE_MAX_WINDOWS {
            error!(
                "network invalidation task exceeds triage budget: task_id={}, since_ts={}, till_ts={}, planned_windows={}, max_windows={}",
                task.id,
                task.since_ts,
                task.till_ts,
                window_count,
                NETWORK_INVALIDATION_TRIAGE_MAX_WINDOWS
            );
            anyhow::bail!(
                "network invalidation task {} requires {} windows",
                task.id,
                window_count
            );
        }
        if !selected_tasks.is_empty()
            && selected_window_count + window_count
                > NETWORK_INVALIDATION_TRIAGE_MAX_WINDOWS
        {
            break;
        }
        selected_window_count += window_count;
        selected_tasks.push(task);
    }
    info!(
        "network invalidation triage selected: fetched_tasks={fetched_task_count}, selected_tasks={}, planned_windows={selected_window_count}, max_windows={}",
        selected_tasks.len(),
        NETWORK_INVALIDATION_TRIAGE_MAX_WINDOWS
    );
    Ok(selected_tasks)
}

fn triaged_task_window_count(
    task: &network_invalidation_task::Model,
    is_for_old_worker: bool,
    cutoff: NaiveDateTime,
) -> anyhow::Result<usize> {
    if !is_for_old_worker && task.till_ts <= cutoff {
        return Ok(0);
    }
    let since_ts = if !is_for_old_worker && task.since_ts < cutoff {
        cutoff
    } else {
        task.since_ts
    };
    split_task_window_count(since_ts, task.till_ts)
}

fn split_task_window_count(
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> anyhow::Result<usize> {
    if till_ts <= since_ts {
        return Ok(1);
    }
    let first_boundary = next_hour_boundary(since_ts);
    if first_boundary >= till_ts {
        return Ok(1);
    }
    const HOUR_MICROSECONDS: i64 = 60 * 60 * 1_000_000;
    let remaining_microseconds =
        (till_ts - first_boundary).num_microseconds().c(h!())?;
    let windows_after_first =
        (remaining_microseconds + HOUR_MICROSECONDS - 1) / HOUR_MICROSECONDS;
    usize::try_from(windows_after_first + 1).c(h!())
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
    let (preserved_tasks, tasks_to_split): (Vec<_>, Vec<_>) = existing_tasks
        .into_iter()
        .partition(|task| !old_task_needs_split(task));
    let mut seen_tasks = HashSet::new();
    let (mut preserved_tasks, mut tasks_to_delete) =
        partition_duplicate_tasks(preserved_tasks, &mut seen_tasks);

    let all_tasks = tasks_to_split
        .iter()
        .cloned()
        .flat_map(split_task)
        .collect::<Vec<_>>();
    let (all_tasks, _) = partition_duplicate_tasks(all_tasks, &mut seen_tasks);
    let triaged_old_tasks = if all_tasks.is_empty() {
        vec![]
    } else {
        insert_triaged_tasks(all_tasks, true, db).await.c(h!())?
    };
    tasks_to_delete.extend(tasks_to_split);
    delete_original_tasks(&tasks_to_delete, &BTreeSet::new(), db)
        .await
        .c(h!())?;
    preserved_tasks.extend(triaged_old_tasks);
    preserved_tasks.sort_by(|a, b| {
        b.till_ts.cmp(&a.till_ts).then_with(|| b.id.cmp(&a.id))
    });
    Ok(preserved_tasks)
}

fn old_task_needs_split(task: &network_invalidation_task::Model) -> bool {
    task.till_ts > next_hour_boundary(task.since_ts)
}

type NetworkInvalidationTaskKey = (
    Option<String>,
    NaiveDateTime,
    NaiveDateTime,
    Option<i64>,
    Option<i64>,
    Option<String>,
);

fn network_invalidation_task_key(
    task: &network_invalidation_task::Model,
) -> NetworkInvalidationTaskKey {
    (
        task.frequency.clone(),
        task.since_ts,
        task.till_ts,
        task.sigint_network_id,
        task.aor_id,
        task.group_master_key.clone(),
    )
}

fn partition_duplicate_tasks(
    mut tasks: Vec<network_invalidation_task::Model>,
    seen_tasks: &mut HashSet<NetworkInvalidationTaskKey>,
) -> (
    Vec<network_invalidation_task::Model>,
    Vec<network_invalidation_task::Model>,
) {
    tasks.sort_by_key(|task| task.id);
    tasks.into_iter().partition(|task| {
        seen_tasks.insert(network_invalidation_task_key(task))
    })
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
        let task_key = network_invalidation_task_key(&task);
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
            aor_id: Set(task.aor_id),
            group_master_key: Set(task.group_master_key.clone()),
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
) -> anyhow::Result<Vec<network_invalidation_task::Model>> {
    let mut started_tasks = vec![];
    let mut task_filters = Vec::new();
    for task in tasks {
        if task.started_at.is_some() {
            warn!("task {} was already started!", task.id);
        }
        let task = mark_task_started(&task, dbx).await.c(h!())?;
        started_tasks.push(task.clone());
        task_filters.extend(build_task_filters(&task, signal_group_aors));
    }

    process_task_filters(task_filters, processed_items, dbx)
        .await
        .c(h!())?;

    Ok(started_tasks)
}

#[derive(Default)]
struct NetworkStatsInvalidation {
    scopes_by_date: BTreeMap<NaiveDate, NetworkStatsScope>,
}

impl NetworkStatsInvalidation {
    fn add_task(
        &mut self,
        task: &network_invalidation_task::Model,
    ) -> anyhow::Result<()> {
        let mut date = crate::stats::get_local_date(task.since_ts);
        let till_date = crate::stats::get_local_date(task.till_ts);
        if date > till_date {
            warn!(
                "skip stats invalidation for task {} with inverted interval: since_ts={} till_ts={}",
                task.id, task.since_ts, task.till_ts
            );
            return Ok(());
        }
        loop {
            self.scopes_by_date
                .entry(date)
                .and_modify(|scope| scope.include(task.sigint_network_id))
                .or_insert_with(|| {
                    NetworkStatsScope::new(task.sigint_network_id)
                });
            if date == till_date {
                return Ok(());
            }
            date = date.succ_opt().c(h!())?;
        }
    }
}

enum NetworkStatsScope {
    All,
    Networks(HashSet<i64>),
}

impl NetworkStatsScope {
    fn new(network_id: Option<i64>) -> Self {
        match network_id {
            Some(network_id) => Self::Networks(HashSet::from([network_id])),
            None => Self::All,
        }
    }

    fn include(&mut self, network_id: Option<i64>) {
        match network_id {
            None => *self = Self::All,
            Some(network_id) => {
                if let Self::Networks(network_ids) = self {
                    network_ids.insert(network_id);
                }
            }
        }
    }

    fn network_ids(&self) -> Option<&HashSet<i64>> {
        match self {
            Self::All => None,
            Self::Networks(network_ids) => Some(network_ids),
        }
    }
}

async fn finish_network_invalidation_tasks(
    started_tasks: Vec<network_invalidation_task::Model>,
    stats_invalidation: NetworkStatsInvalidation,
    dbx: &DatabaseConnection,
    stats_redis: &crate::stats::redis::GroupStatsRedis,
) -> anyhow::Result<()> {
    for (date, scope) in stats_invalidation.scopes_by_date {
        let since_ts = crate::stats::start_of_day(date).c(h!())?;
        let till_ts =
            crate::stats::start_of_day(date.succ_opt().c(h!())?).c(h!())?;
        crate::stats::recalculate_network_stats(
            dbx,
            stats_redis,
            since_ts,
            till_ts,
            scope.network_ids(),
        )
        .await
        .c(h!())?;
    }

    crate::sigint::network::recalculation::enqueue_cached_for_network_invalidations(
        dbx,
        &started_tasks,
    )
    .await
    .c(h!())?;

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
    let mut pending_chunks = vec![filters];
    while let Some(mut filters) = pending_chunks.pop() {
        let main_filter = combine_task_filters(&filters);
        match process_invalidation_filter(main_filter, processed_items, dbx)
            .await
        {
            Ok(()) => {}
            Err(error)
                if filters.len() > 1
                    && is_postgres_statement_timeout(&error) =>
            {
                let right = filters.split_off(filters.len() / 2);
                warn!(
                    "network invalidation query timed out; splitting {} filters into {} and {}",
                    filters.len() + right.len(),
                    filters.len(),
                    right.len()
                );
                pending_chunks.push(right);
                pending_chunks.push(filters);
            }
            Err(error) => {
                if is_postgres_statement_timeout(&error) {
                    warn!(
                        "network invalidation query timed out with {} filter; cannot split further",
                        filters.len()
                    );
                }
                return Err(error).c(h!());
            }
        }
    }
    Ok(())
}

fn combine_task_filters(filters: &[Condition]) -> Condition {
    let mut main_filter = Condition::any();
    for task_filter in filters {
        main_filter = main_filter.add(task_filter.clone());
    }
    main_filter
}

fn is_postgres_statement_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        let sea_orm_timeout = match error.downcast_ref::<DbErr>() {
            Some(
                DbErr::Conn(RuntimeErr::SqlxError(error))
                | DbErr::Exec(RuntimeErr::SqlxError(error))
                | DbErr::Query(RuntimeErr::SqlxError(error)),
            ) => sqlx_error_is_statement_timeout(error),
            _ => false,
        };
        sea_orm_timeout
            || error
                .downcast_ref::<sqlx::Error>()
                .is_some_and(sqlx_error_is_statement_timeout)
    })
}

fn sqlx_error_is_statement_timeout(error: &sqlx::Error) -> bool {
    let sqlx::Error::Database(error) = error else {
        return false;
    };
    error.code().as_deref() == Some("57014")
        && error
            .message()
            .contains("canceling statement due to statement timeout")
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
        let stats_recalculation_item_ids =
            super::directly_recalculated_network_unit_item_ids(
                &txn,
                &new_processed_item_ids,
            )
            .await
            .c(h!())?;
        crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
            items_to_process,
            &txn,
        )
        .await
        .c(h!())?;
        for item_id in stats_recalculation_item_ids {
            crate::stats::enqueue_group_stats_recalculation_for_message(
                &txn,
                item_id,
                format!(
                    "recalculated network unit links for inbox message {item_id}"
                ),
            )
            .await
            .c(h!())?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::fmt;

    fn task(
        since_ts: NaiveDateTime,
        till_ts: NaiveDateTime,
        sigint_network_id: Option<i64>,
    ) -> network_invalidation_task::Model {
        network_invalidation_task::Model {
            id: 1,
            frequency: None,
            since_ts,
            till_ts,
            completed_at: None,
            created_at: since_ts,
            sigint_network_id,
            started_at: None,
            aor_id: None,
            group_master_key: None,
            tag: NETWORK_INVALIDATION_TASK_TAG_RECENT.to_string(),
        }
    }

    #[test]
    fn network_stats_invalidation_coalesces_tasks_by_local_date() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 29).unwrap();
        let day_start = crate::stats::start_of_day(date).unwrap();
        let mut invalidation = NetworkStatsInvalidation::default();

        invalidation
            .add_task(&task(
                day_start + chrono::Duration::hours(1),
                day_start + chrono::Duration::hours(2),
                Some(10),
            ))
            .unwrap();
        invalidation
            .add_task(&task(
                day_start + chrono::Duration::hours(3),
                day_start + chrono::Duration::hours(4),
                Some(20),
            ))
            .unwrap();

        assert_eq!(invalidation.scopes_by_date.len(), 1);
        let NetworkStatsScope::Networks(network_ids) =
            invalidation.scopes_by_date.get(&date).unwrap()
        else {
            panic!("expected network-specific invalidation");
        };
        assert_eq!(network_ids, &HashSet::from([10, 20]));
    }

    #[test]
    fn network_stats_invalidation_promotes_date_to_all_networks() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 29).unwrap();
        let day_start = crate::stats::start_of_day(date).unwrap();
        let mut invalidation = NetworkStatsInvalidation::default();

        invalidation
            .add_task(&task(day_start, day_start, Some(10)))
            .unwrap();
        invalidation
            .add_task(&task(day_start, day_start, None))
            .unwrap();

        assert!(matches!(
            invalidation.scopes_by_date.get(&date).unwrap(),
            NetworkStatsScope::All
        ));
    }

    #[test]
    fn network_stats_invalidation_skips_inverted_interval() {
        let mut invalidation = NetworkStatsInvalidation::default();
        let task = task(
            NaiveDate::from_ymd_opt(2026, 7, 27)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            NaiveDate::from_ymd_opt(2026, 6, 22)
                .unwrap()
                .and_hms_opt(7, 12, 3)
                .unwrap(),
            Some(644),
        );

        invalidation.add_task(&task).unwrap();

        assert!(invalidation.scopes_by_date.is_empty());
    }

    #[test]
    fn old_task_split_only_when_it_crosses_hour_boundary() {
        let hour = NaiveDate::from_ymd_opt(2026, 8, 13)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let within_hour = task(
            hour + chrono::Duration::minutes(15),
            hour + chrono::Duration::hours(1),
            None,
        );
        let crossing_hour = task(
            hour + chrono::Duration::minutes(15),
            hour + chrono::Duration::hours(1) + chrono::Duration::seconds(1),
            None,
        );

        assert!(!old_task_needs_split(&within_hour));
        assert!(old_task_needs_split(&crossing_hour));
    }

    #[test]
    fn split_task_window_count_handles_partial_boundaries() {
        let hour = NaiveDate::from_ymd_opt(2026, 8, 13)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();

        assert_eq!(
            split_task_window_count(
                hour + chrono::Duration::minutes(15),
                hour + chrono::Duration::hours(1),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            split_task_window_count(
                hour + chrono::Duration::minutes(15),
                hour + chrono::Duration::hours(1)
                    + chrono::Duration::microseconds(1),
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn triage_rejects_single_task_over_window_budget() {
        let since_ts = NaiveDate::from_ymd_opt(25, 8, 16)
            .unwrap()
            .and_hms_opt(21, 0, 0)
            .unwrap();
        let till_ts = NaiveDate::from_ymd_opt(2026, 8, 16)
            .unwrap()
            .and_hms_opt(18, 0, 0)
            .unwrap();

        let result = select_tasks_within_triage_budget(
            vec![task(since_ts, till_ts, None)],
            true,
            till_ts,
        );

        assert!(result.is_err());
    }

    #[test]
    fn triage_defers_tasks_beyond_batch_window_budget() {
        let since_ts = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let till_ts = since_ts + chrono::Duration::hours(6_000);
        let first = task(since_ts, till_ts, Some(10));
        let mut second = task(since_ts, till_ts, Some(20));
        second.id = 2;

        let selected = select_tasks_within_triage_budget(
            vec![first.clone(), second],
            true,
            till_ts,
        )
        .unwrap();

        assert_eq!(selected, vec![first]);
    }

    #[test]
    fn duplicate_old_tasks_keep_lowest_id_and_seed_split_deduplication() {
        let since_ts = NaiveDate::from_ymd_opt(2026, 8, 13)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        let first =
            task(since_ts, since_ts + chrono::Duration::hours(1), Some(10));
        let mut duplicate = first.clone();
        duplicate.id = 2;
        let mut seen_tasks = HashSet::new();

        let (preserved, duplicates) = partition_duplicate_tasks(
            vec![duplicate.clone(), first.clone()],
            &mut seen_tasks,
        );
        let (split_candidates, duplicate_candidates) =
            partition_duplicate_tasks(vec![duplicate], &mut seen_tasks);

        assert_eq!(preserved, vec![first]);
        assert_eq!(duplicates.len(), 1);
        assert!(split_candidates.is_empty());
        assert_eq!(duplicate_candidates.len(), 1);
    }

    #[test]
    fn statement_timeout_requires_matching_sqlstate_and_message() {
        let timeout = synthetic_database_error(
            "57014",
            "canceling statement due to statement timeout",
        );
        let canceled = synthetic_database_error(
            "57014",
            "canceling statement due to user request",
        );
        let other = synthetic_database_error(
            "23505",
            "canceling statement due to statement timeout",
        );

        assert!(is_postgres_statement_timeout(&timeout));
        assert!(!is_postgres_statement_timeout(&canceled));
        assert!(!is_postgres_statement_timeout(&other));
    }

    #[derive(Debug)]
    struct SyntheticDatabaseError {
        code: &'static str,
        message: &'static str,
    }

    impl fmt::Display for SyntheticDatabaseError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.message)
        }
    }

    impl std::error::Error for SyntheticDatabaseError {}

    impl sqlx::error::DatabaseError for SyntheticDatabaseError {
        fn message(&self) -> &str {
            self.message
        }

        fn code(&self) -> Option<Cow<'_, str>> {
            Some(Cow::Borrowed(self.code))
        }

        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(
            &mut self,
        ) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn into_error(
            self: Box<Self>,
        ) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    fn synthetic_database_error(
        code: &'static str,
        message: &'static str,
    ) -> anyhow::Error {
        let error = sqlx::Error::Database(Box::new(SyntheticDatabaseError {
            code,
            message,
        }));
        let error =
            DbErr::Query(RuntimeErr::SqlxError(std::sync::Arc::new(error)));
        anyhow::Error::new(error).context("synthetic database context")
    }
}
