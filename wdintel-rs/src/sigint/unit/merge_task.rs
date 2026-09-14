use super::*;
use crate::config::SIGINT_UNIT_MERGE_ADVISORY_LOCK_NAMESPACE;
use crate::delta::{bgtask_log, finish_bgtask};

pub(super) async fn start(
    env: &actix_web::web::Data<Env>,
    login: uuid::Uuid,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<i64, AppError> {
    if unit_to_delete_id == original_id {
        return Err(AppError::BL {
            msg: "unit cannot be merged into itself".to_string(),
        });
    }
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::json!([])),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;
    let env = env.clone();
    tokio::spawn(async move {
        let result =
            run(&env, login, unit_to_delete_id, original_id, bgtask_id).await;
        if let Err(error) =
            finish_bgtask(Some(bgtask_id), &env.dbx, &result).await
        {
            eprintln!(
                "failed to finish unit merge task {bgtask_id}: {error:?}"
            );
        }
    });
    Ok(bgtask_id)
}

async fn run(
    env: &Env,
    login: uuid::Uuid,
    unit_to_delete_id: i64,
    original_id: i64,
    bgtask_id: i64,
) -> Result<(), AppError> {
    let mut guard = env
        .dbx
        .get_postgres_connection_pool()
        .begin()
        .await
        .c(h!())?;
    for unit_id in [
        std::cmp::min(unit_to_delete_id, original_id),
        std::cmp::max(unit_to_delete_id, original_id),
    ] {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1::text || $2::text, 0))")
            .bind(SIGINT_UNIT_MERGE_ADVISORY_LOCK_NAMESPACE)
            .bind(format!("unit:{unit_id}"))
            .execute(&mut *guard)
            .await
            .c(h!())?;
    }
    let result =
        run_locked(env, login, unit_to_delete_id, original_id, bgtask_id).await;
    guard.rollback().await.c(h!())?;
    result
}

async fn run_locked(
    env: &Env,
    login: uuid::Uuid,
    unit_to_delete_id: i64,
    original_id: i64,
    bgtask_id: i64,
) -> Result<(), AppError> {
    let step_count = UnitReferenceStep::ALL.len() + 1;
    loop {
        for (index, step) in UnitReferenceStep::ALL.into_iter().enumerate() {
            move_step(&env.dbx, login, unit_to_delete_id, original_id, step)
                .await
                .c(h!())?;
            record_progress(
                &env.dbx,
                bgtask_id,
                ((index + 1) * 100 / step_count) as i64,
                &format!("[{}/{}] {}", index + 1, step_count, step.label()),
            )
            .await
            .c(h!())?;
        }
        if finalize(&env.dbx, login, unit_to_delete_id, original_id)
            .await
            .c(h!())?
        {
            if let Err(error) = record_progress(
                &env.dbx,
                bgtask_id,
                100,
                &format!("[{step_count}/{step_count}] Об’єднання завершено"),
            )
            .await
            {
                eprintln!("failed to update completed unit merge task {bgtask_id}: {error:?}");
            }
            let event = EventMsg::new(EventType::ETUnitChanged);
            if let Err(error) = fanout(&mut env.redis.clone(), event).await {
                eprintln!("failed to publish merged unit change: {error:?}");
            }
            return Ok(());
        }
        bgtask_log(
            Some(bgtask_id),
            "З’явилися нові прив’язки; повторюємо перенесення",
            &env.dbx,
        )
        .await
        .c(h!())?;
    }
}

async fn move_step(
    dbx: &DatabaseConnection,
    login: uuid::Uuid,
    unit_to_delete_id: i64,
    original_id: i64,
    step: UnitReferenceStep,
) -> Result<(), AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    find_units_for_merge(&transaction, unit_to_delete_id, original_id)
        .await
        .context(h!())?;
    changelog::set_author(&transaction, &login).await.c(h!())?;
    if step == UnitReferenceStep::InboxLinks {
        crate::stats::enqueue_group_stats_recalculation_for_linked_unit(
            &transaction,
            unit_to_delete_id,
            format!("merged unit {unit_to_delete_id} into {original_id}"),
        )
        .await
        .c(h!())?;
    }
    swap_unit_references_step(
        step,
        unit_to_delete_id,
        original_id,
        login,
        &transaction,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn finalize(
    dbx: &DatabaseConnection,
    login: uuid::Uuid,
    unit_to_delete_id: i64,
    original_id: i64,
) -> Result<bool, AppError> {
    let transaction = dbx.begin().await.c(h!())?;
    find_units_for_merge(&transaction, unit_to_delete_id, original_id)
        .await
        .context(h!())?;
    if references_remain(&transaction, unit_to_delete_id)
        .await
        .c(h!())?
    {
        transaction.rollback().await.c(h!())?;
        return Ok(false);
    }
    complete_unit_merge_in_transaction(
        login,
        &transaction,
        unit_to_delete_id,
        original_id,
        MergeUnitNamePolicy::RegenerateDerived,
        false,
    )
    .await
    .context(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(true)
}

async fn references_remain<C>(dbx: &C, unit_id: i64) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    for (table, column) in [
        ("sigint_callsign", "unit_id"),
        ("sigint_signal", "unit"),
        ("sigint_network_unit", "unit_id"),
        ("sigint_network_callsign", "unit_id"),
        ("sigint_unit_attachment", "unit_id"),
        ("sigint_unit_label", "sigint_unit_id"),
        ("sigint_inbox_item_unit", "unit_id"),
        ("orbit_unit_sigint_unit", "sigint_unit_id"),
        ("device", "unit_id"),
    ] {
        let sql = format!("select exists (select 1 from {table} where {column} = $1) as present");
        let row = dbx
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                [unit_id.into()],
            ))
            .await
            .c(h!())?
            .c(h!())?;
        if row.try_get::<bool>("", "present").c(h!())? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn record_progress(
    dbx: &DatabaseConnection,
    bgtask_id: i64,
    progress: i64,
    logline: &str,
) -> Result<(), AppError> {
    dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "update bgtask set progress = greatest(progress, $2) where id = $1 and running = true",
        [bgtask_id.into(), progress.into()],
    ))
    .await
    .c(h!())?;
    bgtask_log(Some(bgtask_id), logline, dbx).await.c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup, mk_sigint_network, mk_sigint_unit};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn staged_merge_commits_dependencies_and_reports_completion() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let duplicate =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let survivor =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let label = sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(duplicate.id),
            label: Set("staged reference".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let network = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let network_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("staged callsign".to_string()),
            unit_id: Set(Some(duplicate.id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let task = bgtask::ActiveModel {
            id: NotSet,
            progress: Set(0),
            loglines: Set(serde_json::json!([])),
            running: Set(true),
            finished_with_error: Set(None),
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        run(&env, login, duplicate.id, survivor.id, task.id)
            .await
            .unwrap();

        assert_eq!(
            sigint_unit_label::Entity::find_by_id(label.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .sigint_unit_id,
            survivor.id
        );
        assert_eq!(
            sigint_network_callsign::Entity::find_by_id(network_callsign.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .unit_id,
            Some(survivor.id)
        );
        assert_eq!(
            sigint_network_callsign_changelog::Entity::find()
                .filter(sigint_network_callsign_changelog::Column::SigintNetworkCallsignId.eq(network_callsign.id))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert!(
            sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            bgtask::Entity::find_by_id(task.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .progress,
            100
        );
    }

    #[tokio::test]
    #[serial]
    async fn staged_merge_rechecks_new_references_before_deleting() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let duplicate =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let survivor =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let first = sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(duplicate.id),
            label: Set("first reference".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        move_step(
            &env.dbx,
            login,
            duplicate.id,
            survivor.id,
            UnitReferenceStep::Labels,
        )
        .await
        .unwrap();
        assert_eq!(
            sigint_unit_label::Entity::find_by_id(first.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .sigint_unit_id,
            survivor.id
        );
        assert!(
            !sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );

        let second = sigint_unit_label::ActiveModel {
            sigint_unit_id: Set(duplicate.id),
            label: Set("new reference".to_string()),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        assert!(!finalize(&env.dbx, login, duplicate.id, survivor.id)
            .await
            .unwrap());
        move_step(
            &env.dbx,
            login,
            duplicate.id,
            survivor.id,
            UnitReferenceStep::Labels,
        )
        .await
        .unwrap();
        assert!(finalize(&env.dbx, login, duplicate.id, survivor.id)
            .await
            .unwrap());
        assert_eq!(
            sigint_unit_label::Entity::find_by_id(second.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .sigint_unit_id,
            survivor.id
        );
        assert!(
            sigint_unit::Entity::find_by_id(duplicate.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
    }
}
