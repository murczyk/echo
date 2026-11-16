use super::*;
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, http::StatusCode, test, web, App, HttpMessage, HttpRequest,
    HttpResponse,
};
use serde_json::json;
use serial_test::serial;

async fn sign_in(
    request: HttpRequest,
    login: web::Path<String>,
) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

#[actix_web::test]
#[serial]
async fn issue_3873_goi_administration_requires_global_admin() {
    use super::goi::integrations::*;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let own = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let manager = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            roles: Set(json!(["Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Admin"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let txn = env.dbx.begin().await.unwrap();
    super::admins::replace_admin_logins(&txn, own.id, Some(&[manager.id.to_string()]), false)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    let store = RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
        .await
        .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route("/test-goi-login/{id}", web::post().to(sign_in))
            .service(list_admin_goi_integrations)
            .service(get_admin_goi_integration)
            .service(upsert_admin_goi_integration)
            .service(delete_admin_goi_integration),
    )
    .await;
    macro_rules! call {
        ($cookie:expr, $path:expr, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri($path)
                    .cookie($cookie.clone())
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let mut cookies = Vec::new();
    for id in [admin.id, manager.id] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/test-goi-login/{id}"))
                .to_request(),
        )
        .await;
        cookies.push(response.response().cookies().next().unwrap().into_owned());
    }
    let mut req = json!({
        "id":null,"owner_organism_id":own.id,"integration_type":"full",
        "ssh_host":"127.0.0.1","ssh_user":"test","ssh_port":22,"path":"/tmp",
        "api_host":"127.0.0.1","api_port":8088,"api_login":"fixture","api_password":"fixture-secret",
        "disable_goi_to_echo_palitra_sync":true,"pause_worker":true,
        "maintainer_login_id":null,"access_organism_ids":[own.id],"access_logins":[]
    });
    let created = call!(cookies[0], "/api/admin/goi/integration/upsert", &req);
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = test::read_body_json(created).await;
    let id = created["id"].as_i64().unwrap();
    req["id"] = json!(id);
    for (path, body) in [
        ("/api/admin/goi/integrations", json!({})),
        ("/api/admin/goi/integration", json!({"id":id})),
        ("/api/admin/goi/integration/upsert", req.clone()),
        ("/api/admin/goi/integration/delete", json!({"id":id})),
    ] {
        assert_eq!(
            call!(cookies[1], path, body).status(),
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    let listed = call!(cookies[0], "/api/admin/goi/integrations", json!({}));
    assert_eq!(listed.status(), StatusCode::OK);
    let loaded = call!(cookies[0], "/api/admin/goi/integration", json!({"id":id}));
    assert_eq!(loaded.status(), StatusCode::OK);
    let loaded: serde_json::Value = test::read_body_json(loaded).await;
    assert_eq!(loaded["api_password"], "fixture-secret");
    req["pause_worker"] = json!(false);
    let updated = call!(cookies[0], "/api/admin/goi/integration/upsert", &req);
    assert_eq!(updated.status(), StatusCode::OK);
    let updated: serde_json::Value = test::read_body_json(updated).await;
    assert_eq!(updated["pause_worker"], false);
    assert_eq!(
        call!(
            cookies[0],
            "/api/admin/goi/integration/delete",
            json!({"id":id})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(cookies[0], "/api/admin/goi/integration", json!({"id":id})).status(),
        StatusCode::NOT_FOUND
    );
}

#[actix_web::test]
#[serial]
async fn issue_3873_label_database_constraints_and_transfer_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let first = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let second = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let user = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(first.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let db = &env.dbx;
    let label = labels::OrganismUserLabel::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into organism_user_label (organism_id,name,color) values ($1,'Test','#87d7f1') returning *", [first.id.into()]))
        .one(db).await.unwrap().unwrap();
    let revision = labels::revision(db).await.unwrap();
    assert!(db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
        [user.id.into(), second.id.into()])).await.is_err());
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
        [user.id.into(), first.id.into()])).await.unwrap();
    assert!(db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into organism_user_label_assignment (login_id,organism_id,label_id) values ($1,$2,$3)",
        [user.id.into(), second.id.into(), label.id.into()])).await.is_err());
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into organism_user_label_assignment (login_id,organism_id,label_id) values ($1,$2,$3)",
        [user.id.into(), first.id.into(), label.id.into()])).await.unwrap();
    assert!(labels::revision(db).await.unwrap() > revision);
    login::Entity::update_many()
        .filter(login::Column::Id.eq(user.id))
        .col_expr(login::Column::OrganismId, Expr::value(second.id))
        .exec(db)
        .await
        .unwrap();
    let count = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select count(*)::bigint as count from organism_user_label_assignment where login_id=$1", [user.id.into()])).await.unwrap().unwrap();
    assert_eq!(count.try_get::<i64>("", "count").unwrap(), 0);
    let count = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"select count(*)::bigint as count from organism_message_stats_exclusion where login_id=$1"#,
        [user.id.into()])).await.unwrap().unwrap();
    assert_eq!(count.try_get::<i64>("", "count").unwrap(), 0);
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)"#,
        [user.id.into(), second.id.into()])).await.unwrap();
    login::Entity::update_many()
        .filter(login::Column::Id.eq(user.id))
        .col_expr(login::Column::DeletedPermanently, Expr::value(true))
        .exec(db)
        .await
        .unwrap();
    let count = db.query_one_raw(Statement::from_string(DbBackend::Postgres,
        r#"select count(*)::bigint as count from organism_message_stats_exclusion"#.to_owned())).await.unwrap().unwrap();
    assert_eq!(count.try_get::<i64>("", "count").unwrap(), 0);
}

#[actix_web::test]
#[serial]
async fn issue_3873_organism_admin_is_scoped_for_users_labels_and_settings() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let own = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            roles: Set(json!(["Basic", "Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let aor = crate::functest::tests::mk_organism_aor(
        &env.dbx,
        organism_aor::ActiveModel {
            organism_id: Set(own.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let foreign = mk_organism(&env.dbx, Default::default()).await.unwrap();
    mk_organism(
        &env.dbx,
        organism::ActiveModel {
            parent_id: Set(Some(own.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let zone = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap()
        .sigint_zone_id;
    let manager = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            roles: Set(json!(["No2FA"])),
            sigint_zone_id: Set(zone),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let txn = env.dbx.begin().await.unwrap();
    super::admins::replace_admin_logins(
        &txn,
        own.id,
        Some(&[manager.id.to_string()]),
        false,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let member = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            roles: Set(json!(["Basic"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let outside = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(foreign.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let profile_id = uuid::Uuid::new_v4().to_string();
    signal_profile::ActiveModel {
        uuid: Set(profile_id.clone()),
        created_at: Set(Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    login::Entity::update_many()
        .filter(login::Column::Id.eq(outside.id))
        .col_expr(
            login::Column::SignalProfileId,
            Expr::value(profile_id.clone()),
        )
        .exec(&env.dbx)
        .await
        .unwrap();
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route("/test-label-login/{id}", web::post().to(sign_in))
            .service(list_organisms)
            .service(update_organism)
            .service(add_group_to_organism)
            .service(remove_group_from_organism)
            .service(organism_available_groups_batch)
            .service(labels::list)
            .service(labels::upsert)
            .service(labels::assign)
            .service(labels::delete)
            .service(message_statistics::set_exclusion)
            .service(crate::users::list_logins)
            .service(crate::users::create_login)
            .service(crate::users::update_login)
            .service(crate::users::delete_login)
        .service(crate::organism::goi::integrations::check_goi_integration_connection),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test-label-login/{}", manager.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    macro_rules! call {
        ($path:expr, $body:expr) => {
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri($path)
                    .cookie(cookie.clone())
                    .set_json($body)
                    .to_request(),
            )
            .await
        };
    }
    let organisms: Vec<serde_json::Value> =
        test::read_body_json(call!("/api/organisms", json!({"sort_by": null})))
            .await;
    assert_eq!(organisms.len(), 1);
    assert_eq!(organisms[0]["id"], own.id);
    let users: serde_json::Value = test::read_body_json(call!(
        "/api/logins",
        json!({"sort_by": null, "filter_by_roles": null})
    ))
    .await;
    assert!(users["users"]
        .as_array()
        .unwrap()
        .iter()
        .all(|user| user["organism_id"] == own.id));
    for (path, body) in [
        ("/api/organism/user-labels", json!(foreign.id)),
        (
            "/api/organism/available-groups-batch",
            json!([own.id, foreign.id]),
        ),
        ("/api/login/delete", json!(outside.id)),
        (
            "/api/admin/goi/check-connection",
            json!({"ssh_host":"127.0.0.1","ssh_user":"test","ssh_port":22,"path":"/tmp"}),
        ),
        (
            "/api/organism/user-labels/upsert",
            json!({"id":null,"organism_id":foreign.id,"name":"Foreign","color":"#87d7f1"}),
        ),
        (
            "/api/organism/message-stats-exclusion",
            json!({"organism_id":foreign.id,"login_id":outside.id,"excluded":true}),
        ),
        (
            "/api/organism/message-stats-exclusion",
            json!({"organism_id":own.id,"login_id":outside.id,"excluded":true}),
        ),
    ] {
        assert_eq!(call!(path, body).status(), StatusCode::FORBIDDEN, "{path}");
    }
    for id in [member.id, manager.id] {
        assert_eq!(
            call!(
                "/api/organism/message-stats-exclusion",
                json!({"organism_id":own.id,"login_id":id,"excluded":true})
            )
            .status(),
            StatusCode::OK
        );
    }
    let exclusions: serde_json::Value =
        test::read_body_json(call!("/api/organism/user-labels", json!(own.id)))
            .await;
    assert_eq!(
        exclusions["excluded_login_ids"].as_array().unwrap().len(),
        2
    );
    for id in [member.id, manager.id] {
        assert!(exclusions["excluded_login_ids"]
            .as_array()
            .unwrap()
            .contains(&json!(id)));
        assert_eq!(
            call!(
                "/api/organism/message-stats-exclusion",
                json!({"organism_id":own.id,"login_id":id,"excluded":false})
            )
            .status(),
            StatusCode::OK
        );
    }
    let created = call!(
        "/api/login/create",
        json!({"login":"label-member-created","password":"test-label-password","roles":["Basic"],"organism_id":own.id})
    );
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = test::read_body_json(created).await;
    assert_eq!(created["sigint_zone_id"], json!(zone));
    assert_eq!(call!("/api/login/create", json!({"login":"forbidden-zone-member","password":"test-label-password","roles":["Basic"],"organism_id":own.id,"sigint_zone_id":999999})).status(), StatusCode::FORBIDDEN);
    let label: serde_json::Value = test::read_body_json(call!("/api/organism/user-labels/upsert", json!({"id":null,"organism_id":own.id,"name":"Аналітика","color":"#87d7f1"}))).await;
    let id = label["id"].as_i64().unwrap();
    assert_eq!(
        call!(
            "/api/organism/user-labels/assign",
            json!({"organism_id":own.id,"login_id":member.id,"label_id":id})
        )
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call!(
            "/api/organism/user-labels/assign",
            json!({"organism_id":own.id,"login_id":outside.id,"label_id":id})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(call!("/api/login/create", json!({"login":"forbidden-signal-member","password":"test-label-password","roles":["Basic"],"organism_id":own.id,"signal_profile_id":profile_id})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"signal_profile_id":profile_id})).status(), StatusCode::FORBIDDEN);
    let mut member_act = member.clone().into_active_model();
    member_act.signal_profile_id = Set(Some(profile_id.clone()));
    member_act.update(&env.dbx).await.unwrap();
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"signal_profile_id":null})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"signal_profile_id":profile_id})).status(), StatusCode::OK);
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"description":"preserved identity"})).status(), StatusCode::OK);
    assert_eq!(
        login::Entity::find_by_id(member.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .signal_profile_id,
        Some(profile_id)
    );
    let delta = delta_login::ActiveModel {
        login: Set(format!("outside-label-delta-{}", uuid::Uuid::new_v4())),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    login::Entity::update_many()
        .filter(login::Column::Id.eq(member.id))
        .col_expr(login::Column::DeltaLoginId, Expr::value(delta.id))
        .exec(&env.dbx)
        .await
        .unwrap();
    login::Entity::update_many()
        .filter(login::Column::Id.eq(outside.id))
        .col_expr(login::Column::DeltaLoginId, Expr::value(delta.id))
        .col_expr(login::Column::Deleted, Expr::value(true))
        .exec(&env.dbx)
        .await
        .unwrap();
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"delta_login":null})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!("/api/login/create", json!({"login":"forbidden-delta-member","password":"test-label-password","roles":["Basic"],"organism_id":own.id,"delta_login":delta.login})).status(), StatusCode::FORBIDDEN);
    for roles in [json!(["Admin"]), json!(["Api"]), json!(["Full"])] {
        assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"roles":roles})).status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":foreign.id})).status(), StatusCode::FORBIDDEN);
    assert_eq!(call!("/api/login/update", json!({"id":member.id,"login":member.login,"organism_id":own.id,"roles":["Rer"]})).status(), StatusCode::OK);
    let outside_after = login::Entity::find_by_id(outside.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outside_after.delta_login_id, Some(delta.id));
    assert_eq!(
        call!(
            "/api/organism/update",
            json!({"id":own.id,"parent_id":foreign.id,"enabled":true})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    for roles in [json!(["Basic", "Rer", "OrganismAdmin"]), json!(["Basic"])] {
        assert_eq!(call!("/api/organism/update", json!({"id":own.id,"parent_id":null,"enabled":true,"aor_ids":[aor.aor_id],"roles":roles})).status(), StatusCode::FORBIDDEN);
    }
    for aors in [json!([]), json!(null), json!([aor.aor_id + 1])] {
        assert_eq!(call!("/api/organism/update", json!({"id":own.id,"parent_id":null,"enabled":true,"aor_ids":aors,"roles":["Basic","Rer"]})).status(), StatusCode::FORBIDDEN);
    }
    for path in ["/api/organism/add-group", "/api/organism/remove-group"] {
        assert_eq!(
            call!(
                path,
                json!({"organism_id":own.id,"group_name":"not-accessible"})
            )
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(call!("/api/organism/update", json!({"id":own.id,"parent_id":null,"enabled":true,"name":"Updated own","aor_ids":[aor.aor_id],"roles":["Rer","Basic"]})).status(), StatusCode::OK);
    let saved = organism::Entity::find_by_id(own.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.name, "Updated own");
    assert_eq!(saved.roles, json!(["Rer", "Basic"]));
    assert_eq!(
        organism_aor::Entity::find()
            .filter(organism_aor::Column::OrganismId.eq(own.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .aor_id,
        aor.aor_id
    );

    assert_eq!(
        call!(
            "/api/organism/user-labels/delete",
            json!({"organism_id":own.id,"label_id":id})
        )
        .status(),
        StatusCode::OK
    );
    let state: serde_json::Value =
        test::read_body_json(call!("/api/organism/user-labels", json!(own.id)))
            .await;
    assert_eq!(state["assignments"], json!([]));
    assert_eq!(call!("/api/organism/update", json!({"id":own.id,"parent_id":null,"enabled":true,"name":"Delegated","aor_ids":[aor.aor_id],"roles":["Rer","Basic"],"admin_logins":[member.id.to_string()]})).status(), StatusCode::OK);
    assert_eq!(
        call!("/api/organism/user-labels", json!(own.id)).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "/api/organism/message-stats-exclusion",
            json!({"organism_id":own.id,"login_id":member.id,"excluded":true})
        )
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[actix_web::test]
#[serial]
async fn issue_3873_login_insert_and_delete_invalidate_sender_ownership() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let profile_id = uuid::Uuid::new_v4().to_string();
    signal_profile::ActiveModel {
        uuid: Set(profile_id.clone()),
        created_at: Set(Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let login = login::ActiveModel {
        organism_id: Set(Some(organism.id)),
        signal_profile_id: Set(Some(profile_id.clone())),
        ..Default::default()
    };
    mk_login(&env.dbx, login.clone()).await.unwrap();
    let mapping = Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!(
            "select organism_id from ({}) senders where sender=$1",
            labels::sender_mapping_sql()
        ),
        [profile_id.into()],
    );
    let owner = env
        .dbx
        .query_one_raw(mapping.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        owner.try_get::<Option<i64>>("", "organism_id").unwrap(),
        Some(organism.id)
    );
    let revision = labels::revision(&env.dbx).await.unwrap();
    let duplicate = mk_login(&env.dbx, login).await.unwrap();
    assert!(labels::revision(&env.dbx).await.unwrap() > revision);
    let ambiguous = env
        .dbx
        .query_one_raw(mapping.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        ambiguous.try_get::<Option<i64>>("", "organism_id").unwrap(),
        None
    );
    let revision = labels::revision(&env.dbx).await.unwrap();
    login::Entity::delete_by_id(duplicate.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    assert!(labels::revision(&env.dbx).await.unwrap() > revision);
    let owner = env.dbx.query_one_raw(mapping).await.unwrap().unwrap();
    assert_eq!(
        owner.try_get::<Option<i64>>("", "organism_id").unwrap(),
        Some(organism.id)
    );
}

#[actix_web::test]
#[serial]
async fn issue_4172_group_discovery_respects_managed_organism() {
    use crate::functest::tests::*;
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = &env.dbx;
    let own = mk_organism(db, Default::default()).await.unwrap();
    let parent = mk_organism(db, Default::default()).await.unwrap();
    let empty = mk_organism(db, Default::default()).await.unwrap();
    let aor = find_test_aor(db).await.unwrap();
    for organism_id in [own.id, parent.id] {
        mk_organism_aor(
            db,
            organism_aor::ActiveModel {
                organism_id: Set(organism_id),
                aor_id: Set(aor.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let first = find_test_signal_group(db).await.unwrap();
    let second = mk_signal_group(
        db,
        signal_group::ActiveModel {
            datasource_id: Set(first.datasource_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let zone = find_test_login(db).await.unwrap().sigint_zone_id.unwrap();
    mk_sigint_zone_datasource(
        db,
        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone),
            datasource_id: Set(second.datasource_id.unwrap()),
            group_master_key: Set(second.master_key.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_group_aor(
        db,
        signal_group_aor::ActiveModel {
            master_key: Set(second.master_key.clone()),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    organism_group::ActiveModel {
        organism_id: Set(own.id),
        signal_group_master_key: Set(first.master_key.clone()),
    }
    .insert(db)
    .await
    .unwrap();
    let manager = mk_login(
        db,
        login::ActiveModel {
            organism_id: Set(Some(own.id)),
            roles: Set(json!(["No2FA"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let txn = db.begin().await.unwrap();
    super::admins::replace_admin_logins(
        &txn,
        own.id,
        Some(&[manager.id.to_string()]),
        false,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .route("/test-label-login/{id}", web::post().to(sign_in))
            .service(group_list),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test-label-login/{}", manager.id))
            .to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    for (organism_id, roles, expected) in [
        (own.id, json!(["No2FA"]), vec![first.master_key.clone()]),
        (empty.id, json!(["No2FA"]), vec![]),
        (
            empty.id,
            json!(["Admin", "No2FA"]),
            vec![first.master_key.clone(), second.master_key.clone()],
        ),
    ] {
        let manager_id = manager.id;
        let mut manager = manager.clone().into_active_model();
        manager.organism_id = Set(Some(organism_id));
        manager.roles = Set(roles);
        manager.update(db).await.unwrap();
        organism_admin::Entity::delete_many()
            .exec(db)
            .await
            .unwrap();
        let txn = db.begin().await.unwrap();
        super::admins::replace_admin_logins(
            &txn,
            organism_id,
            Some(&[manager_id.to_string()]),
            false,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/organism/all-groups")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let groups: Vec<serde_json::Value> =
            test::read_body_json(response).await;
        let actual: std::collections::BTreeSet<_> = groups
            .iter()
            .map(|group| group["master_key"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(actual, expected.into_iter().collect());
    }
    let mut child = own.into_active_model();
    child.parent_id = Set(Some(parent.id));
    let child = child.update(db).await.unwrap();
    let manager_id = manager.id;
    let mut manager = manager.into_active_model();
    manager.organism_id = Set(Some(child.id));
    manager.roles = Set(json!(["No2FA"]));
    manager.update(db).await.unwrap();
    organism_admin::Entity::delete_many()
        .exec(db)
        .await
        .unwrap();
    let txn = db.begin().await.unwrap();
    super::admins::replace_admin_logins(
        &txn,
        child.id,
        Some(&[manager_id.to_string()]),
        false,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/organism/all-groups")
            .cookie(cookie)
            .to_request(),
    )
    .await;
    let groups: Vec<serde_json::Value> = test::read_body_json(response).await;
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0]["master_key"], first.master_key);
}

#[actix_web::test]
#[serial]
async fn organism_admin_assignments_are_independent_and_revocable() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let first = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let second = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let manager = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Basic"])),
            organism_id: Set(Some(first.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let member = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Basic"])),
            organism_id: Set(Some(second.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let txn = env.dbx.begin().await.unwrap();
    for organism_id in [first.id, second.id] {
        admins::replace_admin_logins(
            &txn,
            organism_id,
            Some(&[manager.id.to_string()]),
            false,
        )
        .await
        .unwrap();
    }
    txn.commit().await.unwrap();
    assert_eq!(
        access::administered_organism_ids(&env.dbx, manager.id)
            .await
            .unwrap(),
        vec![first.id, second.id]
    );
    let txn = env.dbx.begin().await.unwrap();
    assert!(admins::replace_admin_logins(
        &txn,
        first.id,
        Some(&[manager.id.to_string(), member.id.to_string()]),
        true
    )
    .await
    .is_err());
    assert_eq!(
        admins::collect_admin_logins(&txn, &[first.id])
            .await
            .unwrap()[&first.id],
        vec![manager.id.to_string()]
    );
    admins::replace_admin_logins(
        &txn,
        second.id,
        Some(&[manager.id.to_string(), member.id.to_string()]),
        true,
    )
    .await
    .unwrap();
    admins::replace_admin_logins(&txn, first.id, Some(&[]), true)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(
        access::administered_organism_ids(&env.dbx, manager.id)
            .await
            .unwrap(),
        vec![second.id]
    );
    let mut second = second.into_active_model();
    second.enabled = Set(false);
    second.update(&env.dbx).await.unwrap();
    assert!(access::administered_organism_ids(&env.dbx, manager.id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        login::Entity::find_by_id(manager.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .roles,
        json!(["Basic"])
    );
}

#[actix_web::test]
#[serial]
async fn organism_admin_migration_preserves_assignments_and_unrelated_roles() {
    use echo_migration::{MigratorTrait, SchemaManager};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let migration = echo_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| migration.name().ends_with("_organism_admins"))
        .unwrap();
    let schema = SchemaManager::new(&txn);
    migration.down(&schema).await.unwrap();
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            roles: Set(json!(["Basic", "OrganismAdmin"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut expected = Vec::new();
    for deleted in [false, true] {
        let login = mk_login(
            &txn,
            login::ActiveModel {
                organism_id: Set(Some(organism.id)),
                roles: Set(json!(["Basic", "OrganismAdmin", "No2FA"])),
                deleted: Set(deleted),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        expected.push(login.id.to_string());
    }
    let ordinary = mk_login(
        &txn,
        login::ActiveModel {
            organism_id: Set(Some(organism.id)),
            roles: Set(json!(["Basic"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    migration.up(&schema).await.unwrap();
    let actual = admins::collect_admin_logins(&txn, &[organism.id])
        .await
        .unwrap();
    expected.sort();
    assert_eq!(actual[&organism.id], expected);
    for id in &expected {
        assert_eq!(
            login::Entity::find_by_id(uuid::Uuid::parse_str(id).unwrap())
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .roles,
            json!(["Basic", "No2FA"])
        );
    }
    assert_eq!(
        login::Entity::find_by_id(ordinary.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .roles,
        json!(["Basic"])
    );
    assert_eq!(
        organism::Entity::find_by_id(organism.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap()
            .roles,
        json!(["Basic"])
    );
    migration.down(&schema).await.unwrap();
    for id in &expected {
        assert_eq!(
            login::Entity::find_by_id(uuid::Uuid::parse_str(id).unwrap())
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .roles,
            json!(["Basic", "No2FA", "OrganismAdmin"])
        );
    }
    txn.rollback().await.unwrap();
}
