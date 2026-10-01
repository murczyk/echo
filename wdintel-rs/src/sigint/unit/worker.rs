use super::{
    acquire_unit_merge_locks_for_ids, activate_units_for_login,
    fanout_unit_changed_data,
};
use crate::config::{
    SIGINT_UNIT_AUTO_ACTIVATION_ADVISORY_LOCK_KEY,
    SIGINT_UNIT_AUTO_ACTIVATION_BATCH_SIZE,
    SIGINT_UNIT_AUTO_ACTIVATION_INTERVAL_SECS,
    SIGINT_UNIT_AUTO_ACTIVATION_LINK_THRESHOLD,
    SIGINT_UNIT_AUTO_ACTIVATION_LOOKBACK_DAYS,
    SIGINT_UNIT_AUTO_ACTIVATION_SCAN_BATCH_SIZE,
};
use crate::entities::{
    sea_orm_active_enums::SigintInboxItemUnitKind, sigint_unit,
};
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, FromQueryResult,
    Iterable, QueryFilter, QueryOrder, QuerySelect, Statement,
    TransactionTrait,
};
use std::sync::Arc;
use tokio::time::{Duration, MissedTickBehavior};

pub async fn run_inactive_unit_activation_worker_nofail(env: Arc<Env>) {
    let mut cursor = None;
    let mut interval = tokio::time::interval(Duration::from_secs(
        SIGINT_UNIT_AUTO_ACTIVATION_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let _loop_guard =
            worker_watch::loop_guard("inactive_unit_activation_worker");
        match activate_inactive_units_once(&env, &mut cursor).await {
            Ok(0) => {}
            Ok(count) => {
                info!("inactive_unit_activation_worker activated {count} units")
            }
            Err(error) => {
                error!("inactive_unit_activation_worker failed: {error:#}")
            }
        }
    }
}

pub(crate) async fn activate_inactive_units_once(
    env: &Env,
    cursor: &mut Option<i64>,
) -> anyhow::Result<usize> {
    activate_inactive_units_with_policy(
        env,
        SIGINT_UNIT_AUTO_ACTIVATION_LOOKBACK_DAYS,
        SIGINT_UNIT_AUTO_ACTIVATION_LINK_THRESHOLD,
        SIGINT_UNIT_AUTO_ACTIVATION_SCAN_BATCH_SIZE,
        cursor,
    )
    .await
    .c(h!())
}

async fn activate_inactive_units_with_policy(
    env: &Env,
    lookback_days: i64,
    link_threshold: i64,
    scan_batch_size: u64,
    cursor: &mut Option<i64>,
) -> anyhow::Result<usize> {
    let transaction = env.dbx.begin().await.c(h!())?;
    if !acquire_worker_lock(&transaction).await.c(h!())? {
        return Ok(0);
    }
    let candidate_ids =
        load_inactive_unit_ids(&transaction, *cursor, scan_batch_size)
            .await
            .c(h!())?;
    if candidate_ids.is_empty() {
        transaction.commit().await.c(h!())?;
        *cursor = None;
        return Ok(0);
    }
    let candidates = load_activation_candidates(
        &transaction,
        lookback_days,
        link_threshold,
        false,
        &candidate_ids,
    )
    .await
    .c(h!())?;
    let next_cursor = if candidates.len()
        == SIGINT_UNIT_AUTO_ACTIVATION_BATCH_SIZE as usize
    {
        candidates.last().map(|unit| unit.id)
    } else if candidate_ids.len() == scan_batch_size as usize {
        candidate_ids.last().copied()
    } else {
        None
    };
    if candidates.is_empty() {
        transaction.commit().await.c(h!())?;
        *cursor = next_cursor;
        return Ok(0);
    }
    let candidate_ids =
        candidates.iter().map(|unit| unit.id).collect::<Vec<_>>();
    acquire_unit_merge_locks_for_ids(&transaction, &candidate_ids)
        .await
        .c(h!())?;
    let units = load_activation_candidates(
        &transaction,
        lookback_days,
        link_threshold,
        true,
        &candidate_ids,
    )
    .await
    .c(h!())?;
    if units.is_empty() {
        transaction.commit().await.c(h!())?;
        *cursor = next_cursor;
        return Ok(0);
    }
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let activated = activate_units_for_login(&transaction, &login, &units)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    *cursor = next_cursor;

    if !activated.is_empty() {
        fanout_unit_changed_data(env).await.c(h!())?;
    }
    Ok(activated.len())
}

async fn load_inactive_unit_ids<C>(
    dbx: &C,
    after_id: Option<i64>,
    limit: u64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    let unit_ids = load_inactive_unit_ids_after(dbx, after_id, limit)
        .await
        .c(h!())?;
    if unit_ids.is_empty() && after_id.is_some() {
        return load_inactive_unit_ids_after(dbx, None, limit).await.c(h!());
    }
    Ok(unit_ids)
}

async fn load_inactive_unit_ids_after<C>(
    dbx: &C,
    after_id: Option<i64>,
    limit: u64,
) -> anyhow::Result<Vec<i64>>
where
    C: ConnectionTrait,
{
    let mut query = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Active.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Id)
        .limit(limit);
    if let Some(after_id) = after_id {
        query = query.filter(sigint_unit::Column::Id.gt(after_id));
    }
    query
        .select_only()
        .column(sigint_unit::Column::Id)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())
}

async fn acquire_worker_lock<C>(dbx: &C) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    let row = dbx
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_try_advisory_xact_lock($1) as acquired",
            [SIGINT_UNIT_AUTO_ACTIVATION_ADVISORY_LOCK_KEY.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "acquired").c(h!())
}

async fn load_activation_candidates<C>(
    dbx: &C,
    lookback_days: i64,
    link_threshold: i64,
    lock_rows: bool,
    candidate_ids: &[i64],
) -> anyhow::Result<Vec<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    let lock_clause = if lock_rows { "for update of unit" } else { "" };
    let values = vec![
        lookback_days.into(),
        activation_link_scan_limit(link_threshold).into(),
        link_threshold.into(),
        SIGINT_UNIT_AUTO_ACTIVATION_BATCH_SIZE.into(),
        candidate_ids.to_vec().into(),
    ];
    sigint_unit::Model::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!(
            r#"
select unit.*
from sigint_unit unit
where unit.id = any($5::bigint[])
  and unit.active = false
  and unit.deleted = false
  and (
      select count(distinct recent_link.item_id)
      from (
          select link.item_id
          from sigint_inbox_item_unit link
          where link.unit_id = unit.id
            and link.created_at > now() - $1 * interval '1 day'
          order by link.created_at desc, link.item_id
          limit $2
      ) recent_link
  ) > $3
order by unit.id
limit $4
{lock_clause}
                "#
        ),
        values,
    ))
    .all(dbx)
    .await
    .c(h!())
}

fn activation_link_scan_limit(link_threshold: i64) -> i64 {
    // The unique (item_id, unit_id, kind) key allows at most one row per kind.
    let link_kind_count =
        i64::try_from(SigintInboxItemUnitKind::iter().count())
            .unwrap_or(i64::MAX);
    link_threshold
        .max(0)
        .saturating_add(1)
        .saturating_mul(link_kind_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{sigint_inbox_item_unit, sigint_unit_changelog};
    use crate::functest::tests::{
        cleanup, mk_sigint_inbox_item, mk_sigint_unit,
    };
    use chrono::{Duration as ChronoDuration, Utc};
    use sea_orm::{
        ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder,
        Set,
    };
    use serial_test::serial;

    async fn insert_links(
        env: &Env,
        unit_id: i64,
        count: usize,
        created_at: chrono::NaiveDateTime,
        duplicate_first_item: bool,
    ) {
        for index in 0..count {
            let item = mk_sigint_inbox_item(&env.dbx, Default::default())
                .await
                .unwrap();
            sigint_inbox_item_unit::ActiveModel {
                item_id: Set(item.id),
                unit_id: Set(unit_id),
                kind: Set(SigintInboxItemUnitKind::Parsed),
                created_at: Set(created_at),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            if duplicate_first_item && index == 0 {
                sigint_inbox_item_unit::ActiveModel {
                    item_id: Set(item.id),
                    unit_id: Set(unit_id),
                    kind: Set(SigintInboxItemUnitKind::Network),
                    created_at: Set(created_at),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn worker_activates_only_units_above_the_recent_link_threshold() {
        let env = cleanup().await.unwrap();
        let boundary = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let stale = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let eligible = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                active: Set(false),
                is_deduplicate_candidate: Set(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let recent = Utc::now().naive_utc() - ChronoDuration::minutes(5);
        insert_links(&env, eligible.id, 3, recent, false).await;
        insert_links(&env, boundary.id, 2, recent, true).await;
        insert_links(
            &env,
            stale.id,
            3,
            Utc::now().naive_utc() - ChronoDuration::days(8),
            false,
        )
        .await;

        let mut cursor = None;
        assert_eq!(
            activate_inactive_units_with_policy(&env, 7, 2, 2, &mut cursor)
                .await
                .unwrap(),
            0
        );
        assert_eq!(cursor, Some(stale.id));
        assert_eq!(
            activate_inactive_units_with_policy(&env, 7, 2, 2, &mut cursor)
                .await
                .unwrap(),
            1
        );
        assert_eq!(cursor, None);

        let eligible = sigint_unit::Entity::find_by_id(eligible.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(eligible.active);
        assert_eq!(eligible.is_deduplicate_candidate, Some(true));
        assert!(
            !sigint_unit::Entity::find_by_id(boundary.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert!(
            !sigint_unit::Entity::find_by_id(stale.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );

        let system_login =
            crate::users::system_login_id(&env.dbx).await.unwrap();
        let changelog = sigint_unit_changelog::Entity::find()
            .filter(sigint_unit_changelog::Column::SigintUnitId.eq(eligible.id))
            .filter(sigint_unit_changelog::Column::Action.eq("update"))
            .order_by_desc(sigint_unit_changelog::Column::Id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(changelog.login_id, system_login);
        assert_eq!(changelog.old_value.unwrap()["active"], false);
        assert_eq!(changelog.new_value.unwrap()["active"], true);
    }
}
