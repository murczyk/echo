use super::*;
use crate::devices::api::types::{
    NullablePatch, RequiredPatch, SearchDeviceFilesReq, SyncDeviceFilesReq,
    UpdateDeviceReq,
};

fn form_path<T>(result: Result<T, AppError>) -> String {
    let Err(AppError::Form(errors)) = result else {
        panic!("expected form error");
    };
    errors.into_keys().next().unwrap()
}

#[test]
fn decode_reports_top_level_and_nested_structural_paths() {
    assert_eq!(
        form_path(decode_json::<UpdateDeviceReq>(br#"{"unexpected":1}"#)),
        "unexpected"
    );
    assert_eq!(
        form_path(decode_json::<SyncDeviceFilesReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a","unexpected":1}]}"#,
        )),
        "files[0].unexpected"
    );
    assert_eq!(form_path(decode_json::<UpdateDeviceReq>(b"{")), "body",);
}

#[test]
fn decode_rejects_noncanonical_uuid_and_explicit_null_file_id() {
    assert_eq!(
        form_path(decode_json::<SyncDeviceFilesReq>(
            br#"{"device_id":"018F0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a"}]}"#,
        )),
        "device_id"
    );
    assert_eq!(
        form_path(decode_json::<SyncDeviceFilesReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"file_id":null,"absolute_path":"/a"}]}"#,
        )),
        "files[0].file_id"
    );
}

#[test]
fn decode_preserves_missing_null_and_value_patch_states() {
    let request = decode_json::<UpdateDeviceReq>(
        br#"{"device_id":"018f0000-0000-7000-8000-000000000000","external_url":null,"custom_fields":{},"name":"Analytical"}"#,
    )
    .unwrap();

    assert_eq!(request.source_label, RequiredPatch::Missing);
    assert_eq!(request.external_url, NullablePatch::Null);
    assert_eq!(request.custom_fields, RequiredPatch::Value(BTreeMap::new()),);
    assert_eq!(request.name, NullablePatch::Value("Analytical".to_string()),);
    assert_eq!(request.aor_ids, RequiredPatch::Missing);
    assert_eq!(request.unit_id, NullablePatch::Missing);

    assert_eq!(
        form_path(decode_json::<UpdateDeviceReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","source_label":null}"#,
        )),
        "source_label",
    );
}

#[test]
fn timestamp_filters_require_a_zone_but_sync_timestamps_are_item_data() {
    assert_eq!(
        form_path(decode_json::<SearchDeviceFilesReq>(
            br#"{"device_id":"018f0000-0000-7000-8000-000000000000","scope_entry_id":"018f0000-0000-7000-8000-000000000001","file_metadata_modified_from":"2026-07-23T12:00:00"}"#,
        )),
        "file_metadata_modified_from",
    );

    let request = decode_json::<SyncDeviceFilesReq>(
        br#"{"device_id":"018f0000-0000-7000-8000-000000000000","path_syntax":"posix","files":[{"absolute_path":"/a","file_metadata_created_at":"not-a-timestamp"}]}"#,
    )
    .unwrap();
    assert_eq!(
        request.files[0].file_metadata_created_at.as_deref(),
        Some("not-a-timestamp"),
    );
}
