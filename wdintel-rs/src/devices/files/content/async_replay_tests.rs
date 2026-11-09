use super::*;
use futures_util::future::join_all;

#[actix_web::test]
#[serial_test::serial]
async fn production_file_worker_waits_for_capacity_and_releases_budget_without_sweep(
) {
    use crate::devices::upload_finalization::{
        resources, worker as finalization_worker,
    };
    use std::time::Duration as StdDuration;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("worker-cleanup").await;
    let upload = fixture.upload(&file, b"published bytes").await;
    drop(fixture.seed_bytes(&upload, b"published bytes").await);
    let job = admit_file_source(&fixture, &upload).await;
    let env = async_file_env(&env, &fixture, true);
    let claim = claim_file_job(&fixture, job).await;
    let held = resources::try_acquire(
        fixture.spool.path(),
        resources::ResourceKind::File,
        1,
    )
    .unwrap()
    .unwrap();
    let operation = finalization_worker::execute_file_for_test(
        env,
        fixture.runtime.clone(),
        claim,
    );
    tokio::pin!(operation);
    assert!(tokio::time::timeout(
        StdDuration::from_millis(100),
        &mut operation
    )
    .await
    .is_err());
    drop(held);
    tokio::time::timeout(StdDuration::from_secs(5), operation)
        .await
        .unwrap()
        .unwrap();
    let state = persisted_file_job(&fixture, job).await;
    assert_eq!(state.status, "completed");
    assert_eq!(state.attempt_count, 1);
    assert_eq!(state.source_release_state, "released");
    assert!(state.quota_released_at.is_some());
    assert_eq!(accounting(&fixture).await, (1, 1, 1, 1, 0, 0));
    let source = fixture.runtime.spool.acquire(upload.id).await.unwrap();
    assert!(source.open_durable_source().unwrap().is_none());
}

fn complete_request(
    upload: &Upload,
    cookie: &Cookie<'static>,
    asynchronous: bool,
) -> test::TestRequest {
    test::TestRequest::post()
        .uri(&format!(
            "{}/complete",
            super::super::resource_location(upload.id)
        ))
        .cookie(cookie.clone())
        .insert_header(("tus-resumable", "1.0.0"))
        .set_json(json!({ "async_finalization": asynchronous }))
}

async fn accounting(fixture: &Fixture) -> (i64, i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "select
            (select count(*) from device_upload_finalization_job),
            (select count(*) from device_upload_finalization_attempt where origin='async'),
            (select count(*) from file_content),
            (select count(*) from file_content_upload_object),
            coalesce((select reserved_jobs from device_upload_finalization_budget where scope='global:file'), 0),
            coalesce((select reserved_source_bytes from device_upload_finalization_budget where scope='global:file'), 0)",
    )
    .fetch_one(fixture.db().get_postgres_connection_pool())
    .await
    .unwrap()
}

fn original_receipt(upload: &Upload) -> Value {
    json!({
        "upload_id": upload.id,
        "file_id": upload.file_id,
        "revision": 1,
        "status": "completed",
    })
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_twenty_admissions_and_mixed_replays_share_one_job() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("concurrent-admission").await;
    let upload = fixture.upload(&file, b"one publication").await;
    drop(fixture.seed_bytes(&upload, b"one publication").await);
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let responses = join_all((0..20).map(|_| {
        test::call_service(
            &app,
            complete_request(&upload, &cookie, true).to_request(),
        )
    }))
    .await;
    let mut responses = responses.into_iter();
    drop(responses.next().unwrap());
    let mut accepted_job = None;
    for mut response in responses {
        // A contender can outwait the source-lock budget while the holder
        // commits the job; it then gets the documented busy answer and a
        // retry replays the committed job.
        if response.status() == StatusCode::SERVICE_UNAVAILABLE {
            assert!(response.headers().contains_key(header::RETRY_AFTER));
            assert_eq!(
                test::read_body_json::<Value, _>(response).await["code"],
                "upload_busy"
            );
            response = test::call_service(
                &app,
                complete_request(&upload, &cookie, true).to_request(),
            )
            .await;
        }
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
        let body: Value = test::read_body_json(response).await;
        let job_id = Uuid::parse_str(body["job_id"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({"status": "queued", "job_id": job_id}));
        assert_eq!(*accepted_job.get_or_insert(job_id), job_id);
    }
    let job_id = accepted_job.unwrap();
    assert_file_job_reserved(&fixture, &upload, job_id).await;
    assert_eq!(accounting(&fixture).await, (1, 0, 0, 0, 1, 15));
    let original_job = persisted_file_job(&fixture, job_id).await;
    let original_upload = fixture.persisted(&upload).await;
    let env_disabled = async_file_env(&env, &fixture, false);
    let app_disabled = app!(env_disabled);
    let cookie = cookie!(app_disabled, fixture.login.id);
    let responses = join_all((0..20).map(|index| {
        test::call_service(
            &app_disabled,
            complete_request(&upload, &cookie, index % 2 == 0).to_request(),
        )
    }))
    .await;
    for (index, response) in responses.into_iter().enumerate() {
        if index % 2 == 0 {
            assert_eq!(response.status(), StatusCode::ACCEPTED);
            assert_eq!(
                test::read_body_json::<Value, _>(response).await,
                json!({"status": "queued", "job_id": job_id})
            );
        } else {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert!(response.headers().contains_key(header::RETRY_AFTER));
            let body: Value = test::read_body_json(response).await;
            assert!(body.get("job_id").is_none());
        }
    }
    assert_eq!(persisted_file_job(&fixture, job_id).await, original_job);
    assert_eq!(fixture.persisted(&upload).await, original_upload);
    assert_eq!(accounting(&fixture).await, (1, 0, 0, 0, 1, 15));
    assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_eq!(accounting(&fixture).await, (1, 1, 1, 1, 1, 15));
    assert_eq!(
        persisted_file_job(&fixture, job_id).await.result.unwrap()["value"],
        original_receipt(&upload)
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_completed_snapshot_survives_cleanup_and_revision_change() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("completed-replay").await;
    let upload = fixture.upload(&file, b"completed source").await;
    drop(fixture.seed_bytes(&upload, b"completed source").await);
    let env = async_file_env(&env, &fixture, true);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        complete_request(&upload, &cookie, true).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot["job_id"], json!(job_id));
    assert_eq!(snapshot["status"], "completed");
    assert_eq!(snapshot["result"], original_receipt(&upload));
    assert!(snapshot["error"].is_null());
    assert!(snapshot["retry_after_seconds"].is_null());
    assert!(snapshot["finished_at"].is_string());
    worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
        .await
        .unwrap();
    resync_file(&env, &fixture, &file).await;
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert_eq!(accounting(&fixture).await, (1, 1, 1, 1, 0, 0));
    let original_job = persisted_file_job(&fixture, job_id).await;
    let provenance = file_content_upload_object::Entity::find_by_id(upload.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let env_disabled = async_file_env(&env, &fixture, false);
    let app = app!(env_disabled);
    let cookie = cookie!(app, fixture.login.id);
    let responses = join_all((0..20).map(|index| {
        test::call_service(
            &app,
            complete_request(&upload, &cookie, index % 2 == 0).to_request(),
        )
    }))
    .await;
    for (index, response) in responses.into_iter().enumerate() {
        assert_eq!(response.status(), StatusCode::OK);
        if index % 2 == 0 {
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "private, no-store"
            );
        }
        assert_eq!(
            test::read_body_json::<Value, _>(response).await,
            if index % 2 == 0 {
                snapshot.clone()
            } else {
                original_receipt(&upload)
            }
        );
    }
    assert_eq!(persisted_file_job(&fixture, job_id).await, original_job);
    assert_eq!(accounting(&fixture).await, (1, 1, 1, 1, 0, 0));
    assert_eq!(
        file_content_upload_object::Entity::find_by_id(upload.id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap(),
        provenance
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_failed_snapshot_replays_without_reexecuting_source() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("failed-replay").await;
    let upload = fixture.upload(&file, b"good").await;
    drop(fixture.seed_bytes(&upload, b"evil").await);
    let env = async_file_env(&env, &fixture, true);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        complete_request(&upload, &cookie, true).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot["job_id"], json!(job_id));
    assert_eq!(snapshot["status"], "failed");
    assert!(snapshot["result"].is_null());
    assert_eq!(snapshot["error"]["code"], "source_digest_mismatch");
    assert_eq!(snapshot["error"]["action"], "new_upload");
    assert!(snapshot["retry_after_seconds"].is_null());
    assert!(snapshot["finished_at"].is_string());
    worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
        .await
        .unwrap();
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    let original_job = persisted_file_job(&fixture, job_id).await;
    let original_accounting = accounting(&fixture).await;
    assert_eq!(original_accounting, (1, 0, 0, 0, 0, 0));
    let env_disabled = async_file_env(&env, &fixture, false);
    let app = app!(env_disabled);
    let cookie = cookie!(app, fixture.login.id);
    let responses = join_all((0..20).map(|index| {
        test::call_service(
            &app,
            complete_request(&upload, &cookie, index % 2 == 0).to_request(),
        )
    }))
    .await;
    for (index, response) in responses.into_iter().enumerate() {
        assert_eq!(
            response.status(),
            if index % 2 == 0 {
                StatusCode::OK
            } else {
                StatusCode::GONE
            }
        );
        assert_eq!(
            test::read_body_json::<Value, _>(response).await,
            if index % 2 == 0 {
                snapshot.clone()
            } else {
                json!({"code": "upload_rejected"})
            }
        );
    }
    assert_eq!(persisted_file_job(&fixture, job_id).await, original_job);
    assert_eq!(accounting(&fixture).await, original_accounting);
    assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_twenty_adoptions_keep_original_sync_receipt_after_reuse() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("sync-adoption").await;
    let upload = fixture.upload(&file, b"original source").await;
    drop(fixture.seed_bytes(&upload, b"original source").await);
    let env = async_file_env(&env, &fixture, false);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        complete_request(&upload, &cookie, false).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        original_receipt(&upload)
    );
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    resync_file(&env, &fixture, &file).await;
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/api/device/files/{}/{}/revisions/2/content-reuse", fixture.device.id, file.id))
            .cookie(cookie.clone())
            .insert_header(("tus-resumable", "1.0.0"))
            .set_json(json!({
                "source_upload_id": upload.id,
                "expected_size": 15,
                "expected_sha256": format!("{:x}", Sha256::digest(b"original source")),
            }))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await["revision"],
        2
    );
    let provenance = file_content_upload_object::Entity::find_by_id(upload.id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(accounting(&fixture).await, (0, 0, 2, 1, 0, 0));
    let responses = join_all((0..20).map(|index| {
        test::call_service(
            &app,
            complete_request(&upload, &cookie, index % 2 == 0).to_request(),
        )
    }))
    .await;
    let mut snapshot = None;
    for (index, response) in responses.into_iter().enumerate() {
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = test::read_body_json(response).await;
        if index % 2 == 0 {
            assert_eq!(body["status"], "completed");
            assert_eq!(body["result"], original_receipt(&upload));
            assert!(body["error"].is_null());
            assert_eq!(snapshot.get_or_insert_with(|| body.clone()), &body);
        } else {
            assert_eq!(body, original_receipt(&upload));
        }
    }
    let job_id =
        Uuid::parse_str(snapshot.unwrap()["job_id"].as_str().unwrap()).unwrap();
    let job = persisted_file_job(&fixture, job_id).await;
    assert_eq!(job.attempt_count, 0);
    assert!(job.winning_attempt_id.is_none());
    assert!(job.quota_released_at.is_some());
    assert_eq!(accounting(&fixture).await, (1, 0, 2, 1, 0, 0));
    assert_eq!(
        file_content_upload_object::Entity::find_by_id(upload.id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap(),
        provenance
    );
    let downloaded =
        crate::storage::download_and_decrypt_from_s3_with_operator(
            &Some(fixture.runtime.storage.clone()),
            &Some(fixture.runtime.storage_config.clone()),
            &fixture.runtime.strongbox_key,
            &provenance.object_key,
        )
        .await
        .unwrap();
    assert_eq!(downloaded, b"original source");
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_busy_sync_owner_bounds_async_admission() {
    use sea_orm::{DbBackend, Statement};
    use std::time::Duration;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("sync-owner").await;
    let upload = fixture.upload(&file, b"sync owner").await;
    drop(fixture.seed_bytes(&upload, b"sync owner").await);
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let barrier = fixture.db().begin().await.unwrap();
    let blocker: i32 = barrier
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_backend_pid() as blocker from file_entry where id=$1 for update",
            [file.id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "blocker")
        .unwrap();
    let (sync_response, (sync_waiting, async_response)) = tokio::join!(
        test::call_service(
            &app,
            complete_request(&upload, &cookie, false).to_request()
        ),
        async {
            let reached = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let blocked: bool = sqlx::query_scalar(
                        "select exists(select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid)))",
                    )
                        .bind(blocker)
                        .fetch_one(fixture.db().get_postgres_connection_pool())
                        .await
                        .unwrap();
                    if blocked {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.is_ok();
            let response = if reached {
                Some(
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        test::call_service(
                            &app,
                            complete_request(&upload, &cookie, true)
                                .to_request(),
                        ),
                    )
                    .await,
                )
            } else {
                None
            };
            barrier.rollback().await.unwrap();
            (reached, response)
        },
    );
    assert!(
        sync_waiting,
        "sync request did not reach the target lock with source ownership"
    );
    let response = async_response
        .unwrap()
        .expect("async request waited for sync publication");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    let body: Value = test::read_body_json(response).await;
    assert!(body.get("job_id").is_none());
    assert_eq!(sync_response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(sync_response).await,
        original_receipt(&upload)
    );
    assert_eq!(accounting(&fixture).await, (0, 0, 1, 1, 0, 0));
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_sync_adoption_preserves_pending_legacy_spool_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("sync-pending-cleanup").await;
    let upload = fixture.upload(&file, b"pending cleanup").await;
    let source = fixture.seed_bytes(&upload, b"pending cleanup").await;
    fixture
        .runtime
        .storage
        .write(
            &fixture
                .runtime
                .storage_config
                .prefixed_key(&upload.object_key),
            b"pending cleanup".to_vec(),
        )
        .await
        .unwrap();
    let publication = repository::publish(
        fixture.db(),
        &upload,
        false,
        Utc::now().fixed_offset(),
        None,
    )
    .await
    .unwrap();
    assert!(matches!(
        publication,
        repository::PublishOutcome::Completed(_)
    ));
    drop(source);
    assert!(fixture.persisted(&upload).await.spool_removed_at.is_none());
    let env = async_file_env(&env, &fixture, false);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let response = test::call_service(
        &app,
        complete_request(&upload, &cookie, true).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: Value = test::read_body_json(response).await;
    assert_eq!(snapshot["status"], "completed");
    assert_eq!(snapshot["result"], original_receipt(&upload));
    assert_eq!(accounting(&fixture).await, (1, 0, 1, 1, 0, 0));
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.lock", upload.id))
        .exists());
    assert!(fixture.persisted(&upload).await.spool_removed_at.is_some());
    assert_eq!(accounting(&fixture).await, (1, 0, 1, 1, 0, 0));
    assert_eq!(
        fixture
            .runtime
            .storage
            .read(&upload.object_key)
            .await
            .unwrap()
            .to_vec(),
        b"pending cleanup"
    );
    let response = test::call_service(
        &app,
        complete_request(&upload, &cookie, true).to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(test::read_body_json::<Value, _>(response).await, snapshot);
}

fn open_lock_descriptors(path: &std::path::Path) -> usize {
    use std::os::unix::fs::MetadataExt;

    let lock = std::fs::metadata(path).unwrap();
    std::fs::read_dir("/dev/fd")
        .unwrap()
        .filter_map(|entry| {
            let descriptor = entry.ok()?.file_name().to_str()?.parse().ok()?;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } != 0 {
                return None;
            }
            Some(unsafe { metadata.assume_init() })
        })
        .filter(|descriptor| {
            descriptor.st_dev as u64 == lock.dev()
                && descriptor.st_ino == lock.ino()
        })
        .count()
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_source_lock_timeout_rechecks_revoked_authorization() {
    use std::time::Duration;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    for asynchronous in [false, true] {
        let mut login = fixture.login.clone().into_active_model();
        login.roles = Set(json!([ROLE_CYBER]));
        login.update(&env.dbx).await.unwrap();
        let file = fixture.file("source-lock-revoked").await;
        let upload = fixture.upload(&file, b"retained source").await;
        let source = fixture.seed_bytes(&upload, b"retained source").await;
        let lock_path =
            fixture.spool.path().join(format!("{}.lock", upload.id));
        let initial_descriptors = open_lock_descriptors(&lock_path);
        assert!(initial_descriptors > 0);
        let original_upload = fixture.persisted(&upload).await;
        let (response, reached_source_lock) = tokio::join!(
            tokio::time::timeout(
                Duration::from_secs(2),
                test::call_service(
                    &app,
                    complete_request(&upload, &cookie, asynchronous)
                        .to_request(),
                ),
            ),
            async {
                let reached =
                    tokio::time::timeout(Duration::from_secs(1), async {
                        while open_lock_descriptors(&lock_path)
                            <= initial_descriptors
                        {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .is_ok();
                if reached {
                    let mut login = fixture.login.clone().into_active_model();
                    login.roles = Set(json!([]));
                    login.update(&env.dbx).await.unwrap();
                }
                reached
            },
        );
        assert!(
            reached_source_lock,
            "request never waited on the held source lock"
        );
        let response = response.expect("source lock wait was not bounded");
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "async={asynchronous}"
        );
        assert_eq!(fixture.persisted(&upload).await, original_upload);
        assert_eq!(accounting(&fixture).await, (0, 0, 0, 0, 0, 0));
        assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
        assert_eq!(
            std::fs::read(
                fixture.spool.path().join(format!("{}.data", upload.id))
            )
            .unwrap(),
            b"retained source"
        );
        drop(source);
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase6_file_sync_waiter_replays_publication_adopted_while_locked() {
    use std::time::Duration;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("sync-waiter-adoption").await;
    let upload = fixture.upload(&file, b"published while waiting").await;
    let source = fixture
        .seed_bytes(&upload, b"published while waiting")
        .await;
    let lock_path = fixture.spool.path().join(format!("{}.lock", upload.id));
    let initial_descriptors = open_lock_descriptors(&lock_path);
    let env = async_file_env(&env, &fixture, true);
    let app = app!(env);
    let cookie = cookie!(app, fixture.login.id);
    let (response, ()) = tokio::join!(
        test::call_service(
            &app,
            complete_request(&upload, &cookie, false).to_request()
        ),
        async {
            tokio::time::timeout(Duration::from_secs(1), async {
                while open_lock_descriptors(&lock_path) <= initial_descriptors {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .expect("sync request never reached held source lock");
            fixture
                .runtime
                .storage
                .write(
                    &fixture
                        .runtime
                        .storage_config
                        .prefixed_key(&upload.object_key),
                    b"published while waiting".to_vec(),
                )
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
            let adopted = test::call_service(
                &app,
                complete_request(&upload, &cookie, true).to_request(),
            )
            .await;
            assert_eq!(adopted.status(), StatusCode::OK);
            let snapshot: Value = test::read_body_json(adopted).await;
            assert_eq!(snapshot["result"], original_receipt(&upload));
            drop(source);
        }
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        original_receipt(&upload)
    );
    assert_eq!(accounting(&fixture).await, (1, 0, 1, 1, 0, 0));
}
