use super::entities::device_file;
use super::*;
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DbBackend, EntityTrait, IntoActiveModel,
    Set, Statement, TransactionTrait,
};
use std::error::Error as StdError;

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
    let config = crate::config::read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let connection = file_registry_db.connection();

    let migration_versions = connection
        .query_all(Statement::from_string(
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
        ["m20260719_174625_create_file_registry_device_file"]
    );

    let columns = connection
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select column_name, is_nullable, column_default, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'device_file'
order by ordinal_position
"#
            .to_string(),
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
            )
        })
        .collect::<Vec<(String, String, Option<String>, String)>>();
    let expected_columns = [
        ("id", "NO", None, "uuid"),
        ("device_id", "NO", None, "uuid"),
        ("name", "NO", None, "text"),
        ("path", "NO", None, "text"),
        ("mime_type", "YES", None, "text"),
        ("extension", "YES", None, "text"),
        (
            "file_metadata_created_at",
            "YES",
            None,
            "timestamp without time zone",
        ),
        (
            "file_metadata_modified_at",
            "YES",
            None,
            "timestamp without time zone",
        ),
        ("created_at", "NO", None, "timestamp without time zone"),
        ("updated_at", "NO", None, "timestamp without time zone"),
    ]
    .into_iter()
    .map(|(name, nullable, default, data_type)| {
        (
            name.to_string(),
            nullable.to_string(),
            default.map(str::to_string),
            data_type.to_string(),
        )
    })
    .collect::<Vec<_>>();
    assert_eq!(columns, expected_columns);

    let check_names = connection
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select conname
from pg_constraint
where conrelid = 'public.device_file'::regclass and contype = 'c'
order by conname
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "conname").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(
        check_names,
        [
            "device_file_extension_not_empty_check",
            "device_file_mime_type_not_empty_check",
            "device_file_name_not_empty_check",
            "device_file_path_not_empty_check",
        ]
    );

    let primary_key_columns = connection
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"
select attribute.attname
from pg_index index
join pg_attribute attribute
  on attribute.attrelid = index.indrelid
 and attribute.attnum = any(index.indkey)
where index.indrelid = 'public.device_file'::regclass
  and index.indisprimary
order by array_position(index.indkey, attribute.attnum)
"#
            .to_string(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "attname").unwrap())
        .collect::<Vec<String>>();
    assert_eq!(primary_key_columns, ["id"]);

    let foreign_key_count: i64 = connection
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "select count(*) as count from pg_constraint where conrelid = 'public.device_file'::regclass and contype = 'f'".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap();
    assert_eq!(foreign_key_count, 0);

    let index_definition: String = connection
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'device_file' and indexname = 'device_file_device_id_updated_at_id_idx'".to_string(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "indexdef")
        .unwrap();
    assert!(
        index_definition.contains("(device_id, updated_at DESC, id)"),
        "{index_definition}"
    );

    let transaction = connection.begin().await.unwrap();
    let id = Uuid::new_v4();
    let device_id = Uuid::new_v4();
    let created_at = Utc::now().naive_utc();
    let metadata_created_at = created_at - Duration::hours(2);
    let metadata_modified_at = created_at - Duration::hours(1);
    let saved = device_file::ActiveModel {
        id: Set(id),
        device_id: Set(device_id),
        name: Set("fully-populated-file".to_string()),
        path: Set("/opt/source/fully-populated-file.bin".to_string()),
        mime_type: Set(Some("application/octet-stream".to_string())),
        extension: Set(Some("bin".to_string())),
        file_metadata_created_at: Set(Some(metadata_created_at)),
        file_metadata_modified_at: Set(Some(metadata_modified_at)),
        created_at: Set(created_at),
        updated_at: Set(created_at),
    }
    .insert(&transaction)
    .await
    .unwrap();
    assert_eq!(saved.id, id);
    assert_eq!(saved.device_id, device_id);
    assert_eq!(saved.mime_type.as_deref(), Some("application/octet-stream"));
    assert_eq!(saved.extension.as_deref(), Some("bin"));
    assert_eq!(saved.file_metadata_created_at, Some(metadata_created_at));
    assert_eq!(saved.file_metadata_modified_at, Some(metadata_modified_at));

    let fetched = device_file::Entity::find_by_id(id)
        .one(&transaction)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fetched, saved);

    let updated_at = created_at + Duration::seconds(1);
    let mut active = fetched.into_active_model();
    active.path = Set("/opt/source/updated-file.bin".to_string());
    active.updated_at = Set(updated_at);
    let updated = active.update(&transaction).await.unwrap();
    assert_eq!(updated.path, "/opt/source/updated-file.bin");
    assert_eq!(updated.updated_at, updated_at);

    let error = device_file::ActiveModel {
        id: Set(Uuid::new_v4()),
        device_id: Set(Uuid::new_v4()),
        name: Set("   ".to_string()),
        path: Set("/opt/source/blank-name.bin".to_string()),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(created_at),
        updated_at: Set(updated_at),
    }
    .insert(&transaction)
    .await
    .unwrap_err();
    assert!(
        has_postgres_error_code(&error, "23514"),
        "expected SQLSTATE 23514, got {error:?}"
    );

    transaction.rollback().await.unwrap();
}

fn has_postgres_error_code(
    error: &(dyn StdError + 'static),
    code: &str,
) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
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
