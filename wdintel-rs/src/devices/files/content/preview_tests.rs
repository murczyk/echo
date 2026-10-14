use super::*;
use actix_web::ResponseError;

fn enable_read_storage(env: &mut Arc<Env>, fixture: &Fixture) {
    let env = Arc::get_mut(env).unwrap();
    env.s3 = Some(fixture.runtime.storage.clone());
    env.s3_config = Some(fixture.runtime.storage_config.clone());
    env.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
    assert!(env.device_file_content.is_none());
}

async fn publish_plaintext(
    fixture: &Fixture,
    bytes: &[u8],
) -> file_entry::Model {
    let file = fixture.file("movie.mp4").await;
    let upload = fixture.upload(&file, bytes).await;
    fixture
        .runtime
        .storage
        .write(
            &fixture
                .runtime
                .storage_config
                .prefixed_key(&upload.object_key),
            bytes.to_vec(),
        )
        .await
        .unwrap();
    repository::publish(
        fixture.db(),
        &upload,
        false,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    file
}

fn media_path(fixture: &Fixture, file: &file_entry::Model) -> String {
    format!(
        "/api/device/files/{}/{}/revisions/1/preview/media",
        fixture.device.id, file.id
    )
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_media_ranges_preserve_original_and_head_contract() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = publish_plaintext(&fixture, b"0123456789").await;
    enable_read_storage(&mut env, &fixture);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let path = media_path(&fixture, &file);
    for (range, if_range, status, expected, content_range) in [
        (None, None, StatusCode::OK, "0123456789", None),
        (
            Some("bytes=2-4"),
            None,
            StatusCode::PARTIAL_CONTENT,
            "234",
            Some("bytes 2-4/10"),
        ),
        (
            Some("bytes=7-"),
            None,
            StatusCode::PARTIAL_CONTENT,
            "789",
            Some("bytes 7-9/10"),
        ),
        (
            Some("bytes=-3"),
            None,
            StatusCode::PARTIAL_CONTENT,
            "789",
            Some("bytes 7-9/10"),
        ),
        (
            Some("bytes=8-99"),
            None,
            StatusCode::PARTIAL_CONTENT,
            "89",
            Some("bytes 8-9/10"),
        ),
        (
            Some("bytes=10-"),
            None,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "",
            Some("bytes */10"),
        ),
        (
            Some("bytes=-0"),
            None,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "",
            Some("bytes */10"),
        ),
        (Some("bytes=4-2"), None, StatusCode::OK, "0123456789", None),
        (
            Some("bytes=999999999999999999999-888888888888888888888"),
            None,
            StatusCode::OK,
            "0123456789",
            None,
        ),
        (
            Some("bytes=888888888888888888888-999999999999999999999"),
            None,
            StatusCode::RANGE_NOT_SATISFIABLE,
            "",
            Some("bytes */10"),
        ),
        (Some("bytes=bad"), None, StatusCode::OK, "0123456789", None),
        (Some("items=2-4"), None, StatusCode::OK, "0123456789", None),
        (
            Some("bytes=0-0,2-2"),
            None,
            StatusCode::OK,
            "0123456789",
            None,
        ),
        (
            Some("bytes=2-4"),
            Some("\"any-validator\""),
            StatusCode::OK,
            "0123456789",
            None,
        ),
    ] {
        let mut request =
            test::TestRequest::get().uri(&path).cookie(cookie.clone());
        if let Some(range) = range {
            request = request.insert_header((header::RANGE, range));
        }
        if let Some(if_range) = if_range {
            request = request.insert_header((header::IF_RANGE, if_range));
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), status, "range={range:?}");
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "private, no-store"
        );
        assert_eq!(
            response.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            response.headers().get("content-encoding").unwrap(),
            "identity"
        );
        assert_eq!(response.headers().get("accept-ranges").unwrap(), "bytes");
        assert!(response.headers().get("etag").is_none());
        assert!(response.headers().get("last-modified").is_none());
        assert_eq!(
            response
                .headers()
                .get("content-range")
                .map(|value| value.to_str().unwrap()),
            content_range
        );
        if status != StatusCode::RANGE_NOT_SATISFIABLE {
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "video/mp4"
            );
            assert!(response
                .headers()
                .get("content-disposition")
                .unwrap()
                .as_bytes()
                .starts_with(b"inline;"));
            assert_eq!(
                response.headers().get("content-length").unwrap(),
                expected.len().to_string().as_str()
            );
        }
        assert_eq!(
            test::read_body(response).await.as_ref(),
            expected.as_bytes()
        );
    }
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header((header::RANGE, "bytes=2-4"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get("content-length").unwrap(), "10");
    assert!(response.headers().get("content-range").is_none());
    assert!(test::read_body(response).await.is_empty());
    let original = path.replace("/preview/media", "/content");
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&original)
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/octet-stream"
    );
    assert!(response
        .headers()
        .get("content-disposition")
        .unwrap()
        .as_bytes()
        .starts_with(b"attachment;"));
    assert_eq!(test::read_body(response).await.as_ref(), b"0123456789");
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_media_encrypted_historical_access_and_empty_source() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture
        .file_with_metadata("old.wav", "audio/wav", "wav")
        .await;
    let bytes = b"immutable encrypted audio";
    let upload = fixture.upload(&file, bytes).await;
    let locked = fixture.seed_bytes(&upload, bytes).await;
    finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    drop(locked);
    resync_file(&env, &fixture, &file).await;
    let empty = publish_plaintext(&fixture, b"").await;
    enable_read_storage(&mut env, &fixture);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let path = media_path(&fixture, &file);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&path)
            .cookie(cookie.clone())
            .insert_header((header::RANGE, "bytes=2-5"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers().get("content-type").unwrap(), "audio/wav");
    assert_eq!(test::read_body(response).await.as_ref(), b"muta");
    for method in [Method::GET, Method::HEAD] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method.clone())
                .uri(&path)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response =
            test::call_service(
                &app,
                test::TestRequest::default()
                    .method(method)
                    .uri(&path.replace(
                        &file.id.to_string(),
                        &Uuid::new_v4().to_string(),
                    ))
                    .cookie(cookie.clone())
                    .to_request(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    let path = media_path(&fixture, &empty);
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&path)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(test::read_body(response).await.is_empty());
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&path)
            .cookie(cookie)
            .insert_header((header::RANGE, "bytes=0-0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers().get("content-range").unwrap(),
        "bytes */0"
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_media_and_original_post_prepare_revocation_use_current_login(
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture
        .file_with_metadata("private.wav", "audio/wav", "wav")
        .await;
    let bytes = b"private encrypted media";
    let upload = fixture.upload(&file, bytes).await;
    let locked = fixture.seed_bytes(&upload, bytes).await;
    finalize(&env, &fixture.runtime, fixture.login.id, upload, &locked)
        .await
        .unwrap();
    drop(locked);
    enable_read_storage(&mut env, &fixture);
    let source = super::super::read::load_published_content(
        &env,
        &fixture.login,
        fixture.device.id,
        file.id,
        1,
    )
    .await
    .unwrap();
    let target = (fixture.device.id, file.id, 1);
    for (original, revocation, expected) in [
        (false, "roles = '[]'::jsonb", StatusCode::FORBIDDEN),
        (false, "deleted = true", StatusCode::UNAUTHORIZED),
        (true, "roles = '[]'::jsonb", StatusCode::FORBIDDEN),
        (true, "deleted = true", StatusCode::UNAUTHORIZED),
    ] {
        let prepared = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let preparation = async {
            let response = if original {
                let request = test::TestRequest::get().to_http_request();
                super::super::read::serve_content(&env, &request, &source)
                    .await?
            } else {
                let body = super::super::preview::prepare_body(
                    web::Data::from(env.clone()),
                    target,
                    &source,
                    0..bytes.len() as u64,
                )
                .await
                .map_err(crate::error::AppError::from)?;
                HttpResponse::Ok().streaming(body)
            };
            prepared.notify_one();
            release.notified().await;
            Ok(response)
        };
        let read = super::super::read::prepare_authorized_content(
            &env,
            fixture.login.id,
            target,
            &source,
            preparation,
        );
        let revoke = async {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                prepared.notified(),
            )
            .await
            .unwrap();
            env.dbx
                .execute_unprepared(&format!(
                    "update login set {revocation} where id = '{}'",
                    fixture.login.id,
                ))
                .await
                .unwrap();
            release.notify_one();
        };
        let (result, ()) = tokio::join!(read, revoke);
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("revoked reader received a prepared media stream"),
        };
        assert!(matches!(
            error,
            crate::error::AppError::Forbidden(_)
                | crate::error::AppError::Unauthenticated
        ));
        assert_eq!(error.error_response().status(), expected);
        env.dbx.execute_unprepared(&format!(
            "update login set roles = '[\"{ROLE_CYBER}\"]'::jsonb, deleted = false where id = '{}'",
            fixture.login.id,
        )).await.unwrap();
    }
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    env.dbx
        .execute_unprepared(&format!(
            "update login set roles = '[]'::jsonb where id = '{}'",
            fixture.login.id,
        ))
        .await
        .unwrap();
    for method in [Method::GET, Method::HEAD] {
        let response = test::call_service(
            &app,
            test::TestRequest::default()
                .method(method)
                .uri(&media_path(&fixture, &file))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = test::read_body(response).await;
        assert!(!body.windows(bytes.len()).any(|window| window == bytes));
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_media_head_does_not_decrypt_and_nonmedia_is_unsupported() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture
        .file_with_metadata("bad.wav", "audio/x-wav", "wav")
        .await;
    let bytes = b"audio metadata only";
    let upload = fixture.upload(&file, bytes).await;
    let locked = fixture.seed_bytes(&upload, bytes).await;
    finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &locked,
    )
    .await
    .unwrap();
    drop(locked);
    fixture
        .runtime
        .storage
        .write(&upload.object_key, b"corrupted ciphertext".to_vec())
        .await
        .unwrap();
    let document = fixture
        .file_with_metadata("document.html", "text/html", "html")
        .await;
    let upload = fixture.upload(&document, b"<script>private</script>").await;
    repository::publish(
        fixture.db(),
        &upload,
        false,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    enable_read_storage(&mut env, &fixture);
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        test::TestRequest::default()
            .method(Method::HEAD)
            .uri(&media_path(&fixture, &file))
            .cookie(cookie.clone())
            .insert_header((header::RANGE, "bytes=0-0"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get("content-type").unwrap(), "audio/wav");
    assert_eq!(
        response.headers().get("content-length").unwrap(),
        bytes.len().to_string().as_str()
    );
    assert!(test::read_body(response).await.is_empty());
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&media_path(&fixture, &file))
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert!(!response.status().is_success());
    assert!(!test::read_body(response)
        .await
        .windows(bytes.len())
        .any(|window| window == bytes));
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&media_path(&fixture, &document))
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert!(!response
        .headers()
        .get("content-type")
        .unwrap()
        .as_bytes()
        .starts_with(b"text/html"));
}
