use crate::entities::signal_message_media as media;
use anyhow::Context;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DbBackend, EntityTrait, PaginatorTrait,
    Set, Statement, TransactionTrait,
};
use sea_orm_migration::{MigratorTrait, SchemaManager};
use uuid::Uuid;
async fn migrate_sources(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let transaction = db.begin().await.context(crate::h!())?;
    let migration = echo_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| {
            migration.name().ends_with("_migrate_transcription_sources")
        })
        .context("transcription source migration missing")
        .context(crate::h!())?;
    let outcome = migration.up(&SchemaManager::new(&transaction)).await;
    if let Err(error) = outcome {
        // A dropped transaction rolls back later, still holding its locks when
        // the caller retries.
        transaction.rollback().await.context(crate::h!())?;
        return Err(error).context(crate::h!());
    }
    transaction.commit().await.context(crate::h!())?;
    Ok(())
}

async fn media_source(env: &crate::types::Env, key: &str) -> Uuid {
    let message =
        crate::functest::tests::mk_signal_message(&env.dbx, Default::default())
            .await
            .unwrap();
    let id = Uuid::now_v7();
    media::ActiveModel {
        id: Set(id),
        signal_message_id: Set(message.id),
        signal_message_uuid: Set(message.id_uuid),
        content_type: Set("audio/wav".into()),
        file_ext: Set(Some("wav".into())),
        file_name: Set(Some("fixture.wav".into())),
        size_bytes: Set(123),
        is_encrypted: Set(true),
        storage_key: Set(Some(key.into())),
        created_at: Set(chrono::Utc::now().naive_utc()),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    id
}
async fn native_snapshot(env: &crate::types::Env) -> Vec<serde_json::Value> {
    env.dbx.query_all_raw(Statement::from_string(DbBackend::Postgres,"select to_jsonb(queue)-'source_id' as value from echo_gpu_transcription_queue queue order by id")).await.unwrap().into_iter().map(|row|row.try_get("","value").unwrap()).collect()
}
#[actix_web::test]
#[serial_test::serial]
async fn conversion_preserves_all_native_data_and_is_repeatable() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let id = media_source(&env, "preserved/main").await;
    echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
    let (registered, _) =
        super::service::enqueue(&env.dbx, "device-audio/registered")
            .await
            .unwrap();
    let fallback = media_source(&env, "unused-key").await;
    env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update signal_message_media set storage_key=null,is_encrypted=false where id=$1", [fallback.into()])).await.unwrap();
    echo_gpu_client::enqueue(&env.dbx, fallback).await.unwrap();
    let pre_registered_media =
        media_source(&env, "preserved/pre-registered").await;
    let pre_registered_source = Uuid::now_v7();
    env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into transcription_source(id,source_key) values($1,'message-media/preserved/pre-registered')", [pre_registered_source.into()])).await.unwrap();
    echo_gpu_client::enqueue(&env.dbx, pre_registered_media)
        .await
        .unwrap();
    env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set state='completed',transcribed_value='preserved',attempt_count=5,reprocess_count=3,reprocess_reason='audit',reprocess_requested_by='fixture',finished_at=now() at time zone 'utc' where source_id='{id}'")).await.unwrap();
    for state in ["queued", "retrying", "terminal", "processing"] {
        let source = media_source(&env, &format!("preserved/{state}")).await;
        echo_gpu_client::enqueue(&env.dbx, source).await.unwrap();
        env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update echo_gpu_transcription_queue set state=$2,attempt_count=4,reprocess_count=2,reprocess_reason='preserved reason',reprocess_requested_by='preserved actor',transcription_scope_id=gen_random_uuid(),worker_id=case when $2='processing' then gen_random_uuid() end,heartbeat_at=(now() at time zone 'utc')-interval '1 hour',next_retry_at=(now() at time zone 'utc')+interval '1 hour',last_error='preserved diagnostic',selected_audio_id=gen_random_uuid(),selected_audio_checksum=repeat('a',64) where source_id=$1",
            [source.into(),state.into()])).await.unwrap();
    }
    env.dbx.execute_unprepared("insert into echo_gpu_audio_chunk(parent_audio_id,parent_instance_id,parent_checksum,chunk_audio_id,chunk_number,chunk_count,chunk_checksum,chunk_start_seconds,transcribed_value,transcription_response,transcription_scope_id,split_version) select selected_audio_id,gen_random_uuid(),selected_audio_checksum,gen_random_uuid(),1,2,repeat('b',64),0,'cached chunk','{\"preserved\":true}'::jsonb,transcription_scope_id,1 from echo_gpu_transcription_queue where selected_audio_id is not null").await.unwrap();
    for index in 0..=crate::config::ECHO_AUDIO_TRANSCRIPTION_BACKFILL_BATCH_SIZE
    {
        let source =
            media_source(&env, &format!("preserved/page/{index}")).await;
        echo_gpu_client::enqueue(&env.dbx, source).await.unwrap();
    }
    let cache_before = chunk_snapshot(&env).await;
    let before = native_snapshot(&env).await;
    assert!(super::service::ensure_sources_registered(&env.dbx)
        .await
        .is_err());
    assert_eq!(before, native_snapshot(&env).await);
    for _ in 0..2 {
        migrate_sources(&env.dbx).await.unwrap();
        super::service::ensure_sources_registered(&env.dbx)
            .await
            .unwrap();
    }
    assert_eq!(before, native_snapshot(&env).await);
    assert_eq!(cache_before, chunk_snapshot(&env).await);
    assert_eq!(
        super::service::source_id(&env.dbx, "device-audio/registered")
            .await
            .unwrap(),
        Some(registered)
    );
    assert_eq!(
        super::service::source_id(
            &env.dbx,
            "message-media/preserved/pre-registered"
        )
        .await
        .unwrap(),
        Some(pre_registered_source)
    );
    let fallback_key = format!(
        "message-media/{}/{fallback}.plaintext",
        &fallback.to_string()[..5]
    );
    assert!(super::service::source_id(&env.dbx, &fallback_key)
        .await
        .unwrap()
        .is_some());
    assert_ne!(
        super::service::source_id(&env.dbx, "message-media/preserved/main")
            .await
            .unwrap()
            .unwrap(),
        id
    );
    let texts = crate::transcriber::completed_transcriptions(&env.dbx, &[id])
        .await
        .unwrap();
    assert_eq!(texts.get(&id).map(String::as_str), Some("preserved"));
}
#[actix_web::test]
#[serial_test::serial]
async fn ambiguous_and_missing_mapping_fail_before_any_durable_change() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let collisions = [
        media_source(&env, "collision").await,
        media_source(&env, "collision").await,
    ];
    for id in collisions {
        echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
    }
    env.dbx
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update echo_gpu_transcription_queue set state='retrying' where source_id=$1",
            [collisions[1].into()],
        ))
        .await
        .unwrap();
    let before = native_snapshot(&env).await;
    let error = migrate_sources(&env.dbx).await.unwrap_err();
    assert!(format!("{error:#}")
        .contains("Incompatible duplicate transcription tasks"));
    assert_eq!(before, native_snapshot(&env).await);
    assert!(
        super::service::source_id(&env.dbx, "message-media/collision")
            .await
            .unwrap()
            .is_none()
    );
    env.dbx
        .execute_unprepared("delete from echo_gpu_transcription_queue")
        .await
        .unwrap();
    let unknown = Uuid::now_v7();
    echo_gpu_client::enqueue(&env.dbx, unknown).await.unwrap();
    let before = native_snapshot(&env).await;
    let error = migrate_sources(&env.dbx).await.unwrap_err();
    assert!(format!("{error:#}").contains(&unknown.to_string()));
    assert_eq!(before, native_snapshot(&env).await);
    assert!(echo_gpu_client::lookup(&env.dbx, unknown)
        .await
        .unwrap()
        .is_some());
}

#[actix_web::test]
#[serial_test::serial]
async fn conversion_merges_compatible_duplicates_in_every_state() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let mut keepers = Vec::new();
    let mut sources = Vec::new();
    for state in ["queued", "retrying", "terminal", "processing", "completed"] {
        let key = format!("duplicate-{state}");
        let first = media_source(&env, &key).await;
        let second = media_source(&env, &key).await;
        for id in [first, second] {
            echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
        }
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update echo_gpu_transcription_queue set state=$2 where source_id=any($1)",
                [vec![first, second].into(), state.into()],
            ))
            .await
            .unwrap();
        env.dbx
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update echo_gpu_transcription_queue set created_at=created_at-interval '1 day' where source_id=$1",
                [first.into()],
            ))
            .await
            .unwrap();
        let keeper = echo_gpu_client::lookup(&env.dbx, first)
            .await
            .unwrap()
            .unwrap();
        keepers.push(keeper.0.id);
        sources.push((format!("message-media/{key}"), keeper, first, second));
    }
    let before: Vec<_> = native_snapshot(&env)
        .await
        .into_iter()
        .filter(|row| {
            keepers.iter().any(|id| row["id"] == serde_json::json!(id))
        })
        .collect();
    for _ in 0..2 {
        migrate_sources(&env.dbx).await.unwrap();
        assert_eq!(native_snapshot(&env).await, before);
    }
    for (key, mut keeper, first, second) in sources {
        let source_id = super::service::source_id(&env.dbx, &key)
            .await
            .unwrap()
            .unwrap();
        keeper.0.source_id = source_id;
        let migrated = echo_gpu_client::lookup(&env.dbx, source_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(migrated.0, keeper.0);
        for id in [first, second] {
            assert!(media::Entity::find_by_id(id)
                .one(&env.dbx)
                .await
                .unwrap()
                .is_some());
        }
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn migration_rejects_active_executor() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let id = media_source(&env, "executor-guard").await;
    echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
    let before = native_snapshot(&env).await;
    for key in [
        super::executor::ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_LOCK,
        super::executor::ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK,
    ] {
        let executor = env.dbx.begin().await.unwrap();
        executor
            .execute_unprepared(&format!("select pg_advisory_xact_lock({key})"))
            .await
            .unwrap();
        let error = migrate_sources(&env.dbx).await.unwrap_err();
        assert!(format!("{error:#}").contains("Stop transcription executors"));
        assert_eq!(before, native_snapshot(&env).await);
        executor.rollback().await.unwrap();
    }
}

#[actix_web::test]
#[serial_test::serial]
async fn conversion_rolls_back_registry_and_queue_on_write_failure() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let id = media_source(&env, "rollback").await;
    echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
    env.dbx.execute_unprepared("create function fail_conversion_test() returns trigger language plpgsql as $$ begin raise exception 'injected remap failure'; end $$; create trigger fail_conversion_test before update of source_id on echo_gpu_transcription_queue for each row execute function fail_conversion_test()").await.unwrap();
    let before = native_snapshot(&env).await;
    let result = migrate_sources(&env.dbx).await;
    env.dbx.execute_unprepared("drop trigger fail_conversion_test on echo_gpu_transcription_queue; drop function fail_conversion_test()").await.unwrap();
    assert!(result.is_err());
    assert_eq!(before, native_snapshot(&env).await);
    assert!(
        super::service::source_id(&env.dbx, "message-media/rollback")
            .await
            .unwrap()
            .is_none()
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn conversion_merges_completed_duplicates_without_changing_material_texts(
) {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let first = media_source(&env, "shared-migration").await;
    let second = media_source(&env, "shared-migration").await;
    let silent_first = media_source(&env, "silent-migration").await;
    let silent_second = media_source(&env, "silent-migration").await;
    for source in [first, second, silent_first, silent_second] {
        echo_gpu_client::enqueue(&env.dbx, source).await.unwrap();
        env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update echo_gpu_transcription_queue set state='completed',transcribed_value=case when source_id=any($2) then null else 'Спільний текст' end,attempt_count=1,finished_at=now() at time zone 'utc',selected_audio_id=gen_random_uuid(),selected_audio_checksum=repeat('a',64),transcription_scope_id=gen_random_uuid(),worker_id=gen_random_uuid() where source_id=$1", [source.into(),vec![silent_first,silent_second].into()])).await.unwrap();
    }
    env.dbx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update echo_gpu_transcription_queue set created_at=created_at-interval '1 day' where source_id=any($1)", [vec![first,silent_first].into()])).await.unwrap();
    let keepers = [
        echo_gpu_client::lookup(&env.dbx, first)
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
        echo_gpu_client::lookup(&env.dbx, silent_first)
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
    ];
    for source in [first, second, silent_first, silent_second] {
        let attachment = media::Entity::find_by_id(source)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            crate::entities::sigint_inbox_item::ActiveModel {
                id: Set(attachment.signal_message_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let login = crate::functest::tests::find_test_login(&env.dbx)
        .await
        .unwrap();
    crate::entities::api_integration::ActiveModel {
        api_user_login_id: Set(login.id),
        has_iggy_connection: Set(true),
        iggy_url: Set(Some("tcp://localhost:8090".into())),
        iggy_login: Set(Some("test".into())),
        iggy_password: Set(Some("test".into())),
        iggy_inbox_topic: Set(Some("test-inbox".into())),
        iggy_analytics_topic: Set(Some("test-analytics".into())),
        sync_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    env.dbx
        .execute_unprepared("delete from api_integration_iggy_event")
        .await
        .unwrap();
    let before: Vec<_> = native_snapshot(&env)
        .await
        .into_iter()
        .filter(|row| {
            keepers.iter().any(|id| row["id"] == serde_json::json!(id))
        })
        .collect();
    for _ in 0..2 {
        migrate_sources(&env.dbx).await.unwrap();
    }
    assert_eq!(native_snapshot(&env).await, before);
    assert_eq!(
        crate::entities::api_integration_iggy_event::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        0
    );
    let texts = crate::transcriber::completed_transcriptions(
        &env.dbx,
        &[first, second, silent_first, silent_second],
    )
    .await
    .unwrap();
    assert_eq!(texts.len(), 2);
    assert_eq!(texts[&first], "Спільний текст");
    assert_eq!(texts[&second], "Спільний текст");
    let silent_source =
        super::service::source_id(&env.dbx, "message-media/silent-migration")
            .await
            .unwrap()
            .unwrap();
    let silent = echo_gpu_client::lookup(&env.dbx, silent_source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(silent.0.state, "completed");
    assert!(silent.0.transcribed_value.is_none());
    env.dbx.execute_unprepared("update echo_gpu_transcription_queue set transcribed_value='Новий результат' where transcribed_value is not null").await.unwrap();
    assert!(
        crate::entities::api_integration_iggy_event::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap()
            > 0
    );
}

#[actix_web::test]
#[serial_test::serial]
async fn migration_rejects_incompatible_duplicates_without_changes() {
    let (env, _guard) = crate::functest::tests::cleanup_locked().await.unwrap();
    let first = media_source(&env, "conflicting-history").await;
    let second = media_source(&env, "conflicting-history").await;
    for id in [first, second] {
        echo_gpu_client::enqueue(&env.dbx, id).await.unwrap();
    }
    for change in [
        "transcribed_value='Спільний текст '",
        "transcribed_value=null",
        "state='processing'",
        "attempt_count=2",
        "reprocess_count=1",
        "reprocess_reason='separate audit'",
        "selected_audio_checksum=repeat('b',64)",
    ] {
        env.dbx.execute_unprepared("update echo_gpu_transcription_queue set state='completed',transcribed_value='Спільний текст',attempt_count=1,reprocess_count=0,reprocess_reason=null,selected_audio_checksum=repeat('a',64)").await.unwrap();
        env.dbx.execute_unprepared(&format!("update echo_gpu_transcription_queue set {change} where source_id='{second}'")).await.unwrap();
        let before = native_snapshot(&env).await;
        let error = migrate_sources(&env.dbx).await.unwrap_err();
        assert!(
            format!("{error:#}")
                .contains("Incompatible duplicate transcription tasks"),
            "{change}: {error:#}"
        );
        assert_eq!(before, native_snapshot(&env).await, "{change}");
        assert!(super::service::source_id(
            &env.dbx,
            "message-media/conflicting-history"
        )
        .await
        .unwrap()
        .is_none());
    }
}

async fn chunk_snapshot(env: &crate::types::Env) -> Vec<serde_json::Value> {
    env.dbx.query_all_raw(Statement::from_string(DbBackend::Postgres,"select to_jsonb(chunk) as value from echo_gpu_audio_chunk chunk order by id")).await.unwrap().into_iter().map(|row|row.try_get("","value").unwrap()).collect()
}
