pub(crate) const ROLE_CYBER: &str = "Cyber";
pub(crate) const ROLE_DEVICE_SOURCE: &str = "DeviceSource";

pub(crate) mod access;
pub(crate) mod analytics;

#[allow(clippy::module_inception)]
pub(crate) mod devices;
pub(crate) mod files;
mod mattermost;
pub(crate) mod settings;
#[cfg(test)]
mod tests;
pub(crate) mod types;
