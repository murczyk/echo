use super::{
    ancestor_expr, descendant_expr, query, Breadcrumb, EntryQueryScope,
    EntrySortKey, FileCursorCodec, FileEntryKind, FileSearchFilters,
    FilesystemError, FilesystemRepository, KeysetPageRequest,
    OffsetPageRequest, PathSyntax, RawFileSearchFilters, TreeEntry,
};
use crate::config::read_config;
use crate::devices::query::list_device_files;
use crate::devices::types::{
    DeviceFileEntry, ListDeviceFilesReq, ListDeviceFilesRsp,
};
use crate::entities::{device, login};
use crate::file_registry::entities::file_entry;
use crate::file_registry::{connect_runtime, run_migrations};
use crate::functest::tests::{cleanup_locked, mk_login};
use crate::types::{AppError, Mode, Uuid};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, QueryFilter, QuerySelect,
};
use serde_json::json;

#[tokio::test]
#[serial_test::serial]
async fn flat_list_repository_preserves_legacy_contract() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(12, 30, 45, 123)
        .unwrap();
    let target_device_id = Uuid::from_u128(0x018f0000000070008000000000000100);
    let empty_device_id = Uuid::from_u128(0x018f0000000070008000000000000200);
    let orphan_device_id = Uuid::from_u128(0x018f0000000070008000000000000300);
    let target_root_id = Uuid::from_u128(0x018f0000000070008000000000000400);
    let target_nested_directory_id =
        Uuid::from_u128(0x018f0000000070008000000000000500);
    let target_extra_directory_id =
        Uuid::from_u128(0x018f0000000070008000000000000600);
    let lower_file_id = Uuid::from_u128(0x018f0000000070008000000000000700);
    let higher_file_id = Uuid::from_u128(0x018f0000000070008000000000000800);
    let orphan_root_id = Uuid::from_u128(0x018f0000000070008000000000000900);
    let orphan_directory_id =
        Uuid::from_u128(0x018f0000000070008000000000000a00);
    let orphan_file_id = Uuid::from_u128(0x018f0000000070008000000000000b00);

    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("filesystem-list-{}", Uuid::now_v7())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    insert_device(
        &env.dbx,
        target_device_id,
        &login.login,
        "filesystem-target",
        timestamp,
    )
    .await;
    insert_device(
        &env.dbx,
        empty_device_id,
        &login.login,
        "filesystem-empty",
        timestamp,
    )
    .await;

    let file_registry_db = env.file_registry_db.connection();
    let target_root_path = uuid_label(target_root_id);
    let target_nested_path = format!(
        "{target_root_path}.{}",
        uuid_label(target_nested_directory_id)
    );
    insert_file_entry(
        file_registry_db,
        root_entry(target_root_id, target_device_id, timestamp),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        directory_entry(
            target_nested_directory_id,
            target_device_id,
            target_root_id,
            &target_root_path,
            "reports",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        file_entry_row(
            lower_file_id,
            target_device_id,
            target_nested_directory_id,
            &target_nested_path,
            "first.log",
            "/target/reports/first.log",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        file_entry_row(
            higher_file_id,
            target_device_id,
            target_nested_directory_id,
            &target_nested_path,
            "second.log",
            "/target/reports/second.log",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        directory_entry(
            target_extra_directory_id,
            target_device_id,
            target_root_id,
            &target_root_path,
            "empty",
            timestamp,
        ),
    )
    .await;

    let orphan_root_path = uuid_label(orphan_root_id);
    let orphan_directory_path =
        format!("{orphan_root_path}.{}", uuid_label(orphan_directory_id));
    insert_file_entry(
        file_registry_db,
        root_entry(orphan_root_id, orphan_device_id, timestamp),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        directory_entry(
            orphan_directory_id,
            orphan_device_id,
            orphan_root_id,
            &orphan_root_path,
            "reports",
            timestamp,
        ),
    )
    .await;
    insert_file_entry(
        file_registry_db,
        file_entry_row(
            orphan_file_id,
            orphan_device_id,
            orphan_directory_id,
            &orphan_directory_path,
            "orphan.log",
            "/orphan/reports/orphan.log",
            timestamp,
        ),
    )
    .await;

    let repository = FilesystemRepository::new(&env.file_registry_db);
    let first_page = repository
        .list_files_offset(
            target_device_id,
            OffsetPageRequest {
                limit: 1,
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(first_page.entries.len(), 1);
    assert_eq!(first_page.entries[0].file_id, higher_file_id);
    assert_eq!(
        first_page.entries[0].absolute_path,
        "/target/reports/second.log"
    );
    assert_eq!(
        first_page.entries[0].file_metadata_created_at,
        Some(timestamp - Duration::hours(2))
    );
    assert_eq!(
        first_page.entries[0].file_metadata_modified_at,
        Some(timestamp - Duration::hours(1))
    );
    assert_eq!(first_page.total, 2);
    assert!(first_page.has_more);

    let second_page = repository
        .list_files_offset(
            target_device_id,
            OffsetPageRequest {
                limit: 1,
                offset: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(second_page.entries.len(), 1);
    assert_eq!(second_page.entries[0].file_id, lower_file_id);
    assert_eq!(second_page.total, 2);
    assert!(!second_page.has_more);

    let zero_limit_page = repository
        .list_files_offset(
            target_device_id,
            OffsetPageRequest {
                limit: 0,
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert!(zero_limit_page.entries.is_empty());
    assert_eq!(zero_limit_page.total, 2);
    assert!(zero_limit_page.has_more);

    let after_end_page = repository
        .list_files_offset(
            target_device_id,
            OffsetPageRequest {
                limit: 1,
                offset: 3,
            },
        )
        .await
        .unwrap();
    assert!(after_end_page.entries.is_empty());
    assert_eq!(after_end_page.total, 2);
    assert!(!after_end_page.has_more);

    let empty_page = repository
        .list_files_offset(
            empty_device_id,
            OffsetPageRequest {
                limit: 1,
                offset: 0,
            },
        )
        .await
        .unwrap();
    assert!(empty_page.entries.is_empty());
    assert_eq!(empty_page.total, 0);
    assert!(!empty_page.has_more);

    let response = list_device_files(
        &env.dbx,
        &env.file_registry_db,
        &ListDeviceFilesReq {
            device_id: target_device_id.to_string(),
            limit: Some(10),
            offset: Some(0),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        response,
        ListDeviceFilesRsp {
            list: vec![
                expected_device_file_entry(
                    higher_file_id,
                    target_device_id,
                    target_nested_directory_id,
                    "second.log",
                    "/target/reports/second.log",
                    timestamp,
                ),
                expected_device_file_entry(
                    lower_file_id,
                    target_device_id,
                    target_nested_directory_id,
                    "first.log",
                    "/target/reports/first.log",
                    timestamp,
                ),
            ],
            total: 2,
            has_more: false,
        }
    );

    let error = list_device_files(
        &env.dbx,
        &env.file_registry_db,
        &ListDeviceFilesReq {
            device_id: orphan_device_id.to_string(),
            limit: Some(10),
            offset: Some(0),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(error, AppError::NotFound));
}

async fn insert_device(
    db: &DatabaseConnection,
    id: Uuid,
    created_by: &str,
    source_label: &str,
    timestamp: NaiveDateTime,
) {
    device::ActiveModel {
        id: Set(id),
        name: Set(Some("Filesystem fixture device".to_string())),
        created_by: Set(created_by.to_string()),
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
    }
}

fn expected_device_file_entry(
    file_id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    name: &str,
    absolute_path: &str,
    timestamp: NaiveDateTime,
) -> DeviceFileEntry {
    DeviceFileEntry {
        file_id: file_id.to_string(),
        device_id: device_id.to_string(),
        parent_id: Some(parent_id.to_string()),
        name: name.to_string(),
        path_syntax: Some("posix".to_string()),
        absolute_path: Some(absolute_path.to_string()),
        mime_type: Some("text/plain".to_string()),
        extension: Some("log".to_string()),
        file_metadata_created_at_ms: Some(datetime_ms(
            timestamp - Duration::hours(2),
        )),
        file_metadata_modified_at_ms: Some(datetime_ms(
            timestamp - Duration::hours(1),
        )),
        created_at_ms: datetime_ms(timestamp),
        updated_at_ms: datetime_ms(timestamp),
    }
}

fn datetime_ms(timestamp: NaiveDateTime) -> i64 {
    timestamp.and_utc().timestamp_millis()
}

fn uuid_label(id: Uuid) -> String {
    format!("n{}", id.to_string().replace('-', ""))
}

#[tokio::test]
#[serial_test::serial]
async fn stage_two_runtime_scopes_filters_ltree_and_cursor_contracts() {
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let db = file_registry_db.connection();
    db.execute_unprepared("truncate table public.file_entry")
        .await
        .unwrap();

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

    db.execute_unprepared("truncate table public.file_entry")
        .await
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn stage_three_root_listing_browse_and_breadcrumbs() {
    let config = read_config(Mode::Test).unwrap();
    run_migrations(&config, Mode::Test).await.unwrap();
    let file_registry_db = connect_runtime(&config, Mode::Test).await.unwrap();
    let db = file_registry_db.connection();
    db.execute_unprepared("truncate table public.file_entry")
        .await
        .unwrap();

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

    db.execute_unprepared("truncate table public.file_entry")
        .await
        .unwrap();
}

struct StageTwoTree {
    device_id: Uuid,
    other_device_id: Uuid,
    root_id: Uuid,
    reports_id: Uuid,
    archive_id: Uuid,
    nested_file_id: Uuid,
    duplicate_file_ids: [Uuid; 3],
    percent_file_id: Uuid,
    underscore_file_id: Uuid,
    backslash_file_id: Uuid,
    metadata_file_id: Uuid,
    metadata_modified_at: NaiveDateTime,
    movable_file_id: Uuid,
    outside_file_id: Uuid,
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
        nested_file_id,
        duplicate_file_ids,
        percent_file_id,
        underscore_file_id,
        backslash_file_id,
        metadata_file_id,
        metadata_modified_at,
        movable_file_id,
        outside_file_id,
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

fn search_filters(
    name_query: Option<&str>,
    mime_types: &[&str],
    extensions: &[&str],
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
) -> FileSearchFilters {
    FileSearchFilters::try_from(RawFileSearchFilters {
        kinds: vec![FileEntryKind::File],
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
    let mut query = query::apply_entry_scope(file_entry::Entity::find(), scope);
    query = query::apply_entry_order(query);
    if let Some(after) = after {
        query = query.filter(query::entry_strict_after_condition(after));
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
