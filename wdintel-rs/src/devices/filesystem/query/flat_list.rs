use crate::devices::filesystem::{
    FileEntry, FileEntryKind, FilesystemError, OffsetPage, OffsetPageRequest,
    PathSyntax,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn list_files_offset(
    db: &DatabaseConnection,
    device_id: Uuid,
    page: OffsetPageRequest,
) -> Result<OffsetPage<FileEntry>, FilesystemError> {
    let query = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File.as_db_str()));
    let total = query
        .clone()
        .count(db)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;
    let files = query
        .order_by_desc(file_entry::Column::UpdatedAt)
        .order_by_desc(file_entry::Column::Id)
        .offset(page.offset)
        .limit(page.limit)
        .all(db)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;
    let returned_len = files.len() as u64;
    let entries = files
        .into_iter()
        .map(map_file_model)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(OffsetPage {
        entries,
        total,
        has_more: page.offset + returned_len < total,
    })
}

fn map_file_model(
    file: file_entry::Model,
) -> Result<FileEntry, FilesystemError> {
    let kind = FileEntryKind::try_from(file.kind.as_str())?;
    if kind != FileEntryKind::File {
        return Err(FilesystemError::Invariant("flat_list_non_file_entry"));
    }

    let parent_entry_id = file
        .parent_id
        .ok_or(FilesystemError::Invariant("file_parent_missing"))?;
    let path_syntax = file
        .path_syntax
        .as_deref()
        .ok_or(FilesystemError::Invariant("file_path_syntax_missing"))
        .and_then(PathSyntax::try_from)?;
    let absolute_path = file
        .absolute_path
        .ok_or(FilesystemError::Invariant("file_absolute_path_missing"))?;

    Ok(FileEntry {
        file_id: file.id,
        device_id: file.device_id,
        parent_entry_id,
        name: file.name,
        name_key: file.name_key,
        path_syntax,
        absolute_path,
        hierarchy_path: file.hierarchy_path,
        mime_type: file.mime_type,
        extension: file.extension,
        file_metadata_created_at: file.file_metadata_created_at,
        file_metadata_modified_at: file.file_metadata_modified_at,
        created_at: file.created_at,
        updated_at: file.updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn valid_file_model() -> file_entry::Model {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_milli_opt(10, 30, 45, 123)
            .unwrap();

        file_entry::Model {
            id: Uuid::from_u128(0x018f0000000070008000000000000001),
            device_id: Uuid::from_u128(
                0x018f0000000070008000000000000000,
            ),
            parent_id: Some(Uuid::from_u128(
                0x018f0000000070008000000000000002,
            )),
            kind: "file".to_string(),
            name: "report.pdf".to_string(),
            name_key: b"report.pdf".to_vec(),
            path_syntax: Some("posix".to_string()),
            absolute_path: Some("/reports/report.pdf".to_string()),
            hierarchy_path: "n018f0000000070008000000000000002.n018f0000000070008000000000000001".to_string(),
            mime_type: Some("application/pdf".to_string()),
            extension: Some("pdf".to_string()),
            file_metadata_created_at: Some(timestamp),
            file_metadata_modified_at: Some(timestamp),
            created_at: timestamp,
            updated_at: timestamp,
        }
    }

    fn assert_invariant(
        result: Result<FileEntry, FilesystemError>,
        expected_code: &'static str,
    ) {
        assert!(matches!(
            result,
            Err(FilesystemError::Invariant(code)) if code == expected_code
        ));
    }

    #[test]
    fn map_file_model_preserves_valid_file_fields() {
        let file = map_file_model(valid_file_model()).unwrap();

        assert_eq!(
            file.file_id,
            Uuid::from_u128(0x018f0000000070008000000000000001)
        );
        assert_eq!(
            file.device_id,
            Uuid::from_u128(0x018f0000000070008000000000000000)
        );
        assert_eq!(
            file.parent_entry_id,
            Uuid::from_u128(0x018f0000000070008000000000000002)
        );
        assert_eq!(file.name, "report.pdf");
        assert_eq!(file.name_key, b"report.pdf");
        assert_eq!(file.path_syntax, PathSyntax::Posix);
        assert_eq!(file.absolute_path, "/reports/report.pdf");
        assert_eq!(
            file.hierarchy_path,
            "n018f0000000070008000000000000002.n018f0000000070008000000000000001"
        );
        assert_eq!(file.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(file.extension.as_deref(), Some("pdf"));
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_milli_opt(10, 30, 45, 123)
            .unwrap();
        assert_eq!(file.file_metadata_created_at, Some(timestamp));
        assert_eq!(file.file_metadata_modified_at, Some(timestamp));
        assert_eq!(file.created_at, timestamp);
        assert_eq!(file.updated_at, timestamp);
    }

    #[test]
    fn map_file_model_rejects_impossible_file_shapes() {
        let mut unknown_kind = valid_file_model();
        unknown_kind.kind = "unknown".to_string();
        assert_invariant(
            map_file_model(unknown_kind),
            "unknown_file_entry_kind",
        );

        let mut directory = valid_file_model();
        directory.kind = "directory".to_string();
        assert_invariant(map_file_model(directory), "flat_list_non_file_entry");

        let mut missing_parent = valid_file_model();
        missing_parent.parent_id = None;
        assert_invariant(map_file_model(missing_parent), "file_parent_missing");

        let mut unknown_syntax = valid_file_model();
        unknown_syntax.path_syntax = Some("unknown".to_string());
        assert_invariant(map_file_model(unknown_syntax), "unknown_path_syntax");

        let mut missing_syntax = valid_file_model();
        missing_syntax.path_syntax = None;
        assert_invariant(
            map_file_model(missing_syntax),
            "file_path_syntax_missing",
        );

        let mut missing_absolute_path = valid_file_model();
        missing_absolute_path.absolute_path = None;
        assert_invariant(
            map_file_model(missing_absolute_path),
            "file_absolute_path_missing",
        );
    }
}
