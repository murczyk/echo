pub(crate) const ROLE_CYBER: &str = "Cyber";
pub(crate) const ROLE_DEVICE_SOURCE: &str = "DeviceSource";

mod access;

#[allow(clippy::module_inception)]
pub(crate) mod devices;
pub(crate) mod files;
#[cfg(test)]
mod tests;
pub(crate) mod types;
