use super::entities::sea_orm_active_enums::{
    FileContentUploadStatus, FileEntryKind, FileSyncSessionMode,
    FileSyncSessionStatus,
};
use super::entities::{
    file_content, file_content_upload, file_entry, file_revision,
    file_sync_session,
};
use super::*;
use crate::devices::analytics::types::RuleExpression;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    DbBackend, DbErr, EntityTrait, FromQueryResult, IntoActiveModel, Set,
    Statement, TransactionTrait, TryIntoModel,
};
use sea_orm_migration::MigratorTrait;
use sqlx::migrate::MigrateDatabase;
use std::{collections::BTreeMap, error::Error as StdError, future::Future};

mod device_audio;
mod file_preview;

#[tokio::test]
async fn missing_configuration_skips_connection_and_migrations() {
    let config: Config = toml::from_str(
        r#"
public_host = ""
cookie_session_secret = ""
storage_dir = ""
signal_api_phone = ""
signal_import_group_name = ""
signal_import_fiven_name = ""
static_path = ""
executable_path = ""
fill_comp_freq_worker = false
"#,
    )
    .unwrap();

    run_migrations(&config, Mode::Debug).await.unwrap();
    assert!(connect_runtime(&config, Mode::Debug)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn missing_file_database_has_actionable_error() {
    let previous = std::env::var_os("TEST_WDFILE_DB_NAME");
    let database = format!("wd_files_test_missing_{}", Uuid::new_v4());
    std::env::set_var("TEST_WDFILE_DB_NAME", &database);
    let config = crate::config::read_config(Mode::Test).unwrap();
    let result = connect_runtime(&config, Mode::Test).await;
    match previous {
        Some(value) => {
            std::env::set_var("TEST_WDFILE_DB_NAME", value);
        }
        None => {
            std::env::remove_var("TEST_WDFILE_DB_NAME");
        }
    }

    let error = match result {
        Ok(_) => {
            panic!("connecting to absent file database unexpectedly succeeded")
        }
        Err(error) => error,
    };
    assert!(
        has_postgres_error_code(&error, "3D000"),
        "expected SQLSTATE 3D000, got {error:?}"
    );
    let expected = format!(
        "File database \"{database}\" does not exist. Create it with `just create-file-registry-database --mode=test`, then restart the backend."
    );
    let details = format!("{:#}", error.source().unwrap());
    assert!(
        details.contains(&expected),
        "expected {expected:?} in {details:?}"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn file_registry_schema_and_entity_round_trip() {
    let (config, database_url) = isolated_file_registry_config().await;

    run_migrations(&config, Mode::Debug).await.unwrap();
    run_migrations(&config, Mode::Debug).await.unwrap();
    {
        let file_registry_db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = file_registry_db.connection();

        assert_migration_versions(connection).await;
        assert_public_extensions(connection).await;
        assert_legacy_file_table_is_absent(connection).await;
        assert_file_entry_schema(connection).await;
        assert_batched_file_sync_schema(connection).await;
        assert_file_content_schema(connection).await;
        assert_file_analysis_schema(connection).await;
        assert_default_analytics_tags(connection).await;
        assert_file_entry_entity_round_trip(connection).await;
    }

    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn verified_content_reuse_migration_preserves_original_publication() {
    let (config, database_url) = isolated_file_registry_config().await;
    {
        let db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = db.connection();
        let applied_count = migrate_through(
            connection,
            "m20261012_094502_device_audio_asr_scan_indexes",
        )
        .await;
        let tx = connection.begin().await.unwrap();
        let tree = insert_file_entry_tree(&tx).await;
        let file = file_entry::ActiveModel {
            is_archive: Set(None),
            archive_file_id: Set(None),
            archive_relative_path: Set(None),
            ..file_entry_row(
                tree.file_id,
                tree.device_id,
                tree.sync_id,
                tree.directory_id,
                &tree.directory_hierarchy_path,
                "app.log",
                r"C:\var\app.log",
                tree.created_at,
            )
        }
        .try_into_model()
        .unwrap();
        let object =
            super::test_support::publish_content(&tx, &file, Uuid::now_v7())
                .await;
        tx.commit().await.unwrap();

        let migrations = wdfiles_migration::Migrator::migrations();
        let reuse_migration_index = migrations
            .iter()
            .position(|migration| {
                migration.name()
                    == "m20260915_212032_reuse_verified_file_content"
            })
            .unwrap();
        let rollback_steps =
            u32::try_from(applied_count - reuse_migration_index).unwrap();
        wdfiles_migration::Migrator::down(connection, Some(rollback_steps))
            .await
            .unwrap();
        wdfiles_migration::Migrator::up(connection, Some(rollback_steps))
            .await
            .unwrap();
        run_migrations(&config, Mode::Debug).await.unwrap();
        assert_file_content_schema(connection).await;
        let content = file_content::Entity::find_by_id((file.id, 1))
            .one(connection)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(content.object_key, object);
        let upload =
            file_content_upload::Entity::find_by_id(content.upload_id.unwrap())
                .one(connection)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(upload.status, FileContentUploadStatus::Completed);
    }
    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn migrate_through(connection: &DatabaseConnection, name: &str) -> usize {
    let count = wdfiles_migration::Migrator::migrations()
        .iter()
        .position(|migration| migration.name() == name)
        .unwrap()
        + 1;
    wdfiles_migration::Migrator::up(connection, Some(count as u32))
        .await
        .unwrap();
    count
}

#[tokio::test]
#[serial_test::serial]
async fn content_migration_rejects_legacy_pointer_without_provenance() {
    let (config, database_url) = isolated_file_registry_config().await;

    {
        let file_registry_db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = file_registry_db.connection();
        let migrations = wdfiles_migration::Migrator::migrations();
        let content_migration_count = migrations
            .iter()
            .position(|migration| {
                migration.name() == "m20260905_160446_device_file_content"
            })
            .unwrap();
        wdfiles_migration::Migrator::up(
            connection,
            Some(u32::try_from(content_migration_count).unwrap()),
        )
        .await
        .unwrap();

        let transaction = connection.begin().await.unwrap();
        let tree = insert_file_entry_tree(&transaction).await;
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update file_entry set content_path = $2 where id = $1",
                vec![tree.file_id.into(), "legacy/device-file-content".into()],
            ))
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let error = wdfiles_migration::Migrator::up(connection, Some(1))
            .await
            .unwrap_err();
        assert!(
            format!("{error:?}").contains(
                "file_entry contains legacy content_path values without file_content provenance"
            ),
            "unexpected migration error: {error:?}"
        );
        assert!(!table_exists(connection, "file_content").await);
        assert!(!table_exists(connection, "file_content_upload").await);
    }

    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn batched_sync_migration_resets_inventory_and_preserves_analytics() {
    let (config, database_url) = isolated_file_registry_config().await;
    let tag_id = Uuid::now_v7();
    let tag_test_file_id = Uuid::now_v7();
    let device_id = Uuid::now_v7();
    let root_id = Uuid::now_v7();
    let file_id = Uuid::now_v7();
    let reanalysis_job_id = Uuid::now_v7();
    let legacy_batch_id = Uuid::now_v7();
    let root_path = uuid_label(root_id);
    let file_path = format!("{root_path}.{}", uuid_label(file_id));

    {
        let file_registry_db = connect_runtime(&config, Mode::Debug)
            .await
            .unwrap()
            .unwrap();
        let connection = file_registry_db.connection();
        let migrations = wdfiles_migration::Migrator::migrations();
        let pre_batched_sync_migration_count = migrations
            .iter()
            .position(|migration| {
                migration.name()
                    == "m20260813_120128_batched_file_metadata_sync"
            })
            .unwrap();
        let batched_sync_migration_count = migrations
            .iter()
            .position(|migration| {
                migration.name()
                    == "m20260815_152642_rename_file_sync_primary_key_columns"
            })
            .unwrap()
            + 1
            - pre_batched_sync_migration_count;
        wdfiles_migration::Migrator::up(
            connection,
            Some(u32::try_from(pre_batched_sync_migration_count).unwrap()),
        )
        .await
        .unwrap();

        connection
            .execute_unprepared(&format!(
                r#"
insert into analytics_tag (id, name, rule_expression)
values ('{tag_id}', 'Migration preservation tag', '{{}}'::jsonb);

insert into analytics_tag_test_file (
    id,
    tag_id,
    position,
    name,
    absolute_path,
    extension
) values (
    '{tag_test_file_id}',
    '{tag_id}',
    0,
    'preserve.log',
    'C:\preserve.log',
    'log'
);

update analytics_tag_rule_set_state
set revision = 17
where id;

create table device_file_sync_batch (
    id uuid primary key,
    device_id uuid not null,
    started_at timestamp with time zone not null default clock_timestamp(),
    completed_at timestamp with time zone,
    updated_at timestamp with time zone not null default clock_timestamp(),
    new_file_count integer not null default 0,
    constraint device_file_sync_batch_new_file_count_check
        check (new_file_count >= 0)
);

create table device_file_sync_batch_entry (
    batch_id uuid not null,
    file_entry_id uuid not null,
    device_id uuid not null,
    analyzed_reported_at timestamp with time zone,
    created_at timestamp with time zone not null default clock_timestamp(),
    constraint device_file_sync_batch_entry_pkey
        primary key (batch_id, file_entry_id),
    constraint device_file_sync_batch_entry_batch_id_fkey
        foreign key (batch_id)
        references device_file_sync_batch(id)
        on delete cascade,
    constraint device_file_sync_batch_entry_file_fk
        foreign key (device_id, file_entry_id)
        references file_entry(device_id, id)
        on delete cascade
);

create function public.device_file_track_analysis_start()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
    perform 1
    from device_file_sync_batch batch
    where batch.device_id = new.device_id
      and batch.completed_at is null;
    return new;
end
$function$;

create trigger device_file_track_analysis_start_trg
    after insert or update of pending on file_analysis_device_state
    for each row
    execute function public.device_file_track_analysis_start();

insert into file_entry (
    id,
    device_id,
    parent_id,
    kind,
    name,
    absolute_path,
    hierarchy_path,
    created_at,
    updated_at
) values (
    '{root_id}',
    '{device_id}',
    null,
    'directory',
    'C:\',
    null,
    '{root_path}'::ltree,
    localtimestamp,
    localtimestamp
);

insert into file_entry (
    id,
    device_id,
    parent_id,
    kind,
    name,
    absolute_path,
    hierarchy_path,
    mime_type,
    extension,
    file_metadata_created_at,
    file_metadata_modified_at,
    created_at,
    updated_at
) values (
    '{file_id}',
    '{device_id}',
    '{root_id}',
    'file',
    'preserve.log',
    'C:\preserve.log',
    '{file_path}'::ltree,
    'text/plain',
    'log',
    localtimestamp,
    localtimestamp,
    localtimestamp,
    localtimestamp
);

insert into device_file_sync_batch (
    id,
    device_id,
    new_file_count
) values (
    '{legacy_batch_id}',
    '{device_id}',
    1
);

insert into device_file_sync_batch_entry (
    batch_id,
    file_entry_id,
    device_id
) values (
    '{legacy_batch_id}',
    '{file_id}',
    '{device_id}'
);

insert into device_file_tag (
    id,
    file_entry_id,
    device_id,
    file_entry_created_at,
    tag_id
) values (
    gen_random_uuid(),
    '{file_id}',
    '{device_id}',
    clock_timestamp(),
    '{tag_id}'
);

insert into file_analysis_reanalysis_job (
    id,
    device_id,
    target_rule_revision,
    generation,
    upper_file_entry_id,
    scheduled_file_count
) values (
    '{reanalysis_job_id}',
    '{device_id}',
    17,
    8,
    '{file_id}',
    1
);

update file_analysis_control
set backfill_cursor = '{file_id}',
    backfill_complete = false,
    next_generation = 9
where id;
"#
            ))
            .await
            .unwrap();

        assert_eq!(table_count(connection, "file_entry").await, 2);
        assert_eq!(table_count(connection, "device_file_tag").await, 1);
        assert_eq!(table_count(connection, "device_file_sync_batch").await, 1);
        assert_eq!(
            table_count(connection, "device_file_sync_batch_entry").await,
            1
        );
        assert_eq!(table_count(connection, "file_analysis_state").await, 1);
        assert_eq!(
            table_count(connection, "file_analysis_reanalysis_job").await,
            1
        );
        assert_eq!(
            table_count(connection, "file_analysis_device_state").await,
            1
        );

        wdfiles_migration::Migrator::up(
            connection,
            Some(u32::try_from(batched_sync_migration_count).unwrap()),
        )
        .await
        .unwrap();
        assert!(!table_exists(connection, "device_file_sync_batch").await);
        assert!(
            !table_exists(connection, "device_file_sync_batch_entry").await
        );
        let legacy_analysis_trigger_exists: bool = connection
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "select to_regprocedure('public.device_file_track_analysis_start()') \
                 is not null as function_exists"
                    .to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "function_exists")
            .unwrap();
        assert!(!legacy_analysis_trigger_exists);

        for table_name in [
            "file_entry",
            "device_file_tag",
            "file_analysis_state",
            "file_analysis_reanalysis_job",
            "file_analysis_device_state",
            "file_sync_session",
            "file_sync_batch",
            "file_sync_item",
            "file_metadata_revision",
        ] {
            assert_eq!(
                table_count(connection, table_name).await,
                0,
                "{table_name} was not reset"
            );
        }

        let preserved_tag_count: i64 = connection
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                format!(
                    "select count(*)::bigint as count from analytics_tag where id = '{tag_id}'"
                ),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "count")
            .unwrap();
        assert_eq!(preserved_tag_count, 1);
        let preserved_test_file_count: i64 = connection
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                format!(
                    "select count(*)::bigint as count from analytics_tag_test_file where id = '{tag_test_file_id}'"
                ),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "count")
            .unwrap();
        assert_eq!(preserved_test_file_count, 1);

        let rule_revision: i64 = connection
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "select revision from analytics_tag_rule_set_state where id"
                    .to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "revision")
            .unwrap();
        assert_eq!(rule_revision, 17);

        let control = connection
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                r#"
select backfill_cursor, backfill_complete, next_generation
from file_analysis_control
where id
"#
                .to_string(),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            control
                .try_get::<Option<Uuid>>("", "backfill_cursor")
                .unwrap(),
            None
        );
        assert!(control.try_get::<bool>("", "backfill_complete").unwrap());
        assert_eq!(control.try_get::<i64>("", "next_generation").unwrap(), 1);
    }

    sqlx::Postgres::drop_database(&database_url).await.unwrap();
}

async fn table_count(connection: &DatabaseConnection, table_name: &str) -> i64 {
    connection
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            format!("select count(*)::bigint as count from {table_name}"),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap()
}

async fn table_exists(
    connection: &DatabaseConnection,
    table_name: &str,
) -> bool {
    connection
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "select to_regclass('public.{table_name}') is not null as table_exists"
            ),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "table_exists")
        .unwrap()
}

async fn isolated_file_registry_config() -> (Config, String) {
    let mut config = crate::config::read_config(Mode::Test).unwrap();
    let file_registry = config.file_registry.as_mut().unwrap();
    file_registry.pg_dbname =
        Some(format!("wd_files_test_schema_{}", Uuid::new_v4().simple()));
    let database_url = crate::mk_wdfile_conn_string(file_registry, Mode::Debug);
    sqlx::Postgres::create_database(&database_url)
        .await
        .unwrap();
    (config, database_url)
}

async fn assert_migration_versions(connection: &DatabaseConnection) {
    let migration_versions = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "select version from seaql_migrations order by version".to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "version").unwrap())
        .collect::<Vec<String>>();

    assert_eq!(
        migration_versions,
        vec![
            "m20260719_174625_create_file_registry_device_file".to_string(),
            "m20260721_124238_create_file_entry".to_string(),
            "m20260721_124518_drop_legacy_device_file".to_string(),
            "m20260728_111013_add_file_entry_journal_index".to_string(),
            "m20260728_182132_add_file_entry_content_path".to_string(),
            "m20260803_164204_file_entry_kind_and_windows_paths".to_string(),
            "m20260806_160450_device_analytics_tags".to_string(),
            "m20260807_125456_analytics_tag_rule_revision".to_string(),
            "m20260807_162040_file_analysis_state".to_string(),
            "m20260808_113748_file_analysis_device_queue".to_string(),
            "m20260808_134904_file_analysis_retry_limit".to_string(),
            "m20260808_134905_analytics_tag_test_expectation".to_string(),
            "m20260810_120000_seed_default_analytics_tags".to_string(),
            "m20260813_120128_batched_file_metadata_sync".to_string(),
            "m20260815_152642_rename_file_sync_primary_key_columns".to_string(),
            "m20260818_094542_batched_file_analysis_runs".to_string(),
            "m20260819_100659_rename_file_metadata_revision_to_file_revision"
                .to_string(),
            "m20260819_103638_optional_source_file_state_settled_by"
                .to_string(),
            "m20260819_103954_update_file_entry_analysis_guard".to_string(),
            "m20260905_160446_device_file_content".to_string(),
            "m20260915_212032_reuse_verified_file_content".to_string(),
            "m20260921_122222_device_sync_session_history".to_string(),
            "m20261003_152726_create_device_audio".to_string(),
            "m20261006_082251_device_documents".to_string(),
            "m20261006_082252_file_history_search".to_string(),
            "m20261007_162050_file_preview".to_string(),
            "m20261008_124822_device_audio_preparation".to_string(),
            "m20261008_183827_file_preview_archive_members".to_string(),
            "m20261010_130006_device_audio_asr".to_string(),
            "m20261012_094502_device_audio_asr_scan_indexes".to_string(),
            "m20261014_182354_device_upload_finalization".to_string(),
            "m20261016_165725_device_audio_transcription_pending".to_string(),
            "m20261016_172538_retire_device_audio_asr_executor".to_string(),
            "m20261017_101924_drop_device_audio_transcription_backfill"
                .to_string(),
            "m20261019_101619_file_archive_registry".to_string(),
            "m20261023_071318_device_audio_forwarding".to_string(),
            "m20261024_090745_device_content_stats".to_string(),
            "m20261024_090746_device_content_stats_pending_index".to_string(),
            "m20261027_092423_failed_finalization_cleanup".to_string(),
            "m20261027_093747_file_finalization_ownership".to_string(),
            "m20261027_112601_synchronous_finalization_adoption".to_string(),
            "m20261028_153759_finalization_terminal_metrics".to_string(),
        ]
    );
}

async fn assert_default_analytics_tags(connection: &DatabaseConnection) {
    let tags = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select id::text as id, name, rule_expression
from analytics_tag
where archived_at is null
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            let name = row.try_get("", "name").unwrap();
            let id = row.try_get("", "id").unwrap();
            let rule_expression = row.try_get("", "rule_expression").unwrap();
            (name, (id, rule_expression))
        })
        .collect::<BTreeMap<String, (String, serde_json::Value)>>();
    let expected = [
        ("Втрати", "019fdb64-4e45-76e2-b1e8-29945f919883"),
        ("Доповіді", "019fdb5c-70d1-72b3-b533-554037355265"),
        ("Озброєння", "019fdb63-23c0-7841-9896-cc3623deb46b"),
        ("Штатки", "019fdb5b-1673-7d23-82ab-b4b05cb119ce"),
        ("Бойові документи", "019fdb5e-e895-70c0-9cd9-fbc02c4d5372"),
        ("Військовий файл", "019fdb68-9ef1-7d51-82a8-a365ddd38e39"),
        ("Карти командира", "019fdaed-f5e0-7a50-ac3f-d31c101b9bf2"),
        ("Плани противника", "019fdb5d-2858-7c31-ad0c-794e9bb3b379"),
        ("Профільні програми", "019feace-8369-7732-aace-2907fdc7540c"),
        ("Робота з радіо", "019fdb62-317c-74c3-ad84-ed794053fce3"),
        ("Маршрути, палітри", "019fdb59-4305-74b0-8c19-50f2bcaacc54"),
        ("Паролі, доступи", "019fdb65-bbc0-7141-aff9-87332813a834"),
    ];

    for (name, expected_id) in expected {
        let (actual_id, rule_expression) =
            tags.get(name).unwrap_or_else(|| {
                panic!("default analytics tag {name:?} is missing")
            });
        assert_eq!(actual_id, expected_id, "unexpected id for tag {name:?}");
        serde_json::from_value::<RuleExpression>(rule_expression.clone())
            .unwrap_or_else(|error| {
                panic!("default analytics tag {name:?} has an invalid rule: {error}")
            });
    }
}

async fn assert_public_extensions(connection: &DatabaseConnection) {
    let extensions = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select extname, extnamespace::regnamespace::text as schema_name
from pg_extension
where extname in ('ltree', 'pg_trgm')
order by extname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "extname").unwrap(),
                row.try_get("", "schema_name").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();

    assert_eq!(
        extensions,
        vec![
            ("ltree".to_string(), "public".to_string()),
            ("pg_trgm".to_string(), "public".to_string()),
        ]
    );
}

async fn assert_legacy_file_table_is_absent(connection: &DatabaseConnection) {
    let legacy_table: Option<String> = connection
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select to_regclass('public.device_file')::text as table_name"
                .to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "table_name")
        .unwrap();

    assert_eq!(legacy_table, None);
}

async fn assert_file_entry_schema(connection: &DatabaseConnection) {
    assert_exact_columns(
        connection,
        "file_entry",
        &[
            ("id", "NO", None, "uuid", "uuid"),
            ("device_id", "NO", None, "uuid", "uuid"),
            ("parent_id", "YES", None, "uuid", "uuid"),
            ("kind", "NO", None, "USER-DEFINED", "file_entry_kind"),
            ("name", "NO", None, "text", "text"),
            ("absolute_path", "YES", None, "text", "text"),
            ("hierarchy_path", "NO", None, "USER-DEFINED", "ltree"),
            ("mime_type", "YES", None, "text", "text"),
            ("extension", "YES", None, "text", "text"),
            (
                "file_metadata_created_at",
                "YES",
                None,
                "timestamp without time zone",
                "timestamp",
            ),
            (
                "file_metadata_modified_at",
                "YES",
                None,
                "timestamp without time zone",
                "timestamp",
            ),
            (
                "created_at",
                "NO",
                None,
                "timestamp without time zone",
                "timestamp",
            ),
            (
                "updated_at",
                "NO",
                None,
                "timestamp without time zone",
                "timestamp",
            ),
            ("content_path", "YES", None, "text", "text"),
            ("revision", "YES", None, "bigint", "int8"),
            ("sync_id", "YES", None, "uuid", "uuid"),
            (
                "source_file_state",
                "YES",
                None,
                "USER-DEFINED",
                "source_file_state_kind",
            ),
            (
                "source_file_state_settled_at",
                "YES",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            ("source_file_state_settled_by", "YES", None, "text", "text"),
            ("analysis_input_revision", "YES", None, "bigint", "int8"),
            ("current_analysis_run_id", "YES", None, "uuid", "uuid"),
            ("is_archive", "YES", None, "boolean", "bool"),
            ("archive_file_id", "YES", None, "uuid", "uuid"),
            ("archive_relative_path", "YES", None, "text", "text"),
        ],
    )
    .await;
    assert_file_entry_constraints(connection).await;
    assert_file_entry_triggers(connection).await;
    assert_file_entry_indexes(connection).await;
}

async fn assert_batched_file_sync_schema(connection: &DatabaseConnection) {
    let table_names = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
      'file_metadata_revision',
      'file_revision',
      'file_sync_batch',
      'file_sync_item',
      'file_sync_session'
  )
order by table_name
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "table_name").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(
        table_names,
        vec![
            "file_revision".to_string(),
            "file_sync_batch".to_string(),
            "file_sync_item".to_string(),
            "file_sync_session".to_string(),
        ]
    );

    assert_column_shapes(
        connection,
        "file_sync_session",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("device_id", "NO", "uuid", "uuid"),
            ("mode", "NO", "USER-DEFINED", "file_sync_session_mode"),
            ("status", "NO", "USER-DEFINED", "file_sync_session_status"),
            ("next_batch_index", "NO", "integer", "int4"),
            ("received_count", "NO", "bigint", "int8"),
            ("accepted_count", "NO", "bigint", "int8"),
            ("created_count", "NO", "bigint", "int8"),
            ("updated_count", "NO", "bigint", "int8"),
            ("rejected_count", "NO", "bigint", "int8"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "updated_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "completed_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "expires_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_sync_batch",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("batch_index", "NO", "integer", "int4"),
            ("status", "NO", "USER-DEFINED", "file_sync_batch_status"),
            ("received_count", "NO", "bigint", "int8"),
            ("accepted_count", "NO", "bigint", "int8"),
            ("created_count", "NO", "bigint", "int8"),
            ("updated_count", "NO", "bigint", "int8"),
            ("rejected_count", "NO", "bigint", "int8"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "applied_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_revision",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("revision", "NO", "bigint", "int8"),
            ("device_id", "NO", "uuid", "uuid"),
            ("sync_id", "NO", "uuid", "uuid"),
            ("name", "NO", "text", "text"),
            ("absolute_path", "YES", "text", "text"),
            ("mime_type", "YES", "text", "text"),
            ("extension", "YES", "text", "text"),
            (
                "file_metadata_created_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "file_metadata_modified_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "source_file_state",
                "YES",
                "USER-DEFINED",
                "source_file_state_kind",
            ),
            (
                "source_file_state_settled_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            ("source_file_state_settled_by", "YES", "text", "text"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
            ("source_sequence", "YES", "bigint", "int8"),
            ("analysis_input_revision", "YES", "bigint", "int8"),
            ("is_archive", "YES", "boolean", "bool"),
            ("origin_archive_id", "YES", "uuid", "uuid"),
            ("archive_member_index", "YES", "bigint", "int8"),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_sync_item",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("batch_index", "NO", "integer", "int4"),
            ("item_index", "NO", "integer", "int4"),
            ("outcome", "YES", "USER-DEFINED", "file_sync_item_outcome"),
            ("file_id", "YES", "uuid", "uuid"),
            ("absolute_path", "NO", "text", "text"),
            ("mime_type", "YES", "text", "text"),
            ("extension", "YES", "text", "text"),
            (
                "file_metadata_created_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "file_metadata_modified_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "source_file_state",
                "YES",
                "USER-DEFINED",
                "source_file_state_kind",
            ),
            (
                "source_file_state_settled_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            ("source_file_state_settled_by", "YES", "text", "text"),
            ("revision", "YES", "bigint", "int8"),
            ("root_id", "YES", "uuid", "uuid"),
            ("error_code", "YES", "text", "text"),
            ("error_message", "YES", "text", "text"),
            ("field_errors", "NO", "jsonb", "jsonb"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;

    let enum_values = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select type.typname, value.enumlabel
from pg_catalog.pg_type as type
join pg_catalog.pg_enum as value on value.enumtypid = type.oid
where type.typname in (
    'file_sync_batch_status',
    'file_sync_item_outcome',
    'file_sync_session_mode',
    'file_sync_session_status',
    'source_file_state_kind'
)
order by type.typname, value.enumsortorder
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "typname").unwrap(),
                row.try_get("", "enumlabel").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        enum_values,
        [
            ("file_sync_batch_status", "processing"),
            ("file_sync_batch_status", "applied"),
            ("file_sync_batch_status", "applied_with_errors"),
            ("file_sync_item_outcome", "created"),
            ("file_sync_item_outcome", "updated"),
            ("file_sync_item_outcome", "rejected"),
            ("file_sync_session_mode", "automatic"),
            ("file_sync_session_mode", "explicit"),
            ("file_sync_session_status", "open"),
            ("file_sync_session_status", "completed"),
            ("file_sync_session_status", "completed_with_errors"),
            ("file_sync_session_status", "expired"),
            ("source_file_state_kind", "scanned"),
            ("source_file_state_kind", "downloaded"),
            ("source_file_state_kind", "changed"),
        ]
        .into_iter()
        .map(|(enum_name, value)| (enum_name.to_string(), value.to_string()))
        .collect::<Vec<_>>()
    );

    assert_eq!(
        constraint_names(connection, "file_sync_session", 'c').await,
        vec![
            "file_sync_session_count_check".to_string(),
            "file_sync_session_expiry_shape_check".to_string(),
            "file_sync_session_nonnegative_check".to_string(),
            "file_sync_session_result_status_check".to_string(),
            "file_sync_session_status_shape_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_sync_batch", 'c').await,
        vec![
            "file_sync_batch_count_check".to_string(),
            "file_sync_batch_nonnegative_check".to_string(),
            "file_sync_batch_result_status_check".to_string(),
            "file_sync_batch_status_shape_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_revision", 'c').await,
        vec![
            "file_metadata_revision_absolute_path_check".to_string(),
            "file_metadata_revision_analysis_check".to_string(),
            "file_metadata_revision_name_check".to_string(),
            "file_metadata_revision_revision_check".to_string(),
            "file_metadata_revision_source_state_check".to_string(),
            "file_revision_archive_member_index_check".to_string(),
            "file_revision_origin_shape_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_revision", 'u').await,
        vec![
            "file_metadata_revision_source_sequence_key".to_string(),
            "file_revision_device_file_revision_key".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_sync_item", 'c').await,
        vec![
            "file_sync_item_field_errors_check".to_string(),
            "file_sync_item_index_check".to_string(),
            "file_sync_item_outcome_shape_check".to_string(),
            "file_sync_item_source_state_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_sync_batch", 'f').await,
        vec!["file_sync_batch_session_fk".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_revision", 'f').await,
        vec![
            "file_metadata_revision_input_fk".to_string(),
            "file_metadata_revision_session_fk".to_string(),
            "file_revision_archive_fk".to_string(),
            "file_revision_device_file_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_sync_item", 'f').await,
        vec![
            "file_sync_item_batch_fk".to_string(),
            "file_sync_item_file_fk".to_string(),
            "file_sync_item_revision_fk".to_string(),
        ]
    );

    let indexes = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select tablename, indexname
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in (
      'file_revision',
      'file_sync_batch',
      'file_sync_item',
      'file_sync_session'
  )
order by tablename, indexname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "tablename").unwrap(),
                row.try_get("", "indexname").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        indexes,
        [
            (
                "file_revision",
                "file_metadata_revision_device_file_source_idx",
            ),
            ("file_revision", "file_metadata_revision_pkey"),
            (
                "file_revision",
                "file_metadata_revision_source_sequence_key",
            ),
            ("file_revision", "file_metadata_revision_sync_file_idx",),
            ("file_revision", "file_revision_archive_member_idx"),
            ("file_revision", "file_revision_archive_snapshot_idx"),
            ("file_revision", "file_revision_device_file_revision_key",),
            ("file_revision", "file_revision_name_trgm_idx"),
            ("file_revision", "file_revision_session_journal_idx"),
            ("file_sync_batch", "file_sync_batch_pkey"),
            ("file_sync_item", "file_sync_item_accepted_path_uidx"),
            ("file_sync_item", "file_sync_item_pkey"),
            ("file_sync_item", "file_sync_item_result_order_idx"),
            ("file_sync_session", "file_sync_session_expiry_idx"),
            ("file_sync_session", "file_sync_session_history_idx"),
            ("file_sync_session", "file_sync_session_open_device_uidx"),
            ("file_sync_session", "file_sync_session_pkey"),
        ]
        .into_iter()
        .map(|(table, index)| (table.to_string(), index.to_string()))
        .collect::<Vec<_>>()
    );

    let revision_triggers = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select tgname
from pg_catalog.pg_trigger
where tgrelid = 'public.file_revision'::regclass
  and not tgisinternal
order by tgname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "tgname").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(
        revision_triggers,
        vec![
            "file_metadata_revision_immutable_trg".to_string(),
            "file_revision_archive_guard".to_string()
        ]
    );
}

async fn assert_file_content_schema(connection: &DatabaseConnection) {
    assert_exact_columns(
        connection,
        "file_content_upload",
        &[
            ("id", "NO", None, "uuid", "uuid"),
            ("device_id", "NO", None, "uuid", "uuid"),
            ("file_id", "NO", None, "uuid", "uuid"),
            ("revision", "NO", None, "bigint", "int8"),
            ("created_by_login_id", "NO", None, "uuid", "uuid"),
            ("upload_length", "NO", None, "bigint", "int8"),
            ("expected_sha256", "NO", None, "bytea", "bytea"),
            ("object_key", "NO", None, "text", "text"),
            (
                "status",
                "NO",
                None,
                "USER-DEFINED",
                "file_content_upload_status",
            ),
            (
                "created_at",
                "NO",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "last_activity_at",
                "NO",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "expires_at",
                "NO",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "hard_expires_at",
                "NO",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "spool_removed_at",
                "YES",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "next_cleanup_at",
                "YES",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            ("stats_epoch", "NO", Some("0"), "bigint", "int8"),
            ("finalization_job_id", "YES", None, "uuid", "uuid"),
        ],
    )
    .await;
    assert_exact_columns(
        connection,
        "file_content",
        &[
            ("file_id", "NO", None, "uuid", "uuid"),
            ("revision", "NO", None, "bigint", "int8"),
            ("upload_id", "YES", None, "uuid", "uuid"),
            ("object_key", "NO", None, "text", "text"),
            ("source_size_bytes", "NO", None, "bigint", "int8"),
            ("source_sha256", "NO", None, "bytea", "bytea"),
            ("is_encrypted", "NO", None, "boolean", "bool"),
            (
                "created_at",
                "NO",
                None,
                "timestamp with time zone",
                "timestamptz",
            ),
            ("origin_archive_id", "YES", None, "uuid", "uuid"),
        ],
    )
    .await;

    let enum_values = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select value.enumlabel
from pg_catalog.pg_type as type
join pg_catalog.pg_enum as value on value.enumtypid = type.oid
where type.typname = 'file_content_upload_status'
order by value.enumsortorder
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "enumlabel").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(
        enum_values,
        [
            "open",
            "completed",
            "aborted",
            "expired",
            "stale",
            "rejected"
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>()
    );

    assert_eq!(
        constraint_names(connection, "file_content_upload", 'c').await,
        vec![
            "file_content_upload_empty_sha256_check".to_string(),
            "file_content_upload_length_check".to_string(),
            "file_content_upload_object_key_check".to_string(),
            "file_content_upload_sha256_check".to_string(),
            "file_content_upload_state_shape_check".to_string(),
            "file_content_upload_time_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_content_upload", 'f').await,
        vec![
            "file_content_upload_finalization_job_id_fkey".to_string(),
            "file_content_upload_target_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_content_upload", 'u').await,
        vec![
            "file_content_upload_binding_key".to_string(),
            "file_content_upload_command_key".to_string(),
            "file_content_upload_object_key_key".to_string(),
            "file_content_upload_source_identity_key".to_string(),
            "file_content_upload_verified_identity_key".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_content", 'c').await,
        vec![
            "file_content_one_origin_check".to_string(),
            "file_content_sha256_check".to_string(),
            "file_content_size_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_content", 'f').await,
        vec![
            "file_content_origin_archive_id_fkey".to_string(),
            "file_content_revision_fk".to_string(),
            "file_content_verified_upload_binding_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_content", 'u').await,
        vec![
            "file_content_archive_source_key".to_string(),
            "file_content_current_pointer_key".to_string(),
        ]
    );

    let foreign_keys = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select conname, pg_get_constraintdef(oid) as definition
from pg_catalog.pg_constraint
where conname in (
    'file_content_revision_fk',
    'file_content_verified_upload_binding_fk',
    'file_content_upload_target_fk',
    'file_content_upload_finalization_job_id_fkey',
    'file_entry_current_content_fk',
    'file_revision_device_file_fk'
)
order by conname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "conname").unwrap(),
                row.try_get("", "definition").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        foreign_keys,
        [
            (
                "file_content_revision_fk",
                "FOREIGN KEY (file_id, revision) REFERENCES file_revision(id, revision) ON DELETE RESTRICT",
            ),
            (
                "file_content_upload_finalization_job_id_fkey",
                "FOREIGN KEY (finalization_job_id) REFERENCES device_upload_finalization_job(id) ON DELETE RESTRICT",
            ),
            (
                "file_content_upload_target_fk",
                "FOREIGN KEY (device_id, file_id, revision) REFERENCES file_revision(device_id, id, revision) ON DELETE RESTRICT",
            ),
            (
                "file_content_verified_upload_binding_fk",
                "FOREIGN KEY (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted) REFERENCES file_content_upload_object(upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted) ON DELETE RESTRICT",
            ),
            (
                "file_entry_current_content_fk",
                "FOREIGN KEY (id, revision, content_path) REFERENCES file_content(file_id, revision, object_key) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
            ),
            (
                "file_revision_device_file_fk",
                "FOREIGN KEY (device_id, id) REFERENCES file_entry(device_id, id) ON DELETE RESTRICT",
            ),
        ]
        .into_iter()
        .map(|(name, definition)| (name.to_string(), definition.to_string()))
        .collect::<Vec<_>>()
    );

    let indexes = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select tablename, indexname
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in ('file_content', 'file_content_upload')
order by tablename, indexname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "tablename").unwrap(),
                row.try_get("", "indexname").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        indexes,
        [
            ("file_content", "file_content_archive_source_key"),
            ("file_content", "file_content_current_pointer_key"),
            ("file_content", "file_content_object_key_idx"),
            ("file_content", "file_content_pkey"),
            ("file_content", "file_content_upload_id_idx"),
            ("file_content_upload", "file_content_upload_binding_key",),
            ("file_content_upload", "file_content_upload_cleanup_idx"),
            ("file_content_upload", "file_content_upload_command_key"),
            ("file_content_upload", "file_content_upload_object_key_key",),
            (
                "file_content_upload",
                "file_content_upload_open_target_uidx",
            ),
            ("file_content_upload", "file_content_upload_pkey"),
            (
                "file_content_upload",
                "file_content_upload_reserved_bytes_idx",
            ),
            (
                "file_content_upload",
                "file_content_upload_reserved_count_idx",
            ),
            (
                "file_content_upload",
                "file_content_upload_source_identity_key"
            ),
            (
                "file_content_upload",
                "file_content_upload_stats_pending_idx",
            ),
            (
                "file_content_upload",
                "file_content_upload_verified_identity_key"
            ),
        ]
        .into_iter()
        .map(|(table, index)| (table.to_string(), index.to_string()))
        .collect::<Vec<_>>()
    );

    let triggers = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select relation.relname as table_name, trigger.tgname as trigger_name
from pg_catalog.pg_trigger as trigger
join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname in ('file_content', 'file_content_upload')
  and not trigger.tgisinternal
order by relation.relname, trigger.tgname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "table_name").unwrap(),
                row.try_get("", "trigger_name").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        triggers,
        [
            ("file_content", "file_content_00_register_object_trg"),
            ("file_content", "file_content_archive_guard"),
            ("file_content", "file_content_immutable_trg"),
            ("file_content", "file_content_verify_reuse_trg"),
            ("file_content", "file_document_content_published"),
            (
                "file_content_upload",
                "file_content_upload_finalization_trg",
            ),
            ("file_content_upload", "file_content_upload_mutation_trg",),
        ]
        .into_iter()
        .map(|(table, trigger)| (table.to_string(), trigger.to_string()))
        .collect::<Vec<_>>()
    );
}

async fn assert_file_analysis_schema(connection: &DatabaseConnection) {
    let table_names = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
      'analytics_tag',
      'analytics_tag_rule_set_state',
      'analytics_tag_test_file',
      'device_file_tag',
      'file_analysis_control',
      'file_analysis_definition',
      'file_analysis_device_state',
      'file_analysis_reanalysis_job',
      'file_analysis_run',
      'file_analysis_run_item',
      'file_analysis_state',
      'file_device_source_state'
  )
order by table_name
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "table_name").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(
        table_names,
        vec![
            "analytics_tag".to_string(),
            "analytics_tag_test_file".to_string(),
            "device_file_tag".to_string(),
            "file_analysis_definition".to_string(),
            "file_analysis_run".to_string(),
            "file_analysis_run_item".to_string(),
            "file_device_source_state".to_string(),
        ]
    );

    assert_column_shapes(
        connection,
        "file_analysis_definition",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("definition_sequence", "NO", "bigint", "int8"),
            ("analyzer_version", "NO", "integer", "int4"),
            ("dsl_version", "NO", "integer", "int4"),
            ("rules", "NO", "jsonb", "jsonb"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_analysis_run",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("run_sequence", "NO", "bigint", "int8"),
            ("device_id", "NO", "uuid", "uuid"),
            ("sync_id", "YES", "uuid", "uuid"),
            ("target_source_sequence", "YES", "bigint", "int8"),
            ("definition_id", "NO", "uuid", "uuid"),
            ("item_count", "NO", "bigint", "int8"),
            ("completed_count", "NO", "bigint", "int8"),
            (
                "created_at",
                "NO",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "prepared_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            (
                "completed_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_analysis_run_item",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("file_id", "NO", "uuid", "uuid"),
            ("metadata_revision", "NO", "bigint", "int8"),
            ("lease_token", "YES", "uuid", "uuid"),
            (
                "lease_expires_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
            ("result_tag_ids", "YES", "ARRAY", "_uuid"),
            (
                "completed_at",
                "YES",
                "timestamp with time zone",
                "timestamptz",
            ),
        ],
    )
    .await;
    assert_column_shapes(
        connection,
        "file_device_source_state",
        &[
            ("id", "NO", "uuid", "uuid"),
            ("last_source_sequence", "NO", "bigint", "int8"),
        ],
    )
    .await;

    assert_eq!(
        constraint_names(connection, "file_analysis_definition", 'c').await,
        vec![
            "file_analysis_definition_rules_check".to_string(),
            "file_analysis_definition_version_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_definition", 'u').await,
        vec!["file_analysis_definition_sequence_key".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_run", 'c').await,
        vec![
            "file_analysis_run_cause_check".to_string(),
            "file_analysis_run_count_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_run", 'f').await,
        vec![
            "file_analysis_run_definition_fk".to_string(),
            "file_analysis_run_sync_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_run", 'u').await,
        vec!["file_analysis_run_sequence_key".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_run_item", 'c').await,
        vec![
            "file_analysis_run_item_lease_check".to_string(),
            "file_analysis_run_item_result_check".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_analysis_run_item", 'f').await,
        vec![
            "file_analysis_run_item_revision_fk".to_string(),
            "file_analysis_run_item_run_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_device_source_state", 'c').await,
        vec!["file_device_source_state_sequence_check".to_string()]
    );

    let link_foreign_keys = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.device_file_tag'::regclass
  and contype = 'f'
order by conname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "conname").unwrap(),
                row.try_get("", "definition").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        link_foreign_keys,
        vec![
            (
                "device_file_tag_file_entry_fk".to_string(),
                "FOREIGN KEY (device_id, file_entry_id) REFERENCES file_entry(device_id, id) ON DELETE CASCADE".to_string(),
            ),
            (
                "device_file_tag_tag_id_fkey".to_string(),
                "FOREIGN KEY (tag_id) REFERENCES analytics_tag(id) ON DELETE CASCADE".to_string(),
            ),
        ]
    );

    let indexes = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select tablename, indexname
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in (
      'file_analysis_definition',
      'file_analysis_run',
      'file_analysis_run_item',
      'file_device_source_state'
  )
order by tablename, indexname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "tablename").unwrap(),
                row.try_get("", "indexname").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        indexes,
        [
            ("file_analysis_definition", "file_analysis_definition_pkey",),
            (
                "file_analysis_definition",
                "file_analysis_definition_sequence_key",
            ),
            ("file_analysis_run", "file_analysis_run_device_sequence_idx"),
            ("file_analysis_run", "file_analysis_run_pkey"),
            ("file_analysis_run", "file_analysis_run_preparing_idx"),
            ("file_analysis_run", "file_analysis_run_running_idx"),
            ("file_analysis_run", "file_analysis_run_sequence_key"),
            ("file_analysis_run", "file_analysis_run_sync_uidx"),
            ("file_analysis_run_item", "file_analysis_run_item_file_idx",),
            (
                "file_analysis_run_item",
                "file_analysis_run_item_pending_idx",
            ),
            ("file_analysis_run_item", "file_analysis_run_item_pkey"),
            ("file_device_source_state", "file_device_source_state_pkey"),
        ]
        .into_iter()
        .map(|(table, index)| (table.to_string(), index.to_string()))
        .collect::<Vec<_>>()
    );

    let triggers = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select relation.relname as table_name, trigger.tgname
from pg_catalog.pg_trigger as trigger
join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname in (
      'analytics_tag',
      'file_analysis_definition',
      'file_analysis_run',
      'file_analysis_run_item'
  )
  and not trigger.tgisinternal
order by relation.relname, trigger.tgname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "table_name").unwrap(),
                row.try_get("", "tgname").unwrap(),
            )
        })
        .collect::<Vec<(String, String)>>();
    assert_eq!(
        triggers,
        [
            ("analytics_tag", "analytics_tag_referenced_delete_guard_trg"),
            (
                "file_analysis_definition",
                "file_analysis_definition_immutable_trg",
            ),
            ("file_analysis_run", "file_analysis_run_mutation_guard_trg"),
            (
                "file_analysis_run_item",
                "file_analysis_run_item_mutation_guard_trg",
            ),
        ]
        .into_iter()
        .map(|(table, trigger)| (table.to_string(), trigger.to_string()))
        .collect::<Vec<_>>()
    );
}

async fn assert_exact_columns(
    connection: &DatabaseConnection,
    table_name: &str,
    expected: &[(&str, &str, Option<&str>, &str, &str)],
) {
    let columns = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                r#"
select column_name, is_nullable, column_default, data_type, udt_name
from information_schema.columns
where table_schema = 'public' and table_name = '{table_name}'
order by ordinal_position
"#
            ),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "column_name").unwrap(),
                row.try_get("", "is_nullable").unwrap(),
                row.try_get("", "column_default").unwrap(),
                row.try_get("", "data_type").unwrap(),
                row.try_get("", "udt_name").unwrap(),
            )
        })
        .collect::<Vec<(String, String, Option<String>, String, String)>>();
    let expected = expected
        .iter()
        .map(|&(name, nullable, default, data_type, udt_name)| {
            (
                name.to_string(),
                nullable.to_string(),
                default.map(str::to_string),
                data_type.to_string(),
                udt_name.to_string(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(columns, expected);
}

async fn assert_column_shapes(
    connection: &DatabaseConnection,
    table_name: &str,
    expected: &[(&str, &str, &str, &str)],
) {
    let columns = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                r#"
select column_name, is_nullable, data_type, udt_name
from information_schema.columns
where table_schema = 'public' and table_name = '{table_name}'
order by ordinal_position
"#
            ),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "column_name").unwrap(),
                row.try_get("", "is_nullable").unwrap(),
                row.try_get("", "data_type").unwrap(),
                row.try_get("", "udt_name").unwrap(),
            )
        })
        .collect::<Vec<(String, String, String, String)>>();
    let expected = expected
        .iter()
        .map(|&(name, nullable, data_type, udt_name)| {
            (
                name.to_string(),
                nullable.to_string(),
                data_type.to_string(),
                udt_name.to_string(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(columns, expected);
}

async fn constraint_names(
    connection: &DatabaseConnection,
    table_name: &str,
    constraint_type: char,
) -> Vec<String> {
    connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            format!(
                "select conname from pg_constraint where conrelid = 'public.{table_name}'::regclass and contype = '{constraint_type}' order by conname"
            ),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "conname").unwrap())
        .collect()
}

async fn assert_file_entry_constraints(connection: &DatabaseConnection) {
    assert_eq!(
        constraint_names(connection, "file_entry", 'p').await,
        vec!["file_entry_pkey".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_entry", 'u').await,
        vec![
            "file_entry_archive_identity_key".to_string(),
            "file_entry_device_id_id_key".to_string()
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_entry", 'f').await,
        vec![
            "file_entry_analysis_input_fk".to_string(),
            "file_entry_archive_parent_fk".to_string(),
            "file_entry_current_analysis_fk".to_string(),
            "file_entry_current_content_fk".to_string(),
            "file_entry_current_revision_fk".to_string(),
            "file_entry_current_session_fk".to_string(),
            "file_entry_parent_fk".to_string(),
        ]
    );
    assert_eq!(
        constraint_names(connection, "file_entry", 'c').await,
        vec![
            "file_entry_absolute_path_length_check".to_string(),
            "file_entry_absolute_path_windows_check".to_string(),
            "file_entry_archive_path_check".to_string(),
            "file_entry_content_revision_check".to_string(),
            "file_entry_directory_content_path_null_check".to_string(),
            "file_entry_directory_metadata_null_check".to_string(),
            "file_entry_extension_check".to_string(),
            "file_entry_mime_type_check".to_string(),
            "file_entry_name_not_empty_check".to_string(),
            "file_entry_row_shape_check".to_string(),
            "file_entry_sync_projection_check".to_string(),
        ]
    );

    let parent_definition: String = connection
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'file_entry_parent_fk'".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "definition")
        .unwrap();
    assert_eq!(
        parent_definition,
        "FOREIGN KEY (device_id, parent_id) REFERENCES file_entry(device_id, id) ON DELETE RESTRICT"
    );
}

async fn assert_file_entry_triggers(connection: &DatabaseConnection) {
    let triggers = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            r#"
select tgname, tgdeferrable, tginitdeferred, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.file_entry'::regclass
  and not tgisinternal
order by tgname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "tgname").unwrap(),
                row.try_get("", "tgdeferrable").unwrap(),
                row.try_get("", "tginitdeferred").unwrap(),
                row.try_get("", "definition").unwrap(),
            )
        })
        .collect::<Vec<(String, bool, bool, String)>>();

    assert_eq!(
        triggers,
        vec![
            (
                "file_entry_archive_guard".to_string(),
                false,
                false,
                "CREATE TRIGGER file_entry_archive_guard BEFORE INSERT OR UPDATE ON public.file_entry FOR EACH ROW EXECUTE FUNCTION file_entry_archive_guard()".to_string(),
            ),
            (
                "file_entry_current_analysis_guard_trg".to_string(),
                true,
                true,
                "CREATE CONSTRAINT TRIGGER file_entry_current_analysis_guard_trg AFTER INSERT OR UPDATE ON public.file_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION file_entry_reject_invalid_current_analysis()".to_string(),
            ),
            (
                "file_entry_hierarchy_trg".to_string(),
                true,
                false,
                "CREATE CONSTRAINT TRIGGER file_entry_hierarchy_trg AFTER INSERT ON public.file_entry DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION file_entry_validate_hierarchy()".to_string(),
            ),
            (
                "file_entry_hierarchy_update_trg".to_string(),
                true,
                false,
                "CREATE CONSTRAINT TRIGGER file_entry_hierarchy_update_trg AFTER UPDATE ON public.file_entry DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (((new.id IS DISTINCT FROM old.id) OR (new.device_id IS DISTINCT FROM old.device_id) OR (new.parent_id IS DISTINCT FROM old.parent_id) OR (new.kind IS DISTINCT FROM old.kind) OR (new.hierarchy_path IS DISTINCT FROM old.hierarchy_path))) EXECUTE FUNCTION file_entry_validate_hierarchy()".to_string(),
            ),
            (
                "file_entry_immutable_update_trg".to_string(),
                false,
                false,
                "CREATE TRIGGER file_entry_immutable_update_trg BEFORE UPDATE ON public.file_entry FOR EACH ROW WHEN (((new.id IS DISTINCT FROM old.id) OR (new.device_id IS DISTINCT FROM old.device_id) OR (new.parent_id IS DISTINCT FROM old.parent_id) OR (new.kind IS DISTINCT FROM old.kind) OR (new.name IS DISTINCT FROM old.name) OR (new.absolute_path IS DISTINCT FROM old.absolute_path) OR (new.hierarchy_path IS DISTINCT FROM old.hierarchy_path))) EXECUTE FUNCTION file_entry_enforce_immutable_update()".to_string(),
            ),
        ]
    );
}

async fn assert_file_entry_indexes(connection: &DatabaseConnection) {
    let indexes = connection
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'file_entry' order by indexname".to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "indexname").unwrap(),
                row.try_get("", "indexdef").unwrap(),
            )
        })
        .collect::<BTreeMap<String, String>>();

    assert_eq!(
        indexes.keys().cloned().collect::<Vec<_>>(),
        vec![
            "file_entry_archive_identity_key".to_string(),
            "file_entry_archive_parent_idx".to_string(),
            "file_entry_children_idx".to_string(),
            "file_entry_device_absolute_path_uidx".to_string(),
            "file_entry_device_id_id_key".to_string(),
            "file_entry_directory_sibling_uidx".to_string(),
            "file_entry_file_extension_idx".to_string(),
            "file_entry_file_mime_idx".to_string(),
            "file_entry_file_modified_idx".to_string(),
            "file_entry_hierarchy_gist_idx".to_string(),
            "file_entry_hierarchy_uidx".to_string(),
            "file_entry_journal_idx".to_string(),
            "file_entry_name_trgm_idx".to_string(),
            "file_entry_pkey".to_string(),
            "file_entry_roots_uidx".to_string(),
            "file_entry_search_order_idx".to_string(),
        ]
    );

    let explicit_indexes = indexes
        .into_iter()
        .filter(|(name, _)| {
            name != "file_entry_device_id_id_key"
                && name != "file_entry_pkey"
                && name != "file_entry_archive_identity_key"
        })
        .collect::<BTreeMap<_, _>>();
    let expected = [
        ("file_entry_archive_parent_idx", "CREATE INDEX file_entry_archive_parent_idx ON public.file_entry USING btree (archive_file_id, parent_id, kind, name, id) WHERE (archive_file_id IS NOT NULL)"),
        (
            "file_entry_children_idx",
            "CREATE INDEX file_entry_children_idx ON public.file_entry USING btree (device_id, parent_id, kind, name, id) WHERE (parent_id IS NOT NULL)",
        ),
        (
            "file_entry_device_absolute_path_uidx",
            "CREATE UNIQUE INDEX file_entry_device_absolute_path_uidx ON public.file_entry USING btree (device_id, absolute_path) WHERE (kind = 'file'::file_entry_kind)",
        ),
        (
            "file_entry_directory_sibling_uidx",
            "CREATE UNIQUE INDEX file_entry_directory_sibling_uidx ON public.file_entry USING btree (device_id, parent_id, name) WHERE ((kind = 'directory'::file_entry_kind) AND (parent_id IS NOT NULL))",
        ),
        (
            "file_entry_file_extension_idx",
            "CREATE INDEX file_entry_file_extension_idx ON public.file_entry USING btree (device_id, extension, id) WHERE ((kind = 'file'::file_entry_kind) AND (extension IS NOT NULL))",
        ),
        (
            "file_entry_file_mime_idx",
            "CREATE INDEX file_entry_file_mime_idx ON public.file_entry USING btree (device_id, mime_type, id) WHERE ((kind = 'file'::file_entry_kind) AND (mime_type IS NOT NULL))",
        ),
        (
            "file_entry_file_modified_idx",
            "CREATE INDEX file_entry_file_modified_idx ON public.file_entry USING btree (device_id, file_metadata_modified_at, id) WHERE ((kind = 'file'::file_entry_kind) AND (file_metadata_modified_at IS NOT NULL))",
        ),
        (
            "file_entry_journal_idx",
            "CREATE INDEX file_entry_journal_idx ON public.file_entry USING btree (device_id, updated_at DESC, id DESC) WHERE (kind = 'file'::file_entry_kind)",
        ),
        (
            "file_entry_hierarchy_gist_idx",
            "CREATE INDEX file_entry_hierarchy_gist_idx ON public.file_entry USING gist (hierarchy_path)",
        ),
        (
            "file_entry_hierarchy_uidx",
            "CREATE UNIQUE INDEX file_entry_hierarchy_uidx ON public.file_entry USING btree (device_id, hierarchy_path)",
        ),
        (
            "file_entry_name_trgm_idx",
            "CREATE INDEX file_entry_name_trgm_idx ON public.file_entry USING gin (name gin_trgm_ops) WHERE (parent_id IS NOT NULL)",
        ),
        (
            "file_entry_roots_uidx",
            "CREATE UNIQUE INDEX file_entry_roots_uidx ON public.file_entry USING btree (device_id, name) WHERE (parent_id IS NULL)",
        ),
        (
            "file_entry_search_order_idx",
            "CREATE INDEX file_entry_search_order_idx ON public.file_entry USING btree (device_id, kind, name, id) WHERE (parent_id IS NOT NULL)",
        ),
    ]
    .into_iter()
    .map(|(name, definition)| (name.to_string(), definition.to_string()))
    .collect::<BTreeMap<_, _>>();

    assert_eq!(explicit_indexes, expected);
}

struct FileEntryTree {
    device_id: Uuid,
    sync_id: Uuid,
    root_id: Uuid,
    directory_id: Uuid,
    file_id: Uuid,
    root_hierarchy_path: String,
    directory_hierarchy_path: String,
    file_hierarchy_path: String,
    created_at: NaiveDateTime,
}

async fn insert_sync_session(
    transaction: &DatabaseTransaction,
    sync_id: Uuid,
    device_id: Uuid,
    created_at: NaiveDateTime,
) {
    let created_at = created_at.and_utc().fixed_offset();
    file_sync_session::ActiveModel {
        id: Set(sync_id),
        device_id: Set(device_id),
        mode: Set(FileSyncSessionMode::Automatic),
        status: Set(FileSyncSessionStatus::Open),
        next_batch_index: Set(0),
        received_count: Set(0),
        accepted_count: Set(0),
        created_count: Set(0),
        updated_count: Set(0),
        rejected_count: Set(0),
        created_at: Set(created_at),
        updated_at: Set(created_at),
        completed_at: Set(None),
        expires_at: Set(None),
    }
    .insert(transaction)
    .await
    .unwrap();
}

async fn insert_file_revision(
    transaction: &DatabaseTransaction,
    file_id: Uuid,
    device_id: Uuid,
    sync_id: Uuid,
    source_sequence: i64,
    name: &str,
    absolute_path: &str,
    created_at: NaiveDateTime,
) {
    let created_at_tz = created_at.and_utc().fixed_offset();
    file_revision::Entity::insert(file_revision::ActiveModel {
        is_archive: sea_orm::ActiveValue::NotSet,
        archive_member_index: sea_orm::ActiveValue::NotSet,
        origin_archive_id: sea_orm::ActiveValue::NotSet,
        id: Set(file_id),
        revision: Set(1),
        device_id: Set(device_id),
        sync_id: Set(sync_id),
        source_sequence: Set(Some(source_sequence)),
        analysis_input_revision: Set(Some(1)),
        name: Set(name.to_string()),
        absolute_path: Set(Some(absolute_path.to_string())),
        mime_type: Set(Some("text/plain".to_string())),
        extension: Set(Some("log".to_string())),
        file_metadata_created_at: Set(Some(
            (created_at - Duration::hours(2)).and_utc().fixed_offset(),
        )),
        file_metadata_modified_at: Set(Some(
            (created_at - Duration::hours(1)).and_utc().fixed_offset(),
        )),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
        created_at: Set(created_at_tz),
    })
    .exec_without_returning(transaction)
    .await
    .unwrap();
}

async fn assert_file_entry_entity_round_trip(connection: &DatabaseConnection) {
    let transaction = connection.begin().await.unwrap();
    let tree = insert_file_entry_tree(&transaction).await;

    let fetched = file_entry::Entity::find_by_id(tree.file_id)
        .one(&transaction)
        .await
        .unwrap()
        .unwrap();
    let hierarchy_path: String = fetched.hierarchy_path;
    assert_eq!(hierarchy_path, tree.file_hierarchy_path);

    let second_file_id = Uuid::new_v4();
    let second_file = file_entry_row(
        second_file_id,
        tree.device_id,
        tree.sync_id,
        tree.directory_id,
        &tree.directory_hierarchy_path,
        "app.log",
        r"C:\var\copy.log",
        tree.created_at,
    );
    let second_file = second_file.insert(&transaction).await.unwrap();
    insert_file_revision(
        &transaction,
        second_file_id,
        tree.device_id,
        tree.sync_id,
        2,
        "app.log",
        r"C:\var\copy.log",
        tree.created_at,
    )
    .await;
    let content_path = super::test_support::publish_content(
        &transaction,
        &second_file,
        Uuid::now_v7(),
    )
    .await;
    let content = file_content::Entity::find_by_id((second_file_id, 1))
        .one(&transaction)
        .await
        .unwrap()
        .unwrap();
    let upload =
        file_content_upload::Entity::find_by_id(content.upload_id.unwrap())
            .one(&transaction)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(content.object_key, content_path);
    assert_eq!(content.source_size_bytes, 1);
    assert_eq!(content.source_sha256, vec![1_u8; 32]);
    assert!(content.is_encrypted);
    assert_eq!(upload.status, FileContentUploadStatus::Completed);
    transaction
        .execute_unprepared("set constraints all immediate")
        .await
        .unwrap();
    let second_file = file_entry::Entity::find_by_id(second_file_id)
        .one(&transaction)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second_file.id, second_file_id);
    assert_eq!(second_file.kind, FileEntryKind::File);
    assert_eq!(second_file.name, "app.log");
    assert_eq!(
        second_file.absolute_path.as_deref(),
        Some(r"C:\var\copy.log")
    );
    assert_eq!(
        second_file.content_path.as_deref(),
        Some(content_path.as_str())
    );

    assert_file_entry_rejections(&transaction, &tree).await;

    transaction.rollback().await.unwrap();
    for id in [
        tree.root_id,
        tree.directory_id,
        tree.file_id,
        second_file_id,
    ] {
        assert!(
            file_entry::Entity::find_by_id(id)
                .one(connection)
                .await
                .unwrap()
                .is_none(),
            "rolled-back file entry {id} still exists"
        );
    }
}

async fn insert_file_entry_tree(
    transaction: &DatabaseTransaction,
) -> FileEntryTree {
    let device_id = Uuid::new_v4();
    let root_id = Uuid::new_v4();
    let directory_id = Uuid::new_v4();
    let file_id = Uuid::new_v4();
    let sync_id = Uuid::now_v7();
    let created_at = Utc::now().naive_utc();
    let root_hierarchy_path = uuid_label(root_id);
    let directory_hierarchy_path =
        format!("{root_hierarchy_path}.{}", uuid_label(directory_id));
    let file_hierarchy_path =
        format!("{directory_hierarchy_path}.{}", uuid_label(file_id));
    insert_sync_session(transaction, sync_id, device_id, created_at).await;

    file_entry::Entity::insert(root_entry(root_id, device_id, created_at))
        .exec_without_returning(transaction)
        .await
        .unwrap();
    file_entry::Entity::insert(directory_entry(
        directory_id,
        device_id,
        root_id,
        &root_hierarchy_path,
        "var",
        created_at,
    ))
    .exec_without_returning(transaction)
    .await
    .unwrap();
    file_entry::Entity::insert(file_entry_row(
        file_id,
        device_id,
        sync_id,
        directory_id,
        &directory_hierarchy_path,
        "app.log",
        r"C:\var\app.log",
        created_at,
    ))
    .exec_without_returning(transaction)
    .await
    .unwrap();
    insert_file_revision(
        transaction,
        file_id,
        device_id,
        sync_id,
        1,
        "app.log",
        r"C:\var\app.log",
        created_at,
    )
    .await;

    FileEntryTree {
        sync_id,
        device_id,
        root_id,
        directory_id,
        file_id,
        root_hierarchy_path,
        directory_hierarchy_path,
        file_hierarchy_path,
        created_at,
    }
}

async fn assert_file_entry_rejections(
    transaction: &DatabaseTransaction,
    tree: &FileEntryTree,
) {
    assert_file_entry_operation_rejected(
        transaction,
        root_entry(Uuid::new_v4(), tree.device_id, tree.created_at)
            .insert(transaction),
    )
    .await;

    assert_file_entry_operation_rejected(
        transaction,
        directory_entry(
            Uuid::new_v4(),
            tree.device_id,
            tree.root_id,
            &tree.root_hierarchy_path,
            "var",
            tree.created_at,
        )
        .insert(transaction),
    )
    .await;

    let orphan_id = Uuid::new_v4();
    assert_file_entry_operation_rejected(
        transaction,
        base_file_entry(
            orphan_id,
            tree.device_id,
            None,
            FileEntryKind::File,
            "orphan.log",
            Some(r"C:\orphan.log"),
            uuid_label(orphan_id),
            tree.created_at,
        )
        .insert(transaction),
    )
    .await;

    assert_file_entry_operation_rejected(
        transaction,
        file_entry_row(
            Uuid::new_v4(),
            tree.device_id,
            tree.sync_id,
            tree.file_id,
            &tree.file_hierarchy_path,
            "nested.log",
            r"C:\var\app.log\nested.log",
            tree.created_at,
        )
        .insert(transaction),
    )
    .await;

    assert_file_entry_operation_rejected(
        transaction,
        directory_entry(
            Uuid::new_v4(),
            Uuid::new_v4(),
            tree.root_id,
            &tree.root_hierarchy_path,
            "cross-device",
            tree.created_at,
        )
        .insert(transaction),
    )
    .await;

    let wrong_hierarchy_id = Uuid::new_v4();
    let mut wrong_hierarchy = directory_entry(
        wrong_hierarchy_id,
        tree.device_id,
        tree.root_id,
        &tree.root_hierarchy_path,
        "wrong-hierarchy",
        tree.created_at,
    );
    wrong_hierarchy.hierarchy_path = Set(uuid_label(wrong_hierarchy_id));
    assert_file_entry_operation_rejected(
        transaction,
        wrong_hierarchy.insert(transaction),
    )
    .await;

    let mut directory_metadata = directory_entry(
        Uuid::new_v4(),
        tree.device_id,
        tree.root_id,
        &tree.root_hierarchy_path,
        "metadata-directory",
        tree.created_at,
    );
    directory_metadata.mime_type =
        Set(Some("application/octet-stream".to_string()));
    assert_file_entry_operation_rejected(
        transaction,
        directory_metadata.insert(transaction),
    )
    .await;

    let mut directory_content = directory_entry(
        Uuid::new_v4(),
        tree.device_id,
        tree.root_id,
        &tree.root_hierarchy_path,
        "content-directory",
        tree.created_at,
    );
    directory_content.content_path =
        Set(Some("devices/018f0000/directory".to_string()));
    assert_file_entry_operation_rejected(
        transaction,
        directory_content.insert(transaction),
    )
    .await;

    let invalid_absolute_path = file_entry_row(
        Uuid::new_v4(),
        tree.device_id,
        tree.sync_id,
        tree.root_id,
        &tree.directory_hierarchy_path,
        "invalid-absolute-path.log",
        "/var/invalid-absolute-path.log",
        tree.created_at,
    );
    assert_file_entry_operation_rejected(
        transaction,
        invalid_absolute_path.insert(transaction),
    )
    .await;

    let root = file_entry::Entity::find_by_id(tree.root_id)
        .one(transaction)
        .await
        .unwrap()
        .unwrap();
    let mut structural_directory_update = root.into_active_model();
    structural_directory_update.name = Set("renamed-root".to_string());
    assert_file_entry_operation_rejected(
        transaction,
        structural_directory_update.update(transaction),
    )
    .await;
}

async fn assert_file_entry_operation_rejected<T, Operation>(
    transaction: &DatabaseTransaction,
    operation: Operation,
) where
    Operation: Future<Output = Result<T, DbErr>>,
{
    transaction
        .execute_unprepared("savepoint file_entry_rejection")
        .await
        .unwrap();
    let error = match operation.await {
        Err(error) => error,
        Ok(_) => panic!("file_entry operation unexpectedly succeeded"),
    };
    assert!(
        ["23503", "23505", "23514", "P0001"]
            .iter()
            .any(|code| has_postgres_error_code(&error, code)),
        "expected constraint or trigger rejection, got {error:?}"
    );
    transaction
        .execute_unprepared("rollback to savepoint file_entry_rejection")
        .await
        .unwrap();
    transaction
        .execute_unprepared("release savepoint file_entry_rejection")
        .await
        .unwrap();
}

fn root_entry(
    id: Uuid,
    device_id: Uuid,
    created_at: NaiveDateTime,
) -> file_entry::ActiveModel {
    base_file_entry(
        id,
        device_id,
        None,
        FileEntryKind::Directory,
        r"C:\",
        None,
        uuid_label(id),
        created_at,
    )
}
fn directory_entry(
    id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    parent_hierarchy_path: &str,
    name: &str,
    created_at: NaiveDateTime,
) -> file_entry::ActiveModel {
    base_file_entry(
        id,
        device_id,
        Some(parent_id),
        FileEntryKind::Directory,
        name,
        None,
        format!("{parent_hierarchy_path}.{}", uuid_label(id)),
        created_at,
    )
}

fn file_entry_row(
    id: Uuid,
    device_id: Uuid,
    sync_id: Uuid,
    parent_id: Uuid,
    parent_hierarchy_path: &str,
    name: &str,
    absolute_path: &str,
    created_at: NaiveDateTime,
) -> file_entry::ActiveModel {
    let mut entry = base_file_entry(
        id,
        device_id,
        Some(parent_id),
        FileEntryKind::File,
        name,
        Some(absolute_path),
        format!("{parent_hierarchy_path}.{}", uuid_label(id)),
        created_at,
    );
    entry.mime_type = Set(Some("text/plain".to_string()));
    entry.extension = Set(Some("log".to_string()));
    entry.file_metadata_created_at = Set(Some(created_at - Duration::hours(2)));
    entry.file_metadata_modified_at =
        Set(Some(created_at - Duration::hours(1)));
    entry.revision = Set(Some(1));
    entry.sync_id = Set(Some(sync_id));
    entry.analysis_input_revision = Set(Some(1));
    entry.current_analysis_run_id = Set(None);
    entry
}

fn base_file_entry(
    id: Uuid,
    device_id: Uuid,
    parent_id: Option<Uuid>,
    kind: FileEntryKind,
    name: &str,
    absolute_path: Option<&str>,
    hierarchy_path: String,
    created_at: NaiveDateTime,
) -> file_entry::ActiveModel {
    file_entry::ActiveModel {
        is_archive: sea_orm::ActiveValue::NotSet,
        archive_relative_path: sea_orm::ActiveValue::NotSet,
        archive_file_id: sea_orm::ActiveValue::NotSet,
        id: Set(id),
        device_id: Set(device_id),
        parent_id: Set(parent_id),
        kind: Set(kind),
        name: Set(name.to_string()),
        absolute_path: Set(absolute_path.map(str::to_string)),
        hierarchy_path: Set(hierarchy_path),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(created_at),
        updated_at: Set(created_at),
        content_path: Set(None),
        revision: Set(None),
        sync_id: Set(None),
        analysis_input_revision: Set(None),
        current_analysis_run_id: Set(None),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
    }
}

fn uuid_label(id: Uuid) -> String {
    format!("n{}", id.to_string().replace('-', ""))
}

mod async_finalization_migration {
    use super::super::entities::device_upload_finalization_job;
    use super::*;

    const VERSION: &str = "m20261014_182354_device_upload_finalization";
    const ADOPTION_VERSION: &str =
        "m20261027_112601_synchronous_finalization_adoption";

    #[tokio::test]
    #[serial_test::serial]
    async fn preserves_publications_and_canonical_sync_writers() {
        let (config, database_url) = isolated_file_registry_config().await;
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            migrate_before_finalization(connection).await;
            let transaction = connection.begin().await.unwrap();
            let original = publish_original(&transaction).await;
            reuse_original(&transaction, &original).await;
            insert_legacy_audio(&transaction).await;
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;

            run_migrations(&config, Mode::Debug).await.unwrap();
            run_migrations(&config, Mode::Debug).await.unwrap();

            assert!(
                table_exists(connection, "file_content_upload_object").await,
                "async finalization migration must register selected objects"
            );
            assert_eq!(publication_snapshot(connection).await, before);
            assert_eq!(table_count(connection, "file_content").await, 2);
            assert_eq!(
                table_count(connection, "file_content_upload_object").await,
                1
            );
            assert_eq!(
                table_count(connection, "device_upload_finalization_job").await,
                0
            );
            assert_eq!(
                table_count(connection, "device_upload_finalization_attempt")
                    .await,
                0
            );
            assert_selected_object(connection, &original).await;
            assert_selected_object_immutable(connection, &original).await;

            let transaction = connection.begin().await.unwrap();
            let old_writer = publish_original(&transaction).await;
            transaction.commit().await.unwrap();
            assert_selected_object(connection, &old_writer).await;
            assert_eq!(
                table_count(connection, "file_content_upload_object").await,
                2
            );
            assert_migration_versions(connection).await;

            downgrade_finalization(connection).await.unwrap();
            assert!(
                !table_exists(connection, "file_content_upload_object").await
            );
            assert_eq!(table_count(connection, "file_content").await, 3);
            assert_eq!(table_count(connection, "device_audio").await, 1);
            wdfiles_migration::Migrator::up(connection, None)
                .await
                .unwrap();
            assert_selected_object(connection, &original).await;
            assert_selected_object(connection, &old_writer).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn preserves_archive_publications_across_finalization_migration() {
        use crate::file_registry::test_support::{
            ARCHIVE_PUBLICATION_SQL, ARCHIVE_SOURCE_SQL,
        };

        let (config, database_url) = isolated_file_registry_config().await;
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            migrate_before_finalization(connection).await;
            let transaction = connection.begin().await.unwrap();
            transaction
                .execute_unprepared(ARCHIVE_SOURCE_SQL)
                .await
                .unwrap();
            transaction.execute_unprepared(
                "insert into file_archive(id,device_id,source_file_id,source_revision,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,root_id,depth,policy) select '00000000-0000-0000-0000-000000000101',r.device_id,r.id,r.revision,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,'00000000-0000-0000-0000-000000000101',1,'{}' from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.revision=1",
            ).await.unwrap();
            transaction
                .execute_unprepared(ARCHIVE_PUBLICATION_SQL)
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;
            run_migrations(&config, Mode::Debug).await.unwrap();
            assert_eq!(publication_snapshot(connection).await, before);
            assert_eq!(table_count(connection, "file_content").await, 4);
            assert_eq!(
                table_count(connection, "file_content_upload_object").await,
                1
            );
            downgrade_finalization(connection).await.unwrap();
            assert_eq!(publication_snapshot(connection).await, before);
            run_migrations(&config, Mode::Debug).await.unwrap();
            assert_eq!(publication_snapshot(connection).await, before);
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfills_accepted_file_job_ownership() {
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
                    migration.name().ends_with("_file_finalization_ownership")
                })
                .unwrap();
            wdfiles_migration::Migrator::up(
                connection,
                Some(u32::try_from(prior).unwrap()),
            )
            .await
            .unwrap();
            let transaction = connection.begin().await.unwrap();
            let upload = insert_open_upload(&transaction).await;
            let job_id = Uuid::new_v4();
            transaction
                .execute_raw(file_job_statement(&upload, job_id, "{}"))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;
            wdfiles_migration::Migrator::up(connection, None)
                .await
                .unwrap();
            let row = connection.query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select finalization_job_id from file_content_upload where id=$1",
                [upload.id.into()],
            )).await.unwrap().unwrap();
            assert_eq!(
                row.try_get::<Option<Uuid>>("", "finalization_job_id")
                    .unwrap(),
                Some(job_id)
            );
            assert_eq!(publication_snapshot(connection).await, before);
            assert_migration_versions(connection).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn phase6_adoption_preserves_populated_legacy_cleanup() {
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
                .position(|migration| migration.name() == ADOPTION_VERSION)
                .unwrap();
            wdfiles_migration::Migrator::up(
                connection,
                Some(u32::try_from(prior).unwrap()),
            )
            .await
            .unwrap();
            let transaction = connection.begin().await.unwrap();
            let original = publish_original(&transaction).await;
            reuse_original(&transaction, &original).await;
            insert_legacy_audio(&transaction).await;
            let pending = insert_open_upload(&transaction).await;
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;
            let upload = file_content_upload::Entity::find_by_id(
                original.upload_id.unwrap(),
            )
            .one(connection)
            .await
            .unwrap()
            .unwrap();
            assert!(upload.spool_removed_at.is_none());
            assert!(upload.next_cleanup_at.is_some());
            assert!(upload.finalization_job_id.is_none());

            wdfiles_migration::Migrator::up(connection, None)
                .await
                .unwrap();
            let job_id = Uuid::new_v4();
            connection
                .execute_raw(synchronous_adoption_statement(
                    &upload,
                    job_id,
                    serde_json::json!({}),
                ))
                .await
                .unwrap();
            let pending_job_id = Uuid::new_v4();
            connection
                .execute_raw(file_job_statement(&pending, pending_job_id, "{}"))
                .await
                .unwrap();
            assert_eq!(publication_snapshot(connection).await, before);
            assert_eq!(
                file_content_upload::Entity::find_by_id(upload.id)
                    .one(connection)
                    .await
                    .unwrap()
                    .unwrap(),
                upload
            );
            assert_eq!(
                file_content_upload::Entity::find_by_id(pending.id)
                    .one(connection)
                    .await
                    .unwrap()
                    .unwrap()
                    .finalization_job_id,
                Some(pending_job_id)
            );
            let cleanup = connection.query_all_raw(Statement::from_string(
                DbBackend::Postgres,
                "select id from file_content_upload where next_cleanup_at <= now() and finalization_job_id is null order by next_cleanup_at, id".to_string(),
            )).await.unwrap();
            assert_eq!(
                cleanup
                    .into_iter()
                    .map(|row| row.try_get::<Uuid>("", "id").unwrap())
                    .collect::<Vec<_>>(),
                vec![upload.id]
            );
            assert_selected_object(connection, &original).await;
            assert_eq!(
                table_count(connection, "device_upload_finalization_attempt")
                    .await,
                0
            );
            assert_migration_versions(connection).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn phase6_rejects_forged_synchronous_adoption() {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            let transaction = connection.begin().await.unwrap();
            let original = publish_original(&transaction).await;
            let upload = file_content_upload::Entity::find_by_id(
                original.upload_id.unwrap(),
            )
            .one(&transaction)
            .await
            .unwrap()
            .unwrap();
            for overrides in [
                serde_json::json!({"attempt_count": 1}),
                serde_json::json!({"lease_epoch": 1}),
                serde_json::json!({"quota_released_at": null}),
                serde_json::json!({"source_release_state": "held", "source_released_at": null, "quota_released_at": null}),
                serde_json::json!({"source_release_state": "release_pending", "source_released_at": null, "quota_released_at": null}),
            ] {
                reject_synchronous_adoption(&transaction, &upload, overrides)
                    .await;
            }
            let impostor_id = Uuid::new_v4();
            let mut impostor = upload.clone().into_active_model();
            impostor.id = Set(impostor_id);
            impostor.object_key = Set(format!(
                "device-file-content/{}/{}/1/{impostor_id}",
                upload.device_id, upload.file_id
            ));
            impostor.status = Set(FileContentUploadStatus::Open);
            impostor.next_cleanup_at = Set(Some(upload.expires_at));
            let impostor = impostor.insert(&transaction).await.unwrap();
            reject_synchronous_adoption(
                &transaction,
                &impostor,
                serde_json::json!({}),
            )
            .await;
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update file_content_upload set status = 'completed', next_cleanup_at = clock_timestamp() where id = $1",
                [impostor.id.into()],
            )).await.unwrap();
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "insert into file_content_upload_object (upload_id, file_id, object_key, source_size_bytes, source_sha256, is_encrypted) select id, file_id, object_key, upload_length, expected_sha256, true from file_content_upload where id = $1",
                [impostor.id.into()],
            )).await.unwrap();
            reject_synchronous_adoption(
                &transaction,
                &impostor,
                serde_json::json!({}),
            )
            .await;
            transaction
                .execute_raw(synchronous_adoption_statement(
                    &upload,
                    Uuid::new_v4(),
                    serde_json::json!({}),
                ))
                .await
                .unwrap();
            transaction.rollback().await.unwrap();
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn phase6_refuses_downgrade_with_synchronous_adoption_history() {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            let transaction = connection.begin().await.unwrap();
            let original = publish_original(&transaction).await;
            let upload = file_content_upload::Entity::find_by_id(
                original.upload_id.unwrap(),
            )
            .one(&transaction)
            .await
            .unwrap()
            .unwrap();
            let job_id = Uuid::new_v4();
            transaction
                .execute_raw(synchronous_adoption_statement(
                    &upload,
                    job_id,
                    serde_json::json!({}),
                ))
                .await
                .unwrap();
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;
            let job_before =
                device_upload_finalization_job::Entity::find_by_id(job_id)
                    .one(connection)
                    .await
                    .unwrap()
                    .unwrap();
            let migrations = wdfiles_migration::Migrator::migrations();
            let index = migrations
                .iter()
                .position(|migration| migration.name() == ADOPTION_VERSION)
                .unwrap();
            let transaction = connection.begin().await.unwrap();
            let error = wdfiles_migration::Migrator::down(
                &transaction,
                Some(u32::try_from(migrations.len() - index).unwrap()),
            )
            .await
            .unwrap_err();
            transaction.rollback().await.unwrap();
            assert!(
                format!("{error:?}").contains(
                    "cannot downgrade with retained finalization history"
                ),
                "unexpected downgrade error: {error:?}"
            );
            assert_eq!(publication_snapshot(connection).await, before);
            assert_eq!(
                device_upload_finalization_job::Entity::find_by_id(job_id)
                    .one(connection)
                    .await
                    .unwrap()
                    .unwrap(),
                job_before
            );
            assert_migration_versions(connection).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    fn synchronous_adoption_statement(
        upload: &file_content_upload::Model,
        job_id: Uuid,
        overrides: serde_json::Value,
    ) -> Statement {
        let now = Utc::now();
        let mut terminal = serde_json::json!({
            "status": "completed", "finished_at": now,
            "created_at": now, "updated_at": now, "next_run_at": now,
            "result": {"version": 1, "value": {
                "upload_id": upload.id, "file_id": upload.file_id,
                "revision": 1, "status": "completed",
            }},
            "source_release_state": "released",
            "source_released_at": now, "quota_released_at": now,
        });
        terminal
            .as_object_mut()
            .unwrap()
            .extend(overrides.as_object().unwrap().clone());
        file_job_statement(upload, job_id, &terminal.to_string())
    }

    async fn reject_synchronous_adoption(
        transaction: &DatabaseTransaction,
        upload: &file_content_upload::Model,
        overrides: serde_json::Value,
    ) {
        let error = reject(
            transaction,
            synchronous_adoption_statement(upload, Uuid::new_v4(), overrides),
        )
        .await;
        assert!(has_postgres_error_code(&error, "P0001"), "{error:?}");
        assert!(
            format!("{error:?}").contains(
                "synchronous adoption requires original completed publication"
            ),
            "{error:?}"
        );
    }

    async fn migrate_before_finalization(connection: &DatabaseConnection) {
        let migrations = wdfiles_migration::Migrator::migrations();
        let prior = migrations
            .iter()
            .position(|migration| migration.name() == VERSION)
            .unwrap_or(migrations.len());
        wdfiles_migration::Migrator::up(
            connection,
            Some(u32::try_from(prior).unwrap()),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_invalid_commands_and_attempt_bindings() {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            assert!(
                table_exists(connection, "device_upload_finalization_job")
                    .await
            );
            let transaction = connection.begin().await.unwrap();
            transaction.execute_unprepared(r#"
DO $test$
DECLARE
  job_id uuid := gen_random_uuid();
  device uuid := gen_random_uuid();
  rejected boolean := false;
BEGIN
  insert into device_upload_finalization_job(id,kind,source_identity,created_by_login_id,device_id,audio_id,audio_name,audio_name_key,recording_started_at,upload_url,source_size_bytes,source_locator,pin_token,status,lease_epoch,error_code,error_message,error_action)
  values(job_id,'audio',device::text||'/'||job_id::text,gen_random_uuid(),device,job_id,'test',convert_to('test','UTF8'),now(),'/api/device/audio/'||device::text||'/uploads/'||job_id::text||'.64',64,'audio/'||job_id::text,gen_random_uuid(),'outcome_unknown',1,'storage_outcome_unknown','Unknown','retry_poll');
  BEGIN
    insert into device_upload_finalization_attempt(id,job_id,kind,ordinal,lease_epoch,device_id,audio_id,object_key,is_encrypted,source_size_bytes)
    values(job_id,job_id,'audio',1,1,device,job_id,'device-audio/'||device::text||'/'||job_id::text||'/'||job_id::text,false,64);
  EXCEPTION WHEN raise_exception THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'REGRESSION: attempt accepted without a live lease'; END IF;
END $test$;
"#).await.unwrap();
            let upload = insert_open_upload(&transaction).await;
            let job_id = Uuid::new_v4();
            for overrides in [
                r#"{"kind":"unknown"}"#,
                r#"{"kind":"audio"}"#,
                r#"{"source_identity":"not-the-upload"}"#,
                r#"{"created_by_login_id":"00000000-0000-0000-0000-000000000001"}"#,
                r#"{"device_id":"00000000-0000-0000-0000-000000000001"}"#,
                r#"{"file_upload_id":null}"#,
                r#"{"file_id":null}"#,
                r#"{"revision":2}"#,
                r#"{"source_size_bytes":2}"#,
                r#"{"audio_id":"00000000-0000-0000-0000-000000000001"}"#,
                r#"{"source_locator":"../outside"}"#,
                r#"{"source_locator":"/absolute"}"#,
                r#"{"source_locator":null}"#,
                r#"{"command_version":0}"#,
                r#"{"attempt_count":-1}"#,
                r#"{"lease_epoch":-1}"#,
                r#"{"status":"completed"}"#,
                r#"{"status":"failed"}"#,
                r#"{"source_release_state":"released"}"#,
            ] {
                reject(
                    &transaction,
                    file_job_statement(&upload, job_id, overrides),
                )
                .await;
            }
            transaction
                .execute_raw(file_job_statement(&upload, job_id, "{}"))
                .await
                .unwrap();
            reject(
                &transaction,
                file_job_statement(&upload, Uuid::new_v4(), "{}"),
            )
            .await;
            assert_command_immutable(&transaction, job_id).await;
            assert_attempt_bindings(&transaction, &upload, job_id).await;
            assert_budget_constraints(&transaction).await;
            assert_file_result_shapes(&transaction).await;
            transaction.rollback().await.unwrap();
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_downgrade_with_retained_job_history() {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            assert!(
                table_exists(connection, "device_upload_finalization_job")
                    .await
            );
            let transaction = connection.begin().await.unwrap();
            let upload = insert_open_upload(&transaction).await;
            let job_id = Uuid::new_v4();
            transaction
                .execute_raw(file_job_statement(&upload, job_id, "{}"))
                .await
                .unwrap();
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set status = 'failed', finished_at = now(), error_code = 'source_digest_mismatch', error_message = 'Source digest mismatch', error_action = 'new_upload' where id = $1",
                [job_id.into()],
            )).await.unwrap();
            reject(
                &transaction,
                file_job_statement(&upload, Uuid::new_v4(), "{}"),
            )
            .await;
            for assignment in [
                "status = 'queued', finished_at = null, error_code = null, error_message = null, error_action = null",
                "error_message = 'replacement failure'",
                "finished_at = finished_at + interval '1 second'",
                "winning_attempt_id = gen_random_uuid()",
            ] {
                reject(&transaction, Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!("update device_upload_finalization_job set {assignment} where id = $1"),
                    [job_id.into()],
                )).await;
            }
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set source_release_state = 'release_pending' where id = $1",
                [job_id.into()],
            )).await.unwrap();
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set source_release_state = 'released', source_released_at = now(), quota_released_at = now() where id = $1",
                [job_id.into()],
            )).await.unwrap();
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;

            let transaction = connection.begin().await.unwrap();
            let error = downgrade_finalization(&transaction).await.unwrap_err();
            transaction.rollback().await.unwrap();
            assert!(
                format!("{error:?}").contains("finalization"),
                "unexpected downgrade error: {error:?}"
            );
            assert_eq!(
                table_count(connection, "device_upload_finalization_job").await,
                1
            );
            assert_eq!(publication_snapshot(connection).await, before);
            assert_migration_versions(connection).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    async fn insert_open_upload(
        transaction: &DatabaseTransaction,
    ) -> file_content_upload::Model {
        let tree = insert_file_entry_tree(transaction).await;
        let upload_id = Uuid::new_v4();
        let now = Utc::now().fixed_offset();
        let expires_at = now + Duration::hours(1);
        let row = transaction.query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into file_content_upload(id,device_id,file_id,revision,created_by_login_id,upload_length,expected_sha256,object_key,status,created_at,last_activity_at,expires_at,hard_expires_at,spool_removed_at,next_cleanup_at)
                values($1,$2,$3,1,$4,1,$5,$6,'open',$7,$7,$8,$9,null,$8)
                returning id,device_id,file_id,revision,created_by_login_id,upload_length,expected_sha256,object_key,status,created_at,last_activity_at,expires_at,hard_expires_at,spool_removed_at,next_cleanup_at,stats_epoch,null::uuid as finalization_job_id"#,
            [upload_id.into(),tree.device_id.into(),tree.file_id.into(),Uuid::new_v4().into(),vec![1_u8; 32].into(),
                format!("device-file-content/{}/{}/1/{upload_id}",tree.device_id,tree.file_id).into(),
                now.into(),expires_at.into(),(now + Duration::days(1)).into()],
        )).await.unwrap().unwrap();
        file_content_upload::Model::from_query_result(&row, "").unwrap()
    }

    async fn downgrade_finalization<'c>(
        connection: impl sea_orm_migration::IntoSchemaManagerConnection<'c>,
    ) -> Result<(), DbErr> {
        let migrations = wdfiles_migration::Migrator::migrations();
        let index = migrations
            .iter()
            .position(|migration| migration.name() == VERSION)
            .unwrap();
        let steps = u32::try_from(migrations.len() - index).unwrap();
        wdfiles_migration::Migrator::down(connection, Some(steps)).await
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_completed_upload_without_original_publication() {
        let (config, database_url) = isolated_file_registry_config().await;
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            migrate_before_finalization(connection).await;
            let transaction = connection.begin().await.unwrap();
            let upload = insert_open_upload(&transaction).await;
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update file_content_upload set status='completed',next_cleanup_at=$2 where id=$1",
                [upload.id.into(),Utc::now().fixed_offset().into()],
            )).await.unwrap();
            transaction.commit().await.unwrap();
            let before = publication_snapshot(connection).await;

            assert!(
                wdfiles_migration::Migrator::up(connection, None)
                    .await
                    .is_err(),
                "migration must reject completed upload without original file content"
            );
            assert!(
                !table_exists(connection, "file_content_upload_object").await
            );
            assert_eq!(publication_snapshot(connection).await, before);
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_noncanonical_audio_commands_and_name_mutation() {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            assert!(
                table_exists(connection, "device_upload_finalization_job")
                    .await
            );
            let transaction = connection.begin().await.unwrap();
            let job_id = Uuid::new_v4();
            let device_id = Uuid::new_v4();
            let source_id = Uuid::new_v4();
            for overrides in [
                r#"{"kind":"file"}"#,
                r#"{"file_upload_id":"00000000-0000-0000-0000-000000000001"}"#,
                r#"{"source_identity":"alternate-url-spelling"}"#,
                r#"{"upload_url":"/api/device/audio/foreign/uploads/source.123"}"#,
                r#"{"source_size_bytes":0}"#,
                r#"{"audio_name":""}"#,
                r#"{"audio_name_key":"\\x01"}"#,
                r#"{"recording_started_at":"infinity"}"#,
                r#"{"pin_token":null}"#,
            ] {
                reject(
                    &transaction,
                    audio_job_statement(
                        job_id, device_id, source_id, overrides,
                    ),
                )
                .await;
            }
            transaction
                .execute_raw(audio_job_statement(
                    job_id, device_id, source_id, "{}",
                ))
                .await
                .unwrap();
            reject(
                &transaction,
                audio_job_statement(Uuid::new_v4(), device_id, source_id, "{}"),
            )
            .await;
            reject(&transaction, Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set status = 'completed', finished_at = now(), result = jsonb_build_object('version', 1, 'value', jsonb_build_object('audio', jsonb_build_object('id', audio_id, 'device_id', device_id))) where id = $1",
                [job_id.into()],
            )).await;
            for assignment in [
                "audio_id = gen_random_uuid()",
                "audio_name = 'renamed.wav', audio_name_key = convert_to('renamed.wav', 'UTF8')",
                "recording_started_at = recording_started_at + interval '1 microsecond'",
                "pin_token = gen_random_uuid()",
                "upload_url = upload_url || '0'",
            ] {
                reject(
                    &transaction,
                    Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        format!(
                            "update device_upload_finalization_job set {assignment} where id = $1"
                        ),
                        [job_id.into()],
                    ),
                )
                .await;
            }
            transaction.rollback().await.unwrap();
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    fn audio_job_statement(
        job_id: Uuid,
        device_id: Uuid,
        source_id: Uuid,
        overrides: &str,
    ) -> Statement {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into device_upload_finalization_job select
                (jsonb_populate_record(null::device_upload_finalization_job,
                    jsonb_build_object(
                        'id', $1::uuid, 'kind', 'audio', 'source_identity', $2::text,
                        'created_by_login_id', $3::uuid, 'device_id', $4::uuid,
                        'audio_id', $5::uuid, 'audio_name', 'record.wav',
                        'audio_name_key', convert_to('record.wav', 'UTF8'),
                        'recording_started_at', '2026-10-14T10:00:00.123456Z',
                        'upload_url', $6::text, 'source_size_bytes', 123,
                        'source_locator', $7::text, 'pin_token', $8::uuid,
                        'command_version', 1, 'status', 'queued', 'created_at', now(),
                        'updated_at', now(), 'next_run_at', now(), 'attempt_count', 0,
                        'lease_epoch', 0, 'source_release_state', 'held'
                    ) || $9::jsonb)).*"#,
            [
                job_id.into(),
                format!("{device_id}/{source_id}").into(),
                Uuid::new_v4().into(),
                device_id.into(),
                Uuid::new_v4().into(),
                format!(
                    "/api/device/audio/{device_id}/uploads/{source_id}.123"
                )
                .into(),
                source_id.to_string().into(),
                Uuid::new_v4().into(),
                overrides.into(),
            ],
        )
    }

    fn file_job_statement(
        upload: &file_content_upload::Model,
        job_id: Uuid,
        overrides: &str,
    ) -> Statement {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into device_upload_finalization_job select
                (jsonb_populate_record(null::device_upload_finalization_job,
                    jsonb_build_object(
                        'id', $1::uuid, 'kind', 'file', 'source_identity', $2::text,
                        'created_by_login_id', $3::uuid, 'device_id', $4::uuid,
                        'file_upload_id', $2::uuid, 'file_id', $5::uuid, 'revision', 1,
                        'source_size_bytes', 1, 'source_locator', $2::text,
                        'command_version', 1, 'status', 'queued',
                        'created_at', now(), 'updated_at', now(), 'next_run_at', now(),
                        'attempt_count', 0, 'lease_epoch', 0, 'source_release_state', 'held'
                    ) || $6::jsonb)).*"#,
            [
                job_id.into(),
                upload.id.to_string().into(),
                upload.created_by_login_id.into(),
                upload.device_id.into(),
                upload.file_id.into(),
                overrides.into(),
            ],
        )
    }

    async fn assert_file_result_shapes(transaction: &DatabaseTransaction) {
        let content = publish_original(transaction).await;
        let upload =
            file_content_upload::Entity::find_by_id(content.upload_id.unwrap())
                .one(transaction)
                .await
                .unwrap()
                .unwrap();
        let receipt = serde_json::json!({
            "upload_id": upload.id, "file_id": upload.file_id,
            "revision": 1, "status": "completed",
        });
        let valid_result = serde_json::json!({"version": 1, "value": receipt});
        let mut string_revision = valid_result.clone();
        string_revision["value"]["revision"] = serde_json::json!("1");
        let mut extra_field = valid_result.clone();
        extra_field["value"]["object_key"] =
            serde_json::json!(upload.object_key);
        for result in [
            serde_json::json!({"version": "1", "value": receipt}),
            serde_json::json!({"version": 1, "value": {"status": "completed"}}),
            string_revision,
            extra_field,
        ] {
            let overrides = serde_json::json!({
                "status": "completed", "finished_at": Utc::now(), "result": result,
                "source_release_state": "released",
                "source_released_at": Utc::now(), "quota_released_at": Utc::now(),
            });
            reject(
                transaction,
                file_job_statement(
                    &upload,
                    Uuid::new_v4(),
                    &overrides.to_string(),
                ),
            )
            .await;
        }
        let overrides = serde_json::json!({
            "status": "completed", "finished_at": Utc::now(), "result": valid_result,
            "source_release_state": "released",
            "source_released_at": Utc::now(), "quota_released_at": Utc::now(),
        });
        let job_id = Uuid::new_v4();
        transaction
            .execute_raw(file_job_statement(
                &upload,
                job_id,
                &overrides.to_string(),
            ))
            .await
            .unwrap();
        reject(transaction, Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_job set result = jsonb_set(result, '{value,revision}', '2'::jsonb) where id = $1",
            [job_id.into()],
        )).await;
    }

    async fn assert_command_immutable(
        transaction: &DatabaseTransaction,
        job_id: Uuid,
    ) {
        for assignment in [
            "id = gen_random_uuid()",
            "created_by_login_id = gen_random_uuid()",
            "device_id = gen_random_uuid()",
            "source_identity = gen_random_uuid()::text",
            "file_upload_id = gen_random_uuid()",
            "file_id = gen_random_uuid()",
            "revision = 2",
            "source_size_bytes = 2",
            "source_locator = 'other-source'",
            "command_version = 2",
            "created_at = created_at + interval '1 second'",
        ] {
            reject(
                transaction,
                Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!("update device_upload_finalization_job set {assignment} where id = $1"),
                    [job_id.into()],
                ),
            )
            .await;
        }
        reject(
            transaction,
            Statement::from_sql_and_values(
                DbBackend::Postgres,
                "delete from device_upload_finalization_job where id = $1",
                [job_id.into()],
            ),
        )
        .await;
    }

    async fn assert_attempt_bindings(
        transaction: &DatabaseTransaction,
        upload: &file_content_upload::Model,
        job_id: Uuid,
    ) {
        transaction.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_job set status = 'processing', lease_epoch = 1, lease_owner = $2, lease_until = now() + interval '1 hour' where id = $1",
            [job_id.into(), Uuid::new_v4().into()],
        )).await.unwrap();
        let attempt_id = Uuid::new_v4();
        for overrides in [
            r#"{"kind":"audio"}"#,
            r#"{"device_id":"00000000-0000-0000-0000-000000000001"}"#,
            r#"{"file_upload_id":"00000000-0000-0000-0000-000000000001"}"#,
            r#"{"object_key":"unowned-key"}"#,
            r#"{"ordinal":0}"#,
            r#"{"lease_epoch":0}"#,
            r#"{"source_size_bytes":2}"#,
            r#"{"source_sha256":"\\x01"}"#,
            r#"{"phase":"prepared"}"#,
            r#"{"phase":"write_intent"}"#,
            r#"{"origin":"legacy_cleanup"}"#,
        ] {
            reject(
                transaction,
                attempt_statement(upload, job_id, attempt_id, overrides),
            )
            .await;
        }
        transaction
            .execute_raw(attempt_statement(upload, job_id, attempt_id, "{}"))
            .await
            .unwrap();
        reject(
            transaction,
            attempt_statement(upload, job_id, Uuid::new_v4(), "{}"),
        )
        .await;
        reject(transaction, Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set source_sha256 = decode(repeat('02', 32), 'hex') where id = $1",
            [attempt_id.into()],
        )).await;
        transaction.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set phase = 'prepared', source_sha256 = decode(repeat('01', 32), 'hex') where id = $1",
            [attempt_id.into()],
        )).await.unwrap();
        transaction.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set phase = 'write_intent', write_intent_at = now(), write_credit_held = true where id = $1",
            [attempt_id.into()],
        )).await.unwrap();
        for assignment in [
            "source_sha256 = decode(repeat('02', 32), 'hex')",
            "source_size_bytes = 2",
            "is_encrypted = false",
            "storage_policy_version = 2",
            "object_key = 'replacement-key'",
            "lease_epoch = 2",
            "write_credit_held = false",
        ] {
            reject(
                transaction,
                Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!(
                        "update device_upload_finalization_attempt set {assignment} where id = $1"
                    ),
                    [attempt_id.into()],
                ),
            )
            .await;
        }
        assert_legacy_cleanup_and_single_write(transaction, upload, job_id)
            .await;
        let other_upload = insert_open_upload(transaction).await;
        let other_job_id = Uuid::new_v4();
        transaction
            .execute_raw(file_job_statement(&other_upload, other_job_id, "{}"))
            .await
            .unwrap();
        reject(transaction, Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set job_id = $2 where id = $1",
            [attempt_id.into(), other_job_id.into()],
        )).await;
    }

    async fn assert_legacy_cleanup_and_single_write(
        transaction: &DatabaseTransaction,
        upload: &file_content_upload::Model,
        job_id: Uuid,
    ) {
        reject(
            transaction,
            legacy_cleanup_statement(upload, job_id, Uuid::new_v4(), 2),
        )
        .await;

        let second_id = Uuid::new_v4();
        transaction
            .execute_raw(attempt_statement(
                upload,
                job_id,
                second_id,
                r#"{"ordinal":3}"#,
            ))
            .await
            .unwrap();
        transaction.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set phase = 'prepared', source_sha256 = decode(repeat('01', 32), 'hex') where id = $1",
            [second_id.into()],
        )).await.unwrap();
        reject(transaction, Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_attempt set phase = 'write_intent', write_intent_at = now(), write_credit_held = true where id = $1",
            [second_id.into()],
        )).await;
    }

    fn legacy_cleanup_statement(
        upload: &file_content_upload::Model,
        job_id: Uuid,
        cleanup_id: Uuid,
        ordinal: i64,
    ) -> Statement {
        let overrides = serde_json::json!({
            "origin": "legacy_cleanup", "ordinal": ordinal, "phase": "retired",
            "object_key": upload.object_key, "retired_at": Utc::now(),
            "cleanup_next_at": Utc::now(),
        });
        attempt_statement(upload, job_id, cleanup_id, &overrides.to_string())
    }

    fn attempt_statement(
        upload: &file_content_upload::Model,
        job_id: Uuid,
        attempt_id: Uuid,
        overrides: &str,
    ) -> Statement {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into device_upload_finalization_attempt select
                (jsonb_populate_record(null::device_upload_finalization_attempt,
                    jsonb_build_object(
                        'id', $1::uuid, 'job_id', $2::uuid, 'kind', 'file',
                        'origin', 'async', 'ordinal', 1, 'lease_epoch', 1,
                        'file_upload_id', $3::uuid, 'device_id', $4::uuid,
                        'object_key', $5::text, 'storage_policy_version', 1,
                        'is_encrypted', true, 'source_size_bytes', 1,
                        'phase', 'preparing', 'write_credit_held', false,
                        'late_write_possible', false, 'created_at', now(), 'updated_at', now()
                    ) || $6::jsonb)).*"#,
            [
                attempt_id.into(),
                job_id.into(),
                upload.id.into(),
                upload.device_id.into(),
                format!("device-file-finalization/{}/{attempt_id}", upload.id)
                    .into(),
                overrides.into(),
            ],
        )
    }

    async fn assert_budget_constraints(transaction: &DatabaseTransaction) {
        transaction.execute_unprepared(
            "insert into device_upload_finalization_budget (scope, reserved_jobs, reserved_source_bytes, unresolved_writes) values ('global:file', 1, 1, 1)",
        ).await.unwrap();
        for assignment in [
            "reserved_jobs = -1",
            "reserved_source_bytes = -1",
            "unresolved_writes = -1",
        ] {
            reject(
                transaction,
                Statement::from_string(
                    DbBackend::Postgres,
                    format!("update device_upload_finalization_budget set {assignment}"),
                ),
            )
            .await;
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn binds_selected_object_to_verified_attempt_and_rejects_canonical_conflict(
    ) {
        let (config, database_url) = isolated_file_registry_config().await;
        run_migrations(&config, Mode::Debug).await.unwrap();
        {
            let db = connect_runtime(&config, Mode::Debug)
                .await
                .unwrap()
                .unwrap();
            let connection = db.connection();
            assert!(
                table_exists(connection, "file_content_upload_object").await
            );
            let transaction = connection.begin().await.unwrap();
            let upload = insert_open_upload(&transaction).await;
            let job_id = Uuid::new_v4();
            let retired_id = Uuid::new_v4();
            transaction
                .execute_raw(file_job_statement(&upload, job_id, "{}"))
                .await
                .unwrap();
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set status = 'processing', lease_epoch = 1, lease_owner = $2, lease_until = now() + interval '1 hour' where id = $1",
                [job_id.into(), Uuid::new_v4().into()],
            )).await.unwrap();
            transaction
                .execute_raw(attempt_statement(
                    &upload, job_id, retired_id, "{}",
                ))
                .await
                .unwrap();
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set active_attempt_id = $2 where id = $1",
                [job_id.into(), retired_id.into()],
            )).await.unwrap();
            reject(
                &transaction,
                selected_object_statement(&upload, retired_id, "{}"),
            )
            .await;
            verify_attempt(&transaction, retired_id).await;
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_attempt set phase = 'retired', retired_at = now(), cleanup_next_at = now() where id = $1",
                [retired_id.into()],
            )).await.unwrap();
            reject(
                &transaction,
                selected_object_statement(&upload, retired_id, "{}"),
            )
            .await;
            reject(&transaction, Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_attempt set phase = 'verified', retired_at = null, cleanup_next_at = null where id = $1",
                [retired_id.into()],
            )).await;

            let selected_id = Uuid::new_v4();
            transaction
                .execute_raw(attempt_statement(
                    &upload,
                    job_id,
                    selected_id,
                    r#"{"ordinal":2}"#,
                ))
                .await
                .unwrap();
            verify_attempt(&transaction, selected_id).await;
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_job set active_attempt_id = $2 where id = $1",
                [job_id.into(), selected_id.into()],
            )).await.unwrap();
            assert_selected_attempt_bindings(
                &transaction,
                &upload,
                selected_id,
            )
            .await;
            transaction
                .execute_raw(selected_object_statement(
                    &upload,
                    selected_id,
                    "{}",
                ))
                .await
                .unwrap();
            reject(&transaction, Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_attempt set phase = 'retired', retired_at = now(), cleanup_next_at = now() where id = $1",
                [selected_id.into()],
            )).await;
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update device_upload_finalization_attempt set phase = 'selected' where id = $1",
                [selected_id.into()],
            )).await.unwrap();
            transaction
                .execute_raw(legacy_cleanup_statement(
                    &upload,
                    job_id,
                    Uuid::new_v4(),
                    3,
                ))
                .await
                .unwrap();
            for assignment in [
                "phase = 'retired', retired_at = now(), cleanup_next_at = now()",
                "cleanup_confirmed_at = now()",
                "is_encrypted = false",
            ] {
                reject(&transaction, Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!("update device_upload_finalization_attempt set {assignment} where id = $1"),
                    [selected_id.into()],
                )).await;
            }
            reject(
                &transaction,
                Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "delete from device_upload_finalization_attempt where id = $1",
                    [selected_id.into()],
                ),
            )
            .await;
            assert_async_publication(&transaction, &upload, selected_id).await;
            transaction.commit().await.unwrap();

            let before = publication_snapshot(connection).await;
            let transaction = connection.begin().await.unwrap();
            assert!(downgrade_finalization(&transaction).await.is_err());
            transaction.rollback().await.unwrap();
            assert_eq!(publication_snapshot(connection).await, before);
            assert_eq!(
                table_count(connection, "file_content_upload_object").await,
                1
            );
            assert_migration_versions(connection).await;
        }
        sqlx::Postgres::drop_database(&database_url).await.unwrap();
    }

    async fn verify_attempt(
        transaction: &DatabaseTransaction,
        attempt_id: Uuid,
    ) {
        for assignment in [
            "phase = 'prepared', source_sha256 = decode(repeat('01', 32), 'hex')",
            "phase = 'write_intent', write_intent_at = now(), write_credit_held = true",
            "phase = 'verified', write_acknowledged_at = now(), verified_at = now(), write_resolved_at = now(), write_credit_held = false",
        ] {
            transaction.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!("update device_upload_finalization_attempt set {assignment} where id = $1"),
                [attempt_id.into()],
            )).await.unwrap();
        }
    }

    async fn assert_selected_attempt_bindings(
        transaction: &DatabaseTransaction,
        upload: &file_content_upload::Model,
        attempt_id: Uuid,
    ) {
        for overrides in [
            r#"{"attempt_id":null}"#,
            r#"{"source_size_bytes":2}"#,
            r#"{"source_sha256":"\\x02"}"#,
            r#"{"is_encrypted":false}"#,
        ] {
            reject(
                transaction,
                selected_object_statement(upload, attempt_id, overrides),
            )
            .await;
        }
        let other_upload = insert_open_upload(transaction).await;
        reject(
            transaction,
            selected_object_statement(&other_upload, attempt_id, "{}"),
        )
        .await;
    }

    fn selected_object_statement(
        upload: &file_content_upload::Model,
        attempt_id: Uuid,
        overrides: &str,
    ) -> Statement {
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"insert into file_content_upload_object select
                (jsonb_populate_record(null::file_content_upload_object,
                    jsonb_build_object(
                        'upload_id', $1::uuid, 'file_id', $2::uuid,
                        'object_key', $3::text, 'source_size_bytes', 1,
                        'source_sha256', decode(repeat('01', 32), 'hex'),
                        'is_encrypted', true, 'attempt_id', $4::uuid
                    ) || $5::jsonb)).*"#,
            [
                upload.id.into(),
                upload.file_id.into(),
                format!("device-file-finalization/{}/{attempt_id}", upload.id)
                    .into(),
                attempt_id.into(),
                overrides.into(),
            ],
        )
    }

    async fn assert_async_publication(
        transaction: &DatabaseTransaction,
        upload: &file_content_upload::Model,
        attempt_id: Uuid,
    ) {
        let mut completed = upload.clone().into_active_model();
        completed.status = Set(FileContentUploadStatus::Completed);
        completed.next_cleanup_at = Set(Some(Utc::now().fixed_offset()));
        completed.update(transaction).await.unwrap();
        let mut content = file_content::ActiveModel {
            file_id: Set(upload.file_id),
            revision: Set(1),
            upload_id: Set(Some(upload.id)),
            origin_archive_id: Set(None),
            object_key: Set(upload.object_key.clone()),
            source_size_bytes: Set(1),
            source_sha256: Set(vec![1; 32]),
            is_encrypted: Set(true),
            created_at: Set(Utc::now().fixed_offset()),
        };
        assert_file_entry_operation_rejected(
            transaction,
            content.clone().insert(transaction),
        )
        .await;
        let object_key =
            format!("device-file-finalization/{}/{attempt_id}", upload.id);
        content.object_key = Set(object_key.clone());
        content.is_encrypted = Set(false);
        assert_file_entry_operation_rejected(
            transaction,
            content.clone().insert(transaction),
        )
        .await;
        content.is_encrypted = Set(true);
        let content = content.insert(transaction).await.unwrap();
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update file_entry set content_path = $2 where id = $1",
                [upload.file_id.into(), object_key.clone().into()],
            ))
            .await
            .unwrap();
        reuse_original(transaction, &content).await;
        let reused = file_content::Entity::find_by_id((upload.file_id, 2))
            .one(transaction)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reused.upload_id, Some(upload.id));
        assert_eq!(reused.object_key, object_key);
        assert!(reused.is_encrypted);
    }

    async fn reject(
        transaction: &DatabaseTransaction,
        statement: Statement,
    ) -> DbErr {
        transaction
            .execute_unprepared("savepoint finalization_rejection")
            .await
            .unwrap();
        let description = format!("{statement:?}");
        let error = match transaction.execute_raw(statement).await {
            Err(error) => error,
            Ok(_) => panic!("operation unexpectedly succeeded: {description}"),
        };
        assert!(
            ["23503", "23505", "23514", "P0001"]
                .iter()
                .any(|code| has_postgres_error_code(&error, code)),
            "expected constraint or trigger rejection for {description}, got {error:?}"
        );
        transaction
            .execute_unprepared("rollback to savepoint finalization_rejection")
            .await
            .unwrap();
        transaction
            .execute_unprepared("release savepoint finalization_rejection")
            .await
            .unwrap();
        error
    }

    async fn assert_selected_object_immutable(
        connection: &DatabaseConnection,
        original: &file_content::Model,
    ) {
        let transaction = connection.begin().await.unwrap();
        for assignment in [
            "object_key = 'replacement-key'",
            "source_size_bytes = 2",
            "source_sha256 = decode(repeat('02', 32), 'hex')",
            "is_encrypted = false",
            "attempt_id = gen_random_uuid()",
        ] {
            reject(
                &transaction,
                Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!(
                        "update file_content_upload_object set {assignment} where upload_id = $1"
                    ),
                    [original.upload_id.into()],
                ),
            )
            .await;
        }
        reject(
            &transaction,
            Statement::from_sql_and_values(
                DbBackend::Postgres,
                "delete from file_content_upload_object where upload_id = $1",
                [original.upload_id.into()],
            ),
        )
        .await;
        assert_canonical_publication_cannot_retire(&transaction, original)
            .await;
        transaction.rollback().await.unwrap();
    }

    async fn assert_canonical_publication_cannot_retire(
        transaction: &DatabaseTransaction,
        original: &file_content::Model,
    ) {
        let upload = file_content_upload::Entity::find_by_id(
            original.upload_id.unwrap(),
        )
        .one(transaction)
        .await
        .unwrap()
        .unwrap();
        let job_id = Uuid::new_v4();
        transaction
            .execute_raw(file_job_statement(&upload, job_id, "{}"))
            .await
            .unwrap();
        transaction.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update device_upload_finalization_job set status = 'processing', lease_epoch = 1, lease_owner = $2, lease_until = now() + interval '1 hour' where id = $1",
            [job_id.into(), Uuid::new_v4().into()],
        )).await.unwrap();
        reject(
            transaction,
            legacy_cleanup_statement(&upload, job_id, Uuid::new_v4(), 1),
        )
        .await;
    }

    async fn publish_original(
        transaction: &DatabaseTransaction,
    ) -> file_content::Model {
        let tree = insert_file_entry_tree(transaction).await;
        let file = file_entry::Entity::find_by_id(tree.file_id)
            .one(transaction)
            .await
            .unwrap()
            .unwrap();
        super::super::test_support::publish_content(
            transaction,
            &file,
            Uuid::now_v7(),
        )
        .await;
        file_content::Entity::find_by_id((file.id, 1))
            .one(transaction)
            .await
            .unwrap()
            .unwrap()
    }

    async fn reuse_original(
        transaction: &DatabaseTransaction,
        original: &file_content::Model,
    ) {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"insert into file_revision
                select (jsonb_populate_record(null::file_revision,
                    to_jsonb(r) || '{"revision":2,"source_sequence":2}'::jsonb)).*
                from file_revision r where id = $1 and revision = 1"#,
                [original.file_id.into()],
            ))
            .await
            .unwrap();
        let mut reused = original.clone().into_active_model();
        reused.revision = Set(2);
        reused.insert(transaction).await.unwrap();
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "update file_entry set revision = 2 where id = $1",
                [original.file_id.into()],
            ))
            .await
            .unwrap();
    }

    async fn insert_legacy_audio(transaction: &DatabaseTransaction) {
        let device_id = Uuid::new_v4();
        let audio_id = Uuid::new_v4();
        let ingest_id = Uuid::new_v4();
        let upload_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let storage_key =
            format!("device-audio/{device_id}/{audio_id}/{ingest_id}");
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"insert into device_audio_ingest (
                id, audio_id, device_id, actor_id, tus_upload_ref, tus_upload_id,
                tus_owner_id, name, name_key, recording_started_at, created_at,
                storage_key, status, lease_token, heartbeat_at
            ) values ($1, $2, $3, $4, $5, $6, $4, 'legacy.wav',
                convert_to('legacy.wav', 'UTF8'), '2026-10-13T10:00:00Z',
                '2026-10-13T10:01:00Z', $7, 'finalizing', $8,
                '2026-10-13T10:01:00Z')"#,
                [
                    ingest_id.into(),
                    audio_id.into(),
                    device_id.into(),
                    actor_id.into(),
                    format!("/api/device/audio/{device_id}/uploads/{upload_id}.123").into(),
                    upload_id.into(),
                    storage_key.into(),
                    Uuid::new_v4().into(),
                ],
            ))
            .await
            .unwrap();
        transaction
            .execute_unprepared(
                r#"update device_audio_ingest set status = 'storing',
                source_size_bytes = 123, source_sha256 = decode(repeat('02', 32), 'hex'),
                duration_us = 1000000, mime_type = 'audio/wav';
            insert into device_audio (
                id, device_id, ingest_id, name, name_key, recording_started_at,
                duration_us, recording_ended_at, created_at, mime_type,
                source_size_bytes, source_sha256, storage_key, transcription,
                text_version, processed, processing_version
            ) select audio_id, device_id, id, name, name_key, recording_started_at,
                duration_us, recording_started_at + interval '1 second',
                created_at, mime_type, source_size_bytes, source_sha256,
                storage_key, '', gen_random_uuid(), false, gen_random_uuid()
                from device_audio_ingest;
            update device_audio_ingest set status = 'ready';"#,
            )
            .await
            .unwrap();
    }

    async fn publication_snapshot(
        connection: &DatabaseConnection,
    ) -> Vec<String> {
        let mut snapshot = Vec::new();
        for table in [
            "file_entry",
            "file_revision",
            "file_content_upload",
            "file_content",
            "device_audio_ingest",
            "device_audio",
        ] {
            let projection = if table == "file_content_upload" {
                "(to_jsonb(t) - 'finalization_job_id')::text"
            } else {
                "row_to_json(t)::text"
            };
            let rows = connection.query_all_raw(Statement::from_string(
                DbBackend::Postgres,
                format!("select {projection} as row from {table} t order by {projection}"),
            )).await.unwrap();
            snapshot.extend(rows.into_iter().map(|row| {
                format!("{table}:{}", row.try_get::<String>("", "row").unwrap())
            }));
        }
        snapshot
    }

    async fn assert_selected_object(
        connection: &DatabaseConnection,
        original: &file_content::Model,
    ) {
        let selected = connection
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select * from file_content_upload_object where upload_id = $1",
                [original.upload_id.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            selected.try_get::<Uuid>("", "file_id").unwrap(),
            original.file_id
        );
        assert_eq!(
            selected.try_get::<String>("", "object_key").unwrap(),
            original.object_key
        );
        assert_eq!(
            selected.try_get::<i64>("", "source_size_bytes").unwrap(),
            1
        );
        assert_eq!(
            selected.try_get::<Vec<u8>>("", "source_sha256").unwrap(),
            vec![1; 32]
        );
        assert!(selected.try_get::<bool>("", "is_encrypted").unwrap());
        assert_eq!(
            selected.try_get::<Option<Uuid>>("", "attempt_id").unwrap(),
            None
        );
    }
}

fn has_postgres_error_code(
    error: &(dyn StdError + 'static),
    code: &str,
) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(
            DbErr::Conn(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Exec(sea_orm::RuntimeErr::SqlxError(sqlx_error))
            | DbErr::Query(sea_orm::RuntimeErr::SqlxError(sqlx_error)),
        ) = error.downcast_ref::<DbErr>()
        {
            if let sqlx::Error::Database(database_error) = sqlx_error.as_ref() {
                if database_error.code().as_deref() == Some(code) {
                    return true;
                }
            }
        }
        if let Some(sqlx::Error::Database(database_error)) =
            error.downcast_ref::<sqlx::Error>()
        {
            if database_error.code().as_deref() == Some(code) {
                return true;
            }
        }
        source = error.source();
    }
    false
}
