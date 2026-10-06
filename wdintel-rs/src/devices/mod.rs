pub(crate) use crate::config::ROLE_CYBER;

pub(crate) mod access;
pub(crate) mod analytics;
#[allow(
    dead_code,
    reason = "Foundation interfaces are consumed by subsequent audio tasks"
)]
pub(crate) mod audio;

#[allow(clippy::module_inception)]
pub(crate) mod devices;
pub(crate) mod files;
mod mattermost;
pub(crate) mod settings;
#[cfg(test)]
mod tests;
pub(crate) mod types;
