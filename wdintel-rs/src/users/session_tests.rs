use super::tests::start_test_user_session;
use super::*;
use crate::functest::tests::{find_test_login, mk_login, mk_organism};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{cookie::Key, test as actix_test, web, App};
use serial_test::serial;

async fn request_password_login(
    env: &Env,
    login: &str,
    password: &str,
) -> (actix_web::http::StatusCode, serde_json::Value, bool) {
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = actix_test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .app_data(web::Data::new(env.clone()))
            .service(user_login),
    )
    .await;
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/user/login")
            .set_json(serde_json::json!({"user": login, "password": password}))
            .to_request(),
    )
    .await;
    let status = response.status();
    let has_cookie = response.response().cookies().next().is_some();
    (
        status,
        actix_test::read_body_json(response).await,
        has_cookie,
    )
}

async fn create_password_login_fixture(
    env: &Env,
    key: &str,
    enrolled: bool,
    secret: &str,
) -> login::Model {
    let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            password: Set(Some(
                argon2::hash_encoded(
                    b"test-password",
                    b"test-2fa-salt",
                    &argon2::Config::default(),
                )
                .unwrap(),
            )),
            password_auth_enabled: Set(true),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    if enrolled {
        crate::entities::login_totp::ActiveModel {
            login_id: Set(login.id),
            totp_secret: Set(totp_crypto::encrypt_secret(
                key, login.id, secret,
            )
            .unwrap()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
    }
    login
}

#[actix_web::test]
#[serial]
async fn issue_3568_two_factor_setting_controls_password_login() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let key = crate::storage::generate_strongbox_key_b64();
    let mut with_key = (*env).clone();
    with_key.config.totp_strongbox_key = Some(key.clone());
    let mut without_key = with_key.clone();
    without_key.config.totp_strongbox_key = None;
    assert!(crate::system_settings::two_factor_auth_enabled(&env.dbx)
        .await
        .unwrap());

    for enrolled in [false, true] {
        let secret = "JBSWY3DPEHPK3PXP";
        let login =
            create_password_login_fixture(&env, &key, enrolled, secret).await;
        for enabled in [None, Some(false), Some(true)] {
            crate::entities::system_settings::Entity::delete_many()
                .exec(&env.dbx)
                .await
                .unwrap();
            crate::entities::system_settings::ActiveModel {
                two_factor_auth_enabled: Set(enabled),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            let selected_env = if enabled == Some(false) {
                &without_key
            } else {
                &with_key
            };
            let (status, body, has_cookie) = request_password_login(
                selected_env,
                &login.login,
                "test-password",
            )
            .await;
            assert_eq!(status, actix_web::http::StatusCode::OK);
            let response: LoginRsp = serde_json::from_value(body).unwrap();
            match (enabled, enrolled, response) {
                (Some(false), _, LoginRsp::Authenticated) => {
                    assert!(has_cookie)
                }
                (None | Some(true), true, LoginRsp::Needs2fa { .. }) => {
                    assert!(!has_cookie)
                }
                (None | Some(true), false, LoginRsp::Needs2faSetup { .. }) => {
                    assert!(!has_cookie)
                }
                unexpected => {
                    panic!("unexpected login outcome: {unexpected:?}")
                }
            }
            assert_eq!(
                login_totp::find_secret(&env.dbx, login.id, &key)
                    .await
                    .unwrap(),
                enrolled.then(|| secret.to_string())
            );
            if enabled == Some(false) {
                let (status, _, has_cookie) = request_password_login(
                    selected_env,
                    &login.login,
                    "wrong-password",
                )
                .await;
                assert_eq!(status, actix_web::http::StatusCode::BAD_REQUEST);
                assert!(!has_cookie);
            }
        }
    }
}

#[tokio::test]
#[serial]
async fn active_login_rejects_ineligible_accounts() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for (deleted, permanent, reason, enabled, organism_permanent) in [
        (
            true,
            false,
            Some(DeactivationReasonEnum::Admin),
            true,
            false,
        ),
        (
            true,
            false,
            Some(DeactivationReasonEnum::Inactive),
            true,
            false,
        ),
        (false, true, None, true, false),
        (false, false, None, false, false),
        (false, false, None, true, true),
    ] {
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                enabled: Set(enabled),
                deleted_permanently: Set(organism_permanent),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                organism_id: Set(Some(organism.id)),
                deleted: Set(deleted),
                deleted_permanently: Set(permanent),
                deactivation_reason: Set(reason),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            ensure_base_role_by_id(&env.dbx, &login.id).await,
            Err(AppError::Unauthenticated)
        ));
        assert!(matches!(
            update_last_active_at(&env.dbx, &login.id).await,
            Err(AppError::Unauthenticated)
        ));
        let unchanged = login::Entity::find_by_id(login.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.last_active_at, login.last_active_at);
    }

    let login = mk_login(&env.dbx, Default::default()).await.unwrap();
    assert!(login.organism_id.is_none());
    has_role(&env.dbx, &login.id, "Rer").await.unwrap();
    update_last_active_at(&env.dbx, &login.id).await.unwrap();
    assert!(matches!(
        has_role(&env.dbx, &login.id, "Admin").await,
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        has_role(&env.dbx, &Uuid::now_v7(), "Rer").await,
        Err(AppError::Unauthenticated)
    ));
}

#[tokio::test]
#[serial]
async fn issue_3568_rer_or_cyber_access_preserves_role_boundaries() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for (roles, allowed) in [
        (vec!["Rer"], true),
        (vec!["Cyber"], true),
        (vec!["Rer", "Cyber"], true),
        (vec!["Admin"], true),
        (vec!["Full"], true),
        (vec!["Basic"], false),
        (vec!["DeviceSource"], false),
        (vec!["Api"], false),
        (vec!["ApiAgent"], false),
        (vec![], false),
    ] {
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(roles)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let result = ensure_base_role_by_id(&env.dbx, &login.id).await;
        if allowed {
            result.unwrap();
            has_role(&env.dbx, &login.id, "Basic").await.unwrap();
        } else {
            assert!(matches!(result, Err(AppError::Forbidden(_))), "{roles:?}");
        }
        if roles == ["Cyber"] {
            for role in ["Rer", "Admin", "UnitsEditor", "CallsignsEditor"] {
                assert!(matches!(
                    has_role(&env.dbx, &login.id, role).await,
                    Err(AppError::Forbidden(_))
                ));
            }
            let mut login = login.into_active_model();
            login.deleted = Set(true);
            let login = login.update(&env.dbx).await.unwrap();
            assert!(matches!(
                ensure_base_role_by_id(&env.dbx, &login.id).await,
                Err(AppError::Unauthenticated)
            ));
        }
    }
}

async fn set_test_login_blocked(
    db: &DatabaseConnection,
    blocked: bool,
) -> anyhow::Result<login::Model> {
    let mut login = find_test_login(db).await.c(h!())?.into_active_model();
    login.deleted = Set(blocked);
    login.deactivation_reason = Set(if blocked {
        Some(DeactivationReasonEnum::Admin)
    } else {
        None
    });
    login.update(db).await.c(h!())
}

async fn check_test_session_role(
    env: web::Data<Env>,
    user: Identity,
) -> Result<Json<()>, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    Ok(Json(()))
}

#[actix_web::test]
#[serial]
async fn blocked_session_returns_401_and_is_cleared() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let session_store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = actix_test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session_store, Key::generate()))
            .app_data(web::Data::from(env.clone()))
            .route("/test/login", web::post().to(start_test_user_session))
            .route("/test/role", web::post().to(check_test_session_role))
            .route(
                "/test/identity",
                web::get().to(|user: Option<Identity>| async move {
                    Json(user.is_some())
                }),
            )
            .service(api_user)
            .service(keep_alive),
    )
    .await;
    for path in ["/api/user", "/api/user/keep-alive"] {
        set_test_login_blocked(&env.dbx, false).await.unwrap();
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/test/login")
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let cookie = response.response().cookies().next().unwrap().into_owned();
        let blocked = set_test_login_blocked(&env.dbx, true).await.unwrap();
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/test/role")
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNAUTHORIZED
        );
        let request = if path == "/api/user" {
            actix_test::TestRequest::get()
        } else {
            actix_test::TestRequest::post()
                .set_json(KeepAliveReq { page_id: None })
        };
        let response = actix_test::call_service(
            &app,
            request.uri(path).cookie(cookie.clone()).to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNAUTHORIZED
        );
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/test/identity")
                .cookie(cookie)
                .to_request(),
        )
        .await;
        assert!(!actix_test::read_body_json::<bool, _>(response).await);
        assert_eq!(
            find_test_login(&env.dbx).await.unwrap().last_active_at,
            blocked.last_active_at
        );
    }
}

#[actix_web::test]
#[serial]
async fn blocked_login_and_totp_keep_form_errors() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let login = set_test_login_blocked(&env.dbx, true).await.unwrap();
    let mut redis = env.redis.clone();
    let challenge = totp_challenge::create_verify_challenge(
        &mut redis,
        login.id,
        login_totp::epoch_of(&login),
    )
    .await
    .unwrap();
    let totp_challenge::CreateChallengeOutcome::Created(challenge_id) =
        challenge
    else {
        panic!("expected a fresh challenge");
    };
    let app = actix_test::init_service(
        App::new()
            .app_data(web::Data::from(env))
            .service(user_login)
            .service(user_confirm_2fa),
    )
    .await;
    for (path, body) in [
        (
            "/api/user/login",
            serde_json::json!({"user": login.login, "password": "wrong"}),
        ),
        (
            "/api/user/confirm-2fa",
            serde_json::json!({"challenge_id": challenge_id, "token": "000000"}),
        ),
    ] {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(path)
                .set_json(body)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::BAD_REQUEST);
        let errors: Vec<(String, String)> =
            actix_test::read_body_json(response).await;
        assert!(errors.iter().any(|(field, message)| {
            field == "login" && message.contains("заблокований адміністратором")
        }));
    }
    assert!(totp_challenge::get_challenge(&mut redis, challenge_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial]
async fn issue_3569_cyber_viewer_permissions_are_additive() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    for extra in [
        None,
        Some("Cyber"),
        Some("Rer"),
        Some("Full"),
        Some("Admin"),
    ] {
        let mut roles = vec!["CyberViewer"];
        roles.extend(extra);
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                roles: Set(serde_json::json!(roles)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        ensure_base_role_by_id(&env.dbx, &login.id).await.unwrap();
        has_role(&env.dbx, &login.id, "Basic").await.unwrap();
        let write =
            has_any_role(&env.dbx, &login.id, vec!["Rer", "Cyber"]).await;
        assert_eq!(write.is_ok(), extra.is_some());
        if extra.is_none() {
            assert!(matches!(write, Err(AppError::Forbidden(_))));
            assert!(!role_matches(
                &roles.iter().map(|r| String::from(*r)).collect::<Vec<_>>(),
                "Rer"
            )
            .unwrap());
        }
    }
}

#[actix_web::test]
#[serial]
async fn issue_3569_viewer_cannot_create_or_edit_messages_or_reports() {
    use crate::entities::{bgtask, signal_message};
    use crate::sigint::direct_submit::{edit_message, submit_direct};
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let mut login = login.into_active_model();
    login.roles = Set(serde_json::json!(["CyberViewer"]));
    login.update(&env.dbx).await.unwrap();
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = actix_test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .app_data(web::Data::from(env.clone()))
            .route("/test/session", web::post().to(start_test_user_session))
            .service(submit_direct)
            .service(edit_message)
            .service(crate::rer_importer::import_csv::rer_csv_import)
            .service(crate::rer_importer::import_csv::rer_delta_csv_import)
            .service(crate::rer_importer::import_kmz::rer_delta_kmz_import)
            .service(crate::rer_importer::inbox::inbox_submit)
            .service(crate::tags::inbox_message_tags_add)
            .service(crate::tags::inbox_message_tags_rm)
            .service(crate::tags::inbox_message_tags_model_error),
    )
    .await;
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/test/session")
            .to_request(),
    )
    .await;
    assert!(response.status().is_success());
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let before = signal_message::Entity::find().all(&env.dbx).await.unwrap();
    let tasks_before = bgtask::Entity::find().all(&env.dbx).await.unwrap();
    for (uri, payload) in [
        (
            "/api/1.1/submit-direct",
            serde_json::json!({"text": "forbidden"}),
        ),
        (
            "/api/1.1/submit-direct",
            serde_json::json!({"text": "forbidden report", "parent_signal_message_ids": [1]}),
        ),
        (
            "/api/1.1/message/1/edit",
            serde_json::json!({"text": "forbidden edit"}),
        ),
        (
            "/api/rer-importer/inbox/submit",
            serde_json::json!({"messages": []}),
        ),
        (
            "/api/tags/tags-add",
            serde_json::json!({"message_id": 1, "tag_id": 1}),
        ),
        (
            "/api/tags/tags-rm",
            serde_json::json!({"message_id": 1, "tag_id": 1}),
        ),
        (
            "/api/tags/tag-model-error",
            serde_json::json!({"message_id": 1, "tag_id": 1}),
        ),
    ] {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(uri)
                .cookie(cookie.clone())
                .set_json(payload)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::FORBIDDEN);
    }
    for uri in [
        "/api/rer/csv-import",
        "/api/rer/delta-csv-import",
        "/api/rer/delta-kmz-import",
    ] {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(uri)
                .cookie(cookie.clone())
                .insert_header((
                    "Content-Type",
                    "multipart/form-data; boundary=echo-3569",
                ))
                .set_payload(
                    "--echo-3569\r\nContent-Disposition: form-data; name=\"file\"; filename=\"import.csv\"\r\nContent-Type: text/csv\r\n\r\nforbidden import\r\n--echo-3569--\r\n",
                )
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::FORBIDDEN,
            "{uri}"
        );
    }
    let tasks_after = bgtask::Entity::find().all(&env.dbx).await.unwrap();
    assert_eq!(tasks_before, tasks_after);
    let after = signal_message::Entity::find().all(&env.dbx).await.unwrap();
    assert_eq!(before, after);
}
