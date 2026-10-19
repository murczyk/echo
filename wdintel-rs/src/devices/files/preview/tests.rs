use super::query;
use crate::file_registry::entities::{
    file_entry, sea_orm_active_enums::FileEntryKind,
};
use crate::file_registry::test_support::{insert_entry, publish_content};
use crate::types::Mode;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseBackend, FromQueryResult, Set,
    Statement, TransactionTrait,
};
use uuid::Uuid;

async fn fixture() -> (crate::file_registry::FileRegistryDb, Uuid, Uuid) {
    fixture_with(Uuid::new_v4(), "gpx").await
}

async fn fixture_with(
    device_id: Uuid,
    extension: &str,
) -> (crate::file_registry::FileRegistryDb, Uuid, Uuid) {
    fixture_with_metadata(
        device_id,
        &format!("source.{extension}"),
        Some(extension),
    )
    .await
}

async fn fixture_with_metadata(
    device_id: Uuid,
    name: &str,
    extension: Option<&str>,
) -> (crate::file_registry::FileRegistryDb, Uuid, Uuid) {
    let metadata = crate::devices::files::normalize_file_metadata(
        name,
        None,
        extension.map(str::to_string),
        None,
        None,
        "fixture",
    )
    .unwrap();
    let config = crate::config::read_config(Mode::Test).unwrap();
    let registry = crate::file_registry::connect_runtime(&config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    let db = registry.connection();
    let root_id = Uuid::new_v4();
    let file_id = Uuid::new_v4();
    let now = Utc::now().naive_utc();
    file_entry::ActiveModel {
        id: Set(root_id),
        device_id: Set(device_id),
        parent_id: Set(None),
        kind: Set(FileEntryKind::Directory),
        name: Set(format!("C:\\{root_id}")),
        hierarchy_path: Set(format!("n{}", root_id.simple())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let file = insert_entry(
        db,
        file_entry::ActiveModel {
            id: Set(file_id),
            device_id: Set(device_id),
            parent_id: Set(Some(root_id)),
            kind: Set(FileEntryKind::File),
            name: Set(name.into()),
            extension: Set(metadata.extension),
            mime_type: Set(metadata.mime_type),
            absolute_path: Set(Some(format!("C:\\{root_id}\\{name}"))),
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
    publish_content(db, &file, Uuid::new_v4()).await;
    (registry, device_id, file_id)
}

#[tokio::test]
#[serial_test::serial]
async fn concurrent_prepare_reuses_one_authoritative_generation() {
    let (registry, device_id, file_id) = fixture().await;
    let db = registry.connection();
    let results = futures_util::future::join_all(
        (0..16).map(|_| query::prepare(db, device_id, file_id, 1, None)),
    )
    .await;
    assert!(
        results.iter().all(Result::is_ok),
        "valid published geodata must be admitted"
    );
    let generations: std::collections::BTreeSet<_> =
        results.into_iter().map(Result::unwrap).collect();
    assert_eq!(
        generations.len(),
        1,
        "concurrent prepare must share one current generation"
    );
}

async fn queued() -> (crate::file_registry::FileRegistryDb, query::Preview) {
    let (registry, device_id, file_id) = fixture().await;
    let db = registry.connection();
    db.execute_unprepared("delete from file_preview")
        .await
        .unwrap();
    let generation = Uuid::new_v4();
    let sql = r#"insert into file_preview (generation,device_id,file_id,revision,source_file_id,source_revision,kind,converter_version,is_current,state,run_id,attempt,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,source_name,source_extension,not_before,output_object_key,retryable,created_at,updated_at)
select $1,r.device_id,r.id,r.revision,c.file_id,c.revision,'geodata_kmz',1,true,'queued',$1,1,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,r.name,r.extension,now(),'fixture-preview/' || $1::text,false,now(),now()
from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.device_id=$2 and r.id=$3 returning *"#;
    let job =
        query::Preview::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [generation.into(), device_id.into(), file_id.into()],
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    (registry, job)
}

async fn running() -> (crate::file_registry::FileRegistryDb, query::Preview) {
    let (registry, job) = queued().await;
    let row = query::Preview::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update file_preview set state='running',lease=gen_random_uuid(),lease_until=now()+interval '120 seconds',heartbeat_at=now(),attempt_deadline=now()+interval '35 minutes',cleanup_after=now()+interval '95 minutes' where generation=$1 returning *", [job.generation.into()])).one(registry.connection()).await.unwrap().unwrap();
    (registry, row)
}

#[tokio::test]
#[serial_test::serial]
async fn claim_uses_persisted_lease_and_deadline() {
    let (registry, queued) = queued().await;
    let job = query::claim(registry.connection()).await.unwrap();
    assert!(job.is_some(), "runnable persisted preview must be claimed");
    let job = job.unwrap();
    assert_eq!(job.generation, queued.generation);
    assert_eq!(job.state, "running");
    assert!(job.lease.is_some() && job.attempt_deadline.is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn heartbeat_rejects_replaced_lease_and_deleted_source() {
    let (registry, job) = running().await;
    let db = registry.connection();
    assert!(
        query::heartbeat(db, &job).await.unwrap(),
        "live lease must renew"
    );
    let mut stale = job.clone();
    stale.lease = Some(Uuid::new_v4());
    assert!(!query::heartbeat(db, &stale).await.unwrap());
    delete_source(db, job.file_id).await;
    assert!(!query::heartbeat(db, &job).await.unwrap());
}

#[tokio::test]
#[serial_test::serial]
async fn publish_fences_current_lease_and_preserves_ready_on_replay() {
    let (registry, job) = running().await;
    let db = registry.connection();
    assert!(
        query::publish(db, &job, 123, vec![2; 32]).await.unwrap(),
        "verified owned result must publish"
    );
    assert!(!query::publish(db, &job, 999, vec![3; 32]).await.unwrap());
    let row =
        query::Preview::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select * from file_preview where generation=$1",
            [job.generation.into()],
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.result_size_bytes, Some(123));
    assert_eq!(row.state, "ready");
}

#[tokio::test]
#[serial_test::serial]
async fn transient_failure_retires_generation_and_preserves_run() {
    let (registry, job) = running().await;
    let db = registry.connection();
    assert!(
        query::fail(db, &job, "conversion_unavailable", true)
            .await
            .unwrap(),
        "owned transient failure must advance durable retry"
    );
    let row =
        query::Preview::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select * from file_preview where file_id=$1 and is_current",
            [job.file_id.into()],
        ))
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(row.generation, job.generation);
    assert_ne!(row.output_object_key, job.output_object_key);
    assert_eq!(row.run_id, job.run_id);
    assert_eq!(row.attempt, 2);
    assert_eq!(row.state, "retry_wait");
}

#[tokio::test]
#[serial_test::serial]
async fn concurrent_prepare_and_automatic_retry_keep_one_current_generation() {
    let (registry, job) = running().await;
    let db = registry.connection();
    let (failed, prepared) = tokio::join!(
        query::fail(db, &job, "conversion_unavailable", true),
        futures_util::future::join_all((0..16).map(|_| {
            query::prepare(db, job.device_id, job.file_id, job.revision, None)
        }))
    );
    assert!(failed.unwrap());
    assert!(prepared.iter().all(Result::is_ok), "{prepared:?}");
    let current = query::current(db, job.device_id, job.file_id, job.revision)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(current.generation, job.generation);
    assert_eq!(current.state, "retry_wait");
    assert_eq!(current.run_id, job.run_id);
    let count = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select count(*) as count from file_preview where file_id=$1 and revision=$2 and is_current",
            [job.file_id.into(), job.revision.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "count")
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
#[serial_test::serial]
async fn cleanup_retains_current_failure_and_excludes_live_lease() {
    let (registry, job) = running().await;
    let db = registry.connection();
    assert!(query::cleanup_candidates(db).await.unwrap().is_empty());
    db.execute_unprepared(&format!("update file_preview set state='failed',lease=null,lease_until=null,heartbeat_at=null,attempt_deadline=now()-interval '2 hours',cleanup_after=now()-interval '1 hour',error_code='source_invalid' where generation='{}'", job.generation)).await.unwrap();
    let candidates = query::cleanup_candidates(db).await.unwrap();
    assert_eq!(
        candidates.len(),
        1,
        "current failed output must be eligible after grace"
    );
    assert!(candidates[0].is_current);
    assert_eq!(candidates[0].state, "failed");
}

#[tokio::test]
#[serial_test::serial]
async fn status_does_not_create_or_refresh_rows() {
    let (registry, device, file) = fixture().await;
    let db = registry.connection();
    assert!(query::current(db, device, file, 1).await.unwrap().is_none());
    let generation = query::prepare(db, device, file, 1, None).await.unwrap();
    let before = query::load(db, generation).await.unwrap().unwrap();
    for _ in 0..3 {
        assert_eq!(
            query::current(db, device, file, 1)
                .await
                .unwrap()
                .unwrap()
                .generation,
            generation
        );
    }
    let after = query::load(db, generation).await.unwrap().unwrap();
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.expires_at, before.expires_at);
}

#[tokio::test]
#[serial_test::serial]
async fn compatible_failed_reuse_requires_explicit_expected_retry() {
    let (registry, job) = running().await;
    let db = registry.connection();
    assert!(query::fail(db, &job, "source_invalid", false)
        .await
        .unwrap());
    assert_eq!(
        query::prepare(db, job.device_id, job.file_id, job.revision, None)
            .await
            .unwrap(),
        job.generation
    );
    assert!(query::prepare(
        db,
        job.device_id,
        job.file_id,
        job.revision,
        Some(job.generation)
    )
    .await
    .is_err());
    db.execute_unprepared(&format!("update file_preview set retryable=true,error_code='storage_unavailable' where generation='{}'",job.generation)).await.unwrap();
    let error = query::prepare(
        db,
        job.device_id,
        job.file_id,
        job.revision,
        Some(job.generation),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<query::Rejection>().unwrap().0,
        "retry_cooldown"
    );
    db.execute_unprepared(&format!("update file_preview set updated_at=now()-interval '31 seconds' where generation='{}'",job.generation)).await.unwrap();
    let next = query::prepare(
        db,
        job.device_id,
        job.file_id,
        job.revision,
        Some(job.generation),
    )
    .await
    .unwrap();
    assert_ne!(next, job.generation);
    let next = query::load(db, next).await.unwrap().unwrap();
    assert_eq!(next.attempt, 1);
    assert_ne!(next.run_id, job.run_id);
    assert!(
        !query::load(db, job.generation)
            .await
            .unwrap()
            .unwrap()
            .is_current
    );
    let error = query::prepare(
        db,
        job.device_id,
        job.file_id,
        job.revision,
        Some(job.generation),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<query::Rejection>().unwrap().0,
        "generation_conflict"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn ready_ttl_invalidates_without_extending_on_prepare() {
    let (registry, job) = running().await;
    let db = registry.connection();
    query::publish(db, &job, 12, vec![2; 32]).await.unwrap();
    let ready = query::load(db, job.generation).await.unwrap().unwrap();
    assert_eq!(
        query::prepare(db, job.device_id, job.file_id, job.revision, None)
            .await
            .unwrap(),
        job.generation
    );
    assert_eq!(
        query::load(db, job.generation)
            .await
            .unwrap()
            .unwrap()
            .expires_at,
        ready.expires_at
    );
    db.execute_unprepared(&format!("update file_preview set expires_at=now()-interval '1 second' where generation='{}'",job.generation)).await.unwrap();
    assert!(query::current(db, job.device_id, job.file_id, job.revision)
        .await
        .unwrap()
        .is_none());
    let next =
        query::prepare(db, job.device_id, job.file_id, job.revision, None)
            .await
            .unwrap();
    assert_ne!(next, job.generation);
}

#[tokio::test]
#[serial_test::serial]
async fn publish_rejects_deleted_source_expired_deadline_and_stale_lease() {
    for reason in ["source", "deadline", "lease"] {
        let (registry, job) = running().await;
        let db = registry.connection();
        match reason {
            "source" => {
                delete_source(db, job.file_id).await;
            }
            "deadline" => {
                db.execute_unprepared(&format!("update file_preview set attempt_deadline=now()-interval '1 second' where generation='{}'",job.generation)).await.unwrap();
            }
            _ => {
                db.execute_unprepared(&format!("update file_preview set lease=gen_random_uuid() where generation='{}'",job.generation)).await.unwrap();
            }
        };
        assert!(
            !query::publish(db, &job, 10, vec![2; 32]).await.unwrap(),
            "{reason} must fence publication"
        );
        assert_ne!(
            query::load(db, job.generation)
                .await
                .unwrap()
                .unwrap()
                .state,
            "ready"
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn expired_lease_takeover_allocates_a_distinct_generation() {
    let (registry, job) = running().await;
    let db = registry.connection();
    db.execute_unprepared(&format!("update file_preview set lease_until=now()-interval '1 second' where generation='{}'",job.generation)).await.unwrap();
    assert!(query::claim(db).await.unwrap().is_none());
    let next = query::current(db, job.device_id, job.file_id, job.revision)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(next.generation, job.generation);
    assert_ne!(next.output_object_key, job.output_object_key);
    assert_eq!(next.attempt, 2);
    assert_eq!(next.run_id, job.run_id);
    assert!(!query::heartbeat(db, &job).await.unwrap());
    db.execute_unprepared(&format!(
        "update file_preview set not_before=now() where generation='{}'",
        next.generation
    ))
    .await
    .unwrap();
    assert_eq!(
        query::claim(db).await.unwrap().unwrap().generation,
        next.generation
    );
}

#[tokio::test]
#[serial_test::serial]
async fn transient_budget_stops_at_three_and_preserves_failed_status_after_cleanup(
) {
    let (registry, mut job) = running().await;
    let db = registry.connection();
    for attempt in 1..=3 {
        assert_eq!(job.attempt, attempt);
        assert!(query::fail(db, &job, "storage_unavailable", true)
            .await
            .unwrap());
        let current =
            query::current(db, job.device_id, job.file_id, job.revision)
                .await
                .unwrap()
                .unwrap();
        if attempt < 3 {
            db.execute_unprepared(&format!("update file_preview set not_before=now() where generation='{}'",current.generation)).await.unwrap();
            job = query::claim(db).await.unwrap().unwrap();
        } else {
            assert_eq!(current.state, "failed");
            assert!(current.retryable);
            query::cleanup_record(db, &current, true).await.unwrap();
            let retained =
                query::current(db, job.device_id, job.file_id, job.revision)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(retained.state, "failed");
            assert_eq!(
                retained.error_code.as_deref(),
                Some("storage_unavailable")
            );
            assert!(retained.object_deleted_at.is_some());
            assert!(retained.tombstone_until.is_some());
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn incompatible_converter_generation_is_retired_by_prepare() {
    let (registry, job) = queued().await;
    let db = registry.connection();
    db.execute_unprepared(&format!("update file_preview set is_current=false,state='retired' where generation='{}'; insert into file_preview select (jsonb_populate_record(null::file_preview,to_jsonb(p)||jsonb_build_object('generation',gen_random_uuid(),'converter_version',2,'is_current',true,'state','queued','output_object_key',output_object_key||'-future'))).* from file_preview p where generation='{}'",job.generation,job.generation)).await.unwrap();
    assert!(query::current(db, job.device_id, job.file_id, job.revision)
        .await
        .unwrap()
        .is_none());
    let generation =
        query::prepare(db, job.device_id, job.file_id, job.revision, None)
            .await
            .unwrap();
    let current = query::load(db, generation).await.unwrap().unwrap();
    assert_eq!(current.converter_version, 1);
    assert_ne!(current.generation, job.generation);
}

#[tokio::test]
#[serial_test::serial]
async fn admission_reuses_current_and_rejects_seventeenth_device_job() {
    let device = Uuid::new_v4();
    let (registry, _, file) = fixture_with(device, "gpx").await;
    let db = registry.connection();
    db.execute_unprepared("delete from file_preview")
        .await
        .unwrap();
    let generation = query::prepare(db, device, file, 1, None).await.unwrap();
    for _ in 1..16 {
        let (registry, _, file) = fixture_with(device, "gpx").await;
        query::prepare(registry.connection(), device, file, 1, None)
            .await
            .unwrap();
    }
    assert_eq!(
        query::prepare(db, device, file, 1, None).await.unwrap(),
        generation
    );
    let (registry, _, file) = fixture_with(device, "gpx").await;
    let error = query::prepare(registry.connection(), device, file, 1, None)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<query::Rejection>().unwrap().0,
        "admission_full"
    );
    assert!(query::current(registry.connection(), device, file, 1)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn global_admission_and_expired_ready_cleanup_have_bounded_batches() {
    let (registry, job) = queued().await;
    let db = registry.connection();
    for _ in 1..128 {
        let (registry, device, file) = fixture().await;
        query::prepare(registry.connection(), device, file, 1, None)
            .await
            .unwrap();
    }
    assert_eq!(
        query::prepare(db, job.device_id, job.file_id, job.revision, None)
            .await
            .unwrap(),
        job.generation
    );
    let (registry, device, file) = fixture().await;
    let error = query::prepare(registry.connection(), device, file, 1, None)
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<query::Rejection>().unwrap().0,
        "admission_full"
    );
    assert!(query::current(registry.connection(), device, file, 1)
        .await
        .unwrap()
        .is_none());
    db.execute_unprepared("update file_preview set state='ready',result_size_bytes=0,result_sha256=source_sha256,result_encrypted=true,expires_at=now()-interval '1 second',cleanup_after=now() where is_current")
        .await
        .unwrap();
    for expected in [28, 0] {
        assert!(query::cleanup_candidates(db).await.unwrap().len() <= 100);
        let remaining = db
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                "select count(*) as count from file_preview where is_current and state='ready'",
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i64>("", "count")
            .unwrap();
        assert_eq!(remaining, expected);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn native_and_unsupported_formats_never_enqueue() {
    for extension in ["kml", "kmz", "txt", "gdb"] {
        let (registry, device, file) =
            fixture_with(Uuid::new_v4(), extension).await;
        let error =
            query::prepare(registry.connection(), device, file, 1, None)
                .await
                .unwrap_err();
        assert_eq!(
            error.downcast_ref::<query::Rejection>().unwrap().0,
            "unsupported_format"
        );
        assert!(query::current(registry.connection(), device, file, 1)
            .await
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
#[serial_test::serial]
async fn geodata_admission_uses_revision_filename_before_accepted_metadata() {
    for (name, extension, accepted) in [
        ("route.GPX", Some("txt"), true),
        ("route", Some("GPX"), true),
        ("route.txt", Some("gpx"), false),
    ] {
        let (registry, device, file) =
            fixture_with_metadata(Uuid::new_v4(), name, extension).await;
        let prepared =
            query::prepare(registry.connection(), device, file, 1, None).await;
        if accepted {
            let generation = prepared.unwrap();
            let preview =
                query::current(registry.connection(), device, file, 1)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(preview.generation, generation);
            assert_eq!(preview.state, "queued");
            assert_eq!(preview.source_name, name);
        } else {
            assert_eq!(
                prepared
                    .unwrap_err()
                    .downcast_ref::<query::Rejection>()
                    .unwrap()
                    .0,
                "unsupported_format"
            );
            assert!(query::current(registry.connection(), device, file, 1)
                .await
                .unwrap()
                .is_none());
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn private_storage_cleanup_preserves_ready_and_catches_late_put() {
    let env = crate::server::new_env(Mode::Test).await.unwrap();
    let (registry, failed) = running().await;
    let db = registry.connection();
    assert!(query::fail(db, &failed, "source_invalid", false)
        .await
        .unwrap());
    db.execute_unprepared(&format!("update file_preview set attempt_deadline=now()-interval '2 hours',cleanup_after=now()-interval '1 hour' where generation='{}'",failed.generation)).await.unwrap();
    let (_, device, file) = fixture().await;
    query::prepare(db, device, file, 1, None).await.unwrap();
    let ready = query::claim(db).await.unwrap().unwrap();
    use sha2::{Digest, Sha256};
    let bytes = kmz_fixture();
    let digest = Sha256::digest(&bytes).to_vec();
    let storage = env.s3.as_ref().expect("private test S3 must be configured");
    let config = super::worker::storage_config(&env).unwrap();
    let key = &env.config.s3_config.as_ref().unwrap().strongbox_key;
    for job in [&ready, &failed] {
        crate::storage::upload_device_content_encrypted(
            storage,
            &config,
            key,
            &job.output_object_key,
            bytes.clone().into(),
            None,
        )
        .await
        .unwrap();
    }
    assert!(query::publish(db, &ready, bytes.len() as i64, digest)
        .await
        .unwrap());
    let decrypted = super::worker::read_bytes(
        &env,
        &ready.output_object_key,
        bytes.len() as u64,
        true,
        26 * 1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(decrypted, bytes);
    let plaintext_key = format!("geodata-tests/{}/source.gpx", Uuid::new_v4());
    storage.write(&plaintext_key, bytes.clone()).await.unwrap();
    assert_eq!(
        super::worker::read_bytes(
            &env,
            &plaintext_key,
            bytes.len() as u64,
            false,
            201 * 1024 * 1024
        )
        .await
        .unwrap(),
        bytes
    );
    assert!(super::worker::read_bytes(
        &env,
        &plaintext_key,
        bytes.len() as u64 - 1,
        false,
        201 * 1024 * 1024
    )
    .await
    .is_err());
    storage.delete(&plaintext_key).await.unwrap();
    super::worker::cleanup(&env, db).await.unwrap();
    assert!(storage.exists(&ready.output_object_key).await.unwrap());
    assert!(!storage.exists(&failed.output_object_key).await.unwrap());
    let tombstone = query::load(db, failed.generation).await.unwrap().unwrap();
    assert_eq!(tombstone.state, "failed");
    assert!(
        tombstone.is_current
            && tombstone.object_deleted_at.is_some()
            && tombstone.tombstone_until.is_some()
    );
    crate::storage::upload_device_content_encrypted(
        storage,
        &config,
        key,
        &failed.output_object_key,
        bytes.into(),
        None,
    )
    .await
    .unwrap();
    db.execute_unprepared(&format!(
        "update file_preview set cleanup_after=now() where generation='{}'",
        failed.generation
    ))
    .await
    .unwrap();
    super::worker::cleanup(&env, db).await.unwrap();
    assert!(!storage.exists(&failed.output_object_key).await.unwrap());
    assert_eq!(
        query::load(db, failed.generation)
            .await
            .unwrap()
            .unwrap()
            .tombstone_until,
        tombstone.tombstone_until
    );
}

fn kmz_fixture() -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("doc.kml", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(
            b"<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document/></kml>",
        )
        .unwrap();
    writer.finish().unwrap().into_inner()
}

#[actix_web::test]
#[serial_test::serial]
async fn geodata_routes_reject_missing_session_before_status_and_result_read() {
    use actix_web::{http::header, test, web, App};
    let env = crate::server::new_env(Mode::Test).await.unwrap();
    let session = actix_session::storage::RedisSessionStore::new(
        crate::redis_conn_string(&env.config).unwrap(),
    )
    .await
    .unwrap();
    let app = test::init_service(
        App::new()
            .wrap(actix_identity::IdentityMiddleware::default())
            .wrap(actix_session::SessionMiddleware::new(
                session,
                actix_web::cookie::Key::generate(),
            ))
            .app_data(web::Data::from(env))
            .service(super::routes()),
    )
    .await;
    let device = Uuid::new_v4();
    let file = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let route = format!(
        "/api/device/files/{device}/{file}/revisions/1/preview/geodata"
    );
    for (method, uri) in [
        (actix_web::http::Method::GET, route.clone()),
        (actix_web::http::Method::POST, route.clone()),
        (actix_web::http::Method::POST, format!("{route}/retry")),
        (
            actix_web::http::Method::GET,
            format!("{route}/{generation}/content"),
        ),
        (
            actix_web::http::Method::HEAD,
            format!("{route}/{generation}/content"),
        ),
    ] {
        let mut request = test::TestRequest::default().method(method).uri(&uri);
        if uri.ends_with("/retry") {
            request = request.set_json(
                serde_json::json!({"expected_generation":generation}),
            );
        }
        let response = test::call_service(&app, request.to_request()).await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
    }
}

async fn delete_source(db: &sea_orm::DatabaseConnection, file: Uuid) {
    let transaction = db.begin().await.unwrap();
    transaction.execute_unprepared(&format!("update file_entry set content_path=null where id='{file}'; alter table file_content disable trigger file_content_immutable_trg; delete from file_content where file_id='{file}'; alter table file_content enable trigger file_content_immutable_trg")).await.unwrap();
    transaction.commit().await.unwrap();
}

#[actix_web::test]
#[serial_test::serial]
async fn ready_result_routes_enforce_generation_and_current_read_access() {
    use crate::entities::{device, login, organism, system_settings};
    use crate::functest::tests::{mk_login, mk_organism};
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        http::{header, StatusCode},
        test, web, App, HttpMessage, HttpRequest, HttpResponse,
    };
    use sha2::{Digest, Sha256};
    let mut env = crate::server::new_env(Mode::Test).await.unwrap();
    std::sync::Arc::get_mut(&mut env)
        .unwrap()
        .config
        .alpine_converter_url = Some("http://127.0.0.1:9".into());
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
            login: Set(format!("geodata-{}", Uuid::new_v4())),
            roles: Set(serde_json::json!([crate::devices::ROLE_CYBER])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (registry, job) = running().await;
    let db = registry.connection();
    device::ActiveModel {
        id: Set(job.device_id),
        name: Set(Some("Geodata routes".into())),
        created_by: Set(login.login.clone()),
        organism_id: Set(organism.id),
        unit_id: Set(None),
        tags: Set(serde_json::json!([])),
        external_url: Set(None),
        archived: Set(true),
        archived_at: Set(Some(Utc::now().naive_utc())),
        custom_fields: Set(serde_json::json!({})),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let original=db.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,"select source_sha256,object_key from file_content where file_id=$1 and revision=1",[job.file_id.into()])).await.unwrap().unwrap();
    let bytes = kmz_fixture();
    let storage = env.s3.as_ref().unwrap();
    crate::storage::upload_device_content_encrypted(
        storage,
        &super::worker::storage_config(&env).unwrap(),
        &env.config.s3_config.as_ref().unwrap().strongbox_key,
        &job.output_object_key,
        bytes.clone().into(),
        None,
    )
    .await
    .unwrap();
    query::publish(
        db,
        &job,
        bytes.len() as i64,
        Sha256::digest(&bytes).to_vec(),
    )
    .await
    .unwrap();
    let large_upload = Uuid::new_v4();
    let large_key = format!(
        "device-file-content/{}/{}/2/{large_upload}",
        job.device_id, job.file_id
    );
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,r#"
insert into file_revision select (jsonb_populate_record(null::file_revision,to_jsonb(r)||jsonb_build_object('revision',2,'source_sequence',2))).* from file_revision r where id=$1 and revision=1
"#,[job.file_id.into()])).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "update file_device_source_state set last_source_sequence=2 where id=$1",
        [job.device_id.into()],
    ))
    .await
    .unwrap();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,r#"
insert into file_content_upload select (jsonb_populate_record(null::file_content_upload,to_jsonb(u)||jsonb_build_object('id',$2::uuid,'revision',2,'upload_length',209715201,'object_key',$3::text,'status','open','next_cleanup_at',expires_at))).* from file_content_upload u where file_id=$1 and revision=1
"#,[job.file_id.into(),large_upload.into(),large_key.clone().into()])).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,"update file_content_upload set status='completed',next_cleanup_at=now() where id=$1",[large_upload.into()])).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,r#"
insert into file_content select (jsonb_populate_record(null::file_content,to_jsonb(c)||jsonb_build_object('revision',2,'upload_id',$2::uuid,'source_size_bytes',209715201,'object_key',$3::text))).* from file_content c where file_id=$1 and revision=1
"#,[job.file_id.into(),large_upload.into(),large_key.into()])).await.unwrap();
    let session =
        RedisSessionStore::new(crate::redis_conn_string(&env.config).unwrap())
            .await
            .unwrap();
    async fn sign_in(
        request: HttpRequest,
        login: web::Path<String>,
    ) -> HttpResponse {
        Identity::login(&request.extensions(), login.into_inner()).unwrap();
        HttpResponse::NoContent().finish()
    }
    let app = test::init_service(
        App::new()
            .app_data(web::Data::from(env.clone()))
            .wrap(IdentityMiddleware::default())
            .wrap(SessionMiddleware::new(
                session,
                actix_web::cookie::Key::generate(),
            ))
            .route("/test/geodata-login/{login}", web::post().to(sign_in))
            .service(super::routes()),
    )
    .await;
    let signed = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&format!("/test/geodata-login/{}", login.id))
            .to_request(),
    )
    .await;
    let cookie = signed.response().cookies().next().unwrap().into_owned();
    let (_, _, conflicting_file) =
        fixture_with_metadata(job.device_id, "route.GPX", Some("txt")).await;
    let conflicting = format!(
        "/api/device/files/{}/{}/revisions/1/preview/geodata",
        job.device_id, conflicting_file,
    );
    let prepared = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&conflicting)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(prepared.status(), StatusCode::ACCEPTED);
    let current = query::current(db, job.device_id, conflicting_file, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.source_name, "route.GPX");
    let base = format!(
        "/api/device/files/{}/{}/revisions/1/preview/geodata",
        job.device_id, job.file_id
    );
    let result = format!("{base}/{}/content", job.generation);
    let oversized = format!(
        "/api/device/files/{}/{}/revisions/2/preview/geodata",
        job.device_id, job.file_id
    );
    assert_eq!(
        test::call_service(
            &app,
            test::TestRequest::post()
                .uri(&oversized)
                .cookie(cookie.clone())
                .to_request()
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(query::current(db, job.device_id, job.file_id, 2)
        .await
        .unwrap()
        .is_none());
    let status = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&base)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(status.status(), StatusCode::OK);
    let status: super::types::DeviceFileGeodataPreviewRsp =
        test::read_body_json(status).await;
    assert_eq!(status.result_url.as_deref(), Some(result.as_str()));
    let prepared = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&base)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(
        prepared.status(),
        StatusCode::OK,
        "compatible ready must reuse without needing a live converter"
    );
    let response = test::call_service(
        &app,
        test::TestRequest::get()
            .uri(&result)
            .cookie(cookie.clone())
            .insert_header((header::RANGE, "bytes=0-1"))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/vnd.google-earth.kmz"
    );
    assert_eq!(test::read_body(response).await.as_ref(), bytes.as_slice());
    storage.delete(&job.output_object_key).await.unwrap();
    let head = test::call_service(
        &app,
        test::TestRequest::default()
            .method(actix_web::http::Method::HEAD)
            .uri(&result)
            .cookie(cookie.clone())
            .to_request(),
    )
    .await;
    assert_eq!(
        head.status(),
        StatusCode::OK,
        "HEAD must use metadata without accessing removed storage bytes"
    );
    assert_eq!(
        head.headers().get(header::CONTENT_LENGTH).unwrap(),
        bytes.len().to_string().as_str()
    );
    assert!(test::read_body(head).await.is_empty());
    let wrong = format!(
        "/api/device/files/{}/{}/revisions/2/preview/geodata/{}/content",
        job.device_id, job.file_id, job.generation
    );
    assert_eq!(
        test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&wrong)
                .cookie(cookie.clone())
                .to_request()
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    db.execute_unprepared(&format!("update file_preview set expires_at=now()-interval '1 second' where generation='{}'",job.generation)).await.unwrap();
    let replacement = query::prepare(db, job.device_id, job.file_id, 1, None)
        .await
        .unwrap();
    assert_ne!(replacement, job.generation);
    for method in [actix_web::http::Method::GET, actix_web::http::Method::HEAD]
    {
        assert_eq!(
            test::call_service(
                &app,
                test::TestRequest::default()
                    .method(method)
                    .uri(&result)
                    .cookie(cookie.clone())
                    .to_request()
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }
    env.dbx
        .execute_unprepared(&format!(
            "update login set roles='[]'::jsonb where id='{}'",
            login.id
        ))
        .await
        .unwrap();
    for uri in [&base, &result] {
        assert_eq!(
            test::call_service(
                &app,
                test::TestRequest::get()
                    .uri(uri)
                    .cookie(cookie.clone())
                    .to_request()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let after=db.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,"select source_sha256,object_key from file_content where file_id=$1 and revision=1",[job.file_id.into()])).await.unwrap().unwrap();
    assert_eq!(
        after.try_get::<Vec<u8>>("", "source_sha256").unwrap(),
        original.try_get::<Vec<u8>>("", "source_sha256").unwrap()
    );
    assert_eq!(
        after.try_get::<String>("", "object_key").unwrap(),
        original.try_get::<String>("", "object_key").unwrap()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn archive_members_keep_independent_generations_and_retry_identity() {
    let (registry, device, file) = fixture_with(Uuid::new_v4(), "zip").await;
    let db = registry.connection();
    db.execute_unprepared("delete from file_preview")
        .await
        .unwrap();
    let target = (device, file, 1);
    let first = query::prepare_selection(db, target, Some("0,2"), None, true)
        .await
        .unwrap();
    let second = query::prepare_selection(db, target, Some("1"), None, true)
        .await
        .unwrap();
    assert_ne!(first, second);
    assert_eq!(
        query::prepare_selection(db, target, Some("0,2"), None, true)
            .await
            .unwrap(),
        first
    );
    assert!(query::current(db, device, file, 1).await.unwrap().is_none());
    assert!(query::prepare_selection(db, target, None, None, true)
        .await
        .is_err());
    assert!(query::prepare_selection(db, target, Some("01"), None, true)
        .await
        .is_err());
    assert!(db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "update file_preview set archive_members='2' where generation=$1",
            [first.into()]
        ))
        .await
        .is_err());
    assert!(
        query::prepare_selection(db, target, Some("1"), Some(first), true)
            .await
            .is_err()
    );
    let job = query::claim(db).await.unwrap().unwrap();
    assert_eq!(job.generation, first);
    assert!(query::fail(db, &job, "conversion_unavailable", true)
        .await
        .unwrap());
    let retried = query::current_selection(db, target, Some("0,2"))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(retried.generation, first);
    assert_eq!(retried.archive_members.as_deref(), Some("0,2"));
    assert_eq!(retried.state, "retry_wait");
    assert_eq!(
        query::current_selection(db, target, Some("1"))
            .await
            .unwrap()
            .unwrap()
            .generation,
        second
    );
}
