use super::*;
use crate::config::{
    SIGINT_UNIT_MERGE_ADVISORY_LOCK_NAMESPACE, SIGINT_UNIT_MERGE_BATCH_SIZE,
    SIGINT_UNIT_MERGE_TASK_MARKER,
};
use crate::delta::bgtask_log;

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
        loglines: Set(serde_json::json!([
            format!("{SIGINT_UNIT_MERGE_TASK_MARKER}{unit_to_delete_id}:{original_id}"),
            "Початок об’єднання"
        ])),
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
            finish_merge_task(&env.dbx, bgtask_id, &result).await
        {
            eprintln!(
                "failed to finish unit merge task {bgtask_id}: {error:?}"
            );
        }
    });
    Ok(bgtask_id)
}

pub(super) async fn recover_abandoned(
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    let tasks = bgtask::Entity::find()
        .filter(bgtask::Column::Running.eq(true))
        .all(dbx)
        .await
        .c(h!())?;
    let mut recovered_commit = false;
    for task in tasks {
        let Some((duplicate_id, survivor_id)) = task
            .loglines
            .as_array()
            .and_then(|lines| lines.first())
            .and_then(serde_json::Value::as_str)
            .and_then(|line| line.strip_prefix(SIGINT_UNIT_MERGE_TASK_MARKER))
            .and_then(|ids| ids.split_once(':'))
            .and_then(|(duplicate_id, survivor_id)| {
                Some((
                    duplicate_id.parse::<i64>().ok()?,
                    survivor_id.parse::<i64>().ok()?,
                ))
            })
        else {
            continue;
        };
        let duplicate = sigint_unit::Entity::find_by_id(duplicate_id)
            .one(dbx)
            .await
            .c(h!())?;
        let survivor = sigint_unit::Entity::find_by_id(survivor_id)
            .one(dbx)
            .await
            .c(h!())?;
        let merge_changelog = sigint_unit_changelog::Entity::find()
            .filter(
                sigint_unit_changelog::Column::SigintUnitId.eq(duplicate_id),
            )
            .filter(
                sigint_unit_changelog::Column::Action.eq("delete_duplicate"),
            )
            .one(dbx)
            .await
            .c(h!())?;
        let committed = merge_changelog
            .as_ref()
            .and_then(|change| change.new_value.as_ref())
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_i64)
            == Some(survivor_id)
            && duplicate.is_some_and(|unit| unit.deleted)
            && survivor.is_some_and(|unit| !unit.deleted);
        let mut task = task.into_active_model();
        task.running = Set(false);
        if committed {
            recovered_commit = true;
            task.progress = Set(100);
        } else {
            task.finished_with_error = Set(Some(
                "Об’єднання перервано перезапуском сервера. Повторіть об’єднання."
                    .to_string(),
            ));
        }
        task.update(dbx).await.c(h!())?;
    }
    Ok(recovered_commit)
}

async fn finish_merge_task(
    dbx: &DatabaseConnection,
    bgtask_id: i64,
    result: &Result<(), AppError>,
) -> Result<(), AppError> {
    let bgtask = bgtask::Entity::find_by_id(bgtask_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let mut bgtask = bgtask.into_active_model();
    bgtask.running = Set(false);
    match result {
        Ok(()) => bgtask.progress = Set(100),
        Err(error) => {
            bgtask.finished_with_error = Set(Some(format!("{error:?}")))
        }
    }
    bgtask.update(dbx).await.c(h!())?;
    Ok(())
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
    let rollback = guard.rollback().await;
    if result.is_ok() {
        rollback.c(h!())?;
    } else if let Err(error) = rollback {
        eprintln!(
            "failed to release unit merge lock after task error: {error:?}"
        );
    }
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
    loop {
        let transaction = dbx.begin().await.c(h!())?;
        find_units_for_merge(&transaction, unit_to_delete_id, original_id)
            .await
            .context(h!())?;
        changelog::set_author(&transaction, &login).await.c(h!())?;
        let batch_full = if step == UnitReferenceStep::InboxLinks {
            let link_ids = sigint_inbox_item_unit::Entity::find()
                .filter(
                    sigint_inbox_item_unit::Column::UnitId
                        .eq(unit_to_delete_id),
                )
                .order_by_asc(sigint_inbox_item_unit::Column::Id)
                .limit(SIGINT_UNIT_MERGE_BATCH_SIZE)
                .lock_exclusive()
                .select_only()
                .column(sigint_inbox_item_unit::Column::Id)
                .into_tuple::<i64>()
                .all(&transaction)
                .await
                .c(h!())?;
            crate::stats::enqueue_group_stats_recalculation_for_unit_link_ids(
                &transaction,
                &link_ids,
                format!("merged unit {unit_to_delete_id} into {original_id}"),
            )
            .await
            .c(h!())?;
            move_inbox_item_unit_links(
                unit_to_delete_id,
                original_id,
                &transaction,
                None,
                Some(&link_ids),
            )
            .await
            .c(h!())?;
            link_ids.len() as u64 == SIGINT_UNIT_MERGE_BATCH_SIZE
        } else {
            swap_unit_references_step(
                step,
                unit_to_delete_id,
                original_id,
                login,
                &transaction,
                Some(SIGINT_UNIT_MERGE_BATCH_SIZE),
            )
            .await
            .c(h!())?
                == SIGINT_UNIT_MERGE_BATCH_SIZE
        };
        transaction.commit().await.c(h!())?;
        if !batch_full {
            break;
        }
    }
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
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(duplicate.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
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
        assert!(orbit_unit_sigint_unit::Entity::find_by_id((
            orbit_unit_id,
            survivor.id
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        assert!(orbit_unit_sigint_unit::Entity::find_by_id((
            orbit_unit_id,
            duplicate.id
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .is_none());
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
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let link = sigint_inbox_item_unit::ActiveModel {
            item_id: Set(inbox_item.id),
            unit_id: Set(duplicate.id),
            kind: Set(crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind::Parsed),
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
        move_step(
            &env.dbx,
            login,
            duplicate.id,
            survivor.id,
            UnitReferenceStep::InboxLinks,
        )
        .await
        .unwrap();
        assert!(finalize(&env.dbx, login, duplicate.id, survivor.id)
            .await
            .unwrap());
        assert_eq!(
            sigint_inbox_item_unit::Entity::find_by_id(link.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .unit_id,
            survivor.id
        );
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

    #[tokio::test]
    #[serial]
    async fn staged_merge_batches_labels_and_reconciles_survivor() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let duplicate = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set("55 мбр".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let survivor = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Custom survivor".to_string()),
                company: Set("1 рота".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for index in 0..=SIGINT_UNIT_MERGE_BATCH_SIZE {
            sigint_unit_label::ActiveModel {
                sigint_unit_id: Set(duplicate.id),
                label: Set(format!("staged batch label {index}")),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

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
            sigint_unit_label::Entity::find()
                .filter(
                    sigint_unit_label::Column::SigintUnitId.eq(duplicate.id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        let interrupted = bgtask::ActiveModel {
            progress: Set(60),
            loglines: Set(serde_json::json!([
                format!(
                    "{SIGINT_UNIT_MERGE_TASK_MARKER}{}:{}",
                    duplicate.id, survivor.id
                ),
                "Перервано"
            ])),
            running: Set(true),
            finished_with_error: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        recover_abandoned(&env.dbx).await.unwrap();
        let interrupted = bgtask::Entity::find_by_id(interrupted.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!interrupted.running);
        assert!(interrupted.finished_with_error.is_some());

        assert!(finalize(&env.dbx, login, duplicate.id, survivor.id)
            .await
            .unwrap());
        let committed = bgtask::ActiveModel {
            progress: Set(90),
            loglines: Set(serde_json::json!([format!(
                "{SIGINT_UNIT_MERGE_TASK_MARKER}{}:{}",
                duplicate.id, survivor.id
            )])),
            running: Set(true),
            finished_with_error: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        recover_abandoned(&env.dbx).await.unwrap();
        let committed = bgtask::Entity::find_by_id(committed.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!committed.running);
        assert_eq!(committed.progress, 100);
        assert!(committed.finished_with_error.is_none());
        let survivor = sigint_unit::Entity::find_by_id(survivor.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(survivor.name, "Custom survivor");
        assert_eq!(survivor.regiment, "55 мбр");
    }
}
