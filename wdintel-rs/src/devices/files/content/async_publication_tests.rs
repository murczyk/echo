use super::*;
use crate::devices::upload_finalization::{admission, query, types::*, worker};
use crate::file_registry::entities::{
    file_content, file_entry, sea_orm_active_enums::FileEntryKind,
};
use crate::functest::tests::cleanup_locked;
use crate::types::DeviceUploadFinalizationSettings;
use chrono::Utc;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;

struct PublicationFixture {
    upload: Upload,
    claim: ClaimedFinalizationJob,
    verified: VerifiedFinalizationObject,
}

impl PublicationFixture {
    async fn new(db: &DatabaseConnection, expired: bool) -> Self {
        Self::named(db, expired, "accepted.txt").await
    }

    async fn named(db: &DatabaseConnection, expired: bool, name: &str) -> Self {
        let file_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        let actor = Uuid::new_v4();
        let now = Utc::now().naive_utc();
        let root_id = Uuid::new_v4();
        file_entry::ActiveModel {
            id: Set(root_id),
            device_id: Set(device_id),
            kind: Set(FileEntryKind::Directory),
            name: Set("C:\\".into()),
            hierarchy_path: Set(format!("n{}", root_id.simple())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        crate::file_registry::test_support::insert_entry(
            db,
            file_entry::ActiveModel {
                id: Set(file_id),
                device_id: Set(device_id),
                parent_id: Set(Some(root_id)),
                kind: Set(FileEntryKind::File),
                name: Set(name.into()),
                absolute_path: Set(Some(format!("C:\\{name}"))),
                hierarchy_path: Set(format!(
                    "n{}.n{}",
                    root_id.simple(),
                    file_id.simple()
                )),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            },
        )
        .await;
        let bytes = b"accepted source";
        let outcome = create_or_replay(
            db,
            NewUpload {
                device_id,
                file_id,
                revision: 1,
                created_by_login_id: actor,
                upload_length: bytes.len() as u64,
                expected_sha256: Sha256::digest(bytes).into(),
                available_spool_bytes: u64::MAX,
                now: (Utc::now()
                    - chrono::Duration::days(if expired { 15 } else { 0 }))
                .fixed_offset(),
            },
            &ContentLimitsConfig::default(),
        )
        .await
        .unwrap();
        let CreateOutcome::Created(upload) = outcome else {
            panic!("expected new upload: {outcome:?}");
        };
        let job = admission::admit(
            db,
            &FinalizationCommand {
                created_by_login_id: actor,
                device_id,
                source_size_bytes: bytes.len() as i64,
                source_locator: Some(format!("{}.data", upload.id)),
                target: FinalizationTarget::File {
                    upload_id: upload.id,
                    file_id,
                    revision: 1,
                },
            },
            &DeviceUploadFinalizationSettings {
                enabled: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let claim = worker::claim_due(
            db,
            FinalizationKind::FinalizationFileKind,
            Uuid::new_v4(),
            worker::ClaimLane::Work,
            60,
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
            bytes.len() as i64,
            &upload.expected_sha256,
            None,
        )
        .await
        .unwrap());
        assert!(query::record_write_intent(db, &claim, attempt, 4)
            .await
            .unwrap());
        assert!(query::record_verified(db, &claim, attempt).await.unwrap());
        let verified = query::active_object(db, &claim).await.unwrap().unwrap();
        Self {
            upload,
            claim,
            verified,
        }
    }

    async fn assert_unpublished(&self, db: &DatabaseConnection) {
        let row = sqlx::query("select u.status::text as upload_status,j.status as job_status,exists(select 1 from file_content_upload_object where upload_id=u.id) as selected,exists(select 1 from file_content where upload_id=u.id) as published from file_content_upload u join device_upload_finalization_job j on j.file_upload_id=u.id where u.id=$1")
            .bind(self.upload.id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
        assert_eq!(row.get::<String, _>("upload_status"), "open");
        assert_eq!(row.get::<String, _>("job_status"), "processing");
        assert!(!row.get::<bool, _>("selected"));
        assert!(!row.get::<bool, _>("published"));
    }
}

#[tokio::test]
#[serial_test::serial]
async fn async_zip_publication_queues_preparation_atomically() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::named(db, false, "accepted.zip").await;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    publish_file_in(&mut transaction, &fixture.claim, &fixture.verified)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let archive = sqlx::query("select a.state,a.source_object_key,a.source_sha256,a.source_size_bytes,a.source_is_encrypted,j.status as job_status,u.status::text as upload_status from file_archive a join file_content_upload u on u.file_id=a.source_file_id and u.revision=a.source_revision join device_upload_finalization_job j on j.file_upload_id=u.id where u.id=$1")
        .bind(fixture.upload.id).fetch_optional(db.get_postgres_connection_pool()).await.unwrap()
        .expect("published ZIP must have a preparation job");
    assert_eq!(archive.get::<String, _>("state"), "queued");
    assert_eq!(archive.get::<String, _>("job_status"), "completed");
    assert_eq!(archive.get::<String, _>("upload_status"), "completed");
    assert_eq!(
        archive.get::<String, _>("source_object_key"),
        fixture.verified.object_key
    );
    assert_eq!(
        archive.get::<Vec<u8>, _>("source_sha256"),
        fixture.upload.expected_sha256
    );
    assert_eq!(
        archive.get::<i64, _>("source_size_bytes"),
        b"accepted source".len() as i64
    );
    assert!(archive.get::<bool, _>("source_is_encrypted"));
    crate::devices::files::archive::enqueue::ensure_in(
        db,
        fixture.upload.device_id,
        fixture.upload.file_id,
        1,
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("select count(*) from file_archive where source_file_id=$1 and source_revision=1")
        .bind(fixture.upload.file_id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
#[serial_test::serial]
async fn async_zip_enqueue_failure_rolls_back_publication() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::named(db, false, "accepted.zip").await;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    sqlx::raw_sql("create function pg_temp.reject_archive_enqueue() returns trigger language plpgsql as $$ begin raise exception 'archive enqueue rejected'; end $$; create trigger reject_archive_enqueue before insert on file_archive for each row execute function pg_temp.reject_archive_enqueue()")
        .execute(&mut *transaction).await.unwrap();
    let result =
        publish_file_in(&mut transaction, &fixture.claim, &fixture.verified)
            .await;
    transaction.rollback().await.unwrap();
    let error =
        result.expect_err("archive enqueue failure must fail publication");
    assert!(format!("{error:#}").contains("archive enqueue rejected"));
    fixture.assert_unpublished(db).await;
    let count: i64 = sqlx::query_scalar(
        "select count(*) from file_archive where source_file_id=$1",
    )
    .bind(fixture.upload.file_id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_accepted_publication_uses_verified_key_after_legacy_expiry() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, true).await;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    let receipt =
        publish_file_in(&mut transaction, &fixture.claim, &fixture.verified)
            .await
            .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(
        receipt,
        CompletedContent {
            upload_id: fixture.upload.id,
            file_id: fixture.upload.file_id,
            revision: 1,
            status: "completed",
        }
    );
    let row = sqlx::query("select u.status::text as upload_status,e.content_path,c.object_key,c.is_encrypted,o.attempt_id,a.phase,j.status as job_status,j.result,j.source_release_state from file_content_upload u join file_entry e on e.id=u.file_id join file_content c on c.upload_id=u.id join file_content_upload_object o on o.upload_id=u.id join device_upload_finalization_attempt a on a.id=o.attempt_id join device_upload_finalization_job j on j.id=a.job_id where u.id=$1")
        .bind(fixture.upload.id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(row.get::<String, _>("upload_status"), "completed");
    assert_eq!(
        row.get::<String, _>("content_path"),
        fixture.verified.object_key
    );
    assert_eq!(
        row.get::<String, _>("object_key"),
        fixture.verified.object_key
    );
    assert_ne!(fixture.verified.object_key, fixture.upload.object_key);
    assert!(row.get::<bool, _>("is_encrypted"));
    assert_eq!(
        row.get::<Uuid, _>("attempt_id"),
        fixture.verified.attempt_id
    );
    assert_eq!(row.get::<String, _>("phase"), "selected");
    assert_eq!(row.get::<String, _>("job_status"), "completed");
    assert_eq!(
        row.get::<String, _>("source_release_state"),
        "release_pending"
    );
    assert_eq!(
        row.get::<serde_json::Value, _>("result"),
        json!({"version":1,"value":{
            "upload_id":fixture.upload.id,"file_id":fixture.upload.file_id,"revision":1,"status":"completed"
        }})
    );
    assert_eq!(
        reconcile_publication(db, fixture.upload.id).await.unwrap(),
        Some(receipt)
    );
    let canonical = sqlx::query("select phase,late_write_possible from device_upload_finalization_attempt where job_id=$1 and object_key=$2 and origin='legacy_cleanup'")
        .bind(fixture.claim.job_id).bind(&fixture.upload.object_key).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(canonical.get::<String, _>("phase"), "retired");
    assert!(canonical.get::<bool, _>("late_write_possible"));
    // The fixture device is new, so publication creates its stats row.
    let stats = sqlx::query("select s.epoch,s.content_count,s.content_bytes,u.stats_epoch,(select sum(content_count) from device_content_stat_extension where device_id=s.device_id)::bigint as extension_count,(select sum(content_count) from device_content_stat_day where device_id=s.device_id)::bigint as day_count from device_content_stat s join file_content_upload u on u.device_id=s.device_id where u.id=$1")
        .bind(fixture.upload.id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(stats.get::<i64, _>("content_count"), 1);
    assert_eq!(
        stats.get::<i64, _>("content_bytes"),
        fixture.upload.upload_length as i64
    );
    assert_eq!(
        stats.get::<i64, _>("stats_epoch"),
        stats.get::<i64, _>("epoch")
    );
    assert_eq!(stats.get::<i64, _>("extension_count"), 1);
    assert_eq!(stats.get::<i64, _>("day_count"), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_accepted_publication_rolls_back_all_selected_evidence() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    publish_file_in(&mut transaction, &fixture.claim, &fixture.verified)
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    fixture.assert_unpublished(db).await;
    assert!(!sqlx::query_scalar::<_, bool>(
        "select exists(select 1 from device_content_stat where device_id=$1)"
    )
    .bind(fixture.upload.device_id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "select phase from device_upload_finalization_attempt where id=$1"
        )
        .bind(fixture.verified.attempt_id)
        .fetch_one(db.get_postgres_connection_pool())
        .await
        .unwrap(),
        "verified"
    );
    assert!(
        file_content::Entity::find_by_id((fixture.upload.file_id, 1))
            .one(db)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_accepted_publication_rejects_old_fence_and_fingerprint_mismatch(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    let mut stale = fixture.claim.clone();
    stale.lease_epoch -= 1;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    let error = publish_file_in(&mut transaction, &stale, &fixture.verified)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(&FinalizationFailure::StaleClaim)
    );
    transaction.rollback().await.unwrap();
    let mut mismatched = fixture.verified.clone();
    mismatched.source_sha256 = [0; 32];
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    let error = publish_file_in(&mut transaction, &fixture.claim, &mismatched)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(&FinalizationFailure::SourceDigestMismatch)
    );
    transaction.rollback().await.unwrap();
    fixture.assert_unpublished(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_accepted_publication_rejects_retired_verified_attempt() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    sqlx::query("update device_upload_finalization_attempt set phase='retired',retired_at=clock_timestamp() where id=$1")
        .bind(fixture.verified.attempt_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    let error =
        publish_file_in(&mut transaction, &fixture.claim, &fixture.verified)
            .await
            .unwrap_err();
    assert_eq!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(&FinalizationFailure::StaleClaim)
    );
    transaction.rollback().await.unwrap();
    fixture.assert_unpublished(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_accepted_source_is_not_expired_or_refreshed_by_legacy_paths() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, true).await;
    let now = Utc::now().fixed_offset();
    assert!(!expire_if_due(db, fixture.upload.id, now).await.unwrap());
    assert!(!schedule_cleanup_retry(
        db,
        fixture.upload.id,
        now,
        now + chrono::Duration::minutes(1)
    )
    .await
    .unwrap());
    assert!(matches!(
        revalidate_open(db, &fixture.upload, now, None)
            .await
            .unwrap(),
        RevalidateOutcome::Open(_)
    ));
    assert!(matches!(
        refresh_open(
            db,
            &fixture.upload,
            now,
            true,
            &ContentLimitsConfig::default(),
            None
        )
        .await
        .unwrap(),
        RevalidateOutcome::Open(_)
    ));
    let upload = load_upload(db, fixture.upload.id).await.unwrap().unwrap();
    assert_eq!(upload.status, UploadStatus::Open);
    assert_eq!(upload.expires_at, fixture.upload.expires_at);
    assert_eq!(upload.hard_expires_at, fixture.upload.hard_expires_at);
    assert_eq!(upload.last_activity_at, fixture.upload.last_activity_at);
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_retained_async_publication_uses_selected_provenance_key() {
    assert_async_retention_uses_selected_bytes(false, false).await;
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_async_retention_uses_held_spool_after_root_replacement() {
    assert_async_retention_uses_selected_bytes(true, false).await;
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_async_retention_skips_replaced_source_without_durable_marker() {
    assert_async_retention_uses_selected_bytes(true, true).await;
}

async fn assert_async_retention_uses_selected_bytes(
    replace_root: bool,
    reacquire: bool,
) {
    let (mut env, _guard) = cleanup_locked().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let configuration = &mut std::sync::Arc::get_mut(&mut env).unwrap().config;
    configuration.storage_dir = directory.path().display().to_string();
    configuration.s3_config = Some(crate::config::S3Config {
        s3_endpoint: "https://storage.invalid".into(),
        s3_region: "test".into(),
        s3_bucket: "async-retention-test".into(),
        s3_access_key_id: String::new(),
        s3_secret_access_key: String::new(),
        strongbox_key: crate::storage::generate_strongbox_key_b64(),
    });
    crate::entities::system_settings::ActiveModel {
        messenger_media_cache_enabled: Set(Some(true)),
        messenger_media_cache_retention_hours: Set(Some(24)),
        messenger_media_cache_max_size_gib: Set(Some(1)),
        messenger_media_cache_min_free_gib: Set(Some(0)),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    sqlx::query("insert into file_content_upload_object(upload_id,file_id,object_key,source_size_bytes,source_sha256,is_encrypted,attempt_id) select u.id,u.file_id,a.object_key,a.source_size_bytes,a.source_sha256,a.is_encrypted,a.id from file_content_upload u join device_upload_finalization_attempt a on a.file_upload_id=u.id where a.id=$1")
        .bind(fixture.verified.attempt_id).execute(&mut *transaction).await.unwrap();
    sqlx::query("insert into file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) select o.file_id,u.revision,u.id,o.object_key,o.source_size_bytes,o.source_sha256,o.is_encrypted,clock_timestamp() from file_content_upload_object o join file_content_upload u on u.id=o.upload_id where u.id=$1")
        .bind(fixture.upload.id).execute(&mut *transaction).await.unwrap();
    sqlx::query("update file_entry set content_path=$2 where id=$1")
        .bind(fixture.upload.file_id)
        .bind(&fixture.verified.object_key)
        .execute(&mut *transaction)
        .await
        .unwrap();
    sqlx::query(
        "update file_content_upload set status='completed' where id=$1",
    )
    .bind(fixture.upload.id)
    .execute(&mut *transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let spool =
        super::super::spool::Spool::for_test(directory.path().join("spool"))
            .await
            .unwrap();
    let locked = spool.acquire(fixture.upload.id).await.unwrap();
    locked
        .append(
            futures_util::stream::iter([Ok(bytes::Bytes::from_static(
                b"accepted source",
            ))]),
            0,
            fixture.upload.upload_length,
        )
        .await
        .unwrap();
    locked
        .make_durable(fixture.upload.upload_length)
        .await
        .unwrap();
    if replace_root {
        tokio::fs::rename(
            directory.path().join("spool"),
            directory.path().join("held-spool"),
        )
        .await
        .unwrap();
        tokio::fs::create_dir(directory.path().join("spool"))
            .await
            .unwrap();
        tokio::fs::write(
            directory
                .path()
                .join("spool")
                .join(format!("{}.data", fixture.upload.id)),
            b"replaced source",
        )
        .await
        .unwrap();
    }
    let locked = if reacquire {
        drop(locked);
        let replacement = super::super::spool::Spool::for_test(
            directory.path().join("spool"),
        )
        .await
        .unwrap();
        replacement.acquire(fixture.upload.id).await.unwrap()
    } else {
        locked
    };
    super::super::local_cache::retain_upload_best_effort(
        &env,
        &fixture.upload,
        &locked,
    )
    .await;
    let retained = super::super::local_cache::read_bytes(
        &env,
        &fixture.verified.object_key,
        fixture.upload.upload_length,
        true,
    )
    .await;
    if reacquire {
        assert_eq!(retained, None);
    } else {
        assert_eq!(retained, Some(b"accepted source".to_vec()));
    }
    assert!(super::super::local_cache::read_bytes(
        &env,
        &fixture.upload.object_key,
        fixture.upload.upload_length,
        true,
    )
    .await
    .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_publication_checks_live_fence_after_waiting_for_target() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    let mut target_lock =
        db.get_postgres_connection_pool().begin().await.unwrap();
    sqlx::query("select id from file_entry where id=$1 for update")
        .bind(fixture.upload.file_id)
        .fetch_one(&mut *target_lock)
        .await
        .unwrap();
    let task_db = db.clone();
    let claim = fixture.claim.clone();
    let verified = fixture.verified.clone();
    let (started, waiting) = tokio::sync::oneshot::channel();
    let mut publication = tokio::spawn(async move {
        let mut transaction = task_db
            .get_postgres_connection_pool()
            .begin()
            .await
            .unwrap();
        started.send(()).unwrap();
        let outcome =
            publish_file_in(&mut transaction, &claim, &verified).await;
        transaction.rollback().await.unwrap();
        outcome
    });
    waiting.await.unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(50),
        &mut publication
    )
    .await
    .is_err());
    tokio::time::timeout(std::time::Duration::from_secs(2),
        sqlx::query("update device_upload_finalization_job set lease_until=clock_timestamp()-interval '1 second' where id=$1")
            .bind(fixture.claim.job_id).execute(db.get_postgres_connection_pool()),
    ).await.unwrap().unwrap();
    target_lock.commit().await.unwrap();
    let error = publication.await.unwrap().unwrap_err();
    assert_eq!(
        error.downcast_ref::<FinalizationFailure>(),
        Some(&FinalizationFailure::StaleClaim)
    );
    fixture.assert_unpublished(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_released_failed_history_does_not_hold_legacy_upload_quota() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    sqlx::query("update device_upload_finalization_attempt set phase='retired',retired_at=clock_timestamp() where id=$1")
        .bind(fixture.verified.attempt_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    sqlx::query("update device_upload_finalization_job set status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code='source_digest_mismatch',error_message='Source fingerprint does not match',error_action='new_upload',source_release_state='release_pending' where id=$1")
        .bind(fixture.claim.job_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    sqlx::query("update file_content_upload set status='rejected',next_cleanup_at=clock_timestamp() where id=$1")
        .bind(fixture.upload.id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let actor = sqlx::query_scalar(
        "select created_by_login_id from file_content_upload where id=$1",
    )
    .bind(fixture.upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    let transaction = db.begin().await.unwrap();
    assert_eq!(
        load_quota(&transaction, actor)
            .await
            .unwrap()
            .reserved_count,
        1
    );
    transaction.rollback().await.unwrap();
    assert!(
        list_cleanup_candidates(db, None, Utc::now().fixed_offset(), 128)
            .await
            .unwrap()
            .is_empty()
    );
    mark_spool_removed(db, fixture.upload.id, Utc::now().fixed_offset())
        .await
        .unwrap();
    let transaction = db.begin().await.unwrap();
    assert_eq!(
        load_quota(&transaction, actor)
            .await
            .unwrap()
            .reserved_count,
        0
    );
    transaction.rollback().await.unwrap();
    sqlx::query("update device_upload_finalization_job set source_release_state='released',source_released_at=clock_timestamp(),quota_released_at=clock_timestamp() where id=$1")
        .bind(fixture.claim.job_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    assert!(
        list_cleanup_candidates(db, None, Utc::now().fixed_offset(), 128)
            .await
            .unwrap()
            .is_empty()
    );
    let old_file = file_entry::Entity::find_by_id(fixture.upload.file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    let file_id = Uuid::new_v4();
    let root_id = old_file.parent_id.unwrap();
    let now = Utc::now().naive_utc();
    crate::file_registry::test_support::insert_entry(
        db,
        file_entry::ActiveModel {
            id: Set(file_id),
            device_id: Set(fixture.upload.device_id),
            parent_id: Set(Some(root_id)),
            kind: Set(FileEntryKind::File),
            name: Set("next.txt".into()),
            absolute_path: Set(Some("C:\\next.txt".into())),
            hierarchy_path: Set(format!(
                "n{}.n{}",
                root_id.simple(),
                file_id.simple()
            )),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        },
    )
    .await;
    let actor = sqlx::query_scalar(
        "select created_by_login_id from file_content_upload where id=$1",
    )
    .bind(fixture.upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    let outcome = create_or_replay(
        db,
        NewUpload {
            device_id: fixture.upload.device_id,
            file_id,
            revision: 1,
            created_by_login_id: actor,
            upload_length: 1,
            expected_sha256: Sha256::digest(b"x").into(),
            available_spool_bytes: u64::MAX,
            now: Utc::now().fixed_offset(),
        },
        &ContentLimitsConfig {
            max_reserved_count: 1,
            max_count_per_login: 1,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, CreateOutcome::Created(_)), "{outcome:?}");
    assert!(load_upload(db, fixture.upload.id).await.unwrap().is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_unselected_canonical_cleanup_is_permanent_across_downgrade() {
    use sea_orm_migration::{MigratorTrait, SchemaManager};

    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    sqlx::query("update device_upload_finalization_attempt set phase='retired',retired_at=clock_timestamp() where id=$1")
        .bind(fixture.verified.attempt_id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let insert = "insert into device_upload_finalization_attempt(id,job_id,kind,origin,ordinal,lease_epoch,file_upload_id,device_id,object_key,is_encrypted,source_size_bytes,phase,retired_at,late_write_possible) values($1,$2,'file','legacy_cleanup',2,$3,$4,$5,$6,false,$7,'retired',clock_timestamp(),true)";
    assert!(sqlx::query(insert)
        .bind(Uuid::new_v4())
        .bind(fixture.claim.job_id)
        .bind(fixture.claim.lease_epoch)
        .bind(fixture.upload.id)
        .bind(fixture.upload.device_id)
        .bind("unrelated/key")
        .bind(fixture.upload.upload_length as i64)
        .execute(db.get_postgres_connection_pool())
        .await
        .is_err());
    let cleanup_id = Uuid::new_v4();
    sqlx::query(insert)
        .bind(cleanup_id)
        .bind(fixture.claim.job_id)
        .bind(fixture.claim.lease_epoch)
        .bind(fixture.upload.id)
        .bind(fixture.upload.device_id)
        .bind(&fixture.upload.object_key)
        .bind(fixture.upload.upload_length as i64)
        .execute(db.get_postgres_connection_pool())
        .await
        .unwrap();
    let migrations = wdfiles_migration::Migrator::migrations();
    let migration = migrations
        .iter()
        .find(|migration| {
            migration.name().ends_with("_failed_finalization_cleanup")
        })
        .unwrap();
    let transaction = db.begin().await.unwrap();
    let error = migration
        .down(&SchemaManager::new(&transaction))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("unselected canonical cleanup"),
        "{error}"
    );
    transaction.rollback().await.unwrap();
    let remaining: i64 = sqlx::query_scalar("select count(*) from device_upload_finalization_attempt where id=$1 and origin='legacy_cleanup' and phase='retired'")
        .bind(cleanup_id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert_eq!(remaining, 1);
}

#[tokio::test]
#[serial_test::serial]
async fn phase4_file_job_ownership_is_atomic_exact_and_permanent() {
    use sea_orm_migration::{MigratorTrait, SchemaManager};

    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let fixture = PublicationFixture::new(db, false).await;
    let owner: Option<Uuid> = sqlx::query_scalar(
        "select finalization_job_id from file_content_upload where id=$1",
    )
    .bind(fixture.upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    assert_eq!(owner, Some(fixture.claim.job_id));
    for replacement in [None, Some(Uuid::new_v4())] {
        assert!(sqlx::query(
            "update file_content_upload set finalization_job_id=$2 where id=$1"
        )
        .bind(fixture.upload.id)
        .bind(replacement)
        .execute(db.get_postgres_connection_pool())
        .await
        .is_err());
    }
    sqlx::query("update file_content_upload set status='rejected',next_cleanup_at=clock_timestamp() where id=$1")
        .bind(fixture.upload.id).execute(db.get_postgres_connection_pool()).await.unwrap();
    let actor: Uuid = sqlx::query_scalar(
        "select created_by_login_id from file_content_upload where id=$1",
    )
    .bind(fixture.upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    let outcome = create_or_replay(
        db,
        NewUpload {
            device_id: fixture.upload.device_id,
            file_id: fixture.upload.file_id,
            revision: fixture.upload.revision,
            created_by_login_id: actor,
            upload_length: fixture.upload.upload_length,
            expected_sha256: fixture.upload.expected_sha256,
            available_spool_bytes: u64::MAX,
            now: Utc::now().fixed_offset(),
        },
        &ContentLimitsConfig::default(),
    )
    .await
    .unwrap();
    let CreateOutcome::Created(upload) = outcome else {
        panic!("expected fresh legacy upload: {outcome:?}");
    };
    let error = sqlx::query(
        "update file_content_upload set finalization_job_id=$2 where id=$1",
    )
    .bind(upload.id)
    .bind(fixture.claim.job_id)
    .execute(db.get_postgres_connection_pool())
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("must bind its original upload"),
        "{error}"
    );
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.unwrap();
    let accepted = admission::admit_in(
        &mut transaction,
        &FinalizationCommand {
            created_by_login_id: actor,
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
    let in_transaction: Option<Uuid> = sqlx::query_scalar(
        "select finalization_job_id from file_content_upload where id=$1",
    )
    .bind(upload.id)
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    assert_eq!(in_transaction, Some(accepted.job_id));
    transaction.rollback().await.unwrap();
    let after_rollback: Option<Uuid> = sqlx::query_scalar(
        "select finalization_job_id from file_content_upload where id=$1",
    )
    .bind(upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .unwrap();
    assert_eq!(after_rollback, None);
    let exists: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_job where id=$1)")
        .bind(accepted.job_id).fetch_one(db.get_postgres_connection_pool()).await.unwrap();
    assert!(!exists);
    let migrations = wdfiles_migration::Migrator::migrations();
    let migration = migrations
        .iter()
        .find(|migration| {
            migration.name().ends_with("_file_finalization_ownership")
        })
        .unwrap();
    let transaction = db.begin().await.unwrap();
    let error = migration
        .down(&SchemaManager::new(&transaction))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("file finalization ownership"),
        "{error}"
    );
    transaction.rollback().await.unwrap();
}
