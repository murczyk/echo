use super::{
    acquire_unit_merge_locks_for_ids, activate_units_for_login,
    fanout_unit_changed_data,
};
use crate::config::{
    SIGINT_UNIT_AUTO_ACTIVATION_ADVISORY_LOCK_KEY,
    SIGINT_UNIT_AUTO_ACTIVATION_INTERVAL_SECS,
    SIGINT_UNIT_AUTO_ACTIVATION_LINK_THRESHOLD,
    SIGINT_UNIT_AUTO_ACTIVATION_LOOKBACK_DAYS,
};
use crate::entities::sigint_unit;
use crate::h;
use crate::types::{error, info, Env, ShortContext};
use crate::utils::worker_watch;
use sea_orm::{
    ConnectionTrait, DbBackend, FromQueryResult, Statement, TransactionTrait,
};
use std::sync::Arc;
use tokio::time::{Duration, MissedTickBehavior};

pub async fn run_inactive_unit_activation_worker_nofail(env: Arc<Env>) {
    let mut interval = tokio::time::interval(Duration::from_secs(
        SIGINT_UNIT_AUTO_ACTIVATION_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let _loop_guard =
            worker_watch::loop_guard("inactive_unit_activation_worker");
        match activate_inactive_units_once(&env).await {
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
) -> anyhow::Result<usize> {
    activate_inactive_units_with_policy(
        env,
        SIGINT_UNIT_AUTO_ACTIVATION_LOOKBACK_DAYS,
        SIGINT_UNIT_AUTO_ACTIVATION_LINK_THRESHOLD,
    )
    .await
    .c(h!())
}

async fn activate_inactive_units_with_policy(
    env: &Env,
    lookback_days: i64,
    link_threshold: i64,
) -> anyhow::Result<usize> {
    let transaction = env.dbx.begin().await.c(h!())?;
    if !acquire_worker_lock(&transaction).await.c(h!())? {
        return Ok(0);
    }
    let candidates = load_activation_candidates(
        &transaction,
        lookback_days,
        link_threshold,
        false,
        None,
    )
    .await
    .c(h!())?;
    if candidates.is_empty() {
        transaction.commit().await.c(h!())?;
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
        Some(&candidate_ids),
    )
    .await
    .c(h!())?;
    if units.is_empty() {
        transaction.commit().await.c(h!())?;
        return Ok(0);
    }
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let activated = activate_units_for_login(&transaction, &login, &units)
        .await
        .c(h!())?;
    crate::orbit::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;

    if !activated.is_empty() {
        fanout_unit_changed_data(env).await.c(h!())?;
    }
    Ok(activated.len())
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
    candidate_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let lock_clause = if lock_rows { "for update of unit" } else { "" };
    let mut values = vec![
        lookback_days.into(),
        link_threshold.saturating_add(1).into(),
        link_threshold.into(),
    ];
    let candidate_filter = candidate_ids
        .filter(|candidate_ids| !candidate_ids.is_empty())
        .map(|candidate_ids| {
            let placeholders = candidate_ids
                .iter()
                .enumerate()
                .map(|(index, unit_id)| {
                    values.push((*unit_id).into());
                    format!("${}", index + 4)
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("and unit.id in ({placeholders})")
        })
        .unwrap_or_default();
    sigint_unit::Model::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!(
            r#"
select unit.*
from sigint_unit unit
where unit.active = false
  and unit.deleted = false
  {candidate_filter}
  and (
      select count(*)
      from (
          select link.item_id
          from sigint_inbox_item_unit link
          where link.unit_id = unit.id
            and link.created_at > now() - $1 * interval '1 day'
          limit $2
      ) recent_link
  ) > $3
order by unit.id
{lock_clause}
                "#
        ),
        values,
    ))
    .all(dbx)
    .await
    .c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        sea_orm_active_enums::SigintInboxItemUnitKind, sigint_inbox_item_unit,
        sigint_unit_changelog,
    };
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
    ) {
        for _ in 0..count {
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
        }
    }

    #[tokio::test]
    #[serial]
    async fn worker_activates_only_units_above_the_recent_link_threshold() {
        let env = cleanup().await.unwrap();
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
        let recent = Utc::now().naive_utc() - ChronoDuration::minutes(5);
        insert_links(&env, eligible.id, 3, recent).await;
        insert_links(&env, boundary.id, 2, recent).await;
        insert_links(
            &env,
            stale.id,
            3,
            Utc::now().naive_utc() - ChronoDuration::days(8),
        )
        .await;

        assert_eq!(
            activate_inactive_units_with_policy(&env, 7, 2)
                .await
                .unwrap(),
            1
        );

        let eligible = sigint_unit::Entity::find_by_id(eligible.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(eligible.active);
        assert_eq!(eligible.is_deduplicate_candidate, Some(false));
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
