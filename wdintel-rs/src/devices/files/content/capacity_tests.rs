use super::*;
use crate::devices::upload_finalization::resources::{self, ResourceKind};

#[actix_web::test]
#[serial_test::serial]
async fn phase8_sync_file_storage_guards_bound_real_async_file_execution() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let env = async_file_env(&env, &fixture, true);
    let bytes = b"shared sync and async file storage capacity";
    let file = fixture.file("shared-storage-capacity").await;
    let upload = fixture.upload(&file, bytes).await;
    drop(fixture.seed_bytes(&upload, bytes).await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let encryption = resources::legacy_slot(&env, ResourceKind::Encryption)
        .await
        .unwrap()
        .unwrap();
    let readback = resources::legacy_slot(&env, ResourceKind::Readback)
        .await
        .unwrap()
        .unwrap();
    let claim = claim_file_job(&fixture, job_id).await;
    let operation = finalizer::finalize_claim(&env, &fixture.runtime, claim);
    tokio::pin!(operation);
    for guard in [encryption, readback] {
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            &mut operation,
        )
        .await
        .is_err());
        let job = device_upload_finalization_job::Entity::find_by_id(job_id)
            .one(fixture.db())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            job.status, "processing",
            "sync file storage guard did not bound async work"
        );
        assert_eq!(job.attempt_count, 1);
        assert!(fixture.runtime.storage.list("").await.unwrap().is_empty());
        drop(guard);
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), operation)
        .await
        .unwrap()
        .unwrap();
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(fixture.db())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.status, "completed");
    assert_eq!(job.attempt_count, 1);
    assert_selected_file_bytes(&fixture, &upload, job_id, bytes).await;
}

#[actix_web::test]
#[serial_test::serial]
async fn phase8_full_write_credit_retries_before_put_and_preserves_file_source()
{
    use crate::devices::upload_finalization::{
        query, recovery,
        types::{FinalizationFailure, FinalizationKind, WriteResolution},
        worker::{claim_due, ClaimLane},
    };

    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let mut env = (*async_file_env(&env, &fixture, true)).clone();
    env.config
        .device_upload_finalization
        .as_mut()
        .unwrap()
        .file_unresolved_writes = 1;
    let db = fixture.db();
    let bytes = b"file source retained while write credit is full";
    let first = fixture.file("unresolved-credit").await;
    let held = fixture.upload(&first, bytes).await;
    drop(fixture.seed_bytes(&held, bytes).await);
    let held_job = admit_file_source(&fixture, &held).await;
    let held_claim = claim_file_job(&fixture, held_job).await;
    let held_attempt =
        query::create_attempt(db, &held_claim, true).await.unwrap();
    assert!(query::prepare_attempt(
        db,
        &held_claim,
        held_attempt,
        bytes.len() as i64,
        &held.expected_sha256,
        None,
    )
    .await
    .unwrap());
    assert!(query::record_write_intent(db, &held_claim, held_attempt, 1)
        .await
        .unwrap());
    assert!(recovery::schedule_retry(
        db,
        &held_claim,
        &FinalizationFailure::StorageOutcomeUnknown,
        true,
        3600,
    )
    .await
    .unwrap());
    let file = fixture.file("waiting-for-credit").await;
    let upload = fixture.upload(&file, bytes).await;
    drop(fixture.seed_bytes(&upload, bytes).await);
    let job_id = admit_file_source(&fixture, &upload).await;
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.status, "retry_wait");
    assert_eq!(
        job.error_code.as_deref(),
        Some("execution_capacity_unavailable")
    );
    assert_eq!(job.source_release_state, "held");
    assert!(job.quota_released_at.is_none());
    assert!(fixture
        .spool
        .path()
        .join(format!("{}.data", upload.id))
        .exists());
    let attempt = device_upload_finalization_attempt::Entity::find_by_id(
        job.active_attempt_id.unwrap(),
    )
    .one(db)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(attempt.phase, "prepared");
    assert!(attempt.write_intent_at.is_none());
    assert!(!attempt.write_credit_held);
    assert_eq!(
        fixture
            .runtime
            .storage
            .stat(&attempt.object_key)
            .await
            .unwrap_err()
            .kind(),
        opendal::ErrorKind::NotFound
    );
    let credits: i64 = sqlx::query_scalar("select unresolved_writes from device_upload_finalization_budget where scope='global:file'")
        .fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(credits, 1);
    assert!(
        device_upload_finalization_attempt::Entity::find_by_id(held_attempt)
            .one(db)
            .await
            .unwrap()
            .unwrap()
            .write_credit_held
    );
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(held_job).execute(db.get_postgres_connection_pool()).await.unwrap();
    let reconciled = claim_due(
        db,
        FinalizationKind::FinalizationFileKind,
        Uuid::new_v4(),
        ClaimLane::Reconcile,
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reconciled.job_id, held_job);
    assert!(query::record_write_resolution(
        db,
        &reconciled,
        held_attempt,
        WriteResolution::DefinitelyNotDispatched
    )
    .await
    .unwrap());
    assert!(query::release_write_credit(db, held_attempt).await.unwrap());
    sqlx::query("update device_upload_finalization_job set next_run_at=clock_timestamp()-interval '1 second' where id=$1")
        .bind(job_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let claim = claim_file_job(&fixture, job_id).await;
    finalizer::finalize_claim(&env, &fixture.runtime, claim)
        .await
        .unwrap();
    let job = device_upload_finalization_job::Entity::find_by_id(job_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.status, "completed");
    assert_selected_file_bytes(&fixture, &upload, job_id, bytes).await;
}
