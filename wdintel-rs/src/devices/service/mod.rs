mod read;
#[cfg(test)]
mod tests;
mod types;
mod write;

pub(in crate::devices) use types::{
    CreateDeviceCommand, DeviceAorReference, DeviceCurrentState,
    DevicePatchField, DeviceUnitReference, UpdateDeviceCommand,
};

pub(in crate::devices) struct DeviceService;
