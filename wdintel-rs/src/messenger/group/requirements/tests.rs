use super::*;
use crate::entities::{
    device_name, login, sigint_unit, signal_message, system_settings,
};
use crate::functest::tests::{cleanup_locked, find_test_login};
use crate::sigint::direct_submit::{bl, types::DirectSubmitPayload};
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, http::StatusCode, test, web, App, HttpMessage, HttpRequest,
};
use sea_orm::{IntoActiveModel, PaginatorTrait, TransactionTrait};
use serde_json::json;

const GROUP: &str = "vukho-test-master-key";

fn payload(value: serde_json::Value) -> DirectSubmitPayload {
    serde_json::from_value(value).unwrap()
}

async fn sign_in(request: HttpRequest, id: web::Data<Uuid>) -> web::Json<()> {
    Identity::login(&request.extensions(), id.to_string()).unwrap();
    web::Json(())
}

// https://github.com/echoua/echo/issues/3935
#[actix_web::test]
#[serial_test::serial]
async fn group_requirements_3935_enforced_for_every_author_and_destination() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let author = find_test_login(&env.dbx).await.unwrap();
    let source = bl::submit_signal_message(
        &author.id,
        &env,
        payload(json!({
            "text": "Source 3935", "signal_group_master_key": GROUP
        })),
    )
    .await
    .unwrap();
    set(&env.dbx, GROUP, Some(true), Some(true)).await.unwrap();
    let before = signal_message::Entity::find()
        .count(&env.dbx)
        .await
        .unwrap();
    for roles in [
        json!(["Rer"]),
        json!(["Admin"]),
        json!(["CyberViewerRestricted"]),
    ] {
        let mut account = author.clone().into_active_model();
        account.roles = Set(roles);
        account.update(&env.dbx).await.unwrap();
        for extra in [
            json!({}),
            json!({"parent_signal_message_ids": [source.signal_message_id]}),
            json!({"copy_source_signal_message_ids": [source.signal_message_id]}),
            json!({"engaged_message_id": source.signal_message_id}),
        ] {
            let mut request = json!({"text": "Message 3935", "signal_group_master_key": GROUP});
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            if request.get("engaged_message_id").is_some() {
                request
                    .as_object_mut()
                    .unwrap()
                    .remove("signal_group_master_key");
            }
            let error =
                bl::submit_signal_message(&author.id, &env, payload(request))
                    .await
                    .unwrap_err();
            assert!(
                matches!(error, AppError::Form(ref errors) if errors.contains_key("unit") && errors.contains_key("deviceName")),
                "{error:?}"
            );
        }
    }
    assert_eq!(
        signal_message::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        before
    );
    let mut author = author.into_active_model();
    author.roles = Set(json!(["Admin"]));
    let author = author.update(&env.dbx).await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let device = device_name::ActiveModel {
        name: Set(Some("Device 3935".into())),
        login_id: Set(author.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .app_data(web::Data::new(author.id))
            .wrap(IdentityMiddleware::default())
            .wrap(
                SessionMiddleware::builder(store, Key::generate())
                    .cookie_secure(false)
                    .build(),
            )
            .route("/_3935/login", web::get().to(sign_in))
            .service(crate::sigint::direct_submit::submit_direct),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/_3935/login").to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    for (fields, status) in [
        (json!({"unit": "  "}), StatusCode::BAD_REQUEST),
        (json!({"unit": "Unit 3935"}), StatusCode::BAD_REQUEST),
        (
            json!({"unit": "Unit 3935", "device_name_id": -1}),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({"unit": "Unit 3935", "device_name_id": device.id}),
            StatusCode::OK,
        ),
    ] {
        let mut request =
            json!({"text": "Message 3935", "signal_group_master_key": GROUP});
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/1.1/submit-direct")
                .cookie(cookie.clone())
                .set_json(request)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), status);
    }
    // Reports kept locally have no destination requirements.
    bl::submit_signal_message(&author.id, &env, payload(json!({"text": "Local report 3935", "parent_signal_message_ids": [source.signal_message_id]}))).await.unwrap();
    // NULL is an unset requirement on an existing group.
    signal_group::ActiveModel {
        master_key: Set(GROUP.into()),
        is_sigint_unit_mandatory: Set(None),
        is_device_mandatory: Set(None),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    bl::submit_signal_message(
        &author.id,
        &env,
        payload(
            json!({"text": "Optional 3935", "signal_group_master_key": GROUP}),
        ),
    )
    .await
    .unwrap();
}

// https://github.com/echoua/echo/issues/3935
#[actix_web::test]
#[serial_test::serial]
async fn group_requirements_3935_unit_creation_required_editor_for_all_endpoints(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let author = find_test_login(&env.dbx).await.unwrap();
    let source = bl::submit_signal_message(
        &author.id,
        &env,
        payload(
            json!({"text": "Original 3935", "signal_group_master_key": GROUP}),
        ),
    )
    .await
    .unwrap();
    let store =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .app_data(web::Data::new(author.id))
            .wrap(IdentityMiddleware::default())
            .wrap(
                SessionMiddleware::builder(store, Key::generate())
                    .cookie_secure(false)
                    .build(),
            )
            .route("/_3935/login", web::get().to(sign_in))
            .service(crate::sigint::direct_submit::submit_direct)
            .service(crate::sigint::direct_submit::edit_message)
            .service(
                crate::sigint::unit::message_creation::create_unit_for_message,
            )
            .service(crate::sigint::unit::create_unit)
            .service(crate::sigint::unit::create_unit_with_auto_network),
    )
    .await;
    let response = test::call_service(
        &app,
        test::TestRequest::get().uri("/_3935/login").to_request(),
    )
    .await;
    let cookie = response.response().cookies().next().unwrap().into_owned();
    let unit = crate::sigint::unit::types::CreateUnitReq {
        name: Some("Unit 3935".into()),
        active: true,
        ..Default::default()
    };
    let full_unit = crate::sigint::unit::types::CreateUnitWithAutoNetworkReq {
        unit: unit.clone(),
        skip_network_creation: true,
        locations: vec![],
        unit_mask: vec![],
    };
    for roles in [json!(["Rer"]), json!(["Cyber"]), json!(["Full"])] {
        login::ActiveModel {
            id: Set(author.id),
            roles: Set(roles),
            ..Default::default()
        }
        .update(&env.dbx)
        .await
        .unwrap();
        for (endpoint, request) in [
            (
                "/api/1.1/submit-direct".to_string(),
                json!({"text": "Message 3935", "unit": "Unit 3935", "create_unit": true, "signal_group_master_key": GROUP}),
            ),
            (
                format!("/api/1.1/message/{}/edit", source.signal_message_id),
                json!({"text": "Edit 3935", "unit": "Unit 3935", "create_unit": true, "signal_group_master_key": GROUP}),
            ),
            (
                "/api/sigint/unit/create-for-message".into(),
                json!(full_unit),
            ),
            (
                "/api/sigint/unit/create-with-auto-network".into(),
                json!(full_unit),
            ),
            ("/api/sigint/unit/create".into(), json!(unit)),
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&endpoint)
                    .cookie(cookie.clone())
                    .set_json(request)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{endpoint}");
        }
    }
    assert_eq!(
        sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
        0
    );
    login::ActiveModel {
        id: Set(author.id),
        roles: Set(json!(["Rer", "UnitsEditor"])),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/sigint/unit/create-for-message")
            .cookie(cookie.clone())
            .set_json(full_unit)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    bl::submit_signal_message(&author.id, &env, payload(json!({"text": "New unit 3935", "unit": "Another unit 3935", "create_unit": true, "signal_group_master_key": GROUP}))).await.unwrap();
    assert_eq!(
        sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
        2
    );
}

// https://github.com/echoua/echo/issues/3935
#[tokio::test]
#[serial_test::serial]
async fn group_requirements_3935_generic_submit_validated_all_groups_and_stored_device(
) {
    use crate::entities::{datasource, sigint_inbox_item};
    use crate::functest::tests::find_test_datasource;
    use crate::rer_importer::inbox::submit_bl::submit_generic_inbox_message;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut author =
        find_test_login(&env.dbx).await.unwrap().into_active_model();
    author.roles = Set(json!(["Admin"]));
    let author = author.update(&env.dbx).await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let source = find_test_datasource(&env.dbx).await.unwrap();
    datasource::ActiveModel {
        id: Set(source.id),
        api_login_id: Set(Some(author.id)),
        enabled: Set(Some(true)),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let device = device_name::ActiveModel {
        name: Set(Some("Generic device 3935".into())),
        login_id: Set(author.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let request: InboxSubmitItem = serde_json::from_value(json!({
        "text": "Generic message 3935", "timestamp": "2026-11-04T08:00:00Z", "group_names": ["Optional 3935", "Required 3935"]
    })).unwrap();
    let env_data = web::Data::from(env.clone());
    submit_generic_inbox_message(
        &env_data,
        &author.id,
        &vec![author.id],
        request.clone(),
    )
    .await
    .unwrap();
    let key = format!(
        "echo.{}",
        &sha256::digest(format!("{}:Required 3935", author.id))[..32]
    );
    set(&env.dbx, &key, Some(true), Some(true)).await.unwrap();
    let before = signal_message::Entity::find()
        .count(&env.dbx)
        .await
        .unwrap();
    let error = submit_generic_inbox_message(
        &env_data,
        &author.id,
        &vec![author.id],
        request.clone(),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error, AppError::Form(ref errors) if errors.contains_key("unit") && errors.contains_key("deviceName")),
        "{error:?}"
    );
    assert_eq!(
        signal_message::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        before
    );
    let mut request = request;
    request.unit = Some("Generic unit 3935".into());
    request.device_name_id = Some(device.id);
    let submitted = submit_generic_inbox_message(
        &env_data,
        &author.id,
        &vec![author.id],
        request,
    )
    .await
    .unwrap();
    let item = sigint_inbox_item::Entity::find_by_id(submitted.inbox_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.device_name_id, Some(device.id));
    let txn = env.dbx.begin().await.unwrap();
    let mut cache = TopKCache::<String, String>::new(64);
    crate::inbox::construct_inbox_item(
        env.settlements.clone(),
        &txn,
        &env.rq,
        &env.config,
        submitted.signal_message_id,
        &mut cache,
        None,
    )
    .await
    .unwrap();
    let item = sigint_inbox_item::Entity::find_by_id(submitted.inbox_id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.device_name_id, Some(device.id));
    txn.commit().await.unwrap();
}
