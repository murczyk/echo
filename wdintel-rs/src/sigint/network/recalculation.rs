use super::primitive_to_naive_datetime;
use crate::config::{
    NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES,
    NETWORK_RECALCULATION_RUN_BUDGET_SECS,
    NETWORK_RECALCULATION_STATEMENT_TIMEOUT_MS,
    NETWORK_RECALCULATION_TASKS_PER_RUN,
    NETWORK_RECALCULATION_TASK_ENQUEUE_CHUNK_SIZE,
    NETWORK_RECALCULATION_TASK_STALE_MINUTES,
};
use crate::entities::sea_orm_active_enums::NetworkRecalculationTaskKind;
use crate::entities::{
    login, network_freq_last_datetime_in_aor, network_invalidation_task,
    network_recalculation_task, sigint_network, sigint_network_aor,
    sigint_network_freq,
};
use crate::h;
use crate::types::{info, ShortContext};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, LockType, OnConflict, UnionType};
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use time::PrimitiveDateTime;

pub(super) async fn load_cached_last_datetime_in_aor(
    db: &DatabaseConnection,
    network_id: i64,
    login_id: uuid::Uuid,
    group_master_keys: &[String],
) -> anyhow::Result<HashMap<i64, Option<i64>>> {
    let group_master_keys =
        normalize_group_master_keys(group_master_keys.to_vec());
    let cached = network_freq_last_datetime_in_aor::Model::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                select cache.*
                from network_freq_last_datetime_in_aor cache
                join sigint_network_freq nf
                  on nf.id = cache.network_freq_id
                where nf.network_id = $1
                  and nf.deleted = false
                  and cache.login_id = $2
                  and not exists (
                      select 1
                      from network_recalculation_task task
                      where task.task_kind = 'network_freq_last_datetime_in_aor'
                        and task.network_freq_id = cache.network_freq_id
                        and task.login_id = cache.login_id
                  )
                  and not exists (
                      select 1
                      from network_invalidation_task task
                      where task.completed_at is null
                        and (
                            task.sigint_network_id is null
                            or task.sigint_network_id = nf.network_id
                        )
                        and (
                            task.frequency is null
                            or task.frequency = nf.freq
                        )
                        and (
                            task.group_master_key is null
                            or exists (
                                select 1
                                from signal_message_group affected_smg
                                join signal_message affected_sm
                                  on affected_sm.id = affected_smg.signal_message_id
                                join sigint_inbox_item affected_ii
                                  on affected_ii.id = affected_sm.id
                                join datasource_group affected_dg
                                  on affected_dg.id = affected_sm.datasource_group_id
                                where affected_smg.group_master_key = task.group_master_key
                                  and affected_dg.group_master_key = any(cache.group_master_keys)
                                  and affected_sm.deleted = false
                                  and affected_ii.freq = nf.freq
                                  and affected_ii.datetime between task.since_ts and task.till_ts
                                  and affected_ii.datetime >= nf.active_from
                                  and affected_ii.datetime
                                        <= coalesce(nf.active_to, current_timestamp at time zone 'utc')
                            )
                        )
                  )
            "#,
            vec![network_id.into(), login_id.into()],
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    let stale_before = Utc::now().naive_utc()
        - Duration::minutes(
            NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES,
        );
    let cached_by_freq = cached
        .into_iter()
        .map(|row| (row.network_freq_id, row))
        .collect::<HashMap<_, _>>();
    let network_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        network_freq_ids
            .into_iter()
            .filter(|network_freq_id| {
                cached_by_freq
                    .get(network_freq_id)
                    .map(|row| {
                        row.calculated_at < stale_before
                            || row.group_master_keys != group_master_keys
                    })
                    .unwrap_or(true)
            })
            .map(|network_freq_id| {
                (
                    NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                    network_freq_id,
                    Some(login_id),
                )
            }),
    )
    .await
    .c(h!())?;
    Ok(cached_by_freq
        .into_values()
        .filter(|row| {
            row.calculated_at >= stale_before
                && row.group_master_keys == group_master_keys
        })
        .map(|row| {
            (
                row.network_freq_id,
                row.last_datetime_in_aor
                    .map(|datetime| datetime.and_utc().timestamp_millis()),
            )
        })
        .collect())
}

pub(super) async fn evict_expired_cache(
    db: &DatabaseConnection,
) -> anyhow::Result<u64> {
    let stale_before = Utc::now().naive_utc()
        - Duration::minutes(
            NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES,
        );
    let deleted_frequency_result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                delete from network_freq_last_datetime_in_aor as cache
                using sigint_network_freq as freq
                where freq.id = cache.network_freq_id
                  and freq.deleted = true
            "#,
            vec![],
        ))
        .await
        .c(h!())?;
    let expired_result =
        network_freq_last_datetime_in_aor::Entity::delete_many()
            .filter(
                network_freq_last_datetime_in_aor::Column::CalculatedAt
                    .lt(stale_before),
            )
            .exec(db)
            .await
            .c(h!())?;
    Ok(deleted_frequency_result.rows_affected() + expired_result.rows_affected)
}

pub(super) async fn enqueue_all_for_network_freq(
    db: &DatabaseTransaction,
    network_freq_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()> {
    let network_freq_exists =
        sigint_network_freq::Entity::find_by_id(network_freq_id)
            .select_only()
            .column(sigint_network_freq::Column::Id)
            .into_tuple::<i64>()
            .one(db)
            .await
            .c(h!())?
            .is_some();
    if !network_freq_exists {
        return Ok(());
    }
    lock_network_freq_recalculation(db, network_freq_id)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        [
            (
                NetworkRecalculationTaskKind::NetworkFreqLastSeen,
                network_freq_id,
                None,
            ),
            (
                NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                network_freq_id,
                Some(login_id),
            ),
        ],
    )
    .await
    .c(h!())?;
    enqueue_cached_last_datetime_in_aor(db, [network_freq_id])
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn enqueue_last_seen_for_networks<I>(
    db: &DatabaseTransaction,
    network_ids: I,
) -> anyhow::Result<()>
where
    I: IntoIterator<Item = i64>,
{
    let network_ids = network_ids.into_iter().collect::<HashSet<_>>();
    if network_ids.is_empty() {
        return Ok(());
    }
    let network_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.is_in(network_ids))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock(LockType::NoKeyUpdate)
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    lock_network_freq_recalculations(db, &network_freq_ids)
        .await
        .c(h!())?;
    sigint_network_freq::Entity::update_many()
        .col_expr(
            sigint_network_freq::Column::LastSeenDt,
            Expr::value(Option::<NaiveDateTime>::None),
        )
        .filter(
            sigint_network_freq::Column::Id
                .is_in(network_freq_ids.iter().copied()),
        )
        .filter(sigint_network_freq::Column::LastSeenDt.is_not_null())
        .exec(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        network_freq_ids.into_iter().map(|network_freq_id| {
            (
                NetworkRecalculationTaskKind::NetworkFreqLastSeen,
                network_freq_id,
                None,
            )
        }),
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(super) async fn enqueue_last_datetime_in_aor_for_network(
    db: &DatabaseTransaction,
    network_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()> {
    let network_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    lock_network_freq_recalculations(db, &network_freq_ids)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        network_freq_ids.iter().map(|network_freq_id| {
            (
                NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                *network_freq_id,
                Some(login_id),
            )
        }),
    )
    .await
    .c(h!())?;
    enqueue_cached_last_datetime_in_aor(db, network_freq_ids)
        .await
        .c(h!())?;
    Ok(())
}

pub(crate) async fn enqueue_cached_last_datetime_in_aor<C, I>(
    db: &C,
    network_freq_ids: I,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
    I: IntoIterator<Item = i64>,
{
    let network_freq_ids = network_freq_ids.into_iter().collect::<HashSet<_>>();
    if network_freq_ids.is_empty() {
        return Ok(());
    }
    let mut affected_keys = network_freq_last_datetime_in_aor::Entity::find()
        .filter(
            network_freq_last_datetime_in_aor::Column::NetworkFreqId
                .is_in(network_freq_ids.iter().copied()),
        )
        .select_only()
        .columns([
            network_freq_last_datetime_in_aor::Column::NetworkFreqId,
            network_freq_last_datetime_in_aor::Column::LoginId,
        ]);
    let started_keys = network_recalculation_task::Entity::find()
        .filter(
            network_recalculation_task::Column::TaskKind
                .eq(NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor),
        )
        .filter(
            network_recalculation_task::Column::NetworkFreqId
                .is_in(network_freq_ids.iter().copied()),
        )
        .filter(network_recalculation_task::Column::StartedAt.is_not_null())
        .select_only()
        .columns([
            network_recalculation_task::Column::NetworkFreqId,
            network_recalculation_task::Column::LoginId,
        ]);
    QueryTrait::query(&mut affected_keys)
        .union(UnionType::Distinct, started_keys.into_query());
    let affected_keys = affected_keys
        .into_tuple::<(i64, Option<uuid::Uuid>)>()
        .all(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        affected_keys
            .into_iter()
            .map(|(network_freq_id, login_id)| {
                (
                    NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                    network_freq_id,
                    login_id,
                )
            }),
    )
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn enqueue_for_network_invalidations(
    db: &DatabaseConnection,
    tasks: &[network_invalidation_task::Model],
    processed_frequencies: &HashSet<String>,
) -> anyhow::Result<()> {
    if tasks.is_empty() {
        return Ok(());
    }
    let invalidation_frequencies =
        collect_invalidation_frequencies(db, tasks, processed_frequencies)
            .await
            .c(h!())?;
    let Some(condition) =
        invalidation_condition(tasks, &invalidation_frequencies)
    else {
        return Ok(());
    };
    enqueue_last_seen_for_invalidations(db, condition.clone())
        .await
        .c(h!())?;
    enqueue_queued_aor_cache_for_invalidations(db, condition.clone())
        .await
        .c(h!())?;
    enqueue_stored_aor_cache_for_invalidations(db, condition)
        .await
        .c(h!())?;
    Ok(())
}

async fn collect_invalidation_frequencies(
    db: &DatabaseConnection,
    tasks: &[network_invalidation_task::Model],
    processed_frequencies: &HashSet<String>,
) -> anyhow::Result<HashSet<String>> {
    let aor_ids = tasks
        .iter()
        .filter_map(|task| task.aor_id)
        .collect::<HashSet<_>>();
    let mut frequencies = processed_frequencies.clone();
    if aor_ids.is_empty() {
        return Ok(frequencies);
    }
    frequencies.extend(
        sigint_network_freq::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_network_freq::Relation::SigintNetwork.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_network::Relation::SigintNetworkAor.def(),
            )
            .filter(sigint_network_aor::Column::AorId.is_in(aor_ids))
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .select_only()
            .column(sigint_network_freq::Column::Freq)
            .distinct()
            .into_tuple::<String>()
            .all(db)
            .await
            .c(h!())?,
    );
    Ok(frequencies)
}

async fn enqueue_last_seen_for_invalidations(
    db: &DatabaseConnection,
    condition: Condition,
) -> anyhow::Result<()> {
    let network_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(condition)
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        network_freq_ids.into_iter().map(|network_freq_id| {
            (
                NetworkRecalculationTaskKind::NetworkFreqLastSeen,
                network_freq_id,
                None,
            )
        }),
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn enqueue_queued_aor_cache_for_invalidations(
    db: &DatabaseConnection,
    condition: Condition,
) -> anyhow::Result<()> {
    let queued_cache_keys = network_recalculation_task::Entity::find()
        .join(
            JoinType::InnerJoin,
            network_recalculation_task::Relation::SigintNetworkFreq.def(),
        )
        .filter(
            network_recalculation_task::Column::TaskKind
                .eq(NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor),
        )
        .filter(condition)
        .select_only()
        .columns([
            network_recalculation_task::Column::NetworkFreqId,
            network_recalculation_task::Column::LoginId,
        ])
        .into_tuple::<(i64, Option<uuid::Uuid>)>()
        .all(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        queued_cache_keys
            .into_iter()
            .map(|(network_freq_id, login_id)| {
                (
                    NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                    network_freq_id,
                    login_id,
                )
            }),
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn enqueue_stored_aor_cache_for_invalidations(
    db: &DatabaseConnection,
    condition: Condition,
) -> anyhow::Result<()> {
    let cached_keys = network_freq_last_datetime_in_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            network_freq_last_datetime_in_aor::Relation::SigintNetworkFreq
                .def(),
        )
        .filter(condition)
        .select_only()
        .columns([
            network_freq_last_datetime_in_aor::Column::NetworkFreqId,
            network_freq_last_datetime_in_aor::Column::LoginId,
        ])
        .into_tuple::<(i64, uuid::Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    enqueue_tasks(
        db,
        cached_keys.into_iter().map(|(network_freq_id, login_id)| {
            (
                NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                network_freq_id,
                Some(login_id),
            )
        }),
    )
    .await
    .c(h!())?;
    Ok(())
}

fn invalidation_condition(
    tasks: &[network_invalidation_task::Model],
    processed_frequencies: &HashSet<String>,
) -> Option<Condition> {
    let mut condition = Condition::any();
    let mut has_condition = false;
    let mut needs_processed_frequencies = false;
    for task in tasks {
        let mut task_condition = Condition::all();
        let mut is_scoped = false;
        if let Some(network_id) = task.sigint_network_id {
            task_condition = task_condition
                .add(sigint_network_freq::Column::NetworkId.eq(network_id));
            is_scoped = true;
        }
        if let Some(frequency) = &task.frequency {
            task_condition = task_condition
                .add(sigint_network_freq::Column::Freq.eq(frequency));
            is_scoped = true;
        }
        if is_scoped {
            condition = condition.add(task_condition);
            has_condition = true;
        } else {
            needs_processed_frequencies = true;
        }
    }
    if needs_processed_frequencies && !processed_frequencies.is_empty() {
        condition = condition.add(
            sigint_network_freq::Column::Freq
                .is_in(processed_frequencies.iter().cloned()),
        );
        has_condition = true;
    }
    has_condition.then_some(condition)
}

async fn enqueue_task<C>(
    db: &C,
    task_kind: NetworkRecalculationTaskKind,
    network_freq_id: i64,
    login_id: Option<uuid::Uuid>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    enqueue_tasks(db, [(task_kind, network_freq_id, login_id)])
        .await
        .c(h!())?;
    Ok(())
}

async fn enqueue_tasks<C, I>(db: &C, tasks: I) -> anyhow::Result<()>
where
    C: ConnectionTrait,
    I: IntoIterator<
        Item = (NetworkRecalculationTaskKind, i64, Option<uuid::Uuid>),
    >,
{
    let tasks = tasks.into_iter().collect::<Vec<_>>();
    for tasks in tasks.chunks(NETWORK_RECALCULATION_TASK_ENQUEUE_CHUNK_SIZE) {
        network_recalculation_task::Entity::insert_many(tasks.iter().map(
            |(task_kind, network_freq_id, login_id)| {
                network_recalculation_task::ActiveModel {
                    id: NotSet,
                    task_kind: Set(task_kind.clone()),
                    network_freq_id: Set(*network_freq_id),
                    login_id: Set(*login_id),
                    started_at: Set(None),
                    created_at: NotSet,
                }
            },
        ))
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(db)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn run_once(db: &DatabaseConnection) -> anyhow::Result<bool> {
    let Some(task) = claim_task(db).await.c(h!())? else {
        return Ok(false);
    };
    info!(
        "recalculating network frequency task id={} kind={:?} network_freq_id={} login_id={:?}",
        task.id, task.task_kind, task.network_freq_id, task.login_id
    );
    if let Err(error) = calculate_task(db, &task).await {
        requeue_failed_task(db, &task).await.c(h!())?;
        return Err(error);
    }
    Ok(true)
}

pub(super) async fn run_pending(db: &DatabaseConnection) -> anyhow::Result<()> {
    let started_at = std::time::Instant::now();
    for _ in 0..NETWORK_RECALCULATION_TASKS_PER_RUN {
        if started_at.elapsed()
            >= std::time::Duration::from_secs(
                NETWORK_RECALCULATION_RUN_BUDGET_SECS,
            )
        {
            break;
        }
        if !run_once(db).await.c(h!())? {
            break;
        }
    }
    Ok(())
}

async fn claim_task(
    db: &DatabaseConnection,
) -> anyhow::Result<Option<network_recalculation_task::Model>> {
    let now = Utc::now().naive_utc();
    let stale_before =
        now - Duration::minutes(NETWORK_RECALCULATION_TASK_STALE_MINUTES);
    let sql = r#"
        with candidate as (
            select id
            from network_recalculation_task
            where started_at is null or started_at < $1
            order by created_at, id
            for update skip locked
            limit 1
        )
        update network_recalculation_task as task
        set started_at = $2
        from candidate
        where task.id = candidate.id
        returning task.*
    "#;
    network_recalculation_task::Model::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![stale_before.into(), now.into()],
        ),
    )
    .one(db)
    .await
    .c(h!())
}

async fn calculate_task(
    db: &DatabaseConnection,
    task: &network_recalculation_task::Model,
) -> anyhow::Result<()> {
    let txn = db.begin().await.c(h!())?;
    txn.execute_unprepared(&format!(
        "set local statement_timeout = {NETWORK_RECALCULATION_STATEMENT_TIMEOUT_MS}"
    ))
    .await
    .c(h!())?;
    if !lock_network_freq_recalculation_target(&txn, task.network_freq_id)
        .await
        .c(h!())?
    {
        delete_claimed_task(&txn, task.id).await.c(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(());
    }
    match task.task_kind {
        NetworkRecalculationTaskKind::NetworkFreqLastSeen => {
            recalculate_last_seen(&txn, task.network_freq_id)
                .await
                .c(h!())?;
        }
        NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor => {
            let login_id = task.login_id.c(h!())?;
            recalculate_last_datetime_in_aor(
                &txn,
                task.network_freq_id,
                login_id,
            )
            .await
            .c(h!())?;
        }
    }
    delete_claimed_task(&txn, task.id).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn lock_network_freq_recalculation<C>(
    db: &C,
    network_freq_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended('network_recalculation:' || $1::text, 0))",
        vec![network_freq_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn lock_network_freq_recalculation_target(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
) -> anyhow::Result<bool> {
    let exists = sigint_network_freq::Entity::find_by_id(network_freq_id)
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .lock(LockType::NoKeyUpdate)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    if exists {
        lock_network_freq_recalculation(txn, network_freq_id)
            .await
            .c(h!())?;
    }
    Ok(exists)
}

async fn lock_network_freq_recalculations<C>(
    db: &C,
    network_freq_ids: &[i64],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let mut network_freq_ids = network_freq_ids.to_vec();
    network_freq_ids.sort_unstable();
    network_freq_ids.dedup();
    for network_freq_id in network_freq_ids {
        lock_network_freq_recalculation(db, network_freq_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn recalculate_last_seen(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
) -> anyhow::Result<()> {
    let sql = r#"
        update sigint_network_freq as nf
        set last_seen_dt = (
            select max(coalesce(ii.datetime, sm.timestamp, sm.created_at))
            from sigint_inbox_item_network iin
            join sigint_inbox_item ii on ii.id = iin.sigint_inbox_item_id
            join signal_message sm on sm.id = ii.id
            join sigint_network network
                on network.id = iin.sigint_network_id
            where iin.sigint_network_id = nf.network_id
              and ii.freq = nf.freq
              and sm.deleted = false
              and network.deleted = false
              and coalesce(ii.datetime, sm.timestamp, sm.created_at) >= nf.active_from
              and coalesce(ii.datetime, sm.timestamp, sm.created_at)
                    <= coalesce(nf.active_to, current_timestamp at time zone 'utc')
              and coalesce(ii.datetime, sm.timestamp, sm.created_at)
                    >= coalesce(network.active_from, '-infinity'::timestamp)
              and coalesce(ii.datetime, sm.timestamp, sm.created_at)
                    <= coalesce(network.active_to, current_timestamp at time zone 'utc')
        )
        where nf.id = $1
          and nf.deleted = false
    "#;
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        vec![network_freq_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[derive(Debug, FromQueryResult)]
struct LastDatetimeInAorRow {
    last_datetime_in_aor: Option<PrimitiveDateTime>,
}

async fn recalculate_last_datetime_in_aor(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()> {
    let network_freq = sigint_network_freq::Entity::find_by_id(network_freq_id)
        .select_only()
        .columns([
            sigint_network_freq::Column::NetworkId,
            sigint_network_freq::Column::Deleted,
        ])
        .into_tuple::<(i64, bool)>()
        .one(txn)
        .await
        .c(h!())?;
    let Some((network_id, network_freq_deleted)) = network_freq else {
        return Ok(());
    };
    if network_freq_deleted {
        delete_cached_last_datetime_in_aor(txn, network_freq_id, login_id)
            .await
            .c(h!())?;
        return Ok(());
    }
    let login_exists = login::Entity::find_by_id(login_id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .select_only()
        .column(login::Column::Id)
        .into_tuple::<uuid::Uuid>()
        .one(txn)
        .await
        .c(h!())?
        .is_some();
    if !login_exists {
        delete_cached_last_datetime_in_aor(txn, network_freq_id, login_id)
            .await
            .c(h!())?;
        return Ok(());
    }
    let groups =
        crate::messenger::group::get_identity_sigint_groups(txn, &login_id)
            .await
            .c(h!())?;
    let group_master_keys = normalize_group_master_keys(groups);
    let aor_ids = sigint_network_aor::Entity::find()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id))
        .select_only()
        .column(sigint_network_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    let last_datetime_in_aor =
        if group_master_keys.is_empty() || aor_ids.is_empty() {
            None
        } else {
            calculate_last_datetime_in_aor(
                txn,
                network_freq_id,
                aor_ids,
                group_master_keys.clone(),
            )
            .await
            .c(h!())?
        };
    network_freq_last_datetime_in_aor::Entity::insert(
        network_freq_last_datetime_in_aor::ActiveModel {
            network_freq_id: Set(network_freq_id),
            login_id: Set(login_id),
            group_master_keys: Set(group_master_keys),
            last_datetime_in_aor: Set(last_datetime_in_aor),
            calculated_at: Set(Utc::now().naive_utc()),
        },
    )
    .on_conflict(
        OnConflict::columns([
            network_freq_last_datetime_in_aor::Column::NetworkFreqId,
            network_freq_last_datetime_in_aor::Column::LoginId,
        ])
        .update_columns([
            network_freq_last_datetime_in_aor::Column::GroupMasterKeys,
            network_freq_last_datetime_in_aor::Column::LastDatetimeInAor,
            network_freq_last_datetime_in_aor::Column::CalculatedAt,
        ])
        .to_owned(),
    )
    .exec(txn)
    .await
    .c(h!())?;
    Ok(())
}

fn normalize_group_master_keys(
    mut group_master_keys: Vec<String>,
) -> Vec<String> {
    group_master_keys.sort_unstable();
    group_master_keys.dedup();
    group_master_keys
}

async fn delete_cached_last_datetime_in_aor(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()> {
    network_freq_last_datetime_in_aor::Entity::delete_by_id((
        network_freq_id,
        login_id,
    ))
    .exec(txn)
    .await
    .c(h!())?;
    Ok(())
}

async fn calculate_last_datetime_in_aor(
    txn: &DatabaseTransaction,
    network_freq_id: i64,
    aor_ids: Vec<i64>,
    groups: Vec<String>,
) -> anyhow::Result<Option<NaiveDateTime>> {
    let sql = r#"
        select max(ii.datetime) as last_datetime_in_aor
        from sigint_network_freq nf
        join sigint_inbox_item_network iin
            on iin.sigint_network_id = nf.network_id
        join sigint_inbox_item ii
            on ii.id = iin.sigint_inbox_item_id
           and ii.freq = nf.freq
        join signal_message sm on sm.id = ii.id
        join datasource_group dg on dg.id = sm.datasource_group_id
        where nf.id = $1
          and nf.deleted = false
          and sm.deleted = false
          and ii.datetime is not null
          and dg.group_master_key = any($3)
          and coalesce(ii.datetime, sm.timestamp, sm.created_at) >= nf.active_from
          and coalesce(ii.datetime, sm.timestamp, sm.created_at)
                <= coalesce(nf.active_to, current_timestamp at time zone 'utc')
          and exists (
              select 1
              from signal_message_group smg
              join signal_group_aor sga
                  on sga.master_key = smg.group_master_key
              join area_of_responsibility linked_aor
                  on linked_aor.id = sga.aor_id
              join area_of_responsibility selected_aor
                  on selected_aor.id = any($2)
              where smg.signal_message_id = sm.id
                and linked_aor.deleted = false
                and selected_aor.deleted = false
                and (
                    linked_aor.left_bound between selected_aor.left_bound and selected_aor.right_bound
                    or (
                        linked_aor.left_bound <= selected_aor.left_bound
                        and linked_aor.right_bound >= selected_aor.right_bound
                    )
                )
          )
    "#;
    let row = LastDatetimeInAorRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            vec![network_freq_id.into(), aor_ids.into(), groups.into()],
        ),
    )
    .one(txn)
    .await
    .c(h!())?
    .c(h!())?;
    row.last_datetime_in_aor
        .map(primitive_to_naive_datetime)
        .transpose()
        .map_err(Into::into)
}

async fn delete_claimed_task(
    txn: &DatabaseTransaction,
    task_id: i64,
) -> anyhow::Result<()> {
    network_recalculation_task::Entity::delete_by_id(task_id)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

async fn requeue_failed_task(
    db: &DatabaseConnection,
    task: &network_recalculation_task::Model,
) -> anyhow::Result<()> {
    let txn = db.begin().await.c(h!())?;
    enqueue_task(
        &txn,
        task.task_kind.clone(),
        task.network_freq_id,
        task.login_id,
    )
    .await
    .c(h!())?;
    network_recalculation_task::Entity::delete_by_id(task.id)
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        datasource_group, sigint_inbox_item, sigint_network, signal_group,
        signal_message, signal_message_group,
    };
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_sigint_network,
        mk_sigint_network_freq, mk_signal_group, mk_signal_message,
        mk_signal_message_group,
    };
    use serial_test::serial;

    fn invalidation_task(
        id: i64,
        network_id: i64,
        frequency: &str,
    ) -> network_invalidation_task::Model {
        let now = Utc::now().naive_utc();
        network_invalidation_task::Model {
            id,
            frequency: Some(frequency.to_string()),
            since_ts: now,
            till_ts: now,
            completed_at: None,
            created_at: now,
            sigint_network_id: Some(network_id),
            started_at: Some(now),
            aor_id: None,
            group_master_key: None,
            tag: "network-recalculation-test".to_string(),
        }
    }

    struct InvalidationFixture {
        first_network: sigint_network::Model,
        second_network: sigint_network::Model,
        network_freqs: Vec<sigint_network_freq::Model>,
    }

    async fn setup_invalidation_fixture(
        db: &DatabaseConnection,
        login_id: uuid::Uuid,
    ) -> InvalidationFixture {
        let first_network = mk_sigint_network(
            db,
            sigint_network::ActiveModel {
                name: Set("First reconciliation network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_network = mk_sigint_network(
            db,
            sigint_network::ActiveModel {
                name: Set("Second reconciliation network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut network_freqs = Vec::new();
        for (network_id, frequency) in [
            (first_network.id, "148.1000"),
            (first_network.id, "149.1000"),
            (second_network.id, "148.1000"),
            (second_network.id, "149.1000"),
            (first_network.id, "150.1000"),
        ] {
            network_freqs.push(
                mk_sigint_network_freq(
                    db,
                    sigint_network_freq::ActiveModel {
                        network_id: Set(network_id),
                        freq: Set(frequency.to_string()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            );
        }
        network_freq_last_datetime_in_aor::Entity::insert_many(
            network_freqs.iter().skip(1).map(|network_freq| {
                network_freq_last_datetime_in_aor::ActiveModel {
                    network_freq_id: Set(network_freq.id),
                    login_id: Set(login_id),
                    group_master_keys: Set(Vec::new()),
                    last_datetime_in_aor: Set(None),
                    calculated_at: Set(Utc::now().naive_utc()),
                }
            }),
        )
        .exec_without_returning(db)
        .await
        .unwrap();
        network_recalculation_task::ActiveModel {
            id: NotSet,
            task_kind: Set(
                NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            ),
            network_freq_id: Set(network_freqs[0].id),
            login_id: Set(Some(login_id)),
            started_at: Set(Some(Utc::now().naive_utc())),
            created_at: NotSet,
        }
        .insert(db)
        .await
        .unwrap();
        InvalidationFixture {
            first_network,
            second_network,
            network_freqs,
        }
    }

    async fn assert_compound_invalidation_scope(
        db: &DatabaseConnection,
        fixture: &InvalidationFixture,
    ) {
        enqueue_for_network_invalidations(
            db,
            &[
                invalidation_task(1, fixture.first_network.id, "148.1000"),
                invalidation_task(2, fixture.second_network.id, "149.1000"),
            ],
            &HashSet::new(),
        )
        .await
        .unwrap();

        let tasks = network_recalculation_task::Entity::find()
            .all(db)
            .await
            .unwrap();
        let expected_ids = HashSet::from([
            fixture.network_freqs[0].id,
            fixture.network_freqs[3].id,
        ]);
        for task_kind in [
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
        ] {
            assert_eq!(
                tasks
                    .iter()
                    .filter(|task| task.task_kind == task_kind)
                    .map(|task| task.network_freq_id)
                    .collect::<HashSet<_>>(),
                expected_ids
            );
        }
        assert_eq!(
            tasks
                .iter()
                .filter(|task| {
                    task.task_kind
                        == NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor
                        && task.network_freq_id == fixture.network_freqs[0].id
                })
                .count(),
            2
        );
        assert_eq!(tasks.len(), 5);
    }

    async fn assert_broad_invalidation_scope(
        db: &DatabaseConnection,
        fixture: &InvalidationFixture,
    ) {
        network_recalculation_task::Entity::delete_many()
            .exec(db)
            .await
            .unwrap();
        let mut group_invalidation =
            invalidation_task(3, fixture.first_network.id, "unused");
        group_invalidation.sigint_network_id = None;
        group_invalidation.frequency = None;
        group_invalidation.group_master_key =
            Some("affected-group".to_string());
        enqueue_for_network_invalidations(
            db,
            &[group_invalidation],
            &HashSet::from(["149.1000".to_string()]),
        )
        .await
        .unwrap();
        let tasks = network_recalculation_task::Entity::find()
            .all(db)
            .await
            .unwrap();
        let expected_ids = HashSet::from([
            fixture.network_freqs[1].id,
            fixture.network_freqs[3].id,
        ]);
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.network_freq_id)
                .collect::<HashSet<_>>(),
            expected_ids
        );
        assert_eq!(tasks.len(), 4);
    }

    async fn assert_aor_invalidation_scope(
        db: &DatabaseConnection,
        fixture: &InvalidationFixture,
    ) {
        network_recalculation_task::Entity::delete_many()
            .exec(db)
            .await
            .unwrap();
        let aor_id = crate::entities::area_of_responsibility::Entity::find()
            .select_only()
            .column(crate::entities::area_of_responsibility::Column::Id)
            .into_tuple::<i64>()
            .one(db)
            .await
            .unwrap()
            .unwrap();
        crate::functest::tests::mk_sigint_network_aor(
            db,
            sigint_network_aor::ActiveModel {
                network_id: Set(fixture.first_network.id),
                aor_id: Set(aor_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut aor_invalidation =
            invalidation_task(4, fixture.first_network.id, "unused");
        aor_invalidation.sigint_network_id = None;
        aor_invalidation.frequency = None;
        aor_invalidation.aor_id = Some(aor_id);
        enqueue_for_network_invalidations(
            db,
            &[aor_invalidation],
            &HashSet::new(),
        )
        .await
        .unwrap();

        for task_kind in [
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
        ] {
            assert!(network_recalculation_task::Entity::find()
                .filter(
                    network_recalculation_task::Column::NetworkFreqId
                        .eq(fixture.network_freqs[4].id),
                )
                .filter(
                    network_recalculation_task::Column::TaskKind.eq(task_kind),
                )
                .one(db)
                .await
                .unwrap()
                .is_some());
        }
    }

    #[tokio::test]
    #[serial]
    async fn invalidation_reconciliation_preserves_compound_scopes() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let fixture = setup_invalidation_fixture(&env.dbx, login_id).await;

        // Regression: https://github.com/echoua/echo/issues/3440
        assert_compound_invalidation_scope(&env.dbx, &fixture).await;
        assert_broad_invalidation_scope(&env.dbx, &fixture).await;
        assert_aor_invalidation_scope(&env.dbx, &fixture).await;
    }

    struct QueueFixture {
        login_id: uuid::Uuid,
        network: sigint_network::Model,
        network_freq: sigint_network_freq::Model,
    }

    async fn setup_queue_fixture(db: &DatabaseConnection) -> QueueFixture {
        let login_id =
            crate::users::login_id_by_name(db, "Tester").await.unwrap();
        let network = mk_sigint_network(
            db,
            sigint_network::ActiveModel {
                name: Set("Network recalculation queue".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_freq = mk_sigint_network_freq(
            db,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("148.1950".to_string()),
                last_seen_dt: Set(Some(
                    Utc::now().naive_utc() - Duration::days(1),
                )),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        QueueFixture {
            login_id,
            network,
            network_freq,
        }
    }

    #[tokio::test]
    #[serial]
    async fn network_state_change_clears_last_seen_before_queued_refresh() {
        // Regression: https://github.com/echoua/echo/issues/3440
        let env = cleanup().await.unwrap();
        let fixture = setup_queue_fixture(&env.dbx).await;
        let txn = env.dbx.begin().await.unwrap();

        enqueue_last_seen_for_networks(&txn, [fixture.network.id])
            .await
            .unwrap();

        assert_eq!(
            sigint_network_freq::Entity::find_by_id(fixture.network_freq.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .last_seen_dt,
            None
        );
        assert_eq!(
            network_recalculation_task::Entity::find()
                .filter(
                    network_recalculation_task::Column::TaskKind
                        .eq(NetworkRecalculationTaskKind::NetworkFreqLastSeen),
                )
                .filter(
                    network_recalculation_task::Column::NetworkFreqId
                        .eq(fixture.network_freq.id),
                )
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        txn.commit().await.unwrap();
    }

    async fn start_deduplicated_task(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
    ) -> network_recalculation_task::Model {
        let kind = NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor;
        enqueue_task(
            db,
            kind.clone(),
            fixture.network_freq.id,
            Some(fixture.login_id),
        )
        .await
        .unwrap();
        enqueue_task(db, kind, fixture.network_freq.id, Some(fixture.login_id))
            .await
            .unwrap();
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(db)
                .await
                .unwrap(),
            1
        );
        let task = network_recalculation_task::Entity::find()
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let mut task = task.into_active_model();
        task.started_at = Set(Some(Utc::now().naive_utc()));
        task.update(db).await.unwrap()
    }

    async fn complete_granular_tasks(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
        started_task: &network_recalculation_task::Model,
    ) -> Vec<String> {
        enqueue_cached_last_datetime_in_aor(db, [fixture.network_freq.id])
            .await
            .unwrap();
        enqueue_cached_last_datetime_in_aor(db, [fixture.network_freq.id])
            .await
            .unwrap();
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
            fixture.network_freq.id,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(db)
                .await
                .unwrap(),
            3
        );

        calculate_task(db, started_task).await.unwrap();
        let remaining = network_recalculation_task::Entity::find()
            .all(db)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 2);
        for task_kind in [
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
        ] {
            assert!(remaining.iter().any(|task| task.task_kind == task_kind));
        }
        assert!(run_once(db).await.unwrap());
        assert!(run_once(db).await.unwrap());
        assert_eq!(
            sigint_network_freq::Entity::find_by_id(fixture.network_freq.id)
                .one(db)
                .await
                .unwrap()
                .unwrap()
                .last_seen_dt,
            None
        );
        let cached = network_freq_last_datetime_in_aor::Entity::find_by_id((
            fixture.network_freq.id,
            fixture.login_id,
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(cached.last_datetime_in_aor, None);
        cached.group_master_keys
    }

    async fn assert_cache_refresh_rules(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
        group_master_keys: &[String],
    ) {
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            fixture.network_freq.id,
            Some(fixture.login_id),
        )
        .await
        .unwrap();
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(run_once(db).await.unwrap());

        let cached = network_freq_last_datetime_in_aor::Entity::find_by_id((
            fixture.network_freq.id,
            fixture.login_id,
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
        let mut cached = cached.into_active_model();
        cached.group_master_keys = Set(vec!["stale-scope".to_string()]);
        cached.update(db).await.unwrap();
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(run_once(db).await.unwrap());
    }

    async fn assert_expired_cache_is_evicted(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
        group_master_keys: &[String],
    ) {
        let cached = network_freq_last_datetime_in_aor::Entity::find_by_id((
            fixture.network_freq.id,
            fixture.login_id,
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
        let mut cached = cached.into_active_model();
        cached.calculated_at = Set(Utc::now().naive_utc()
            - Duration::minutes(
                NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES + 1,
            ));
        cached.update(db).await.unwrap();
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(evict_expired_cache(db).await.unwrap(), 1);
        assert!(network_freq_last_datetime_in_aor::Entity::find_by_id((
            fixture.network_freq.id,
            fixture.login_id,
        ))
        .one(db)
        .await
        .unwrap()
        .is_none());
    }

    async fn assert_invalidation_handoff_suppresses_cache(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
        group_master_keys: &[String],
    ) {
        let invalidation = invalidation_task(
            1_000,
            fixture.network.id,
            &fixture.network_freq.freq,
        )
        .into_active_model()
        .insert(db)
        .await
        .unwrap();
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(run_once(db).await.unwrap());

        let mut invalidation = invalidation.into_active_model();
        invalidation.completed_at = Set(Some(Utc::now().naive_utc()));
        invalidation.update(db).await.unwrap();
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .contains_key(&fixture.network_freq.id));
    }

    async fn assert_secondary_group_invalidation_suppresses_cache(
        db: &DatabaseConnection,
        fixture: &QueueFixture,
        group_master_keys: &[String],
    ) {
        let visible_group_master_key = group_master_keys.first().unwrap();
        let datasource_group = datasource_group::Entity::find()
            .filter(
                datasource_group::Column::GroupMasterKey
                    .eq(visible_group_master_key),
            )
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let secondary_group = mk_signal_group(
            db,
            signal_group::ActiveModel {
                master_key: Set("secondary-cache-invalidation".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let message = mk_signal_message(
            db,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datetime = Utc::now().naive_utc();
        mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(fixture.network_freq.freq.clone())),
                datetime: Set(Some(datetime)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            db,
            signal_message_group::ActiveModel {
                signal_message_id: Set(message.id),
                group_master_key: Set(Some(secondary_group.master_key.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let mut invalidation = invalidation_task(
            1_001,
            fixture.network.id,
            &fixture.network_freq.freq,
        );
        invalidation.sigint_network_id = None;
        invalidation.frequency = None;
        invalidation.group_master_key = Some(secondary_group.master_key);
        invalidation.since_ts = datetime - Duration::seconds(1);
        invalidation.till_ts = datetime + Duration::seconds(1);
        let invalidation =
            invalidation.into_active_model().insert(db).await.unwrap();

        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .is_empty());

        invalidation.delete(db).await.unwrap();
        assert!(run_once(db).await.unwrap());
        assert!(load_cached_last_datetime_in_aor(
            db,
            fixture.network.id,
            fixture.login_id,
            group_master_keys,
        )
        .await
        .unwrap()
        .contains_key(&fixture.network_freq.id));
    }

    async fn assert_deleted_frequency_cache_is_removed(
        db: &DatabaseConnection,
        fixture: QueueFixture,
        group_master_keys: Vec<String>,
    ) {
        network_freq_last_datetime_in_aor::ActiveModel {
            network_freq_id: Set(fixture.network_freq.id),
            login_id: Set(fixture.login_id),
            group_master_keys: Set(group_master_keys),
            last_datetime_in_aor: Set(None),
            calculated_at: Set(Utc::now().naive_utc()),
        }
        .insert(db)
        .await
        .unwrap();
        let network_freq_id = fixture.network_freq.id;
        let mut network_freq = fixture.network_freq.into_active_model();
        network_freq.deleted = Set(true);
        network_freq.update(db).await.unwrap();
        assert_eq!(evict_expired_cache(db).await.unwrap(), 1);
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            network_freq_id,
            Some(fixture.login_id),
        )
        .await
        .unwrap();
        assert!(run_once(db).await.unwrap());
        assert!(network_freq_last_datetime_in_aor::Entity::find_by_id((
            network_freq_id,
            fixture.login_id,
        ))
        .one(db)
        .await
        .unwrap()
        .is_none());
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(db)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial]
    async fn pending_tasks_are_deduplicated_and_completion_is_granular() {
        let env = cleanup().await.unwrap();
        let fixture = setup_queue_fixture(&env.dbx).await;
        let started_task = start_deduplicated_task(&env.dbx, &fixture).await;
        let group_master_keys =
            complete_granular_tasks(&env.dbx, &fixture, &started_task).await;

        // Regression: https://github.com/echoua/echo/issues/3440
        assert_cache_refresh_rules(&env.dbx, &fixture, &group_master_keys)
            .await;

        assert_invalidation_handoff_suppresses_cache(
            &env.dbx,
            &fixture,
            &group_master_keys,
        )
        .await;
        assert_secondary_group_invalidation_suppresses_cache(
            &env.dbx,
            &fixture,
            &group_master_keys,
        )
        .await;

        assert_expired_cache_is_evicted(&env.dbx, &fixture, &group_master_keys)
            .await;
        assert_deleted_frequency_cache_is_removed(
            &env.dbx,
            fixture,
            group_master_keys,
        )
        .await;
    }
}
