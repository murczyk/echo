use super::FilesystemError;
use crate::config::DEVICE_FILE_CURSOR_MAX_BYTES;
use uuid::Uuid;

#[allow(dead_code)]
pub(in crate::devices) struct FileCursorCodec;

#[allow(dead_code)]
impl FileCursorCodec {
    pub(in crate::devices) fn encode(boundary_entry_id: Uuid) -> String {
        boundary_entry_id.to_string()
    }

    pub(in crate::devices) fn decode(
        cursor: &str,
    ) -> Result<Uuid, FilesystemError> {
        if cursor.len() > DEVICE_FILE_CURSOR_MAX_BYTES {
            return Err(FilesystemError::invalid_cursor());
        }
        Uuid::parse_str(cursor).map_err(|_| FilesystemError::invalid_cursor())
    }
}

#[cfg(test)]
mod tests;
