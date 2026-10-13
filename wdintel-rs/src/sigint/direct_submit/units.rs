use super::types::DirectSubmitPayload;
use crate::config::SIGINT_DIRECT_SUBMIT_UNIT_LOCK_NAMESPACE;
use crate::entities::{sigint_inbox_item, sigint_unit};
use crate::sigint::unit::{self, types::CreateUnitReq};
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Statement,
};
use uuid::Uuid;

pub(super) async fn resolve_unit<C>(
    db: &C,
    login: &Uuid,
    payload: &DirectSubmitPayload,
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let name = payload.unit.as_deref().unwrap_or_default().trim();
    let unit = if let Some(id) = payload.unit_id {
        Some(
            sigint_unit::Entity::find_by_id(id)
                .filter(sigint_unit::Column::Deleted.eq(false))
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
            db.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT pg_advisory_xact_lock($1, hashtext($2))",
                [
                    SIGINT_DIRECT_SUBMIT_UNIT_LOCK_NAMESPACE.into(),
                    name.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase()
                        .into(),
                ],
            ))
            .await
            .c(h!())?;
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

async fn find_or_create_named_unit<C>(
    db: &C,
    login: &Uuid,
    name: &str,
    create: bool,
) -> anyhow::Result<Option<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = $1",
            [name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()],
        ))
        .order_by_asc(sigint_unit::Column::Id)
        .limit(2)
        .all(db)
        .await
        .c(h!())?;
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
        _ if create => anyhow::bail!("Оберіть підрозділ зі списку."),
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
    use crate::sigint::direct_submit::bl::submit_signal_message;
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
        resolve_unit(&txn, &login, &existing).await.unwrap();
        let mut new = payload("Відкочений 3535");
        new.create_unit = true;
        resolve_unit(&txn, &login, &new).await.unwrap();
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
}
