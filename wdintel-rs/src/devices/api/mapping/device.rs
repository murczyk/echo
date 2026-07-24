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
mod tests;
