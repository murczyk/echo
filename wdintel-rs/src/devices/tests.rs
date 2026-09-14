use self::schema::device_active_model;
use crate::config::{IDENTITY_DURATION_HOURS, ROLE_ADMIN};
use crate::devices::{ROLE_CYBER, ROLE_DEVICE_SOURCE};
use crate::entities::{
    area_of_responsibility, device_settings, login, organism, sigint_unit,
    system_settings,
};
use crate::file_registry::entities::{
    analytics_tag, device_file_tag, file_content, file_content_upload,
    file_entry, sea_orm_active_enums::FileEntryKind,
};
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
    http::{Method, StatusCode},
    test, web, App, HttpMessage, HttpRequest, HttpResponse,
};
use base64::Engine;
use chrono::{NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, EntityTrait,
    IntoActiveModel, TransactionTrait,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn configure_routes(cfg: &mut ServiceConfig) {
    cfg.service(super::devices::list)
        .service(super::devices::unit_stats)
        .service(super::devices::aors)
        .service(super::devices::units)
        .service(super::devices::detail)
        .service(super::devices::create)
        .service(super::devices::update)
        .service(super::settings::update)
        .service(super::files::roots)
        .service(super::files::subtree_counts)
        .service(super::files::browse)
        .service(super::files::search)
        .service(super::files::journal)
        .service(super::files::sync_files)
        .service(super::files::start_sync_session)
        .service(super::files::sync_session_status)
        .service(super::files::apply_sync_batch)
        .service(super::files::complete_sync_session)
        .service(super::files::sync_session_items)
        .service(super::files::content::routes())
        .service(super::analytics::list_tags)
        .service(super::analytics::create_tag)
        .service(super::analytics::update_tag)
        .service(super::analytics::archive_tag)
        .service(super::analytics::restore_tag)
        .service(super::analytics::save_tag_rule)
        .service(super::analytics::list_tag_test_files)
        .service(super::analytics::test_tag_rule)
        .service(super::analytics::reanalyze_all)
        .service(super::analytics::reanalyze_device)
        .service(super::analytics::get_analysis_run)
        .service(super::analytics::list_analysis_runs)
        .service(super::analytics::list_analysis_run_files)
        .service(super::analytics::device_tags)
        .service(super::analytics::device_summary)
        .service(super::analytics::device_files);
}

async fn login(request: HttpRequest, login: web::Path<String>) -> HttpResponse {
    Identity::login(&request.extensions(), login.into_inner()).unwrap();
    HttpResponse::NoContent().finish()
}

fn analytics_root_entry(
    id: Uuid,
    device_id: Uuid,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    file_entry::ActiveModel {
        id: Set(id),
        device_id: Set(device_id),
        parent_id: Set(None),
        kind: Set(FileEntryKind::Directory),
        name: Set("C:\\".to_string()),
        absolute_path: Set(None),
        hierarchy_path: Set(format!("n{}", id.to_string().replace('-', ""))),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(timestamp),
        updated_at: Set(timestamp),
        content_path: Set(None),
        revision: Set(None),
        sync_id: Set(None),
        analysis_input_revision: Set(None),
        current_analysis_run_id: Set(None),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
    }
}

fn analytics_file_entry(
    id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    name: &str,
    extension: &str,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    let root_path = format!("n{}", parent_id.to_string().replace('-', ""));
    file_entry::ActiveModel {
        id: Set(id),
        device_id: Set(device_id),
        parent_id: Set(Some(parent_id)),
        kind: Set(FileEntryKind::File),
        name: Set(name.to_string()),
        absolute_path: Set(Some(format!(r"C:\{name}"))),
        hierarchy_path: Set(format!(
            "{root_path}.n{}",
            id.to_string().replace('-', ""),
        )),
        mime_type: Set(None),
        extension: Set(Some(extension.to_string())),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(timestamp),
        updated_at: Set(timestamp),
        content_path: Set(None),
        revision: Set(None),
        sync_id: Set(None),
        analysis_input_revision: Set(None),
        current_analysis_run_id: Set(None),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
    }
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
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
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
        Some("Other API device"),
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    let mut settings =
        device_settings::Entity::find_by_id(crate::config::DEVICE_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    settings.mattermost_webhook_url =
        Set(Some("https://127.0.0.1/hooks/unreachable".to_string()));
    settings.update(&env.dbx).await.unwrap();

    let config = env.config.clone();
    let (metrics, metrics_recorder) =
        crate::telemetry::Metrics::recording(&config);
    let content_spool = tempfile::tempdir().unwrap();
    let content_storage =
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish();
    let content_runtime = super::files::content::runtime_for_test(
        env.file_registry_db().unwrap().clone(),
        content_spool.path().to_path_buf(),
        content_storage.clone(),
        Some(metrics.clone()),
    )
    .await;
    let env_mut = std::sync::Arc::get_mut(&mut env).unwrap();
    env_mut.metrics = Some(metrics);
    env_mut.device_file_content = Some(content_runtime);
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

    let notification_lock = env.dbx.begin().await.unwrap();
    notification_lock
        .execute_unprepared(
            "LOCK TABLE device_settings IN ACCESS EXCLUSIVE MODE",
        )
        .await
        .unwrap();

    let create_response =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            post_json!(
                "/api/device/create",
                json!({
                    "name": "API device",
                    "external_url": "https://example.com/device",
                    "custom_fields": {"inventory_id": "api-1"}
                })
            )
        })
        .await;
    notification_lock.rollback().await.unwrap();
    let response = create_response
        .expect("device creation waited for its Mattermost notification");
    assert_eq!(response.status(), StatusCode::OK);
    let created: Value = test::read_body_json(response).await;
    let device_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "API device");
    assert_eq!(created["aors"], json!([]));
    assert_eq!(created["unit"], Value::Null);

    let response = post_json!(
        "/api/device/update",
        json!({"device_id": device_id, "name": "API renamed"})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let updated: Value = test::read_body_json(response).await;
    assert_eq!(updated["name"], "API renamed");

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
    assert_eq!(detail["name"], "API renamed");

    let response =
        post_json!("/api/device/detail", json!({"device_id": other_device.id}));
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = post_json!(
        "/api/device/files/sync",
        json!({
            "device_id": device_id,
            "files": [
                {
                    "absolute_path": r"C:\reports\bad.txt",
                    "file_metadata_created_at": "not-a-timestamp"
                },
                {
                    "absolute_path": r"C:\reports\good.txt",
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
    assert_eq!(sync["results"][0]["code"], "validation");
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
    let good_file = file_entry::Entity::find_by_id(good_file_id)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap();
    let content = b"device API content";
    let digest: [u8; 32] = Sha256::digest(content).into();
    let metadata = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    );
    let collection_path = format!(
        "/api/device/files/{device_id}/{good_file_id}/revisions/{}/content-uploads",
        good_file.revision.unwrap()
    );

    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri(&collection_path)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get("tus-version").unwrap(), "1.0.0");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&collection_path)
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", content.len().to_string()))
            .insert_header(("upload-metadata", metadata.clone()))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&collection_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", content.len().to_string()))
            .insert_header(("upload-metadata", metadata))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers().get("tus-resumable").unwrap(), "1.0.0");
    let upload_location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&upload_location)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers().get("upload-offset").unwrap(), "0");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&upload_location)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("x-http-method-override", "PATCH"))
            .insert_header(("upload-offset", "0"))
            .insert_header(("content-type", "application/offset+octet-stream"))
            .set_payload(content.as_slice())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("upload-offset")
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        content.len()
    );

    let complete_path = format!("{upload_location}/complete");
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&complete_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let completed: Value = test::read_body_json(response).await;
    assert_eq!(completed["file_id"], good_file_id.to_string());
    assert_eq!(completed["revision"], good_file.revision.unwrap());
    assert_eq!(completed["status"], "completed");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&complete_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body_json::<Value, _>(response).await, completed);

    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&upload_location)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("upload-offset")
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap(),
        content.len()
    );
    assert!(response.headers().get("upload-expires").is_none());

    let stored_content = file_content::Entity::find_by_id((
        good_file_id,
        good_file.revision.unwrap(),
    ))
    .one(env.file_registry_db().unwrap().connection())
    .await
    .unwrap()
    .unwrap();
    assert!(stored_content.is_encrypted);
    assert!(
        content_storage
            .stat(&stored_content.object_key)
            .await
            .unwrap()
            .content_length()
            > u64::try_from(content.len()).unwrap()
    );
    assert!(sync["results"][1].get("root").is_none());
    let root_id = sync["results"][1]["file"]["root_entry_id"]
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
        Some("Child API device"),
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
    login.roles = Set(json!([ROLE_CYBER]));
    login.update(&env.dbx).await.unwrap();
    let response = post_json!(
        "/api/device/update",
        json!({
            "device_id": device_id,
            "external_url": "https://example.com/cyber-update"
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let updated: Value = test::read_body_json(response).await;
    assert_eq!(updated["external_url"], "https://example.com/cyber-update");
    let response = post_json!(
        "/api/device/create",
        json!({"external_url": "https://example.com/cyber-device"})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let cyber_created: Value = test::read_body_json(response).await;
    assert_eq!(cyber_created["name"], Value::Null);
    assert_eq!(
        cyber_created["external_url"],
        "https://example.com/cyber-device"
    );
    let response = post_json!(
        "/api/device/update",
        json!({"device_id": device_id, "name": "Forbidden rename"})
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = post_json!(
        "/api/device/create",
        json!({"name": "Forbidden Cyber device"})
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
}

#[actix_web::test]
#[serial_test::serial]
async fn device_file_content_rejections_are_tus_compliant_and_side_effect_free()
{
    struct RejectionCase {
        name: &'static str,
        method: Method,
        authenticated: bool,
        headers: Vec<(&'static str, String)>,
        payload: Option<&'static [u8]>,
        expected_status: StatusCode,
        expected_code: Option<&'static str>,
        exposes_tus_versions: bool,
    }

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
    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("content-api-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let device = device_active_model(
        &login.login,
        organism.id,
        Some("Content API device"),
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();
    let now = Utc::now().naive_utc();
    let root_id = Uuid::now_v7();
    analytics_root_entry(root_id, device.id, now)
        .insert(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    let file = crate::file_registry::test_support::insert_entry(
        env.file_registry_db().unwrap().connection(),
        analytics_file_entry(
            Uuid::now_v7(),
            device.id,
            root_id,
            "upload.txt",
            "txt",
            now,
        ),
    )
    .await;

    let config = env.config.clone();
    let content_spool = tempfile::tempdir().unwrap();
    let content_storage =
        opendal::Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish();
    let content_runtime = super::files::content::runtime_for_test(
        env.file_registry_db().unwrap().clone(),
        content_spool.path().to_path_buf(),
        content_storage.clone(),
        None,
    )
    .await;
    std::sync::Arc::get_mut(&mut env)
        .unwrap()
        .device_file_content = Some(content_runtime);
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
            .service(super::files::content::routes()),
    )
    .await;
    let login_response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/login/{}", login.id))
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

    let content = b"abc";
    let digest: [u8; 32] = Sha256::digest(content).into();
    let metadata = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    );
    let collection_path = format!(
        "/api/device/files/{}/{}/revisions/{}/content-uploads",
        device.id,
        file.id,
        file.revision.unwrap()
    );
    let collection_cases = [
        RejectionCase {
            name: "authentication is required",
            method: Method::POST,
            authenticated: false,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                ("upload-length", content.len().to_string()),
                ("upload-metadata", metadata.clone()),
            ],
            payload: None,
            expected_status: StatusCode::UNAUTHORIZED,
            expected_code: None,
            exposes_tus_versions: false,
        },
        RejectionCase {
            name: "unsupported TUS version",
            method: Method::POST,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "0.2.2".to_string()),
                ("upload-length", content.len().to_string()),
                ("upload-metadata", metadata.clone()),
            ],
            payload: None,
            expected_status: StatusCode::PRECONDITION_FAILED,
            expected_code: Some("unsupported_tus_version"),
            exposes_tus_versions: true,
        },
        RejectionCase {
            name: "unsupported collection method",
            method: Method::PUT,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                ("upload-length", content.len().to_string()),
                ("upload-metadata", metadata.clone()),
            ],
            payload: None,
            expected_status: StatusCode::METHOD_NOT_ALLOWED,
            expected_code: Some("method_not_allowed"),
            exposes_tus_versions: false,
        },
        RejectionCase {
            name: "non-canonical metadata",
            method: Method::POST,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                ("upload-length", content.len().to_string()),
                (
                    "upload-metadata",
                    format!("{metadata},filename dXBsb2FkLnR4dA=="),
                ),
            ],
            payload: None,
            expected_status: StatusCode::BAD_REQUEST,
            expected_code: Some("invalid_upload_metadata"),
            exposes_tus_versions: false,
        },
    ];

    for case in collection_cases {
        let mut request = test::TestRequest::default()
            .method(case.method)
            .uri(&collection_path);
        if case.authenticated {
            request = request.cookie(session_cookie.clone());
        }
        for (name, value) in case.headers {
            request = request.insert_header((name, value));
        }
        if let Some(payload) = case.payload {
            request = request.set_payload(payload);
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), case.expected_status, "{}", case.name);
        assert_eq!(
            response.headers().get("tus-resumable").unwrap(),
            "1.0.0",
            "{}",
            case.name
        );
        if case.exposes_tus_versions {
            assert_eq!(
                response.headers().get("tus-version").unwrap(),
                "1.0.0",
                "{}",
                case.name
            );
        }
        if let Some(expected_code) = case.expected_code {
            let body: Value = test::read_body_json(response).await;
            assert_eq!(body["code"], expected_code, "{}", case.name);
        }
    }
    assert!(file_content_upload::Entity::find()
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .is_empty());

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&collection_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", content.len().to_string()))
            .insert_header(("upload-metadata", metadata))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let upload_location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    let resource_cases = [
        RejectionCase {
            name: "unsupported resource method",
            method: Method::GET,
            authenticated: true,
            headers: vec![("tus-resumable", "1.0.0".to_string())],
            payload: None,
            expected_status: StatusCode::METHOD_NOT_ALLOWED,
            expected_code: Some("method_not_allowed"),
            exposes_tus_versions: false,
        },
        RejectionCase {
            name: "unsupported resource TUS version",
            method: Method::PATCH,
            authenticated: true,
            headers: vec![("tus-resumable", "0.2.2".to_string())],
            payload: Some(b"x"),
            expected_status: StatusCode::PRECONDITION_FAILED,
            expected_code: Some("unsupported_tus_version"),
            exposes_tus_versions: true,
        },
        RejectionCase {
            name: "invalid PATCH content type",
            method: Method::PATCH,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                ("upload-offset", "0".to_string()),
                ("content-type", "application/octet-stream".to_string()),
            ],
            payload: Some(b"x"),
            expected_status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            expected_code: Some("invalid_content_type"),
            exposes_tus_versions: false,
        },
        RejectionCase {
            name: "missing PATCH offset",
            method: Method::PATCH,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                (
                    "content-type",
                    "application/offset+octet-stream".to_string(),
                ),
            ],
            payload: Some(b"x"),
            expected_status: StatusCode::BAD_REQUEST,
            expected_code: Some("invalid_upload_offset"),
            exposes_tus_versions: false,
        },
        RejectionCase {
            name: "mismatched PATCH offset",
            method: Method::PATCH,
            authenticated: true,
            headers: vec![
                ("tus-resumable", "1.0.0".to_string()),
                ("upload-offset", "1".to_string()),
                (
                    "content-type",
                    "application/offset+octet-stream".to_string(),
                ),
            ],
            payload: Some(b"x"),
            expected_status: StatusCode::CONFLICT,
            expected_code: Some("offset_mismatch"),
            exposes_tus_versions: false,
        },
    ];

    for case in resource_cases {
        let mut request = test::TestRequest::default()
            .method(case.method)
            .uri(&upload_location)
            .cookie(session_cookie.clone());
        for (name, value) in case.headers {
            request = request.insert_header((name, value));
        }
        if let Some(payload) = case.payload {
            request = request.set_payload(payload);
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), case.expected_status, "{}", case.name);
        assert_eq!(
            response.headers().get("tus-resumable").unwrap(),
            "1.0.0",
            "{}",
            case.name
        );
        if case.exposes_tus_versions {
            assert_eq!(
                response.headers().get("tus-version").unwrap(),
                "1.0.0",
                "{}",
                case.name
            );
        }
        let expected_code = case.expected_code.unwrap();
        let body: Value = test::read_body_json(response).await;
        assert_eq!(body["code"], expected_code, "{}", case.name);

        let head = test::call_service(
            &app,
            test::TestRequest::default()
                .method(Method::HEAD)
                .uri(&upload_location)
                .cookie(session_cookie.clone())
                .insert_header(("tus-resumable", "1.0.0"))
                .to_request(),
        )
        .await;
        assert_eq!(head.status(), StatusCode::NO_CONTENT, "{}", case.name);
        assert_eq!(
            head.headers().get("upload-offset").unwrap(),
            "0",
            "{} mutated the payload",
            case.name
        );
    }

    let complete_path = format!("{upload_location}/complete");
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&complete_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["code"], "upload_incomplete");
    let head = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&upload_location)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(head.status(), StatusCode::NO_CONTENT);
    assert_eq!(head.headers().get("upload-offset").unwrap(), "0");

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&upload_location)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("x-http-method-override", "PATCH"))
            .insert_header(("upload-offset", "0"))
            .insert_header(("content-type", "application/offset+octet-stream"))
            .set_payload(content.as_slice())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&complete_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let completed: Value = test::read_body_json(response).await;

    let empty_file = crate::file_registry::test_support::insert_entry(
        env.file_registry_db().unwrap().connection(),
        analytics_file_entry(
            Uuid::now_v7(),
            device.id,
            root_id,
            "empty.txt",
            "txt",
            now,
        ),
    )
    .await;
    let empty_revision = empty_file.revision.unwrap();
    let empty_collection_path = format!(
        "/api/device/files/{}/{}/revisions/{empty_revision}/content-uploads",
        device.id, empty_file.id
    );
    let empty_digest: [u8; 32] = Sha256::digest([]).into();
    let empty_metadata = format!(
        "sha256 {}",
        base64::engine::general_purpose::STANDARD.encode(empty_digest)
    );
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&empty_collection_path)
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .insert_header(("upload-length", "0"))
            .insert_header(("upload-metadata", empty_metadata))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let empty_upload_location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("{empty_upload_location}/complete"))
            .cookie(session_cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let empty_completed: Value = test::read_body_json(response).await;
    assert_eq!(empty_completed["file_id"], empty_file.id.to_string());
    assert_eq!(empty_completed["revision"], empty_revision);
    assert_eq!(empty_completed["status"], "completed");
    let empty_content =
        file_content::Entity::find_by_id((empty_file.id, empty_revision))
            .one(env.file_registry_db().unwrap().connection())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(empty_content.source_size_bytes, 0);
    assert!(empty_content.is_encrypted);
    assert!(
        content_storage
            .stat(&empty_content.object_key)
            .await
            .unwrap()
            .content_length()
            > 0
    );

    std::fs::remove_dir_all(content_spool.path()).unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&complete_path)
            .cookie(session_cookie)
            .insert_header(("tus-resumable", "1.0.0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body_json::<Value, _>(response).await, completed);
}

#[actix_web::test]
#[serial_test::serial]
async fn device_settings_api_masks_preserves_replaces_clears_and_authorizes() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut settings =
        device_settings::Entity::find_by_id(crate::config::DEVICE_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    settings.mattermost_webhook_url = Set(None);
    settings.update(&env.dbx).await.unwrap();

    let organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-settings-admin-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_ADMIN])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-settings-reader-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_CYBER])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let config = env.config.clone();
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

    macro_rules! login_cookie {
        ($login_id:expr) => {{
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!("/test/login/{}", $login_id))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let cookie: Cookie<'static> =
                response.response().cookies().next().unwrap().into_owned();
            cookie
        }};
    }
    macro_rules! post {
        ($cookie:expr, $body:expr) => {{
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri("/api/admin/device/settings")
                    .cookie($cookie)
                    .set_json(&$body)
                    .to_request(),
            )
            .await
        }};
    }

    let admin_cookie = login_cookie!(admin.id);
    let reader_cookie = login_cookie!(reader.id);

    let response = post!(reader_cookie, json!({}));
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = post!(admin_cookie.clone(), json!({}));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"hasMattermostWebhook": false})
    );

    const WEBHOOK: &str = "https://1.1.1.1/hooks/device-settings-secret";
    let response = post!(
        admin_cookie.clone(),
        json!({"mattermostWebhookUrl": WEBHOOK})
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"hasMattermostWebhook": true})
    );
    let stored =
        device_settings::Entity::find_by_id(crate::config::DEVICE_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(stored.mattermost_webhook_url.as_deref(), Some(WEBHOOK));

    let response =
        post!(admin_cookie.clone(), json!({"mattermostWebhookUrl": "   "}));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"hasMattermostWebhook": true})
    );

    let response = post!(
        admin_cookie.clone(),
        json!({
            "mattermostWebhookUrl": "https://1.0.0.1/hooks/replacement",
            "clearMattermostWebhook": true
        })
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let stored =
        device_settings::Entity::find_by_id(crate::config::DEVICE_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(stored.mattermost_webhook_url.as_deref(), Some(WEBHOOK));

    let response = post!(admin_cookie, json!({"clearMattermostWebhook": true}));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"hasMattermostWebhook": false})
    );
    let stored =
        device_settings::Entity::find_by_id(crate::config::DEVICE_SETTINGS_ID)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(stored.mattermost_webhook_url, None);
}

#[actix_web::test]
#[serial_test::serial]
async fn analytics_api_authorizes_hydrates_and_filters_dynamic_tags() {
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
    let foreign_organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let admin = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("analytics-admin-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_ADMIN])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("analytics-reader-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_CYBER])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let foreign_reader = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("analytics-foreign-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_CYBER])),
            organism_id: Set(Some(foreign_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let device = device_active_model(
        &admin.login,
        organism.id,
        Some("Analytics API device"),
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();

    let now = Utc::now();
    let root_id = Uuid::now_v7();
    let tagged_file_id = Uuid::now_v7();
    let untagged_file_id = Uuid::now_v7();
    let file_db = env.file_registry_db().unwrap().connection();
    analytics_root_entry(root_id, device.id, now.naive_utc())
        .insert(file_db)
        .await
        .unwrap();
    crate::file_registry::test_support::insert_entry(
        file_db,
        analytics_file_entry(
            tagged_file_id,
            device.id,
            root_id,
            "tagged.pdf",
            "pdf",
            now.naive_utc(),
        ),
    )
    .await;
    crate::file_registry::test_support::insert_entry(
        file_db,
        analytics_file_entry(
            untagged_file_id,
            device.id,
            root_id,
            "untagged.txt",
            "txt",
            now.naive_utc(),
        ),
    )
    .await;

    let active_tag_id = Uuid::now_v7();
    let archived_tag_id = Uuid::now_v7();
    for (id, name, archived_at) in [
        (active_tag_id, "Active tag", None),
        (archived_tag_id, "Archived tag", Some(now.fixed_offset())),
    ] {
        analytics_tag::ActiveModel {
            id: Set(id),
            name: Set(name.to_string()),
            rule_expression: Set(None),
            archived_at: Set(archived_at),
            created_at: Set(now.fixed_offset()),
            updated_at: Set(now.fixed_offset()),
        }
        .insert(file_db)
        .await
        .unwrap();
    }
    device_file_tag::ActiveModel {
        id: Set(Uuid::now_v7()),
        file_entry_id: Set(tagged_file_id),
        device_id: Set(device.id),
        file_entry_created_at: Set(now.fixed_offset()),
        tag_id: Set(active_tag_id),
        created_at: Set(now.fixed_offset()),
        updated_at: Set(now.fixed_offset()),
    }
    .insert(file_db)
    .await
    .unwrap();

    let config = env.config.clone();
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

    macro_rules! login_cookie {
        ($login_id:expr) => {{
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&format!("/test/login/{}", $login_id))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let cookie: Cookie<'static> =
                response.response().cookies().next().unwrap().into_owned();
            cookie
        }};
    }
    macro_rules! post_as {
        ($cookie:expr, $path:expr, $body:expr) => {{
            test::call_service(
                &app,
                test::TestRequest::post()
                    .uri($path)
                    .cookie($cookie.clone())
                    .set_json(&$body)
                    .to_request(),
            )
            .await
        }};
    }

    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri("/api/device/analytics/tags")
            .set_json(json!({"device_id": device.id}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let reader_cookie = login_cookie!(reader.id);
    let foreign_cookie = login_cookie!(foreign_reader.id);
    let admin_cookie = login_cookie!(admin.id);

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/tags",
        json!({"device_id": device.id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let tags: Value = test::read_body_json(response).await;
    assert_eq!(
        tags["tags"],
        json!([{"id": active_tag_id, "name": "Active tag"}]),
    );

    let response = post_as!(
        foreign_cookie,
        "/api/device/analytics/tags",
        json!({"device_id": device.id})
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/summary",
        json!({"device_id": device.id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let summary: Value = test::read_body_json(response).await;
    assert_eq!(summary["total_file_count"], 2);
    assert_eq!(summary["analyzed_file_count"], 0);
    assert_eq!(summary["items"].as_array().unwrap().len(), 1);
    assert_eq!(summary["items"][0]["tag"]["id"], active_tag_id.to_string());
    assert_eq!(summary["items"][0]["file_count"], 1);

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/files",
        json!({
            "device_id": device.id,
            "tag_id": active_tag_id,
            "limit": 10,
            "cursor": null
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let files: Value = test::read_body_json(response).await;
    assert_eq!(files["files"].as_array().unwrap().len(), 1);
    assert_eq!(files["files"][0]["file_id"], tagged_file_id.to_string());
    assert_eq!(files["files"][0]["name"], "tagged.pdf");

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": root_id,
            "tag_ids": [active_tag_id],
            "tag_match": "any",
            "untagged": false
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let browse: Value = test::read_body_json(response).await;
    assert_eq!(browse["entries"].as_array().unwrap().len(), 1);
    assert_eq!(browse["entries"][0]["entry_id"], tagged_file_id.to_string());
    assert_eq!(
        browse["entries"][0]["tags"],
        json!([{"id": active_tag_id, "name": "Active tag"}]),
    );

    let response = post_as!(
        reader_cookie,
        "/api/device/files/search",
        json!({
            "device_id": device.id,
            "scope_entry_id": root_id,
            "untagged": true
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let search: Value = test::read_body_json(response).await;
    assert_eq!(search["entries"].as_array().unwrap().len(), 1);
    assert_eq!(
        search["entries"][0]["entry_id"],
        untagged_file_id.to_string(),
    );
    assert_eq!(search["entries"][0]["tags"], json!([]));

    let response = post_as!(
        reader_cookie,
        "/api/device/files/journal",
        json!({
            "device_id": device.id,
            "tag_ids": [active_tag_id],
            "tag_match": "all"
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let journal: Value = test::read_body_json(response).await;
    assert_eq!(journal["total_count"], 1);
    assert_eq!(journal["entries"].as_array().unwrap().len(), 1);
    assert_eq!(journal["entries"][0]["file_id"], tagged_file_id.to_string(),);
    assert_eq!(
        journal["entries"][0]["tags"],
        json!([{"id": active_tag_id, "name": "Active tag"}]),
    );

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": root_id,
            "tag_ids": [archived_tag_id]
        })
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let sparse_file_ids = (0..=100).map(|_| Uuid::now_v7()).collect::<Vec<_>>();
    for (index, file_id) in sparse_file_ids.iter().enumerate() {
        crate::file_registry::test_support::insert_entry(
            file_db,
            analytics_file_entry(
                *file_id,
                device.id,
                root_id,
                &format!("z-sparse-{index:03}.txt"),
                "txt",
                now.naive_utc(),
            ),
        )
        .await;
    }
    let sparse_tagged_file_id = *sparse_file_ids.last().unwrap();
    device_file_tag::ActiveModel {
        id: Set(Uuid::now_v7()),
        file_entry_id: Set(sparse_tagged_file_id),
        device_id: Set(device.id),
        file_entry_created_at: Set(now.fixed_offset()),
        tag_id: Set(active_tag_id),
        created_at: Set(now.fixed_offset()),
        updated_at: Set(now.fixed_offset()),
    }
    .insert(file_db)
    .await
    .unwrap();

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": root_id,
            "tag_ids": [active_tag_id],
            "tag_match": "any",
            "limit": 1
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let first_filtered_page: Value = test::read_body_json(response).await;
    assert_eq!(
        first_filtered_page["entries"][0]["entry_id"],
        tagged_file_id.to_string(),
    );
    let first_filtered_cursor =
        first_filtered_page["next_cursor"].as_str().unwrap();

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": root_id,
            "tag_ids": [active_tag_id],
            "tag_match": "any",
            "limit": 1,
            "cursor": first_filtered_cursor
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let second_filtered_page: Value = test::read_body_json(response).await;
    assert_eq!(
        second_filtered_page["entries"][0]["entry_id"],
        sparse_tagged_file_id.to_string(),
    );
    assert_eq!(second_filtered_page["next_cursor"], Value::Null);

    let nested_directory_id = Uuid::now_v7();
    let nested_file_id = Uuid::now_v7();
    let root_hierarchy_path =
        format!("n{}", root_id.to_string().replace('-', ""));
    let directory_hierarchy_path = format!(
        "{root_hierarchy_path}.n{}",
        nested_directory_id.to_string().replace('-', ""),
    );
    file_entry::ActiveModel {
        id: Set(nested_directory_id),
        device_id: Set(device.id),
        parent_id: Set(Some(root_id)),
        kind: Set(FileEntryKind::Directory),
        name: Set("Nested".to_string()),
        absolute_path: Set(None),
        hierarchy_path: Set(directory_hierarchy_path.clone()),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(now.naive_utc()),
        updated_at: Set(now.naive_utc()),
        content_path: Set(None),
        revision: Set(None),
        sync_id: Set(None),
        analysis_input_revision: Set(None),
        current_analysis_run_id: Set(None),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
    }
    .insert(file_db)
    .await
    .unwrap();
    crate::file_registry::test_support::insert_entry(
        file_db,
        file_entry::ActiveModel {
            id: Set(nested_file_id),
            device_id: Set(device.id),
            parent_id: Set(Some(nested_directory_id)),
            kind: Set(FileEntryKind::File),
            name: Set("nested.pdf".to_string()),
            absolute_path: Set(Some(r"C:\Nested\nested.pdf".to_string())),
            hierarchy_path: Set(format!(
                "{directory_hierarchy_path}.n{}",
                nested_file_id.to_string().replace('-', ""),
            )),
            mime_type: Set(None),
            extension: Set(Some("pdf".to_string())),
            file_metadata_created_at: Set(None),
            file_metadata_modified_at: Set(None),
            created_at: Set(now.naive_utc()),
            updated_at: Set(now.naive_utc()),
            content_path: Set(None),
            revision: Set(None),
            sync_id: Set(None),
            analysis_input_revision: Set(None),
            current_analysis_run_id: Set(None),
            source_file_state: Set(None),
            source_file_state_settled_at: Set(None),
            source_file_state_settled_by: Set(None),
        },
    )
    .await;
    device_file_tag::ActiveModel {
        id: Set(Uuid::now_v7()),
        file_entry_id: Set(nested_file_id),
        device_id: Set(device.id),
        file_entry_created_at: Set(now.fixed_offset()),
        tag_id: Set(active_tag_id),
        created_at: Set(now.fixed_offset()),
        updated_at: Set(now.fixed_offset()),
    }
    .insert(file_db)
    .await
    .unwrap();

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": root_id,
            "tag_ids": [active_tag_id]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let filtered_root: Value = test::read_body_json(response).await;
    assert!(filtered_root["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["entry_id"] == nested_directory_id.to_string()));

    let response = post_as!(
        reader_cookie,
        "/api/device/files/browse",
        json!({
            "device_id": device.id,
            "parent_entry_id": nested_directory_id,
            "tag_ids": [active_tag_id]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let filtered_directory: Value = test::read_body_json(response).await;
    assert_eq!(
        filtered_directory["entries"][0]["entry_id"],
        nested_file_id.to_string(),
    );

    let response = post_as!(
        reader_cookie,
        "/api/admin/device-analytics/tags/create",
        json!({"name": "Forbidden"})
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/list",
        json!({})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let admin_tags: Value = test::read_body_json(response).await;
    assert_eq!(admin_tags["tags"].as_array().unwrap().len(), 2);

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/rule/test",
        json!({
            "id": active_tag_id,
            "rule_expression": {
                "op": "match",
                "field": "extension",
                "matcher": "equals",
                "values": ["pdf"]
            },
            "files": [{
                "absolute_path": "C:\\draft.pdf",
                "expected_match": true
            }]
        })
    );
    assert_eq!(response.status(), StatusCode::OK);
    let tested: Value = test::read_body_json(response).await;
    assert_eq!(
        tested["results"],
        json!([{"index": 0, "matched": true, "passed": true}]),
    );

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/rule/test-files/list",
        json!({"id": active_tag_id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let test_files: Value = test::read_body_json(response).await;
    assert_eq!(
        test_files["files"],
        json!([{"absolute_path": "C:\\draft.pdf", "expected_match": true}])
    );

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/create",
        json!({"name": " active TAG "})
    );
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/create",
        json!({"name": "  Temporary tag  "})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let created: Value = test::read_body_json(response).await;
    assert_eq!(created["name"], "Temporary tag");
    assert_eq!(created["rule_expression"], Value::Null);
    let created_tag_id = created["id"].as_str().unwrap();

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/rule/save",
        json!({
            "id": created_tag_id,
            "rule_expression": {"op": "any", "children": []}
        })
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let validation: Value = test::read_body_json(response).await;
    assert_eq!(validation["code"], "empty_group");
    assert_eq!(validation["path"], "rule_expression.children");

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/rule/save",
        json!({
            "id": created_tag_id,
            "rule_expression": {
                "op": "match",
                "field": "extension",
                "matcher": "equals",
                "values": ["txt"]
            }
        })
    );
    assert_eq!(response.status(), StatusCode::OK);

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/tags/update",
        json!({"id": created_tag_id, "name": "Renamed tag"})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let renamed: Value = test::read_body_json(response).await;
    assert_eq!(renamed["name"], "Renamed tag");

    for path in [
        "/api/admin/device-analytics/tags/archive",
        "/api/admin/device-analytics/tags/restore",
    ] {
        let response =
            post_as!(admin_cookie, path, json!({"id": created_tag_id}));
        assert_eq!(response.status(), StatusCode::OK);
    }

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/reanalyze/device",
        json!({"device_id": device.id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let scheduled: Value = test::read_body_json(response).await;
    let run_id = scheduled["run"]["run_id"].as_str().unwrap();
    assert_eq!(scheduled["run"]["device_id"], device.id.to_string());
    assert_eq!(scheduled["run"]["cause"], "manual_reanalysis");
    assert_eq!(scheduled["run"]["target_source_sequence"], 104);
    assert_eq!(scheduled["run"]["status"], "preparing");
    assert_eq!(scheduled["run"]["item_count"], 0);
    assert_eq!(scheduled["run"]["completed_count"], 0);

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/runs/get",
        json!({"run_id": run_id})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let fetched: Value = test::read_body_json(response).await;
    assert_eq!(fetched["run"], scheduled["run"]);

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/runs/list",
        json!({"device_id": device.id, "limit": 1})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let listed: Value = test::read_body_json(response).await;
    assert_eq!(listed["runs"], json!([scheduled["run"].clone()]));

    let response = post_as!(
        reader_cookie,
        "/api/device/analytics/runs/files",
        json!({"run_id": run_id, "limit": 1})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let files: Value = test::read_body_json(response).await;
    assert_eq!(files, json!({"files": [], "next_cursor": null}));

    let response = post_as!(
        admin_cookie,
        "/api/admin/device-analytics/reanalyze/all",
        json!({})
    );
    assert_eq!(response.status(), StatusCode::OK);
    let scheduled_all: Value = test::read_body_json(response).await;
    assert_eq!(
        scheduled_all["definition_id"],
        scheduled["run"]["definition_id"],
    );
    assert_eq!(scheduled_all["created_run_count"], 1);
}

const TARGET_ROUTES: [&str; 29] = [
    "/api/device/list",
    "/api/device/unit-stats",
    "/api/device/aors",
    "/api/device/units",
    "/api/device/detail",
    "/api/device/create",
    "/api/device/update",
    "/api/admin/device/settings",
    "/api/device/files/roots",
    "/api/device/files/subtree-counts",
    "/api/device/files/browse",
    "/api/device/files/search",
    "/api/device/files/journal",
    "/api/device/files/sync",
    "/api/admin/device-analytics/tags/list",
    "/api/admin/device-analytics/tags/create",
    "/api/admin/device-analytics/tags/update",
    "/api/admin/device-analytics/tags/archive",
    "/api/admin/device-analytics/tags/restore",
    "/api/admin/device-analytics/tags/rule/save",
    "/api/admin/device-analytics/tags/rule/test",
    "/api/admin/device-analytics/reanalyze/all",
    "/api/admin/device-analytics/reanalyze/device",
    "/api/device/analytics/runs/get",
    "/api/device/analytics/runs/list",
    "/api/device/analytics/runs/files",
    "/api/device/analytics/tags",
    "/api/device/analytics/summary",
    "/api/device/analytics/files",
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
async fn target_route_matrix_registers_only_post_routes() {
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
    use crate::config::ROLE_ADMIN;
    use crate::devices::devices::query::{
        authorize_file_registry_access, FileRegistryDeviceAccess,
    };
    use crate::devices::tests::schema::device_active_model;
    use crate::devices::{ROLE_CYBER, ROLE_DEVICE_SOURCE};
    use crate::entities::{login, organism, system_settings};
    use crate::error::AppError;
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use crate::types::Uuid;
    use sea_orm::{
        AccessMode, ActiveModelTrait, ActiveValue::Set, DatabaseConnection,
        IntoActiveModel, IsolationLevel, TransactionTrait,
    };
    use serde_json::json;
    use serial_test::serial;

    fn roles(roles: &[&str]) -> serde_json::Value {
        json!(roles)
    }

    fn capabilities(roles: &serde_json::Value) -> (bool, bool, bool, bool) {
        (
            require_read(roles).is_ok(),
            require_create(roles).is_ok(),
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
            (ROLE_CYBER, (true, true, true, false)),
            (ROLE_DEVICE_SOURCE, (true, true, true, true)),
            (ROLE_ADMIN, (true, true, true, true)),
        ];

        for (role, expected_capabilities) in cases {
            assert_eq!(capabilities(&roles(&[role])), expected_capabilities);
        }
    }

    #[test]
    fn access_unions_combined_device_roles() {
        let cases = vec![
            (
                vec![ROLE_CYBER, ROLE_DEVICE_SOURCE],
                (true, true, true, true),
            ),
            (
                vec![ROLE_DEVICE_SOURCE, "Unrelated"],
                (true, true, true, true),
            ),
            (vec![ROLE_CYBER, "Unrelated"], (true, true, true, false)),
        ];

        for (roles, expected_capabilities) in cases {
            assert_eq!(capabilities(&json!(roles)), expected_capabilities);
        }
    }

    #[test]
    fn access_ignores_unrelated_and_miscased_roles() {
        let cases = vec![
            vec!["DevicesEditor"],
            vec!["Unrelated"],
            vec!["cyber"],
            vec!["devicesource"],
        ];

        for roles in cases {
            assert_eq!(
                capabilities(&json!(roles)),
                (false, false, false, false)
            );
        }
    }

    #[test]
    fn access_requirements_return_generic_forbidden_error() {
        let roles = roles(&[]);

        for result in [
            require_read(&roles),
            require_create(&roles),
            require_source_write(&roles),
            require_analytical_write(&roles),
        ] {
            assert_device_operation_forbidden(result.unwrap_err());
        }
    }

    #[test]
    fn access_authorizes_all_field_group_combinations() {
        let cyber_roles = roles(&[ROLE_CYBER]);
        let source_roles = roles(&[ROLE_DEVICE_SOURCE]);
        let cases = [
            (false, false, true),
            (true, false, true),
            (false, true, false),
            (true, true, false),
        ];

        for (source_data, analytical_data, cyber_allowed) in cases {
            let cyber_result = require_field_groups(
                &cyber_roles,
                DeviceFieldGroups {
                    source_data,
                    analytical_data,
                },
            );
            if cyber_allowed {
                cyber_result.unwrap();
            } else {
                assert_device_operation_forbidden(cyber_result.unwrap_err());
            }

            require_field_groups(
                &source_roles,
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
                roles: Set(json!([ROLE_DEVICE_SOURCE])),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login_id = login.id;

        let source = resolve_login_by_id(&env.dbx, &login_id).await.unwrap();
        assert_eq!(capabilities(&source.roles), (true, true, true, true));
        assert_eq!(organism_id(&source).unwrap(), organism.id);

        let mut login = login.into_active_model();
        login.roles = Set(json!([ROLE_CYBER]));
        let login = login.update(&env.dbx).await.unwrap();

        let cyber = resolve_login_by_id(&env.dbx, &login_id).await.unwrap();
        assert_eq!(capabilities(&cyber.roles), (true, true, true, false));

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

    #[tokio::test]
    #[serial]
    async fn file_sync_authorization_uses_a_fresh_repeatable_read_snapshot() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        insert_devices_settings(&env.dbx, true).await;
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
                login: Set(format!("device-snapshot-{}", Uuid::now_v7())),
                roles: Set(json!([ROLE_DEVICE_SOURCE])),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let device = device_active_model(
            &login.login,
            organism.id,
            Some("Snapshot device"),
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        let device_id = device.id;

        authorize_file_sync_snapshot(&env.dbx, &login.id, device_id)
            .await
            .unwrap();

        let transaction = env
            .dbx
            .begin_with_config(
                Some(IsolationLevel::RepeatableRead),
                Some(AccessMode::ReadOnly),
            )
            .await
            .unwrap();
        let snapshot_login =
            resolve_login_by_id(&transaction, &login.id).await.unwrap();

        let mut updated_login = login.into_active_model();
        updated_login.roles = Set(json!([]));
        let updated_login = updated_login.update(&env.dbx).await.unwrap();

        authorize_file_registry_access(
            &transaction,
            &snapshot_login,
            device_id,
            FileRegistryDeviceAccess::FileSync,
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();

        assert!(matches!(
            authorize_file_sync_snapshot(
                &env.dbx,
                &snapshot_login.id,
                device_id,
            )
                .await,
            Err(AppError::Forbidden(message))
                if message == DEVICE_OPERATION_FORBIDDEN
        ));

        let mut updated_login = updated_login.into_active_model();
        updated_login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
        updated_login.update(&env.dbx).await.unwrap();
        let mut archived_device = device.into_active_model();
        archived_device.archived = Set(true);
        archived_device.archived_at = Set(Some(chrono::Utc::now().naive_utc()));
        archived_device.update(&env.dbx).await.unwrap();

        assert!(matches!(
            authorize_file_sync_snapshot(
                &env.dbx,
                &snapshot_login.id,
                device_id,
            )
            .await,
            Err(AppError::Form(_))
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
            Some("Device name"),
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

        assert_eq!(fetched.name.as_deref(), Some("Device name"));
        assert_eq!(fetched.custom_fields, custom_fields);

        let duplicate_name = device_active_model(
            &login.login,
            organism.id,
            Some("Device name"),
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_eq!(duplicate_name.name.as_deref(), Some("Device name"));

        let unnamed = device_active_model(
            &login.login,
            organism.id,
            None,
            json!({}),
            false,
            None,
        )
        .insert(&env.dbx)
        .await
        .unwrap();
        assert_eq!(unnamed.name, None);

        assert_device_check_fails(
            &env.dbx,
            &login.login,
            organism.id,
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
            .query_all_raw(Statement::from_string(
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
            .query_one_raw(Statement::from_string(
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
            .query_all_raw(Statement::from_string(
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
            .query_all_raw(Statement::from_string(
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
        name: Option<&str>,
        custom_fields: Value,
        archived: bool,
        archived_at: Option<NaiveDateTime>,
    ) {
        let transaction = dbx.begin().await.unwrap();
        let error = device_active_model(
            created_by,
            organism_id,
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
            custom_fields: Set(custom_fields),
        }
    }

    fn has_postgres_error_code(
        error: &(dyn StdError + 'static),
        code: &str,
    ) -> bool {
        let mut source = Some(error);
        while let Some(error) = source {
            if let Some(
                sea_orm::DbErr::Conn(sea_orm::RuntimeErr::SqlxError(
                    sqlx_error,
                ))
                | sea_orm::DbErr::Exec(sea_orm::RuntimeErr::SqlxError(
                    sqlx_error,
                ))
                | sea_orm::DbErr::Query(sea_orm::RuntimeErr::SqlxError(
                    sqlx_error,
                )),
            ) = error.downcast_ref::<sea_orm::DbErr>()
            {
                if let sqlx::Error::Database(database_error) =
                    sqlx_error.as_ref()
                {
                    if database_error.code().as_deref() == Some(code) {
                        return true;
                    }
                }
            }
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
