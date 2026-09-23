use super::*;
use crate::functest::tests::{cleanup_locked, find_test_login, mk_login};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{cookie::Key, test, web, App};
use sea_orm::{ActiveModelTrait, IntoActiveModel};
use serial_test::serial;

// #3575: equal labels must never merge account identity or ownership.
#[tokio::test]
#[serial]
async fn issue_3575_display_names_preserve_identity() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let first = mk_login(&env.dbx, Default::default()).await.unwrap();
    let second = mk_login(&env.dbx, Default::default()).await.unwrap();
    for account in [&first, &second] {
        let saved =
            save_display_name(&env.dbx, account.id, Some("  Сокіл 🦅  "))
                .await
                .unwrap();
        assert_eq!(saved.display_name.as_deref(), Some("Сокіл 🦅"));
        assert_eq!(saved.login, account.login);
        assert_eq!(saved.id, account.id.to_string());
        let stored = login::Entity::find_by_id(account.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.login, account.login);
        assert_eq!(stored.roles, account.roles);
        assert_eq!(stored.sigint_zone_id, account.sigint_zone_id);
        assert_eq!(stored.password, account.password);
    }
    let request = AuthorIdentitiesReq {
        logins: vec![first.login.clone()],
        ids: vec![second.id.to_string()],
    };
    let resolved = find_authors(&env.dbx, &request).await.unwrap();
    assert_eq!(resolved.len(), 2);
    assert_ne!(resolved[0].id, resolved[1].id);
    for invalid in [
        "я".repeat(101),
        "two\nlines".into(),
        "tab\tname".into(),
        "control\u{7f}".into(),
        "line\u{2028}break".into(),
    ] {
        assert!(save_display_name(&env.dbx, first.id, Some(&invalid))
            .await
            .is_err());
    }
    assert!(
        save_display_name(&env.dbx, first.id, Some(&"я".repeat(100)))
            .await
            .is_ok()
    );
    for empty in [Some("  "), None] {
        assert_eq!(
            save_display_name(&env.dbx, first.id, empty)
                .await
                .unwrap()
                .display_name,
            None
        );
    }
    let mut removed = second.into_active_model();
    removed.deleted_permanently = Set(true);
    removed.update(&env.dbx).await.unwrap();
    assert_eq!(find_authors(&env.dbx, &request).await.unwrap().len(), 1);
    assert!(find_authors(
        &env.dbx,
        &AuthorIdentitiesReq {
            logins: vec![first.login; 201],
            ids: vec![]
        }
    )
    .await
    .is_err());
}

// #3575: the writable account is taken from the session, never the payload.
#[actix_web::test]
#[serial]
async fn issue_3575_display_name_endpoint_is_self_only() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let owner = find_test_login(&env.dbx).await.unwrap();
    let other = mk_login(&env.dbx, Default::default()).await.unwrap();
    let session_store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(session_store, Key::generate()))
            .app_data(web::Data::from(env.clone()))
            .route(
                "/test/login",
                web::post().to(super::super::tests::start_test_user_session),
            )
            .service(save)
            .service(authors)
            .service(super::super::api_user),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/user/display-name")
            .set_json(serde_json::json!({"display_name":"Сокіл"}))
            .to_request(),
    )
    .await;
    assert!(!response.status().is_success());
    let response = test::call_service(
        &app,
        test::TestRequest::post().uri("/test/login").to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let response = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/user/display-name")
            .cookie(cookie.clone())
            .set_json(
                serde_json::json!({"display_name":"Сокіл", "id":other.id}),
            )
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), actix_web::http::StatusCode::BAD_REQUEST);
    let response = test::call_service(
        &app,
        test::TestRequest::put()
            .uri("/api/user/display-name")
            .cookie(cookie.clone())
            .set_json(serde_json::json!({"display_name":"Сокіл"}))
            .to_request(),
    )
    .await;
    assert!(response.status().is_success());
    let saved: AuthorIdentity = test::read_body_json(response).await;
    assert_eq!(saved.id, owner.id.to_string());
    assert_eq!(
        login::Entity::find_by_id(other.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        None
    );
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/user")
            .cookie(cookie)
            .to_request(),
    )
    .await;
    let current: super::super::types::User =
        test::read_body_json(response).await;
    assert_eq!(current.name, owner.login);
    assert_eq!(current.display_name.as_deref(), Some("Сокіл"));
}
