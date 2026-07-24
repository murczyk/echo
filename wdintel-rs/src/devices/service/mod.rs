mod read;
#[cfg(test)]
mod tests;
mod types;
mod write;

pub(in crate::devices) use types::{
    CreateDeviceCommand, DeviceAorReference, DeviceArchivedScope,
    DeviceCurrentState, DeviceListSort, DevicePatchField, DeviceStatusCounts,
    DeviceUnitReference, DeviceUnitStat, ListDevicesCommand, ListDevicesResult,
    UpdateDeviceCommand,
};

pub(in crate::devices) struct DeviceService;
