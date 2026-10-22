use crate::entities::{login, organism, signal_message, signal_message_group};
use crate::functest::tests::*;
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{cookie::Key, test, web, App, HttpMessage, HttpRequest};
use sea_orm::*;
use uuid::Uuid;

async fn login_reader(
    request: HttpRequest,
    login: web::Data<Uuid>,
) -> web::Json<()> {
    Identity::login(&request.extensions(), login.to_string()).unwrap();
    web::Json(())
}

// https://github.com/echoua/echo/issues/3612
#[actix_web::test]
#[serial_test::serial]
async fn replies_3612_reader_could_reply_without_gaining_ordinary_message_write_access(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let author = find_test_login(&env.dbx).await.unwrap();
    organism::ActiveModel {
        id: Set(author.organism_id.unwrap()),
        roles: Set(serde_json::json!([])),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(serde_json::json!(["CyberViewerRestricted"])),
            organism_id: Set(author.organism_id),
            sigint_zone_id: Set(author.sigint_zone_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let source = mk_signal_message(
        &env.dbx,
        signal_message::ActiveModel {
            body: Set(Some("Readable source".into())),
            login_id: Set(Some(author.id)),
            datasource_group_id: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_message_group(
        &env.dbx,
        signal_message_group::ActiveModel {
            signal_message_id: Set(source.id),
            group_master_key: Set(Some("vukho-test-master-key".into())),
            datasource_group_id: Set(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let sessions =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .app_data(web::Data::new(reader.id))
            .wrap(IdentityMiddleware::default())
            .wrap(
                SessionMiddleware::builder(sessions, Key::generate())
                    .cookie_secure(false)
                    .build(),
            )
            .route("/_3612/login", web::get().to(login_reader))
            .service(crate::sigint::direct_submit::submit_direct)
            .service(super::message_replies),
    )
    .await;
    let login_response = test::call_service(
        &app,
        test::TestRequest::get().uri("/_3612/login").to_request(),
    )
    .await;
    let cookie = login_response
        .response()
        .cookies()
        .next()
        .unwrap()
        .into_owned();
    let plain = test::call_service(&app, test::TestRequest::post().uri("/api/1.1/submit-direct")
        .cookie(cookie.clone()).set_json(serde_json::json!({ "text": "Not allowed", "signal_group_master_key": "vukho-test-master-key" })).to_request()).await;
    assert_eq!(plain.status(), actix_web::http::StatusCode::FORBIDDEN);
    let unit = test::call_service(&app, test::TestRequest::post().uri("/api/1.1/submit-direct")
        .cookie(cookie.clone()).set_json(serde_json::json!({ "text": "Not allowed", "unit": "Protected unit", "cited_signal_message_ids": [source.id] })).to_request()).await;
    assert_eq!(unit.status(), actix_web::http::StatusCode::FORBIDDEN);
    let reply = test::call_service(&app, test::TestRequest::post().uri("/api/1.1/submit-direct")
        .cookie(cookie.clone()).set_json(serde_json::json!({ "text": "Reader reply", "cited_signal_message_ids": [source.id] })).to_request()).await;
    assert!(
        reply.status().is_success(),
        "{}",
        String::from_utf8_lossy(&test::read_body(reply).await)
    );
    let response = test::call_service(&app, test::TestRequest::post().uri("/api/rer-importer/message-replies")
        .cookie(cookie).set_json(serde_json::json!({ "signal_message_ids": [source.id], "screen": "Analysis" })).to_request()).await;
    assert!(response.status().is_success());
    let response: super::types::MessageRepliesRsp =
        test::read_body_json(response).await;
    assert_eq!(response.replies.len(), 1);
    assert!(response
        .reply_messages
        .iter()
        .any(|message| message.preview == "Reader reply"));
}
