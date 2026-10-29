use super::*;
use crate::devices::upload_finalization::{
    query, recovery,
    resources::{self, ResourceKind},
    types::*,
    worker::{claim_due, ClaimLane},
};
use crate::storage::finalization::ManagedStorage;
use std::path::Path;
use std::time::Duration as StdDuration;

const SOURCE: &[u8] = b"durable file after child exit";
const CHILD_TEST: &str = "devices::files::content::acceptance_tests::async_recovery_tests::phase7_file_boundary_child";

fn filesystem_storage(root: &Path) -> opendal::Operator {
    opendal::Operator::new(
        opendal::services::Fs::default().root(root.to_str().unwrap()),
    )
    .unwrap()
    .finish()
}

fn share_runtime_storage(
    runtime: &mut DeviceFileContentRuntime,
    root: &Path,
    key: &str,
) {
    runtime.storage = filesystem_storage(root);
    runtime.strongbox_key = key.to_owned();
    runtime.managed_storage = Arc::new(
        ManagedStorage::for_test(
            runtime.storage.clone(),
            runtime.storage_config.clone(),
            key,
        )
        .unwrap(),
    );
}

async fn run_boundary_child(fixture: &Fixture, stage: &str) {
    let output = tokio::time::timeout(
        StdDuration::from_secs(60),
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--ignored", "--nocapture"])
            .env("ECHO_FILE_RECOVERY_STAGE", stage)
            .env("ECHO_FILE_RECOVERY_ROOT", fixture.spool.path())
            .env("ECHO_FILE_RECOVERY_KEY", &fixture.runtime.strongbox_key)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        output.status.code(),
        Some(73),
        "stage={stage}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

fn exit_boundary(stage: &str, boundary: &str) {
    if stage == boundary {
        std::process::exit(73);
    }
}

async fn write_attempt(
    runtime: &DeviceFileContentRuntime,
    object: &VerifiedFinalizationObject,
) {
    crate::storage::upload_encrypted_to_s3_with_operator(
        &Some(runtime.storage.clone()),
        &runtime.storage_config,
        &runtime.strongbox_key,
        &object.object_key,
        web::Bytes::from_static(SOURCE),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "child entry point; run only through phase7 file recovery tests"]
async fn phase7_file_boundary_child() {
    let stage = std::env::var("ECHO_FILE_RECOVERY_STAGE").unwrap();
    let root = std::path::PathBuf::from(
        std::env::var_os("ECHO_FILE_RECOVERY_ROOT").unwrap(),
    );
    let key = std::env::var("ECHO_FILE_RECOVERY_KEY").unwrap();
    let upload_id: Uuid = std::fs::read_to_string(root.join("upload-id"))
        .unwrap()
        .parse()
        .unwrap();
    let env = crate::server::new_readonly_env(crate::types::Mode::Test)
        .await
        .unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let database: String = sqlx::query_scalar("select current_database()")
        .fetch_one(db.get_postgres_connection_pool())
        .await
        .unwrap();
    assert_eq!(database, std::env::var("TEST_WDFILE_DB_NAME").unwrap());
    assert_ne!(database, "wd_files_test");
    let mut runtime = runtime_for_test(
        env.file_registry_db().unwrap().clone(),
        root.clone(),
        filesystem_storage(&root.join("objects")),
        None,
    )
    .await;
    share_runtime_storage(
        Arc::get_mut(&mut runtime).unwrap(),
        &root.join("objects"),
        &key,
    );
    let upload = repository::load_upload(db, upload_id)
        .await
        .unwrap()
        .unwrap();
    let accepted_upload = file_content_upload::Entity::find_by_id(upload_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let spool = runtime.spool.acquire(upload_id).await.unwrap();
    spool.make_durable(upload.upload_length).await.unwrap();
    exit_boundary(&stage, "source_fsync");
    let job = crate::devices::upload_finalization::admission::admit(
        db,
        &FinalizationCommand {
            created_by_login_id: accepted_upload.created_by_login_id,
            device_id: upload.device_id,
            source_size_bytes: upload.upload_length as i64,
            source_locator: Some(format!("{}.data", upload.id)),
            target: FinalizationTarget::File {
                upload_id: upload.id,
                file_id: upload.file_id,
                revision: upload.revision,
            },
        },
        &DeviceUploadFinalizationSettings {
            enabled: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    exit_boundary(&stage, "accepted_commit");
    let claim = claim_due(
        db,
        FinalizationKind::FinalizationFileKind,
        Uuid::new_v4(),
        ClaimLane::Work,
        600,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, job.job_id);
    let attempt = query::create_attempt(db, &claim, true).await.unwrap();
    assert!(query::prepare_attempt(
        db,
        &claim,
        attempt,
        SOURCE.len() as i64,
        &upload.expected_sha256,
        None,
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(db, &claim, attempt, 4)
        .await
        .unwrap());
    exit_boundary(&stage, "write_intent");
    let object = query::active_object(db, &claim).await.unwrap().unwrap();
    write_attempt(&runtime, &object).await;
    exit_boundary(&stage, "put_before_ack");
    let guard = resources::try_acquire_file(&root, ResourceKind::Readback, 1)
        .unwrap()
        .unwrap();
    assert!(matches!(
        runtime
            .managed_storage
            .clone()
            .reconcile(db, &claim, guard, StdDuration::from_secs(10))
            .await
            .unwrap(),
        recovery::Reconciliation::Verified(_)
    ));
    exit_boundary(&stage, "verified_readback");
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    repository::publish_file_in(&mut transaction, &claim, &object)
        .await
        .unwrap();
    exit_boundary(&stage, "publication_before_commit");
    transaction.commit().await.unwrap();
    exit_boundary(&stage, "publication_commit");
    spool.remove_durable_source().await.unwrap();
    exit_boundary(&stage, "source_removed_before_receipt");
    panic!("unknown child boundary: {stage}");
}

async fn reclaim_file(fixture: &Fixture, job: Uuid) -> ClaimedFinalizationJob {
    sqlx::query("update device_upload_finalization_job set lease_until=case when lease_owner is null then null else clock_timestamp()-interval '1 second' end,next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job).execute(fixture.db().get_postgres_connection_pool()).await.unwrap();
    let requires_reconciliation: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and ((write_intent_at is not null and phase not in ('retired','selected')) or write_credit_held))")
        .bind(job).fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
    let claim = claim_due(
        fixture.db(),
        FinalizationKind::FinalizationFileKind,
        Uuid::new_v4(),
        if requires_reconciliation {
            ClaimLane::Reconcile
        } else {
            ClaimLane::Work
        },
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim.job_id, job);
    claim
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_file_child_exits_recover_same_source_attempt_and_publication() {
    for stage in [
        "source_fsync",
        "accepted_commit",
        "write_intent",
        "put_before_ack",
        "verified_readback",
        "publication_before_commit",
        "publication_commit",
        "source_removed_before_receipt",
    ] {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let mut fixture = Fixture::new(&env).await;
        let key = fixture.runtime.strongbox_key.clone();
        let objects = fixture.spool.path().join("objects");
        share_runtime_storage(
            Arc::get_mut(&mut fixture.runtime).unwrap(),
            &objects,
            &key,
        );
        let file = fixture.file(stage).await;
        let upload = fixture.upload(&file, SOURCE).await;
        drop(fixture.seed_bytes(&upload, SOURCE).await);
        std::fs::write(
            fixture.spool.path().join("upload-id"),
            upload.id.to_string(),
        )
        .unwrap();
        run_boundary_child(&fixture, stage).await;
        let before =
            query::read_file_job(fixture.db(), upload.id).await.unwrap();
        assert_eq!(before.is_none(), stage == "source_fsync");
        let job_id = match before {
            Some((job, _)) => job.id,
            None => admit_file_source(&fixture, &upload).await,
        };
        let before = device_upload_finalization_job::Entity::find_by_id(job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        let active_attempt = before.active_attempt_id;
        let committed = matches!(
            stage,
            "publication_commit" | "source_removed_before_receipt"
        );
        assert_eq!(before.status == "completed", committed, "stage={stage}");
        let mut env = async_file_env(&env, &fixture, false);
        if !committed {
            let claim = reclaim_file(&fixture, job_id).await;
            finalizer::finalize_claim(&env, &fixture.runtime, claim.clone())
                .await
                .unwrap();
            if stage == "write_intent" {
                let pending =
                    device_upload_finalization_job::Entity::find_by_id(job_id)
                        .one(fixture.db())
                        .await
                        .unwrap()
                        .unwrap();
                assert_eq!(pending.status, "outcome_unknown");
                assert_eq!(pending.active_attempt_id, active_attempt);
                assert_eq!(pending.source_release_state, "held");
                assert_finalization_source_unpublished(
                    &fixture, &upload, SOURCE,
                )
                .await;
                let object = query::active_object(fixture.db(), &claim)
                    .await
                    .unwrap()
                    .unwrap();
                let attempt =
                    device_upload_finalization_attempt::Entity::find_by_id(
                        object.attempt_id,
                    )
                    .one(fixture.db())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(attempt.write_credit_held);
                assert!(!fixture
                    .runtime
                    .storage
                    .exists(&object.object_key)
                    .await
                    .unwrap());
                let entries = fixture
                    .runtime
                    .storage
                    .list_with("")
                    .recursive(true)
                    .await
                    .unwrap();
                assert!(entries.iter().all(|entry| entry.metadata().is_dir()),
                    "write-intent recovery wrote an unexpected object: {entries:?}");
                write_attempt(&fixture.runtime, &object).await;
                let claim = reclaim_file(&fixture, job_id).await;
                finalizer::finalize_claim(&env, &fixture.runtime, claim)
                    .await
                    .unwrap();
            }
        }
        assert_selected_file_bytes(&fixture, &upload, job_id, SOURCE).await;
        let completed =
            device_upload_finalization_job::Entity::find_by_id(job_id)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(completed.status, "completed", "stage={stage}");
        if let Some(attempt) = active_attempt {
            assert_eq!(completed.winning_attempt_id, Some(attempt));
        }
        if stage == "publication_commit" {
            let settings = system_settings::Entity::find()
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            let mut settings = settings.into_active_model();
            settings.messenger_media_cache_enabled = Set(Some(true));
            settings.messenger_media_cache_retention_hours = Set(Some(24));
            settings.messenger_media_cache_max_size_gib = Set(Some(1));
            settings.messenger_media_cache_min_free_gib = Set(Some(0));
            settings.update(&env.dbx).await.unwrap();
            let blocked_cache = fixture.spool.path().join("blocked-cache-root");
            std::fs::write(&blocked_cache, b"not a cache directory").unwrap();
            let configuration = &mut Arc::get_mut(&mut env).unwrap().config;
            configuration.storage_dir = blocked_cache.display().to_string();
            configuration.s3_config = Some(crate::config::S3Config {
                s3_endpoint: "https://storage.invalid".into(),
                s3_region: "test".into(),
                s3_bucket: fixture.runtime.storage_config.bucket.clone(),
                s3_access_key_id: String::new(),
                s3_secret_access_key: String::new(),
                strongbox_key: fixture.runtime.strongbox_key.clone(),
            });
        }
        worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
            .await
            .unwrap();
        worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
            .await
            .unwrap();
        let released =
            device_upload_finalization_job::Entity::find_by_id(job_id)
                .one(fixture.db())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(released.result, completed.result);
        assert_eq!(released.status, "completed");
        assert_eq!(released.source_release_state, "released");
        assert!(released.quota_released_at.is_some());
        let counts: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
            "select
                (select count(*) from device_upload_finalization_job),
                (select count(*) from device_upload_finalization_attempt where origin='async'),
                (select count(*) from file_content),
                (select count(*) from file_content_upload_object),
                (select reserved_jobs from device_upload_finalization_budget where scope='global:file'),
                (select reserved_source_bytes from device_upload_finalization_budget where scope='global:file')",
        ).fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
        assert_eq!(counts, (1, 1, 1, 1, 0, 0), "stage={stage}");
        if stage == "publication_commit" {
            let selected =
                file_content_upload_object::Entity::find_by_id(upload.id)
                    .one(fixture.db())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(super::super::local_cache::read_bytes(
                &env,
                &selected.object_key,
                SOURCE.len() as u64,
                true,
            )
            .await
            .is_none());
        }
        assert!(!fixture
            .spool
            .path()
            .join(format!("{}.data", upload.id))
            .exists());
        assert_selected_file_bytes(&fixture, &upload, job_id, SOURCE).await;
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_file_takeover_rejects_old_fence_and_repeated_late_key_cleanup()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let mut fixture = Fixture::new(&env).await;
    let key = fixture.runtime.strongbox_key.clone();
    let objects = fixture.spool.path().join("objects");
    share_runtime_storage(
        Arc::get_mut(&mut fixture.runtime).unwrap(),
        &objects,
        &key,
    );
    let file = fixture.file("late-legacy-write").await;
    let upload = fixture.upload(&file, SOURCE).await;
    drop(fixture.seed_bytes(&upload, SOURCE).await);
    std::fs::write(
        fixture.spool.path().join("upload-id"),
        upload.id.to_string(),
    )
    .unwrap();
    run_boundary_child(&fixture, "put_before_ack").await;
    let job = device_upload_finalization_job::Entity::find()
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    let stale = ClaimedFinalizationJob {
        job_id: job.id,
        owner: job.lease_owner.unwrap(),
        lease_epoch: job.lease_epoch,
        kind: FinalizationKind::FinalizationFileKind,
        requires_reconciliation: false,
    };
    let object = query::active_object(fixture.db(), &stale)
        .await
        .unwrap()
        .unwrap();
    let claim = reclaim_file(&fixture, job.id).await;
    assert!(claim.lease_epoch > stale.lease_epoch);
    assert!(
        !query::record_verified(fixture.db(), &stale, object.attempt_id)
            .await
            .unwrap()
    );
    let mut transaction = fixture
        .db()
        .get_postgres_connection_pool()
        .begin()
        .await
        .unwrap();
    let error = repository::publish_file_in(&mut transaction, &stale, &object)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(&FinalizationFailure::StaleClaim)
    );
    transaction.rollback().await.unwrap();
    let env = async_file_env(&env, &fixture, false);
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    assert_selected_file_bytes(&fixture, &upload, job.id, SOURCE).await;
    let retired: Uuid = sqlx::query_scalar("select id from device_upload_finalization_attempt where job_id=$1 and origin='legacy_cleanup' and object_key=$2 and phase='retired'")
        .bind(job.id).bind(&upload.object_key).fetch_one(fixture.db().get_postgres_connection_pool()).await.unwrap();
    for _ in 0..2 {
        fixture
            .runtime
            .storage
            .write(&upload.object_key, b"late obsolete PUT".to_vec())
            .await
            .unwrap();
        assert!(fixture
            .runtime
            .managed_storage
            .cleanup_retired(fixture.db(), retired, StdDuration::from_secs(5))
            .await
            .unwrap());
        assert!(
            fixture
                .runtime
                .storage
                .stat(&upload.object_key)
                .await
                .unwrap_err()
                .kind()
                == opendal::ErrorKind::NotFound
        );
        assert!(!fixture
            .runtime
            .managed_storage
            .cleanup_retired(
                fixture.db(),
                object.attempt_id,
                StdDuration::from_secs(5)
            )
            .await
            .unwrap());
        assert_selected_file_bytes(&fixture, &upload, job.id, SOURCE).await;
    }
    let retired =
        device_upload_finalization_attempt::Entity::find_by_id(retired)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
    assert!(retired.cleanup_confirmed_at.is_some());
    assert!(retired.cleanup_next_at.is_some());
    assert!(retired.late_write_possible);
}

#[actix_web::test]
#[serial_test::serial]
async fn phase7_file_restart_pin_survives_old_ttl_and_filesync_stale_cleanup() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let file = fixture.file("accepted-before-stale").await;
    let upload = fixture.upload(&file, SOURCE).await;
    drop(fixture.seed_bytes(&upload, SOURCE).await);
    std::fs::write(
        fixture.spool.path().join("upload-id"),
        upload.id.to_string(),
    )
    .unwrap();
    run_boundary_child(&fixture, "accepted_commit").await;
    let job_id = query::read_file_job(fixture.db(), upload.id)
        .await
        .unwrap()
        .unwrap()
        .0
        .id;
    let mut clock = fixture
        .db()
        .get_postgres_connection_pool()
        .begin()
        .await
        .unwrap();
    sqlx::query("set local session_replication_role=replica")
        .execute(&mut *clock)
        .await
        .unwrap();
    sqlx::query("update file_content_upload set created_at=statement_timestamp()-interval '4 days',last_activity_at=statement_timestamp()-interval '3 days',expires_at=statement_timestamp()-interval '2 days',hard_expires_at=statement_timestamp()-interval '1 day',next_cleanup_at=statement_timestamp()-interval '2 days' where id=$1")
        .bind(upload.id).execute(&mut *clock).await.unwrap();
    sqlx::query("set local session_replication_role=origin")
        .execute(&mut *clock)
        .await
        .unwrap();
    clock.commit().await.unwrap();
    let aged = fixture.persisted(&upload).await;
    assert!(aged.expires_at < Utc::now());
    assert!(aged.hard_expires_at < Utc::now());
    let env = async_file_env(&env, &fixture, false);
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert!(query::file_source_is_pinned(fixture.db(), upload.id)
        .await
        .unwrap());
    assert_finalization_source_unpublished(&fixture, &upload, SOURCE).await;
    resync_file(&env, &fixture, &file).await;
    worker::cleanup_one_for_test(&env, &fixture.runtime, upload.id)
        .await
        .unwrap();
    assert_eq!(
        fixture.persisted(&upload).await.status,
        crate::file_registry::entities::sea_orm_active_enums::FileContentUploadStatus::Stale
    );
    assert!(file_content::Entity::find_by_id((
        upload.file_id,
        upload.revision
    ))
    .one(fixture.db())
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        std::fs::read(fixture.spool.path().join(format!("{}.data", upload.id)))
            .unwrap(),
        SOURCE
    );
    assert!(query::file_source_is_pinned(fixture.db(), upload.id)
        .await
        .unwrap());
    let claim = reclaim_file(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let failed = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(
        failed.error_code.as_deref(),
        Some("target_revision_changed")
    );
    assert!(failed.result.is_none());
    worker::cleanup_finalization_for_test(&env, &fixture.runtime, job_id)
        .await
        .unwrap();
    assert!(!fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    assert!(!query::file_source_is_pinned(fixture.db(), upload.id)
        .await
        .unwrap());
}
