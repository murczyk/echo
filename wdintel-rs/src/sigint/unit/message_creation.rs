use super::*;
use crate::config::{
    REDIS_MAXLEN, SIGINT_DIRECT_SUBMIT_UNIT_LOCK_NAMESPACE,
    SIGINT_MESSAGE_UNIT_PENDING_NETWORK_REDIS_PREFIX,
};
use redis::AsyncCommands;

#[post("/api/sigint/unit/create-for-message")]
pub async fn create_unit_for_message(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateUnitWithAutoNetworkReq>,
    context: actix_web::web::Query<MessageUnitCreationContext>,
) -> Result<Json<Unit>, AppError> {
    ensure_base_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    ensure_unit_creation(&env.dbx, &login, &req.unit)
        .await
        .c(h!())?;
    if let Some(message_id) = context.editing_message_id {
        ensure_message_unit_edit_access(&env, &login, message_id)
            .await
            .c(h!())?;
    } else {
        crate::users::role_settings::ensure_unit_creation(&env.dbx, &login)
            .await
            .c(h!())?;
    }
    Ok(Json(
        create_unit_for_message_for_login(&login, &env, req.into_inner())
            .await
            .c(h!())?,
    ))
}

#[derive(Deserialize)]
pub struct MessageUnitCreationContext {
    editing_message_id: Option<i64>,
}

async fn ensure_message_unit_edit_access(
    env: &Env,
    login: &Uuid,
    message_id: i64,
) -> anyhow::Result<()> {
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let logins = crate::users::get_organism_login_ids_by_id(&env.dbx, login)
        .await
        .c(h!())?;
    crate::sigint::direct_submit::query::find_editable_signal_message(
        &env.dbx, message_id, &groups, login, &logins,
    )
    .await
    .c(h!())?;
    Ok(())
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
    let retry_key = message_unit_network_retry_key(login, unit.id);
    if let Some(network) = created_network {
        enqueue_created_network_recalculations(&transaction, &network)
            .await
            .c(h!())?;
        env.redis
            .clone()
            .set::<_, _, ()>(&retry_key, network.id)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    let unit = render_created_unit_with_optional_network(
        login, env, unit, network_id, None,
    )
    .await
    .c(h!())?
    .unit;
    replay_message_unit_network(env, &name, &retry_key, unit.id)
        .await
        .c(h!())?;
    Ok(unit)
}

fn message_unit_network_retry_key(login: &uuid::Uuid, unit_id: i64) -> String {
    format!(
        "{SIGINT_MESSAGE_UNIT_PENDING_NETWORK_REDIS_PREFIX}{login}:{unit_id}"
    )
}

async fn replay_message_unit_network(
    env: &Env,
    name: &str,
    retry_key: &str,
    unit_id: i64,
) -> anyhow::Result<()> {
    let transaction = env.dbx.begin().await.c(h!())?;
    lock_unit_name_for_creation(&transaction, name)
        .await
        .c(h!())?;
    let mut redis = env.redis.clone();
    let network_id: Option<i64> = redis.get(retry_key).await.c(h!())?;
    let Some(network_id) = network_id else {
        return Ok(());
    };
    let network = sigint_network::Entity::find_by_id(network_id)
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .filter(sigint_network_unit::Column::UnitId.eq(unit_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_network::Column::ActiveTo.is_null())
        .one(&transaction)
        .await
        .c(h!())?;
    if network.is_some() {
        fanout_pending_message_unit_network(&mut redis, retry_key, network_id)
            .await
            .c(h!())?;
    } else {
        redis
            .del::<_, ()>(&[
                retry_key.to_string(),
                format!("{retry_key}:delivered"),
            ])
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn fanout_pending_message_unit_network(
    redis: &mut redis::aio::ConnectionManager,
    retry_key: &str,
    network_id: i64,
) -> anyhow::Result<()> {
    let mut sessions = crate::session::get_all_sessions(redis).await.c(h!())?;
    sessions.sort_by_key(|session| session.session_id);
    let script = redis::Script::new(
        r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
for i = 3, #KEYS do
    if redis.call('SISMEMBER', KEYS[2], KEYS[i]) == 0 then
        redis.call('XADD', KEYS[i], 'MAXLEN', '~', ARGV[2], '*', 'v', ARGV[3])
        redis.call('SADD', KEYS[2], KEYS[i])
    end
end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
        "#,
    );
    let mut invocation = script.prepare_invoke();
    invocation
        .key(retry_key)
        .key(format!("{retry_key}:delivered"));
    for session in sessions {
        invocation
            .key(crate::event_stream::session_stream_id(session.session_id));
    }
    invocation
        .arg(network_id)
        .arg(REDIS_MAXLEN)
        .arg(
            serde_json::to_string(&EventMsg::new(EventType::ETNetworkChanged))
                .c(h!())?,
        )
        .invoke_async::<i64>(redis)
        .await
        .c(h!())?;
    Ok(())
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
    use crate::functest::tests::{
        cleanup, cleanup_locked, mk_sigint_inbox_item, mk_sigint_network,
        mk_sigint_network_unit, mk_signal_group, mk_signal_message_group,
    };
    use redis::{streams::StreamRangeReply, AsyncCommands};
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

    async fn non_rer_inbox_item(dbx: &DatabaseConnection) -> i64 {
        let group = mk_signal_group(
            dbx,
            signal_group::ActiveModel {
                interseption_kind: Set(
                    sea_orm_active_enums::InterseptionKind::Other,
                ),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let item = mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                datetime: Set(Some(chrono::Utc::now().naive_utc())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(item.id),
                group_master_key: Set(Some(group.master_key)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        item.id
    }

    async fn take_session_events(
        redis: &mut redis::aio::ConnectionManager,
        session_id: uuid::Uuid,
    ) -> Vec<EventType> {
        let stream_id = crate::event_stream::session_stream_id(session_id);
        let reply: StreamRangeReply =
            redis.xrange_all(&stream_id).await.unwrap();
        redis::pipe()
            .del(&stream_id)
            .del(crate::event_stream::get_sess_key(session_id))
            .srem(crate::config::REDIS_SESSIONS_KEY, session_id.to_string())
            .query_async::<()>(redis)
            .await
            .unwrap();
        reply
            .ids
            .into_iter()
            .map(|entry| {
                let event: String = entry.get("v").unwrap();
                serde_json::from_str::<EventMsg>(&event).unwrap().event_type
            })
            .collect()
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_replayed_network_effects_after_commit_failure() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        super::super::tests::insert_settings(&env.dbx, true).await;
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let item_id = non_rer_inbox_item(&env.dbx).await;
        let mut req = request("Підрозділ повторного створення 3535");
        req.skip_network_creation = false;
        req.locations = vec!["Київ".to_string()];
        req.unit_mask = vec![req.unit.name.clone().unwrap()];
        let first_session_id = uuid::Uuid::new_v4();
        let second_session_id = uuid::Uuid::new_v4();
        let healthy_session_id =
            std::cmp::min(first_session_id, second_session_id);
        let session_id = std::cmp::max(first_session_id, second_session_id);
        let mut redis = env.redis.clone();
        crate::session::add_session(&mut redis, session_id, &login)
            .await
            .unwrap();
        let stream_id = crate::event_stream::session_stream_id(session_id);
        redis
            .set_ex::<_, _, ()>(&stream_id, "wrong stream type", 30)
            .await
            .unwrap();
        let failed =
            create_unit_for_message_for_login(&login, &env, req.clone()).await;
        assert!(failed.is_err());
        let units = find_exact_named_units(&env.dbx, &unit_name_req(&req.unit))
            .await
            .unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        let retry_key = message_unit_network_retry_key(&login, units[0].id);
        assert!(redis.exists::<_, bool>(&retry_key).await.unwrap());
        crate::session::add_session(&mut redis, healthy_session_id, &login)
            .await
            .unwrap();
        let healthy_stream_id =
            crate::event_stream::session_stream_id(healthy_session_id);
        for _ in 0..2 {
            assert!(replay_message_unit_network(
                &env,
                &unit_name_req(&req.unit),
                &retry_key,
                units[0].id,
            )
            .await
            .is_err());
        }
        let reply: StreamRangeReply =
            redis.xrange_all(&healthy_stream_id).await.unwrap();
        assert_eq!(reply.ids.len(), 1);
        assert!(redis.exists::<_, bool>(&retry_key).await.unwrap());
        assert!(redis
            .sismember::<_, _, bool>(
                format!("{retry_key}:delivered"),
                &healthy_stream_id,
            )
            .await
            .unwrap());
        redis.del::<_, ()>(&stream_id).await.unwrap();
        mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                unit_id: Set(units[0].id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        req.skip_network_creation = true;
        req.locations.clear();
        let retried =
            create_unit_for_message_for_login(&login, &env, req.clone())
                .await
                .unwrap();
        let repeated = create_unit_for_message_for_login(&login, &env, req)
            .await
            .unwrap();
        let events = take_session_events(&mut redis, session_id).await;
        let healthy_events =
            take_session_events(&mut redis, healthy_session_id).await;
        assert!(!redis.exists::<_, bool>(&retry_key).await.unwrap());
        assert!(!redis
            .exists::<_, bool>(format!("{retry_key}:delivered"))
            .await
            .unwrap());
        assert_eq!(retried.id, units[0].id);
        assert_eq!(repeated.id, retried.id);
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == EventType::ETNetworkChanged)
                .count(),
            1
        );
        assert_eq!(
            healthy_events
                .iter()
                .filter(|event| **event == EventType::ETNetworkChanged)
                .count(),
            1
        );
        assert_eq!(
            sigint_network::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_inbox_item_unit_tag_queue::Entity::find()
                .filter(
                    sigint_inbox_item_unit_tag_queue::Column::SigintInboxItemId
                        .eq(item_id),
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_rolled_back_partial_recalculations() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        super::super::tests::insert_settings(&env.dbx, true).await;
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let item_id = non_rer_inbox_item(&env.dbx).await;
        let mut req = request("Підрозділ відкату створення 3535");
        req.skip_network_creation = false;
        req.locations = vec!["Київ".to_string()];
        req.unit_mask = vec![req.unit.name.clone().unwrap()];
        env.dbx
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item_unit_tag_queue ADD CONSTRAINT \
                 message_unit_3535_rejected_queue CHECK (false) NOT VALID",
            )
            .await
            .unwrap();
        let failed =
            create_unit_for_message_for_login(&login, &env, req.clone()).await;
        env.dbx
            .execute_unprepared(
                "ALTER TABLE sigint_inbox_item_unit_tag_queue DROP CONSTRAINT \
                 message_unit_3535_rejected_queue",
            )
            .await
            .unwrap();
        assert!(failed.is_err());
        assert_eq!(
            sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
            0
        );
        assert_eq!(
            sigint_network::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        create_unit_for_message_for_login(&login, &env, req)
            .await
            .unwrap();
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_inbox_item_unit_tag_queue::Entity::find()
                .filter(
                    sigint_inbox_item_unit_tag_queue::Column::SigintInboxItemId
                        .eq(item_id),
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn message_unit_3535_reused_concurrent_normalized_names() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        super::super::tests::insert_settings(&env.dbx, true).await;
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let mut first_req = request("Новий підрозділ 3535");
        first_req.skip_network_creation = false;
        first_req.locations = vec!["Київ".to_string()];
        first_req.unit_mask = vec!["Новий підрозділ 3535".to_string()];
        let mut second_req = first_req.clone();
        second_req.unit.name = Some("  НОВИЙ   ПІДРОЗДІЛ 3535  ".to_string());
        let session_id = uuid::Uuid::new_v4();
        let mut redis = env.redis.clone();
        crate::session::add_session(&mut redis, session_id, &login)
            .await
            .unwrap();
        let (first, second) = tokio::join!(
            create_unit_for_message_for_login(&login, &env, first_req),
            create_unit_for_message_for_login(&login, &env, second_req),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.battalion, "3535 бат");
        assert_eq!(first.comment, "#3535 full message unit");
        let events = take_session_events(&mut redis, session_id).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| **event == EventType::ETNetworkChanged)
                .count(),
            1
        );
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
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
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let mut existing = request("Існуючий підрозділ 3535").unit;
        existing.active = false;
        existing.comment = "Збережений коментар".to_string();
        let (existing, _) =
            create_unit_for_login(&login, &env, existing).await.unwrap();
        non_rer_inbox_item(&env.dbx).await;
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                unit_mask: Set(serde_json::json!([existing.name])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(existing.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let session_id = uuid::Uuid::new_v4();
        let mut redis = env.redis.clone();
        crate::session::add_session(&mut redis, session_id, &login)
            .await
            .unwrap();
        let mut req = request("  ІСНУЮЧИЙ   ПІДРОЗДІЛ 3535 ");
        req.skip_network_creation = false;
        req.locations = vec!["Київ".to_string()];
        let reused =
            create_unit_for_message_for_login(&login, &env, req.clone())
                .await
                .unwrap();
        create_unit_for_message_for_login(&login, &env, req)
            .await
            .unwrap();
        let events = take_session_events(&mut redis, session_id).await;
        assert!(!events.contains(&EventType::ETNetworkChanged));
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
            1
        );
        assert_eq!(
            network_invalidation_task::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_unit_tag_queue::Entity::find()
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
