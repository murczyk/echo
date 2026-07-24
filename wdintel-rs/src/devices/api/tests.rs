use super::configure_routes;
use crate::config::{
    IDENTITY_DURATION_HOURS, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::entities::{login, organism, system_settings};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Mode;
use actix_identity::{Identity, IdentityMiddleware};
use actix_session::storage::RedisSessionStore;
use actix_session::SessionMiddleware;
use actix_web::cookie::{Cookie, Key};
use actix_web::{
    http::StatusCode, test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
use serde_json::{json, Value};
use uuid::Uuid;

async fn login(request: HttpRequest, login: web::Path<String>) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

#[actix_web::test]
#[serial_test::serial]
async fn target_api_smoke_covers_all_routes_and_boundary_precedence() {
    let (env, _guard) = cleanup_locked().await.unwrap();
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

    let config = crate::config::read_config(Mode::Test).unwrap();
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
            .uri(&format!("/test/login/{login_name}"))
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
            .uri("/api/device/list")
            .cookie(session_cookie.clone())
            .insert_header(("content-type", "application/json"))
            .set_payload("{")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body[0][0], "body");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/list")
            .cookie(session_cookie.clone())
            .set_payload("{}")
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body[0][0], "body");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/list")
            .cookie(session_cookie.clone())
            .insert_header(("content-type", "application/json"))
            .insert_header((
                "content-length",
                (crate::config::SERVER_JSON_PAYLOAD_MAX_BYTES + 1).to_string(),
            ))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body[0][0], "body");

    let response = post_json!("/api/device/list", json!({"limit": "one"}));
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body[0][0], "limit");

    let response = post_json!("/api/device/unit-stats", json!({}));
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body[0][0], "body");

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

    let mut login = login.into_active_model();
    login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
    login.update(&env.dbx).await.unwrap();
    let response = post_json!(
        "/api/device/update",
        json!({"device_id": device_id, "name": "Forbidden rename"})
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
