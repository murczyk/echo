use super::*;
use crate::devices::filesystem::{
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
        name: "/".to_string(),
        name_key: vec![1],
        path_syntax: PathSyntax::Posix,
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
                "name": "/",
                "path_syntax": "posix",
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
            file_id: Uuid::parse_str("018f0000-0000-7000-8000-000000000003")
                .unwrap(),
            name: "report.log".to_string(),
            absolute_path: "/var/log/report.log".to_string(),
            has_content: true,
            synchronized_at,
        }],
        next_cursor: Some("018f0000-0000-7000-8000-000000000003".to_string()),
        total_count: 27,
    };

    assert_eq!(
        serde_json::to_value(map_journal(result)).unwrap(),
        json!({
            "entries": [{
                "file_id": "018f0000-0000-7000-8000-000000000003",
                "name": "report.log",
                "absolute_path": "/var/log/report.log",
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

    let value =
        serde_json::to_value(map_sync(SyncFilesResult { results })).unwrap();
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
        let field_errors = result["error"]["field_errors"].as_array().unwrap();
        assert_eq!(field_errors.len(), usize::from(index == 0));
    }
}
