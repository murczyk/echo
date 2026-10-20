use super::manifest::Limits;
use crate::devices::config::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Policy {
    pub manifest: Limits,
    pub source_bytes: u64,
    pub expanded_bytes: u64,
    pub root_ratio: u64,
    pub max_depth: u64,
    pub attempt_seconds: u64,
    pub recovery_seconds: u64,
    pub max_attempts: u64,
    pub retry_seconds: Vec<u64>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            manifest: Limits::default(),
            source_bytes: DEVICE_FILE_ARCHIVE_SOURCE_MAX_BYTES,
            expanded_bytes: DEVICE_FILE_ARCHIVE_ROOT_EXPANDED_MAX_BYTES,
            root_ratio: DEVICE_FILE_ARCHIVE_ROOT_MAX_RATIO,
            max_depth: DEVICE_FILE_ARCHIVE_MAX_DEPTH,
            attempt_seconds: DEVICE_FILE_ARCHIVE_ATTEMPT_SECONDS,
            recovery_seconds: DEVICE_FILE_ARCHIVE_RECOVERY_SECONDS,
            max_attempts: DEVICE_FILE_ARCHIVE_MAX_ATTEMPTS,
            retry_seconds: DEVICE_FILE_ARCHIVE_RETRY_SECONDS.to_vec(),
        }
    }
}
