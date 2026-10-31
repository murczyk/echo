use super::*;
use crate::entities::{signal_message, signal_message_group};
use crate::functest::tests::{cleanup_locked, mk_login};
use actix_identity::IdentityMiddleware;
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, http::StatusCode, test as actix_test, App, HttpRequest,
    HttpResponse,
};
use serde_json::json;

async fn start_session(
    env: web::Data<Env>,
    request: HttpRequest,
    login_id: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    crate::users::start_user_session(
        &env,
        &request,
        login_id.into_inner(),
        &env.dbx,
    )
    .await
    .c(h!())?;
    Ok(HttpResponse::Ok().finish())
}

#[actix_web::test]
#[serial]
async fn api_senders_enforce_admin_management_and_api_scoping() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut accounts = Vec::new();
    for roles in [
        json!(["Admin"]),
        json!(["Api"]),
        json!(["Api"]),
        json!(["Rer"]),
    ] {
        accounts.push(
            mk_login(
                &env.dbx,
                login::ActiveModel {
                    roles: Set(roles),
                    ..Default::default()
                },
            )
            .await
            .unwrap(),
        );
    }
    let [_admin, api, other_api, sender_login] = accounts.as_slice() else {
        unreachable!()
    };
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = actix_test::init_service(
        App::new()
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(store, Key::generate()))
            .app_data(web::Data::from(env.clone()))
            .route("/test/session/{login_id}", web::post().to(start_session))
            .service(list_senders)
            .service(upsert_sender)
            .service(delete_sender)
            .service(fetch_senders)
            .service(crate::operator::message_submit),
    )
    .await;
    let mut cookies = Vec::new();
    for account in &accounts {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri(&format!("/test/session/{}", account.id))
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        cookies
            .push(response.response().cookies().next().unwrap().into_owned());
    }
    let response = actix_test::call_service(&app, actix_test::TestRequest::post()
        .uri("/api/admin/api-senders/upsert").cookie(cookies[0].clone())
        .set_json(json!({"api_id": api.id, "login_id": sender_login.id, "display_name": "  Operator Alice  "}))
        .to_request()).await;
    assert!(response.status().is_success());
    let sender: ApiSender = actix_test::read_body_json(response).await;
    assert_eq!(sender.display_name, "Operator Alice");
    assert_eq!(sender.login_id, sender_login.id);
    assert_eq!(sender.api_id, api.id);

    for (cookie, count) in [(cookies[1].clone(), 1), (cookies[2].clone(), 0)] {
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/echo-operator/fetch-senders")
                .cookie(cookie)
                .set_json(json!({"api_id": api.id}))
                .to_request(),
        )
        .await;
        assert!(response.status().is_success());
        let senders: Vec<ApiSender> =
            actix_test::read_body_json(response).await;
        assert_eq!(senders.len(), count);
        if count == 1 {
            assert_eq!(senders[0].sender_uuid, sender.sender_uuid);
        }
    }
    let request = json!({"api_id": api.id, "sender_uuid": sender.sender_uuid, "login_id": sender_login.id, "display_name": "Changed"});
    for cookie in [cookies[1].clone(), cookies[3].clone()] {
        for path in [
            "/api/admin/api-senders",
            "/api/admin/api-senders/upsert",
            "/api/admin/api-senders/delete",
        ] {
            let response = actix_test::call_service(
                &app,
                actix_test::TestRequest::post()
                    .uri(path)
                    .cookie(cookie.clone())
                    .set_json(&request)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }
    for cookie in [None, Some(cookies[0].clone()), Some(cookies[3].clone())] {
        let mut request = actix_test::TestRequest::post()
            .uri("/api/echo-operator/fetch-senders");
        if let Some(cookie) = cookie {
            request = request.cookie(cookie);
        }
        let response =
            actix_test::call_service(&app, request.to_request()).await;
        assert!(!response.status().is_success());
    }

    for (index, expected_login) in [(1, Some(sender_login.id)), (2, None)] {
        let response = actix_test::call_service(&app, actix_test::TestRequest::post()
            .uri("/api/echo-operator/message/submit").cookie(cookies[index].clone())
            .set_json(json!({
                "instance_id": "sender-test",
                "message": format!("Sender attribution integration {index}"),
                "group": {"id": format!("sender-test-{index}"), "name": format!("Sender test {index}")},
                "profile": {"id": sender.sender_uuid, "name": "Client-supplied name"},
                "metadata": {}
            })).to_request()).await;
        assert!(response.status().is_success(), "{}", response.status());
        let response: serde_json::Value =
            actix_test::read_body_json(response).await;
        let message = signal_message::Entity::find()
            .filter(
                signal_message::Column::MessageUid
                    .eq(response["message_uid"].as_str().unwrap()),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let expected_sender = expected_login
            .map(|id| id.to_string())
            .unwrap_or_else(|| format!("echo.{}", sender.sender_uuid));
        assert_eq!(message.sender.as_deref(), Some(expected_sender.as_str()));
        assert_eq!(message.login_id, expected_login);
        let group = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(message.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(group.sender, message.sender);
        assert_eq!(group.login_id, expected_login);
    }
    let mut changed = request;
    changed["display_name"] = json!("Renamed");
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/upsert")
            .cookie(cookies[0].clone())
            .set_json(&changed)
            .to_request(),
    )
    .await;
    assert!(response.status().is_success());
    let updated: ApiSender = actix_test::read_body_json(response).await;
    assert_eq!(updated.sender_uuid, sender.sender_uuid);
    assert_eq!(updated.display_name, "Renamed");
    changed["api_id"] = json!(other_api.id);
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/upsert")
            .cookie(cookies[0].clone())
            .set_json(&changed)
            .to_request(),
    )
    .await;
    assert!(!response.status().is_success());
    let response = actix_test::call_service(&app, actix_test::TestRequest::post()
        .uri("/api/admin/api-senders/delete").cookie(cookies[0].clone())
        .set_json(json!({"api_id": other_api.id, "sender_uuid": sender.sender_uuid})).to_request()).await;
    assert!(response.status().is_success());
    assert_eq!(list(&env.dbx, api.id).await.unwrap().len(), 1);
    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/delete")
            .cookie(cookies[0].clone())
            .set_json(
                json!({"api_id": api.id, "sender_uuid": sender.sender_uuid}),
            )
            .to_request(),
    )
    .await;
    assert!(response.status().is_success());
    assert!(list(&env.dbx, api.id).await.unwrap().is_empty());
}

#[tokio::test]
#[serial]
async fn api_senders_reject_blank_names_non_api_owners_and_missing_accounts() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let api = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Api"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let account = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for (api_id, login_id, display_name) in [
        (api.id, account.id, " \t\n"),
        (account.id, account.id, "Sender"),
        (api.id, Uuid::new_v4(), "Sender"),
    ] {
        assert!(save(
            &env.dbx,
            UpsertApiSenderReq {
                api_id,
                login_id,
                display_name: display_name.to_string(),
                sender_uuid: None,
            }
        )
        .await
        .is_err());
    }
    for (sql, expected_error) in [
        (
            r#"insert into api_sender (api_id, login_id, display_name) values ($1, $2, ' ')"#,
            "api_sender_display_name_check",
        ),
        (
            r#"insert into api_sender (api_id, login_id, display_name) values ($1, nullif($2::uuid, $2::uuid), 'Sender')"#,
            "not-null constraint",
        ),
    ] {
        let error = env
            .dbx
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                [api.id.into(), account.id.into()],
            ))
            .await
            .unwrap_err();
        assert!(error.to_string().contains(expected_error), "{error}");
    }
}
