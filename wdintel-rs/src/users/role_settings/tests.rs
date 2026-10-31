use super::*;
use crate::entities::{login, sigint_unit, signal_message, system_settings};
use crate::functest::tests::{cleanup_locked, find_test_login, mk_login};
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::{storage::RedisSessionStore, SessionMiddleware};
use actix_web::{
    cookie::Key, http::StatusCode, test, App, HttpMessage, HttpRequest,
};
use sea_orm::{IntoActiveModel, PaginatorTrait};
use serde_json::json;

async fn test_login(
    request: HttpRequest,
    id: web::Path<Uuid>,
) -> web::Json<()> {
    Identity::login(&request.extensions(), id.to_string()).unwrap();
    web::Json(())
}

async fn set_rules(
    db: &DatabaseConnection,
    role: &str,
    unit: bool,
    device: bool,
    allow_unit_creation: bool,
) {
    role_message_settings::Entity::delete_by_id(role)
        .exec(db)
        .await
        .unwrap();
    to_active(RoleMessageSettings {
        role: role.to_string(),
        unit_required: unit,
        device_required: device,
        allow_unit_creation,
    })
    .unwrap()
    .insert(db)
    .await
    .unwrap();
}

// https://github.com/echoua/echo/issues/3935
#[tokio::test]
#[serial_test::serial]
async fn role_settings_3935_combined_assigned_roles_and_respected_server_access(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let defaults = resolve(&env.dbx, &login.id).await.unwrap();
    assert!(
        !defaults.unit_required
            && !defaults.device_required
            && defaults.allow_unit_creation
    );

    let mut login = login.into_active_model();
    login.roles = Set(json!(["Rer", "Cyber", "NoAutoLogout"]));
    let login = login.update(&env.dbx).await.unwrap();
    let server_settings = system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    set_rules(&env.dbx, "Rer", true, true, false).await;
    set_rules(&env.dbx, "Cyber", true, true, false).await;
    let strict = resolve(&env.dbx, &login.id).await.unwrap();
    assert!(
        strict.unit_required
            && strict.device_required
            && !strict.allow_unit_creation
    );

    let mut server_settings = server_settings.into_active_model();
    server_settings.devices_section_enabled = Set(false);
    let server_settings = server_settings.update(&env.dbx).await.unwrap();
    let disabled = resolve(&env.dbx, &login.id).await.unwrap();
    assert!(
        disabled.unit_required
            && !disabled.device_required
            && !disabled.allow_unit_creation
    );

    let mut server_settings = server_settings.into_active_model();
    server_settings.devices_section_enabled = Set(true);
    server_settings.update(&env.dbx).await.unwrap();
    set_rules(&env.dbx, "Cyber", false, true, true).await;
    let combined = resolve(&env.dbx, &login.id).await.unwrap();
    assert!(
        !combined.unit_required
            && combined.device_required
            && combined.allow_unit_creation
    );
    set_rules(&env.dbx, "Rer", true, false, false).await;
    assert!(!resolve(&env.dbx, &login.id).await.unwrap().device_required);

    set_rules(&env.dbx, "Admin", false, false, true).await;
    set_rules(&env.dbx, "Cyber", true, true, false).await;
    set_rules(&env.dbx, "Rer", true, true, false).await;
    let strict = resolve(&env.dbx, &login.id).await.unwrap();
    assert!(
        strict.unit_required
            && strict.device_required
            && !strict.allow_unit_creation
    );
    let mut login = login.into_active_model();
    login.roles = Set(json!(["Rer"]));
    let login = login.update(&env.dbx).await.unwrap();
    assert!(!resolve(&env.dbx, &login.id).await.unwrap().device_required);
}

// https://github.com/echoua/echo/issues/3935
#[actix_web::test]
#[serial_test::serial]
async fn role_settings_3935_guarded_admin_crud_and_message_creation_endpoints()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let author = find_test_login(&env.dbx).await.unwrap();
    let mut author = author.into_active_model();
    author.roles = Set(json!(["Rer", "Cyber"]));
    let author = author.update(&env.dbx).await.unwrap();
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            roles: Set(json!(["Admin"])),
            ..Default::default()
        },
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
            .wrap(IdentityMiddleware::default())
            .wrap(
                SessionMiddleware::builder(store, Key::generate())
                    .cookie_secure(false)
                    .build(),
            )
            .route("/_3935/login/{id}", web::get().to(test_login))
            .service(list)
            .service(create)
            .service(update)
            .service(delete)
            .service(current)
            .service(crate::sigint::direct_submit::submit_direct)
            .service(crate::sigint::direct_submit::edit_message)
            .service(
                crate::sigint::unit::message_creation::create_unit_for_message,
            ),
    )
    .await;
    let mut cookies = Vec::new();
    for id in [author.id, admin.id] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/_3935/login/{id}"))
                .to_request(),
        )
        .await;
        cookies
            .push(response.response().cookies().next().unwrap().into_owned());
    }
    let rules = json!({"role": "Rer", "unitRequired": true, "deviceRequired": false, "allowUnitCreation": false});
    for endpoint in ["list", "create", "update", "delete"] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&format!("/api/admin/role-message-settings/{endpoint}"))
                .cookie(cookies[0].clone())
                .set_json(&rules)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{endpoint}");
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/role-message-settings/create")
            .cookie(cookies[1].clone())
            .set_json(&rules)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/role-message-settings/create")
            .cookie(cookies[1].clone())
            .set_json(&rules)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        role_message_settings::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        1
    );
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/role-message-settings/list")
            .cookie(cookies[1].clone())
            .to_request(),
    )
    .await;
    let response: RoleMessageSettingsListRsp =
        test::read_body_json(response).await;
    assert_eq!(response.settings[0].role, "Rer");
    assert!(response.roles.contains(&"Rer".to_string()));
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri("/api/1.1/submit-direct/settings")
            .cookie(cookies[0].clone())
            .to_request(),
    )
    .await;
    let response: MessageCreationSettings =
        test::read_body_json(response).await;
    assert!(response.unit_required && !response.allow_unit_creation);

    let before = signal_message::Entity::find()
        .count(&env.dbx)
        .await
        .unwrap();
    for (payload, status) in [
        (
            json!({"text": "Message", "unit": "  ", "signal_group_master_key": "vukho-test-master-key"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text": "Report", "parent_signal_message_ids": [1]}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"text": "Message", "unit": "Forbidden unit 3935", "create_unit": true, "signal_group_master_key": "vukho-test-master-key"}),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/1.1/submit-direct")
                .cookie(cookies[0].clone())
                .set_json(&payload)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), status);
    }
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/sigint/unit/create-for-message")
            .cookie(cookies[0].clone())
            .set_json(
                crate::sigint::unit::types::CreateUnitWithAutoNetworkReq {
                    unit: crate::sigint::unit::types::CreateUnitReq {
                        name: Some("Forbidden unit 3935".to_string()),
                        active: true,
                        ..Default::default()
                    },
                    skip_network_creation: true,
                    locations: vec![],
                    unit_mask: vec![],
                },
            )
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        signal_message::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        sigint_unit::Entity::find().count(&env.dbx).await.unwrap(),
        0
    );

    let mut relaxed = rules.clone();
    relaxed["unitRequired"] = json!(false);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/role-message-settings/update")
            .cookie(cookies[1].clone())
            .set_json(&relaxed)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!resolve(&env.dbx, &author.id).await.unwrap().unit_required);
    let response = test::call_service(&app, test::TestRequest::post()
        .uri("/api/1.1/submit-direct").cookie(cookies[0].clone())
        .set_json(json!({"text": "Allowed message 3935", "signal_group_master_key": "vukho-test-master-key"})).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let message: serde_json::Value = test::read_body_json(response).await;
    let message_id = message["signal_message_id"].as_i64().unwrap();

    set_rules(&env.dbx, "Rer", true, true, false).await;
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let response = test::call_service(&app, test::TestRequest::post()
        .uri("/api/1.1/submit-direct").cookie(cookies[0].clone())
        .set_json(json!({"text": "Report without device 3935", "unit": "Existing label", "parent_signal_message_ids": [message_id]}))
        .to_request()).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: serde_json::Value = test::read_body_json(response).await;
    assert!(error["message"].as_str().unwrap().contains("пристрою"));
    let response = test::call_service(&app, test::TestRequest::post()
        .uri(&format!("/api/1.1/message/{message_id}/edit")).cookie(cookies[0].clone())
        .set_json(json!({"text": "Edited message 3935", "signal_group_master_key": "vukho-test-master-key"}))
        .to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = test::call_service(&app, test::TestRequest::post()
        .uri(&format!("/api/sigint/unit/create-for-message?editing_message_id={message_id}"))
        .cookie(cookies[0].clone())
        .set_json(crate::sigint::unit::types::CreateUnitWithAutoNetworkReq {
            unit: crate::sigint::unit::types::CreateUnitReq { name: Some("Edit unit 3935".to_string()), active: true, ..Default::default() },
            skip_network_creation: true, locations: vec![], unit_mask: vec![],
        }).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/admin/role-message-settings/delete")
            .cookie(cookies[1].clone())
            .set_json(json!({"role": "Rer"}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        resolve(&env.dbx, &author.id)
            .await
            .unwrap()
            .allow_unit_creation
    );
}
