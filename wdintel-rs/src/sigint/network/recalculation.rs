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
    network_recalculation_task, sigint_network_aor, sigint_network_freq,
};
use crate::error::AppError;
use crate::h;
use crate::types::{info, ShortContext};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use time::PrimitiveDateTime;

pub(super) async fn load_cached_last_datetime_in_aor(
    db: &DatabaseConnection,
    network_id: i64,
    login_id: uuid::Uuid,
) -> Result<HashMap<i64, Option<i64>>, AppError> {
    let cached = network_freq_last_datetime_in_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            network_freq_last_datetime_in_aor::Relation::SigintNetworkFreq
                .def(),
        )
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(network_freq_last_datetime_in_aor::Column::LoginId.eq(login_id))
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
                    .map(|row| row.calculated_at < stale_before)
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
        .filter(|row| row.calculated_at >= stale_before)
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

pub(super) async fn enqueue_all_for_network_freq<C>(
    db: &C,
    network_freq_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
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

pub(super) async fn enqueue_last_seen_for_networks<C, I>(
    db: &C,
    network_ids: I,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
    I: IntoIterator<Item = i64>,
{
    let network_ids = network_ids.into_iter().collect::<HashSet<_>>();
    if network_ids.is_empty() {
        return Ok(());
    }
    let network_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.is_in(network_ids))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
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

pub(super) async fn enqueue_last_datetime_in_aor_for_network<C>(
    db: &C,
    network_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
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
    let cached_keys = network_freq_last_datetime_in_aor::Entity::find()
        .filter(
            network_freq_last_datetime_in_aor::Column::NetworkFreqId
                .is_in(network_freq_ids.iter().copied()),
        )
        .select_only()
        .columns([
            network_freq_last_datetime_in_aor::Column::NetworkFreqId,
            network_freq_last_datetime_in_aor::Column::LoginId,
        ])
        .into_tuple::<(i64, uuid::Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    let started_keys = network_recalculation_task::Entity::find()
        .filter(
            network_recalculation_task::Column::TaskKind
                .eq(NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor),
        )
        .filter(
            network_recalculation_task::Column::NetworkFreqId
                .is_in(network_freq_ids),
        )
        .filter(network_recalculation_task::Column::StartedAt.is_not_null())
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
        cached_keys
            .into_iter()
            .map(|(network_freq_id, login_id)| {
                (
                    NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                    network_freq_id,
                    Some(login_id),
                )
            })
            .chain(started_keys.into_iter().map(
                |(network_freq_id, login_id)| {
                    (
                        NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                        network_freq_id,
                        login_id,
                    )
                },
            )),
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
    let Some(condition) = invalidation_condition(tasks, processed_frequencies)
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
    txn.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended('network_recalculation:' || $1::text, 0))",
        vec![task.network_freq_id.into()],
    ))
    .await
    .c(h!())?;
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
    let aor_ids = sigint_network_aor::Entity::find()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id))
        .select_only()
        .column(sigint_network_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    let last_datetime_in_aor = if groups.is_empty() || aor_ids.is_empty() {
        None
    } else {
        calculate_last_datetime_in_aor(txn, network_freq_id, aor_ids, groups)
            .await
            .c(h!())?
    };
    network_freq_last_datetime_in_aor::Entity::insert(
        network_freq_last_datetime_in_aor::ActiveModel {
            network_freq_id: Set(network_freq_id),
            login_id: Set(login_id),
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
    use crate::entities::sigint_network;
    use crate::functest::tests::{
        cleanup, mk_sigint_network, mk_sigint_network_freq,
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

    #[tokio::test]
    #[serial]
    async fn invalidation_reconciliation_preserves_compound_scopes() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let first_network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("First reconciliation network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_network = mk_sigint_network(
            &env.dbx,
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
        ] {
            network_freqs.push(
                mk_sigint_network_freq(
                    &env.dbx,
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
                    last_datetime_in_aor: Set(None),
                    calculated_at: Set(Utc::now().naive_utc()),
                }
            }),
        )
        .exec_without_returning(&env.dbx)
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
        .insert(&env.dbx)
        .await
        .unwrap();

        enqueue_for_network_invalidations(
            &env.dbx,
            &[
                invalidation_task(1, first_network.id, "148.1000"),
                invalidation_task(2, second_network.id, "149.1000"),
            ],
            &HashSet::new(),
        )
        .await
        .unwrap();

        let tasks = network_recalculation_task::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        let expected_ids =
            HashSet::from([network_freqs[0].id, network_freqs[3].id]);
        let last_seen_ids = tasks
            .iter()
            .filter(|task| {
                task.task_kind
                    == NetworkRecalculationTaskKind::NetworkFreqLastSeen
            })
            .map(|task| task.network_freq_id)
            .collect::<HashSet<_>>();
        let cached_aor_ids = tasks
            .iter()
            .filter(|task| {
                task.task_kind
                    == NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor
            })
            .map(|task| task.network_freq_id)
            .collect::<HashSet<_>>();
        assert_eq!(last_seen_ids, expected_ids);
        assert_eq!(cached_aor_ids, expected_ids);
        assert_eq!(
            tasks
                .iter()
                .filter(|task| {
                    task.task_kind
                        == NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor
                        && task.network_freq_id == network_freqs[0].id
                })
                .count(),
            2
        );
        assert_eq!(tasks.len(), 5);

        network_recalculation_task::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let mut group_invalidation =
            invalidation_task(3, first_network.id, "unused");
        group_invalidation.sigint_network_id = None;
        group_invalidation.frequency = None;
        group_invalidation.group_master_key =
            Some("affected-group".to_string());
        enqueue_for_network_invalidations(
            &env.dbx,
            &[group_invalidation],
            &HashSet::from(["149.1000".to_string()]),
        )
        .await
        .unwrap();
        let tasks = network_recalculation_task::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        let expected_ids =
            HashSet::from([network_freqs[1].id, network_freqs[3].id]);
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.network_freq_id)
                .collect::<HashSet<_>>(),
            expected_ids
        );
        assert_eq!(tasks.len(), 4);
    }

    #[tokio::test]
    #[serial]
    async fn pending_tasks_are_deduplicated_and_completion_is_granular() {
        let env = cleanup().await.unwrap();
        let login_id = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Network recalculation queue".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("148.1950".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let kind = NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor;

        enqueue_task(&env.dbx, kind.clone(), network_freq.id, Some(login_id))
            .await
            .unwrap();
        enqueue_task(&env.dbx, kind.clone(), network_freq.id, Some(login_id))
            .await
            .unwrap();
        let started_task = network_recalculation_task::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );

        let mut started_task = started_task.into_active_model();
        started_task.started_at = Set(Some(Utc::now().naive_utc()));
        let started_task = started_task.update(&env.dbx).await.unwrap();
        enqueue_cached_last_datetime_in_aor(&env.dbx, [network_freq.id])
            .await
            .unwrap();
        enqueue_cached_last_datetime_in_aor(&env.dbx, [network_freq.id])
            .await
            .unwrap();
        enqueue_task(
            &env.dbx,
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
            network_freq.id,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            3
        );

        calculate_task(&env.dbx, &started_task).await.unwrap();
        let remaining = network_recalculation_task::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|task| {
            task.task_kind
                == NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor
        }));
        assert!(remaining.iter().any(|task| {
            task.task_kind == NetworkRecalculationTaskKind::NetworkFreqLastSeen
        }));

        assert!(run_once(&env.dbx).await.unwrap());
        assert!(run_once(&env.dbx).await.unwrap());
        let cached = network_freq_last_datetime_in_aor::Entity::find_by_id((
            network_freq.id,
            login_id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(cached.last_datetime_in_aor, None);
        let mut cached = cached.into_active_model();
        cached.calculated_at = Set(Utc::now().naive_utc()
            - Duration::minutes(
                NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES + 1,
            ));
        cached.update(&env.dbx).await.unwrap();
        assert!(load_cached_last_datetime_in_aor(
            &env.dbx, network.id, login_id,
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(evict_expired_cache(&env.dbx).await.unwrap(), 1);
        assert!(network_freq_last_datetime_in_aor::Entity::find_by_id((
            network_freq.id,
            login_id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());

        network_freq_last_datetime_in_aor::ActiveModel {
            network_freq_id: Set(network_freq.id),
            login_id: Set(login_id),
            last_datetime_in_aor: Set(None),
            calculated_at: Set(Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let network_freq_id = network_freq.id;
        let mut network_freq = network_freq.into_active_model();
        network_freq.deleted = Set(true);
        network_freq.update(&env.dbx).await.unwrap();
        assert_eq!(evict_expired_cache(&env.dbx).await.unwrap(), 1);
        enqueue_task(
            &env.dbx,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            network_freq_id,
            Some(login_id),
        )
        .await
        .unwrap();
        assert!(run_once(&env.dbx).await.unwrap());
        assert!(network_freq_last_datetime_in_aor::Entity::find_by_id((
            network_freq_id,
            login_id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
        assert_eq!(
            network_recalculation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }
}
