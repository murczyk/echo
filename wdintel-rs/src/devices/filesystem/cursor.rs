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
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips_boundary_uuid() {
        let boundary_entry_id = Uuid::from_u128(4);
        let cursor = FileCursorCodec::encode(boundary_entry_id);

        assert_eq!(cursor, boundary_entry_id.to_string());
        assert_eq!(
            FileCursorCodec::decode(&cursor).unwrap(),
            boundary_entry_id
        );
    }

    #[test]
    fn decode_rejects_malformed_and_oversized_cursors() {
        for cursor in [
            "not-a-uuid".to_string(),
            "a".repeat(DEVICE_FILE_CURSOR_MAX_BYTES + 1),
        ] {
            assert!(matches!(
                FileCursorCodec::decode(&cursor),
                Err(FilesystemError::Validation(_))
            ));
        }
    }
}
