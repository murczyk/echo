use super::primitive_to_naive_datetime;
use crate::config::{
    NETWORK_FREQ_LAST_DATETIME_IN_AOR_CACHE_TTL_MINUTES,
    NETWORK_RECALCULATION_STATEMENT_TIMEOUT_MS,
    NETWORK_RECALCULATION_TASK_STALE_MINUTES,
};
use crate::entities::sea_orm_active_enums::NetworkRecalculationTaskKind;
use crate::entities::{
    network_freq_last_datetime_in_aor, network_invalidation_task,
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
    for network_freq_id in network_freq_ids {
        let should_enqueue = cached_by_freq
            .get(&network_freq_id)
            .map(|row| row.calculated_at < stale_before)
            .unwrap_or(true);
        if should_enqueue {
            enqueue_task(
                db,
                NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
                network_freq_id,
                Some(login_id),
            )
            .await
            .c(h!())?;
        }
    }
    Ok(cached_by_freq
        .into_values()
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
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                delete from network_freq_last_datetime_in_aor as cache
                using sigint_network_freq as freq
                where freq.id = cache.network_freq_id
                  and (freq.deleted = true or cache.calculated_at < $1)
            "#,
            vec![stale_before.into()],
        ))
        .await
        .c(h!())?;
    Ok(result.rows_affected())
}

pub(super) async fn enqueue_all_for_network_freq<C>(
    db: &C,
    network_freq_id: i64,
    login_id: uuid::Uuid,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    enqueue_task(
        db,
        NetworkRecalculationTaskKind::NetworkFreqLastSeen,
        network_freq_id,
        None,
    )
    .await
    .c(h!())?;
    enqueue_task(
        db,
        NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
        network_freq_id,
        Some(login_id),
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
    for network_freq_id in network_freq_ids {
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastSeen,
            network_freq_id,
            None,
        )
        .await
        .c(h!())?;
    }
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
    for network_freq_id in &network_freq_ids {
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            *network_freq_id,
            Some(login_id),
        )
        .await
        .c(h!())?;
    }
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
                .is_in(network_freq_ids),
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
    for (network_freq_id, login_id) in cached_keys {
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            network_freq_id,
            Some(login_id),
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub(crate) async fn enqueue_cached_for_network_invalidations(
    db: &DatabaseConnection,
    tasks: &[network_invalidation_task::Model],
) -> anyhow::Result<()> {
    let mut all_network_freqs = false;
    let mut network_ids = HashSet::new();
    let mut frequencies = HashSet::new();
    for task in tasks {
        match (task.sigint_network_id, task.frequency.as_ref()) {
            (None, None) => all_network_freqs = true,
            (Some(network_id), frequency) => {
                network_ids.insert(network_id);
                if let Some(frequency) = frequency {
                    frequencies.insert(frequency.clone());
                }
            }
            (None, Some(frequency)) => {
                frequencies.insert(frequency.clone());
            }
        }
    }
    let mut query = network_freq_last_datetime_in_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            network_freq_last_datetime_in_aor::Relation::SigintNetworkFreq
                .def(),
        )
        .select_only()
        .columns([
            network_freq_last_datetime_in_aor::Column::NetworkFreqId,
            network_freq_last_datetime_in_aor::Column::LoginId,
        ]);
    if !all_network_freqs {
        if network_ids.is_empty() && frequencies.is_empty() {
            return Ok(());
        }
        let mut condition = Condition::any();
        if !network_ids.is_empty() {
            condition = condition
                .add(sigint_network_freq::Column::NetworkId.is_in(network_ids));
        }
        if !frequencies.is_empty() {
            condition = condition
                .add(sigint_network_freq::Column::Freq.is_in(frequencies));
        }
        query = query.filter(condition);
    }
    let cached_keys = query
        .into_tuple::<(i64, uuid::Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    for (network_freq_id, login_id) in cached_keys {
        enqueue_task(
            db,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            network_freq_id,
            Some(login_id),
        )
        .await
        .c(h!())?;
    }
    Ok(())
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
    network_recalculation_task::Entity::insert(
        network_recalculation_task::ActiveModel {
            id: NotSet,
            task_kind: Set(task_kind),
            network_freq_id: Set(network_freq_id),
            login_id: Set(login_id),
            started_at: Set(None),
            created_at: NotSet,
        },
    )
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(db)
    .await
    .c(h!())?;
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
    while run_once(db).await.c(h!())? {}
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
    delete_matching_tasks(&txn, task).await.c(h!())?;
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
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    if network_freq.deleted {
        network_freq_last_datetime_in_aor::Entity::delete_by_id((
            network_freq_id,
            login_id,
        ))
        .exec(txn)
        .await
        .c(h!())?;
        return Ok(());
    }
    let groups =
        crate::messenger::group::get_identity_sigint_groups(txn, &login_id)
            .await
            .c(h!())?;
    let aor_ids = sigint_network_aor::Entity::find()
        .filter(
            sigint_network_aor::Column::NetworkId.eq(network_freq.network_id),
        )
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

async fn delete_matching_tasks(
    txn: &DatabaseTransaction,
    task: &network_recalculation_task::Model,
) -> anyhow::Result<()> {
    let mut delete = network_recalculation_task::Entity::delete_many()
        .filter(
            network_recalculation_task::Column::TaskKind
                .eq(task.task_kind.clone()),
        )
        .filter(
            network_recalculation_task::Column::NetworkFreqId
                .eq(task.network_freq_id),
        );
    delete = match task.login_id {
        Some(login_id) => delete
            .filter(network_recalculation_task::Column::LoginId.eq(login_id)),
        None => {
            delete.filter(network_recalculation_task::Column::LoginId.is_null())
        }
    };
    delete.exec(txn).await.c(h!())?;
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
        enqueue_task(&env.dbx, kind.clone(), network_freq.id, Some(login_id))
            .await
            .unwrap();
        enqueue_task(&env.dbx, kind, network_freq.id, Some(login_id))
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

        let txn = env.dbx.begin().await.unwrap();
        delete_matching_tasks(&txn, &started_task).await.unwrap();
        txn.commit().await.unwrap();
        let remaining = network_recalculation_task::Entity::find()
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].task_kind,
            NetworkRecalculationTaskKind::NetworkFreqLastSeen
        );

        assert!(run_once(&env.dbx).await.unwrap());
        enqueue_task(
            &env.dbx,
            NetworkRecalculationTaskKind::NetworkFreqLastDatetimeInAor,
            network_freq.id,
            Some(login_id),
        )
        .await
        .unwrap();
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
