use super::*;
use crate::devices::service::DeviceStatusCounts as DomainStatusCounts;
use crate::types::BTreeMap;
use chrono::NaiveDate;
use serde_json::json;
use uuid::Uuid;

fn device_state() -> DeviceCurrentState {
    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 23)
        .unwrap()
        .and_hms_opt(9, 10, 11)
        .unwrap();
    DeviceCurrentState {
        id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap(),
        source_label: "source".to_string(),
        name: None,
        aors: vec![DeviceAorReference {
            id: 7,
            name: "AOR".to_string(),
        }],
        unit: Some(DeviceUnitReference {
            id: 8,
            name: "Unit".to_string(),
        }),
        external_url: Some("https://example.com".to_string()),
        custom_fields: BTreeMap::from([(
            "inventory_id".to_string(),
            "42".to_string(),
        )]),
        created_by: "reader".to_string(),
        archived: true,
        archived_at: Some(timestamp),
        created_at: timestamp,
        updated_at: timestamp,
    }
}

#[test]
fn detail_and_list_have_distinct_exact_wire_shapes() {
    assert_eq!(
        serde_json::to_value(map_device_details(device_state())).unwrap(),
        json!({
            "id": "018f0000-0000-7000-8000-000000000001",
            "source_label": "source",
            "name": null,
            "aors": [{"id": 7, "name": "AOR"}],
            "unit": {"id": 8, "name": "Unit"},
            "external_url": "https://example.com",
            "custom_fields": {"inventory_id": "42"},
            "created_by": "reader",
            "archived": true,
            "created_at": "2026-07-23T09:10:11Z",
            "updated_at": "2026-07-23T09:10:11Z",
            "archived_at": "2026-07-23T09:10:11Z"
        }),
    );

    assert_eq!(
        serde_json::to_value(map_device_list(ListDevicesResult {
            devices: vec![device_state()],
            total: 1,
            has_more: false,
            status_counts: DomainStatusCounts {
                active: 0,
                archived: 1,
            },
        }))
        .unwrap(),
        json!({
            "list": [{
                "id": "018f0000-0000-7000-8000-000000000001",
                "source_label": "source",
                "name": null,
                "aors": [{"id": 7, "name": "AOR"}],
                "unit": {"id": 8, "name": "Unit"},
                "created_by": "reader",
                "archived": true,
                "created_at": "2026-07-23T09:10:11Z",
                "updated_at": "2026-07-23T09:10:11Z",
                "archived_at": "2026-07-23T09:10:11Z"
            }],
            "total": 1,
            "has_more": false,
            "status_counts": {"active": 0, "archived": 1}
        }),
    );
}
