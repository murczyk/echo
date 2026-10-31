use super::*;
use crate::entities::{signal_message, signal_message_group};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
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
    let [_admin, api, _other_api, sender_login] = accounts.as_slice() else {
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
            .service(crate::rer_importer::inbox::inbox_submit_v11)
            .service(crate::sigint::direct_submit::edit_message)
            .service(crate::rer_importer::inbox::delete_message)
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

    let send = |request: actix_test::TestRequest| {
        actix_test::call_service(&app, request.to_request())
    };
    verify_sender_access(&send, &env, &accounts, &cookies, &sender).await;
    verify_submission_authors(&send, &env, &accounts, &cookies, &sender).await;
    verify_sender_lifecycle(&send, &env, &accounts, &cookies, &sender).await;
}

async fn verify_sender_access<Fut>(
    send: &impl Fn(actix_test::TestRequest) -> Fut,
    env: &Env,
    accounts: &[login::Model],
    cookies: &[actix_web::cookie::Cookie<'static>],
    sender: &ApiSender,
) where
    Fut: std::future::Future<Output = actix_web::dev::ServiceResponse>,
{
    let [_admin, api, other_api, sender_login] = accounts else {
        unreachable!()
    };
    for (cookie, count) in [(cookies[1].clone(), 1), (cookies[2].clone(), 0)] {
        let response = send(
            actix_test::TestRequest::post()
                .uri("/api/echo-operator/fetch-senders")
                .cookie(cookie)
                .set_json(json!({"api_id": api.id})),
        )
        .await;
        assert!(response.status().is_success());
        let senders: Vec<serde_json::Value> =
            actix_test::read_body_json(response).await;
        assert_eq!(senders.len(), count);
        if count == 1 {
            assert_eq!(
                senders[0],
                json!({
                    "sender_uuid": sender.sender_uuid,
                    "display_name": sender.display_name,
                })
            );
        }
    }
    let request = json!({"api_id": api.id, "sender_uuid": sender.sender_uuid, "login_id": sender_login.id, "display_name": "Changed"});
    for cookie in [cookies[1].clone(), cookies[3].clone()] {
        for path in [
            "/api/admin/api-senders",
            "/api/admin/api-senders/upsert",
            "/api/admin/api-senders/delete",
        ] {
            let response = send(
                actix_test::TestRequest::post()
                    .uri(path)
                    .cookie(cookie.clone())
                    .set_json(&request),
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
        let response = send(request).await;
        assert!(!response.status().is_success());
    }
    for (actor, sender_id) in [
        (api.id, Uuid::new_v4()),
        (other_api.id, sender.sender_uuid),
        (sender_login.id, sender.sender_uuid),
    ] {
        assert!(resolve_login(&env.dbx, actor, Some(sender_id))
            .await
            .is_err());
    }
    for path in [
        "/api/1.1/message/1/edit",
        "/api/rer-importer/delete-message",
    ] {
        let response = send(
            actix_test::TestRequest::post()
                .uri(path)
                .cookie(cookies[1].clone())
                .set_json(json!({"id": 1, "sender_id": sender.sender_uuid})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

async fn verify_submission_authors<Fut>(
    send: &impl Fn(actix_test::TestRequest) -> Fut,
    env: &Env,
    accounts: &[login::Model],
    cookies: &[actix_web::cookie::Cookie<'static>],
    sender: &ApiSender,
) where
    Fut: std::future::Future<Output = actix_web::dev::ServiceResponse>,
{
    let [_admin, api, _other_api, sender_login] = accounts else {
        unreachable!()
    };
    for (index, expected_login) in [(1, Some(sender_login.id)), (2, None)] {
        let response = send(actix_test::TestRequest::post()
            .uri("/api/echo-operator/message/submit").cookie(cookies[index].clone())
            .set_json(json!({
                "instance_id": "sender-test",
                "message": format!("Sender attribution integration {index}"),
                "group": {"id": format!("sender-test-{index}"), "name": format!("Sender test {index}")},
                "profile": {"id": sender.sender_uuid, "name": "Client-supplied name"},
                "metadata": {}
            }))).await;
        assert!(response.status().is_success(), "{}", response.status());
        let response: serde_json::Value =
            actix_test::read_body_json(response).await;
        let expected_sender = expected_login
            .map(|id| id.to_string())
            .unwrap_or_else(|| format!("echo.{}", sender.sender_uuid));
        assert_message_attribution(
            &env.dbx,
            &response,
            Some(&expected_sender),
            expected_login,
        )
        .await;
    }
    for sender_id in [None, Some(sender.sender_uuid)] {
        let text = format!("Generic API sender {sender_id:?}");
        let response = send(
            actix_test::TestRequest::post()
                .uri("/api/1.1/submit")
                .cookie(cookies[1].clone())
                .set_json(json!({
                    "text": text,
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                    "group_names": ["Generic API sender test"],
                    "sender_id": sender_id,
                })),
        )
        .await;
        assert!(response.status().is_success(), "{}", response.status());
        let message = signal_message::Entity::find()
            .filter(signal_message::Column::Body.eq(text))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let expected_login = if sender_id.is_some() {
            sender_login.id
        } else {
            api.id
        };
        let expected_sender = sender_id.map(|_| expected_login.to_string());
        assert_message_attribution(
            &env.dbx,
            &json!({"message_uid": message.message_uid}),
            expected_sender.as_deref(),
            Some(expected_login),
        )
        .await;
    }
}

async fn verify_sender_lifecycle<Fut>(
    send: &impl Fn(actix_test::TestRequest) -> Fut,
    env: &Env,
    accounts: &[login::Model],
    cookies: &[actix_web::cookie::Cookie<'static>],
    sender: &ApiSender,
) where
    Fut: std::future::Future<Output = actix_web::dev::ServiceResponse>,
{
    let [admin, api, other_api, sender_login] = accounts else {
        unreachable!()
    };
    let request = json!({"api_id": api.id, "sender_uuid": sender.sender_uuid, "login_id": sender_login.id, "display_name": "Changed"});
    let mut changed = request;
    changed["display_name"] = json!("Renamed");
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/upsert")
            .cookie(cookies[0].clone())
            .set_json(&changed),
    )
    .await;
    assert!(response.status().is_success());
    let updated: ApiSender = actix_test::read_body_json(response).await;
    assert_eq!(updated.sender_uuid, sender.sender_uuid);
    assert_eq!(updated.display_name, "Renamed");
    changed["api_id"] = json!(other_api.id);
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/upsert")
            .cookie(cookies[0].clone())
            .set_json(&changed),
    )
    .await;
    assert!(!response.status().is_success());
    changed["api_id"] = json!(api.id);
    changed["login_id"] = json!(admin.id);
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/upsert")
            .cookie(cookies[0].clone())
            .set_json(&changed),
    )
    .await;
    assert!(response.status().is_success());
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/echo-operator/message/submit")
            .cookie(cookies[1].clone())
            .set_json(json!({
                "instance_id": "sender-test",
                "message": "Sender attribution integration 1",
                "group": {"id": "sender-test-1", "name": "Sender test 1"},
                "profile": {"id": "legacy-profile", "name": "Ignored"},
                "sender_id": sender.sender_uuid,
                "metadata": {}
            })),
    )
    .await;
    assert!(response.status().is_success());
    let response: serde_json::Value =
        actix_test::read_body_json(response).await;
    assert_distinct_mapped_submissions(
        &env.dbx,
        &response,
        sender_login.id,
        admin.id,
    )
    .await;
    let response = send(actix_test::TestRequest::post()
        .uri("/api/admin/api-senders/delete").cookie(cookies[0].clone())
        .set_json(json!({"api_id": other_api.id, "sender_uuid": sender.sender_uuid}))).await;
    assert!(response.status().is_success());
    assert_eq!(list(&env.dbx, api.id).await.unwrap().len(), 1);
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/admin/api-senders/delete")
            .cookie(cookies[0].clone())
            .set_json(
                json!({"api_id": api.id, "sender_uuid": sender.sender_uuid}),
            ),
    )
    .await;
    assert!(response.status().is_success());
    assert!(list(&env.dbx, api.id).await.unwrap().is_empty());
    let response = send(
        actix_test::TestRequest::post()
            .uri("/api/echo-operator/message/submit")
            .cookie(cookies[1].clone())
            .set_json(json!({
                "instance_id": "sender-test",
                "message": "After sender deletion",
                "group": {"id": "sender-test-1", "name": "Sender test 1"},
                "profile": {"id": sender.sender_uuid, "name": "Legacy"},
                "metadata": {}
            })),
    )
    .await;
    assert!(response.status().is_success());
    let response: serde_json::Value =
        actix_test::read_body_json(response).await;
    assert_message_attribution(
        &env.dbx,
        &response,
        Some(&format!("echo.{}", sender.sender_uuid)),
        None,
    )
    .await;
    let historical = signal_message::Entity::find()
        .filter(
            signal_message::Column::Body.eq("Sender attribution integration 1"),
        )
        .filter(signal_message::Column::LoginId.eq(sender_login.id))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(historical.login_id, Some(sender_login.id));
    for (path, body) in [
        (
            "/api/1.1/submit",
            json!({
                "text": "Deleted explicit sender",
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "group_names": ["Generic API sender test"],
                "sender_id": sender.sender_uuid,
            }),
        ),
        (
            "/api/echo-operator/message/submit",
            json!({
                "instance_id": "sender-test",
                "message": "Deleted explicit sender",
                "profile": {"id": "legacy", "name": "Legacy"},
                "group": {"id": "sender-test-1", "name": "Sender test 1"},
                "metadata": {},
                "sender_id": sender.sender_uuid,
            }),
        ),
    ] {
        let response = send(
            actix_test::TestRequest::post()
                .uri(path)
                .cookie(cookies[1].clone())
                .set_json(body),
        )
        .await;
        assert!(!response.status().is_success());
    }
}

async fn submitted_message(
    db: &DatabaseConnection,
    response: &serde_json::Value,
) -> signal_message::Model {
    signal_message::Entity::find()
        .filter(
            signal_message::Column::MessageUid
                .eq(response["message_uid"].as_str().unwrap()),
        )
        .one(db)
        .await
        .unwrap()
        .unwrap()
}

async fn assert_message_attribution(
    db: &DatabaseConnection,
    response: &serde_json::Value,
    sender: Option<&str>,
    login_id: Option<Uuid>,
) {
    let message = submitted_message(db, response).await;
    assert_eq!(message.sender.as_deref(), sender);
    assert_eq!(message.login_id, login_id);
    let group = signal_message_group::Entity::find()
        .filter(signal_message_group::Column::SignalMessageId.eq(message.id))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group.sender, message.sender);
    assert_eq!(group.login_id, login_id);
}

async fn assert_distinct_mapped_submissions(
    db: &DatabaseConnection,
    response: &serde_json::Value,
    original_login: Uuid,
    duplicate_login: Uuid,
) {
    let message = submitted_message(db, response).await;
    let original = signal_message::Entity::find()
        .filter(signal_message::Column::Body.eq(message.body.clone()))
        .filter(signal_message::Column::LoginId.eq(original_login))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(message.id, original.id);
    for (message, login_id) in
        [(original, original_login), (message, duplicate_login)]
    {
        assert_message_attribution(
            db,
            &json!({"message_uid": message.message_uid}),
            Some(&login_id.to_string()),
            Some(login_id),
        )
        .await;
    }
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

#[tokio::test]
#[serial]
async fn api_sender_deactivation_revokes_existing_attribution() {
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
    let account = mk_login(&env.dbx, Default::default()).await.unwrap();
    let request = UpsertApiSenderReq {
        api_id: api.id,
        login_id: account.id,
        display_name: "Operator".to_string(),
        sender_uuid: None,
    };
    let sender = save(&env.dbx, request.clone()).await.unwrap();
    for (deleted, deleted_permanently) in [(true, false), (true, true)] {
        let mut account = account.clone().into_active_model();
        account.deleted = Set(deleted);
        account.deleted_permanently = Set(deleted_permanently);
        account.update(&env.dbx).await.unwrap();

        assert!(find(&env.dbx, api.id, &sender.sender_uuid.to_string())
            .await
            .is_err());
        assert!(available_senders(api.id)
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
        assert!(save(&env.dbx, request.clone()).await.is_err());
    }
    let mut account = account.clone().into_active_model();
    account.deleted = Set(false);
    account.deleted_permanently = Set(false);
    let account = account.update(&env.dbx).await.unwrap();
    assert!(find(&env.dbx, api.id, &sender.sender_uuid.to_string())
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        available_senders(api.id).all(&env.dbx).await.unwrap().len(),
        1
    );

    let organism = mk_organism(&env.dbx, Default::default()).await.unwrap();
    let mut account = account.into_active_model();
    account.organism_id = Set(Some(organism.id));
    account.update(&env.dbx).await.unwrap();
    for (enabled, deleted_permanently) in [(false, false), (true, true)] {
        let mut organism = organism.clone().into_active_model();
        organism.enabled = Set(enabled);
        organism.deleted_permanently = Set(deleted_permanently);
        organism.update(&env.dbx).await.unwrap();
        assert!(find(&env.dbx, api.id, &sender.sender_uuid.to_string())
            .await
            .is_err());
        assert!(available_senders(api.id)
            .all(&env.dbx)
            .await
            .unwrap()
            .is_empty());
        assert!(save(&env.dbx, request.clone()).await.is_err());
    }
}
