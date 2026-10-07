use super::*;

#[tokio::test]
#[serial_test::serial]
async fn device_audio_schema_preserves_existing_files() {
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
            .position(|migration| {
                migration.name().ends_with("_create_device_audio")
            })
            .unwrap_or(migrations.len());
        wdfiles_migration::Migrator::up(connection, Some(prior as u32))
            .await
            .unwrap();
        let transaction = connection.begin().await.unwrap();
        let tree = insert_file_entry_tree(&transaction).await;
        transaction.commit().await.unwrap();
        let before = legacy_snapshot(connection).await;

        run_migrations(&config, Mode::Debug).await.unwrap();
        run_migrations(&config, Mode::Debug).await.unwrap();

        assert!(table_exists(connection, "device_audio").await);
        assert!(table_exists(connection, "device_audio_ingest").await);
        assert_eq!(legacy_snapshot(connection).await, before);
        assert!(file_entry::Entity::find_by_id(tree.file_id)
            .one(connection)
            .await
            .unwrap()
            .is_some());
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn legacy_snapshot(connection: &DatabaseConnection) -> Vec<String> {
    let mut snapshot = Vec::new();
    for table in ["file_entry", "file_revision", "file_sync_session"] {
        let rows = connection
            .query_all_raw(Statement::from_string(
                DbBackend::Postgres,
                format!("select row_to_json(t)::text as row from {table} t order by id"),
            ))
            .await
            .unwrap();
        snapshot.extend(rows.into_iter().map(|row| {
            format!("{table}:{}", row.try_get::<String>("", "row").unwrap())
        }));
    }
    snapshot
}

#[tokio::test]
#[serial_test::serial]
async fn device_audio_schema_accepts_existing_tus_reference() {
    let (config, database_url) = isolated_file_registry_config().await;
    run_migrations(&config, Mode::Debug).await.unwrap();
    {
        let db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let transaction = db.connection().begin().await.unwrap();
        let (fixture, _source_dir) = real_completed_source().await;
        insert_ingest(&transaction, &fixture, "record.wav").await;
        transaction.rollback().await.unwrap();
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn real_completed_source() -> (AudioFixture, tempfile::TempDir) {
    use crate::sigint::file_upload::tus::{
        CompletedUploadWriteResult, TusHandler, TusUploadMetadata,
    };

    let mut fixture = AudioFixture::new();
    let source_dir = tempfile::tempdir().unwrap();
    let handler = TusHandler::new_for_test(
        source_dir.path().to_str().unwrap().to_string(),
        &format!("/api/device/audio/{}/uploads", fixture.device_id),
    );
    let result = handler
        .create_completed_upload(
            &fixture.actor_id,
            TusUploadMetadata::default(),
            futures_util::stream::iter([Ok(actix_web::web::Bytes::from(
                vec![0; 123],
            ))]),
        )
        .await
        .unwrap();
    let CompletedUploadWriteResult::Stored {
        file_id,
        upload_url,
        size,
    } = result
    else {
        panic!("shared handler did not complete the test source");
    };
    let source = handler
        .open_completed_url(&fixture.actor_id, &upload_url)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.file_id, file_id);
    assert_eq!(source.upload_length, size);
    fixture.upload_id = file_id;
    fixture.upload_ref = upload_url;
    (fixture, source_dir)
}

#[tokio::test]
#[serial_test::serial]
async fn device_audio_schema_rejects_identity_mutation() {
    let (config, database_url) = isolated_file_registry_config().await;
    run_migrations(&config, Mode::Debug).await.unwrap();
    {
        let db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = db.connection();
        assert!(table_exists(connection, "device_audio").await);
        let transaction = connection.begin().await.unwrap();
        let fixture = AudioFixture::new();
        insert_ingest(&transaction, &fixture, "record.wav").await;
        validate_ingest(&transaction, &fixture).await;
        assert_audio_constraints(&transaction, &fixture).await;
        insert_audio(&transaction, &fixture, "record.wav")
            .await
            .unwrap();
        transaction
            .execute_unprepared(
                "update device_audio_ingest set status = 'ready'",
            )
            .await
            .unwrap();
        assert_audio_immutability(&transaction).await;
        assert_ledger_immutability(&transaction).await;
        assert_bytewise_names(&transaction, &fixture).await;
        transaction.rollback().await.unwrap();
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

struct AudioFixture {
    ingest_id: Uuid,
    audio_id: Uuid,
    device_id: Uuid,
    actor_id: Uuid,
    upload_id: Uuid,
    upload_ref: String,
}

impl AudioFixture {
    fn new() -> Self {
        Self::for_device(Uuid::new_v4())
    }

    fn for_device(device_id: Uuid) -> Self {
        let upload_id = Uuid::new_v4();
        Self {
            ingest_id: Uuid::new_v4(),
            audio_id: Uuid::new_v4(),
            device_id,
            actor_id: Uuid::new_v4(),
            upload_id,
            upload_ref: format!(
                "/api/device/audio/{device_id}/uploads/{upload_id}.123"
            ),
        }
    }

    fn key(&self) -> String {
        format!(
            "device-audio/{}/{}/{}",
            self.device_id, self.audio_id, self.ingest_id
        )
    }
}

async fn insert_ingest(
    connection: &DatabaseTransaction,
    fixture: &AudioFixture,
    name: &str,
) {
    connection
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into device_audio_ingest (
                id, audio_id, device_id, actor_id, tus_upload_ref,
                tus_upload_id, tus_owner_id, name, name_key,
                recording_started_at, created_at, storage_key, status,
                lease_token, heartbeat_at
            ) values ($1,$2,$3,$4,$5,$6,$4,$7,convert_to($7,'UTF8'),
                '2026-10-03T23:59:30Z','2026-10-04T00:01:00Z',$8,
                'finalizing',$9,'2026-10-04T00:01:00Z')"#,
            [
                fixture.ingest_id.into(),
                fixture.audio_id.into(),
                fixture.device_id.into(),
                fixture.actor_id.into(),
                fixture.upload_ref.clone().into(),
                fixture.upload_id.into(),
                name.into(),
                fixture.key().into(),
                Uuid::new_v4().into(),
            ],
        ))
        .await
        .unwrap();
}

async fn validate_ingest(
    connection: &DatabaseTransaction,
    fixture: &AudioFixture,
) {
    connection.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update device_audio_ingest set status='storing', source_size_bytes=123, source_sha256=decode(repeat('00',32),'hex'), duration_us=90000000, mime_type='audio/wav' where id=$1",
        [fixture.ingest_id.into()],
    )).await.unwrap();
}

async fn insert_audio(
    connection: &DatabaseTransaction,
    fixture: &AudioFixture,
    name: &str,
) -> Result<sea_orm::ExecResult, DbErr> {
    insert_audio_with_override(connection, fixture, name, "'{}'::jsonb").await
}

async fn insert_audio_with_override(
    connection: &DatabaseTransaction,
    fixture: &AudioFixture,
    name: &str,
    overrides: &str,
) -> Result<sea_orm::ExecResult, DbErr> {
    connection.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!(r#"insert into device_audio select (jsonb_populate_record(
            null::device_audio, jsonb_build_object(
                'id',$1::uuid,'device_id',$2::uuid,'ingest_id',$3::uuid,
                'name',$4::text,'name_key',convert_to($4::text,'UTF8'),
                'recording_started_at','2026-10-03T23:59:30Z',
                'duration_us',90000000,'recording_ended_at','2026-10-04T00:01:00Z',
                'created_at','2026-10-04T00:01:00Z','mime_type','audio/wav',
                'source_size_bytes',123,'source_sha256',decode(repeat('00',32),'hex'),
                'storage_key',$5::text,'transcription','',
                'text_version',$6::uuid,'processed',false,'processing_version',$7::uuid
            ) || {overrides})).*"#),
        [fixture.audio_id.into(), fixture.device_id.into(), fixture.ingest_id.into(),
            name.into(), fixture.key().into(), Uuid::new_v4().into(), Uuid::new_v4().into()],
    )).await
}

async fn reject(connection: &DatabaseTransaction, sql: &str) {
    assert_file_entry_operation_rejected(
        connection,
        connection.execute_unprepared(sql),
    )
    .await;
}

async fn assert_audio_constraints(
    connection: &DatabaseTransaction,
    fixture: &AudioFixture,
) {
    for assignment in [
        "source_size_bytes=0",
        "source_size_bytes=104857601",
        "source_sha256=decode('00','hex')",
        "duration_us=0",
        "mime_type='text/plain'",
        "name_key=decode('00','hex')",
        "name=''",
        "name=repeat('я',513)",
        "recording_started_at='infinity'",
    ] {
        reject(
            connection,
            &format!("update device_audio_ingest set {assignment}"),
        )
        .await;
    }
    reject(
        connection,
        "update device_audio_ingest set status='finalizing'",
    )
    .await;
    for assignment in [
        "source_size_bytes=0",
        "source_size_bytes=104857601",
        "source_sha256=decode('00','hex')",
        "duration_us=0",
        "mime_type='text/plain'",
        "name_key=decode('00','hex')",
        "name=''",
        "name=repeat('я',513)",
        "recording_ended_at='2026-10-04T00:01:00.000001Z'",
        "recording_started_at='infinity'",
        "ingest_id=gen_random_uuid()",
    ] {
        let overrides =
            format!("jsonb_build_object({})", assignment_json(assignment));
        assert_file_entry_operation_rejected(
            connection,
            insert_audio_with_override(
                connection,
                fixture,
                "record.wav",
                &overrides,
            ),
        )
        .await;
    }
}

fn assignment_json(assignment: &str) -> String {
    let (column, value) = assignment.split_once('=').unwrap();
    format!("'{column}',{value}")
}

async fn assert_audio_immutability(connection: &DatabaseTransaction) {
    for assignment in [
        "id=gen_random_uuid()",
        "device_id=gen_random_uuid()",
        "ingest_id=gen_random_uuid()",
        "name='renamed.wav'",
        "name_key=convert_to('renamed.wav','UTF8')",
        "recording_started_at=recording_started_at + interval '1 second'",
        "duration_us=duration_us+1",
        "recording_ended_at=recording_ended_at + interval '1 second'",
        "created_at=created_at + interval '1 second'",
        "mime_type='audio/mpeg'",
        "source_size_bytes=124",
        "source_sha256=decode(repeat('01',32),'hex')",
        "storage_key=storage_key || '/changed'",
    ] {
        reject(connection, &format!("update device_audio set {assignment}"))
            .await;
    }
    reject(connection, "delete from device_audio").await;
    connection.execute_unprepared("update device_audio set transcription=E'  текст\\n',text_version=gen_random_uuid(),processed=true,processing_version=gen_random_uuid()").await.unwrap();
}

async fn assert_ledger_immutability(connection: &DatabaseTransaction) {
    for assignment in [
        "id=gen_random_uuid()",
        "audio_id=gen_random_uuid()",
        "device_id=gen_random_uuid()",
        "actor_id=gen_random_uuid()",
        "tus_upload_ref='/other'",
        "tus_upload_id=gen_random_uuid()",
        "tus_owner_id=gen_random_uuid()",
        "name='other.wav'",
        "name_key=decode('01','hex')",
        "recording_started_at=recording_started_at + interval '1 second'",
        "created_at=created_at + interval '1 second'",
        "storage_key=storage_key || '/other'",
        "status='deleting'",
        "lease_token=gen_random_uuid()",
        "heartbeat_at=now()",
        "source_size_bytes=124",
        "source_sha256=decode(repeat('01',32),'hex')",
        "duration_us=1",
        "mime_type='audio/mpeg'",
        "cleanup_token=gen_random_uuid()",
        "next_cleanup_at=now()",
        "last_error='changed'",
    ] {
        reject(
            connection,
            &format!("update device_audio_ingest set {assignment}"),
        )
        .await;
    }
    reject(connection, "delete from device_audio_ingest").await;
    connection.execute_unprepared("update device_audio_ingest set source_consumed_at='2026-10-04T00:02:00Z'").await.unwrap();
    reject(
        connection,
        "update device_audio_ingest set source_consumed_at=null",
    )
    .await;
}

async fn assert_bytewise_names(
    connection: &DatabaseTransaction,
    ready: &AudioFixture,
) {
    for name in [
        "record.wav",
        "Record.wav",
        "é.wav",
        "e\u{301}.wav",
        " record.wav ",
    ] {
        let fixture = AudioFixture::for_device(ready.device_id);
        insert_ingest(connection, &fixture, name).await;
        validate_ingest(connection, &fixture).await;
        if name == "record.wav" {
            assert_file_entry_operation_rejected(
                connection,
                insert_audio(connection, &fixture, name),
            )
            .await;
        } else {
            insert_audio(connection, &fixture, name).await.unwrap();
        }
    }
    let other = AudioFixture::new();
    insert_ingest(connection, &other, "record.wav").await;
    validate_ingest(connection, &other).await;
    insert_audio(connection, &other, "record.wav")
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn device_audio_down_refuses_data() {
    let (config, database_url) = isolated_file_registry_config().await;
    {
        let db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = db.connection();
        let migrations = wdfiles_migration::Migrator::migrations();
        let audio_migration_index = migrations
            .iter()
            .position(|migration| {
                migration.name() == "m20261003_152726_create_device_audio"
            })
            .unwrap();
        wdfiles_migration::Migrator::up(
            connection,
            Some(u32::try_from(audio_migration_index + 1).unwrap()),
        )
        .await
        .unwrap();
        assert!(table_exists(connection, "device_audio").await);
        let transaction = connection.begin().await.unwrap();
        let fixture = AudioFixture::new();
        insert_ingest(&transaction, &fixture, "record.wav").await;
        transaction.commit().await.unwrap();
        assert_down_rejected(connection).await;
        let transaction = connection.begin().await.unwrap();
        validate_ingest(&transaction, &fixture).await;
        insert_audio(&transaction, &fixture, "record.wav")
            .await
            .unwrap();
        transaction
            .execute_unprepared("update device_audio_ingest set status='ready'")
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        assert_down_rejected(connection).await;
        assert_eq!(table_count(connection, "device_audio").await, 1);
        assert_eq!(table_count(connection, "device_audio_ingest").await, 1);
        connection
            .execute_unprepared("truncate device_audio, device_audio_ingest")
            .await
            .unwrap();
        wdfiles_migration::Migrator::down(connection, Some(1))
            .await
            .unwrap();
        assert!(!table_exists(connection, "device_audio").await);
        run_migrations(&config, Mode::Debug).await.unwrap();
        assert!(table_exists(connection, "device_audio").await);
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn assert_down_rejected(connection: &DatabaseConnection) {
    let error = wdfiles_migration::Migrator::down(connection, Some(1))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains(
            "device_audio rollback refused: audio or ingest data exists"
        ),
        "unexpected down error: {error:?}"
    );
    assert!(table_exists(connection, "device_audio").await);
    assert!(table_exists(connection, "device_audio_ingest").await);
}
