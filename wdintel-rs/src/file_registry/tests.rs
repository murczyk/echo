use super::entities::file_entry;
use super::entities::sea_orm_active_enums::FileEntryKind;
use super::*;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    DbBackend, DbErr, EntityTrait, IntoActiveModel, NotSet, Set, Statement,
    TransactionTrait,
};
use std::{collections::BTreeMap, error::Error as StdError, future::Future};

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
    let config = crate::config::read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db =
        connect_runtime(&config, Mode::Test).await.unwrap().unwrap();
    let connection = file_registry_db.connection();

    assert_migration_versions(connection).await;
    assert_public_extensions(connection).await;
    assert_legacy_file_table_is_absent(connection).await;
    assert_file_entry_schema(connection).await;
    assert_file_entry_entity_round_trip(connection).await;
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
        ]
    );
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
        ],
    )
    .await;
    assert_file_entry_constraints(connection).await;
    assert_file_entry_triggers(connection).await;
    assert_file_entry_indexes(connection).await;
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
        vec!["file_entry_device_id_id_key".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_entry", 'f').await,
        vec!["file_entry_parent_fk".to_string()]
    );
    assert_eq!(
        constraint_names(connection, "file_entry", 'c').await,
        vec![
            "file_entry_absolute_path_length_check".to_string(),
            "file_entry_absolute_path_windows_check".to_string(),
            "file_entry_directory_content_path_null_check".to_string(),
            "file_entry_directory_metadata_null_check".to_string(),
            "file_entry_extension_check".to_string(),
            "file_entry_mime_type_check".to_string(),
            "file_entry_name_not_empty_check".to_string(),
            "file_entry_row_shape_check".to_string(),
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
                "file_entry_hierarchy_trg".to_string(),
                true,
                false,
                "CREATE CONSTRAINT TRIGGER file_entry_hierarchy_trg AFTER INSERT OR UPDATE ON public.file_entry DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION file_entry_validate_hierarchy()".to_string(),
            ),
            (
                "file_entry_immutable_update_trg".to_string(),
                false,
                false,
                "CREATE TRIGGER file_entry_immutable_update_trg BEFORE UPDATE ON public.file_entry FOR EACH ROW EXECUTE FUNCTION file_entry_enforce_immutable_update()".to_string(),
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
            "file_entry_children_idx".to_string(),
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
            name != "file_entry_device_id_id_key" && name != "file_entry_pkey"
        })
        .collect::<BTreeMap<_, _>>();
    let expected = [
        (
            "file_entry_children_idx",
            "CREATE INDEX file_entry_children_idx ON public.file_entry USING btree (device_id, parent_id, kind, name, id) WHERE (parent_id IS NOT NULL)",
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
    root_id: Uuid,
    directory_id: Uuid,
    file_id: Uuid,
    root_hierarchy_path: String,
    directory_hierarchy_path: String,
    file_hierarchy_path: String,
    created_at: NaiveDateTime,
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
    let mut second_file = file_entry_row(
        second_file_id,
        tree.device_id,
        tree.directory_id,
        &tree.directory_hierarchy_path,
        "app.log",
        r"C:\var\app.log",
        tree.created_at,
    );
    second_file.content_path =
        Set(Some("devices/018f0000/report.log".to_string()));
    let second_file = second_file.insert(&transaction).await.unwrap();
    assert_eq!(second_file.id, second_file_id);
    assert_eq!(second_file.kind, FileEntryKind::File);
    assert_eq!(second_file.name, "app.log");
    assert_eq!(
        second_file.absolute_path.as_deref(),
        Some(r"C:\var\app.log")
    );
    assert_eq!(
        second_file.content_path.as_deref(),
        Some("devices/018f0000/report.log")
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
    let created_at = Utc::now().naive_utc();
    let root_hierarchy_path = uuid_label(root_id);
    let directory_hierarchy_path =
        format!("{root_hierarchy_path}.{}", uuid_label(directory_id));
    let file_hierarchy_path =
        format!("{directory_hierarchy_path}.{}", uuid_label(file_id));

    root_entry(root_id, device_id, created_at)
        .insert(transaction)
        .await
        .unwrap();
    directory_entry(
        directory_id,
        device_id,
        root_id,
        &root_hierarchy_path,
        "var",
        created_at,
    )
    .insert(transaction)
    .await
    .unwrap();
    file_entry_row(
        file_id,
        device_id,
        directory_id,
        &directory_hierarchy_path,
        "app.log",
        r"C:\var\app.log",
        created_at,
    )
    .insert(transaction)
    .await
    .unwrap();

    FileEntryTree {
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
        analyzed: NotSet,
    }
}

fn uuid_label(id: Uuid) -> String {
    format!("n{}", id.to_string().replace('-', ""))
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
