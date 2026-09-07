use super::tests::start_test_user_session;
use super::*;
use crate::functest::tests::{find_test_login, mk_login, mk_organism};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{cookie::Key, test as actix_test, web, App};
use serial_test::serial;

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
            has_role(&env.dbx, &login.id, "Rer").await,
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
