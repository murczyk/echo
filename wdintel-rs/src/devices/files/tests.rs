use super::bl;
use super::ltree::{ancestor_expr, descendant_expr};
use super::query::{self, capture_transaction_id, handle_commit_error};
use super::{
    classify_transaction_error, map_transaction_body_error,
    normalize_file_metadata, Breadcrumb, BrowseFilesCommand,
    DomainFileEntryKind, EntryQueryScope, EntrySortKey, FileEntry,
    FileSearchFilters, FilesystemError, KeysetPageRequest,
    PreparedFileMutation, RawFileSearchFilters, SearchEntry,
    SearchFilesCommand, SyncFileItemCommand, SyncFileItemOutcome,
    SyncFileItemResult, SyncFileOperation, SyncFileRejectionKind,
    SyncFilesCommand, TreeEntry,
};
use crate::config::{
    read_config, DEVICE_FILE_CURSOR_MAX_BYTES, DEVICE_FILE_PAGE_MAX_LIMIT,
    DEVICE_FILE_SYNC_BATCH_MAX_COUNT, ROLE_ADMIN,
};
use crate::devices::access;
use crate::devices::{ROLE_CYBER, ROLE_DEVICE_SOURCE};
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
        DomainFileEntryKind::Directory,
        "C:\\",
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
        DomainFileEntryKind::Directory,
        name,
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
        DomainFileEntryKind::File,
        name,
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
    kind: DomainFileEntryKind,
    name: &str,
    absolute_path: Option<&str>,
    hierarchy_path: String,
    timestamp: NaiveDateTime,
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
    let _cleanup_guard = crate::functest::tests::lock_cleanup().await;
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db =
        connect_runtime(&config, Mode::Test).await.unwrap().unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let tree = insert_stage_two_tree(db, timestamp).await;
    let repository = &file_registry_db;
    let reports_scope = assert_directory_scope_lookup(repository, &tree).await;

    assert_ltree_predicates(db, &tree).await;
    assert_scope_rules(db, &reports_scope, &tree).await;
    assert_literal_name_filters(db, &reports_scope, &tree).await;
    assert_exact_metadata_filters(db, &reports_scope, &tree).await;
    assert_duplicate_name_key_pagination(db, repository, &reports_scope, &tree)
        .await;
    assert_file_move_round_trip(db, &tree, timestamp).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_four_scoped_search_filters_paths_and_cursor() {
    let _cleanup_guard = crate::functest::tests::lock_cleanup().await;
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db =
        connect_runtime(&config, Mode::Test).await.unwrap().unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let tree = insert_stage_two_tree(db, timestamp).await;
    let repository = &file_registry_db;
    let reports_scope = query::find_directory_scope(
        repository,
        tree.device_id,
        tree.reports_id,
    )
    .await
    .unwrap();

    assert_stage_four_subtree_and_paths(repository, &reports_scope, &tree)
        .await;
    assert_stage_four_filters(repository, &reports_scope, &tree).await;
    assert_stage_four_duplicate_pagination(repository, &reports_scope, &tree)
        .await;
    assert_stage_four_query_counts(db, &reports_scope).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_three_root_listing_browse_and_breadcrumbs() {
    let _cleanup_guard = crate::functest::tests::lock_cleanup().await;
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db =
        connect_runtime(&config, Mode::Test).await.unwrap().unwrap();
    let db = file_registry_db.connection();
    truncate_file_entries(db).await;

    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let forest = insert_stage_three_forest(db, timestamp).await;
    let repository = &file_registry_db;

    assert_stage_three_root_listing(repository, &forest).await;
    let navigation_scope = query::find_directory_scope(
        repository,
        forest.target_device_id,
        forest.navigation_id,
    )
    .await
    .unwrap();
    let same_scope = query::find_directory_scope(
        repository,
        forest.target_device_id,
        forest.same_directory_id,
    )
    .await
    .unwrap();
    assert_stage_three_direct_children(repository, &navigation_scope, &forest)
        .await;
    assert_stage_three_invalid_directory_scopes(repository, &forest).await;
    assert_stage_three_breadcrumbs(repository, &same_scope, &forest).await;

    truncate_file_entries(db).await;
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eight_read_service_authorizes_and_composes_roots_browse_search()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = stage_eight_timestamp();
    let owner = insert_device_owner(&env.dbx, "filesystem-stage-eight").await;
    let forest = insert_stage_three_forest(
        env.file_registry_db().unwrap().connection(),
        timestamp,
    )
    .await;
    let tree = insert_stage_two_tree(
        env.file_registry_db().unwrap().connection(),
        timestamp,
    )
    .await;
    insert_device(&env.dbx, forest.target_device_id, &owner, timestamp).await;
    insert_device(&env.dbx, tree.device_id, &owner, timestamp).await;
    archive_device(&env.dbx, tree.device_id, timestamp).await;

    for roles in [
        &[ROLE_CYBER][..],
        &[ROLE_DEVICE_SOURCE][..],
        &[ROLE_ADMIN][..],
    ] {
        let actor = access::login_with_roles(&owner, roles);
        assert_stage_eight_actor_reads(
            &env.dbx,
            env.file_registry_db().unwrap(),
            &actor,
            &forest,
            &tree,
        )
        .await;
    }

    let admin = access::login_with_roles(&owner, &[ROLE_ADMIN]);
    assert_stage_eight_browse_composition(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &admin,
        &forest,
    )
    .await;
    let duplicate_cursor = assert_stage_eight_search_composition(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &admin,
        &tree,
    )
    .await;
    assert_stage_eight_validation_contract(
        &env.dbx,
        env.file_registry_db().unwrap(),
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
    let tree = insert_stage_two_tree(
        env.file_registry_db().unwrap().connection(),
        timestamp,
    )
    .await;
    let forest = insert_stage_three_forest(
        env.file_registry_db().unwrap().connection(),
        timestamp,
    )
    .await;
    insert_device(&env.dbx, tree.device_id, &owner, timestamp).await;
    insert_device(&env.dbx, tree.other_device_id, &owner, timestamp).await;

    let actor = access::login_with_roles(&owner, &[ROLE_ADMIN]);
    assert_stage_eight_live_scope_errors(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        &tree,
    )
    .await;

    let outage_db = connect_runtime(&env.config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    outage_db.connection().clone().close().await.unwrap();
    let unauthorized = access::login_with_roles(&owner, &[]);
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
        r"C:\reports\archive",
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
        r"C:\reports\archive\nested.log",
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
            r"C:\reports\duplicate",
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
        r"C:\reports\literal%value",
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
        r"C:\reports\literalXvalue",
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
        r"C:\reports\under_score",
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
        r"C:\reports\underXscore",
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
        r"C:\reports\back\slash",
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
        r"C:\reports\backXslash",
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
        r"C:\reports\metadata.pdf",
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
        r"C:\reports\metadata-old.pdf",
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
        r"C:\reports\movable.log",
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
        r"C:\sibling.log",
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
        r"C:\other\outside.log",
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
    repository: &FileRegistryDb,
    tree: &StageTwoTree,
) -> super::DirectoryScope {
    let scope = query::find_directory_scope(
        repository,
        tree.device_id,
        tree.reports_id,
    )
    .await
    .unwrap();
    assert_eq!(scope.device_id(), tree.device_id);
    assert_eq!(scope.entry_id(), tree.reports_id);
    assert!(matches!(
        query::find_directory_scope(
            repository,
            tree.other_device_id,
            tree.reports_id,
        )
        .await,
        Err(FilesystemError::NotFound)
    ));
    assert!(matches!(
        query::find_directory_scope(
            repository,
            tree.device_id,
            tree.nested_file_id,
        )
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
    repository: &FileRegistryDb,
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

    let cursor = crate::devices::files::cursor::encode(first_page[1]);
    let boundary_entry_id =
        crate::devices::files::cursor::decode(&cursor).unwrap();
    let after = query::resolve_cursor_entry_sort_key(
        repository,
        boundary_entry_id,
        &scope,
    )
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
        Set(Some(r"C:\reports\archive\movable.log".to_string()));
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
        Some(r"C:\reports\archive\movable.log")
    );
    assert_eq!(moved.hierarchy_path, expected_hierarchy_path);
}

async fn assert_stage_four_subtree_and_paths(
    repository: &FileRegistryDb,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters = search_filters_with_kinds(&[], None, &[], &[], None, None);
    let page = query::search_entries(
        repository,
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
    repository: &FileRegistryDb,
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
        let page = query::search_entries(
            repository,
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
    let metadata_page = query::search_entries(
        repository,
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
        &[DomainFileEntryKind::Directory],
        None,
        &[],
        &[],
        None,
        None,
    );
    let directory_page = query::search_entries(
        repository,
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
    repository: &FileRegistryDb,
    reports_scope: &super::DirectoryScope,
    tree: &StageTwoTree,
) {
    let filters =
        search_filters_with_kinds(&[], Some("duplicate"), &[], &[], None, None);
    let first_page = query::search_entries(
        repository,
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
    let cursor = crate::devices::files::cursor::encode(next.entry_id());
    let boundary_entry_id =
        crate::devices::files::cursor::decode(&cursor).unwrap();
    let query_scope = EntryQueryScope::Search {
        directory: reports_scope,
        filters: &filters,
    };
    let after = query::resolve_cursor_entry_sort_key(
        repository,
        boundary_entry_id,
        &query_scope,
    )
    .await
    .unwrap();
    assert_eq!(after, next);
    let second_page = query::search_entries(
        repository,
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
        query::resolve_cursor_entry_sort_key(
            repository,
            boundary_entry_id,
            &changed_filter_scope,
        )
        .await,
        Err(FilesystemError::Validation(_))
    ));
    let archive_scope = query::find_directory_scope(
        repository,
        tree.device_id,
        tree.archive_id,
    )
    .await
    .unwrap();
    let changed_directory_scope = EntryQueryScope::Search {
        directory: &archive_scope,
        filters: &filters,
    };
    assert!(matches!(
        query::resolve_cursor_entry_sort_key(
            repository,
            boundary_entry_id,
            &changed_directory_scope,
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

    let nonempty_page = query::search_entries_on_connection(
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
    let empty_page = query::search_entries_on_connection(
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
        &[DomainFileEntryKind::File],
        name_query,
        mime_types,
        extensions,
        file_metadata_modified_from,
        file_metadata_modified_to,
    )
}

fn search_filters_with_kinds(
    kinds: &[DomainFileEntryKind],
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
    target_primary_root_id: Uuid,
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
    let target_primary_root_id =
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
    let target_primary_root_path = uuid_label(target_primary_root_id);
    let navigation_path =
        format!("{target_primary_root_path}.{}", uuid_label(navigation_id));
    let same_path =
        format!("{navigation_path}.{}", uuid_label(same_directory_id));
    let other_root_path = uuid_label(other_root_id);

    insert_file_entry(
        db,
        base_file_entry(
            single_root_id,
            single_root_device_id,
            None,
            DomainFileEntryKind::Directory,
            "C:\\",
            None,
            single_root_path,
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        root_entry(target_primary_root_id, target_device_id, timestamp),
    )
    .await;
    insert_file_entry(
        db,
        base_file_entry(
            target_windows_drive_root_id,
            target_device_id,
            None,
            DomainFileEntryKind::Directory,
            "D:\\",
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
            DomainFileEntryKind::Directory,
            "\\\\server\\share\\",
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
            target_primary_root_id,
            &target_primary_root_path,
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
            r"C:\navigation\aaa",
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
                r"C:\navigation\same",
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
            r"C:\navigation\same\nested",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        db,
        file_entry_row(
            sibling_file_id,
            target_device_id,
            target_primary_root_id,
            &target_primary_root_path,
            "sibling",
            r"C:\sibling",
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
            r"C:\other",
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
        target_primary_root_id,
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
    repository: &FileRegistryDb,
    forest: &StageThreeForest,
) {
    assert_eq!(
        query::list_roots(repository, forest.empty_device_id)
            .await
            .unwrap(),
        Vec::new()
    );
    assert_eq!(
        query::list_roots(repository, forest.single_root_device_id)
            .await
            .unwrap()
            .into_iter()
            .map(|root| root.entry_id)
            .collect::<Vec<_>>(),
        vec![forest.single_root_id]
    );

    let roots = query::list_roots(repository, forest.target_device_id)
        .await
        .unwrap();
    assert_eq!(
        roots
            .iter()
            .map(|root| (root.name.clone(), root.entry_id))
            .collect::<Vec<_>>(),
        vec![
            ("C:\\".to_string(), forest.target_primary_root_id),
            ("D:\\".to_string(), forest.target_windows_drive_root_id),
            (
                "\\\\server\\share\\".to_string(),
                forest.target_windows_unc_root_id,
            ),
        ]
    );
    assert!(!roots
        .iter()
        .any(|root| root.entry_id == forest.other_root_id));
}

async fn assert_stage_three_direct_children(
    repository: &FileRegistryDb,
    scope: &super::DirectoryScope,
    forest: &StageThreeForest,
) {
    let first_page = query::list_children(
        repository,
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

    let second_page = query::list_children(
        repository,
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

    let third_page = query::list_children(
        repository,
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
    repository: &FileRegistryDb,
    scope: &super::DirectoryScope,
    boundary_entry_id: Uuid,
) -> EntrySortKey {
    let cursor = crate::devices::files::cursor::encode(boundary_entry_id);
    let boundary_entry_id =
        crate::devices::files::cursor::decode(&cursor).unwrap();
    let query_scope = EntryQueryScope::Browse(scope);

    query::resolve_cursor_entry_sort_key(
        repository,
        boundary_entry_id,
        &query_scope,
    )
    .await
    .unwrap()
}

async fn assert_stage_three_invalid_directory_scopes(
    repository: &FileRegistryDb,
    forest: &StageThreeForest,
) {
    assert!(matches!(
        query::find_directory_scope(
            repository,
            forest.target_device_id,
            forest.aaa_file_id,
        )
        .await,
        Err(FilesystemError::NotFound)
    ));
    assert!(matches!(
        query::find_directory_scope(
            repository,
            forest.other_device_id,
            forest.same_directory_id,
        )
        .await,
        Err(FilesystemError::NotFound)
    ));
}

async fn assert_stage_three_breadcrumbs(
    repository: &FileRegistryDb,
    same_scope: &super::DirectoryScope,
    forest: &StageThreeForest,
) {
    let root_scope = query::find_directory_scope(
        repository,
        forest.target_device_id,
        forest.target_primary_root_id,
    )
    .await
    .unwrap();
    assert_eq!(
        query::list_breadcrumbs(repository, &root_scope)
            .await
            .unwrap(),
        vec![Breadcrumb {
            entry_id: forest.target_primary_root_id,
            name: "C:\\".to_string(),
        }]
    );
    assert_eq!(
        query::list_breadcrumbs(repository, same_scope)
            .await
            .unwrap(),
        vec![
            Breadcrumb {
                entry_id: forest.target_primary_root_id,
                name: "C:\\".to_string(),
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
    actor: &login::Model,
    forest: &StageThreeForest,
    tree: &StageTwoTree,
) {
    let active_roots = bl::list_roots(
        main_db,
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
            forest.target_primary_root_id,
            forest.target_windows_drive_root_id,
            forest.target_windows_unc_root_id,
        ]
    );

    let archived_roots =
        bl::list_roots(main_db, file_registry_db, actor, tree.device_id)
            .await
            .unwrap();
    assert_eq!(
        archived_roots
            .iter()
            .map(|root| root.entry_id)
            .collect::<Vec<_>>(),
        vec![tree.root_id]
    );

    let active_browse = bl::browse(
        main_db,
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

    let archived_browse = bl::browse(
        main_db,
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

    let active_search = bl::search(
        main_db,
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

    let archived_search = bl::search(
        main_db,
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
    actor: &login::Model,
    forest: &StageThreeForest,
) {
    let default_page = bl::browse(
        main_db,
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
                entry_id: forest.target_primary_root_id,
                name: "C:\\".to_string(),
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

    let without_breadcrumbs = bl::browse(
        main_db,
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

    let first_page = bl::browse(
        main_db,
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

    let second_page = bl::browse(
        main_db,
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

    let third_page = bl::browse(
        main_db,
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
    actor: &login::Model,
    tree: &StageTwoTree,
) -> String {
    let scoped_search = bl::search(
        main_db,
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

    let literal_search = bl::search(
        main_db,
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

    let technical_search = bl::search(
        main_db,
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

    let first_page = bl::search(
        main_db,
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

    let second_page = bl::search(
        main_db,
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
    actor: &login::Model,
    forest: &StageThreeForest,
    tree: &StageTwoTree,
    duplicate_cursor: &str,
    timestamp: NaiveDateTime,
) {
    assert_form_error(
        bl::browse(
            main_db,
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
        bl::browse(
            main_db,
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
        bl::browse(
            main_db,
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
        bl::search(
            main_db,
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
        bl::search(
            main_db,
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
        bl::search(
            main_db,
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
    actor: &login::Model,
    tree: &StageTwoTree,
) {
    assert_not_found(
        bl::browse(
            main_db,
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
        bl::browse(
            main_db,
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
        bl::search(
            main_db,
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
    unauthorized: &login::Model,
    actor: &login::Model,
    tree: &StageTwoTree,
    forest: &StageThreeForest,
) {
    assert_forbidden(
        bl::list_roots(main_db, outage_db, unauthorized, tree.device_id)
            .await
            .unwrap_err(),
    );
    assert_forbidden(
        bl::browse(
            main_db,
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
        bl::search(
            main_db,
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
        bl::list_roots(main_db, outage_db, actor, forest.single_root_device_id)
            .await
            .unwrap_err(),
    );
    assert_not_found(
        bl::browse(
            main_db,
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
        bl::search(
            main_db,
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
        bl::list_roots(main_db, outage_db, actor, tree.device_id)
            .await
            .unwrap_err(),
    );
    assert_dependency_filesystem_error(
        bl::browse(
            main_db,
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
        bl::search(
            main_db,
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
    assert!(source
        .chain()
        .any(|error| error.to_string() == "failed to read device filesystem"));
    assert!(source.chain().any(|error| matches!(
        error.downcast_ref::<FilesystemError>(),
        Some(FilesystemError::Dependency(_))
    )));
}

fn stage_nine_mutation(
    device_id: Uuid,
    file_id: Option<Uuid>,
    absolute_path: &str,
    mime_type: Option<&str>,
    extension: Option<&str>,
    file_metadata_created_at: Option<NaiveDateTime>,
    file_metadata_modified_at: Option<NaiveDateTime>,
) -> PreparedFileMutation {
    let source_path = crate::devices::files::path::parse(
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
    name: &str,
) -> &'a file_entry::Model {
    entries
        .iter()
        .find(|entry| {
            entry.parent_id.is_none()
                && entry.kind == DomainFileEntryKind::Directory
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
                && entry.kind == DomainFileEntryKind::Directory
                && entry.name == name
        })
        .unwrap()
}

fn stage_nine_structure_timestamps(
    entries: &[file_entry::Model],
) -> BTreeMap<Uuid, NaiveDateTime> {
    entries
        .iter()
        .filter(|entry| entry.kind == DomainFileEntryKind::Directory)
        .map(|entry| (entry.id, entry.updated_at))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_creates_and_reuses_canonical_hierarchy()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = env.file_registry_db().unwrap();

    let first = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\var\log\app\first.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(first.operation, SyncFileOperation::Created);

    let before = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    let root_id = stage_nine_root(&before, "C:\\").id;
    let var_id = stage_nine_directory(&before, root_id, "var").id;
    let log_id = stage_nine_directory(&before, var_id, "log").id;
    let app_id = stage_nine_directory(&before, log_id, "app").id;
    let structure_timestamps = stage_nine_structure_timestamps(&before);

    let second = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\var\log\app\first.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let file_log = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\var\log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let after = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;

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
                    && entry.kind == DomainFileEntryKind::Directory
            })
            .count(),
        1,
    );
    assert_eq!(
        after
            .iter()
            .filter(|entry| {
                entry.parent_id.is_some()
                    && entry.kind == DomainFileEntryKind::Directory
            })
            .count(),
        3,
    );
    assert_eq!(
        after
            .iter()
            .filter(|entry| entry.kind == DomainFileEntryKind::File)
            .count(),
        3,
    );

    let directory_log = stage_nine_directory(&after, var_id, "log");
    let file_log_entry = after
        .iter()
        .find(|entry| {
            entry.id == file_log.file.file_id
                && entry.kind == DomainFileEntryKind::File
        })
        .unwrap();
    assert_eq!(directory_log.id, log_id);
    assert_eq!(directory_log.parent_id, file_log_entry.parent_id);
    assert_eq!(directory_log.name, file_log_entry.name);
    assert_eq!(stage_nine_directory(&after, log_id, "app").id, app_id);
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_moves_and_prunes_atomically() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = env.file_registry_db().unwrap();
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

    let initial = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\old\shared\nested\original.log",
            Some("text/plain"),
            Some("log"),
            Some(initial_metadata_created_at),
            Some(initial_metadata_modified_at),
        ),
    )
    .await
    .unwrap();
    query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\old\shared\keep.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let initial_entries = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    let primary_root_id = stage_nine_root(&initial_entries, "C:\\").id;
    let old_id =
        stage_nine_directory(&initial_entries, primary_root_id, "old").id;
    let shared_id = stage_nine_directory(&initial_entries, old_id, "shared").id;
    let nested_id =
        stage_nine_directory(&initial_entries, shared_id, "nested").id;

    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let same_root = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            Some(initial.file.file_id),
            r"C:\old\other\same-root.json",
            Some("application/json"),
            Some("json"),
            Some(updated_metadata_created_at),
            Some(updated_metadata_modified_at),
        ),
    )
    .await
    .unwrap();
    assert_eq!(same_root.operation, SyncFileOperation::Updated);
    assert_eq!(same_root.file.file_id, initial.file.file_id);
    assert_eq!(same_root.file.device_id, initial.file.device_id);
    assert_eq!(same_root.file.created_at, initial.file.created_at);
    assert!(same_root.file.updated_at > initial.file.updated_at);
    let after_same = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    let other_id = stage_nine_directory(&after_same, old_id, "other").id;
    assert!(!after_same.iter().any(|entry| entry.id == nested_id));
    assert!(after_same.iter().any(|entry| entry.id == shared_id));

    let cross_root_mutation = stage_nine_mutation(
        device_id,
        Some(initial.file.file_id),
        r"D:\archive\cross-root.bin",
        Some("application/octet-stream"),
        Some("bin"),
        Some(cross_metadata_created_at),
        Some(cross_metadata_modified_at),
    );
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let cross_root = query::mutate_file(repository, &cross_root_mutation)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let repeated = query::mutate_file(repository, &cross_root_mutation)
        .await
        .unwrap();

    assert_eq!(cross_root.file.file_id, initial.file.file_id);
    assert_eq!(cross_root.file.device_id, initial.file.device_id);
    assert_eq!(cross_root.file.created_at, initial.file.created_at);
    assert!(cross_root.file.updated_at > same_root.file.updated_at);
    assert!(repeated.file.updated_at > cross_root.file.updated_at);
    assert_eq!(repeated.file.absolute_path, r"D:\archive\cross-root.bin");
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

    let after_cross = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    assert_eq!(
        after_cross
            .iter()
            .filter(|entry| {
                entry.parent_id.is_none()
                    && entry.kind == DomainFileEntryKind::Directory
            })
            .count(),
        2,
    );
    assert_eq!(stage_nine_root(&after_cross, "C:\\").id, primary_root_id,);
    assert_eq!(
        stage_nine_root(&after_cross, "D:\\").id,
        repeated.root.entry_id,
    );
    assert!(after_cross.iter().any(|entry| entry.id == old_id));
    assert!(after_cross.iter().any(|entry| entry.id == shared_id));
    assert!(!after_cross.iter().any(|entry| entry.id == nested_id));
    assert!(!after_cross.iter().any(|entry| entry.id == other_id));

    let other_device_file = query::mutate_file(
        repository,
        &stage_nine_mutation(
            Uuid::now_v7(),
            None,
            r"C:\other-device\file.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let before_not_found = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    for file_id in [Uuid::now_v7(), shared_id, other_device_file.file.file_id] {
        let error = query::mutate_file(
            repository,
            &stage_nine_mutation(
                device_id,
                Some(file_id),
                r"C:\missing\path.log",
                Some("text/plain"),
                Some("log"),
                None,
                None,
            ),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, FilesystemError::NotFound));
    }
    assert_eq!(
        stage_nine_entries(
            env.file_registry_db().unwrap().connection(),
            device_id,
        )
        .await,
        before_not_found,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_nine_mutation_repository_serializes_concurrent_structure_changes(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let first_file_registry_db = connect_runtime(&env.config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    let second_file_registry_db = connect_runtime(&env.config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    let first_repository = &first_file_registry_db;
    let second_repository = &second_file_registry_db;
    let first_create = stage_nine_mutation(
        device_id,
        None,
        r"C:\concurrent\shared\one.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let second_create = stage_nine_mutation(
        device_id,
        None,
        r"C:\concurrent\shared\two.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let (first, second) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                query::mutate_file(first_repository, &first_create),
                query::mutate_file(second_repository, &second_create),
            )
        })
        .await
        .expect("concurrent creates timed out");
    let first = first.unwrap();
    let second = second.unwrap();

    let seed_repository = env.file_registry_db().unwrap();
    let secondary = query::mutate_file(
        seed_repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"D:\source\secondary.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let first_move = stage_nine_mutation(
        device_id,
        Some(first.file.file_id),
        r"D:\destination\first.log",
        Some("application/json"),
        Some("json"),
        None,
        None,
    );
    let second_move = stage_nine_mutation(
        device_id,
        Some(secondary.file.file_id),
        r"C:\concurrent\destination\second.log",
        Some("application/json"),
        Some("json"),
        None,
        None,
    );
    let (first_move, second_move) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                query::mutate_file(first_repository, &first_move),
                query::mutate_file(second_repository, &second_move),
            )
        })
        .await
        .expect("opposite root moves timed out");
    let first_move = first_move.unwrap();
    let second_move = second_move.unwrap();

    assert_eq!(first_move.file.file_id, first.file.file_id);
    assert_eq!(second_move.file.file_id, secondary.file.file_id);
    let entries = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    let roots = entries
        .iter()
        .filter(|entry| {
            entry.parent_id.is_none()
                && entry.kind == DomainFileEntryKind::Directory
        })
        .collect::<Vec<_>>();
    let root_identities = roots
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<HashSet<_>>();
    assert_eq!(roots.len(), 2);
    assert_eq!(root_identities.len(), roots.len());

    let directories = entries
        .iter()
        .filter(|entry| {
            entry.parent_id.is_some()
                && entry.kind == DomainFileEntryKind::Directory
        })
        .collect::<Vec<_>>();
    let directory_identities = directories
        .iter()
        .map(|entry| (entry.parent_id.unwrap(), entry.name.clone()))
        .collect::<HashSet<_>>();
    assert_eq!(directory_identities.len(), directories.len());

    let files = entries
        .iter()
        .filter(|entry| entry.kind == DomainFileEntryKind::File)
        .collect::<Vec<_>>();
    let expected_paths = [
        r"C:\concurrent\shared\two.log",
        r"D:\destination\first.log",
        r"C:\concurrent\destination\second.log",
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
                    && entry.kind == DomainFileEntryKind::Directory
            })
            .unwrap();
        assert_eq!(
            file.hierarchy_path,
            format!("{}.{}", parent.hierarchy_path, uuid_label(file.id)),
        );
        let root_label = file.hierarchy_path.split('.').next().unwrap();
        assert!(roots.iter().any(|entry| entry.hierarchy_path == root_label));
        assert!(file.absolute_path.is_some());
    }

    assert_ne!(first.file.file_id, second.file.file_id);
}

fn stage_ten_command(
    device_id: Uuid,
    files: Vec<SyncFileItemCommand>,
) -> SyncFilesCommand {
    SyncFilesCommand { device_id, files }
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
    insert_device(&env.dbx, device_id, &owner, timestamp).await;
    let actor = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let result = bl::sync(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        stage_ten_command(
            device_id,
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
    assert_stage_ten_rejected(
        &result.results[1],
        1,
        SyncFileRejectionKind::Validation,
        "filesystem validation failed",
        false,
        &["files[1].absolute_path"],
    );
    stage_ten_accepted_file(
        &result.results[2],
        2,
        SyncFileOperation::Created,
        "\\\\server\\share\\",
        r"\\server\share\dir\b.txt",
        &["dir", "b.txt"],
    );
    let repeated = stage_ten_accepted_file(
        &result.results[3],
        3,
        SyncFileOperation::Created,
        "C:\\",
        r"C:\logs\a.log",
        &["logs", "a.log"],
    );
    assert_ne!(first.file_id, repeated.file_id);

    let entries = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.kind == DomainFileEntryKind::File)
            .count(),
        3
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| {
                entry.parent_id.is_none()
                    && entry.kind == DomainFileEntryKind::Directory
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
    insert_device(&env.dbx, target_device_id, &owner, timestamp).await;
    insert_device(&env.dbx, other_device_id, &owner, timestamp).await;
    let actor = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let repository = env.file_registry_db().unwrap();
    let metadata_created_at = timestamp - Duration::hours(2);
    let metadata_modified_at = timestamp - Duration::hours(1);
    let duplicate = query::mutate_file(
        repository,
        &stage_nine_mutation(
            target_device_id,
            None,
            r"C:\seed\duplicate.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let updated = query::mutate_file(
        repository,
        &stage_nine_mutation(
            target_device_id,
            None,
            r"C:\existing\README.txt",
            Some("text/plain"),
            Some("txt"),
            Some(metadata_created_at),
            Some(metadata_modified_at),
        ),
    )
    .await
    .unwrap();
    let content_path = format!("devices/{target_device_id}/content/README");
    let mut updated_file = file_entry::Entity::find_by_id(updated.file.file_id)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    updated_file.content_path = Set(Some(content_path.clone()));
    updated_file
        .update(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    let omitted = query::mutate_file(
        repository,
        &stage_nine_mutation(
            target_device_id,
            None,
            r"C:\omitted\keep.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let foreign = query::mutate_file(
        repository,
        &stage_nine_mutation(
            other_device_id,
            None,
            r"C:\foreign\private.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let target_before = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        target_device_id,
    )
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
    let foreign_before = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        other_device_id,
    )
    .await;
    let device_updated_at_before = device::Entity::find_by_id(target_device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .updated_at;

    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let result = bl::sync(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        stage_ten_command(
            target_device_id,
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

    let target_after = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        target_device_id,
    )
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
        stage_nine_entries(
            env.file_registry_db().unwrap().connection(),
            other_device_id,
        )
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
    let repeated = bl::sync(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        stage_ten_command(
            target_device_id,
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
    insert_device(&env.dbx, device_id, &owner, timestamp).await;
    insert_device(&env.dbx, archived_device_id, &owner, timestamp).await;
    archive_device(&env.dbx, archived_device_id, timestamp).await;
    let source = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let unauthorized = access::login_with_roles(&owner, &[]);
    let outage_db = connect_runtime(&env.config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    outage_db.connection().clone().close().await.unwrap();

    assert_forbidden(
        bl::sync(
            &env.dbx,
            &outage_db,
            &unauthorized,
            stage_ten_command(device_id, Vec::new()),
        )
        .await
        .unwrap_err(),
    );
    assert_form_error(
        bl::sync(
            &env.dbx,
            &outage_db,
            &source,
            stage_ten_command(device_id, Vec::new()),
        )
        .await
        .unwrap_err(),
        "files",
        "must contain between 1 and 1000 items",
    );
    assert_form_error(
        bl::sync(&env.dbx,
        &outage_db,
        &source,
        stage_ten_command(device_id, vec![
            stage_ten_file(None, r"C:\logs\a.log");
            DEVICE_FILE_SYNC_BATCH_MAX_COUNT + 1
        ]),)
        .await
        .unwrap_err(),
        "files",
        &format!(
            "must contain between 1 and {DEVICE_FILE_SYNC_BATCH_MAX_COUNT} items"
        ),
    );
    assert_not_found(
        bl::sync(
            &env.dbx,
            &outage_db,
            &source,
            stage_ten_command(
                Uuid::now_v7(),
                vec![stage_ten_file(None, r"C:\logs\a.log")],
            ),
        )
        .await
        .unwrap_err(),
    );
    assert_form_error(
        bl::sync(
            &env.dbx,
            &outage_db,
            &source,
            stage_ten_command(
                archived_device_id,
                vec![stage_ten_file(None, r"C:\logs\a.log")],
            ),
        )
        .await
        .unwrap_err(),
        "device_id",
        "Архівований пристрій не можна редагувати",
    );

    let before = stage_ten_registry_snapshot(
        env.file_registry_db().unwrap().connection(),
    )
    .await;
    assert_form_error(
        bl::sync(
            &env.dbx,
            env.file_registry_db().unwrap(),
            &source,
            stage_ten_command(device_id, Vec::new()),
        )
        .await
        .unwrap_err(),
        "files",
        "must contain between 1 and 1000 items",
    );
    assert_eq!(
        stage_ten_registry_snapshot(
            env.file_registry_db().unwrap().connection(),
        )
        .await,
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
    insert_device(&env.dbx, device_id, &owner, timestamp).await;
    let source = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let outage_main =
        crate::new_pg_pool_from_config(&env.config).await.unwrap();
    outage_main.clone().close().await.unwrap();
    let before = stage_ten_registry_snapshot(
        env.file_registry_db().unwrap().connection(),
    )
    .await;

    let error = bl::sync(
        &outage_main,
        env.file_registry_db().unwrap(),
        &source,
        stage_ten_command(
            device_id,
            vec![stage_ten_file(None, r"C:\logs\a.log")],
        ),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, AppError::AnyhowError { .. }));
    assert_eq!(
        stage_ten_registry_snapshot(
            env.file_registry_db().unwrap().connection(),
        )
        .await,
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
    let repository = env.file_registry_db().unwrap();
    let expected = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\phase\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let committed_transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db().unwrap().connection(),
    )
    .await;
    let aborted_transaction_id = stage_eleven_aborted_transaction_id(
        env.file_registry_db().unwrap().connection(),
    )
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
                repository,
                expected.clone(),
                committed_transaction_id.clone(),
                stage_eleven_sqlstate_error(code),
            )
            .await,
            Err(FilesystemError::Conflict)
        ));
    }
    let error = handle_commit_error(
        repository,
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
                repository,
                expected.clone(),
                committed_transaction_id.clone(),
                stage_eleven_sqlstate_error(code),
            )
            .await
            .unwrap(),
            expected,
        );
        let error = handle_commit_error(
            repository,
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
            repository,
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
            repository,
            expected.clone(),
            aborted_transaction_id.clone(),
            stage_eleven_no_sqlstate_error(),
        )
        .await,
        Err(FilesystemError::CommitUncertain(_))
    ));
    assert_eq!(
        handle_commit_error(
            repository,
            expected.clone(),
            committed_transaction_id,
            anyhow::anyhow!("stage-eleven-synthetic-non-database"),
        )
        .await
        .unwrap(),
        expected,
    );
    let error = handle_commit_error(
        repository,
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
        r"C:\lost\create.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let transaction = env
        .file_registry_db()
        .unwrap()
        .connection()
        .begin()
        .await
        .unwrap();
    let expected = query::mutate_file_in_transaction(&transaction, &mutation)
        .await
        .unwrap();
    let transaction_id = stage_eleven_transaction_id(&transaction).await;
    transaction.commit().await.unwrap();

    let repository = env.file_registry_db().unwrap();
    let reconciled = handle_commit_error(
        repository,
        expected.clone(),
        transaction_id,
        anyhow::anyhow!("stage-eleven-lost-acknowledgement"),
    )
    .await
    .unwrap();
    assert_eq!(reconciled, expected);

    let entries = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| {
                entry.kind == DomainFileEntryKind::File
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
    let repository = env.file_registry_db().unwrap();
    let initial = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\original\file.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let mutation = stage_nine_mutation(
        device_id,
        Some(initial.file.file_id),
        r"E:\same\file.log",
        Some("text/plain"),
        Some("log"),
        None,
        None,
    );
    let fixed_now = chrono::Utc::now().naive_utc() + Duration::seconds(1);

    let aborted = env
        .file_registry_db()
        .unwrap()
        .connection()
        .begin()
        .await
        .unwrap();
    let aborted_result = query::mutate_file_at(&aborted, &mutation, fixed_now)
        .await
        .unwrap();
    let aborted_transaction_id = stage_eleven_transaction_id(&aborted).await;
    aborted.rollback().await.unwrap();

    let committed = env
        .file_registry_db()
        .unwrap()
        .connection()
        .begin()
        .await
        .unwrap();
    let committed_result =
        query::mutate_file_at(&committed, &mutation, fixed_now)
            .await
            .unwrap();
    committed.commit().await.unwrap();
    assert_eq!(committed_result, aborted_result);

    let error = handle_commit_error(
        repository,
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
    let repository = env.file_registry_db().unwrap();
    let expected = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\status\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();

    let transaction = env
        .file_registry_db()
        .unwrap()
        .connection()
        .begin()
        .await
        .unwrap();
    let in_progress_transaction_id =
        stage_eleven_transaction_id(&transaction).await;
    let error = handle_commit_error(
        repository,
        expected.clone(),
        in_progress_transaction_id,
        anyhow::anyhow!("stage-eleven-in-progress"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    transaction.rollback().await.unwrap();

    let error = handle_commit_error(
        repository,
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
    let repository = env.file_registry_db().unwrap();
    let expected = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\outage\exact.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db().unwrap().connection(),
    )
    .await;
    let before = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;
    let outage_db = connect_runtime(&env.config, Mode::Test)
        .await
        .unwrap()
        .unwrap();
    outage_db.connection().clone().close().await.unwrap();
    let outage_repository = &outage_db;

    let error = handle_commit_error(
        outage_repository,
        expected,
        transaction_id,
        anyhow::anyhow!("stage-eleven-registry-outage"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    assert_eq!(
        stage_nine_entries(
            env.file_registry_db().unwrap().connection(),
            device_id,
        )
        .await,
        before,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stage_eleven_committed_xid_mismatch_keeps_commit_uncertain() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = Uuid::now_v7();
    let repository = env.file_registry_db().unwrap();
    let expected = query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            None,
            r"C:\mismatch\before.log",
            Some("text/plain"),
            Some("log"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let transaction_id = stage_eleven_committed_transaction_id(
        env.file_registry_db().unwrap().connection(),
    )
    .await;
    query::mutate_file(
        repository,
        &stage_nine_mutation(
            device_id,
            Some(expected.file.file_id),
            r"D:\mismatch\after.log",
            Some("application/json"),
            Some("json"),
            None,
            None,
        ),
    )
    .await
    .unwrap();
    let before_handler = stage_nine_entries(
        env.file_registry_db().unwrap().connection(),
        device_id,
    )
    .await;

    let error = handle_commit_error(
        repository,
        expected,
        transaction_id,
        anyhow::anyhow!("stage-eleven-committed-mismatch"),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    assert_eq!(
        stage_nine_entries(
            env.file_registry_db().unwrap().connection(),
            device_id,
        )
        .await,
        before_handler,
    );
}

mod cursor_tests {
    use super::super::cursor::*;
    use super::super::*;
    use crate::config::DEVICE_FILE_CURSOR_MAX_BYTES;
    use uuid::Uuid;

    #[test]
    fn cursor_round_trips_boundary_uuid() {
        let boundary_entry_id = Uuid::from_u128(4);
        let cursor = encode(boundary_entry_id);

        assert_eq!(cursor, boundary_entry_id.to_string());
        assert_eq!(decode(&cursor).unwrap(), boundary_entry_id);
    }

    #[test]
    fn decode_rejects_malformed_and_oversized_cursors() {
        for cursor in [
            "not-a-uuid".to_string(),
            "a".repeat(DEVICE_FILE_CURSOR_MAX_BYTES + 1),
        ] {
            assert!(matches!(
                decode(&cursor),
                Err(FilesystemError::Validation(_))
            ));
        }
    }
}

mod error_tests {
    use super::super::error::*;
    use std::error::Error;

    const SENTINEL_SECRET: &str = "filesystem-source-sentinel-secret";

    #[test]
    fn filesystem_error_display_labels_are_safe_and_stable() {
        let cases = [
            (
                FilesystemError::Validation(vec![FilesystemFieldError {
                    path: "absolute_path".to_string(),
                    message: "invalid".to_string(),
                }]),
                "filesystem validation failed",
                false,
            ),
            (
                FilesystemError::NotFound,
                "filesystem entry not found",
                false,
            ),
            (FilesystemError::Conflict, "filesystem conflict", false),
            (
                FilesystemError::Dependency(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem dependency failed",
                true,
            ),
            (
                FilesystemError::Invariant("safe_invariant_code"),
                "filesystem invariant failed: safe_invariant_code",
                false,
            ),
            (
                FilesystemError::Internal(anyhow::anyhow!(SENTINEL_SECRET)),
                "filesystem internal failure",
                true,
            ),
            (
                FilesystemError::CommitUncertain(anyhow::anyhow!(
                    SENTINEL_SECRET
                )),
                "filesystem commit outcome uncertain",
                true,
            ),
        ];

        for (error, expected_display, has_source) in cases {
            assert_eq!(error.to_string(), expected_display);
            assert!(!error.to_string().contains(SENTINEL_SECRET));

            if has_source {
                let source =
                    error.source().expect("source error must be retained");
                assert!(format!("{source:#}").contains(SENTINEL_SECRET));
            } else {
                assert!(error.source().is_none());
            }
        }
    }
}

mod ltree_tests {
    use super::super::ltree::*;
    use super::super::*;
    use uuid::Uuid;

    #[test]
    fn uuid_paths_use_only_lowercase_uuid_labels() {
        let root_id = Uuid::from_u128(0x018f0000000700080000000000000002);
        let directory_id = Uuid::from_u128(0x018f0000000700080000000000000001);
        let root_label = "n018f0000000700080000000000000002";
        let directory_label = "n018f0000000700080000000000000001";

        assert_eq!(uuid_label(root_id), root_label);
        assert_eq!(root_hierarchy_path(root_id), root_label);
        assert_eq!(
            child_hierarchy_path(root_label, directory_id),
            format!("{root_label}.{directory_label}")
        );
    }

    #[test]
    fn expected_hierarchy_path_requires_exact_nonempty_uuid_chain() {
        let root_id = Uuid::from_u128(1);
        let directory_id = Uuid::from_u128(2);
        let expected =
            "n00000000000000000000000000000001.n00000000000000000000000000000002";

        assert_eq!(
            expected_hierarchy_path(&[root_id, directory_id]).unwrap(),
            expected
        );
        assert!(
            verify_hierarchy_path(&[root_id, directory_id], expected).is_ok()
        );
        assert!(matches!(
            expected_hierarchy_path(&[]),
            Err(FilesystemError::Invariant("hierarchy_path_empty"))
        ));
        assert!(matches!(
            verify_hierarchy_path(&[root_id, directory_id], "nwrong"),
            Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
        ));
    }

    #[test]
    fn hierarchy_entry_ids_requires_canonical_nonempty_labels() {
        let root_id = Uuid::from_u128(1);
        let directory_id = Uuid::from_u128(2);
        let hierarchy_path =
            expected_hierarchy_path(&[root_id, directory_id]).unwrap();

        assert_eq!(
            hierarchy_entry_ids(&hierarchy_path).unwrap(),
            vec![root_id, directory_id]
        );
        for hierarchy_path in [
            "",
            "nwrong",
            "n0000000000000000000000000000000A",
            "n00000000000000000000000000000001..n00000000000000000000000000000002",
        ] {
            assert!(matches!(
                hierarchy_entry_ids(hierarchy_path),
                Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
            ));
        }
    }
}

mod metadata_tests {
    use super::super::metadata::*;
    use super::super::types::NormalizedFileMetadata;
    use super::super::*;
    use crate::config::{
        DEVICE_FILE_EXTENSION_MAX_CHARS, DEVICE_FILE_MIME_TYPE_MAX_CHARS,
    };
    use chrono::{DateTime, NaiveDate};

    fn validation_errors(
        result: Result<NormalizedFileMetadata, FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn explicit_metadata_is_trimmed_and_takes_precedence_without_case_rewrite()
    {
        let metadata = normalize_file_metadata(
            "report.pdf",
            Some("  application/x-custom  ".to_string()),
            Some("  TXT  ".to_string()),
            None,
            None,
            "files[3]",
        )
        .unwrap();

        assert_eq!(metadata.mime_type.as_deref(), Some("application/x-custom"));
        assert_eq!(metadata.extension.as_deref(), Some("TXT"));
    }

    #[test]
    fn custom_and_unknown_explicit_values_are_preserved_without_filename_fallback(
    ) {
        let custom = normalize_file_metadata(
            "report.pdf",
            Some("vendor/custom".to_string()),
            Some("custom_extension".to_string()),
            None,
            None,
            "files[0]",
        )
        .unwrap();
        assert_eq!(custom.mime_type.as_deref(), Some("vendor/custom"));
        assert_eq!(custom.extension.as_deref(), Some("custom_extension"));

        let unknown_extension = normalize_file_metadata(
            "report.pdf",
            None,
            Some("not-a-known-extension".to_string()),
            None,
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(
            unknown_extension.extension.as_deref(),
            Some("not-a-known-extension")
        );
        assert_eq!(unknown_extension.mime_type, None);
    }

    #[test]
    fn derives_exact_extension_from_last_meaningful_dot() {
        let cases = [
            ("report.tar.gz", Some("gz")),
            (".bashrc", None),
            (".config.json", Some("json")),
            ("report.", None),
            ("report", None),
        ];

        for (file_name, expected_extension) in cases {
            let metadata = normalize_file_metadata(
                file_name, None, None, None, None, "files[2]",
            )
            .unwrap();
            assert_eq!(
                metadata.extension.as_deref(),
                expected_extension,
                "{file_name}"
            );
        }
    }

    #[test]
    fn derives_known_mime_and_leaves_unknown_mapping_absent() {
        let known = normalize_file_metadata(
            "report.pdf",
            None,
            None,
            None,
            None,
            "files[0]",
        )
        .unwrap();
        assert_eq!(known.extension.as_deref(), Some("pdf"));
        assert_eq!(known.mime_type.as_deref(), Some("application/pdf"));

        let unknown = normalize_file_metadata(
            "report.unmapped_extension",
            None,
            None,
            None,
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(unknown.extension.as_deref(), Some("unmapped_extension"));
        assert_eq!(unknown.mime_type, None);
    }

    #[test]
    fn normalizes_timezone_offsets_to_naive_utc() {
        let expected = NaiveDate::from_ymd_opt(2026, 7, 22)
            .unwrap()
            .and_hms_opt(9, 30, 0)
            .unwrap();
        let positive =
            DateTime::parse_from_rfc3339("2026-07-22T12:30:00+03:00").unwrap();
        let negative =
            DateTime::parse_from_rfc3339("2026-07-22T05:30:00-04:00").unwrap();
        let metadata = normalize_file_metadata(
            "report",
            None,
            None,
            Some(positive),
            Some(negative),
            "files[0]",
        )
        .unwrap();
        assert_eq!(metadata.file_metadata_created_at, Some(expected));
        assert_eq!(metadata.file_metadata_modified_at, Some(expected));

        let utc = DateTime::parse_from_rfc3339("2026-07-22T09:30:00Z").unwrap();
        let metadata = normalize_file_metadata(
            "report",
            None,
            None,
            Some(utc),
            None,
            "files[1]",
        )
        .unwrap();
        assert_eq!(metadata.file_metadata_created_at, Some(expected));
        assert_eq!(metadata.file_metadata_modified_at, None);
    }

    #[test]
    fn metadata_validation_collects_mime_then_extension_errors_with_exact_paths(
    ) {
        assert_eq!(
            validation_errors(normalize_file_metadata(
                "report.pdf",
                Some("  ".to_string()),
                Some(" .txt ".to_string()),
                None,
                None,
                "files[3]",
            )),
            vec![
                FilesystemFieldError {
                    path: "files[3].mime_type".to_string(),
                    message: format!(
                        "must contain between 1 and {DEVICE_FILE_MIME_TYPE_MAX_CHARS} Unicode scalar values after trimming"
                    ),
                },
                FilesystemFieldError {
                    path: "files[3].extension".to_string(),
                    message: "must not start with '.'".to_string(),
                },
            ]
        );

        let long_extension = "a".repeat(DEVICE_FILE_EXTENSION_MAX_CHARS + 1);
        assert_eq!(
            validation_errors(normalize_file_metadata(
                "report.pdf",
                None,
                Some(long_extension),
                None,
                None,
                "files[4]",
            )),
            vec![FilesystemFieldError {
                path: "files[4].extension".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_EXTENSION_MAX_CHARS} Unicode scalar values after trimming"
                ),
            }]
        );
    }
}

mod path_tests {
    use super::super::path::*;
    use super::super::types::ParsedSourcePath;
    use super::super::*;
    use crate::config::{
        DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS,
        DEVICE_FILE_PATH_COMPONENT_MAX_CHARS,
        DEVICE_FILE_PATH_COMPONENT_MAX_COUNT,
    };

    fn validation_errors(
        result: Result<ParsedSourcePath, FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn parser_preserves_exact_windows_paths_and_canonicalizes_drive_roots() {
        struct Case {
            absolute_path: &'static str,
            root_name: &'static str,
            components: &'static [&'static str],
        }

        let cases = [
            Case {
                absolute_path: r"C:\var\Журнал\app.log",
                root_name: r"C:\",
                components: &["var", "Журнал", "app.log"],
            },
            Case {
                absolute_path: r"c:\Logs\APP.LOG",
                root_name: r"C:\",
                components: &["Logs", "APP.LOG"],
            },
            Case {
                absolute_path: r"\\Server\Share\dir\report.pdf",
                root_name: r"\\Server\Share\",
                components: &["dir", "report.pdf"],
            },
            Case {
                absolute_path: r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_disarm.wav",
                root_name: r"D:\",
                components: &[
                    "Counter-Strike Source v34 HD",
                    "cstrike",
                    "sound",
                    "weapons",
                    "csgo",
                    "c4",
                    "c4_disarm.wav",
                ],
            },
            Case {
                absolute_path: r"D:\Counter-Strike Source v34 HD\cstrike\sound\weapons\csgo\c4\c4_plant.wav",
                root_name: r"D:\",
                components: &[
                    "Counter-Strike Source v34 HD",
                    "cstrike",
                    "sound",
                    "weapons",
                    "csgo",
                    "c4",
                    "c4_plant.wav",
                ],
            },
            Case {
                absolute_path: r"C:\<:|?*>\report",
                root_name: r"C:\",
                components: &["<:|?*>", "report"],
            },
        ];

        for case in cases {
            let parsed = crate::devices::files::path::parse(
                case.absolute_path.to_string(),
                "files[3].absolute_path",
            )
            .unwrap();

            assert_eq!(parsed.absolute_path, case.absolute_path);
            assert_eq!(
                parsed.absolute_path.as_bytes(),
                case.absolute_path.as_bytes()
            );
            assert_eq!(parsed.root_name, case.root_name);
            assert_eq!(
                parsed.components,
                case.components
                    .iter()
                    .map(|component| (*component).to_string())
                    .collect::<Vec<_>>()
            );
            assert_eq!(parsed.file_name(), *case.components.last().unwrap());
        }
    }

    #[test]
    fn parser_rejects_each_forbidden_path_form_with_exact_field_path() {
        let cases = [
            "/".to_string(),
            "relative/file".to_string(),
            "//dir/file".to_string(),
            "/dir//file".to_string(),
            "/dir/".to_string(),
            "/dir\\file".to_string(),
            "/./file".to_string(),
            "/dir/..".to_string(),
            "/dir/\0file".to_string(),
            "C:file".to_string(),
            "\\file".to_string(),
            "C:\\".to_string(),
            "C:\\dir/file".to_string(),
            "C:\\\\file".to_string(),
            "C:\\dir\\".to_string(),
            "C:\\.\\file".to_string(),
            "C:\\dir\\..\\file".to_string(),
            "C:\\dir\\\0file".to_string(),
            r"\\?\C:\file".to_string(),
            r"\\.\C:\file".to_string(),
            r"\\\server\share\file".to_string(),
            r"\\server\share".to_string(),
            r"\\server\\file".to_string(),
            r"\\server\share\dir\\file".to_string(),
            "\\\\server\\share\\dir\\".to_string(),
            r"\\.\share\dir\file".to_string(),
            r"\\server\share\..\file".to_string(),
        ];

        for (index, absolute_path) in cases.into_iter().enumerate() {
            let field_path = format!("files[{index}].absolute_path");
            assert_eq!(
                validation_errors(parse(absolute_path, &field_path)),
                vec![FilesystemFieldError {
                    path: field_path,
                    message: "must be an absolute Windows file path"
                        .to_string(),
                }]
            );
        }
    }

    #[test]
    fn parser_enforces_scalar_component_count_and_component_length_boundaries()
    {
        let component_count = DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS
            / DEVICE_FILE_PATH_COMPONENT_MAX_CHARS;
        let component = "a".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS - 1);
        let final_component =
            "a".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS - 3);
        let mut components = vec![component; component_count];
        *components.last_mut().unwrap() = final_component;
        let max_path = format!(r"C:\{}", components.join(r"\"));
        assert_eq!(
            max_path.chars().count(),
            DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS
        );
        assert!(parse(max_path.clone(), "files[0].absolute_path").is_ok());

        let scalar_overflow = format!("{max_path}a");
        assert_eq!(
            validation_errors(parse(
                scalar_overflow,
                "files[0].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[0].absolute_path".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS} Unicode scalar values"
                ),
            }]
        );

        let max_component = format!(
            r"C:\{}",
            "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS)
        );
        assert!(parse(max_component, "files[1].absolute_path").is_ok());
        let component_overflow = format!(
            r"C:\{}",
            "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS + 1)
        );
        assert_eq!(
            validation_errors(parse(
                component_overflow,
                "files[1].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[1].absolute_path".to_string(),
                message: format!(
                    "each path component must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_CHARS} Unicode scalar values"
                ),
            }]
        );

        let max_component_count = format!(
            r"C:\{}",
            vec!["a"; DEVICE_FILE_PATH_COMPONENT_MAX_COUNT].join(r"\")
        );
        assert!(parse(max_component_count, "files[2].absolute_path",).is_ok());
        let component_count_overflow = format!(
            r"C:\{}",
            vec!["a"; DEVICE_FILE_PATH_COMPONENT_MAX_COUNT + 1].join(r"\")
        );
        assert_eq!(
            validation_errors(parse(
                component_count_overflow,
                "files[2].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[2].absolute_path".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_PATH_COMPONENT_MAX_COUNT} path components"
                ),
            }]
        );
    }
}

mod sync_pipeline_tests {
    use super::super::sync_pipeline::*;
    use super::super::*;
    use crate::config::DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS;
    use chrono::NaiveDate;
    use std::{collections::HashSet, future};
    use uuid::Uuid;

    fn sync_file(
        file_id: Option<Uuid>,
        absolute_path: &str,
        mime_type: Option<&str>,
        extension: Option<&str>,
    ) -> SyncFileItemCommand {
        SyncFileItemCommand {
            file_id,
            absolute_path: absolute_path.to_string(),
            mime_type: mime_type.map(str::to_string),
            extension: extension.map(str::to_string),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
        }
    }

    fn field_error(path: &str) -> FilesystemFieldError {
        FilesystemFieldError {
            path: path.to_string(),
            message: "invalid".to_string(),
        }
    }

    #[test]
    fn preparation_keeps_duplicate_and_item_validation_errors_ordered() {
        let file_id = Uuid::now_v7();
        let duplicate_file_ids = HashSet::from([file_id]);
        let files = vec![
            sync_file(
                Some(file_id),
                "C:\\logs\\a.log",
                Some("   "),
                Some(".log"),
            ),
            sync_file(Some(file_id), "relative.log", None, None),
        ];

        let prepared =
            prepare_sync_items(Uuid::now_v7(), files, &duplicate_file_ids)
                .unwrap();
        let error_paths = prepared
            .into_iter()
            .map(|prepared| match prepared {
                PreparedSyncFileItem::Rejected(SyncFileItemResult {
                    outcome: SyncFileItemOutcome::Rejected { field_errors, .. },
                    ..
                }) => field_errors
                    .into_iter()
                    .map(|error| error.path)
                    .collect::<Vec<_>>(),
                PreparedSyncFileItem::Mutation { .. } => {
                    panic!("expected rejected item")
                }
                PreparedSyncFileItem::Rejected(_) => {
                    panic!("expected validation rejection")
                }
            })
            .collect::<Vec<_>>();

        assert_eq!(
            error_paths,
            vec![
                vec![
                    "files[0].file_id",
                    "files[0].mime_type",
                    "files[0].extension",
                ],
                vec!["files[1].file_id", "files[1].absolute_path"],
            ]
        );
    }

    #[test]
    fn invalid_timestamp_string_is_an_item_validation_rejection() {
        let mut file = sync_file(None, r"C:\logs\a.log", None, None);
        file.file_metadata_created_at = Some("not-a-timestamp".to_string());
        file.file_metadata_modified_at =
            Some("2026-07-23T12:00:00+03:00".to_string());

        let prepared =
            prepare_sync_items(Uuid::now_v7(), vec![file], &HashSet::new())
                .unwrap();
        let PreparedSyncFileItem::Rejected(SyncFileItemResult {
            outcome:
                SyncFileItemOutcome::Rejected {
                    kind, field_errors, ..
                },
            ..
        }) = prepared.into_iter().next().unwrap()
        else {
            panic!("expected timestamp validation rejection");
        };

        assert_eq!(kind, SyncFileRejectionKind::Validation);
        assert_eq!(
            field_errors
                .into_iter()
                .map(|error| error.path)
                .collect::<Vec<_>>(),
            vec!["files[0].file_metadata_created_at"],
        );
    }

    #[test]
    fn item_error_mapping_is_safe_and_commit_uncertainty_is_fatal() {
        let cases = vec![
            (
                FilesystemError::Validation(vec![field_error(
                    "files[0].absolute_path",
                )]),
                SyncFileRejectionKind::Validation,
                "filesystem validation failed",
                false,
                vec![field_error("files[0].absolute_path")],
            ),
            (
                FilesystemError::NotFound,
                SyncFileRejectionKind::NotFound,
                "filesystem entry not found",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Conflict,
                SyncFileRejectionKind::Conflict,
                "filesystem conflict",
                true,
                Vec::new(),
            ),
            (
                FilesystemError::Dependency(anyhow::anyhow!("dependency")),
                SyncFileRejectionKind::Dependency,
                "filesystem dependency failed",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Invariant("invariant"),
                SyncFileRejectionKind::Internal,
                "filesystem internal failure",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Internal(anyhow::anyhow!("internal")),
                SyncFileRejectionKind::Internal,
                "filesystem internal failure",
                false,
                Vec::new(),
            ),
        ];

        for (
            error,
            expected_kind,
            expected_message,
            expected_retry,
            expected_errors,
        ) in cases
        {
            let SyncFileItemResult {
                index,
                outcome:
                    SyncFileItemOutcome::Rejected {
                        kind,
                        message,
                        retry,
                        field_errors,
                    },
            } = map_sync_item_error(7, error).unwrap()
            else {
                panic!("expected rejected item result")
            };

            assert_eq!(index, 7);
            assert_eq!(kind, expected_kind);
            assert_eq!(message, expected_message);
            assert_eq!(retry, expected_retry);
            assert_eq!(field_errors, expected_errors);
        }

        assert!(matches!(
            map_sync_item_error(
                0,
                FilesystemError::CommitUncertain(anyhow::anyhow!("uncertain")),
            ),
            Err(FilesystemError::CommitUncertain(_))
        ));
    }

    fn prepared_mutation(absolute_path: &str) -> PreparedFileMutation {
        let prepared = prepare_sync_items(
            Uuid::now_v7(),
            vec![sync_file(None, absolute_path, None, None)],
            &HashSet::new(),
        )
        .unwrap()
        .pop()
        .unwrap();
        let PreparedSyncFileItem::Mutation { mutation, .. } = prepared else {
            panic!("expected prepared mutation");
        };
        mutation
    }

    fn mutation_result(
        mutation: &PreparedFileMutation,
    ) -> super::super::FileMutationResult {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 24)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let root_id = mutation.candidate_root_entry_id;
        let parent_entry_id = mutation
            .candidate_directory_entry_ids
            .last()
            .copied()
            .unwrap_or(root_id);
        let root_path = format!("n{}", root_id.simple());
        let file_path = format!("{root_path}.n{}", mutation.file_id.simple());

        super::super::FileMutationResult {
            operation: mutation.operation,
            root: super::super::RootEntry {
                entry_id: root_id,
                device_id: mutation.device_id,
                name: mutation.source_path.root_name.clone(),
                hierarchy_path: root_path,
                created_at: timestamp,
                updated_at: timestamp,
            },
            file: super::super::FileEntry {
                file_id: mutation.file_id,
                device_id: mutation.device_id,
                parent_entry_id,
                name: mutation.source_path.file_name().to_string(),
                absolute_path: mutation.source_path.absolute_path.clone(),
                hierarchy_path: file_path,
                has_content: false,
                mime_type: mutation.metadata.mime_type.clone(),
                extension: mutation.metadata.extension.clone(),
                file_metadata_created_at: mutation
                    .metadata
                    .file_metadata_created_at,
                file_metadata_modified_at: mutation
                    .metadata
                    .file_metadata_modified_at,
                created_at: timestamp,
                updated_at: timestamp,
            },
            path_components: mutation.source_path.components.clone(),
        }
    }

    #[tokio::test]
    async fn retries_reuse_the_same_prepared_mutation_candidates() {
        let mutation = prepared_mutation(r"C:\logs\retry.log");
        let expected_identity = (
            mutation.file_id,
            mutation.candidate_root_entry_id,
            mutation.candidate_directory_entry_ids.clone(),
        );
        let mut identities = Vec::new();
        let mut attempts = 0;
        let result = mutate_file_with_retry(&mutation, &mut |attempt| {
            attempts += 1;
            identities.push((
                attempt.file_id,
                attempt.candidate_root_entry_id,
                attempt.candidate_directory_entry_ids.clone(),
            ));
            future::ready(if attempts == 1 {
                Err(FilesystemError::Conflict)
            } else {
                Ok(attempt.file_id)
            })
        })
        .await
        .unwrap();

        assert_eq!(result, mutation.file_id);
        assert_eq!(
            identities,
            vec![expected_identity.clone(), expected_identity]
        );
    }

    #[tokio::test]
    async fn exhausted_conflict_rejects_item_and_continues() {
        let mut attempted_paths = Vec::new();
        let result = sync_files_with_mutator(
            Uuid::now_v7(),
            vec![
                sync_file(None, r"C:\retry\rejected.log", None, None),
                sync_file(None, r"D:\accepted\kept.log", None, None),
            ],
            HashSet::new(),
            |mutation| {
                attempted_paths
                    .push(mutation.source_path.absolute_path.clone());
                let result = if mutation.source_path.absolute_path
                    == r"C:\retry\rejected.log"
                {
                    Err(FilesystemError::Conflict)
                } else {
                    Ok(mutation_result(&mutation))
                };
                future::ready(result)
            },
        )
        .await
        .unwrap();

        assert_eq!(
            attempted_paths
                .iter()
                .filter(|path| path.as_str() == r"C:\retry\rejected.log")
                .count(),
            DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS,
        );
        assert_eq!(
            attempted_paths.last().map(String::as_str),
            Some(r"D:\accepted\kept.log"),
        );
        assert!(matches!(
            result.results[0].outcome,
            SyncFileItemOutcome::Rejected {
                kind: SyncFileRejectionKind::Conflict,
                retry: true,
                ..
            }
        ));
        assert!(matches!(
            result.results[1].outcome,
            SyncFileItemOutcome::Accepted { .. }
        ));
    }

    #[tokio::test]
    async fn commit_uncertainty_stops_later_items_after_prior_success() {
        let mut attempted_paths = Vec::new();
        let error = sync_files_with_mutator(
            Uuid::now_v7(),
            vec![
                sync_file(None, r"C:\prior\committed.log", None, None),
                sync_file(None, r"D:\target\uncertain.log", None, None),
                sync_file(None, r"E:\later\must-not-run.log", None, None),
            ],
            HashSet::new(),
            |mutation| {
                attempted_paths
                    .push(mutation.source_path.absolute_path.clone());
                let result = if mutation.source_path.absolute_path
                    == r"D:\target\uncertain.log"
                {
                    Err(FilesystemError::CommitUncertain(anyhow::anyhow!(
                        "uncertain"
                    )))
                } else {
                    Ok(mutation_result(&mutation))
                };
                future::ready(result)
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, FilesystemError::CommitUncertain(_)));
        assert_eq!(
            attempted_paths,
            [r"C:\prior\committed.log", r"D:\target\uncertain.log",],
        );
    }
}

mod types_tests {
    use super::super::types::*;
    use uuid::Uuid;

    #[test]
    fn directory_and_query_scopes_preserve_one_navigation_scope() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let directory_id = Uuid::from_u128(3);
        let timestamp = chrono::NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let root_scope = DirectoryScope::Root(RootEntry {
            entry_id: root_id,
            device_id,
            name: "root".to_string(),
            hierarchy_path: "n00000000000000000000000000000002".to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        });
        let directory_scope = DirectoryScope::Directory {
            entry: DirectoryEntry {
                entry_id: directory_id,
                device_id,
                parent_entry_id: root_id,
                name: "directory".to_string(),
                hierarchy_path:
                    "n00000000000000000000000000000002.n00000000000000000000000000000003"
                        .to_string(),
                created_at: timestamp,
                updated_at: timestamp,
            },
            root_id,
        };
        let filters = FileSearchFilters::try_from(RawFileSearchFilters {
            kinds: vec![DomainFileEntryKind::File],
            name_query: Some("abc".to_string()),
            mime_types: Vec::new(),
            extensions: Vec::new(),
            file_metadata_modified_from: None,
            file_metadata_modified_to: None,
        })
        .unwrap();

        let browse = EntryQueryScope::Browse(&root_scope);
        assert_eq!(browse.device_id(), device_id);
        assert_eq!(browse.directory(), &root_scope);
        assert_eq!(
            root_scope.hierarchy_path(),
            "n00000000000000000000000000000002"
        );

        let search = EntryQueryScope::Search {
            directory: &directory_scope,
            filters: &filters,
        };
        assert_eq!(search.device_id(), device_id);
        assert_eq!(search.directory(), &directory_scope);
        assert_eq!(
            directory_scope.hierarchy_path(),
            "n00000000000000000000000000000002.n00000000000000000000000000000003"
        );
    }
}

mod validation_tests {
    use super::super::validation::*;
    use super::super::*;
    use crate::config::{
        DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES,
        DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS,
        DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS,
        DEVICE_FILE_PATH_COMPONENT_MAX_CHARS,
        DEVICE_FILE_SUBTREE_COUNT_MAX_DIRECTORIES,
        DEVICE_FILE_SYNC_BATCH_MAX_COUNT,
    };
    use crate::devices::files::types::{
        DomainFileEntryKind, EntrySortKey, KeysetPageRequest,
    };
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn raw_filters() -> RawFileSearchFilters {
        RawFileSearchFilters {
            kinds: Vec::new(),
            name_query: None,
            mime_types: Vec::new(),
            extensions: Vec::new(),
            file_metadata_modified_from: None,
            file_metadata_modified_to: None,
        }
    }

    fn validation_errors(
        result: Result<FileSearchFilters, FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn keyset_page_request_enforces_configured_limit_boundaries() {
        let default =
            KeysetPageRequest::<EntrySortKey>::try_new(None, None).unwrap();
        assert_eq!(default.limit(), 100);
        assert_eq!(default.after(), None);

        for limit in [0, 101] {
            let Err(FilesystemError::Validation(errors)) =
                KeysetPageRequest::<EntrySortKey>::try_new(Some(limit), None)
            else {
                panic!("expected invalid limit");
            };
            assert_eq!(
                errors,
                vec![FilesystemFieldError {
                    path: "limit".to_string(),
                    message: "must be between 1 and 100".to_string(),
                }]
            );
        }
    }

    #[test]
    fn filters_reject_pre_deduplication_value_counts_with_exact_paths() {
        let filters = RawFileSearchFilters {
            kinds: vec![DomainFileEntryKind::File; 51],
            mime_types: vec!["application/json".to_string(); 51],
            extensions: vec!["json".to_string(); 51],
            ..raw_filters()
        };

        let errors = validation_errors(filters.try_into());
        assert_eq!(
            errors
                .into_iter()
                .map(|error| error.path)
                .collect::<Vec<_>>(),
            vec!["kinds", "mime_types", "extensions",]
        );
    }

    #[test]
    fn filters_canonicalize_only_arrays_and_trim_name_query_once() {
        let filters = RawFileSearchFilters {
            kinds: vec![
                DomainFileEntryKind::File,
                DomainFileEntryKind::Directory,
                DomainFileEntryKind::File,
            ],
            name_query: Some("  💾ab  ".to_string()),
            mime_types: vec![
                "text/plain".to_string(),
                " text/plain ".to_string(),
                "text/plain".to_string(),
            ],
            extensions: vec![
                "txt".to_string(),
                "TXT".to_string(),
                "txt".to_string(),
            ],
            ..raw_filters()
        };

        let filters = FileSearchFilters::try_from(filters).unwrap();
        let expected_mime_types =
            vec![" text/plain ".to_string(), "text/plain".to_string()];
        let expected_extensions = vec!["TXT".to_string(), "txt".to_string()];

        assert_eq!(
            filters.kinds(),
            &[DomainFileEntryKind::Directory, DomainFileEntryKind::File]
        );
        assert_eq!(filters.name_query(), Some("💾ab"));
        assert_eq!(filters.mime_types(), expected_mime_types.as_slice());
        assert_eq!(filters.extensions(), expected_extensions.as_slice());
    }

    #[test]
    fn name_query_uses_unicode_scalar_limits_and_rejects_whitespace() {
        let accepted = RawFileSearchFilters {
            name_query: Some("💾ab".to_string()),
            ..raw_filters()
        };
        assert_eq!(
            FileSearchFilters::try_from(accepted).unwrap().name_query(),
            Some("💾ab")
        );

        for name_query in ["   ".to_string(), "a".repeat(256)] {
            let errors = validation_errors(
                RawFileSearchFilters {
                    name_query: Some(name_query),
                    ..raw_filters()
                }
                .try_into(),
            );
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0].path, "name_query");
        }
    }

    #[test]
    fn modified_time_range_is_validated_before_sql() {
        let from = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(11, 0, 0)
            .unwrap();
        let errors = validation_errors(
            RawFileSearchFilters {
                file_metadata_modified_from: Some(from),
                file_metadata_modified_to: Some(to),
                ..raw_filters()
            }
            .try_into(),
        );

        assert_eq!(
            errors,
            vec![FilesystemFieldError {
                path: "file_metadata_modified_from".to_string(),
                message: "must be before or equal to file_metadata_modified_to"
                    .to_string(),
            }]
        );
    }

    fn path_validation_errors(
        result: Result<(), FilesystemError>,
    ) -> Vec<FilesystemFieldError> {
        match result {
            Err(FilesystemError::Validation(errors)) => errors,
            _ => panic!("expected filesystem validation error"),
        }
    }

    #[test]
    fn absolute_path_limits_enforce_utf8_bytes_before_scalar_values() {
        let max_path = "\u{10ffff}".repeat(DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS);
        assert_eq!(max_path.len(), DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES);
        validate_absolute_path_limits(&max_path, "files[0].absolute_path")
            .unwrap();

        let byte_overflow = format!("{max_path}\u{10ffff}");
        assert_eq!(
            path_validation_errors(validate_absolute_path_limits(
                &byte_overflow,
                "files[0].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[0].absolute_path".to_string(),
                message: format!(
                    "must contain at most {DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES} UTF-8 bytes"
                ),
            }]
        );

        assert_eq!(
            path_validation_errors(validate_absolute_path_limits(
                "",
                "files[1].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[1].absolute_path".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS} Unicode scalar values"
                ),
            }]
        );
    }

    #[test]
    fn path_component_limits_enforce_aggregate_scalar_boundary() {
        let component = "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS);
        let component_count = DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS
            / DEVICE_FILE_PATH_COMPONENT_MAX_CHARS;
        let components = vec![component.as_str(); component_count];
        validate_path_component_limits(&components, "files[2].absolute_path")
            .unwrap();

        let mut aggregate_overflow = components;
        aggregate_overflow.push("a");
        assert_eq!(
            path_validation_errors(validate_path_component_limits(
                &aggregate_overflow,
                "files[2].absolute_path",
            )),
            vec![FilesystemFieldError {
                path: "files[2].absolute_path".to_string(),
                message: format!(
                    "path components must contain at most {DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS} Unicode scalar values in total"
                ),
            }]
        );
    }

    fn sync_file(file_id: Option<Uuid>) -> SyncFileItemCommand {
        SyncFileItemCommand {
            file_id,
            absolute_path: r"C:\logs\a.log".to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
        }
    }

    #[test]
    fn sync_batch_size_enforces_configured_boundaries() {
        for item_count in [1, DEVICE_FILE_SYNC_BATCH_MAX_COUNT] {
            validate_sync_batch_size(item_count).unwrap();
        }

        for item_count in [0, DEVICE_FILE_SYNC_BATCH_MAX_COUNT + 1] {
            assert_eq!(
                path_validation_errors(validate_sync_batch_size(item_count)),
                vec![FilesystemFieldError {
                    path: "files".to_string(),
                    message: format!(
                        "must contain between 1 and {DEVICE_FILE_SYNC_BATCH_MAX_COUNT} items"
                    ),
                }]
            );
        }
    }
    #[test]
    fn subtree_count_batch_enforces_size_and_uniqueness() {
        for item_count in [1, DEVICE_FILE_SUBTREE_COUNT_MAX_DIRECTORIES] {
            let entry_ids = (1..=item_count)
                .map(|value| Uuid::from_u128(value as u128))
                .collect::<Vec<_>>();
            validate_subtree_count_directories(&entry_ids).unwrap();
        }

        for item_count in [0, DEVICE_FILE_SUBTREE_COUNT_MAX_DIRECTORIES + 1] {
            let entry_ids = (1..=item_count)
                .map(|value| Uuid::from_u128(value as u128))
                .collect::<Vec<_>>();
            assert_eq!(
                path_validation_errors(validate_subtree_count_directories(&entry_ids)),
                vec![FilesystemFieldError {
                    path: "directory_entry_ids".to_string(),
                    message: format!(
                        "must contain between 1 and {DEVICE_FILE_SUBTREE_COUNT_MAX_DIRECTORIES} items"
                    ),
                }]
            );
        }

        let duplicate = Uuid::from_u128(1);
        assert_eq!(
            path_validation_errors(validate_subtree_count_directories(&[
                duplicate, duplicate,
            ])),
            vec![FilesystemFieldError {
                path: "directory_entry_ids".to_string(),
                message: "must not contain duplicate values".to_string(),
            }]
        );
    }

    #[test]
    fn duplicate_file_ids_mark_only_repeated_supplied_ids() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let files = vec![
            sync_file(Some(first)),
            sync_file(None),
            sync_file(Some(second)),
            sync_file(Some(first)),
            sync_file(None),
            sync_file(Some(second)),
            sync_file(Some(first)),
        ];

        assert_eq!(
            duplicate_file_ids(&files),
            std::collections::HashSet::from([first, second])
        );
    }
}

mod query_ancestors_tests {
    use super::super::query::ancestors::*;
    use super::super::query::model;
    use super::super::*;
    use crate::devices::files::DirectoryEntry;
    use crate::file_registry::entities::file_entry;
    use chrono::{NaiveDate, NaiveDateTime};
    use uuid::Uuid;

    #[test]
    fn map_breadcrumb_chain_rejects_parent_gap() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let current_id = Uuid::from_u128(3);
        let missing_parent_id = Uuid::from_u128(4);
        let hierarchy_path = hierarchy_path(&[root_id, current_id]);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![
                root_model(device_id, root_id),
                directory_model(
                    device_id,
                    current_id,
                    missing_parent_id,
                    &hierarchy_path,
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("breadcrumb_chain_gap")
        ));
    }

    #[test]
    fn map_breadcrumb_chain_rejects_device_mismatch() {
        let device_id = Uuid::from_u128(1);
        let other_device_id = Uuid::from_u128(2);
        let root_id = Uuid::from_u128(3);
        let current_id = Uuid::from_u128(4);
        let hierarchy_path = hierarchy_path(&[root_id, current_id]);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![
                root_model(device_id, root_id),
                directory_model(
                    other_device_id,
                    current_id,
                    root_id,
                    &hierarchy_path,
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("breadcrumb_device_mismatch")
        ));
    }

    #[test]
    fn map_breadcrumb_chain_rejects_missing_current_entry() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let current_id = Uuid::from_u128(3);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![root_model(device_id, root_id)],
        )
        .unwrap_err();

        assert!(matches!(error, FilesystemError::NotFound));
    }

    #[test]
    fn map_path_components_uses_root_relative_names_and_page_final_name() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let archive_id = Uuid::from_u128(4);
        let nested_file_id = Uuid::from_u128(5);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let archive_path = hierarchy_path(&[root_id, reports_id, archive_id]);
        let nested_file_path =
            hierarchy_path(&[root_id, reports_id, archive_id, nested_file_id]);
        let entries = vec![tree_file(
            device_id,
            nested_file_id,
            archive_id,
            &nested_file_path,
            "nested.log",
        )];
        let components = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    root_id,
                    &reports_path,
                    "reports",
                ),
                named_directory_model(
                    device_id,
                    archive_id,
                    reports_id,
                    &archive_path,
                    "archive",
                ),
                file_model(
                    device_id,
                    nested_file_id,
                    archive_id,
                    &nested_file_path,
                    "renamed-after-page-query.log",
                ),
            ],
        )
        .unwrap();

        assert_eq!(
            components,
            vec![vec![
                "reports".to_string(),
                "archive".to_string(),
                "nested.log".to_string(),
            ]]
        );
    }

    #[test]
    fn map_path_components_rejects_missing_final_row() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let file_path = hierarchy_path(&[root_id, reports_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            reports_id,
            &file_path,
            "missing.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    root_id,
                    &reports_path,
                    "reports",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(error, FilesystemError::NotFound));
    }

    #[test]
    fn map_path_components_rejects_parent_gap() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let unexpected_parent_id = Uuid::from_u128(5);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let file_path = hierarchy_path(&[root_id, reports_id, file_id]);
        let entries = vec![tree_file(
            device_id, file_id, reports_id, &file_path, "gap.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    unexpected_parent_id,
                    &reports_path,
                    "reports",
                ),
                file_model(
                    device_id, file_id, reports_id, &file_path, "gap.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_chain_gap")
        ));
    }

    #[test]
    fn map_path_components_rejects_file_ancestor() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let file_ancestor_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let file_ancestor_path = hierarchy_path(&[root_id, file_ancestor_id]);
        let file_path = hierarchy_path(&[root_id, file_ancestor_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            file_ancestor_id,
            &file_path,
            "nested.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                file_model(
                    device_id,
                    file_ancestor_id,
                    root_id,
                    &file_ancestor_path,
                    "not-a-directory",
                ),
                file_model(
                    device_id,
                    file_id,
                    file_ancestor_id,
                    &file_path,
                    "nested.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_non_directory_ancestor")
        ));
    }

    #[test]
    fn map_path_components_rejects_device_mismatch() {
        let device_id = Uuid::from_u128(1);
        let other_device_id = Uuid::from_u128(2);
        let root_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let file_path = hierarchy_path(&[root_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            root_id,
            &file_path,
            "mismatch.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                file_model(
                    other_device_id,
                    file_id,
                    root_id,
                    &file_path,
                    "mismatch.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_device_mismatch")
        ));
    }

    #[test]
    fn map_path_components_rejects_final_entry_mismatch() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let final_id = Uuid::from_u128(3);
        let expected_file_id = Uuid::from_u128(4);
        let final_path = hierarchy_path(&[root_id, final_id]);
        let directory_entry = tree_directory(
            device_id,
            final_id,
            root_id,
            &final_path,
            "directory",
        );
        let file_entry = tree_file(
            device_id,
            expected_file_id,
            root_id,
            &final_path,
            "file",
        );

        for entry in [directory_entry, file_entry] {
            let error = map_path_components(
                &[entry],
                vec![
                    root_model(device_id, root_id),
                    file_model(
                        device_id,
                        final_id,
                        root_id,
                        &final_path,
                        "file",
                    ),
                ],
            )
            .unwrap_err();

            assert!(matches!(
                error,
                FilesystemError::Invariant("path_context_entry_mismatch")
            ));
        }
    }

    fn directory_scope(
        device_id: Uuid,
        root_id: Uuid,
        current_id: Uuid,
    ) -> DirectoryScope {
        DirectoryScope::Directory {
            entry: DirectoryEntry {
                entry_id: current_id,
                device_id,
                parent_entry_id: root_id,
                name: "current".to_string(),
                hierarchy_path: hierarchy_path(&[root_id, current_id]),
                created_at: timestamp(),
                updated_at: timestamp(),
            },
            root_id,
        }
    }

    fn root_model(device_id: Uuid, root_id: Uuid) -> file_entry::Model {
        file_entry::Model {
            id: root_id,
            device_id,
            parent_id: None,
            kind: DomainFileEntryKind::Directory,
            name: "C:\\".to_string(),
            absolute_path: None,
            hierarchy_path: hierarchy_path(&[root_id]),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
            content_path: None,
        }
    }

    fn directory_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
    ) -> file_entry::Model {
        file_entry::Model {
            id,
            device_id,
            parent_id: Some(parent_id),
            kind: DomainFileEntryKind::Directory,
            name: "current".to_string(),
            absolute_path: None,
            hierarchy_path: hierarchy_path.to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
            content_path: None,
        }
    }

    fn named_directory_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> file_entry::Model {
        let mut entry =
            directory_model(device_id, id, parent_id, hierarchy_path);
        entry.name = name.to_string();
        entry
    }

    fn file_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> file_entry::Model {
        file_entry::Model {
            id,
            device_id,
            parent_id: Some(parent_id),
            kind: DomainFileEntryKind::File,
            name: name.to_string(),
            absolute_path: Some(format!(r"C:\{name}")),
            hierarchy_path: hierarchy_path.to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
            content_path: None,
        }
    }

    fn tree_directory(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> TreeEntry {
        model::map_tree_model(named_directory_model(
            device_id,
            id,
            parent_id,
            hierarchy_path,
            name,
        ))
        .unwrap()
    }

    fn tree_file(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> TreeEntry {
        model::map_tree_model(file_model(
            device_id,
            id,
            parent_id,
            hierarchy_path,
            name,
        ))
        .unwrap()
    }

    fn hierarchy_path(entry_ids: &[Uuid]) -> String {
        entry_ids
            .iter()
            .map(|entry_id| format!("n{}", entry_id.simple()))
            .collect::<Vec<_>>()
            .join(".")
    }

    fn timestamp() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 30, 45)
            .unwrap()
    }
}

mod query_core_tests {
    use super::super::query::core::*;

    #[derive(Debug, PartialEq, Eq)]
    struct Row(u8);

    #[test]
    fn page_finalizer_uses_returned_boundary_only_when_more_rows_exist() {
        let page = finalize_page(vec![Row(1), Row(2), Row(3)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, Some(2));

        let page = finalize_page(vec![Row(1), Row(2)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, None);
    }
}

mod query_model_tests {
    use super::super::query::model::*;
    use super::super::*;
    use crate::file_registry::entities::file_entry;
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn timestamp() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_milli_opt(10, 30, 45, 123)
            .unwrap()
    }

    fn root_model() -> file_entry::Model {
        let timestamp = timestamp();
        file_entry::Model {
            id: Uuid::from_u128(1),
            device_id: Uuid::from_u128(2),
            parent_id: None,
            kind: DomainFileEntryKind::Directory,
            name: "C:\\".to_string(),
            absolute_path: None,
            hierarchy_path: "n00000000000000000000000000000001".to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp,
            updated_at: timestamp,
            content_path: None,
        }
    }

    fn directory_model() -> file_entry::Model {
        let mut entry = root_model();
        entry.id = Uuid::from_u128(3);
        entry.parent_id = Some(Uuid::from_u128(1));
        entry.name = "reports".to_string();
        entry.hierarchy_path =
            "n00000000000000000000000000000001.n00000000000000000000000000000003"
                .to_string();
        entry
    }

    fn file_model() -> file_entry::Model {
        let mut entry = directory_model();
        entry.id = Uuid::from_u128(4);
        entry.kind = DomainFileEntryKind::File;
        entry.name = "report.pdf".to_string();
        entry.absolute_path = Some(r"C:\reports\report.pdf".to_string());
        entry.hierarchy_path = "n00000000000000000000000000000001.n00000000000000000000000000000003.n00000000000000000000000000000004".to_string();
        entry.mime_type = Some("application/pdf".to_string());
        entry.extension = Some("pdf".to_string());
        entry.file_metadata_created_at = Some(timestamp());
        entry.file_metadata_modified_at = Some(timestamp());
        entry.content_path = Some("devices/018f0000/report.pdf".to_string());
        entry
    }

    fn assert_invariant<T>(
        result: Result<T, FilesystemError>,
        expected_code: &'static str,
    ) {
        assert!(matches!(
            result,
            Err(FilesystemError::Invariant(code)) if code == expected_code
        ));
    }

    #[test]
    fn mappers_preserve_all_valid_row_shapes() {
        let root = map_root_model(root_model()).unwrap();
        assert_eq!(root.entry_id, Uuid::from_u128(1));

        let directory = map_directory_model(directory_model()).unwrap();
        assert_eq!(directory.entry_id, Uuid::from_u128(3));
        assert_eq!(directory.parent_entry_id, Uuid::from_u128(1));

        let file = map_file_model(file_model()).unwrap();
        assert_eq!(file.file_id, Uuid::from_u128(4));
        assert_eq!(file.absolute_path, r"C:\reports\report.pdf");
        assert!(file.has_content);

        assert!(matches!(
            map_tree_model(directory_model()),
            Ok(TreeEntry::Directory(_))
        ));
        assert!(matches!(
            map_tree_model(file_model()),
            Ok(TreeEntry::File(_))
        ));
        assert!(matches!(
            map_directory_scope(root_model(), None),
            Ok(DirectoryScope::Root(_))
        ));
        assert!(matches!(
            map_directory_scope(directory_model(), Some(Uuid::from_u128(1))),
            Ok(DirectoryScope::Directory { .. })
        ));
    }

    #[test]
    fn mappers_reject_invalid_shapes_with_stable_invariants() {
        let mut root_with_parent = root_model();
        root_with_parent.parent_id = Some(Uuid::from_u128(9));
        assert_invariant(
            map_root_model(root_with_parent),
            "root_parent_present",
        );

        let mut root_with_path = root_model();
        root_with_path.absolute_path = Some("/".to_string());
        assert_invariant(
            map_root_model(root_with_path),
            "root_absolute_path_present",
        );

        let mut root_with_metadata = root_model();
        root_with_metadata.mime_type = Some("text/plain".to_string());
        assert_invariant(
            map_root_model(root_with_metadata),
            "root_file_metadata_present",
        );

        let mut directory_without_parent = directory_model();
        directory_without_parent.parent_id = None;
        assert_invariant(
            map_directory_model(directory_without_parent),
            "directory_parent_missing",
        );

        let mut directory_with_path = directory_model();
        directory_with_path.absolute_path = Some(r"C:\reports".to_string());
        assert_invariant(
            map_directory_model(directory_with_path),
            "directory_absolute_path_present",
        );

        let mut directory_with_metadata = directory_model();
        directory_with_metadata.extension = Some("tmp".to_string());
        assert_invariant(
            map_directory_model(directory_with_metadata),
            "directory_file_metadata_present",
        );
        let mut directory_with_content = directory_model();
        directory_with_content.content_path =
            Some("devices/018f0000/reports".to_string());
        assert_invariant(
            map_directory_model(directory_with_content),
            "directory_file_metadata_present",
        );

        assert_invariant(
            map_file_model(directory_model()),
            "file_entry_non_file",
        );
        assert_invariant(map_tree_model(root_model()), "tree_root_entry");
        assert_invariant(
            map_directory_scope(file_model(), None),
            "directory_scope_non_directory_entry",
        );
        assert_invariant(
            map_directory_scope(directory_model(), None),
            "directory_scope_root_context_missing",
        );
    }
}

mod query_mutation_file_tests {
    use super::super::query::mutation::file::*;
    use super::super::*;
    use uuid::Uuid;

    #[test]
    fn stale_optimistic_root_is_a_retryable_conflict() {
        let optimistic_root_entry_id = Uuid::from_u128(1);
        let unchanged_path = format!(
            "n{}.n{}",
            optimistic_root_entry_id.simple(),
            Uuid::from_u128(2).simple(),
        );
        ensure_file_root_unchanged(optimistic_root_entry_id, &unchanged_path)
            .unwrap();

        let changed_path = format!(
            "n{}.n{}",
            Uuid::from_u128(3).simple(),
            Uuid::from_u128(2).simple(),
        );
        assert!(matches!(
            ensure_file_root_unchanged(optimistic_root_entry_id, &changed_path,),
            Err(FilesystemError::Conflict)
        ));
    }
}

mod mapping_tests {
    use super::super::bl::{
        map_browse, map_journal, map_roots, map_subtree_counts, map_sync,
    };
    use super::super::*;
    use crate::devices::files::{
        FileJournalEntry, FilesystemFieldError, JournalFilesResult,
        SyncFileItemResult,
    };
    use chrono::NaiveDate;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn roots_use_canonical_wire_fields_and_utc_timestamps() {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 23)
            .unwrap()
            .and_hms_milli_opt(9, 10, 11, 123)
            .unwrap();
        let root = RootEntry {
            entry_id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001")
                .unwrap(),
            device_id: Uuid::parse_str("018f0000-0000-7000-8000-000000000002")
                .unwrap(),
            name: "C:\\".to_string(),
            hierarchy_path: "internal".to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        };

        assert_eq!(
            serde_json::to_value(map_roots(vec![root])).unwrap(),
            json!({
                "roots": [{
                    "entry_id": "018f0000-0000-7000-8000-000000000001",
                    "device_id": "018f0000-0000-7000-8000-000000000002",
                    "parent_entry_id": null,
                    "kind": "directory",
                    "name": "C:\\",
                    "created_at": "2026-07-23T09:10:11.123Z",
                    "updated_at": "2026-07-23T09:10:11.123Z"
                }]
            }),
        );
    }
    #[test]
    fn subtree_counts_preserve_request_order() {
        let first =
            Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let second =
            Uuid::parse_str("018f0000-0000-7000-8000-000000000002").unwrap();

        assert_eq!(
            serde_json::to_value(map_subtree_counts(vec![
                SubtreeFileCount {
                    entry_id: first,
                    file_count: 7,
                },
                SubtreeFileCount {
                    entry_id: second,
                    file_count: 0,
                },
            ]))
            .unwrap(),
            json!({
                "counts": [
                    {
                        "entry_id": "018f0000-0000-7000-8000-000000000001",
                        "file_count": 7
                    },
                    {
                        "entry_id": "018f0000-0000-7000-8000-000000000002",
                        "file_count": 0
                    }
                ]
            }),
        );
    }

    #[test]
    fn browse_rejects_misaligned_path_context() {
        let error = map_browse(BrowseFilesResult {
            breadcrumbs: Vec::new(),
            entries: Vec::new(),
            entry_path_components: vec![Vec::new()],
            next_cursor: None,
        })
        .unwrap_err();
        assert!(matches!(error, AppError::AnyhowError { .. }));
    }

    #[test]
    fn journal_maps_current_sync_timestamp_and_pagination_cursor() {
        let synchronized_at = NaiveDate::from_ymd_opt(2026, 7, 28)
            .unwrap()
            .and_hms_opt(8, 15, 30)
            .unwrap();
        let result = JournalFilesResult {
            entries: vec![FileJournalEntry {
                file_id: Uuid::parse_str(
                    "018f0000-0000-7000-8000-000000000003",
                )
                .unwrap(),
                name: "report.log".to_string(),
                absolute_path: r"C:\var\log\report.log".to_string(),
                has_content: true,
                synchronized_at,
            }],
            next_cursor: Some(
                "018f0000-0000-7000-8000-000000000003".to_string(),
            ),
            total_count: 27,
        };

        assert_eq!(
            serde_json::to_value(map_journal(result)).unwrap(),
            json!({
                "entries": [{
                    "file_id": "018f0000-0000-7000-8000-000000000003",
                    "name": "report.log",
                    "absolute_path": "C:\\var\\log\\report.log",
                    "has_content": true,
                    "synchronized_at": "2026-07-28T08:15:30Z"
                }],
                "total_count": 27,
                "next_cursor": "018f0000-0000-7000-8000-000000000003"
            }),
        );
    }

    #[test]
    fn sync_maps_all_safe_rejection_kinds_in_input_order() {
        let results = [
            SyncFileRejectionKind::Validation,
            SyncFileRejectionKind::NotFound,
            SyncFileRejectionKind::Conflict,
            SyncFileRejectionKind::Dependency,
            SyncFileRejectionKind::Internal,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| SyncFileItemResult {
            index,
            outcome: SyncFileItemOutcome::Rejected {
                kind,
                message: format!("safe-{index}"),
                retry: true,
                field_errors: vec![FilesystemFieldError {
                    path: format!("files[{index}].absolute_path"),
                    message: "invalid".to_string(),
                }],
            },
        })
        .collect();

        let value = serde_json::to_value(map_sync(SyncFilesResult { results }))
            .unwrap();
        let results = value["results"].as_array().unwrap();
        assert_eq!(
            results
                .iter()
                .map(|result| result["error"]["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "validation",
                "not_found",
                "conflict",
                "dependency",
                "internal",
            ],
        );
        for (index, result) in results.iter().enumerate() {
            assert_eq!(result["index"], index);
            assert_eq!(result["status"], "rejected");
            assert!(result.get("retry").is_none());
            let field_errors =
                result["error"]["field_errors"].as_array().unwrap();
            assert_eq!(field_errors.len(), usize::from(index == 0));
        }
    }
}
