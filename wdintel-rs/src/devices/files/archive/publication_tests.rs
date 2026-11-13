use super::{
    enqueue,
    extract::Verified,
    manifest::{Manifest, Member},
    protocol::Output,
    publication,
    repository::{self, Attempt},
};
use crate::file_registry::test_support::ARCHIVE_SOURCE_SQL;
use crate::types::Mode;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait,
    QueryFilter, Statement, TransactionTrait,
};
use uuid::Uuid;

async fn fixture() -> (DatabaseConnection, Uuid, Uuid) {
    let config = crate::config::read_config(Mode::Test).unwrap();
    let registry = crate::file_registry::connect_runtime(&config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    let db = registry.connection().clone();
    let name: String = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select current_database() as name",
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "name")
        .unwrap();
    assert!(name.starts_with("wd_files_test_"));
    crate::file_registry::run_migrations(&config, Mode::Test)
        .await
        .unwrap();
    db.execute_unprepared("truncate file_entry,file_sync_session,file_device_source_state restart identity cascade").await.unwrap();
    db.execute_unprepared(ARCHIVE_SOURCE_SQL).await.unwrap();
    let row = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select id,device_id from file_revision where revision=2",
        ))
        .await
        .unwrap()
        .unwrap();
    let file = row.try_get("", "id").unwrap();
    let device = row.try_get("", "device_id").unwrap();
    (db, device, file)
}

async fn running(
    db: &DatabaseConnection,
    device: Uuid,
    file: Uuid,
    revision: i64,
) -> Attempt {
    let id = enqueue::ensure(db, device, file, revision)
        .await
        .unwrap()
        .unwrap();
    let run_id = Uuid::new_v4();
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set state='running',attempts=attempts+1,run_id=$2,heartbeat_at=now(),first_started_at=now(),deadline=now()+interval '1 day' where id=$1",[id.into(),run_id.into()])).await.unwrap();
    Attempt {
        archive_id: id,
        run_id,
    }
}

fn outputs(attempt: &Attempt, names: &[&str]) -> Vec<Output> {
    names
        .iter()
        .enumerate()
        .map(|(ordinal, name)| {
            let directory = name.ends_with('/');
            Output {
                member: Member {
                    modified_at: None,
                    path: name.trim_end_matches('/').into(),
                    directory,
                    inferred: false,
                    ordinal: Some(ordinal as u64),
                    method: 0,
                    size: 0,
                    compressed_size: 0,
                    crc32: 0,
                    data_offset: 0,
                },
                object_key: (!directory).then(|| {
                    format!(
                        "device-file-archive/{}/1/{}",
                        attempt.archive_id,
                        Uuid::new_v4()
                    )
                }),
                bytes: (!directory).then_some(Verified {
                    size: 0,
                    sha256: [0; 32],
                    crc32: 0,
                }),
                encrypted: false,
            }
        })
        .collect()
}

async fn publish(db: &DatabaseConnection, attempt: &Attempt, names: &[&str]) {
    let outputs = outputs(attempt, names);
    let manifest = Manifest {
        members: outputs.iter().map(|o| o.member.clone()).collect(),
        records: outputs.len() as u64,
        metadata_bytes: 0,
    };
    repository::admit(db, attempt, &manifest).await.unwrap();
    publication::publish(db, attempt, &outputs).await.unwrap();
}

async fn members(db: &DatabaseConnection, file: Uuid) -> Vec<(Uuid, i64)> {
    use crate::file_registry::entities::file_entry;
    file_entry::Entity::find()
        .filter(file_entry::Column::ArchiveFileId.eq(file))
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|e| (e.id, e.revision.unwrap()))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn inherited_history_reuses_ids_and_old_publication_cannot_regress_current(
) {
    let (db, device, file) = fixture().await;
    let second = running(&db, device, file, 2).await;
    publish(&db, &second, &["report.pdf", "empty/"]).await;
    let before = members(&db, file).await;
    let first = running(&db, device, file, 1).await;
    publish(&db, &first, &["report.pdf", "empty/"]).await;
    assert_eq!(members(&db, file).await, before);
    assert!(before.iter().all(|(_, revision)| *revision == 2));
    let count:i64=db.query_one_raw(Statement::from_string(DbBackend::Postgres,"select count(*) as n from file_revision where origin_archive_id is not null")).await.unwrap().unwrap().try_get("","n").unwrap();
    assert_eq!(count, 4);
    // A repeated uncertain-COMMIT reconciliation is a no-op.
    publication::publish(
        &db,
        &second,
        &outputs(&second, &["report.pdf", "empty/"]),
    )
    .await
    .unwrap();
    assert_eq!(members(&db, file).await, before);
}

#[tokio::test]
#[serial_test::serial]
async fn absent_current_members_remain_historical_and_reappearing_members_reuse_ids(
) {
    let (db, device, file) = fixture().await;
    let first = running(&db, device, file, 1).await;
    publish(&db, &first, &["report.pdf"]).await;
    let before = members(&db, file).await;
    let id = before[0].0;
    let second = running(&db, device, file, 2).await;
    publish(&db, &second, &[]).await;
    use crate::file_registry::entities::file_entry;
    let visible = file_entry::Entity::find()
        .filter(file_entry::Column::Id.eq(id))
        .filter(super::query::current_visibility())
        .all(&db)
        .await
        .unwrap();
    assert!(visible.is_empty());
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update file_entry set revision=3 where id=$1;",
        [file.into()],
    ))
    .await
    .unwrap_err();
    // Source revisions and the current projection change atomically.
    db.execute_unprepared("do $$ declare s file_revision; begin select * into strict s from file_revision where origin_archive_id is null and revision=2; insert into file_revision(id,revision,device_id,sync_id,name,absolute_path,mime_type,extension,created_at,source_sequence,analysis_input_revision) values(s.id,3,s.device_id,s.sync_id,s.name,s.absolute_path,s.mime_type,s.extension,now(),3,1); insert into file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) select file_id,3,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,now() from file_content where file_id=s.id and revision=2; update file_entry set revision=3 where id=s.id; end $$").await.unwrap();
    let third = running(&db, device, file, 3).await;
    publish(&db, &third, &["report.pdf"]).await;
    assert_eq!(members(&db, file).await, vec![(id, 3)]);
    assert!(file_entry::Entity::find_by_id(id)
        .filter(super::query::current_visibility())
        .one(&db)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn publication_requires_complete_admitted_manifest_and_current_run() {
    let (db, device, file) = fixture().await;
    let attempt = running(&db, device, file, 2).await;
    let prepared = outputs(&attempt, &["report.pdf"]);
    repository::admit(
        &db,
        &attempt,
        &Manifest {
            members: prepared.iter().map(|o| o.member.clone()).collect(),
            records: 1,
            metadata_bytes: 0,
        },
    )
    .await
    .unwrap();
    assert!(publication::publish(&db, &attempt, &[]).await.is_err());
    assert!(members(&db, file).await.is_empty());
    let stale = Attempt {
        archive_id: attempt.archive_id,
        run_id: Uuid::new_v4(),
    };
    assert!(publication::publish(&db, &stale, &prepared).await.is_err());
    assert!(members(&db, file).await.is_empty());
    publication::publish(&db, &attempt, &prepared)
        .await
        .unwrap();
    assert_eq!(members(&db, file).await.len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn nested_zip_and_case_distinct_paths_inherit_source_revision() {
    let (db, device, file) = fixture().await;
    let attempt = running(&db, device, file, 2).await;
    publish(&db, &attempt, &["Report.txt", "report.txt", "child.zip"]).await;
    assert_eq!(members(&db, file).await.len(), 3);
    let row=db.query_one_raw(Statement::from_string(DbBackend::Postgres,"select source_revision,parent_id,root_id,state from file_archive where parent_id is not null")).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "source_revision").unwrap(), 2);
    assert_eq!(
        row.try_get::<Uuid>("", "parent_id").unwrap(),
        attempt.archive_id
    );
    assert_eq!(row.try_get::<String>("", "state").unwrap(), "queued");
}

#[tokio::test]
#[serial_test::serial]
async fn publication_lock_wait_is_bounded_without_partial_members() {
    let (db, device, file) = fixture().await;
    let attempt = running(&db, device, file, 2).await;
    let lock = db.begin().await.unwrap();
    lock.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id from file_archive where id=$1 for update",
        [attempt.archive_id.into()],
    ))
    .await
    .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        publication::publish(&db, &attempt, &[]),
    )
    .await
    .expect("publication lock wait must terminate");
    let error = result.unwrap_err();
    assert!(
        error
            .chain()
            .any(|cause| cause.to_string().contains("lock timeout")),
        "{error:#}"
    );
    lock.rollback().await.unwrap();
    assert!(members(&db, file).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn file_directory_transitions_keep_distinct_snapshot_identities() {
    let (db, device, file) = fixture().await;
    let first = running(&db, device, file, 1).await;
    publish(&db, &first, &["entry"]).await;
    let second = running(&db, device, file, 2).await;
    publish(&db, &second, &["entry/"]).await;
    let identities = members(&db, file).await;
    assert_eq!(identities.len(), 2);
    assert_ne!(identities[0].0, identities[1].0);
    use crate::file_registry::entities::file_entry;
    let visible = file_entry::Entity::find()
        .filter(file_entry::Column::ArchiveFileId.eq(file))
        .filter(super::query::current_visibility())
        .all(&db)
        .await
        .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].kind,
        crate::devices::files::types::DomainFileEntryKind::Directory
    );
    assert_eq!(visible[0].revision, Some(2));
}

#[tokio::test]
#[serial_test::serial]
async fn recovery_fences_old_runs_and_retry_charges_bytes_without_duplicate_nodes(
) {
    let (db, device, file) = fixture().await;
    let first = running(&db, device, file, 2).await;
    let mut manifest = Manifest {
        members: outputs(&first, &["one", "two"])
            .into_iter()
            .map(|o| o.member)
            .collect(),
        records: 2,
        metadata_bytes: 0,
    };
    for member in &mut manifest.members {
        member.size = 1;
    }
    repository::admit(&db, &first, &manifest).await.unwrap();
    repository::admit(&db, &first, &manifest).await.unwrap();
    repository::recover(&db).await.unwrap();
    assert!(repository::claim(&db).await.unwrap().is_none());
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set not_before=now()-interval '1 second' where id=$1",[first.archive_id.into()])).await.unwrap();
    let (second, archive) = repository::claim(&db).await.unwrap().unwrap();
    assert_ne!(first.run_id, second.run_id);
    assert_eq!(archive.attempts, 2);
    assert_eq!((archive.expanded_bytes, archive.node_count), (2, 2));
    assert!(repository::renew(&db, &first).await.is_err());
    assert!(publication::publish(&db, &first, &[]).await.is_err());
    repository::admit(&db, &second, &manifest).await.unwrap();
    repository::fail(&db, &second, &super::error::Failure::Integrity.into())
        .await
        .unwrap();
    let row = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select state,error_code,expanded_bytes,node_count from file_archive where id=$1",[first.archive_id.into()])).await.unwrap().unwrap();
    assert_eq!(row.try_get::<String>("", "state").unwrap(), "failed");
    assert_eq!(
        row.try_get::<String>("", "error_code").unwrap(),
        "integrity_mismatch"
    );
    assert_eq!(row.try_get::<i64>("", "expanded_bytes").unwrap(), 4);
    assert_eq!(row.try_get::<i64>("", "node_count").unwrap(), 2);
    assert!(members(&db, file).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn cleanup_s3_denial_retains_debt_and_allows_next_archive_3830() {
    for delayed in [false, true] {
        let (db, device, file) = fixture().await;
        let stale = enqueue::ensure(&db, device, file, 1)
            .await
            .unwrap()
            .unwrap();
        let next = enqueue::ensure(&db, device, file, 2)
            .await
            .unwrap()
            .unwrap();
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set state='failed',error_code='storage_failed',attempts=1,updated_at=now()-interval '3 minutes',next_cleanup_at=now()-interval '1 minute' where id=$1",[stale.into()])).await.unwrap();
        let server = super::storage_tests::server_with_delay(
            vec![(403, "<Error><Code>AccessDenied</Code></Error>")],
            std::time::Duration::from_secs(if delayed { 60 } else { 0 }),
        )
        .await;
        let scratch = tempfile::tempdir().unwrap();
        let result =
            super::cleanup::sweep(&db, &server.config, scratch.path()).await;
        // S3 failures are per-row warnings; an exhausted budget ends the pass.
        assert!(result.is_ok());

        assert_eq!(server.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let row = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select state,next_cleanup_at>clock_timestamp() as deferred from file_archive where id=$1", [stale.into()])).await.unwrap().unwrap();
        assert_eq!(row.try_get::<String>("", "state").unwrap(), "failed");
        assert!(row.try_get::<bool>("", "deferred").unwrap());
        let (attempt, _) = repository::claim(&db).await.unwrap().unwrap();
        assert_eq!(attempt.archive_id, next);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn directory_dates_use_descendant_dates_from_the_selected_archive_revision_3930(
) {
    use crate::devices::files::query::dates;
    use crate::file_registry::entities::file_entry;
    let (db, device, file) = fixture().await;
    let mut directory_id = None;
    for (revision, day) in [(1, 10), (2, 20)] {
        let attempt = running(&db, device, file, revision).await;
        let mut outputs = outputs(
            &attempt,
            &["nested/", "nested/deep/", "nested/deep/a.txt", "empty/"],
        );
        let modified = chrono::NaiveDate::from_ymd_opt(2026, 7, day)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        for output in &mut outputs {
            output.member.modified_at = Some(modified);
            if let Some(bytes) = &mut output.bytes {
                bytes.size = revision as u64 * 7;
                output.member.size = bytes.size;
                output.member.compressed_size = bytes.size;
            }
        }
        repository::admit(
            &db,
            &attempt,
            &Manifest {
                members: outputs
                    .iter()
                    .map(|output| output.member.clone())
                    .collect(),
                records: outputs.len() as u64,
                metadata_bytes: 0,
            },
        )
        .await
        .unwrap();
        publication::publish(&db, &attempt, &outputs).await.unwrap();
        let mut folders = file_entry::Entity::find()
            .filter(file_entry::Column::ArchiveFileId.eq(file))
            .filter(
                file_entry::Column::Kind
                    .eq(crate::devices::files::DomainFileEntryKind::Directory),
            )
            .all(&db)
            .await
            .unwrap();
        dates::hydrate(&db, &mut folders).await.unwrap();
        let nested = folders
            .iter()
            .find(|folder| folder.name == "nested")
            .unwrap();
        if let Some(id) = directory_id {
            assert_eq!(nested.id, id);
        }
        directory_id = Some(nested.id);
        assert_eq!(nested.file_metadata_modified_at, Some(modified));
        assert!(nested.file_metadata_created_at.is_none());
        let empty = folders
            .iter()
            .find(|folder| folder.name == "empty")
            .unwrap();
        assert!(empty.file_metadata_created_at.is_none());
        assert!(empty.file_metadata_modified_at.is_none());
        let mut entries = folders
            .into_iter()
            .map(|entry| {
                crate::devices::files::bl::mapping::map_tree_entry(
                    crate::devices::files::query::model::map_tree_model(entry)
                        .unwrap(),
                    vec![],
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        crate::devices::files::query::sizes::hydrate(&db, &mut entries)
            .await
            .unwrap();
        for entry in entries {
            assert_eq!(
                entry.size_bytes,
                Some(if entry.name == "empty" {
                    0
                } else {
                    revision * 7
                })
            );
        }
    }
    let mut historical = file_entry::Entity::find_by_id(directory_id.unwrap())
        .one(&db)
        .await
        .unwrap()
        .unwrap();
    historical.revision = Some(1);
    dates::hydrate(&db, std::slice::from_mut(&mut historical))
        .await
        .unwrap();
    let mut entries = vec![crate::devices::files::bl::mapping::map_tree_entry(
        crate::devices::files::query::model::map_tree_model(historical.clone())
            .unwrap(),
        vec![],
        vec![],
    )];
    crate::devices::files::query::sizes::hydrate(&db, &mut entries)
        .await
        .unwrap();
    assert_eq!(entries[0].size_bytes, Some(7));
    assert_eq!(
        historical.file_metadata_modified_at.unwrap(),
        chrono::NaiveDate::from_ymd_opt(2026, 7, 10)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    );
}
