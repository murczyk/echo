use super::*;

fn assert_form_field(err: AppError, field: &str) {
    match err {
        AppError::Form(errors) => assert!(errors.contains_key(field)),
        err => panic!("unexpected error: {err:?}"),
    }
}

#[test]
fn device_name_is_trimmed_and_required() {
    assert_eq!(normalize_device_name("  Device  ").unwrap(), "Device");
    assert_form_field(normalize_device_name("   ").unwrap_err(), "name");
}

#[test]
fn present_external_url_requires_nonempty_http_url_with_host() {
    assert_eq!(
        normalize_present_external_url(" https://example.com ".to_string())
            .unwrap(),
        "https://example.com/"
    );

    let empty = normalize_present_external_url("   ".to_string()).unwrap_err();
    match empty {
        AppError::Form(errors) => assert_eq!(
            errors.get("external_url").map(String::as_str),
            Some("Посилання не може бути порожнім")
        ),
        err => panic!("unexpected error: {err:?}"),
    }
    assert_form_field(
        normalize_present_external_url("ftp://example.com".to_string())
            .unwrap_err(),
        "external_url",
    );
    assert_form_field(
        normalize_present_external_url("https:///".to_string()).unwrap_err(),
        "external_url",
    );
    assert_form_field(
        normalize_present_external_url(format!(
            "https://{}/",
            "a".repeat(DEVICE_EXTERNAL_URL_MAX_CHARS)
        ))
        .unwrap_err(),
        "external_url",
    );
}

#[test]
fn unique_aor_ids_are_sorted_and_reject_duplicates() {
    assert_eq!(normalize_unique_aor_ids(vec![9, 2, 5]).unwrap(), [2, 5, 9]);
    assert_eq!(
        normalize_unique_aor_ids(Vec::new()).unwrap(),
        Vec::<i64>::new()
    );
    assert_form_field(
        normalize_unique_aor_ids(vec![2, 2]).unwrap_err(),
        "aor_ids",
    );
}

#[test]
fn source_label_and_custom_fields_are_normalized_without_special_keys() {
    assert_eq!(
        normalize_source_label("  source-device  ").unwrap(),
        "source-device"
    );
    assert_form_field(
        normalize_source_label("   ").unwrap_err(),
        "source_label",
    );

    let fields = normalize_custom_fields(BTreeMap::from([
        (" inventory_id ".to_string(), "node-1".to_string()),
        ("source_port".to_string(), "not-a-port".to_string()),
    ]))
    .unwrap();
    assert_eq!(
        fields,
        BTreeMap::from([
            ("inventory_id".to_string(), "node-1".to_string()),
            ("source_port".to_string(), "not-a-port".to_string()),
        ])
    );

    let patch = normalize_custom_fields_patch(BTreeMap::from([
        (" inventory_id ".to_string(), Some("node-2".to_string())),
        ("source_port".to_string(), None),
    ]))
    .unwrap();
    assert_eq!(
        patch,
        BTreeMap::from([
            ("inventory_id".to_string(), Some("node-2".to_string())),
            ("source_port".to_string(), None),
        ])
    );
    assert_form_field(
        normalize_custom_fields(BTreeMap::from([(
            " ".to_string(),
            "value".to_string(),
        )]))
        .unwrap_err(),
        "custom_fields",
    );
    assert_form_field(
        normalize_custom_fields_patch(BTreeMap::from([
            (" inventory_id ".to_string(), Some("node-1".to_string())),
            ("inventory_id".to_string(), Some("node-2".to_string())),
        ]))
        .unwrap_err(),
        "custom_fields",
    );
}
