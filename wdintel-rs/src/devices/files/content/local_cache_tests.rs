use super::*;

async fn cache_settings(env: &Env, enabled: bool) {
    let settings = system_settings::Entity::find()
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let mut settings = settings.into_active_model();
    settings.messenger_media_cache_enabled = Set(Some(enabled));
    settings.messenger_media_cache_retention_hours = Set(Some(24));
    settings.messenger_media_cache_max_size_gib = Set(Some(1));
    settings.messenger_media_cache_min_free_gib = Set(Some(0));
    settings.update(&env.dbx).await.unwrap();
}

fn read_storage(
    env: &mut Arc<Env>,
    fixture: &Fixture,
    directory: &std::path::Path,
) {
    let env = Arc::get_mut(env).unwrap();
    env.config.storage_dir = directory.display().to_string();
    env.s3 = Some(fixture.runtime.storage.clone());
    env.s3_config = Some(fixture.runtime.storage_config.clone());
    env.config.s3_config = Some(crate::config::S3Config {
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        s3_endpoint: "https://storage.invalid".to_owned(),
        s3_region: "test".to_owned(),
        s3_bucket: fixture.runtime.storage_config.bucket.clone(),
        strongbox_key: fixture.runtime.strongbox_key.clone(),
    });
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_retained_upload_survives_spool_cleanup_and_s3_outage() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let directory = tempfile::tempdir().unwrap();
    read_storage(&mut env, &fixture, directory.path());
    cache_settings(&env, true).await;
    let mut published = Vec::new();
    for (bytes, encrypted) in [
        (b"0123456789 encrypted audio".as_slice(), true),
        (
            b"\0\0\0\x18ftypisom\0\0\0\0isommp42plaintext video".as_slice(),
            false,
        ),
        (b"".as_slice(), true),
    ] {
        let file = fixture.file("media.mp4").await;
        let upload = fixture.upload(&file, bytes).await;
        let spool = fixture.seed_bytes(&upload, bytes).await;
        finalize(
            &env,
            &fixture.runtime,
            fixture.login.id,
            upload.clone(),
            &spool,
        )
        .await
        .unwrap();
        let content = file_content::Entity::find_by_id((file.id, 1))
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(content.is_encrypted, encrypted);
        assert!(!fixture
            .spool
            .path()
            .join(format!("{}.data", upload.id))
            .exists());
        published.push((file.id, bytes));
    }
    Arc::get_mut(&mut env).unwrap().s3 = None;
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    for (id, bytes) in &published {
        let path =
            format!("/api/device/files/{}/{id}/revisions/1", fixture.device.id);
        for suffix in ["content", "preview/media"] {
            let response = test::call_service(
                &app,
                test::TestRequest::get()
                    .uri(&format!("{path}/{suffix}"))
                    .cookie(cookie.clone())
                    .to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{suffix} must use retained upload"
            );
            assert_eq!(test::read_body(response).await.as_ref(), *bytes);
            let response = test::call_service(
                &app,
                test::TestRequest::default()
                    .method(Method::HEAD)
                    .uri(&format!("{path}/{suffix}"))
                    .cookie(cookie.clone())
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("{path}/preview/media"))
                .insert_header((header::RANGE, "bytes=2-4"))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        if bytes.is_empty() {
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        } else {
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(test::read_body(response).await.as_ref(), &bytes[2..5]);
        }
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(
                    &format!("{path}/content")
                        .replace("revisions/1", "revisions/2"),
                )
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    cache_settings(&env, false).await;
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!(
                "/api/device/files/{}/{}/revisions/1/content",
                fixture.device.id, published[0].0
            ))
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    cache_settings(&env, true).await;
    let mut denied = fixture.login.clone().into_active_model();
    denied.roles = Set(json!([]));
    denied.update(&env.dbx).await.unwrap();
    for suffix in ["content", "preview/media"] {
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!(
                    "/api/device/files/{}/{}/revisions/1/{suffix}",
                    fixture.device.id, published[0].0
                ))
                .cookie(cookie.clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_retention_disabled_or_degraded_preserves_s3_publication() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    for failure in ["disabled", "unwritable", "disk-floor"] {
        let directory = tempfile::tempdir().unwrap();
        read_storage(&mut env, &fixture, directory.path());
        cache_settings(&env, failure != "disabled").await;
        if failure == "unwritable" {
            std::fs::write(
                crate::messenger::media_cache::media_cache_dir(&env.config),
                b"not a directory",
            )
            .unwrap();
        }
        if failure == "disk-floor" {
            let mut settings = system_settings::Entity::find()
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
            settings.messenger_media_cache_min_free_gib =
                Set(Some(crate::config::MESSENGER_MEDIA_CACHE_SIZE_GIB_MAX));
            settings.update(&env.dbx).await.unwrap();
        }
        let bytes = b"published despite unavailable retention";
        let file = fixture.file("media.mp4").await;
        let upload = fixture.upload(&file, bytes).await;
        let spool = fixture.seed_bytes(&upload, bytes).await;
        finalize(&env, &fixture.runtime, fixture.login.id, upload, &spool)
            .await
            .unwrap();
        let source = super::super::read::load_published_content(
            &env,
            &fixture.login,
            fixture.device.id,
            file.id,
            1,
        )
        .await
        .unwrap();
        let response = super::super::read::serve_content(
            &env,
            &test::TestRequest::get().to_http_request(),
            &source,
        )
        .await
        .unwrap();
        assert_eq!(
            actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_retained_upload_recovers_commit_before_spool_cleanup() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let directory = tempfile::tempdir().unwrap();
    read_storage(&mut env, &fixture, directory.path());
    cache_settings(&env, true).await;
    let bytes = b"committed before process stopped";
    let file = fixture.file("recovered.mp4").await;
    let upload = fixture.upload(&file, bytes).await;
    let spool = fixture.seed_bytes(&upload, bytes).await;
    fixture
        .runtime
        .storage
        .write(&upload.object_key, bytes.to_vec())
        .await
        .unwrap();
    assert!(matches!(
        repository::publish(
            fixture.db(),
            &upload,
            false,
            Utc::now().fixed_offset(),
            None
        )
        .await
        .unwrap(),
        repository::PublishOutcome::Completed(_)
    ));
    drop(spool);
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    Arc::get_mut(&mut env).unwrap().s3 = None;
    let source = super::super::read::load_published_content(
        &env,
        &fixture.login,
        fixture.device.id,
        file.id,
        1,
    )
    .await
    .unwrap();
    let response = super::super::read::serve_content(
        &env,
        &test::TestRequest::get().to_http_request(),
        &source,
    )
    .await
    .unwrap();
    assert_eq!(
        actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap()
            .as_ref(),
        bytes
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_reused_content_extends_retention_without_another_upload() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let directory = tempfile::tempdir().unwrap();
    read_storage(&mut env, &fixture, directory.path());
    cache_settings(&env, true).await;
    let bytes = b"retained across metadata revisions";
    let file = fixture.file("reused.mp4").await;
    let upload = fixture.upload(&file, bytes).await;
    let spool = fixture.seed_bytes(&upload, bytes).await;
    finalize(
        &env,
        &fixture.runtime,
        fixture.login.id,
        upload.clone(),
        &spool,
    )
    .await
    .unwrap();
    drop(spool);
    let config = crate::messenger::media_local_cache::configured_config(
        &env.config,
        &env.dbx,
    )
    .await
    .unwrap();
    let original = crate::messenger::media_local_cache::ready_object(
        &config,
        &upload.object_key,
        bytes.len() as u64,
        true,
    )
    .await
    .unwrap()
    .unwrap();
    let metadata_path = original.with_extension("json");
    let mut metadata: Value =
        serde_json::from_slice(&std::fs::read(&metadata_path).unwrap())
            .unwrap();
    metadata["retain_until"] = json!(Utc::now().timestamp() - 1);
    std::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap())
        .unwrap();
    resync_file(&env, &fixture, &file).await;
    let current = Arc::get_mut(&mut env).unwrap();
    current.s3 = None;
    current.device_file_content = Some(fixture.runtime.clone());
    let app = app!(env);
    let cookie: Cookie<'static> = cookie!(app, fixture.login.id);
    let response = test::call_service(&app, test::TestRequest::post()
        .uri(&format!("/api/device/files/{}/{}/revisions/2/content-reuse", fixture.device.id, file.id))
        .cookie(cookie.clone())
        .insert_header(("Tus-Resumable", "1.0.0"))
        .set_json(json!({"source_upload_id":upload.id,"expected_size":bytes.len(),"expected_sha256":format!("{:x}", Sha256::digest(bytes))}))
        .to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(metadata_path).unwrap()).unwrap();
    assert!(
        metadata["retain_until"].as_i64().unwrap()
            >= (Utc::now() + Duration::hours(23)).timestamp()
    );
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&format!(
                "/api/device/files/{}/{}/revisions/2/content",
                fixture.device.id, file.id
            ))
            .cookie(cookie)
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body(response).await.as_ref(), bytes);
}

async fn wait_for_publication_lock(fixture: &Fixture, locker_pid: i32) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)))",
            )
            .bind(locker_pid)
            .fetch_one(fixture.db().get_postgres_connection_pool())
            .await
            .unwrap();
            if blocked {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("finalizer did not reach publication after authorization");
}

#[actix_web::test]
#[serial_test::serial]
async fn acceptance_stalled_cache_settings_cannot_hold_finalization_or_reads() {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let directory = tempfile::tempdir().unwrap();
    read_storage(&mut env, &fixture, directory.path());
    cache_settings(&env, true).await;
    let bytes = b"published while optional cache settings stall";
    let file = fixture.file("slow-cache.mp4").await;
    let upload = fixture.upload(&file, bytes).await;
    let spool = fixture.seed_bytes(&upload, bytes).await;
    let mut publication_lock = fixture
        .db()
        .get_postgres_connection_pool()
        .begin()
        .await
        .unwrap();
    let locker_pid: i32 = sqlx::query_scalar("select pg_backend_pid()")
        .fetch_one(&mut *publication_lock)
        .await
        .unwrap();
    sqlx::query("select id from file_entry where id=$1 for update")
        .bind(file.id)
        .fetch_one(&mut *publication_lock)
        .await
        .unwrap();
    let completed = tokio::sync::Notify::new();
    let finalization = async {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(9),
            finalize(
                &env,
                &fixture.runtime,
                fixture.login.id,
                upload.clone(),
                &spool,
            ),
        )
        .await;
        completed.notify_one();
        result
            .expect("optional cache capture delayed durable publication")
            .unwrap();
    };
    let stalled_settings = async {
        wait_for_publication_lock(&fixture, locker_pid).await;
        let settings_lock = env.dbx.begin().await.unwrap();
        settings_lock
            .execute_unprepared(
                "lock table system_settings in access exclusive mode",
            )
            .await
            .unwrap();
        publication_lock.commit().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while fixture.runtime.finalization_permits.available_permits()
                != fixture.runtime.config.finalization_max_concurrent
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("optional cache capture retained a finalization permit");
        completed.notified().await;
        let source = repository::find_published_content(
            fixture.db(),
            fixture.device.id,
            file.id,
            1,
        )
        .await
        .unwrap()
        .unwrap();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            super::super::read::serve_content(
                &env,
                &test::TestRequest::get().to_http_request(),
                &source,
            ),
        )
        .await
        .expect("cache settings prevented S3 fallback")
        .unwrap();
        assert_eq!(
            actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        settings_lock.rollback().await.unwrap();
    };
    tokio::join!(finalization, stalled_settings);
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
}
