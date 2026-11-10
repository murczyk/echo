use super::*;

fn png(color: [u8; 3]) -> Vec<u8> {
    let pixels = image::RgbImage::from_pixel(80, 40, image::Rgb(color));
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    encoded.into_inner()
}

async fn publish_plain(
    fixture: &Fixture,
    file: &file_entry::Model,
    bytes: &[u8],
) {
    let upload = fixture.upload(file, bytes).await;
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
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_thumbnails_preserve_historical_bytes_and_recheck_cached_access(
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let original = fixture
        .file_with_metadata("photo.png", "image/png", "png")
        .await;
    publish_plain(&fixture, &original, &png([220, 20, 20])).await;
    resync_file(&env, &fixture, &original).await;
    let current = file_entry::Entity::find_by_id(original.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let green = png([20, 220, 20]);
    let upload = fixture.upload(&current, &green).await;
    let spool = fixture.seed_bytes(&upload, &green).await;
    finalize(&env, &fixture.runtime, fixture.login.id, upload, &spool)
        .await
        .unwrap();
    drop(spool);
    let absent = fixture
        .file_with_metadata("absent.png", "image/png", "png")
        .await;
    let unsupported = fixture
        .file_with_metadata("notes.txt", "text/plain", "txt")
        .await;
    publish_plain(&fixture, &unsupported, b"text").await;
    let corrupt = fixture
        .file_with_metadata("corrupt.png", "image/png", "png")
        .await;
    publish_plain(&fixture, &corrupt, b"invalid image bytes").await;
    let env_mut = Arc::get_mut(&mut env).unwrap();
    env_mut.s3 = Some(fixture.runtime.storage.clone());
    env_mut.s3_config = Some(fixture.runtime.storage_config.clone());
    env_mut.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: String::new(),
        s3_region: String::new(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let uri = |file: Uuid, revision: i64| {
        format!(
            "/api/device/files/{}/{}/revisions/{revision}/thumbnail",
            fixture.device.id, file
        )
    };
    for (revision, dominant) in [(1, 0usize), (2, 1), (1, 0)] {
        let bytes =
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    let response = test::call_service(
                        &app,
                        test::TestRequest::get()
                            .uri(&uri(original.id, revision))
                            .cookie(cookie.clone())
                            .to_request(),
                    )
                    .await;
                    assert_eq!(
                        response.headers().get(header::CACHE_CONTROL).unwrap(),
                        "private, no-store"
                    );
                    assert_eq!(
                        response
                            .headers()
                            .get(header::X_CONTENT_TYPE_OPTIONS)
                            .unwrap(),
                        "nosniff"
                    );
                    if response.status() == StatusCode::OK {
                        assert_eq!(
                            response
                                .headers()
                                .get(header::CONTENT_TYPE)
                                .unwrap(),
                            "image/jpeg"
                        );
                        break test::read_body(response).await;
                    }
                    assert_eq!(response.status(), StatusCode::ACCEPTED);
                    assert_eq!(
                        response.headers().get(header::RETRY_AFTER).unwrap(),
                        "2"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(20))
                        .await;
                }
            })
            .await
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(
            decoded.dimensions(),
            (80, 40),
            "small images must not be enlarged"
        );
        let pixel = decoded.get_pixel(40, 20).0;
        assert!(
            pixel[dominant] > 200 && pixel[1 - dominant] < 40,
            "wrong revision thumbnail: {pixel:?}"
        );
    }
    for (path, expected, authenticated) in [
        (uri(original.id, 1), StatusCode::UNAUTHORIZED, false),
        (uri(original.id, 3), StatusCode::NOT_FOUND, true),
        (uri(absent.id, 1), StatusCode::NOT_FOUND, true),
        (
            uri(unsupported.id, 1),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            true,
        ),
        (
            uri(original.id, 1).replace(
                &fixture.device.id.to_string(),
                &Uuid::new_v4().to_string(),
            ),
            StatusCode::NOT_FOUND,
            true,
        ),
    ] {
        let mut request = test::TestRequest::get().uri(&path);
        if authenticated {
            request = request.cookie(cookie.clone());
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(response.status(), expected);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert!(!test::read_body(response)
            .await
            .starts_with(&[0xff, 0xd8, 0xff]));
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let response = test::call_service(
                &app,
                test::TestRequest::get()
                    .uri(&uri(corrupt.id, 1))
                    .cookie(cookie.clone())
                    .to_request(),
            )
            .await;
            if response.status() == StatusCode::UNPROCESSABLE_ENTITY {
                break;
            }
            assert_eq!(response.status(), StatusCode::ACCEPTED);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    env.dbx
        .execute_raw(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            "update login set roles='[]'::jsonb where id=$1",
            [fixture.login.id.into()],
        ))
        .await
        .unwrap();
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&uri(original.id, 1))
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!test::read_body(response)
        .await
        .starts_with(&[0xff, 0xd8, 0xff]));
}
