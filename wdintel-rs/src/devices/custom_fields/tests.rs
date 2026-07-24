use super::*;
use serde_json::json;

#[test]
fn custom_fields_round_trip_and_patch_keep_arbitrary_keys() {
    let fields = BTreeMap::from([
        ("inventory_id".to_string(), "node-1".to_string()),
        ("source_port".to_string(), "not-a-port".to_string()),
        ("source_version".to_string(), "2026.07".to_string()),
    ]);
    let value = custom_fields_to_json(fields.clone());
    assert_eq!(custom_fields_from_json(&value).unwrap(), fields);

    let patched = apply_custom_fields_patch(
        &value,
        BTreeMap::from([
            ("source_port".to_string(), None),
            ("source_version".to_string(), Some("2026.08".to_string())),
        ]),
    )
    .unwrap();
    assert_eq!(
        patched,
        json!({
            "inventory_id": "node-1",
            "source_version": "2026.08",
        })
    );
}

#[test]
fn custom_fields_reject_non_string_values() {
    assert!(custom_fields_from_json(&json!({"inventory_id": 22})).is_err());
}
