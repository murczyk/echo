use super::types::DirectSubmitPayload;
use crate::entities::{sigint_inbox_item, sigint_unit};
use crate::sigint::unit::message_creation::{
    find_exact_named_units, lock_unit_name_for_creation,
};
use crate::sigint::unit::{self, types::CreateUnitReq};
use crate::types::*;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
};
use uuid::Uuid;

pub(super) async fn resolve_unit<C>(
    db: &C,
    login: &Uuid,
    payload: &DirectSubmitPayload,
    copy_source_ids: &[i64],
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let name = payload.unit.as_deref().unwrap_or_default().trim();
    if payload.create_unit && (payload.unit_id.is_some() || name.is_empty()) {
        return Err(crate::error::AppError::BL {
            msg: "Вкажіть назву нового підрозділу або оберіть підрозділ зі списку.".to_string(),
        })
        .c(h!());
    }
    if payload.unit_id.is_none()
        && !payload.create_unit
        && !copy_source_ids.is_empty()
        && sigint_inbox_item::Entity::find()
            .filter(
                sigint_inbox_item::Column::Id.is_in(copy_source_ids.to_vec()),
            )
            .filter(
                sigint_inbox_item::Column::UnitV2
                    .eq(payload.unit.as_deref().unwrap_or_default()),
            )
            .one(db)
            .await
            .c(h!())?
            .is_some()
    {
        return Ok(None);
    }
    let unit = if let Some(id) = payload.unit_id {
        Some(
            sigint_unit::Entity::find_by_id(id)
                .filter(sigint_unit::Column::Deleted.eq(false))
                .lock_exclusive()
                .one(db)
                .await
                .c(h!())?
                .ok_or(crate::error::AppError::NotFound)
                .c(h!())?,
        )
    } else if name.is_empty() {
        None
    } else {
        if payload.create_unit {
            lock_unit_name_for_creation(db, name).await.c(h!())?;
        }
        find_or_create_named_unit(db, login, name, payload.create_unit)
            .await
            .c(h!())?
    };
    if let Some(unit) = &unit {
        return Ok(Some(
            unit::activate_unit_for_login(db, login, unit)
                .await
                .c(h!())?,
        ));
    }
    Ok(unit)
}

pub(super) async fn preserve_unit<C>(
    db: &C,
    inbox_id: i64,
    payload: &DirectSubmitPayload,
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let selections =
        crate::inbox::unit_selection::load_selections(db, &[inbox_id])
            .await
            .c(h!())?;
    let Some(selection) = selections.get(&inbox_id) else {
        return Ok(None);
    };
    let item = sigint_inbox_item::Entity::find_by_id(inbox_id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    let unit_name = item
        .unit_v2
        .as_deref()
        .or(item.unit.as_deref())
        .unwrap_or_default();
    if !crate::inbox::unit_selection::matches_source(
        selection,
        item.unit_v2.as_deref(),
        item.unit.as_deref(),
    ) || crate::inbox::unit_resolution::normalize_unit_label(unit_name)
        != crate::inbox::unit_resolution::normalize_unit_label(
            payload.unit.as_deref().unwrap_or_default(),
        )
    {
        crate::inbox::unit_selection::clear_selection(db, inbox_id)
            .await
            .c(h!())?;
        return Ok(None);
    }
    sigint_unit::Entity::find_by_id(selection.unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_exclusive()
        .one(db)
        .await
        .c(h!())
}

async fn find_or_create_named_unit<C>(
    db: &C,
    login: &Uuid,
    name: &str,
    create: bool,
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let units = find_exact_named_units(db, name).await.c(h!())?;
    match units.len() {
        0 if create => Ok(Some(
            unit::insert_unit_with_changelog(
                db,
                login,
                &CreateUnitReq {
                    name: Some(name.to_string()),
                    active: true,
                    ..Default::default()
                },
            )
            .await
            .c(h!())?,
        )),
        1 => Ok(units.into_iter().next()),
        _ if create => Err(crate::error::AppError::BL {
            msg: "Оберіть підрозділ зі списку.".to_string(),
        })
        .c(h!()),
        _ => Ok(None),
    }
}

pub(super) async fn attach_unit<C>(
    db: &C,
    inbox_id: i64,
    unit: &sigint_unit::Model,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let item = sigint_inbox_item::Entity::find_by_id(inbox_id)
        .one(db)
        .await
        .c(h!())?
        .ok_or(crate::error::AppError::NotFound)
        .c(h!())?;
    crate::inbox::unit_selection::store_selection(db, &item, unit.id)
        .await
        .c(h!())?;
    crate::inbox::unit_resolution::sync_selected_inbox_unit(
        db,
        inbox_id,
        item.id_uuid,
        unit.id,
        &unit.name,
    )
    .await
    .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
    use crate::entities::{sigint_inbox_item_unit, sigint_unit_changelog};
    use crate::functest::tests::cleanup;
    use crate::sigint::direct_submit::bl::{
        copy_signal_messages, edit_signal_message, submit_signal_message,
    };
    use crate::sigint::unit::types::UnitSearchReq;
    use sea_orm::{
        ActiveModelTrait, DatabaseConnection, IntoActiveModel, Set,
        TransactionTrait,
    };
    use serial_test::serial;

    async fn seed_unit(
        db: &DatabaseConnection,
        login: &Uuid,
        req: CreateUnitReq,
    ) -> sigint_unit::Model {
        let txn = db.begin().await.unwrap();
        let unit = unit::insert_unit_with_changelog(&txn, login, &req)
            .await
            .unwrap();
        txn.commit().await.unwrap();
        unit
    }

    fn payload(name: &str) -> DirectSubmitPayload {
        serde_json::from_value(serde_json::json!({
            "text": "#3535 unit selection",
            "unit": name,
            "signal_group_master_key": "vukho-test-master-key",
        }))
        .unwrap()
    }

    async fn parsed_unit_id(db: &DatabaseConnection, id: i64) -> i64 {
        sigint_inbox_item_unit::Entity::find()
            .filter(sigint_inbox_item_unit::Column::ItemId.eq(id))
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Parsed),
            )
            .one(db)
            .await
            .unwrap()
            .unwrap()
            .unit_id
    }

    async fn assert_reconciled_selection(
        env: &Env,
        item_id: i64,
        unit_id: i64,
    ) {
        crate::inbox::unit_resolution::run_failed_inbox_unit_worker_once(
            &env.dbx,
        )
        .await
        .unwrap();
        assert_eq!(parsed_unit_id(&env.dbx, item_id).await, unit_id);
        crate::inbox::unit_resolution::reprocess_inbox_items_for_unit(
            &env.dbx, unit_id,
        )
        .await
        .unwrap();
        assert_eq!(parsed_unit_id(&env.dbx, item_id).await, unit_id);
        let txn = env.dbx.begin().await.unwrap();
        let mut cache = TopKCache::<String, String>::new(64);
        crate::inbox::construct_inbox_item(
            env.settlements.clone(),
            &txn,
            &env.rq,
            &env.config,
            item_id,
            &mut cache,
            None,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        assert_eq!(parsed_unit_id(&env.dbx, item_id).await, unit_id);
        let now = chrono::Utc::now().naive_utc();
        crate::inbox::unit_resolution::backfill_inbox_unit_links(
            &env.dbx,
            now - chrono::Duration::days(1),
            now + chrono::Duration::days(1),
            0,
            None,
        )
        .await
        .unwrap();
        assert_eq!(parsed_unit_id(&env.dbx, item_id).await, unit_id);
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_activated_selected_child_and_preserved_its_id()
    {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let parent = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                regiment: "3535 полк".to_string(),
                ..Default::default()
            },
        )
        .await;
        let child = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                company: "1 рота".to_string(),
                regiment: parent.regiment.clone(),
                ..Default::default()
            },
        )
        .await;
        seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some(child.name.clone()),
                ..Default::default()
            },
        )
        .await;
        let mut request = payload(&child.name);
        request.unit_id = Some(child.id);
        let created =
            submit_signal_message(&login, &env, request).await.unwrap();
        assert_eq!(
            parsed_unit_id(&env.dbx, created.signal_message_id).await,
            child.id
        );
        assert_reconciled_selection(&env, created.signal_message_id, child.id)
            .await;
        let copied =
            copy_signal_messages(&login, &env, vec![created.signal_message_id])
                .await
                .unwrap();
        assert_eq!(copied.payloads[0].unit_id, Some(child.id));
        for id in [parent.id, child.id] {
            assert!(
                sigint_unit::Entity::find_by_id(id)
                    .one(&env.dbx)
                    .await
                    .unwrap()
                    .unwrap()
                    .active
            );
        }
        assert!(sigint_unit_changelog::Entity::find()
            .filter(sigint_unit_changelog::Column::SigintUnitId.eq(child.id))
            .filter(sigint_unit_changelog::Column::Action.eq("update"))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial]
    async fn issue_3891_legacy_report_preserves_unit_without_selecting_catalog_match(
    ) {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let created =
            submit_signal_message(&login, &env, payload("Успадкований 3891"))
                .await
                .unwrap();
        let source = created.signal_message_id;
        let original = sigint_inbox_item::Entity::find_by_id(source)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let catalog = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Успадкований 3891".to_string()),
                ..Default::default()
            },
        )
        .await;
        let mut copied = copy_signal_messages(&login, &env, vec![source])
            .await
            .unwrap()
            .payloads
            .remove(0);
        assert_eq!(copied.unit_id, None);
        copied.full_body = Some("#3891 report with different text".to_string());
        let report = submit_signal_message(&login, &env, copied.clone())
            .await
            .unwrap();
        let report_item =
            sigint_inbox_item::Entity::find_by_id(report.signal_message_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(report_item.unit_v2, original.unit_v2);
        let selection = crate::inbox::unit_selection::load_selections(
            &env.dbx,
            &[report.signal_message_id],
        )
        .await
        .unwrap();
        assert!(
            selection.is_empty(),
            "an inherited unit must not select a catalog match"
        );

        copied.unit_id = Some(catalog.id);
        let selected =
            submit_signal_message(&login, &env, copied).await.unwrap();
        assert_eq!(
            parsed_unit_id(&env.dbx, selected.signal_message_id).await,
            catalog.id
        );
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_created_one_unit_for_concurrent_requests() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let mut request = payload("  Новий/підрозділ 3535  ");
        request.create_unit = true;
        let (first, second) = tokio::join!(
            submit_signal_message(&login, &env, request.clone()),
            submit_signal_message(&login, &env, request),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        let units = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Name.eq("Новий/підрозділ 3535"))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(units.len(), 1);
        assert!(units[0].active);
        for created in [&first, &second] {
            assert_eq!(
                parsed_unit_id(&env.dbx, created.signal_message_id).await,
                units[0].id
            );
            assert_reconciled_selection(
                &env,
                created.signal_message_id,
                units[0].id,
            )
            .await;
        }
        let mut report = payload("Підрозділ донесення 3535");
        report.create_unit = true;
        report.signal_group_master_key = None;
        report.parent_signal_message_ids = vec![first.signal_message_id];
        let report = submit_signal_message(&login, &env, report).await.unwrap();
        let report_unit_id =
            parsed_unit_id(&env.dbx, report.signal_message_id).await;
        let report_unit = sigint_unit::Entity::find_by_id(report_unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(report_unit.active);
        assert_eq!(report_unit.name, "Підрозділ донесення 3535");
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_rolled_back_unit_creation_and_activation() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let unit = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Неактивний 3535".to_string()),
                ..Default::default()
            },
        )
        .await;
        let txn = env.dbx.begin().await.unwrap();
        let mut existing = payload(&unit.name);
        existing.unit_id = Some(unit.id);
        resolve_unit(&txn, &login, &existing, &[]).await.unwrap();
        let mut new = payload("Відкочений 3535");
        new.create_unit = true;
        resolve_unit(&txn, &login, &new, &[]).await.unwrap();
        txn.rollback().await.unwrap();
        assert!(
            !sigint_unit::Entity::find_by_id(unit.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert!(sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Name.eq("Відкочений 3535"))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    #[serial]
    async fn unit_search_3535_included_inactive_children_and_resolved_history()
    {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let mut children = vec![];
        for index in 0..55 {
            children.push(
                seed_unit(
                    &env.dbx,
                    &login,
                    CreateUnitReq {
                        name: Some(format!("Рота {index} 3535 полк")),
                        active: index == 0,
                        ..Default::default()
                    },
                )
                .await,
            );
        }
        let deleted = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Видалений 3535 полк".to_string()),
                active: true,
                ..Default::default()
            },
        )
        .await;
        let mut deleted = deleted.into_active_model();
        deleted.deleted = Set(true);
        let deleted = deleted.update(&env.dbx).await.unwrap();
        let mut request = UnitSearchReq {
            search: "3535 полк".to_string(),
            include_inactive: Some(true),
            names: None,
        };
        let found = unit::find_search_units(&env.dbx, &request).await.unwrap();
        assert_eq!(found.len(), children.len());
        request.include_inactive = None;
        assert_eq!(
            unit::find_search_units(&env.dbx, &request)
                .await
                .unwrap()
                .len(),
            1
        );
        request.include_inactive = Some(true);
        request.search.clear();
        request.names = Some(vec![
            children[1].name.clone(),
            deleted.name,
            "Невідомий лейбл".to_string(),
        ]);
        let history =
            unit::find_search_units(&env.dbx, &request).await.unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, children[1].id);
    }

    #[tokio::test]
    #[serial]
    async fn unit_search_3535_ranked_echelons_before_limiting_children() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let brigade = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                brigade: "123 омбр".to_string(),
                active: true,
                ..Default::default()
            },
        )
        .await;
        let battalion = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                battalion: "2 мб".to_string(),
                brigade: brigade.brigade.clone(),
                ..Default::default()
            },
        )
        .await;
        for index in 0..260 {
            seed_unit(
                &env.dbx,
                &login,
                CreateUnitReq {
                    company: format!("1 мр {index}"),
                    battalion: battalion.battalion.clone(),
                    brigade: brigade.brigade.clone(),
                    ..Default::default()
                },
            )
            .await;
        }
        let mut request = UnitSearchReq {
            search: "123 омб".to_string(),
            include_inactive: Some(true),
            names: None,
        };
        let found = unit::find_search_units(&env.dbx, &request).await.unwrap();
        assert_eq!(
            found.len(),
            crate::config::SIGINT_UNIT_SEARCH_INACTIVE_LIMIT as usize
        );
        assert_eq!(found[0].id, brigade.id);
        assert_eq!(found[1].id, battalion.id);
        assert!(found[2..].iter().all(|unit| !unit.company.is_empty()));
        request.include_inactive = None;
        let found = unit::find_search_units(&env.dbx, &request).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, brigade.id);
    }

    #[tokio::test]
    #[serial]
    async fn unit_search_3535_kept_exact_parent_visible_among_many_children() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let parent = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("3535 полк".to_string()),
                ..Default::default()
            },
        )
        .await;
        for index in 0..260 {
            seed_unit(
                &env.dbx,
                &login,
                CreateUnitReq {
                    name: Some(format!("1 рота {index} 3535 полк")),
                    ..Default::default()
                },
            )
            .await;
        }
        let found = unit::find_search_units(
            &env.dbx,
            &UnitSearchReq {
                search: parent.name.clone(),
                include_inactive: Some(true),
                names: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            found.len(),
            crate::config::SIGINT_UNIT_SEARCH_INACTIVE_LIMIT as usize
        );
        assert_eq!(found[0].id, parent.id);
        assert_eq!(found.iter().filter(|unit| unit.id == parent.id).count(), 1);
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_preserved_selection_on_edit_and_merge_and_cleared_changed_source(
    ) {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let selected = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Однакова назва 3535".to_string()),
                ..Default::default()
            },
        )
        .await;
        let survivor = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some(selected.name.clone()),
                active: true,
                ..Default::default()
            },
        )
        .await;
        let mut request = payload(&selected.name);
        request.unit_id = Some(selected.id);
        let created =
            submit_signal_message(&login, &env, request).await.unwrap();
        let mut inactive = selected.clone().into_active_model();
        inactive.active = Set(false);
        inactive.update(&env.dbx).await.unwrap();
        let mut edited = payload(&selected.name);
        edited.text = Some("#3535 edited body".to_string());
        edit_signal_message(&login, &env, created.signal_message_id, edited)
            .await
            .unwrap();
        assert_eq!(
            parsed_unit_id(&env.dbx, created.signal_message_id).await,
            selected.id
        );
        assert!(
            !sigint_unit::Entity::find_by_id(selected.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
        let txn = env.dbx.begin().await.unwrap();
        unit::merge_units_in_transaction(login, &txn, selected.id, survivor.id)
            .await
            .unwrap();
        txn.commit().await.unwrap();
        assert_reconciled_selection(
            &env,
            created.signal_message_id,
            survivor.id,
        )
        .await;
        edit_signal_message(
            &login,
            &env,
            created.signal_message_id,
            payload(""),
        )
        .await
        .unwrap();
        assert!(crate::entities::sigint_inbox_item_unit_selection::Entity::find_by_id(created.signal_message_id)
            .one(&env.dbx).await.unwrap().is_none());
        assert!(sigint_inbox_item_unit::Entity::find()
            .filter(
                sigint_inbox_item_unit::Column::ItemId
                    .eq(created.signal_message_id)
            )
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Parsed)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_invalidated_selection_after_raw_source_changes()
    {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let unit = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Підрозділ джерела 3535".to_string()),
                ..Default::default()
            },
        )
        .await;
        let mut request = payload(&unit.name);
        request.unit_id = Some(unit.id);
        let created =
            submit_signal_message(&login, &env, request).await.unwrap();
        let mut source = crate::entities::signal_message::Entity::find_by_id(
            created.signal_message_id,
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
        source.body = Set(Some("Змінене джерело без підрозділу".to_string()));
        source.update(&env.dbx).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut cache = TopKCache::<String, String>::new(64);
        crate::inbox::construct_inbox_item(
            env.settlements.clone(),
            &txn,
            &env.rq,
            &env.config,
            created.signal_message_id,
            &mut cache,
            None,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        assert!(crate::entities::sigint_inbox_item_unit_selection::Entity::find_by_id(created.signal_message_id).one(&env.dbx).await.unwrap().is_none());
        assert!(sigint_inbox_item_unit::Entity::find()
            .filter(
                sigint_inbox_item_unit::Column::ItemId
                    .eq(created.signal_message_id)
            )
            .filter(
                sigint_inbox_item_unit::Column::Kind
                    .eq(SigintInboxItemUnitKind::Parsed)
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    #[serial]
    async fn direct_submit_3535_rejected_invalid_creation_and_deleted_selection(
    ) {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let unit = seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("  Дубль\t 3535 ".to_string()),
                ..Default::default()
            },
        )
        .await;
        let mut request = payload("дубль 3535");
        request.create_unit = true;
        let txn = env.dbx.begin().await.unwrap();
        assert_eq!(
            resolve_unit(&txn, &login, &request, &[])
                .await
                .unwrap()
                .unwrap()
                .id,
            unit.id
        );
        txn.rollback().await.unwrap();
        seed_unit(
            &env.dbx,
            &login,
            CreateUnitReq {
                name: Some("Дубль 3535".to_string()),
                ..Default::default()
            },
        )
        .await;
        for name in ["дубль 3535", "  "] {
            request.unit = Some(name.to_string());
            let error = submit_signal_message(&login, &env, request.clone())
                .await
                .unwrap_err();
            assert!(
                matches!(error, crate::error::AppError::BL { .. }),
                "{error:?}"
            );
        }
        let mut deleted = unit.into_active_model();
        deleted.deleted = Set(true);
        let deleted = deleted.update(&env.dbx).await.unwrap();
        request.unit_id = Some(deleted.id);
        request.create_unit = false;
        assert!(matches!(
            submit_signal_message(&login, &env, request)
                .await
                .unwrap_err(),
            crate::error::AppError::NotFound
        ));
    }
}
