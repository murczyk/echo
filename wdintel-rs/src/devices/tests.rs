use self::schema::device_active_model;
use crate::config::{
    IDENTITY_DURATION_HOURS, ROLE_CYBER, ROLE_DEVICE_ANALYST,
    ROLE_DEVICE_SOURCE,
};
use crate::entities::{
    area_of_responsibility, login, organism, sigint_unit, system_settings,
};
use crate::file_registry::entities::file_entry;
use crate::functest::tests::{
    cleanup_locked, mk_aor, mk_login, mk_organism, mk_sigint_unit,
};
use crate::types::Mode;
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::storage::RedisSessionStore;
use actix_session::SessionMiddleware;
use actix_web::cookie::{Cookie, Key};
use actix_web::web::ServiceConfig;
use actix_web::{
    http::StatusCode, test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn configure_routes(cfg: &mut ServiceConfig) {
    cfg.service(super::devices::list)
        .service(super::devices::unit_stats)
        .service(super::devices::aors)
        .service(super::devices::units)
        .service(super::devices::detail)
        .service(super::devices::create)
        .service(super::devices::update)
        .service(super::files::roots)
        .service(super::files::subtree_counts)
        .service(super::files::browse)
        .service(super::files::search)
        .service(super::files::journal)
        .service(super::files::sync);
}

async fn login(request: HttpRequest, login: web::Path<String>) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

#[actix_web::test]
#[serial_test::serial]
async fn target_api_smoke_covers_all_routes() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login_name = format!("device-api-{}", Uuid::now_v7());
    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(login_name.clone()),
            roles: Set(json!([ROLE_DEVICE_ANALYST])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login_id = login.id;
    let lookup_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Device API lookup AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let lookup_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(login_id),
            name: Set("Device API lookup unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-api-other-{}", Uuid::now_v7())),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_device = device_active_model(
        &other_login.login,
        other_organism.id,
        "Other organism API source",
        None,
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();

    let config = env.config.clone();
    let (metrics, metrics_recorder) =
        crate::telemetry::Metrics::recording(&config);
    std::sync::Arc::get_mut(&mut env).unwrap().metrics = Some(metrics);
    let redis_session_store =
        RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        IDENTITY_DURATION_HOURS * 60 * 60,
                    )))
                    .build(),
            )
            .wrap(SessionMiddleware::new(redis_session_store, Key::generate()))
            .route("/test/login/{login}", web::post().to(self::login))
            .configure(configure_routes),
    )
    .await;

    let login_response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{login_id}"))
            .to_request(),
    )
    .await;
    assert_eq!(login_response.status(), StatusCode::NO_CONTENT);
    let session_cookie: Cookie<'static> = login_response
        .response()
        .cookies()
        .next()
        .unwrap()
        .into_owned();

    macro_rules! post_json {
        ($path:expr, $body:expr) => {{
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri($path)
                    .cookie(session_cookie.clone())
                    .set_json(&$body)
                    .to_request(),
            )
            .await
        }};
    }

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/aors")
            .cookie(session_cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let aors: Value = test::read_body_json(response).await;
    assert!(aors.as_array().unwrap().iter().any(|aor| {
        aor["id"].as_i64() == Some(lookup_aor.id)
            && aor["name"].as_str() == Some(lookup_aor.name.as_str())
    }));

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/units")
            .cookie(session_cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let units: Value = test::read_body_json(response).await;
    assert!(units["units"].as_array().unwrap().iter().any(|unit| {
        unit["id"].as_i64() == Some(lookup_unit.id)
            && unit["name"].as_str() == Some(lookup_unit.name.as_str())
    }));

    let response = post_json!(
        "/api/device/create",
        json!({
            "source_label": "API source",
            "external_url": "https://example.com/device",
            "custom_fields": {"inventory_id": "api-1"}
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let created: Value = test::read_body_json(response).await;
    let device_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], Value::Null);
    assert_eq!(created["aors"], json!([]));
    assert_eq!(created["unit"], Value::Null);

    let response = post_json!(
        "/api/device/update",
        json!({"device_id": device_id, "name": "API analytical name"})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let updated: Value = test::read_body_json(response).await;
    assert_eq!(updated["name"], "API analytical name");

    let response = post_json!("/api/device/list", json!({}));
    assert_eq!(response.status(), StatusCode::OK);
    let list: Value = test::read_body_json(response).await;
    assert_eq!(list["total"], 1);
    assert_eq!(list["list"][0]["id"], device_id);

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/unit-stats")
            .cookie(session_cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let stats: Value = test::read_body_json(response).await;
    assert_eq!(stats, json!({"units": []}));

    let response =
        post_json!("/api/device/detail", json!({"device_id": device_id}));
    assert_eq!(response.status(), StatusCode::OK);
    let detail: Value = test::read_body_json(response).await;
    assert_eq!(detail["name"], "API analytical name");

    let response =
        post_json!("/api/device/detail", json!({"device_id": other_device.id}));
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = post_json!(
        "/api/device/files/sync",
        json!({
            "device_id": device_id,
            "path_syntax": "posix",
            "files": [
                {
                    "absolute_path": "/reports/bad.txt",
                    "file_metadata_created_at": "not-a-timestamp"
                },
                {
                    "absolute_path": "/reports/good.txt",
                    "mime_type": "text/plain",
                    "extension": "txt",
                    "file_metadata_modified_at": "2026-07-23T12:00:00+03:00"
                }
            ]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let sync: Value = test::read_body_json(response).await;
    assert_eq!(sync["results"][0]["status"], "rejected");
    assert_eq!(sync["results"][0]["error"]["kind"], "validation");
    assert_eq!(sync["results"][1]["status"], "accepted");
    env.metrics.as_ref().unwrap().force_flush_for_test();
    assert_eq!(
        metrics_recorder.counter_value(
            "echo.device_files.synchronized.count",
            &[("operation", "created")],
        ),
        Some(1)
    );
    assert_eq!(sync["results"][1]["file"]["has_content"], false);
    assert!(sync["results"][1]["file"].get("content_path").is_none());
    let good_file_id = Uuid::parse_str(
        sync["results"][1]["file"]["file_id"].as_str().unwrap(),
    )
    .unwrap();
    let mut good_file = file_entry::Entity::find_by_id(good_file_id)
        .one(env.file_registry_db.connection())
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    good_file.content_path =
        Set(Some(format!("devices/{device_id}/content/good.txt")));
    good_file
        .update(env.file_registry_db.connection())
        .await
        .unwrap();
    let root_id = sync["results"][1]["root"]["entry_id"]
        .as_str()
        .unwrap()
        .to_string();

    let response =
        post_json!("/api/device/files/roots", json!({"device_id": device_id}));
    assert_eq!(response.status(), StatusCode::OK);
    let roots: Value = test::read_body_json(response).await;
    assert_eq!(roots["roots"].as_array().unwrap().len(), 1);
    assert_eq!(roots["roots"][0]["entry_id"], root_id);
    assert!(roots["roots"][0].get("subtree_file_count").is_none());

    let response = post_json!(
        "/api/device/files/browse",
        json!({
            "device_id": device_id,
            "parent_entry_id": root_id,
            "include_breadcrumbs": true
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let browse: Value = test::read_body_json(response).await;
    assert_eq!(browse["entries"][0]["name"], "reports");
    assert_eq!(browse["entries"][0]["kind"], "directory");
    assert!(browse["entries"][0].get("path_components").is_some());
    assert!(browse["entries"][0].get("subtree_file_count").is_none());
    assert_eq!(browse["entries"][0]["has_content"], false);
    assert!(browse["entries"][0].get("content_path").is_none());
    let reports_id = browse["entries"][0]["entry_id"].as_str().unwrap();
    let response = post_json!(
        "/api/device/files/subtree-counts",
        json!({
            "device_id": device_id,
            "parent_entry_id": null,
            "directory_entry_ids": [root_id]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let root_counts: Value = test::read_body_json(response).await;
    assert_eq!(root_counts["counts"][0]["entry_id"], root_id);
    assert_eq!(root_counts["counts"][0]["file_count"], 1);

    let response = post_json!(
        "/api/device/files/subtree-counts",
        json!({
            "device_id": device_id,
            "parent_entry_id": root_id,
            "directory_entry_ids": [reports_id]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let directory_counts: Value = test::read_body_json(response).await;
    assert_eq!(directory_counts["counts"][0]["entry_id"], reports_id);
    assert_eq!(directory_counts["counts"][0]["file_count"], 1);

    let response = post_json!(
        "/api/device/files/search",
        json!({
            "device_id": device_id,
            "scope_entry_id": root_id,
            "file_metadata_modified_from": "2026-07-24T00:00:00Z",
            "file_metadata_modified_to": "2026-07-23T00:00:00Z"
        })
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: Value = test::read_body_json(response).await;
    assert_eq!(error[0][0], "file_metadata_modified_from");

    let response = post_json!(
        "/api/device/files/search",
        json!({
            "device_id": device_id,
            "scope_entry_id": root_id,
            "name_query": "good"
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let search: Value = test::read_body_json(response).await;
    assert_eq!(search["entries"].as_array().unwrap().len(), 1);
    assert_eq!(search["entries"][0]["name"], "good.txt");
    assert!(search["entries"][0].get("path_components").is_some());
    assert_eq!(search["entries"][0]["has_content"], true);
    assert!(search["entries"][0].get("content_path").is_none());

    let response = post_json!(
        "/api/device/files/sync",
        json!({
            "device_id": device_id,
            "path_syntax": "windows",
            "files": [
                {
                    "absolute_path": r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_disarm.wav"
                },
                {
                    "absolute_path": r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_plant.wav"
                }
            ]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let sync: Value = test::read_body_json(response).await;
    assert_eq!(sync["results"][0]["status"], "accepted");
    assert_eq!(sync["results"][1]["status"], "accepted");
    assert_eq!(sync["results"][0]["file"]["has_content"], false);
    assert_eq!(sync["results"][1]["file"]["has_content"], false);
    assert!(sync["results"][0]["file"].get("content_path").is_none());
    assert!(sync["results"][1]["file"].get("content_path").is_none());
    assert_eq!(
        sync["results"][0]["file"]["absolute_path"],
        r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_disarm.wav"
    );
    assert_eq!(
        sync["results"][1]["file"]["absolute_path"],
        r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_plant.wav"
    );

    let response = post_json!(
        "/api/device/files/journal",
        json!({"device_id": device_id, "limit": 2})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let journal: Value = test::read_body_json(response).await;
    let journal_entries = journal["entries"].as_array().unwrap();
    assert_eq!(journal_entries.len(), 2);
    assert_eq!(journal["total_count"], 3);
    assert!(journal_entries
        .iter()
        .all(|entry| entry["synchronized_at"].as_str().is_some()));
    assert!(journal_entries
        .iter()
        .all(|entry| entry["has_content"] == false));
    assert!(journal_entries
        .iter()
        .all(|entry| entry.get("content_path").is_none()));
    let mut first_page_paths = journal_entries
        .iter()
        .map(|entry| entry["absolute_path"].as_str().unwrap())
        .collect::<Vec<_>>();
    first_page_paths.sort_unstable();
    assert_eq!(
        first_page_paths,
        vec![
            r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_disarm.wav",
            r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_plant.wav",
        ]
    );
    let journal_cursor = journal["next_cursor"].as_str().unwrap();

    let response = post_json!(
        "/api/device/files/journal",
        json!({
            "device_id": device_id,
            "limit": 2,
            "cursor": journal_cursor
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let journal: Value = test::read_body_json(response).await;
    assert_eq!(journal["entries"].as_array().unwrap().len(), 1);
    assert_eq!(journal["total_count"], 3);
    assert_eq!(journal["entries"][0]["name"], "good.txt");
    assert_eq!(journal["entries"][0]["has_content"], true);
    assert!(journal["entries"][0].get("content_path").is_none());
    assert_eq!(journal["next_cursor"], Value::Null);

    let child_organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            parent_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-api-child-{}", Uuid::now_v7())),
            organism_id: Set(Some(child_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let child_device = device_active_model(
        &child_login.login,
        child_organism.id,
        "Child organism API source",
        None,
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();

    let response =
        post_json!("/api/device/detail", json!({"device_id": child_device.id}));
    assert_eq!(response.status(), StatusCode::OK);
    let response = post_json!("/api/device/list", json!({}));
    assert_eq!(response.status(), StatusCode::OK);
    let list: Value = test::read_body_json(response).await;
    assert_eq!(list["total"], 2);
    assert!(list["list"]
        .as_array()
        .unwrap()
        .iter()
        .any(|device| device["id"] == child_device.id.to_string()));

    let mut login = login.into_active_model();
    login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
    let login = login.update(&env.dbx).await.unwrap();
    let response = post_json!(
        "/api/device/update",
        json!({"device_id": device_id, "name": "Forbidden rename"})
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    for path in ["/api/device/aors", "/api/device/units"] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(path)
                .cookie(session_cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    let mut login = login.into_active_model();
    login.roles = Set(json!([ROLE_CYBER]));
    login.update(&env.dbx).await.unwrap();
    for path in ["/api/device/aors", "/api/device/units"] {
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri(path)
                .cookie(session_cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

const TARGET_ROUTES: [&str; 13] = [
    "/api/device/list",
    "/api/device/unit-stats",
    "/api/device/aors",
    "/api/device/units",
    "/api/device/detail",
    "/api/device/create",
    "/api/device/update",
    "/api/device/files/roots",
    "/api/device/files/subtree-counts",
    "/api/device/files/browse",
    "/api/device/files/search",
    "/api/device/files/journal",
    "/api/device/files/sync",
];

const EXCLUDED_ROUTES: [&str; 8] = [
    "/api/device/archive",
    "/api/device/restore",
    "/api/device/files/list",
    "/api/device/files/create",
    "/api/device/files/roots/create",
    "/api/device/files/hide",
    "/api/device/files/restore",
    "/api/device/files/content",
];

#[actix_web::test]
async fn target_route_matrix_has_only_thirteen_post_routes() {
    let config = crate::config::read_config(Mode::Test).unwrap();
    let redis_session_store =
        RedisSessionStore::new(crate::redis_conn_string(&config).unwrap())
            .await
            .unwrap();
    let app = test::init_service(
        App::new()
            .wrap(
                IdentityMiddleware::builder()
                    .visit_deadline(Some(std::time::Duration::from_secs(
                        IDENTITY_DURATION_HOURS * 60 * 60,
                    )))
                    .build(),
            )
            .wrap(SessionMiddleware::new(redis_session_store, Key::generate()))
            .configure(configure_routes),
    )
    .await;

    for path in TARGET_ROUTES {
        let response = test::call_service(
            &app,
            test::TestRequest::post().uri(path).to_request(),
        )
        .await;
        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "POST {path} must be registered",
        );

        let response = test::call_service(
            &app,
            test::TestRequest::get().uri(path).to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "GET {path} must not be registered",
        );
    }

    for path in EXCLUDED_ROUTES {
        let response = test::call_service(
            &app,
            test::TestRequest::post().uri(path).to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "POST {path} must stay excluded",
        );
    }
}

mod access_tests {
    use super::super::access::*;
    use crate::config::{
        ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
    };
    use crate::entities::{login, organism, system_settings};
    use crate::error::AppError;
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use crate::types::Uuid;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, DatabaseConnection, IntoActiveModel,
    };
    use serde_json::json;
    use serial_test::serial;

    fn roles(roles: &[&str]) -> serde_json::Value {
        json!(roles)
    }

    fn capabilities(roles: &serde_json::Value) -> (bool, bool, bool) {
        (
            require_read(roles).is_ok(),
            require_source_write(roles).is_ok(),
            require_analytical_write(roles).is_ok(),
        )
    }

    fn assert_device_operation_forbidden(error: AppError) {
        match error {
            AppError::Forbidden(message) => {
                assert_eq!(message, DEVICE_OPERATION_FORBIDDEN);
            }
            error => {
                panic!(
                    "expected device-operation forbidden error, got {error:?}"
                )
            }
        }
    }

    async fn insert_devices_settings(
        dbx: &DatabaseConnection,
        enabled: bool,
    ) -> system_settings::Model {
        system_settings::ActiveModel {
            devices_section_enabled: Set(enabled),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    #[test]
    fn access_maps_each_exact_device_role() {
        let cases = [
            (ROLE_CYBER, (true, false, false)),
            (ROLE_DEVICE_SOURCE, (true, true, false)),
            (ROLE_DEVICE_ANALYST, (true, true, true)),
            (ROLE_ADMIN, (true, true, true)),
        ];

        for (role, expected_capabilities) in cases {
            assert_eq!(capabilities(&roles(&[role])), expected_capabilities);
        }
    }

    #[test]
    fn access_unions_combined_device_roles() {
        let cases = vec![
            (vec![ROLE_CYBER, ROLE_DEVICE_SOURCE], (true, true, false)),
            (vec![ROLE_CYBER, ROLE_DEVICE_ANALYST], (true, true, true)),
            (vec![ROLE_DEVICE_SOURCE, "Unrelated"], (true, true, false)),
        ];

        for (roles, expected_capabilities) in cases {
            assert_eq!(capabilities(&json!(roles)), expected_capabilities);
        }
    }

    #[test]
    fn access_ignores_legacy_and_unrelated_roles() {
        let cases = vec![
            vec!["DevicesEditor"],
            vec!["Unrelated"],
            vec!["deviceanalyst"],
        ];

        for roles in cases {
            assert_eq!(capabilities(&json!(roles)), (false, false, false));
        }
    }

    #[test]
    fn access_requirements_return_generic_forbidden_error() {
        let roles = roles(&[]);

        for result in [
            require_read(&roles),
            require_source_write(&roles),
            require_analytical_write(&roles),
        ] {
            assert_device_operation_forbidden(result.unwrap_err());
        }
    }

    #[test]
    fn access_authorizes_all_field_group_combinations() {
        let source_roles = roles(&[ROLE_DEVICE_SOURCE]);
        let analyst_roles = roles(&[ROLE_DEVICE_ANALYST]);
        let cases = [
            (false, false, true),
            (true, false, true),
            (false, true, false),
            (true, true, false),
        ];

        for (source_data, analytical_data, source_allowed) in cases {
            let source_result = require_field_groups(
                &source_roles,
                DeviceFieldGroups {
                    source_data,
                    analytical_data,
                },
            );
            if source_allowed {
                source_result.unwrap();
            } else {
                assert_device_operation_forbidden(source_result.unwrap_err());
            }

            require_field_groups(
                &analyst_roles,
                DeviceFieldGroups {
                    source_data,
                    analytical_data,
                },
            )
            .unwrap();
        }
    }

    #[tokio::test]
    #[serial]
    async fn resolve_uses_current_roles_and_rejects_disabled_or_missing_login()
    {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let settings = insert_devices_settings(&env.dbx, true).await;
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login_name = format!("device-access-{}", Uuid::now_v7());
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(login_name),
                roles: Set(json!([ROLE_DEVICE_ANALYST])),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login_id = login.id;

        let analyst = resolve_login_by_id(&env.dbx, &login_id).await.unwrap();
        assert_eq!(capabilities(&analyst.roles), (true, true, true));
        assert_eq!(organism_id(&analyst).unwrap(), organism.id);

        let mut login = login.into_active_model();
        login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
        let login = login.update(&env.dbx).await.unwrap();

        let source = resolve_login_by_id(&env.dbx, &login_id).await.unwrap();
        assert_eq!(capabilities(&source.roles), (true, true, false));

        let mut login = login.into_active_model();
        login.organism_id = Set(None);
        let login = login.update(&env.dbx).await.unwrap();
        let missing_organism_error =
            match resolve_login_by_id(&env.dbx, &login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected missing-organism error"),
            };
        assert!(matches!(missing_organism_error, AppError::Unauthenticated));

        let mut login = login.into_active_model();
        login.organism_id = Set(Some(organism.id));
        login.update(&env.dbx).await.unwrap();

        let missing_login_id = Uuid::now_v7();
        let missing_login_error =
            match resolve_login_by_id(&env.dbx, &missing_login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected missing-login error"),
            };
        assert!(matches!(missing_login_error, AppError::Unauthenticated));

        let mut settings = settings.into_active_model();
        settings.devices_section_enabled = Set(false);
        settings.update(&env.dbx).await.unwrap();

        let disabled_section_error =
            match resolve_login_by_id(&env.dbx, &login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected disabled-section error"),
            };
        assert!(matches!(
            disabled_section_error,
            AppError::Forbidden(message)
                if message == "devices_section_enabled is disabled"
        ));
    }
}

pub(in crate::devices) mod schema {
    use crate::entities::{device, login, organism};
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use crate::types::Uuid;
    use chrono::{NaiveDateTime, Utc};
    use sea_orm::{
        ActiveModelTrait,
        ActiveValue::{NotSet, Set},
        ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, Statement,
        TransactionTrait,
    };
    use serde_json::{json, Value};
    use std::error::Error as StdError;

    #[tokio::test]
    #[serial_test::serial]
    async fn device_schema_enforces_target_fields() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        assert_exact_device_columns(&env.dbx).await;
        assert_device_aor_schema(&env.dbx).await;

        assert_legacy_device_file_table_is_absent(&env.dbx).await;
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(format!("device-schema-{}", Uuid::now_v7())),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let custom_fields =
            json!({"inventory_id": "node-1", "transport": "ssh"});
        let saved = device_active_model(
            &login.login,
            organism.id,
            "shared-source-label",
            Some("Analytical name"),
            custom_fields.clone(),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        let fetched = device::Entity::find_by_id(saved.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(fetched.name.as_deref(), Some("Analytical name"));
        assert_eq!(fetched.source_label, "shared-source-label");
        assert_eq!(fetched.custom_fields, custom_fields);

        let duplicate_source_label = device_active_model(
            &login.login,
            organism.id,
            "shared-source-label",
            Some("Different name"),
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_eq!(duplicate_source_label.source_label, "shared-source-label");

        let nullable_name = device_active_model(
            &login.login,
            organism.id,
            "source-without-name",
            None,
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_eq!(nullable_name.name, None);

        assert_device_check_fails(
            &env.dbx,
            &login.login,
            organism.id,
            "   ",
            Some("Valid name"),
            json!({}),
            false,
            None,
        )
        .await;
        assert_device_check_fails(
            &env.dbx,
            &login.login,
            organism.id,
            "valid-source-label",
            Some("   "),
            json!({}),
            false,
            None,
        )
        .await;
        assert_device_check_fails(
            &env.dbx,
            &login.login,
            organism.id,
            "valid-source-label",
            Some("Valid name"),
            json!([]),
            false,
            None,
        )
        .await;
        assert_device_check_fails(
            &env.dbx,
            &login.login,
            organism.id,
            "valid-source-label",
            Some("Valid name"),
            json!({}),
            false,
            Some(Utc::now().naive_utc()),
        )
        .await;

        let renamed_login = format!("device-schema-renamed-{}", Uuid::now_v7());
        let mut login: login::ActiveModel = login.into();
        login.login = Set(renamed_login.clone());
        login.update(&env.dbx).await.unwrap();

        let renamed_device = device::Entity::find_by_id(saved.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(renamed_device.created_by, renamed_login);
    }

    async fn assert_exact_device_columns(dbx: &DatabaseConnection) {
        let columns = dbx
            .query_all(Statement::from_string(
                DbBackend::Postgres,
                r#"
    select column_name, is_nullable, column_default, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'device'
    order by ordinal_position
    "#
                .to_string(),
            ))
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.try_get("", "column_name").unwrap(),
                    row.try_get("", "is_nullable").unwrap(),
                    row.try_get("", "column_default").unwrap(),
                    row.try_get("", "data_type").unwrap(),
                )
            })
            .collect::<Vec<(String, String, Option<String>, String)>>();
        let expected_columns = [
            ("id", "NO", None, "uuid"),
            ("name", "YES", None, "text"),
            ("created_by", "NO", None, "text"),
            ("unit_id", "YES", None, "bigint"),
            ("tags", "NO", Some("'[]'::jsonb"), "jsonb"),
            ("external_url", "YES", None, "text"),
            ("archived", "NO", Some("false"), "boolean"),
            ("archived_at", "YES", None, "timestamp without time zone"),
            (
                "created_at",
                "NO",
                Some("(now() AT TIME ZONE 'utc'::text)"),
                "timestamp without time zone",
            ),
            (
                "updated_at",
                "NO",
                Some("(now() AT TIME ZONE 'utc'::text)"),
                "timestamp without time zone",
            ),
            ("source_label", "NO", None, "text"),
            ("custom_fields", "NO", None, "jsonb"),
            ("organism_id", "NO", None, "bigint"),
        ]
        .into_iter()
        .map(|(name, nullable, default, data_type)| {
            (
                name.to_string(),
                nullable.to_string(),
                default.map(str::to_string),
                data_type.to_string(),
            )
        })
        .collect::<Vec<_>>();

        assert_eq!(columns, expected_columns);
    }

    async fn assert_legacy_device_file_table_is_absent(
        dbx: &DatabaseConnection,
    ) {
        let legacy_table: Option<String> = dbx
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "select to_regclass('public.device_file')::text as table_name"
                    .to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "table_name")
            .unwrap();

        assert_eq!(legacy_table, None);
    }

    async fn assert_device_aor_schema(dbx: &DatabaseConnection) {
        let constraints = dbx
            .query_all(Statement::from_string(
                DbBackend::Postgres,
                r#"
    select conname, contype::text, pg_get_constraintdef(oid)
    from pg_constraint
    where conrelid = 'public.device_aor'::regclass
    order by conname
    "#
                .to_string(),
            ))
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.try_get("", "conname").unwrap(),
                    row.try_get("", "contype").unwrap(),
                    row.try_get("", "pg_get_constraintdef").unwrap(),
                )
            })
            .collect::<Vec<(String, String, String)>>();
        assert_eq!(
            constraints,
            [
                (
                    "device_aor_aor_id_fkey",
                    "f",
                    "FOREIGN KEY (aor_id) REFERENCES area_of_responsibility(id) ON DELETE CASCADE",
                ),
                ("device_aor_aor_id_not_null", "n", "NOT NULL aor_id"),
                ("device_aor_created_at_not_null", "n", "NOT NULL created_at"),
                (
                    "device_aor_device_aor_unique",
                    "u",
                    "UNIQUE (device_id, aor_id)",
                ),
                (
                    "device_aor_device_id_fkey",
                    "f",
                    "FOREIGN KEY (device_id) REFERENCES device(id) ON DELETE CASCADE",
                ),
                ("device_aor_device_id_not_null", "n", "NOT NULL device_id"),
                ("device_aor_id_not_null", "n", "NOT NULL id"),
                ("device_aor_pkey", "p", "PRIMARY KEY (id)"),
            ]
            .into_iter()
            .map(|(name, kind, definition)| {
                (
                    name.to_string(),
                    kind.to_string(),
                    definition.to_string(),
                )
            })
            .collect::<Vec<_>>(),
        );

        let indexes = dbx
            .query_all(Statement::from_string(
                DbBackend::Postgres,
                r#"
    select indexname, indexdef
    from pg_indexes
    where schemaname = 'public' and tablename = 'device_aor'
    order by indexname
    "#
                .to_string(),
            ))
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.try_get("", "indexname").unwrap(),
                    row.try_get("", "indexdef").unwrap(),
                )
            })
            .collect::<Vec<(String, String)>>();
        assert_eq!(
            indexes,
            [
                (
                    "device_aor_aor_id_device_id_idx",
                    "CREATE INDEX device_aor_aor_id_device_id_idx ON public.device_aor USING btree (aor_id, device_id)",
                ),
                (
                    "device_aor_device_aor_unique",
                    "CREATE UNIQUE INDEX device_aor_device_aor_unique ON public.device_aor USING btree (device_id, aor_id)",
                ),
                (
                    "device_aor_device_id_idx",
                    "CREATE INDEX device_aor_device_id_idx ON public.device_aor USING btree (device_id)",
                ),
                (
                    "device_aor_pkey",
                    "CREATE UNIQUE INDEX device_aor_pkey ON public.device_aor USING btree (id)",
                ),
            ]
            .into_iter()
            .map(|(name, definition)| (name.to_string(), definition.to_string()))
            .collect::<Vec<_>>(),
        );
    }

    async fn assert_device_check_fails(
        dbx: &DatabaseConnection,
        created_by: &str,
        organism_id: i64,
        source_label: &str,
        name: Option<&str>,
        custom_fields: Value,
        archived: bool,
        archived_at: Option<NaiveDateTime>,
    ) {
        let transaction = dbx.begin().await.unwrap();
        let error = device_active_model(
            created_by,
            organism_id,
            source_label,
            name,
            custom_fields,
            archived,
            archived_at,
        )
        .insert(&transaction)
        .await
        .unwrap_err();
        assert!(
            has_postgres_error_code(&error, "23514"),
            "expected SQLSTATE 23514, got {error:?}"
        );
        transaction.rollback().await.unwrap();
    }

    pub(in crate::devices) fn device_active_model(
        created_by: &str,
        organism_id: i64,
        source_label: &str,
        name: Option<&str>,
        custom_fields: Value,
        archived: bool,
        archived_at: Option<NaiveDateTime>,
    ) -> device::ActiveModel {
        device::ActiveModel {
            id: Set(Uuid::now_v7()),
            name: Set(name.map(str::to_owned)),
            created_by: Set(created_by.to_string()),
            organism_id: Set(organism_id),
            unit_id: Set(None),
            tags: Set(json!([])),
            external_url: Set(None),
            archived: Set(archived),
            archived_at: Set(archived_at),
            created_at: NotSet,
            updated_at: NotSet,
            source_label: Set(source_label.to_string()),
            custom_fields: Set(custom_fields),
        }
    }

    fn has_postgres_error_code(
        error: &(dyn StdError + 'static),
        code: &str,
    ) -> bool {
        let mut source = Some(error);
        while let Some(error) = source {
            if let Some(sqlx::Error::Database(database_error)) =
                error.downcast_ref::<sqlx::Error>()
            {
                if database_error.code().as_deref() == Some(code) {
                    return true;
                }
            }
            source = error.source();
        }
        false
    }
}
