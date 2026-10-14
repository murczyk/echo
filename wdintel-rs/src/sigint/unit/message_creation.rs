use super::*;
use crate::config::SIGINT_DIRECT_SUBMIT_UNIT_LOCK_NAMESPACE;

#[post("/api/sigint/unit/create-for-message")]
pub async fn create_unit_for_message(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateUnitWithAutoNetworkReq>,
) -> Result<Json<Unit>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    ensure_unit_creation(&env.dbx, &login, &req.unit)
        .await
        .c(h!())?;
    Ok(Json(
        create_unit_for_message_for_login(&login, &env, req.into_inner())
            .await
            .c(h!())?,
    ))
}

async fn create_unit_for_message_for_login(
    login: &uuid::Uuid,
    env: &Env,
    mut req: CreateUnitWithAutoNetworkReq,
) -> anyhow::Result<Unit> {
    let name = unit_name_req(&req.unit);
    if name.trim().is_empty() {
        return Err(AppError::BL {
            msg: "Вкажіть назву нового підрозділу.".to_string(),
        })
        .c(h!());
    }
    clear_create_unit_orbit_note_if_hidden(&env.dbx, login, &mut req.unit)
        .await
        .c(h!())?;
    let transaction = begin_unit_creation_transaction(&env.dbx, &req.unit)
        .await
        .c(h!())?;
    lock_unit_name_for_creation(&transaction, &name)
        .await
        .c(h!())?;
    let units = find_exact_named_units(&transaction, &name).await.c(h!())?;
    let (unit, network_id, created_network) = match units.len() {
        0 => insert_message_unit(&transaction, login, env, &req)
            .await
            .c(h!())?,
        1 => (units.into_iter().next().c(h!())?, None, None),
        _ => {
            return Err(AppError::BL {
                msg: "Оберіть підрозділ зі списку.".to_string(),
            })
            .c(h!());
        }
    };
    transaction.commit().await.c(h!())?;
    Ok(render_created_unit_with_optional_network(
        login,
        env,
        unit,
        network_id,
        created_network,
    )
    .await
    .c(h!())?
    .unit)
}

async fn insert_message_unit(
    transaction: &DatabaseTransaction,
    login: &uuid::Uuid,
    env: &Env,
    req: &CreateUnitWithAutoNetworkReq,
) -> anyhow::Result<(
    sigint_unit::Model,
    Option<i64>,
    Option<sigint_network::Model>,
)> {
    let network_locations = if req.skip_network_creation {
        None
    } else {
        crate::system_settings::ensure_devices_section_enabled(&env.dbx)
            .await
            .c(h!())?;
        let locations = normalize_network_locations(req.locations.clone());
        if locations.is_empty() {
            return Err(AppError::BL {
                msg: "network locations are required".to_string(),
            })
            .c(h!());
        }
        Some(locations)
    };
    let unit = insert_merge_link_unit(transaction, login, &req.unit)
        .await
        .c(h!())?;
    let (network_id, created_network) = create_optional_unit_network(
        transaction,
        login,
        req,
        unit.id,
        network_locations,
    )
    .await
    .c(h!())?;
    Ok((unit, network_id, created_network))
}

pub(crate) async fn lock_unit_name_for_creation<C>(
    db: &C,
    name: &str,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock($1, hashtext($2))",
        [
            SIGINT_DIRECT_SUBMIT_UNIT_LOCK_NAMESPACE.into(),
            crate::inbox::unit_resolution::normalize_unit_label(name).into(),
        ],
    ))
    .await
    .c(h!())?;
    Ok(())
}

pub(crate) async fn find_exact_named_units<C>(
    db: &C,
    name: &str,
) -> anyhow::Result<Vec<sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = $1",
            [crate::inbox::unit_resolution::normalize_unit_label(name)],
        ))
        .order_by_asc(sigint_unit::Column::Id)
        .limit(2)
        .lock_exclusive()
        .all(db)
        .await
        .c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::cleanup;
    use serial_test::serial;

    fn request(name: &str) -> CreateUnitWithAutoNetworkReq {
        CreateUnitWithAutoNetworkReq {
            unit: CreateUnitReq {
                name: Some(name.to_string()),
                active: true,
                comment: "#3535 full message unit".to_string(),
                battalion: "3535 бат".to_string(),
                ..Default::default()
            },
            skip_network_creation: true,
            locations: vec![],
            unit_mask: vec![],
        }
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_reused_concurrent_normalized_names() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let (first, second) = tokio::join!(
            create_unit_for_message_for_login(
                &login,
                &env,
                request("Новий підрозділ 3535")
            ),
            create_unit_for_message_for_login(
                &login,
                &env,
                request("  НОВИЙ   ПІДРОЗДІЛ 3535  ")
            ),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.battalion, "3535 бат");
        assert_eq!(first.comment, "#3535 full message unit");
        assert_eq!(
            sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
            1
        );
        assert_eq!(
            sigint_unit_changelog::Entity::find()
                .filter(sigint_unit_changelog::Column::Action.eq("create"))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_reused_existing_without_overwriting_details() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let mut existing = request("Існуючий підрозділ 3535").unit;
        existing.active = false;
        existing.comment = "Збережений коментар".to_string();
        let (existing, _) =
            create_unit_for_login(&login, &env, existing).await.unwrap();
        let mut req = request("  ІСНУЮЧИЙ   ПІДРОЗДІЛ 3535 ");
        req.skip_network_creation = false;
        req.locations = vec!["Київ".to_string()];
        let reused = create_unit_for_message_for_login(&login, &env, req)
            .await
            .unwrap();
        assert_eq!(reused.id, existing.id);
        assert!(!reused.active);
        assert_eq!(reused.comment, "Збережений коментар");
        assert_eq!(
            sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
            1
        );
        assert_eq!(
            sigint_network::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_rejected_ambiguity_and_ignored_deleted_matches()
    {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let req = request("Неоднозначний підрозділ 3535");
        let (first, _) = create_unit_for_login(&login, &env, req.unit.clone())
            .await
            .unwrap();
        let (second, _) = create_unit_for_login(&login, &env, req.unit.clone())
            .await
            .unwrap();
        let error =
            create_unit_for_message_for_login(&login, &env, req.clone())
                .await
                .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<AppError>(),
            Some(AppError::BL { .. })
        ));
        assert_eq!(
            sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
            2
        );
        let mut second = second.into_active_model();
        second.deleted = Set(true);
        second.update(&env.dbx).await.unwrap();
        let reused = create_unit_for_message_for_login(&login, &env, req)
            .await
            .unwrap();
        assert_eq!(reused.id, first.id);
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_shared_direct_submit_name_lock() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let payload = serde_json::from_value(serde_json::json!({
            "text": "#3535 concurrent message creation",
            "unit": "  СПІЛЬНИЙ   ПІДРОЗДІЛ 3535 ",
            "create_unit": true,
            "signal_group_master_key": "vukho-test-master-key",
        }))
        .unwrap();
        let (created, submitted) = tokio::join!(
            create_unit_for_message_for_login(
                &login,
                &env,
                request("Спільний підрозділ 3535")
            ),
            crate::sigint::direct_submit::bl::submit_signal_message(
                &login, &env, payload
            ),
        );
        let created = created.unwrap();
        let submitted = submitted.unwrap();
        assert_eq!(
            sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
            1
        );
        let selection = crate::inbox::unit_selection::load_selections(
            &env.dbx,
            &[submitted.signal_message_id],
        )
        .await
        .unwrap();
        assert_eq!(selection[&submitted.signal_message_id].unit_id, created.id);
    }
}
