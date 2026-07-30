use crate::devices::api::types::{
    format_datetime, AorSummary, DeviceDetails, DeviceListItem,
    DeviceStatusCounts, DeviceUnitStat as DeviceUnitStatDto,
    DeviceUnitStatsRsp, ListDevicesRsp, UnitSummary,
};
use crate::devices::service::{
    DeviceAorReference, DeviceCurrentState, DeviceUnitReference,
    DeviceUnitStat, ListDevicesResult,
};

pub(in crate::devices) fn map_device_details(
    device: DeviceCurrentState,
) -> DeviceDetails {
    DeviceDetails {
        id: device.id.hyphenated().to_string(),
        source_label: device.source_label,
        name: device.name,
        aors: device.aors.into_iter().map(map_aor).collect(),
        unit: device.unit.map(map_unit),
        external_url: device.external_url,
        custom_fields: device.custom_fields,
        created_by: device.created_by,
        archived: device.archived,
        created_at: format_datetime(device.created_at),
        updated_at: format_datetime(device.updated_at),
        archived_at: device.archived_at.map(format_datetime),
    }
}

pub(in crate::devices) fn map_device_list(
    result: ListDevicesResult,
) -> ListDevicesRsp {
    ListDevicesRsp {
        list: result
            .devices
            .into_iter()
            .map(map_device_list_item)
            .collect(),
        total: result.total,
        has_more: result.has_more,
        status_counts: DeviceStatusCounts {
            active: result.status_counts.active,
            archived: result.status_counts.archived,
        },
    }
}

pub(in crate::devices) fn map_device_unit_stats(
    units: Vec<DeviceUnitStat>,
) -> DeviceUnitStatsRsp {
    DeviceUnitStatsRsp {
        units: units
            .into_iter()
            .map(|unit| DeviceUnitStatDto {
                unit: map_unit(unit.unit),
                count: unit.count,
            })
            .collect(),
    }
}

fn map_device_list_item(device: DeviceCurrentState) -> DeviceListItem {
    DeviceListItem {
        id: device.id.hyphenated().to_string(),
        source_label: device.source_label,
        name: device.name,
        aors: device.aors.into_iter().map(map_aor).collect(),
        unit: device.unit.map(map_unit),
        created_by: device.created_by,
        archived: device.archived,
        created_at: format_datetime(device.created_at),
        updated_at: format_datetime(device.updated_at),
        archived_at: device.archived_at.map(format_datetime),
    }
}

fn map_aor(aor: DeviceAorReference) -> AorSummary {
    AorSummary {
        id: aor.id,
        name: aor.name,
    }
}

fn map_unit(unit: DeviceUnitReference) -> UnitSummary {
    UnitSummary {
        id: unit.id,
        name: unit.name,
    }
}

#[cfg(test)]
mod tests {
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
            id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001")
                .unwrap(),
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
}
