use super::ltree::{ancestor_expr, descendant_expr};
use super::repository::{capture_transaction_id, handle_commit_error};
use super::{
    classify_transaction_error, map_transaction_body_error,
    normalize_file_metadata, query, Breadcrumb, BrowseFilesCommand,
    EntryQueryScope, EntrySortKey, FileCursorCodec, FileEntry, FileEntryKind,
    FileMetadataService, FileSearchFilters, FilesystemError,
    FilesystemRepository, KeysetPageRequest, PathSyntax, PreparedFileMutation,
    RawFileSearchFilters, SearchEntry, SearchFilesCommand, SourcePathParser,
    SyncFileItemCommand, SyncFileItemOutcome, SyncFileItemResult,
    SyncFileOperation, SyncFileRejectionKind, SyncFilesCommand, TreeEntry,
};
use crate::config::{
    read_config, DEVICE_FILE_CURSOR_MAX_BYTES, DEVICE_FILE_PAGE_MAX_LIMIT,
    ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::devices::access::DeviceActor;
use crate::devices::main_db::MainDb;
use crate::entities::{device, login, organism};
use crate::file_registry::entities::file_entry;
use crate::file_registry::{connect_runtime, run_migrations, FileRegistryDb};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::h;
use crate::types::{AppError, Mode, ShortContext, Uuid};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, IntoActiveModel,
    QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::error::Error as StdError;
use std::fmt;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

async fn insert_device(
    db: &DatabaseConnection,
    id: Uuid,
    owner: &login::Model,
    source_label: &str,
    timestamp: NaiveDateTime,
) {
    device::ActiveModel {
        id: Set(id),
        name: Set(Some("Filesystem fixture device".to_string())),
        created_by: Set(owner.login.clone()),
        organism_id: Set(owner.organism_id.unwrap()),
        unit_id: Set(None),
        tags: Set(json!([])),
        external_url: Set(None),
        archived: Set(false),
        archived_at: Set(None),
        created_at: Set(timestamp),
        updated_at: Set(timestamp),
        source_label: Set(source_label.to_string()),
        custom_fields: Set(json!({})),
    }
    .insert(db)
    .await
    .unwrap();
}

async fn insert_device_owner(
    db: &DatabaseConnection,
    prefix: &str,
) -> login::Model {
    let organism = mk_organism(
        db,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_login(
        db,
        login::ActiveModel {
            login: Set(format!("{prefix}-{}", Uuid::now_v7())),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn insert_file_entry(
    db: &DatabaseConnection,
    entry: file_entry::ActiveModel,
) {
    entry.insert(db).await.unwrap();
}

fn root_entry(
    id: Uuid,
    device_id: Uuid,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    base_file_entry(
        id,
        device_id,
        None,
        "directory",
        "/",
        Some("posix"),
        None,
        uuid_label(id),
        timestamp,
    )
}

fn directory_entry(
    id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    parent_hierarchy_path: &str,
    name: &str,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    base_file_entry(
        id,
        device_id,
        Some(parent_id),
        "directory",
        name,
        None,
        None,
        format!("{parent_hierarchy_path}.{}", uuid_label(id)),
        timestamp,
    )
}

fn file_entry_row(
    id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    parent_hierarchy_path: &str,
    name: &str,
    absolute_path: &str,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    let mut entry = base_file_entry(
        id,
        device_id,
        Some(parent_id),
        "file",
        name,
        Some("posix"),
        Some(absolute_path),
        format!("{parent_hierarchy_path}.{}", uuid_label(id)),
        timestamp,
    );
    entry.mime_type = Set(Some("text/plain".to_string()));
    entry.extension = Set(Some("log".to_string()));
    entry.file_metadata_created_at = Set(Some(timestamp - Duration::hours(2)));
    entry.file_metadata_modified_at = Set(Some(timestamp - Duration::hours(1)));
    entry
}

fn base_file_entry(
    id: Uuid,
    device_id: Uuid,
    parent_id: Option<Uuid>,
    kind: &str,
    name: &str,
    path_syntax: Option<&str>,
    absolute_path: Option<&str>,
    hierarchy_path: String,
    timestamp: NaiveDateTime,
) -> file_entry::ActiveModel {
    file_entry::ActiveModel {
        id: Set(id),
        device_id: Set(device_id),
        parent_id: Set(parent_id),
        kind: Set(kind.to_string()),
        name: Set(name.to_string()),
        name_key: Set(name.as_bytes().to_vec()),
        path_syntax: Set(path_syntax.map(str::to_string)),
        absolute_path: Set(absolute_path.map(str::to_string)),
        hierarchy_path: Set(hierarchy_path),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(timestamp),
        updated_at: Set(timestamp),
        content_path: Set(None),
    }
}

fn uuid_label(id: Uuid) -> String {
    format!("n{}", id.to_string().replace('-', ""))
}

async fn truncate_file_entries(db: &DatabaseConnection) {
    db.execute_unprepared("truncate table public.file_entry")
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn stage_two_runtime_scopes_filters_ltree_and_cursor_contracts() {
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let tree = insert_stage_two_tree(db, timestamp).await;
    let repository = FilesystemRepository::new(&file_registry_db);
    let reports_scope = assert_directory_scope_lookup(&repository, &tree).await;

    assert_ltree_predicates(db, &tree).await;
    assert_scope_rules(db, &reports_scope, &tree).await;
    assert_literal_name_filters(db, &reports_scope, &tree).await;
    assert_exact_metadata_filters(db, &reports_scope, &tree).await;
    assert_duplicate_name_key_pagination(
        db,
        &repository,
        &reports_scope,
        &tree,
    )
    .await;
    assert_file_move_round_trip(db, &tree, timestamp).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_four_scoped_search_filters_paths_and_cursor() {
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let tree = insert_stage_two_tree(db, timestamp).await;
    let repository = FilesystemRepository::new(&file_registry_db);
    let reports_scope = repository
        .find_directory_scope(tree.device_id, tree.reports_id)
        .await
        .unwrap();

    assert_stage_four_subtree_and_paths(&repository, &reports_scope, &tree)
        .await;
    assert_stage_four_filters(&repository, &reports_scope, &tree).await;
    assert_stage_four_duplicate_pagination(&repository, &reports_scope, &tree)
        .await;
    assert_stage_four_query_counts(db, &reports_scope).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_three_root_listing_browse_and_breadcrumbs() {
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let forest = insert_stage_three_forest(db, timestamp).await;
    let repository = FilesystemRepository::new(&file_registry_db);

    assert_stage_three_root_listing(&repository, &forest).await;
    let navigation_scope = repository
        .find_directory_scope(forest.target_device_id, forest.navigation_id)
        .await
        .unwrap();
    let same_scope = repository
        .find_directory_scope(forest.target_device_id, forest.same_directory_id)
        .await
        .unwrap();
    assert_stage_three_direct_children(&repository, &navigation_scope, &forest)
        .await;
    assert_stage_three_invalid_directory_scopes(&repository, &forest).await;
    assert_stage_three_breadcrumbs(&repository, &same_scope, &forest).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eight_read_service_authorizes_and_composes_roots_browse_search()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-eight").await;
    let forest =
        insert_stage_three_forest(env.file_registry_db.connection(), timestamp)
            .await;
    let tree =
        insert_stage_two_tree(env.file_registry_db.connection(), timestamp)
            .await;
    insert_device(
        &env.dbx,
        forest.target_device_id,
        &owner,
        "stage-eight-active",
        timestamp,
    )
    .await;
    insert_device(
        &env.dbx,
        tree.device_id,
        &owner,
        "stage-eight-archived",
        timestamp,
    )
    .await;
    archive_device(&env.dbx, tree.device_id, timestamp).await;

    for (login, roles) in [
        ("stage-eight-cyber", &[ROLE_CYBER][..]),
        ("stage-eight-source", &[ROLE_DEVICE_SOURCE][..]),
        ("stage-eight-analyst", &[ROLE_DEVICE_ANALYST][..]),
        ("stage-eight-admin", &[ROLE_ADMIN][..]),
    ] {
        let actor = crate::devices::access::test_support::device_actor(
            login,
            owner.organism_id.unwrap(),
            roles,
        );
        assert_stage_eight_actor_reads(
            &env.dbx,
            &env.file_registry_db,
            &actor,
            &forest,
            &tree,
        )
        .await;
    }

    let admin = crate::devices::access::test_support::device_actor(
        "stage-eight-admin",
        owner.organism_id.unwrap(),
        &[ROLE_ADMIN],
    );
    assert_stage_eight_browse_composition(
        &env.dbx,
        &env.file_registry_db,
        &admin,
        &forest,
    )
    .await;
    let duplicate_cursor = assert_stage_eight_search_composition(
        &env.dbx,
        &env.file_registry_db,
        &admin,
        &tree,
    )
    .await;
    assert_stage_eight_validation_contract(
        &env.dbx,
        &env.file_registry_db,
        &admin,
        &forest,
        &tree,
        &duplicate_cursor,
        timestamp,
    )
    .await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eight_read_service_short_circuits_and_preserves_safe_errors() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-eight").await;
    let tree =
        insert_stage_two_tree(env.file_registry_db.connection(), timestamp)
            .await;
    let forest =
        insert_stage_three_forest(env.file_registry_db.connection(), timestamp)
            .await;
    insert_device(
        &env.dbx,
        tree.device_id,
        &owner,
        "stage-eight-visible",
        timestamp,
    )
    .await;
    insert_device(
        &env.dbx,
        tree.other_device_id,
        &owner,
        "stage-eight-other",
        timestamp,
    )
    .await;

    let actor = crate::devices::access::test_support::device_actor(
        "stage-eight-admin",
        owner.organism_id.unwrap(),
        &[ROLE_ADMIN],
    );
    assert_stage_eight_live_scope_errors(
        &env.dbx,
        &env.file_registry_db,
        &actor,
        &tree,
    )
    .await;

    let outage_db = connect_runtime(&env.config, Mode::Test).await.unwrap();
    outage_db.connection().clone().close().await.unwrap();
    let unauthorized = crate::devices::access::test_support::device_actor(
        "stage-eight-none",
        owner.organism_id.unwrap(),
        &[],
    );
    assert_stage_eight_outage_short_circuits(
        &env.dbx,
        &outage_db,
        &unauthorized,
        &actor,
        &tree,
        &forest,
    )
    .await;
}

struct StageTwoTree {
    device_id: Uuid,
    other_device_id: Uuid,
    root_id: Uuid,
    reports_id: Uuid,
    archive_id: Uuid,
    archive_file_id: Uuid,
    nested_file_id: Uuid,
    duplicate_file_ids: [Uuid; 3],
    percent_file_id: Uuid,
    percent_noise_file_id: Uuid,
    underscore_file_id: Uuid,
    underscore_noise_file_id: Uuid,
    backslash_file_id: Uuid,
    backslash_noise_file_id: Uuid,
    metadata_file_id: Uuid,
    metadata_noise_file_id: Uuid,
    metadata_modified_at: NaiveDateTime,
    movable_file_id: Uuid,
    outside_file_id: Uuid,
    same_device_sibling_file_id: Uuid,
    reports_path: String,
    archive_path: String,
}

async fn insert_stage_two_tree(
    db: &DatabaseConnection,
    timestamp: NaiveDateTime,
) -> StageTwoTree {
    let device_id = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1000);
    let other_device_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1100);
    let root_id = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1200);
    let reports_id = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1300);
    let archive_id = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1400);
    let archive_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2400);
    let nested_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1500);
    let duplicate_file_ids = [
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1600),
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1700),
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1800),
    ];
    let percent_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1900);
    let percent_noise_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1a00);
    let underscore_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1b00);
    let underscore_noise_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1c00);
    let backslash_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1d00);
    let backslash_noise_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1e00);
    let metadata_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_1f00);
    let metadata_noise_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2000);
    let movable_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2100);
    let same_device_sibling_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2500);
    let other_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2200);
    let outside_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_2300);
    let root_path = uuid_label(root_id);
    let reports_path = format!("{root_path}.{}", uuid_label(reports_id));
    let archive_path = format!("{reports_path}.{}", uuid_label(archive_id));
    let other_root_path = uuid_label(other_root_id);
    let metadata_modified_at = timestamp + Duration::hours(3);

    insert_file_entry(db, root_entry(root_id, device_id, timestamp)).await;
    insert_file_entry(
        db,
        directory_entry(
            reports_id, device_id, root_id, &root_path, "reports", timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        directory_entry(
            archive_id,
            device_id,
            reports_id,
            &reports_path,
            "archive",
            timestamp,
        ),
    )
    .await;
    insert_stage_two_file(
        db,
        archive_file_id,
        device_id,
        reports_id,
        &reports_path,
        "archive",
        "/reports/archive",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        nested_file_id,
        device_id,
        archive_id,
        &archive_path,
        "nested.log",
        "/reports/archive/nested.log",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    for duplicate_file_id in duplicate_file_ids {
        insert_stage_two_file(
            db,
            duplicate_file_id,
            device_id,
            reports_id,
            &reports_path,
            "duplicate",
            "/reports/duplicate",
            "text/plain",
            "log",
            timestamp,
            timestamp,
        )
        .await;
    }
    insert_stage_two_file(
        db,
        percent_file_id,
        device_id,
        reports_id,
        &reports_path,
        "literal%value",
        "/reports/literal%value",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        percent_noise_file_id,
        device_id,
        reports_id,
        &reports_path,
        "literalXvalue",
        "/reports/literalXvalue",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        underscore_file_id,
        device_id,
        reports_id,
        &reports_path,
        "under_score",
        "/reports/under_score",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        underscore_noise_file_id,
        device_id,
        reports_id,
        &reports_path,
        "underXscore",
        "/reports/underXscore",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        backslash_file_id,
        device_id,
        reports_id,
        &reports_path,
        r"back\slash",
        r"\reports\back\slash",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        backslash_noise_file_id,
        device_id,
        reports_id,
        &reports_path,
        "backXslash",
        "/reports/backXslash",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        metadata_file_id,
        device_id,
        reports_id,
        &reports_path,
        "metadata.pdf",
        "/reports/metadata.pdf",
        "application/pdf",
        "pdf",
        timestamp,
        metadata_modified_at,
    )
    .await;
    insert_stage_two_file(
        db,
        metadata_noise_file_id,
        device_id,
        reports_id,
        &reports_path,
        "metadata-old.pdf",
        "/reports/metadata-old.pdf",
        "application/pdf",
        "pdf",
        timestamp,
        metadata_modified_at - Duration::seconds(1),
    )
    .await;
    insert_stage_two_file(
        db,
        movable_file_id,
        device_id,
        reports_id,
        &reports_path,
        "movable.log",
        "/reports/movable.log",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_stage_two_file(
        db,
        same_device_sibling_file_id,
        device_id,
        root_id,
        &root_path,
        "sibling.log",
        "/sibling.log",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;
    insert_file_entry(
        db,
        root_entry(other_root_id, other_device_id, timestamp),
    )
    .await;
    insert_stage_two_file(
        db,
        outside_file_id,
        other_device_id,
        other_root_id,
        &other_root_path,
        "outside.log",
        "/other/outside.log",
        "text/plain",
        "log",
        timestamp,
        timestamp,
    )
    .await;

    StageTwoTree {
        device_id,
        other_device_id,
        root_id,
        reports_id,
        archive_id,
        archive_file_id,
        nested_file_id,
        duplicate_file_ids,
        percent_file_id,
        percent_noise_file_id,
        underscore_file_id,
        underscore_noise_file_id,
        backslash_file_id,
        backslash_noise_file_id,
        metadata_file_id,
        metadata_noise_file_id,
        metadata_modified_at,
        movable_file_id,
        outside_file_id,
        same_device_sibling_file_id,
        reports_path,
        archive_path,
    }
}

async fn insert_stage_two_file(
    db: &DatabaseConnection,
    id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    parent_hierarchy_path: &str,
    name: &str,
    absolute_path: &str,
    mime_type: &str,
    extension: &str,
    created_at: NaiveDateTime,
    modified_at: NaiveDateTime,
) {
    let mut entry = file_entry_row(
        id,
        device_id,
        parent_id,
        parent_hierarchy_path,
        name,
        absolute_path,
        created_at,
    );
    entry.mime_type = Set(Some(mime_type.to_string()));
    entry.extension = Set(Some(extension.to_string()));
    entry.file_metadata_modified_at = Set(Some(modified_at));
    insert_file_entry(db, entry).await;
}

async fn assert_directory_scope_lookup(
    repository: &FilesystemRepository<'_>,
    tree: &StageTwoTree,
) -> super::DirectoryScope {
    let scope = repository
        .find_directory_scope(tree.device_id, tree.reports_id)
        .await
        .unwrap();
    assert_eq!(scope.device_id(), tree.device_id);
    assert_eq!(scope.entry_id(), tree.reports_id);
    assert!(matches!(
        repository
            .find_directory_scope(tree.other_device_id, tree.reports_id)
            .await,
        Err(FilesystemError::NotFound)
    ));
    assert!(matches!(
        repository
            .find_directory_scope(tree.device_id, tree.nested_file_id)
            .await,
        Err(FilesystemError::NotFound)
    ));
    scope
}

async fn assert_ltree_predicates(db: &DatabaseConnection, tree: &StageTwoTree) {
    let nested = file_entry::Entity::find_by_id(tree.nested_file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        nested.hierarchy_path,
        format!("{}.{}", tree.archive_path, uuid_label(tree.nested_file_id))
    );

    let descendants = file_entry::Entity::find()
        .filter(descendant_expr(&tree.reports_path))
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect::<Vec<_>>();
    assert!(descendants.contains(&tree.reports_id));
    assert!(descendants.contains(&tree.archive_id));
    assert!(descendants.contains(&tree.nested_file_id));
    assert!(!descendants.contains(&tree.root_id));
    assert!(!descendants.contains(&tree.outside_file_id));

    let mut ancestors = file_entry::Entity::find()
        .filter(ancestor_expr(&tree.archive_path))
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect::<Vec<_>>();
    ancestors.sort_unstable();
    assert_eq!(
        ancestors,
        vec![tree.root_id, tree.reports_id, tree.archive_id]
    );
}

async fn assert_scope_rules(
    db: &DatabaseConnection,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let browse = EntryQueryScope::Browse(reports_scope);
    let browse_ids = scoped_entry_ids(db, &browse, None, None).await;
    assert!(browse_ids.contains(&tree.archive_id));
    assert!(browse_ids.contains(&tree.duplicate_file_ids[0]));
    assert!(!browse_ids.contains(&tree.reports_id));
    assert!(!browse_ids.contains(&tree.nested_file_id));
    assert!(!browse_ids.contains(&tree.outside_file_id));

    let all_filters = FileSearchFilters::try_from(RawFileSearchFilters {
        kinds: Vec::new(),
        name_query: None,
        mime_types: Vec::new(),
        extensions: Vec::new(),
        file_metadata_modified_from: None,
        file_metadata_modified_to: None,
    })
    .unwrap();
    let search = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &all_filters,
    };
    let search_ids = scoped_entry_ids(db, &search, None, None).await;
    assert!(search_ids.contains(&tree.archive_id));
    assert!(search_ids.contains(&tree.nested_file_id));
    assert!(!search_ids.contains(&tree.reports_id));
    assert!(!search_ids.contains(&tree.root_id));
    assert!(!search_ids.contains(&tree.outside_file_id));
}

async fn assert_literal_name_filters(
    db: &DatabaseConnection,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    for (name_query, expected_id) in [
        ("literal%value", tree.percent_file_id),
        ("under_score", tree.underscore_file_id),
        (r"back\slash", tree.backslash_file_id),
    ] {
        let filters = search_filters(Some(name_query), &[], &[], None, None);
        let scope = EntryQueryScope::Search {
            directory: reports_scope,
            filters: &filters,
        };
        assert_eq!(
            scoped_entry_ids(db, &scope, None, None).await,
            vec![expected_id]
        );
    }
}

async fn assert_exact_metadata_filters(
    db: &DatabaseConnection,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters = search_filters(
        None,
        &["application/pdf"],
        &["pdf"],
        Some(tree.metadata_modified_at),
        Some(tree.metadata_modified_at),
    );
    let scope = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &filters,
    };
    assert_eq!(
        scoped_entry_ids(db, &scope, None, None).await,
        vec![tree.metadata_file_id]
    );
}

async fn assert_duplicate_name_key_pagination(
    db: &DatabaseConnection,
    repository: &FilesystemRepository<'_>,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters = search_filters(Some("duplicate"), &[], &[], None, None);
    let scope = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &filters,
    };
    let first_page = scoped_entry_ids(db, &scope, None, Some(2)).await;
    assert_eq!(
        first_page,
        vec![tree.duplicate_file_ids[0], tree.duplicate_file_ids[1]]
    );

    let cursor = FileCursorCodec::encode(first_page[1]);
    let boundary_entry_id = FileCursorCodec::decode(&cursor).unwrap();
    let after = repository
        .resolve_cursor_entry_sort_key(boundary_entry_id, &scope)
        .await
        .unwrap();
    let second_page = scoped_entry_ids(db, &scope, Some(&after), Some(2)).await;

    assert_eq!(second_page, vec![tree.duplicate_file_ids[2]]);
    assert_eq!([first_page, second_page].concat(), tree.duplicate_file_ids);
}

async fn assert_file_move_round_trip(
    db: &DatabaseConnection,
    tree: &StageTwoTree,
    timestamp: NaiveDateTime,
) {
    let mut movable = file_entry::Entity::find_by_id(tree.movable_file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    let expected_hierarchy_path =
        format!("{}.{}", tree.archive_path, uuid_label(tree.movable_file_id));
    movable.parent_id = Set(Some(tree.archive_id));
    movable.absolute_path =
        Set(Some("/reports/archive/movable.log".to_string()));
    movable.hierarchy_path = Set(expected_hierarchy_path.clone());
    movable.updated_at = Set(timestamp + Duration::seconds(1));
    movable.save(db).await.unwrap();

    let moved = file_entry::Entity::find_by_id(tree.movable_file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.parent_id, Some(tree.archive_id));
    assert_eq!(
        moved.absolute_path.as_deref(),
        Some("/reports/archive/movable.log")
    );
    assert_eq!(moved.hierarchy_path, expected_hierarchy_path);
}

async fn assert_stage_four_subtree_and_paths(
    repository: &FilesystemRepository<'_>,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters = search_filters_with_kinds(&[], None, &[], &[], None, None);
    let page = repository
        .search_entries(
            reports_scope,
            &filters,
            KeysetPageRequest::try_new(Some(100), None).unwrap(),
        )
        .await
        .unwrap();
    let entry_ids = search_entry_ids(&page.entries);
    let expected_ids = [
        tree.archive_id,
        tree.archive_file_id,
        tree.nested_file_id,
        tree.duplicate_file_ids[0],
        tree.duplicate_file_ids[1],
        tree.duplicate_file_ids[2],
        tree.percent_file_id,
        tree.percent_noise_file_id,
        tree.underscore_file_id,
        tree.underscore_noise_file_id,
        tree.backslash_file_id,
        tree.backslash_noise_file_id,
        tree.metadata_file_id,
        tree.metadata_noise_file_id,
        tree.movable_file_id,
    ];
    assert_eq!(entry_ids.len(), expected_ids.len());
    for expected_id in expected_ids {
        assert!(entry_ids.contains(&expected_id));
    }
    for excluded_id in [
        tree.root_id,
        tree.reports_id,
        tree.same_device_sibling_file_id,
        tree.outside_file_id,
    ] {
        assert!(!entry_ids.contains(&excluded_id));
    }

    let archive_directory_index = entry_ids
        .iter()
        .position(|entry_id| *entry_id == tree.archive_id)
        .unwrap();
    let archive_file_index = entry_ids
        .iter()
        .position(|entry_id| *entry_id == tree.archive_file_id)
        .unwrap();
    assert!(archive_directory_index < archive_file_index);
    let duplicate_ids = entry_ids
        .iter()
        .copied()
        .filter(|entry_id| tree.duplicate_file_ids.contains(entry_id))
        .collect::<Vec<_>>();
    assert_eq!(duplicate_ids, tree.duplicate_file_ids);
    assert_eq!(
        find_search_entry(&page.entries, tree.archive_id).path_components,
        vec!["reports".to_string(), "archive".to_string()]
    );
    assert_eq!(
        find_search_entry(&page.entries, tree.archive_file_id).path_components,
        vec!["reports".to_string(), "archive".to_string()]
    );
    assert_eq!(
        find_search_entry(&page.entries, tree.nested_file_id).path_components,
        vec![
            "reports".to_string(),
            "archive".to_string(),
            "nested.log".to_string(),
        ]
    );
}

async fn assert_stage_four_filters(
    repository: &FilesystemRepository<'_>,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    for (name_query, expected_id) in [
        ("literal%value", tree.percent_file_id),
        ("under_score", tree.underscore_file_id),
        (r"back\slash", tree.backslash_file_id),
    ] {
        let filters = search_filters_with_kinds(
            &[],
            Some(name_query),
            &[],
            &[],
            None,
            None,
        );
        let page = repository
            .search_entries(
                reports_scope,
                &filters,
                KeysetPageRequest::try_new(None, None).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(search_entry_ids(&page.entries), vec![expected_id]);
    }

    let metadata_filters = search_filters_with_kinds(
        &[],
        None,
        &["application/pdf"],
        &["pdf"],
        Some(tree.metadata_modified_at),
        Some(tree.metadata_modified_at),
    );
    let metadata_page = repository
        .search_entries(
            reports_scope,
            &metadata_filters,
            KeysetPageRequest::try_new(None, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        search_entry_ids(&metadata_page.entries),
        vec![tree.metadata_file_id]
    );
    assert!(matches!(
        &metadata_page.entries[0].entry,
        TreeEntry::File(_)
    ));

    let directory_filters = search_filters_with_kinds(
        &[FileEntryKind::Directory],
        None,
        &[],
        &[],
        None,
        None,
    );
    let directory_page = repository
        .search_entries(
            reports_scope,
            &directory_filters,
            KeysetPageRequest::try_new(None, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        search_entry_ids(&directory_page.entries),
        vec![tree.archive_id]
    );
}

async fn assert_stage_four_duplicate_pagination(
    repository: &FilesystemRepository<'_>,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters =
        search_filters_with_kinds(&[], Some("duplicate"), &[], &[], None, None);
    let first_page = repository
        .search_entries(
            reports_scope,
            &filters,
            KeysetPageRequest::try_new(Some(2), None).unwrap(),
        )
        .await
        .unwrap();
    let first_entry_ids = search_entry_ids(&first_page.entries);
    assert_eq!(
        first_entry_ids,
        vec![tree.duplicate_file_ids[0], tree.duplicate_file_ids[1]]
    );
    let next = first_page.next.clone().unwrap();
    let cursor = FileCursorCodec::encode(next.entry_id());
    let boundary_entry_id = FileCursorCodec::decode(&cursor).unwrap();
    let query_scope = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &filters,
    };
    let after = repository
        .resolve_cursor_entry_sort_key(boundary_entry_id, &query_scope)
        .await
        .unwrap();
    assert_eq!(after, next);
    let second_page = repository
        .search_entries(
            reports_scope,
            &filters,
            KeysetPageRequest::try_new(Some(2), Some(after)).unwrap(),
        )
        .await
        .unwrap();
    let second_entry_ids = search_entry_ids(&second_page.entries);
    assert_eq!(second_entry_ids, vec![tree.duplicate_file_ids[2]]);
    assert_eq!(
        [first_entry_ids, second_entry_ids].concat(),
        tree.duplicate_file_ids
    );

    let changed_filters =
        search_filters_with_kinds(&[], Some("archive"), &[], &[], None, None);
    let changed_filter_scope = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &changed_filters,
    };
    assert!(matches!(
        repository
            .resolve_cursor_entry_sort_key(
                boundary_entry_id,
                &changed_filter_scope
            )
            .await,
        Err(FilesystemError::Validation(_))
    ));
    let archive_scope = repository
        .find_directory_scope(tree.device_id, tree.archive_id)
        .await
        .unwrap();
    let changed_directory_scope = EntryQueryScope::Search {
        directory: &archive_scope,
        filters: &filters,
    };
    assert!(matches!(
        repository
            .resolve_cursor_entry_sort_key(
                boundary_entry_id,
                &changed_directory_scope
            )
            .await,
        Err(FilesystemError::Validation(_))
    ));
}

async fn assert_stage_four_query_counts(
    db: &DatabaseConnection,
    reports_scope: &super::DirectoryScope,
) {
    let filters =
        search_filters_with_kinds(&[], Some("duplicate"), &[], &[], None, None);
    let query_count = Arc::new(AtomicUsize::new(0));
    let callback_count = Arc::clone(&query_count);
    let mut measured_db = db.clone();
    measured_db.set_metric_callback(move |_| {
        callback_count.fetch_add(1, Ordering::SeqCst);
    });

    let nonempty_page = query::search_entries(
        &measured_db,
        reports_scope,
        &filters,
        KeysetPageRequest::try_new(Some(2), None).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(nonempty_page.entries.len(), 2);
    assert_eq!(query_count.load(Ordering::SeqCst), 2);

    query_count.store(0, Ordering::SeqCst);
    let empty_filters = search_filters_with_kinds(
        &[],
        Some("not-present"),
        &[],
        &[],
        None,
        None,
    );
    let empty_page = query::search_entries(
        &measured_db,
        reports_scope,
        &empty_filters,
        KeysetPageRequest::try_new(None, None).unwrap(),
    )
    .await
    .unwrap();
    assert!(empty_page.entries.is_empty());
    assert_eq!(query_count.load(Ordering::SeqCst), 1);
}

fn search_entry_ids(entries: &[SearchEntry]) -> Vec<Uuid> {
    entries.iter().map(search_entry_id).collect()
}

fn search_entry_id(entry: &SearchEntry) -> Uuid {
    match &entry.entry {
        TreeEntry::Directory(directory) => directory.entry_id,
        TreeEntry::File(file) => file.file_id,
    }
}

fn find_search_entry(entries: &[SearchEntry], entry_id: Uuid) -> &SearchEntry {
    entries
        .iter()
        .find(|entry| search_entry_id(entry) == entry_id)
        .unwrap()
}

fn search_filters(
    name_query: Option<&str>,
    mime_types: &[&str],
    extensions: &[&str],
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
) -> FileSearchFilters {
    search_filters_with_kinds(
        &[FileEntryKind::File],
        name_query,
        mime_types,
        extensions,
        file_metadata_modified_from,
        file_metadata_modified_to,
    )
}

fn search_filters_with_kinds(
    kinds: &[FileEntryKind],
    name_query: Option<&str>,
    mime_types: &[&str],
    extensions: &[&str],
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
) -> FileSearchFilters {
    FileSearchFilters::try_from(RawFileSearchFilters {
        kinds: kinds.to_vec(),
        name_query: name_query.map(str::to_string),
        mime_types: mime_types.iter().map(ToString::to_string).collect(),
        extensions: extensions.iter().map(ToString::to_string).collect(),
        file_metadata_modified_from,
        file_metadata_modified_to,
    })
    .unwrap()
}

async fn scoped_entry_ids(
    db: &DatabaseConnection,
    scope: &EntryQueryScope<'_>,
    after: Option<&EntrySortKey>,
    limit: Option<u64>,
) -> Vec<Uuid> {
    let mut query =
        query::core::apply_entry_scope(file_entry::Entity::find(), scope);
    query = query::core::apply_entry_order(query);
    if let Some(after) = after {
        query = query.filter(query::core::entry_strict_after_condition(after));
    }
    if let Some(limit) = limit {
        query = query.limit(limit);
    }
    query
        .all(db)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect()
}

struct StageThreeForest {
    empty_device_id: Uuid,
    single_root_device_id: Uuid,
    target_device_id: Uuid,
    other_device_id: Uuid,
    single_root_id: Uuid,
    target_posix_root_id: Uuid,
    target_windows_drive_root_id: Uuid,
    target_windows_unc_root_id: Uuid,
    other_root_id: Uuid,
    navigation_id: Uuid,
    same_directory_id: Uuid,
    zeta_directory_id: Uuid,
    aaa_file_id: Uuid,
    same_file_ids: [Uuid; 3],
    nested_file_id: Uuid,
    sibling_file_id: Uuid,
    other_file_id: Uuid,
}

async fn insert_stage_three_forest(
    db: &DatabaseConnection,
    timestamp: NaiveDateTime,
) -> StageThreeForest {
    let empty_device_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3000);
    let single_root_device_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3100);
    let target_device_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3200);
    let other_device_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3300);
    let single_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3400);
    let target_posix_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3500);
    let target_windows_drive_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3600);
    let target_windows_unc_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3700);
    let other_root_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3800);
    let navigation_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3900);
    let same_directory_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3a00);
    let zeta_directory_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3b00);
    let aaa_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3c00);
    let same_file_ids = [
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3d00),
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3e00),
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_3f00),
    ];
    let nested_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_4000);
    let sibling_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_4100);
    let other_file_id =
        Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_4200);
    let single_root_path = uuid_label(single_root_id);
    let target_posix_root_path = uuid_label(target_posix_root_id);
    let navigation_path =
        format!("{target_posix_root_path}.{}", uuid_label(navigation_id));
    let same_path =
        format!("{navigation_path}.{}", uuid_label(same_directory_id));
    let other_root_path = uuid_label(other_root_id);

    insert_file_entry(
        db,
        base_file_entry(
            single_root_id,
            single_root_device_id,
            None,
            "directory",
            "/",
            Some("posix"),
            None,
            single_root_path,
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        root_entry(target_posix_root_id, target_device_id, timestamp),
    )
    .await;
    insert_file_entry(
        db,
        base_file_entry(
            target_windows_drive_root_id,
            target_device_id,
            None,
            "directory",
            "C:\\",
            Some("windows"),
            None,
            uuid_label(target_windows_drive_root_id),
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        base_file_entry(
            target_windows_unc_root_id,
            target_device_id,
            None,
            "directory",
            "\\\\server\\share\\",
            Some("windows"),
            None,
            uuid_label(target_windows_unc_root_id),
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        directory_entry(
            navigation_id,
            target_device_id,
            target_posix_root_id,
            &target_posix_root_path,
            "navigation",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        directory_entry(
            same_directory_id,
            target_device_id,
            navigation_id,
            &navigation_path,
            "same",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        directory_entry(
            zeta_directory_id,
            target_device_id,
            navigation_id,
            &navigation_path,
            "zeta",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        file_entry_row(
            aaa_file_id,
            target_device_id,
            navigation_id,
            &navigation_path,
            "aaa",
            "/navigation/aaa",
            timestamp,
        ),
    )
    .await;
    for same_file_id in same_file_ids {
        insert_file_entry(
            db,
            file_entry_row(
                same_file_id,
                target_device_id,
                navigation_id,
                &navigation_path,
                "same",
                "/navigation/same",
                timestamp,
            ),
        )
        .await;
    }
    insert_file_entry(
        db,
        file_entry_row(
            nested_file_id,
            target_device_id,
            same_directory_id,
            &same_path,
            "nested",
            "/navigation/same/nested",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        file_entry_row(
            sibling_file_id,
            target_device_id,
            target_posix_root_id,
            &target_posix_root_path,
            "sibling",
            "/sibling",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        root_entry(other_root_id, other_device_id, timestamp),
    )
    .await;
    insert_file_entry(
        db,
        file_entry_row(
            other_file_id,
            other_device_id,
            other_root_id,
            &other_root_path,
            "other",
            "/other",
            timestamp,
        ),
    )
    .await;

    StageThreeForest {
        empty_device_id,
        single_root_device_id,
        target_device_id,
        other_device_id,
        single_root_id,
        target_posix_root_id,
        target_windows_drive_root_id,
        target_windows_unc_root_id,
        other_root_id,
        navigation_id,
        same_directory_id,
        zeta_directory_id,
        aaa_file_id,
        same_file_ids,
        nested_file_id,
        sibling_file_id,
        other_file_id,
    }
}

async fn assert_stage_three_root_listing(
    repository: &FilesystemRepository<'_>,
    forest: &StageThreeForest,
) {
    assert_eq!(
        repository.list_roots(forest.empty_device_id).await.unwrap(),
        Vec::new()
    );
    assert_eq!(
        repository
            .list_roots(forest.single_root_device_id)
            .await
            .unwrap()
            .into_iter()
            .map(|root| root.entry_id)
            .collect::<Vec<_>>(),
        vec![forest.single_root_id]
    );

    let roots = repository
        .list_roots(forest.target_device_id)
        .await
        .unwrap();
    assert_eq!(
        roots
            .iter()
            .map(|root| (
                root.path_syntax,
                root.name_key.clone(),
                root.entry_id
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                PathSyntax::Posix,
                b"/".to_vec(),
                forest.target_posix_root_id,
            ),
            (
                PathSyntax::Windows,
                b"C:\\".to_vec(),
                forest.target_windows_drive_root_id,
            ),
            (
                PathSyntax::Windows,
                b"\\\\server\\share\\".to_vec(),
                forest.target_windows_unc_root_id,
            ),
        ]
    );
    assert!(!roots
        .iter()
        .any(|root| root.entry_id == forest.other_root_id));
}

async fn assert_stage_three_direct_children(
    repository: &FilesystemRepository<'_>,
    scope: &super::DirectoryScope,
    forest: &StageThreeForest,
) {
    let first_page = repository
        .list_children(
            scope,
            KeysetPageRequest::<EntrySortKey>::try_new(Some(2), None).unwrap(),
        )
        .await
        .unwrap();
    let first_entry_ids = tree_entry_ids(&first_page.entries);
    assert_eq!(
        first_entry_ids,
        vec![forest.same_directory_id, forest.zeta_directory_id]
    );
    let first_after = resolve_browse_after(
        repository,
        scope,
        first_page
            .next
            .expect("first page must continue")
            .entry_id(),
    )
    .await;

    let second_page = repository
        .list_children(
            scope,
            KeysetPageRequest::try_new(Some(2), Some(first_after)).unwrap(),
        )
        .await
        .unwrap();
    let second_entry_ids = tree_entry_ids(&second_page.entries);
    assert_eq!(
        second_entry_ids,
        vec![forest.aaa_file_id, forest.same_file_ids[0]]
    );
    let second_after = resolve_browse_after(
        repository,
        scope,
        second_page
            .next
            .expect("second page must continue")
            .entry_id(),
    )
    .await;

    let third_page = repository
        .list_children(
            scope,
            KeysetPageRequest::try_new(Some(2), Some(second_after)).unwrap(),
        )
        .await
        .unwrap();
    let third_entry_ids = tree_entry_ids(&third_page.entries);
    assert_eq!(
        third_entry_ids,
        vec![forest.same_file_ids[1], forest.same_file_ids[2]]
    );
    assert!(third_page.next.is_none());

    let entry_ids =
        [first_entry_ids, second_entry_ids, third_entry_ids].concat();
    assert_eq!(
        entry_ids,
        vec![
            forest.same_directory_id,
            forest.zeta_directory_id,
            forest.aaa_file_id,
            forest.same_file_ids[0],
            forest.same_file_ids[1],
            forest.same_file_ids[2],
        ]
    );
    assert!(!entry_ids.contains(&forest.nested_file_id));
    assert!(!entry_ids.contains(&forest.sibling_file_id));
    assert!(!entry_ids.contains(&forest.other_file_id));
}

async fn resolve_browse_after(
    repository: &FilesystemRepository<'_>,
    scope: &super::DirectoryScope,
    boundary_entry_id: Uuid,
) -> EntrySortKey {
    let cursor = FileCursorCodec::encode(boundary_entry_id);
    let boundary_entry_id = FileCursorCodec::decode(&cursor).unwrap();
    let query_scope = EntryQueryScope::Browse(scope);

    repository
        .resolve_cursor_entry_sort_key(boundary_entry_id, &query_scope)
        .await
        .unwrap()
}

async fn assert_stage_three_invalid_directory_scopes(
    repository: &FilesystemRepository<'_>,
    forest: &StageThreeForest,
) {
    assert!(matches!(
        repository
            .find_directory_scope(forest.target_device_id, forest.aaa_file_id)
            .await,
        Err(FilesystemError::NotFound)
    ));
    assert!(matches!(
        repository
            .find_directory_scope(
                forest.other_device_id,
                forest.same_directory_id
            )
            .await,
        Err(FilesystemError::NotFound)
    ));
}

async fn assert_stage_three_breadcrumbs(
    repository: &FilesystemRepository<'_>,
    same_scope: &super::DirectoryScope,
    forest: &StageThreeForest,
) {
    let root_scope = repository
        .find_directory_scope(
            forest.target_device_id,
            forest.target_posix_root_id,
        )
        .await
        .unwrap();
    assert_eq!(
        repository.list_breadcrumbs(&root_scope).await.unwrap(),
        vec![Breadcrumb {
            entry_id: forest.target_posix_root_id,
            name: "/".to_string(),
        }]
    );
    assert_eq!(
        repository.list_breadcrumbs(same_scope).await.unwrap(),
        vec![
            Breadcrumb {
                entry_id: forest.target_posix_root_id,
                name: "/".to_string(),
            },
            Breadcrumb {
                entry_id: forest.navigation_id,
                name: "navigation".to_string(),
            },
            Breadcrumb {
                entry_id: forest.same_directory_id,
                name: "same".to_string(),
            },
        ]
    );
}

fn tree_entry_ids(entries: &[TreeEntry]) -> Vec<Uuid> {
    entries
        .iter()
        .map(|entry| match entry {
            TreeEntry::Directory(directory) => directory.entry_id,
            TreeEntry::File(file) => file.file_id,
        })
        .collect()
}

fn stage_eight_timestamp() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 7, 22)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap()
}

async fn archive_device(
    db: &DatabaseConnection,
    device_id: Uuid,
    timestamp: NaiveDateTime,
) {
    let mut device = device::Entity::find_by_id(device_id)
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    device.archived = Set(true);
    device.archived_at = Set(Some(timestamp));
    device.update(db).await.unwrap();
}

async fn assert_stage_eight_actor_reads(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    actor: &DeviceActor,
    forest: &StageThreeForest,
    tree: &StageTwoTree,
) {
    let active_roots = FileMetadataService::list_roots(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        forest.target_device_id,
    )
    .await
    .unwrap();
    assert_eq!(
        active_roots
            .iter()
            .map(|root| root.entry_id)
            .collect::<Vec<_>>(),
        vec![
            forest.target_posix_root_id,
            forest.target_windows_drive_root_id,
            forest.target_windows_unc_root_id,
        ]
    );

    let archived_roots = FileMetadataService::list_roots(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        tree.device_id,
    )
    .await
    .unwrap();
    assert_eq!(
        archived_roots
            .iter()
            .map(|root| root.entry_id)
            .collect::<Vec<_>>(),
        vec![tree.root_id]
    );

    let active_browse = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.same_directory_id,
            include_breadcrumbs: false,
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        tree_entry_ids(&active_browse.entries),
        vec![forest.nested_file_id]
    );

    let archived_browse = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: tree.device_id,
            parent_entry_id: tree.reports_id,
            include_breadcrumbs: false,
            limit: Some(1),
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        tree_entry_ids(&archived_browse.entries),
        vec![tree.archive_id]
    );

    let active_search = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: forest.target_device_id,
            scope_entry_id: forest.navigation_id,
            filters: raw_search_filters(Some("same"), &[], &[], None, None),
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        search_entry_ids(&active_search.entries),
        vec![
            forest.same_directory_id,
            forest.same_file_ids[0],
            forest.same_file_ids[1],
            forest.same_file_ids[2],
        ]
    );

    let archived_search = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(Some("archive"), &[], &[], None, None),
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        search_entry_ids(&archived_search.entries),
        vec![tree.archive_id, tree.archive_file_id]
    );
}

async fn assert_stage_eight_browse_composition(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    actor: &DeviceActor,
    forest: &StageThreeForest,
) {
    let default_page = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.same_directory_id,
            include_breadcrumbs: true,
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        default_page.breadcrumbs,
        vec![
            Breadcrumb {
                entry_id: forest.target_posix_root_id,
                name: "/".to_string(),
            },
            Breadcrumb {
                entry_id: forest.navigation_id,
                name: "navigation".to_string(),
            },
            Breadcrumb {
                entry_id: forest.same_directory_id,
                name: "same".to_string(),
            },
        ]
    );
    assert_eq!(
        tree_entry_ids(&default_page.entries),
        vec![forest.nested_file_id]
    );
    assert!(default_page.next_cursor.is_none());

    let without_breadcrumbs = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.same_directory_id,
            include_breadcrumbs: false,
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert!(without_breadcrumbs.breadcrumbs.is_empty());
    assert_eq!(
        tree_entry_ids(&without_breadcrumbs.entries),
        vec![forest.nested_file_id]
    );
    assert_eq!(
        default_page.entry_path_components,
        vec![vec![
            "navigation".to_string(),
            "same".to_string(),
            "nested".to_string(),
        ]],
    );
    assert_eq!(
        without_breadcrumbs.entry_path_components,
        default_page.entry_path_components,
    );

    let first_page = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.navigation_id,
            include_breadcrumbs: false,
            limit: Some(2),
            cursor: None,
        },
    )
    .await
    .unwrap();
    let first_cursor = first_page
        .next_cursor
        .clone()
        .expect("first browse page must continue");
    let first_entry_ids = tree_entry_ids(&first_page.entries);
    assert_eq!(
        first_entry_ids,
        vec![forest.same_directory_id, forest.zeta_directory_id]
    );

    let second_page = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.navigation_id,
            include_breadcrumbs: false,
            limit: Some(2),
            cursor: Some(first_cursor),
        },
    )
    .await
    .unwrap();
    let second_cursor = second_page
        .next_cursor
        .clone()
        .expect("second browse page must continue");
    let second_entry_ids = tree_entry_ids(&second_page.entries);
    assert_eq!(
        second_entry_ids,
        vec![forest.aaa_file_id, forest.same_file_ids[0]]
    );

    let third_page = FileMetadataService::browse(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        BrowseFilesCommand {
            device_id: forest.target_device_id,
            parent_entry_id: forest.navigation_id,
            include_breadcrumbs: false,
            limit: Some(2),
            cursor: Some(second_cursor),
        },
    )
    .await
    .unwrap();
    let third_entry_ids = tree_entry_ids(&third_page.entries);
    assert_eq!(
        third_entry_ids,
        vec![forest.same_file_ids[1], forest.same_file_ids[2]]
    );
    assert!(third_page.next_cursor.is_none());
    assert_eq!(
        [first_entry_ids, second_entry_ids, third_entry_ids].concat(),
        vec![
            forest.same_directory_id,
            forest.zeta_directory_id,
            forest.aaa_file_id,
            forest.same_file_ids[0],
            forest.same_file_ids[1],
            forest.same_file_ids[2],
        ]
    );
}

async fn assert_stage_eight_search_composition(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    actor: &DeviceActor,
    tree: &StageTwoTree,
) -> String {
    let scoped_search = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(None, &[], &[], None, None),
            limit: Some(100),
            cursor: None,
        },
    )
    .await
    .unwrap();
    let scoped_entry_ids = search_entry_ids(&scoped_search.entries);
    assert!(scoped_entry_ids.contains(&tree.archive_id));
    assert!(scoped_entry_ids.contains(&tree.nested_file_id));
    assert!(!scoped_entry_ids.contains(&tree.reports_id));
    assert_eq!(
        find_search_entry(&scoped_search.entries, tree.nested_file_id)
            .path_components,
        vec![
            "reports".to_string(),
            "archive".to_string(),
            "nested.log".to_string(),
        ]
    );

    let literal_search = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(
                Some("literal%value"),
                &[],
                &[],
                None,
                None,
            ),
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        search_entry_ids(&literal_search.entries),
        vec![tree.percent_file_id]
    );

    let technical_search = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(
                None,
                &["application/pdf"],
                &["pdf"],
                Some(tree.metadata_modified_at),
                Some(tree.metadata_modified_at),
            ),
            limit: None,
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        search_entry_ids(&technical_search.entries),
        vec![tree.metadata_file_id]
    );

    let first_page = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(
                Some("duplicate"),
                &[],
                &[],
                None,
                None,
            ),
            limit: Some(2),
            cursor: None,
        },
    )
    .await
    .unwrap();
    let duplicate_cursor = first_page
        .next_cursor
        .clone()
        .expect("first duplicate search page must continue");
    let first_entry_ids = search_entry_ids(&first_page.entries);
    assert_eq!(
        first_entry_ids,
        vec![tree.duplicate_file_ids[0], tree.duplicate_file_ids[1]]
    );

    let second_page = FileMetadataService::search(
        MainDb::new(main_db),
        file_registry_db,
        actor,
        SearchFilesCommand {
            device_id: tree.device_id,
            scope_entry_id: tree.reports_id,
            filters: raw_search_filters(
                Some("duplicate"),
                &[],
                &[],
                None,
                None,
            ),
            limit: Some(2),
            cursor: Some(duplicate_cursor.clone()),
        },
    )
    .await
    .unwrap();
    let second_entry_ids = search_entry_ids(&second_page.entries);
    assert_eq!(second_entry_ids, vec![tree.duplicate_file_ids[2]]);
    assert_eq!(
        [first_entry_ids, second_entry_ids].concat(),
        tree.duplicate_file_ids.to_vec()
    );

    duplicate_cursor
}

async fn assert_stage_eight_validation_contract(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    actor: &DeviceActor,
    forest: &StageThreeForest,
    tree: &StageTwoTree,
    duplicate_cursor: &str,
    timestamp: NaiveDateTime,
) {
    assert_form_error(
        FileMetadataService::browse(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            BrowseFilesCommand {
                device_id: forest.target_device_id,
                parent_entry_id: forest.navigation_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: Some("not-a-uuid".to_string()),
            },
        )
        .await
        .unwrap_err(),
        "cursor",
        "invalid cursor",
    );
    assert_form_error(
        FileMetadataService::browse(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            BrowseFilesCommand {
                device_id: forest.target_device_id,
                parent_entry_id: forest.navigation_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: Some("a".repeat(DEVICE_FILE_CURSOR_MAX_BYTES + 1)),
            },
        )
        .await
        .unwrap_err(),
        "cursor",
        "invalid cursor",
    );
    assert_form_error(
        FileMetadataService::browse(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            BrowseFilesCommand {
                device_id: forest.target_device_id,
                parent_entry_id: forest.navigation_id,
                include_breadcrumbs: false,
                limit: Some(0),
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
        "limit",
        &format!("must be between 1 and {DEVICE_FILE_PAGE_MAX_LIMIT}"),
    );
    assert_form_error(
        FileMetadataService::search(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: tree.reports_id,
                filters: raw_search_filters(
                    Some("archive"),
                    &[],
                    &[],
                    None,
                    None,
                ),
                limit: Some(2),
                cursor: Some(duplicate_cursor.to_string()),
            },
        )
        .await
        .unwrap_err(),
        "cursor",
        "invalid cursor",
    );
    assert_form_error(
        FileMetadataService::search(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: tree.archive_id,
                filters: raw_search_filters(
                    Some("duplicate"),
                    &[],
                    &[],
                    None,
                    None,
                ),
                limit: Some(2),
                cursor: Some(duplicate_cursor.to_string()),
            },
        )
        .await
        .unwrap_err(),
        "cursor",
        "invalid cursor",
    );
    assert_form_error(
        FileMetadataService::search(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: tree.reports_id,
                filters: raw_search_filters(
                    None,
                    &[],
                    &[],
                    Some(timestamp + Duration::seconds(1)),
                    Some(timestamp),
                ),
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
        "file_metadata_modified_from",
        "must be before or equal to file_metadata_modified_to",
    );
}

async fn assert_stage_eight_live_scope_errors(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    actor: &DeviceActor,
    tree: &StageTwoTree,
) {
    assert_not_found(
        FileMetadataService::browse(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            BrowseFilesCommand {
                device_id: tree.other_device_id,
                parent_entry_id: tree.reports_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
    assert_not_found(
        FileMetadataService::browse(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            BrowseFilesCommand {
                device_id: tree.device_id,
                parent_entry_id: tree.archive_file_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
    assert_not_found(
        FileMetadataService::search(
            MainDb::new(main_db),
            file_registry_db,
            actor,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: Uuid::from_u128(
                    0x018f_0000_0000_7000_8000_0000_0000_9000,
                ),
                filters: raw_search_filters(None, &[], &[], None, None),
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
}

async fn assert_stage_eight_outage_short_circuits(
    main_db: &DatabaseConnection,
    outage_db: &FileRegistryDb,
    unauthorized: &DeviceActor,
    actor: &DeviceActor,
    tree: &StageTwoTree,
    forest: &StageThreeForest,
) {
    assert_forbidden(
        FileMetadataService::list_roots(
            MainDb::new(main_db),
            outage_db,
            unauthorized,
            tree.device_id,
        )
        .await
        .unwrap_err(),
    );
    assert_forbidden(
        FileMetadataService::browse(
            MainDb::new(main_db),
            outage_db,
            unauthorized,
            BrowseFilesCommand {
                device_id: tree.device_id,
                parent_entry_id: tree.reports_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
    assert_forbidden(
        FileMetadataService::search(
            MainDb::new(main_db),
            outage_db,
            unauthorized,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: tree.reports_id,
                filters: raw_search_filters(None, &[], &[], None, None),
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );

    assert_not_found(
        FileMetadataService::list_roots(
            MainDb::new(main_db),
            outage_db,
            actor,
            forest.single_root_device_id,
        )
        .await
        .unwrap_err(),
    );
    assert_not_found(
        FileMetadataService::browse(
            MainDb::new(main_db),
            outage_db,
            actor,
            BrowseFilesCommand {
                device_id: forest.single_root_device_id,
                parent_entry_id: forest.single_root_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
    assert_not_found(
        FileMetadataService::search(
            MainDb::new(main_db),
            outage_db,
            actor,
            SearchFilesCommand {
                device_id: forest.single_root_device_id,
                scope_entry_id: forest.single_root_id,
                filters: raw_search_filters(None, &[], &[], None, None),
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );

    assert_dependency_filesystem_error(
        FileMetadataService::list_roots(
            MainDb::new(main_db),
            outage_db,
            actor,
            tree.device_id,
        )
        .await
        .unwrap_err(),
    );
    assert_dependency_filesystem_error(
        FileMetadataService::browse(
            MainDb::new(main_db),
            outage_db,
            actor,
            BrowseFilesCommand {
                device_id: tree.device_id,
                parent_entry_id: tree.reports_id,
                include_breadcrumbs: false,
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
    assert_dependency_filesystem_error(
        FileMetadataService::search(
            MainDb::new(main_db),
            outage_db,
            actor,
            SearchFilesCommand {
                device_id: tree.device_id,
                scope_entry_id: tree.reports_id,
                filters: raw_search_filters(None, &[], &[], None, None),
                limit: None,
                cursor: None,
            },
        )
        .await
        .unwrap_err(),
    );
}

fn raw_search_filters(
    name_query: Option<&str>,
    mime_types: &[&str],
    extensions: &[&str],
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
) -> RawFileSearchFilters {
    RawFileSearchFilters {
        kinds: Vec::new(),
        name_query: name_query.map(str::to_string),
        mime_types: mime_types.iter().map(ToString::to_string).collect(),
        extensions: extensions.iter().map(ToString::to_string).collect(),
        file_metadata_modified_from,
        file_metadata_modified_to,
    }
}

fn assert_form_error(error: AppError, path: &str, message: &str) {
    let AppError::Form(errors) = error else {
        panic!("expected form error");
    };
    assert_eq!(errors.len(), 1);
    assert_eq!(errors.get(path), Some(&message.to_string()));
}

fn assert_forbidden(error: AppError) {
    assert!(matches!(
        error,
        AppError::Forbidden(message) if message == "device operation is forbidden"
    ));
}

fn assert_not_found(error: AppError) {
    assert!(matches!(error, AppError::NotFound));
}

fn assert_dependency_filesystem_error(error: AppError) {
    let AppError::AnyhowError { source } = error else {
        panic!("expected dependency application error");
    };
    assert_eq!(source.to_string(), "failed to read device filesystem");
    assert!(source.chain().any(|error| matches!(
        error.downcast_ref::<FilesystemError>(),
        Some(FilesystemError::Dependency(_))
    )));
}

fn stage_nine_mutation(
    device_id: Uuid,
    file_id: Option<Uuid>,
    path_syntax: PathSyntax,
    absolute_path: &str,
    mime_type: Option<&str>,
    extension: Option<&str>,
    file_metadata_created_at: Option<NaiveDateTime>,
    file_metadata_modified_at: Option<NaiveDateTime>,
) -> PreparedFileMutation {
    let source_path = SourcePathParser::parse(
        path_syntax,
        absolute_path.to_string(),
        "absolute_path",
    )
    .unwrap();
    let metadata = normalize_file_metadata(
        source_path.file_name(),
        mime_type.map(str::to_string),
        extension.map(str::to_string),
        file_metadata_created_at.map(stage_nine_datetime),
        file_metadata_modified_at.map(stage_nine_datetime),
        "metadata",
    )
    .unwrap();

    match file_id {
        Some(file_id) => PreparedFileMutation::for_update(
            device_id,
            file_id,
            source_path,
            metadata,
        ),
        None => {
            PreparedFileMutation::for_create(device_id, source_path, metadata)
        }
    }
}

fn stage_nine_datetime(
    timestamp: NaiveDateTime,
) -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::from_naive_utc_and_offset(
        timestamp,
        chrono::FixedOffset::east_opt(0).unwrap(),
    )
}

async fn stage_nine_entries(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Vec<file_entry::Model> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .order_by_asc(file_entry::Column::Id)
        .all(db)
        .await
        .unwrap()
}

fn stage_nine_root<'a>(
    entries: &'a [file_entry::Model],
    path_syntax: PathSyntax,
    name: &str,
) -> &'a file_entry::Model {
    entries
        .iter()
        .find(|entry| {
            entry.parent_id.is_none()
                && entry.kind == FileEntryKind::Directory.as_db_str()
                && entry.path_syntax.as_deref() == Some(path_syntax.as_db_str())
                && entry.name == name
        })
        .unwrap()
}

fn stage_nine_directory<'a>(
    entries: &'a [file_entry::Model],
    parent_id: Uuid,
    name: &str,
) -> &'a file_entry::Model {
    entries
        .iter()
        .find(|entry| {
            entry.parent_id == Some(parent_id)
                && entry.kind == FileEntryKind::Directory.as_db_str()
                && entry.name == name
        })
        .unwrap()
}

fn stage_nine_structure_timestamps(
    entries: &[file_entry::Model],
) -> BTreeMap<Uuid, NaiveDateTime> {
    entries
        .iter()
        .filter(|entry| entry.kind == FileEntryKind::Directory.as_db_str())
        .map(|entry| (entry.id, entry.updated_at))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_creates_and_reuses_canonical_hierarchy()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);

    let first = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Posix,
            "/var/log/app/first.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(first.operation, SyncFileOperation::Created);

    let before =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    let root_id = stage_nine_root(&before, PathSyntax::Posix, "/").id;
    let var_id = stage_nine_directory(&before, root_id, "var").id;
    let log_id = stage_nine_directory(&before, var_id, "log").id;
    let app_id = stage_nine_directory(&before, log_id, "app").id;
    let structure_timestamps = stage_nine_structure_timestamps(&before);

    let second = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Posix,
            "/var/log/app/first.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let file_log = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Posix,
            "/var/log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let after =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;

    assert_eq!(second.operation, SyncFileOperation::Created);
    assert_ne!(first.file.file_id, second.file.file_id);
    assert_eq!(first.root.entry_id, second.root.entry_id);
    assert_eq!(first.root.updated_at, second.root.updated_at);
    assert_eq!(
        stage_nine_structure_timestamps(&after),
        structure_timestamps,
    );
    assert_eq!(
        after
            .iter()
            .filter(|entry| {
                entry.parent_id.is_none()
                    && entry.kind == FileEntryKind::Directory.as_db_str()
            })
            .count(),
        1,
    );
    assert_eq!(
        after
            .iter()
            .filter(|entry| {
                entry.parent_id.is_some()
                    && entry.kind == FileEntryKind::Directory.as_db_str()
            })
            .count(),
        3,
    );
    assert_eq!(
        after
            .iter()
            .filter(|entry| entry.kind == FileEntryKind::File.as_db_str())
            .count(),
        3,
    );

    let directory_log = stage_nine_directory(&after, var_id, "log");
    let file_log_entry = after
        .iter()
        .find(|entry| {
            entry.id == file_log.file.file_id
                && entry.kind == FileEntryKind::File.as_db_str()
        })
        .unwrap();
    assert_eq!(directory_log.id, log_id);
    assert_eq!(directory_log.parent_id, file_log_entry.parent_id);
    assert_eq!(directory_log.name, file_log_entry.name);
    assert_eq!(directory_log.name_key, file_log_entry.name_key);
    assert_eq!(stage_nine_directory(&after, log_id, "app").id, app_id);
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_moves_and_prunes_atomically() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let initial_metadata_created_at = NaiveDate::from_ymd_opt(2026, 7, 22)
        .unwrap()
        .and_hms_milli_opt(8, 0, 0, 0)
        .unwrap();
    let initial_metadata_modified_at =
        initial_metadata_created_at + Duration::minutes(30);
    let updated_metadata_created_at =
        initial_metadata_created_at + Duration::hours(1);
    let updated_metadata_modified_at =
        initial_metadata_created_at + Duration::hours(2);
    let cross_metadata_created_at =
        initial_metadata_created_at + Duration::hours(3);
    let cross_metadata_modified_at =
        initial_metadata_created_at + Duration::hours(4);

    let initial = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Posix,
            "/old/shared/nested/original.log",
            Some("text/plain"),
            Some("log"),
            Some(initial_metadata_created_at),
            Some(initial_metadata_modified_at),
        ))
        .await
        .unwrap();
    repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Posix,
            "/old/shared/keep.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let initial_entries =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    let posix_root_id =
        stage_nine_root(&initial_entries, PathSyntax::Posix, "/").id;
    let old_id =
        stage_nine_directory(&initial_entries, posix_root_id, "old").id;
    let shared_id = stage_nine_directory(&initial_entries, old_id, "shared").id;
    let nested_id =
        stage_nine_directory(&initial_entries, shared_id, "nested").id;

    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let same_root = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            Some(initial.file.file_id),
            PathSyntax::Posix,
            "/old/other/same-root.json",
            Some("application/json"),
            Some("json"),
            Some(updated_metadata_created_at),
            Some(updated_metadata_modified_at),
        ))
        .await
        .unwrap();
    assert_eq!(same_root.operation, SyncFileOperation::Updated);
    assert_eq!(same_root.file.file_id, initial.file.file_id);
    assert_eq!(same_root.file.device_id, initial.file.device_id);
    assert_eq!(same_root.file.created_at, initial.file.created_at);
    assert!(same_root.file.updated_at > initial.file.updated_at);
    let after_same =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    let other_id = stage_nine_directory(&after_same, old_id, "other").id;
    assert!(!after_same.iter().any(|entry| entry.id == nested_id));
    assert!(after_same.iter().any(|entry| entry.id == shared_id));

    let cross_root_mutation = stage_nine_mutation(
        device_id,
        Some(initial.file.file_id),
        PathSyntax::Windows,
        r"C:\archive\cross-root.bin",
        Some("application/octet-stream"),
        Some("bin"),
        Some(cross_metadata_created_at),
        Some(cross_metadata_modified_at),
    );
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let cross_root =
        repository.mutate_file(&cross_root_mutation).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let repeated = repository.mutate_file(&cross_root_mutation).await.unwrap();

    assert_eq!(cross_root.file.file_id, initial.file.file_id);
    assert_eq!(cross_root.file.device_id, initial.file.device_id);
    assert_eq!(cross_root.file.created_at, initial.file.created_at);
    assert!(cross_root.file.updated_at > same_root.file.updated_at);
    assert!(repeated.file.updated_at > cross_root.file.updated_at);
    assert_eq!(repeated.file.path_syntax, PathSyntax::Windows);
    assert_eq!(repeated.file.absolute_path, r"C:\archive\cross-root.bin");
    assert_eq!(
        repeated.file.mime_type.as_deref(),
        Some("application/octet-stream"),
    );
    assert_eq!(repeated.file.extension.as_deref(), Some("bin"));
    assert_eq!(
        repeated.file.file_metadata_created_at,
        Some(cross_metadata_created_at),
    );
    assert_eq!(
        repeated.file.file_metadata_modified_at,
        Some(cross_metadata_modified_at),
    );

    let after_cross =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    assert_eq!(
        after_cross
            .iter()
            .filter(|entry| {
                entry.parent_id.is_none()
                    && entry.kind == FileEntryKind::Directory.as_db_str()
            })
            .count(),
        2,
    );
    assert_eq!(
        stage_nine_root(&after_cross, PathSyntax::Posix, "/").id,
        posix_root_id,
    );
    assert_eq!(
        stage_nine_root(&after_cross, PathSyntax::Windows, "C:\\").id,
        repeated.root.entry_id,
    );
    assert!(after_cross.iter().any(|entry| entry.id == old_id));
    assert!(after_cross.iter().any(|entry| entry.id == shared_id));
    assert!(!after_cross.iter().any(|entry| entry.id == nested_id));
    assert!(!after_cross.iter().any(|entry| entry.id == other_id));

    let other_device_file = repository
        .mutate_file(&stage_nine_mutation(
            Uuid::now_v7(),
            None,
            PathSyntax::Posix,
            "/other-device/file.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let before_not_found =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    for file_id in [Uuid::now_v7(), shared_id, other_device_file.file.file_id] {
        let error = repository
            .mutate_file(&stage_nine_mutation(
                device_id,
                Some(file_id),
                PathSyntax::Posix,
                "/missing/path.log",
                Some("text/plain"),
                Some("log"),
                None,
                None,
            ))
            .await
            .unwrap_err();
        assert!(matches!(error, FilesystemError::NotFound));
    }
    assert_eq!(
        stage_nine_entries(env.file_registry_db.connection(), device_id).await,
        before_not_found,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_serializes_concurrent_structure_changes(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let first_file_registry_db =
        connect_runtime(&env.config, Mode::Test).await.unwrap();
    let second_file_registry_db =
        connect_runtime(&env.config, Mode::Test).await.unwrap();
    let first_repository = FilesystemRepository::new(&first_file_registry_db);
    let second_repository = FilesystemRepository::new(&second_file_registry_db);
    let first_create = stage_nine_mutation(
        device_id,
        None,
        PathSyntax::Posix,
        "/concurrent/shared/one.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let second_create = stage_nine_mutation(
        device_id,
        None,
        PathSyntax::Posix,
        "/concurrent/shared/two.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let (first, second) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                first_repository.mutate_file(&first_create),
                second_repository.mutate_file(&second_create),
            )
        })
        .await
        .expect("concurrent creates timed out");
    let first = first.unwrap();
    let second = second.unwrap();

    let seed_repository = FilesystemRepository::new(&env.file_registry_db);
    let windows = seed_repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\source\windows.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let first_move = stage_nine_mutation(
        device_id,
        Some(first.file.file_id),
        PathSyntax::Windows,
        r"C:\destination\posix.log",
        Some("application/json"),
        Some("json"),
        None,
        None,
    );
    let second_move = stage_nine_mutation(
        device_id,
        Some(windows.file.file_id),
        PathSyntax::Posix,
        "/concurrent/destination/windows.log",
        Some("application/json"),
        Some("json"),
        None,
        None,
    );
    let (first_move, second_move) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                first_repository.mutate_file(&first_move),
                second_repository.mutate_file(&second_move),
            )
        })
        .await
        .expect("opposite root moves timed out");
    let first_move = first_move.unwrap();
    let second_move = second_move.unwrap();

    assert_eq!(first_move.file.file_id, first.file.file_id);
    assert_eq!(second_move.file.file_id, windows.file.file_id);
    let entries =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    let roots = entries
        .iter()
        .filter(|entry| {
            entry.parent_id.is_none()
                && entry.kind == FileEntryKind::Directory.as_db_str()
        })
        .collect::<Vec<_>>();
    let root_identities = roots
        .iter()
        .map(|entry| (entry.path_syntax.clone(), entry.name_key.clone()))
        .collect::<HashSet<_>>();
    assert_eq!(roots.len(), 2);
    assert_eq!(root_identities.len(), roots.len());

    let directories = entries
        .iter()
        .filter(|entry| {
            entry.parent_id.is_some()
                && entry.kind == FileEntryKind::Directory.as_db_str()
        })
        .collect::<Vec<_>>();
    let directory_identities = directories
        .iter()
        .map(|entry| (entry.parent_id.unwrap(), entry.name_key.clone()))
        .collect::<HashSet<_>>();
    assert_eq!(directory_identities.len(), directories.len());

    let files = entries
        .iter()
        .filter(|entry| entry.kind == FileEntryKind::File.as_db_str())
        .collect::<Vec<_>>();
    let expected_paths = [
        "/concurrent/shared/two.log",
        r"C:\destination\posix.log",
        "/concurrent/destination/windows.log",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<HashSet<_>>();
    let actual_paths = files
        .iter()
        .map(|entry| entry.absolute_path.clone().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(files.len(), 3);
    assert_eq!(actual_paths, expected_paths);
    for file in files {
        let parent = entries
            .iter()
            .find(|entry| {
                entry.id == file.parent_id.unwrap()
                    && entry.device_id == device_id
                    && entry.kind == FileEntryKind::Directory.as_db_str()
            })
            .unwrap();
        assert_eq!(
            file.hierarchy_path,
            format!("{}.{}", parent.hierarchy_path, uuid_label(file.id)),
        );
        let root_label = file.hierarchy_path.split('.').next().unwrap();
        let root = roots
            .iter()
            .find(|entry| entry.hierarchy_path == root_label)
            .unwrap();
        assert_eq!(file.path_syntax, root.path_syntax);
        assert!(file.absolute_path.is_some());
    }

    assert_ne!(first.file.file_id, second.file.file_id);
}

fn stage_ten_command(
    device_id: Uuid,
    path_syntax: PathSyntax,
    files: Vec<SyncFileItemCommand>,
) -> SyncFilesCommand {
    SyncFilesCommand {
        device_id,
        path_syntax,
        files,
    }
}

fn stage_ten_file(
    file_id: Option<Uuid>,
    absolute_path: &str,
) -> SyncFileItemCommand {
    SyncFileItemCommand {
        file_id,
        absolute_path: absolute_path.to_string(),
        mime_type: None,
        extension: None,
        file_metadata_created_at: None,
        file_metadata_modified_at: None,
    }
}

fn stage_ten_accepted_file<'a>(
    result: &'a SyncFileItemResult,
    index: usize,
    operation: SyncFileOperation,
    root_name: &str,
    absolute_path: &str,
    expected_path_components: &[&str],
) -> &'a FileEntry {
    assert_eq!(result.index, index);
    let SyncFileItemOutcome::Accepted {
        operation: actual_operation,
        root,
        file,
        path_components,
    } = &result.outcome
    else {
        panic!("expected accepted sync result");
    };

    assert_eq!(*actual_operation, operation);
    assert_eq!(root.name, root_name);
    assert_eq!(file.absolute_path, absolute_path);
    assert_eq!(file.path_syntax, root.path_syntax);
    assert_eq!(
        path_components,
        &expected_path_components
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    );
    file
}

fn assert_stage_ten_rejected(
    result: &SyncFileItemResult,
    index: usize,
    kind: SyncFileRejectionKind,
    message: &str,
    retry: bool,
    expected_field_paths: &[&str],
) {
    assert_eq!(result.index, index);
    let SyncFileItemOutcome::Rejected {
        kind: actual_kind,
        message: actual_message,
        retry: actual_retry,
        field_errors,
    } = &result.outcome
    else {
        panic!("expected rejected sync result");
    };

    assert_eq!(*actual_kind, kind);
    assert_eq!(actual_message, message);
    assert_eq!(*actual_retry, retry);
    assert_eq!(
        field_errors
            .iter()
            .map(|error| error.path.as_str())
            .collect::<Vec<_>>(),
        expected_field_paths
    );
}

async fn stage_ten_registry_snapshot(
    db: &DatabaseConnection,
) -> Vec<file_entry::Model> {
    file_entry::Entity::find()
        .order_by_asc(file_entry::Column::Id)
        .all(db)
        .await
        .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn stage_ten_sync_service_returns_ordered_partial_results() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-ten").await;
    let device_id = Uuid::now_v7();
    insert_device(
        &env.dbx,
        device_id,
        &owner,
        "stage-ten-ordered-results",
        timestamp,
    )
    .await;
    let actor = crate::devices::access::test_support::device_actor(
        &owner.login,
        owner.organism_id.unwrap(),
        &[ROLE_DEVICE_SOURCE],
    );
    let result = FileMetadataService::sync(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        stage_ten_command(
            device_id,
            PathSyntax::Windows,
            vec![
                stage_ten_file(None, r"C:\logs\a.log"),
                stage_ten_file(None, "relative.log"),
                stage_ten_file(None, r"\\server\share\dir\b.txt"),
                stage_ten_file(None, r"C:\logs\a.log"),
            ],
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        result
            .results
            .iter()
            .map(|result| result.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    let first = stage_ten_accepted_file(
        &result.results[0],
        0,
        SyncFileOperation::Created,
        "C:\\",
        r"C:\logs\a.log",
        &["logs", "a.log"],
    );
    assert_eq!(first.path_syntax, PathSyntax::Windows);
    assert_stage_ten_rejected(
        &result.results[1],
        1,
        SyncFileRejectionKind::Validation,
        "filesystem validation failed",
        false,
        &["files[1].absolute_path"],
    );
    let unc = stage_ten_accepted_file(
        &result.results[2],
        2,
        SyncFileOperation::Created,
        "\\\\server\\share\\",
        r"\\server\share\dir\b.txt",
        &["dir", "b.txt"],
    );
    assert_eq!(unc.path_syntax, PathSyntax::Windows);
    let repeated = stage_ten_accepted_file(
        &result.results[3],
        3,
        SyncFileOperation::Created,
        "C:\\",
        r"C:\logs\a.log",
        &["logs", "a.log"],
    );
    assert_ne!(first.file_id, repeated.file_id);

    let entries =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.kind == FileEntryKind::File.as_db_str())
            .count(),
        3
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| {
                entry.parent_id.is_none()
                    && entry.kind == FileEntryKind::Directory.as_db_str()
            })
            .count(),
        2
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_ten_sync_service_rejects_duplicates_and_isolates_item_failures()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-ten").await;
    let target_device_id = Uuid::now_v7();
    let other_device_id = Uuid::now_v7();
    insert_device(
        &env.dbx,
        target_device_id,
        &owner,
        "stage-ten-target",
        timestamp,
    )
    .await;
    insert_device(
        &env.dbx,
        other_device_id,
        &owner,
        "stage-ten-other",
        timestamp,
    )
    .await;
    let actor = crate::devices::access::test_support::device_actor(
        &owner.login,
        owner.organism_id.unwrap(),
        &[ROLE_DEVICE_SOURCE],
    );
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let metadata_created_at = timestamp - Duration::hours(2);
    let metadata_modified_at = timestamp - Duration::hours(1);
    let duplicate = repository
        .mutate_file(&stage_nine_mutation(
            target_device_id,
            None,
            PathSyntax::Posix,
            "/seed/duplicate.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let updated = repository
        .mutate_file(&stage_nine_mutation(
            target_device_id,
            None,
            PathSyntax::Posix,
            "/existing/README.txt",
            Some("text/plain"),
            Some("txt"),
            Some(metadata_created_at),
            Some(metadata_modified_at),
        ))
        .await
        .unwrap();
    let content_path = format!("devices/{target_device_id}/content/README");
    let mut updated_file = file_entry::Entity::find_by_id(updated.file.file_id)
        .one(env.file_registry_db.connection())
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    updated_file.content_path = Set(Some(content_path.clone()));
    updated_file
        .update(env.file_registry_db.connection())
        .await
        .unwrap();
    let omitted = repository
        .mutate_file(&stage_nine_mutation(
            target_device_id,
            None,
            PathSyntax::Posix,
            "/omitted/keep.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let foreign = repository
        .mutate_file(&stage_nine_mutation(
            other_device_id,
            None,
            PathSyntax::Posix,
            "/foreign/private.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let target_before =
        stage_nine_entries(env.file_registry_db.connection(), target_device_id)
            .await;
    let duplicate_before = target_before
        .iter()
        .find(|entry| entry.id == duplicate.file.file_id)
        .unwrap()
        .clone();
    let omitted_before = target_before
        .iter()
        .find(|entry| entry.id == omitted.file.file_id)
        .unwrap()
        .clone();
    let foreign_before =
        stage_nine_entries(env.file_registry_db.connection(), other_device_id)
            .await;
    let device_updated_at_before = device::Entity::find_by_id(target_device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .updated_at;

    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let result = FileMetadataService::sync(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        stage_ten_command(
            target_device_id,
            PathSyntax::Windows,
            vec![
                stage_ten_file(
                    Some(duplicate.file.file_id),
                    r"C:\duplicate\ignored.log",
                ),
                stage_ten_file(None, r"C:\new\created.txt"),
                stage_ten_file(
                    Some(duplicate.file.file_id),
                    r"C:\duplicate\ignored-again.log",
                ),
                stage_ten_file(Some(Uuid::now_v7()), r"C:\unknown\missing.txt"),
                stage_ten_file(Some(updated.file.file_id), r"D:\moved\README"),
                stage_ten_file(
                    Some(foreign.file.file_id),
                    r"C:\foreign\private.txt",
                ),
            ],
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        result
            .results
            .iter()
            .map(|result| result.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, 5]
    );
    assert_stage_ten_rejected(
        &result.results[0],
        0,
        SyncFileRejectionKind::Validation,
        "filesystem validation failed",
        false,
        &["files[0].file_id"],
    );
    let SyncFileItemOutcome::Rejected { field_errors, .. } =
        &result.results[0].outcome
    else {
        panic!("expected duplicate rejection");
    };
    assert_eq!(field_errors[0].message, "must be unique within the batch");
    let created = stage_ten_accepted_file(
        &result.results[1],
        1,
        SyncFileOperation::Created,
        "C:\\",
        r"C:\new\created.txt",
        &["new", "created.txt"],
    );
    let created_file_id = created.file_id;
    assert!(!created.has_content);
    assert_stage_ten_rejected(
        &result.results[2],
        2,
        SyncFileRejectionKind::Validation,
        "filesystem validation failed",
        false,
        &["files[2].file_id"],
    );
    let SyncFileItemOutcome::Rejected { field_errors, .. } =
        &result.results[2].outcome
    else {
        panic!("expected duplicate rejection");
    };
    assert_eq!(field_errors[0].message, "must be unique within the batch");
    assert_stage_ten_rejected(
        &result.results[3],
        3,
        SyncFileRejectionKind::NotFound,
        "filesystem entry not found",
        false,
        &[],
    );
    let moved = stage_ten_accepted_file(
        &result.results[4],
        4,
        SyncFileOperation::Updated,
        "D:\\",
        r"D:\moved\README",
        &["moved", "README"],
    );
    assert_eq!(moved.file_id, updated.file.file_id);
    assert_eq!(moved.created_at, updated.file.created_at);
    assert!(moved.updated_at > updated.file.updated_at);
    assert_eq!(moved.mime_type, None);
    assert_eq!(moved.extension, None);
    assert_eq!(moved.file_metadata_created_at, None);
    assert_eq!(moved.file_metadata_modified_at, None);
    assert!(moved.has_content);
    let moved_updated_at = moved.updated_at;
    assert_stage_ten_rejected(
        &result.results[5],
        5,
        SyncFileRejectionKind::NotFound,
        "filesystem entry not found",
        false,
        &[],
    );

    let target_after =
        stage_nine_entries(env.file_registry_db.connection(), target_device_id)
            .await;
    assert_eq!(
        target_after
            .iter()
            .find(|entry| entry.id == duplicate.file.file_id)
            .unwrap(),
        &duplicate_before
    );
    assert_eq!(
        target_after
            .iter()
            .find(|entry| entry.id == omitted.file.file_id)
            .unwrap(),
        &omitted_before
    );
    assert!(target_after.iter().any(|entry| entry.id == created_file_id));
    assert!(target_after.iter().any(|entry| {
        entry.id == updated.file.file_id
            && entry.absolute_path.as_deref() == Some(r"D:\moved\README")
            && entry.content_path.as_deref() == Some(content_path.as_str())
    }));
    assert_eq!(
        stage_nine_entries(env.file_registry_db.connection(), other_device_id)
            .await,
        foreign_before
    );
    assert_eq!(
        device::Entity::find_by_id(target_device_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .updated_at,
        device_updated_at_before
    );

    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let repeated = FileMetadataService::sync(
        MainDb::new(&env.dbx),
        &env.file_registry_db,
        &actor,
        stage_ten_command(
            target_device_id,
            PathSyntax::Windows,
            vec![stage_ten_file(
                Some(updated.file.file_id),
                r"D:\moved\README",
            )],
        ),
    )
    .await
    .unwrap();
    let repeated = stage_ten_accepted_file(
        &repeated.results[0],
        0,
        SyncFileOperation::Updated,
        "D:\\",
        r"D:\moved\README",
        &["moved", "README"],
    );
    assert_eq!(repeated.file_id, updated.file.file_id);
    assert_eq!(repeated.created_at, updated.file.created_at);
    assert!(repeated.updated_at > moved_updated_at);
    assert!(repeated.has_content);
}

#[tokio::test]
#[serial_test::serial]
async fn stage_ten_sync_service_gates_registry_writes() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-ten").await;
    let device_id = Uuid::now_v7();
    let archived_device_id = Uuid::now_v7();
    insert_device(&env.dbx, device_id, &owner, "stage-ten-active", timestamp)
        .await;
    insert_device(
        &env.dbx,
        archived_device_id,
        &owner,
        "stage-ten-archived",
        timestamp,
    )
    .await;
    archive_device(&env.dbx, archived_device_id, timestamp).await;
    let source = crate::devices::access::test_support::device_actor(
        &owner.login,
        owner.organism_id.unwrap(),
        &[ROLE_DEVICE_SOURCE],
    );
    let unauthorized = crate::devices::access::test_support::device_actor(
        "stage-ten-none",
        owner.organism_id.unwrap(),
        &[],
    );
    let outage_db = connect_runtime(&env.config, Mode::Test).await.unwrap();
    outage_db.connection().clone().close().await.unwrap();

    assert_forbidden(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &outage_db,
            &unauthorized,
            stage_ten_command(device_id, PathSyntax::Windows, Vec::new()),
        )
        .await
        .unwrap_err(),
    );
    assert_form_error(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &outage_db,
            &source,
            stage_ten_command(device_id, PathSyntax::Windows, Vec::new()),
        )
        .await
        .unwrap_err(),
        "files",
        "must contain between 1 and 100 items",
    );
    assert_form_error(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &outage_db,
            &source,
            stage_ten_command(
                device_id,
                PathSyntax::Windows,
                vec![stage_ten_file(None, r"C:\logs\a.log"); 101],
            ),
        )
        .await
        .unwrap_err(),
        "files",
        "must contain between 1 and 100 items",
    );
    assert_not_found(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &outage_db,
            &source,
            stage_ten_command(
                Uuid::now_v7(),
                PathSyntax::Windows,
                vec![stage_ten_file(None, r"C:\logs\a.log")],
            ),
        )
        .await
        .unwrap_err(),
    );
    assert_form_error(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &outage_db,
            &source,
            stage_ten_command(
                archived_device_id,
                PathSyntax::Windows,
                vec![stage_ten_file(None, r"C:\logs\a.log")],
            ),
        )
        .await
        .unwrap_err(),
        "device_id",
        "Архівований пристрій не можна редагувати",
    );

    let before =
        stage_ten_registry_snapshot(env.file_registry_db.connection()).await;
    assert_form_error(
        FileMetadataService::sync(
            MainDb::new(&env.dbx),
            &env.file_registry_db,
            &source,
            stage_ten_command(device_id, PathSyntax::Windows, Vec::new()),
        )
        .await
        .unwrap_err(),
        "files",
        "must contain between 1 and 100 items",
    );
    assert_eq!(
        stage_ten_registry_snapshot(env.file_registry_db.connection()).await,
        before
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_ten_sync_service_main_db_outage_short_circuits_registry() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-ten").await;
    let device_id = Uuid::now_v7();
    insert_device(
        &env.dbx,
        device_id,
        &owner,
        "stage-ten-main-outage",
        timestamp,
    )
    .await;
    let source = crate::devices::access::test_support::device_actor(
        &owner.login,
        owner.organism_id.unwrap(),
        &[ROLE_DEVICE_SOURCE],
    );
    let outage_main =
        crate::new_pg_pool_from_config(&env.config).await.unwrap();
    outage_main.clone().close().await.unwrap();
    let before =
        stage_ten_registry_snapshot(env.file_registry_db.connection()).await;

    let error = FileMetadataService::sync(
        MainDb::new(&outage_main),
        &env.file_registry_db,
        &source,
        stage_ten_command(
            device_id,
            PathSyntax::Windows,
            vec![stage_ten_file(None, r"C:\logs\a.log")],
        ),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, AppError::AnyhowError { .. }));
    assert_eq!(
        stage_ten_registry_snapshot(env.file_registry_db.connection()).await,
        before
    );
}

#[derive(Debug)]
struct StageElevenDatabaseError {
    code: Option<String>,
}

impl fmt::Display for StageElevenDatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("stage eleven synthetic database error")
    }
}

impl StdError for StageElevenDatabaseError {}

impl sqlx::error::DatabaseError for StageElevenDatabaseError {
    fn message(&self) -> &str {
        "stage eleven synthetic database error"
    }

    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        self.code.as_deref().map(std::borrow::Cow::Borrowed)
    }

    fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
        self
    }

    fn into_error(
        self: Box<Self>,
    ) -> Box<dyn StdError + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> sqlx::error::ErrorKind {
        sqlx::error::ErrorKind::Other
    }
}

fn stage_eleven_database_error(code: Option<&str>) -> anyhow::Error {
    Err::<(), _>(sqlx::Error::Database(Box::new(StageElevenDatabaseError {
        code: code.map(str::to_string),
    })))
    .c(h!())
    .unwrap_err()
}

fn stage_eleven_sqlstate_error(code: &str) -> anyhow::Error {
    stage_eleven_database_error(Some(code))
}

fn stage_eleven_no_sqlstate_error() -> anyhow::Error {
    stage_eleven_database_error(None)
}

async fn stage_eleven_transaction_id(
    transaction: &DatabaseTransaction,
) -> String {
    capture_transaction_id(transaction).await.unwrap()
}

async fn stage_eleven_committed_transaction_id(
    db: &DatabaseConnection,
) -> String {
    let transaction = db.begin().await.unwrap();
    let transaction_id = stage_eleven_transaction_id(&transaction).await;
    transaction.commit().await.unwrap();
    transaction_id
}

async fn stage_eleven_aborted_transaction_id(
    db: &DatabaseConnection,
) -> String {
    let transaction = db.begin().await.unwrap();
    let transaction_id = stage_eleven_transaction_id(&transaction).await;
    transaction.rollback().await.unwrap();
    transaction_id
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_dispatches_transaction_errors_by_phase() {
    use super::TransactionErrorClass;

    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let expected = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\phase\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let committed_transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db.connection(),
    )
    .await;
    let aborted_transaction_id =
        stage_eleven_aborted_transaction_id(env.file_registry_db.connection())
            .await;

    for code in ["40001", "40P01"] {
        assert_eq!(
            classify_transaction_error(&stage_eleven_sqlstate_error(code),),
            TransactionErrorClass::Retryable,
        );
    }
    for code in ["40003", "08006", "08007"] {
        assert_eq!(
            classify_transaction_error(&stage_eleven_sqlstate_error(code),),
            TransactionErrorClass::OutcomeUncertain,
        );
    }
    assert_eq!(
        classify_transaction_error(&stage_eleven_no_sqlstate_error()),
        TransactionErrorClass::OutcomeUncertain,
    );
    assert_eq!(
        classify_transaction_error(&anyhow::anyhow!(
            "stage-eleven-synthetic-non-database"
        )),
        TransactionErrorClass::OutcomeUncertain,
    );
    assert_eq!(
        classify_transaction_error(&stage_eleven_sqlstate_error("22012"),),
        TransactionErrorClass::DatabaseFailure,
    );

    for code in ["40001", "40P01"] {
        assert!(matches!(
            map_transaction_body_error(stage_eleven_sqlstate_error(code),),
            FilesystemError::Conflict
        ));
    }
    for code in ["40003", "22012"] {
        let error =
            map_transaction_body_error(stage_eleven_sqlstate_error(code));
        let FilesystemError::Internal(source) = error else {
            panic!("body error must retain an internal source");
        };
        assert!(source
            .chain()
            .any(|source| source.downcast_ref::<sqlx::Error>().is_some()));
    }
    for code in ["08006", "08007"] {
        let error =
            map_transaction_body_error(stage_eleven_sqlstate_error(code));
        let FilesystemError::Dependency(source) = error else {
            panic!("connection error must remain a dependency");
        };
        assert!(source
            .chain()
            .any(|source| source.downcast_ref::<sqlx::Error>().is_some()));
    }
    let error = map_transaction_body_error(stage_eleven_no_sqlstate_error());
    let FilesystemError::Internal(source) = error else {
        panic!("database error without SQLSTATE must be internal in the body");
    };
    assert!(source
        .chain()
        .any(|source| source.downcast_ref::<sqlx::Error>().is_some()));
    let error = map_transaction_body_error(anyhow::anyhow!(
        "stage-eleven-synthetic-non-database"
    ));
    let FilesystemError::Internal(source) = error else {
        panic!("synthetic body error must be internal");
    };
    assert!(source
        .to_string()
        .contains("stage-eleven-synthetic-non-database"));

    for code in ["40001", "40P01"] {
        assert!(matches!(
            handle_commit_error(
                &repository,
                expected.clone(),
                committed_transaction_id.clone(),
                stage_eleven_sqlstate_error(code),
            )
            .await,
            Err(FilesystemError::Conflict)
        ));
    }
    let error = handle_commit_error(
        &repository,
        expected.clone(),
        committed_transaction_id.clone(),
        stage_eleven_sqlstate_error("22012"),
    )
    .await
    .unwrap_err();
    let FilesystemError::Internal(source) = error else {
        panic!("definite commit failure must remain internal");
    };
    assert!(source
        .chain()
        .any(|source| source.downcast_ref::<sqlx::Error>().is_some()));

    for code in ["40003", "08006", "08007"] {
        assert_eq!(
            handle_commit_error(
                &repository,
                expected.clone(),
                committed_transaction_id.clone(),
                stage_eleven_sqlstate_error(code),
            )
            .await
            .unwrap(),
            expected,
        );
        let error = handle_commit_error(
            &repository,
            expected.clone(),
            aborted_transaction_id.clone(),
            stage_eleven_sqlstate_error(code),
        )
        .await
        .unwrap_err();
        let FilesystemError::CommitUncertain(source) = error else {
            panic!("unconfirmed outcome must remain uncertain");
        };
        assert!(source
            .chain()
            .any(|source| source.downcast_ref::<sqlx::Error>().is_some()));
    }
    assert_eq!(
        handle_commit_error(
            &repository,
            expected.clone(),
            committed_transaction_id.clone(),
            stage_eleven_no_sqlstate_error(),
        )
        .await
        .unwrap(),
        expected,
    );
    assert!(matches!(
        handle_commit_error(
            &repository,
            expected.clone(),
            aborted_transaction_id.clone(),
            stage_eleven_no_sqlstate_error(),
        )
        .await,
        Err(FilesystemError::CommitUncertain(_))
    ));
    assert_eq!(
        handle_commit_error(
            &repository,
            expected.clone(),
            committed_transaction_id,
            anyhow::anyhow!("stage-eleven-synthetic-non-database"),
        )
        .await
        .unwrap(),
        expected,
    );
    let error = handle_commit_error(
        &repository,
        expected,
        aborted_transaction_id,
        anyhow::anyhow!("stage-eleven-synthetic-non-database"),
    )
    .await
    .unwrap_err();
    let FilesystemError::CommitUncertain(source) = error else {
        panic!("synthetic uncertain outcome must retain its source");
    };
    assert!(source
        .to_string()
        .contains("stage-eleven-synthetic-non-database"));
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_reconciles_committed_keyless_create() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let mutation = stage_nine_mutation(
        device_id,
        None,
        PathSyntax::Windows,
        r"C:\lost\create.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let transaction = env.file_registry_db.connection().begin().await.unwrap();
    let expected = super::mutation::mutate_file(&transaction, &mutation)
        .await
        .unwrap();
    let transaction_id = stage_eleven_transaction_id(&transaction).await;
    transaction.commit().await.unwrap();

    let repository = FilesystemRepository::new(&env.file_registry_db);
    let reconciled = handle_commit_error(
        &repository,
        expected.clone(),
        transaction_id,
        anyhow::anyhow!("stage-eleven-lost-acknowledgement"),
    )
    .await
    .unwrap();
    assert_eq!(reconciled, expected);

    let entries =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| {
                entry.kind == FileEntryKind::File.as_db_str()
                    && entry.id == expected.file.file_id
            })
            .count(),
        1,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_aborted_attempt_cannot_borrow_identical_state() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let initial = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\original\file.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let mutation = stage_nine_mutation(
        device_id,
        Some(initial.file.file_id),
        PathSyntax::Windows,
        r"E:\same\file.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let fixed_now = chrono::Utc::now().naive_utc() + Duration::seconds(1);

    let aborted = env.file_registry_db.connection().begin().await.unwrap();
    let aborted_result =
        super::mutation::mutate_file_at(&aborted, &mutation, fixed_now)
            .await
            .unwrap();
    let aborted_transaction_id = stage_eleven_transaction_id(&aborted).await;
    aborted.rollback().await.unwrap();

    let committed = env.file_registry_db.connection().begin().await.unwrap();
    let committed_result =
        super::mutation::mutate_file_at(&committed, &mutation, fixed_now)
            .await
            .unwrap();
    committed.commit().await.unwrap();
    assert_eq!(committed_result, aborted_result);

    let error = handle_commit_error(
        &repository,
        aborted_result,
        aborted_transaction_id,
        anyhow::anyhow!("stage-eleven-aborted-attribution"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_reconciliation_requires_committed_xid() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let expected = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\status\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();

    let transaction = env.file_registry_db.connection().begin().await.unwrap();
    let in_progress_transaction_id =
        stage_eleven_transaction_id(&transaction).await;
    let error = handle_commit_error(
        &repository,
        expected.clone(),
        in_progress_transaction_id,
        anyhow::anyhow!("stage-eleven-in-progress"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    transaction.rollback().await.unwrap();

    let error = handle_commit_error(
        &repository,
        expected,
        "0".to_string(),
        anyhow::anyhow!("stage-eleven-null-status"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_registry_outage_keeps_commit_uncertain() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let expected = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\outage\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db.connection(),
    )
    .await;
    let before =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;
    let outage_db = connect_runtime(&env.config, Mode::Test).await.unwrap();
    outage_db.connection().clone().close().await.unwrap();
    let outage_repository = FilesystemRepository::new(&outage_db);

    let error = handle_commit_error(
        &outage_repository,
        expected,
        transaction_id,
        anyhow::anyhow!("stage-eleven-registry-outage"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    assert_eq!(
        stage_nine_entries(env.file_registry_db.connection(), device_id).await,
        before,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_committed_xid_mismatch_keeps_commit_uncertain() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = FilesystemRepository::new(&env.file_registry_db);
    let expected = repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            None,
            PathSyntax::Windows,
            r"C:\mismatch\before.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ))
        .await
        .unwrap();
    let transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db.connection(),
    )
    .await;
    repository
        .mutate_file(&stage_nine_mutation(
            device_id,
            Some(expected.file.file_id),
            PathSyntax::Windows,
            r"D:\mismatch\after.log",
            Some("application/json"),
            Some("json"),
            None,
            None,
        ))
        .await
        .unwrap();
    let before_handler =
        stage_nine_entries(env.file_registry_db.connection(), device_id).await;

    let error = handle_commit_error(
        &repository,
        expected,
        transaction_id,
        anyhow::anyhow!("stage-eleven-committed-mismatch"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    assert_eq!(
        stage_nine_entries(env.file_registry_db.connection(), device_id).await,
        before_handler,
    );
}
