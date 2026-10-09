use super::*;

#[tokio::test]
#[serial_test::serial]
async fn preview_upgrade_preserves_originals_and_retains_cleanup_ledger() {
    let (config, database_url) = isolated_file_registry_config().await;
    {
        let db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = db.connection();
        let migrations = wdfiles_migration::Migrator::migrations();
        let prior = migrations
            .iter()
            .position(|migration| migration.name().ends_with("_file_preview"))
            .unwrap_or(migrations.len());
        wdfiles_migration::Migrator::up(connection, Some(prior as u32))
            .await
            .unwrap();
        let transaction = connection.begin().await.unwrap();
        let tree = insert_file_entry_tree(&transaction).await;
        let entry = file_entry::Entity::find_by_id(tree.file_id)
            .one(&transaction)
            .await
            .unwrap()
            .unwrap();
        super::super::test_support::publish_content(
            &transaction,
            &entry,
            Uuid::now_v7(),
        )
        .await;
        transaction.commit().await.unwrap();
        let before = snapshot(connection).await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        run_migrations(&config, Mode::Debug).await.unwrap();
        assert!(
            table_exists(connection, "file_preview").await,
            "durable preview ledger must exist after upgrade"
        );
        assert_eq!(snapshot(connection).await, before);
        let generation = Uuid::new_v4();
        connection.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres, r#"
insert into file_preview (generation, device_id, file_id, revision, source_file_id, source_revision, kind, converter_version, is_current, state, run_id, attempt, source_object_key, source_sha256, source_size_bytes, source_is_encrypted, source_name, source_extension, not_before, output_object_key, retryable, created_at, updated_at)
select $1, r.device_id, r.id, r.revision, c.file_id, c.revision, 'geodata_kmz', 1, true, 'queued', $1, 1, c.object_key, c.source_sha256, c.source_size_bytes, c.is_encrypted, r.name, r.extension, now(), 'test-preview/' || $1::text, false, now(), now()
from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.id=$2
"#, [generation.into(), tree.file_id.into()])).await.unwrap();
        let transaction = connection.begin().await.unwrap();
        for update in [
            "attempt=0",
            "attempt=4",
            "revision=0",
            "source_sha256='\\x01'",
            "source_size_bytes=-1",
            "state='unknown'",
            "state='running'",
            "state='ready'",
            "state='retired'",
            "source_revision=null",
            "source_name='other.gpx'",
            "source_object_key='another-key'",
            "device_id=gen_random_uuid()",
        ] {
            assert_file_entry_operation_rejected(&transaction, transaction.execute_unprepared(&format!("update file_preview set {update} where generation='{generation}'"))).await;
        }
        assert_file_entry_operation_rejected(&transaction, transaction.execute_unprepared(&format!("insert into file_preview select gen_random_uuid(), device_id, file_id, revision, source_file_id, source_revision, kind, converter_version, is_current, state, run_id, attempt, source_object_key, source_sha256, source_size_bytes, source_is_encrypted, source_name, source_extension, lease, lease_until, heartbeat_at, not_before, attempt_deadline, output_object_key || '-duplicate', result_size_bytes, result_sha256, result_encrypted, error_code, retryable, created_at, updated_at, expires_at, cleanup_after, object_deleted_at, tombstone_until from file_preview where generation='{generation}'"))).await;
        transaction.rollback().await.unwrap();
        let transaction = connection.begin().await.unwrap();
        transaction.execute_unprepared(&format!("update file_entry set content_path=null where id='{0}'; alter table file_content disable trigger file_content_immutable_trg; delete from file_content where file_id='{0}'; alter table file_content enable trigger file_content_immutable_trg",tree.file_id)).await.unwrap();
        transaction.commit().await.unwrap();
        let row = connection.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres, "select source_file_id, source_revision, source_object_key from file_preview where generation=$1", [generation.into()])).await.unwrap().unwrap();
        assert_eq!(
            row.try_get::<Option<Uuid>>("", "source_file_id").unwrap(),
            None
        );
        assert_eq!(
            row.try_get::<Option<i64>>("", "source_revision").unwrap(),
            None
        );
        assert!(!row
            .try_get::<String>("", "source_object_key")
            .unwrap()
            .is_empty());
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn snapshot(connection: &DatabaseConnection) -> Vec<String> {
    let mut snapshot = Vec::new();
    for table in ["file_entry", "file_revision", "file_content"] {
        let rows = connection.query_all_raw(Statement::from_string(DbBackend::Postgres, format!("select row_to_json(t)::text as row from {table} t order by row_to_json(t)::text"))).await.unwrap();
        snapshot.extend(rows.into_iter().map(|row| {
            format!("{table}:{}", row.try_get::<String>("", "row").unwrap())
        }));
    }
    snapshot
}
