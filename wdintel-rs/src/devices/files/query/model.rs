use crate::devices::files::{
    DirectoryEntry, DirectoryScope, DomainFileEntryKind, DomainPathSyntax,
    FileEntry, FileJournalEntry, FilesystemError, RootEntry, TreeEntry,
};
use crate::file_registry::entities::file_entry;

pub(in crate::devices::files) fn map_root_model(
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

pub(in crate::devices::files) fn map_directory_model(
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

pub(in crate::devices::files) fn map_file_model(
    entry: file_entry::Model,
) -> Result<FileEntry, FilesystemError> {
    if DomainFileEntryKind::try_from(entry.kind.as_str())?
        != DomainFileEntryKind::File
    {
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
        has_content: entry.content_path.is_some(),
        mime_type: entry.mime_type,
        extension: entry.extension,
        file_metadata_created_at: entry.file_metadata_created_at,
        file_metadata_modified_at: entry.file_metadata_modified_at,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    })
}

pub(in crate::devices::files) fn map_file_journal_model(
    entry: file_entry::Model,
) -> Result<FileJournalEntry, FilesystemError> {
    let file = map_file_model(entry)?;
    Ok(FileJournalEntry {
        file_id: file.file_id,
        name: file.name,
        absolute_path: file.absolute_path,
        has_content: file.has_content,
        synchronized_at: file.updated_at,
    })
}

pub(in crate::devices::files) fn map_tree_model(
    entry: file_entry::Model,
) -> Result<TreeEntry, FilesystemError> {
    match DomainFileEntryKind::try_from(entry.kind.as_str())? {
        DomainFileEntryKind::Directory if entry.parent_id.is_none() => {
            Err(FilesystemError::Invariant("tree_root_entry"))
        }
        DomainFileEntryKind::Directory => {
            map_directory_model(entry).map(TreeEntry::Directory)
        }
        DomainFileEntryKind::File => map_file_model(entry).map(TreeEntry::File),
    }
}

pub(in crate::devices::files) fn map_directory_scope(
    entry: file_entry::Model,
    root_context: Option<(uuid::Uuid, DomainPathSyntax)>,
) -> Result<DirectoryScope, FilesystemError> {
    match DomainFileEntryKind::try_from(entry.kind.as_str())? {
        DomainFileEntryKind::File => Err(FilesystemError::Invariant(
            "directory_scope_non_directory_entry",
        )),
        DomainFileEntryKind::Directory if entry.parent_id.is_none() => {
            map_root_model(entry).map(DirectoryScope::Root)
        }
        DomainFileEntryKind::Directory => {
            let (root_id, path_syntax) =
                root_context.ok_or(FilesystemError::Invariant(
                    "directory_scope_root_context_missing",
                ))?;
            map_directory_model(entry).map(|entry| DirectoryScope::Directory {
                entry,
                root_id,
                path_syntax,
            })
        }
    }
}

fn ensure_directory_kind(
    entry: &file_entry::Model,
    invariant: &'static str,
) -> Result<(), FilesystemError> {
    if DomainFileEntryKind::try_from(entry.kind.as_str())?
        == DomainFileEntryKind::Directory
    {
        Ok(())
    } else {
        Err(FilesystemError::Invariant(invariant))
    }
}

fn required_path_syntax(
    entry: &file_entry::Model,
    missing_invariant: &'static str,
) -> Result<DomainPathSyntax, FilesystemError> {
    entry
        .path_syntax
        .as_deref()
        .ok_or(FilesystemError::Invariant(missing_invariant))
        .and_then(DomainPathSyntax::try_from)
}

fn ensure_directory_metadata_absent(
    entry: &file_entry::Model,
    invariant: &'static str,
) -> Result<(), FilesystemError> {
    if entry.mime_type.is_none()
        && entry.extension.is_none()
        && entry.file_metadata_created_at.is_none()
        && entry.file_metadata_modified_at.is_none()
        && entry.content_path.is_none()
    {
        Ok(())
    } else {
        Err(FilesystemError::Invariant(invariant))
    }
}
