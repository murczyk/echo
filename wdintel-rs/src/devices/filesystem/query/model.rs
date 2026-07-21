use crate::devices::filesystem::{
    DirectoryEntry, DirectoryScope, FileEntry, FileEntryKind, FilesystemError,
    PathSyntax, RootEntry, TreeEntry,
};
use crate::file_registry::entities::file_entry;

pub(super) fn map_root_model(
    entry: file_entry::Model,
) -> Result<RootEntry, FilesystemError> {
    ensure_directory_kind(&entry, "root_non_directory_entry")?;
    if entry.parent_id.is_some() {
        return Err(FilesystemError::Invariant("root_parent_present"));
    }
    let path_syntax = required_path_syntax(&entry, "root_path_syntax_missing")?;
    if entry.absolute_path.is_some() {
        return Err(FilesystemError::Invariant("root_absolute_path_present"));
    }
    ensure_directory_metadata_absent(&entry, "root_file_metadata_present")?;

    Ok(RootEntry {
        entry_id: entry.id,
        device_id: entry.device_id,
        name: entry.name,
        name_key: entry.name_key,
        path_syntax,
        hierarchy_path: entry.hierarchy_path,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    })
}

pub(super) fn map_directory_model(
    entry: file_entry::Model,
) -> Result<DirectoryEntry, FilesystemError> {
    ensure_directory_kind(&entry, "directory_non_directory_entry")?;
    let parent_entry_id = entry
        .parent_id
        .ok_or(FilesystemError::Invariant("directory_parent_missing"))?;
    if entry.path_syntax.is_some() {
        return Err(FilesystemError::Invariant(
            "directory_path_syntax_present",
        ));
    }
    if entry.absolute_path.is_some() {
        return Err(FilesystemError::Invariant(
            "directory_absolute_path_present",
        ));
    }
    ensure_directory_metadata_absent(
        &entry,
        "directory_file_metadata_present",
    )?;

    Ok(DirectoryEntry {
        entry_id: entry.id,
        device_id: entry.device_id,
        parent_entry_id,
        name: entry.name,
        name_key: entry.name_key,
        hierarchy_path: entry.hierarchy_path,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    })
}

pub(super) fn map_file_model(
    entry: file_entry::Model,
) -> Result<FileEntry, FilesystemError> {
    if FileEntryKind::try_from(entry.kind.as_str())? != FileEntryKind::File {
        return Err(FilesystemError::Invariant("file_entry_non_file"));
    }
    let parent_entry_id = entry
        .parent_id
        .ok_or(FilesystemError::Invariant("file_parent_missing"))?;
    let path_syntax = required_path_syntax(&entry, "file_path_syntax_missing")?;
    let absolute_path = entry
        .absolute_path
        .ok_or(FilesystemError::Invariant("file_absolute_path_missing"))?;

    Ok(FileEntry {
        file_id: entry.id,
        device_id: entry.device_id,
        parent_entry_id,
        name: entry.name,
        name_key: entry.name_key,
        path_syntax,
        absolute_path,
        hierarchy_path: entry.hierarchy_path,
        mime_type: entry.mime_type,
        extension: entry.extension,
        file_metadata_created_at: entry.file_metadata_created_at,
        file_metadata_modified_at: entry.file_metadata_modified_at,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    })
}

#[allow(dead_code)]
pub(super) fn map_tree_model(
    entry: file_entry::Model,
) -> Result<TreeEntry, FilesystemError> {
    match FileEntryKind::try_from(entry.kind.as_str())? {
        FileEntryKind::Directory if entry.parent_id.is_none() => {
            Err(FilesystemError::Invariant("tree_root_entry"))
        }
        FileEntryKind::Directory => {
            map_directory_model(entry).map(TreeEntry::Directory)
        }
        FileEntryKind::File => map_file_model(entry).map(TreeEntry::File),
    }
}

pub(super) fn map_directory_scope(
    entry: file_entry::Model,
) -> Result<DirectoryScope, FilesystemError> {
    match FileEntryKind::try_from(entry.kind.as_str())? {
        FileEntryKind::File => Err(FilesystemError::Invariant(
            "directory_scope_non_directory_entry",
        )),
        FileEntryKind::Directory if entry.parent_id.is_none() => {
            map_root_model(entry).map(DirectoryScope::Root)
        }
        FileEntryKind::Directory => {
            map_directory_model(entry).map(DirectoryScope::Directory)
        }
    }
}

fn ensure_directory_kind(
    entry: &file_entry::Model,
    invariant: &'static str,
) -> Result<(), FilesystemError> {
    if FileEntryKind::try_from(entry.kind.as_str())? == FileEntryKind::Directory
    {
        Ok(())
    } else {
        Err(FilesystemError::Invariant(invariant))
    }
}

fn required_path_syntax(
    entry: &file_entry::Model,
    missing_invariant: &'static str,
) -> Result<PathSyntax, FilesystemError> {
    entry
        .path_syntax
        .as_deref()
        .ok_or(FilesystemError::Invariant(missing_invariant))
        .and_then(PathSyntax::try_from)
}

fn ensure_directory_metadata_absent(
    entry: &file_entry::Model,
    invariant: &'static str,
) -> Result<(), FilesystemError> {
    if entry.mime_type.is_none()
        && entry.extension.is_none()
        && entry.file_metadata_created_at.is_none()
        && entry.file_metadata_modified_at.is_none()
    {
        Ok(())
    } else {
        Err(FilesystemError::Invariant(invariant))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn timestamp() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_milli_opt(10, 30, 45, 123)
            .unwrap()
    }

    fn root_model() -> file_entry::Model {
        let timestamp = timestamp();
        file_entry::Model {
            id: Uuid::from_u128(1),
            device_id: Uuid::from_u128(2),
            parent_id: None,
            kind: "directory".to_string(),
            name: "/".to_string(),
            name_key: b"/".to_vec(),
            path_syntax: Some("posix".to_string()),
            absolute_path: None,
            hierarchy_path: "n00000000000000000000000000000001".to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp,
            updated_at: timestamp,
        }
    }

    fn directory_model() -> file_entry::Model {
        let mut entry = root_model();
        entry.id = Uuid::from_u128(3);
        entry.parent_id = Some(Uuid::from_u128(1));
        entry.name = "reports".to_string();
        entry.name_key = b"reports".to_vec();
        entry.path_syntax = None;
        entry.hierarchy_path = "n00000000000000000000000000000001.n00000000000000000000000000000003".to_string();
        entry
    }

    fn file_model() -> file_entry::Model {
        let mut entry = directory_model();
        entry.id = Uuid::from_u128(4);
        entry.kind = "file".to_string();
        entry.name = "report.pdf".to_string();
        entry.name_key = b"report.pdf".to_vec();
        entry.path_syntax = Some("posix".to_string());
        entry.absolute_path = Some("/reports/report.pdf".to_string());
        entry.hierarchy_path = "n00000000000000000000000000000001.n00000000000000000000000000000003.n00000000000000000000000000000004".to_string();
        entry.mime_type = Some("application/pdf".to_string());
        entry.extension = Some("pdf".to_string());
        entry.file_metadata_created_at = Some(timestamp());
        entry.file_metadata_modified_at = Some(timestamp());
        entry
    }

    fn assert_invariant<T>(
        result: Result<T, FilesystemError>,
        expected_code: &'static str,
    ) {
        assert!(matches!(
            result,
            Err(FilesystemError::Invariant(code)) if code == expected_code
        ));
    }

    #[test]
    fn mappers_preserve_all_valid_row_shapes() {
        let root = map_root_model(root_model()).unwrap();
        assert_eq!(root.entry_id, Uuid::from_u128(1));
        assert_eq!(root.path_syntax, PathSyntax::Posix);

        let directory = map_directory_model(directory_model()).unwrap();
        assert_eq!(directory.entry_id, Uuid::from_u128(3));
        assert_eq!(directory.parent_entry_id, Uuid::from_u128(1));

        let file = map_file_model(file_model()).unwrap();
        assert_eq!(file.file_id, Uuid::from_u128(4));
        assert_eq!(file.absolute_path, "/reports/report.pdf");

        assert!(matches!(
            map_tree_model(directory_model()),
            Ok(TreeEntry::Directory(_))
        ));
        assert!(matches!(
            map_tree_model(file_model()),
            Ok(TreeEntry::File(_))
        ));
        assert!(matches!(
            map_directory_scope(root_model()),
            Ok(DirectoryScope::Root(_))
        ));
        assert!(matches!(
            map_directory_scope(directory_model()),
            Ok(DirectoryScope::Directory(_))
        ));
    }

    #[test]
    fn mappers_reject_invalid_shapes_with_stable_invariants() {
        let mut root_with_parent = root_model();
        root_with_parent.parent_id = Some(Uuid::from_u128(9));
        assert_invariant(
            map_root_model(root_with_parent),
            "root_parent_present",
        );

        let mut root_without_syntax = root_model();
        root_without_syntax.path_syntax = None;
        assert_invariant(
            map_root_model(root_without_syntax),
            "root_path_syntax_missing",
        );

        let mut root_with_path = root_model();
        root_with_path.absolute_path = Some("/".to_string());
        assert_invariant(
            map_root_model(root_with_path),
            "root_absolute_path_present",
        );

        let mut root_with_metadata = root_model();
        root_with_metadata.mime_type = Some("text/plain".to_string());
        assert_invariant(
            map_root_model(root_with_metadata),
            "root_file_metadata_present",
        );

        let mut directory_without_parent = directory_model();
        directory_without_parent.parent_id = None;
        assert_invariant(
            map_directory_model(directory_without_parent),
            "directory_parent_missing",
        );

        let mut directory_with_syntax = directory_model();
        directory_with_syntax.path_syntax = Some("posix".to_string());
        assert_invariant(
            map_directory_model(directory_with_syntax),
            "directory_path_syntax_present",
        );

        let mut directory_with_path = directory_model();
        directory_with_path.absolute_path = Some("/reports".to_string());
        assert_invariant(
            map_directory_model(directory_with_path),
            "directory_absolute_path_present",
        );

        let mut directory_with_metadata = directory_model();
        directory_with_metadata.extension = Some("tmp".to_string());
        assert_invariant(
            map_directory_model(directory_with_metadata),
            "directory_file_metadata_present",
        );

        assert_invariant(
            map_file_model(directory_model()),
            "file_entry_non_file",
        );
        assert_invariant(map_tree_model(root_model()), "tree_root_entry");
        assert_invariant(
            map_directory_scope(file_model()),
            "directory_scope_non_directory_entry",
        );
    }
}
