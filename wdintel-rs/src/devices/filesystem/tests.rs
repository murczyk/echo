use super::{FilesystemRepository, OffsetPageRequest};
use crate::devices::query::list_device_files;
use crate::devices::types::{
    DeviceFileEntry, ListDeviceFilesReq, ListDeviceFilesRsp,
};
use crate::entities::{device, login};
use crate::file_registry::entities::file_entry;
use crate::functest::tests::{cleanup_locked, mk_login};
use crate::types::{AppError, Uuid};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection};
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
