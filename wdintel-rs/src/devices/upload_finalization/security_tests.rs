use super::*;

macro_rules! ingress_app {
    ($env:expr) => {{
        let sessions = RedisSessionStore::new(
            crate::redis_conn_string(&$env.config).unwrap(),
        )
        .await
        .unwrap();
        test::init_service(
            App::new()
                .app_data(web::Data::from($env.clone()))
                .app_data(web::JsonConfig::default().limit(1024))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(sessions, Key::generate()))
                .route("/test/login/{actor}", web::post().to(sign_in))
                .service(crate::devices::files::content::routes())
                .service(crate::devices::audio::routes()),
        )
        .await
    }};
}

#[actix_web::test]
#[serial_test::serial]
async fn ingress_rejects_unauthorized_and_oversized_requests_without_reading_body(
) {
    use actix_web::{dev::Payload, error::PayloadError};
    use bytes::Bytes;
    use futures_util::{stream, Stream};
    use std::{cell::Cell, pin::Pin, rc::Rc, task::Poll};

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    for enabled in [false, true] {
        let mut ingress_env = (*env).clone();
        ingress_env.config.device_upload_finalization =
            Some(DeviceUploadFinalizationSettings {
                enabled,
                ..Default::default()
            });
        let ingress_env = Arc::new(ingress_env);
        let app = ingress_app!(ingress_env);
        let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
        let file_uri = format!(
            "/api/device/file-content-uploads/{}/complete",
            Uuid::new_v4()
        );
        for (uri, authenticated, length, status) in [
            (
                "/api/device/audio/receive",
                false,
                1024,
                StatusCode::UNAUTHORIZED,
            ),
            (file_uri.as_str(), false, 1024, StatusCode::UNAUTHORIZED),
            (
                "/api/device/audio/receive",
                true,
                2048,
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let polls = Rc::new(Cell::new(0));
            let observed = polls.clone();
            let body: Pin<Box<dyn Stream<Item = Result<Bytes, PayloadError>>>> =
                Box::pin(stream::poll_fn(move |_| {
                    let count = observed.get();
                    observed.set(count + 1);
                    if count == 0 {
                        Poll::Ready(Some(Ok(Bytes::from_static(b"{"))))
                    } else {
                        Poll::Pending
                    }
                }));
            let mut request = test::TestRequest::post()
                .uri(uri)
                .insert_header((header::CONTENT_TYPE, "application/json"))
                .insert_header((header::CONTENT_LENGTH, length.to_string()));
            if authenticated {
                request = request.cookie(cookie.clone());
            }
            let mut request = request.to_request();
            *request.payload() = Payload::from(body);
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                test::call_service(&app, request),
            )
            .await
            .expect("early rejection must not wait for the request body");
            assert_eq!(response.status(), status);
            assert_eq!(polls.get(), 0, "{uri}: early rejection read the body");
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "private, no-store"
            );
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_file_ingress_errors_are_private_without_changing_sync_precedence(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let directory = tempfile::tempdir().unwrap();
    let mut ingress_env = (*env).clone();
    ingress_env.device_file_content = Some(
        crate::devices::files::content::runtime_for_test(
            env.file_registry_db.as_ref().unwrap().clone(),
            directory.path().to_path_buf(),
            opendal::Operator::new(opendal::services::Memory::default())
                .unwrap()
                .finish(),
            None,
        )
        .await,
    );
    let ingress_env = Arc::new(ingress_env);
    let app = ingress_app!(ingress_env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    let target = fixture
        .file_target(env.file_registry_db().unwrap().connection())
        .await;
    let FinalizationTarget::File { upload_id, .. } = target else {
        unreachable!()
    };
    let existing =
        format!("/api/device/file-content-uploads/{upload_id}/complete");
    let missing = format!(
        "/api/device/file-content-uploads/{}/complete",
        Uuid::new_v4()
    );
    let oversized = format!(
        "{{\"async_finalization\":true,\"padding\":\"{}\"}}",
        "x".repeat(2048)
    );
    for (uri, body, authenticated, tus, expected, private) in [
        (
            &existing,
            r#"{"async_finalization":true}"#,
            false,
            true,
            StatusCode::UNAUTHORIZED,
            true,
        ),
        (
            &missing,
            r#"{"async_finalization":true}"#,
            true,
            true,
            StatusCode::NOT_FOUND,
            true,
        ),
        (
            &existing,
            r#"{"async_finalization":true,"extra":1}"#,
            true,
            true,
            StatusCode::BAD_REQUEST,
            true,
        ),
        (
            &existing,
            oversized.as_str(),
            true,
            true,
            StatusCode::PAYLOAD_TOO_LARGE,
            true,
        ),
        (
            &existing,
            r#"{"async_finalization":true,"extra":1}"#,
            false,
            false,
            StatusCode::UNAUTHORIZED,
            true,
        ),
        (
            &existing,
            r#"{"async_finalization":true,"extra":1}"#,
            true,
            false,
            StatusCode::PRECONDITION_FAILED,
            true,
        ),
        (&missing, "", true, true, StatusCode::NOT_FOUND, true),
        (
            &missing,
            r#"{"async_finalization":false}"#,
            true,
            true,
            StatusCode::NOT_FOUND,
            true,
        ),
    ] {
        let mut request = test::TestRequest::post()
            .uri(uri)
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(body.to_owned());
        if authenticated {
            request = request.cookie(cookie.clone());
        }
        if tus {
            request = request.insert_header(("Tus-Resumable", "1.0.0"));
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(
            response.status(),
            expected,
            "{uri} {body} authenticated={authenticated} tus={tus}"
        );
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .map(|value| value.to_str().unwrap()),
            private.then_some("private, no-store")
        );
        let body = test::read_body(response).await;
        assert!(!String::from_utf8_lossy(&body).contains("private-source"));
    }
    assert!(device_upload_finalization_job::Entity::find()
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .is_empty());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_audio_ingress_errors_are_private_without_changing_sync_extractors(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let app = ingress_app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    let valid = json!({
        "async_finalization": true,
        "device_id": fixture.device.id,
        "upload_url": format!("/api/device/audio/{}/uploads/{}.64", fixture.device.id, Uuid::new_v4()),
        "name": "private audio",
        "recording_started_at": "2026-10-14T08:00:00Z",
    });
    let mut invalid_uuid = valid.clone();
    invalid_uuid["device_id"] = json!("invalid");
    let mut invalid_start = valid.clone();
    invalid_start["recording_started_at"] = json!("invalid");
    let mut unknown_field = valid.clone();
    unknown_field["unknown"] = json!(true);
    let mut oversized = valid.clone();
    oversized["name"] = json!("x".repeat(2048));
    let mut synchronous = invalid_start.clone();
    synchronous["async_finalization"] = json!(false);
    let mut omitted = synchronous.clone();
    omitted
        .as_object_mut()
        .unwrap()
        .remove("async_finalization");
    for (body, authenticated, expected, private) in [
        (valid, false, StatusCode::UNAUTHORIZED, true),
        (invalid_uuid, true, StatusCode::BAD_REQUEST, true),
        (invalid_start, true, StatusCode::BAD_REQUEST, true),
        (unknown_field, true, StatusCode::BAD_REQUEST, true),
        (oversized, true, StatusCode::PAYLOAD_TOO_LARGE, true),
        (synchronous, true, StatusCode::BAD_REQUEST, false),
        (omitted, true, StatusCode::BAD_REQUEST, false),
    ] {
        let mut request = test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .set_json(&body);
        if authenticated {
            request = request.cookie(cookie.clone());
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(
            response.status(),
            expected,
            "{body} authenticated={authenticated}"
        );
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .map(|value| value.to_str().unwrap()),
            private.then_some("private, no-store")
        );
    }
    assert!(device_upload_finalization_job::Entity::find()
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .is_empty());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_existing_sessions_lose_status_access_for_deleted_or_disabled_actors(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let db = env.file_registry_db().unwrap().connection();
    let command = fixture
        .command(db, FinalizationKind::FinalizationAudioKind)
        .await;
    let job = seed_job(db, &command, "queued").await;
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    for change in ["deleted", "deleted_permanently", "organism_disabled"] {
        let mut actor = fixture.actor.clone().into_active_model();
        actor.deleted = Set(change == "deleted");
        actor.deleted_permanently = Set(change == "deleted_permanently");
        actor.update(&env.dbx).await.unwrap();
        sqlx::query("update organism set enabled=$2 where id=$1")
            .bind(fixture.actor.organism_id.unwrap())
            .bind(change != "organism_disabled")
            .execute(env.dbx.get_postgres_connection_pool())
            .await
            .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path(job.id))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{change}");
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert_eq!(persisted(db, job.id).await, job);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_audio_compressed_ingress_keeps_private_errors_and_decoded_size_limit(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let app = ingress_app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.actor.id);
    for (asynchronous, name, authenticated, expected) in [
        (
            true,
            "private recording".to_owned(),
            false,
            StatusCode::UNAUTHORIZED,
        ),
        (
            true,
            "private recording".to_owned(),
            true,
            StatusCode::BAD_REQUEST,
        ),
        (true, "x".repeat(2048), true, StatusCode::PAYLOAD_TOO_LARGE),
        (
            false,
            "private recording".to_owned(),
            true,
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let body = serde_json::to_vec(&json!({
            "async_finalization": asynchronous,
            "device_id": fixture.device.id,
            "name": name,
            "recording_started_at": "invalid",
            "upload_url": "/private-source",
        }))
        .unwrap();
        let body = zstd::stream::encode_all(body.as_slice(), 1).unwrap();
        let mut request = test::TestRequest::post()
            .uri("/api/device/audio/receive")
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .insert_header((header::CONTENT_ENCODING, "zstd"))
            .set_payload(body);
        if authenticated {
            request = request.cookie(cookie.clone());
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), expected);
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .map(|value| value.to_str().unwrap()),
            asynchronous.then_some("private, no-store")
        );
    }
    assert!(device_upload_finalization_job::Entity::find()
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .is_empty());
}
