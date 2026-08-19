use super::cursor;
use super::error::{FilesystemError, FilesystemFieldError};
use super::query;
use super::types::{
    BrowseFilesCommand, BrowseFilesResult, EntryQueryScope, EntrySortKey,
    FileSearchFilters, JournalFilesCommand, JournalFilesResult,
    KeysetPageRequest, RootEntry, SearchEntry, SearchFilesCommand,
    SearchFilesResult, SubtreeFileCount, SubtreeFileCountsCommand, TreeEntry,
};
use super::validation::validate_subtree_count_directories;
use crate::devices::analytics::types::TagFilter;
use crate::devices::analytics::{
    hydrate_active_tags, load_active_tag_memberships, matches_tag_filter,
    normalize_tag_filter,
};
use crate::devices::devices::query::{
    self as device_query, FileRegistryDeviceAccess,
};
use crate::entities::login;
use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::types::ShortContext;
use sea_orm::DatabaseConnection;
use uuid::Uuid;

pub(in crate::devices) async fn list_roots(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<Vec<RootEntry>, AppError> {
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;

    query::list_roots(file_registry_db, device_id)
        .await
        .map_err(map_read_error)
}
pub(in crate::devices) async fn count_subtrees(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: SubtreeFileCountsCommand,
) -> Result<Vec<SubtreeFileCount>, AppError> {
    let SubtreeFileCountsCommand {
        device_id,
        parent_entry_id,
        directory_entry_ids,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    validate_subtree_count_directories(&directory_entry_ids)
        .map_err(map_read_error)
        .c(h!())?;

    query::count_file_subtrees(
        file_registry_db,
        device_id,
        parent_entry_id,
        &directory_entry_ids,
    )
    .await
    .map_err(map_read_error)
}

pub(in crate::devices) async fn journal(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: JournalFilesCommand,
) -> Result<JournalFilesResult, AppError> {
    let JournalFilesCommand {
        device_id,
        limit,
        cursor,
        tag_ids,
        tag_match,
        untagged,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let tag_filter = normalize_tag_filter(
        file_registry_db.connection(),
        tag_ids,
        tag_match,
        untagged,
    )
    .await
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_file_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            Some(
                query::resolve_file_journal_cursor(
                    file_registry_db,
                    device_id,
                    boundary_file_id,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let requested_page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let (page, total_count) = query::list_file_journal_with_total(
        file_registry_db,
        device_id,
        requested_page,
        tag_filter.as_ref(),
    )
    .await
    .map_err(map_read_error)
    .c(h!())?;
    let next_cursor =
        page.next.map(|sort_key| cursor::encode(sort_key.file_id()));
    let entries = page.entries;
    let file_entry_ids = entries
        .iter()
        .map(|entry| entry.file_id)
        .collect::<Vec<_>>();
    let tags_by_file =
        hydrate_active_tags(file_registry_db.connection(), &file_entry_ids)
            .await
            .c(h!())?;

    Ok(JournalFilesResult {
        total_count,
        entries,
        next_cursor,
        tags_by_file,
    })
}

pub(in crate::devices) async fn browse(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: BrowseFilesCommand,
) -> Result<BrowseFilesResult, AppError> {
    let BrowseFilesCommand {
        device_id,
        parent_entry_id,
        include_breadcrumbs,
        limit,
        cursor,
        tag_ids,
        tag_match,
        untagged,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let tag_filter = normalize_tag_filter(
        file_registry_db.connection(),
        tag_ids,
        tag_match,
        untagged,
    )
    .await
    .c(h!())?;
    let scope = query::find_directory_scope(
        file_registry_db,
        device_id,
        parent_entry_id,
    )
    .await
    .map_err(map_read_error)
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_entry_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            let query_scope = EntryQueryScope::Browse(&scope);
            Some(
                query::resolve_cursor_entry_sort_key(
                    file_registry_db,
                    boundary_entry_id,
                    &query_scope,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let requested_page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let (entries, next_cursor) = if let Some(tag_filter) = &tag_filter {
        filtered_browse_page(
            file_registry_db,
            &scope,
            requested_page,
            tag_filter,
        )
        .await?
    } else {
        let page =
            query::list_children(file_registry_db, &scope, requested_page)
                .await
                .map_err(map_read_error)
                .c(h!())?;
        (
            page.entries,
            page.next
                .map(|sort_key| cursor::encode(sort_key.entry_id())),
        )
    };
    let entry_path_components =
        query::load_path_components(file_registry_db, &entries)
            .await
            .map_err(map_read_error)
            .c(h!())?;
    let breadcrumbs = if include_breadcrumbs {
        query::list_breadcrumbs(file_registry_db, &scope)
            .await
            .map_err(map_read_error)
            .c(h!())?
    } else {
        Vec::new()
    };
    let file_entry_ids = entries.iter().map(tree_entry_id).collect::<Vec<_>>();
    let tags_by_file =
        hydrate_active_tags(file_registry_db.connection(), &file_entry_ids)
            .await
            .c(h!())?;

    Ok(BrowseFilesResult {
        breadcrumbs,
        entries,
        entry_path_components,
        next_cursor,
        tags_by_file,
    })
}

pub(in crate::devices) async fn search(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: SearchFilesCommand,
) -> Result<SearchFilesResult, AppError> {
    let SearchFilesCommand {
        device_id,
        scope_entry_id,
        filters,
        limit,
        cursor,
        tag_ids,
        tag_match,
        untagged,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let tag_filter = normalize_tag_filter(
        file_registry_db.connection(),
        tag_ids,
        tag_match,
        untagged,
    )
    .await
    .c(h!())?;
    let filters = FileSearchFilters::try_from(filters)
        .map_err(map_read_error)
        .c(h!())?;
    let scope = query::find_directory_scope(
        file_registry_db,
        device_id,
        scope_entry_id,
    )
    .await
    .map_err(map_read_error)
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_entry_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            let query_scope = EntryQueryScope::Search {
                directory: &scope,
                filters: &filters,
            };
            Some(
                query::resolve_cursor_entry_sort_key(
                    file_registry_db,
                    boundary_entry_id,
                    &query_scope,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let requested_page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let (entries, next_cursor) = if let Some(tag_filter) = &tag_filter {
        filtered_search_page(
            file_registry_db,
            &scope,
            &filters,
            requested_page,
            tag_filter,
        )
        .await?
    } else {
        let page = query::search_entries(
            file_registry_db,
            &scope,
            &filters,
            requested_page,
        )
        .await
        .map_err(map_read_error)
        .c(h!())?;
        (
            page.entries,
            page.next
                .map(|sort_key| cursor::encode(sort_key.entry_id())),
        )
    };
    let file_entry_ids =
        entries.iter().map(search_entry_id).collect::<Vec<_>>();
    let tags_by_file =
        hydrate_active_tags(file_registry_db.connection(), &file_entry_ids)
            .await
            .c(h!())?;

    Ok(SearchFilesResult {
        entries,
        next_cursor,
        tags_by_file,
    })
}
async fn filtered_browse_page(
    file_registry_db: &FileRegistryDb,
    scope: &super::types::DirectoryScope,
    requested_page: KeysetPageRequest<EntrySortKey>,
    tag_filter: &TagFilter,
) -> Result<(Vec<TreeEntry>, Option<String>), AppError> {
    let target_len = usize::try_from(requested_page.limit())
        .expect("validated file page limit must fit usize");
    let mut after = requested_page.after().cloned();
    let mut entries = Vec::with_capacity(target_len);
    loop {
        let page = query::list_children(
            file_registry_db,
            scope,
            KeysetPageRequest::try_new(
                Some(crate::config::DEVICE_FILE_PAGE_MAX_LIMIT),
                after,
            )
            .expect("configured file page limit must be valid"),
        )
        .await
        .map_err(map_read_error)
        .c(h!())?;
        let page_len = page.entries.len();
        let has_later_page = page.next.is_some();
        let entry_ids =
            page.entries.iter().map(tree_entry_id).collect::<Vec<_>>();
        let matching_entry_ids = query::find_matching_tree_entry_ids(
            file_registry_db,
            scope.device_id(),
            &entry_ids,
            tag_filter,
        )
        .await
        .map_err(map_read_error)
        .c(h!())?;
        for (index, entry) in page.entries.into_iter().enumerate() {
            let entry_id = tree_entry_id(&entry);
            if matching_entry_ids.contains(&entry_id) {
                entries.push(entry);
                if entries.len() == target_len {
                    let has_later_candidate =
                        index + 1 < page_len || has_later_page;
                    return Ok((
                        entries,
                        has_later_candidate.then(|| cursor::encode(entry_id)),
                    ));
                }
            }
        }
        let Some(next) = page.next else {
            return Ok((entries, None));
        };
        after = Some(next);
    }
}

async fn filtered_search_page(
    file_registry_db: &FileRegistryDb,
    scope: &super::types::DirectoryScope,
    filters: &FileSearchFilters,
    requested_page: KeysetPageRequest<EntrySortKey>,
    tag_filter: &TagFilter,
) -> Result<(Vec<SearchEntry>, Option<String>), AppError> {
    let target_len = usize::try_from(requested_page.limit())
        .expect("validated file page limit must fit usize");
    let mut after = requested_page.after().cloned();
    let mut entries = Vec::with_capacity(target_len);
    loop {
        let page = query::search_entries(
            file_registry_db,
            scope,
            filters,
            KeysetPageRequest::try_new(
                Some(crate::config::DEVICE_FILE_PAGE_MAX_LIMIT),
                after,
            )
            .expect("configured file page limit must be valid"),
        )
        .await
        .map_err(map_read_error)
        .c(h!())?;
        let page_len = page.entries.len();
        let has_later_page = page.next.is_some();
        let entry_ids =
            page.entries.iter().map(search_entry_id).collect::<Vec<_>>();
        let memberships = load_active_tag_memberships(
            file_registry_db.connection(),
            &entry_ids,
        )
        .await
        .c(h!())?;
        for (index, entry) in page.entries.into_iter().enumerate() {
            let entry_id = search_entry_id(&entry);
            if matches_tag_filter(memberships.get(&entry_id), tag_filter) {
                entries.push(entry);
                if entries.len() == target_len {
                    let has_later_candidate =
                        index + 1 < page_len || has_later_page;
                    return Ok((
                        entries,
                        has_later_candidate.then(|| cursor::encode(entry_id)),
                    ));
                }
            }
        }
        let Some(next) = page.next else {
            return Ok((entries, None));
        };
        after = Some(next);
    }
}

fn tree_entry_id(entry: &TreeEntry) -> Uuid {
    match entry {
        TreeEntry::Directory(directory) => directory.entry_id,
        TreeEntry::File(file) => file.file_id,
    }
}

fn search_entry_id(entry: &SearchEntry) -> Uuid {
    tree_entry_id(&entry.entry)
}

fn validation_form(errors: Vec<FilesystemFieldError>) -> AppError {
    AppError::Form(
        errors
            .into_iter()
            .map(|error| (error.path, error.message))
            .collect(),
    )
}

fn map_read_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => validation_form(errors),
        FilesystemError::NotFound => AppError::NotFound,
        FilesystemError::Invariant(_) => AppError::BL {
            msg: "device filesystem invariant violated".to_string(),
        },
        error @ (FilesystemError::Conflict
        | FilesystemError::Dependency(_)
        | FilesystemError::Internal(_)
        | FilesystemError::CommitUncertain(_)) => AppError::AnyhowError {
            source: anyhow::Error::new(error)
                .context("failed to read device filesystem"),
        },
    }
}

mod mapping {
    use super::super::types::FileEntryKind as FileEntryKindDto;
    use super::super::types::{
        BrowseDeviceFilesRsp, CountDeviceFileSubtreesRsp, DeviceFile,
        DeviceFileJournalEntry, DeviceFileRoot, DeviceFileSubtreeCount,
        DeviceFileTreeEntry, FileBreadcrumb, JournalDeviceFilesRsp,
        ListDeviceFileRootsRsp, SearchDeviceFilesRsp, SourceFileState,
        SourceFileStateKind,
    };
    use super::super::{
        Breadcrumb, BrowseFilesResult, DomainSourceFileStateKind, FileEntry,
        JournalFilesResult, NormalizedSourceFileState, RootEntry,
        SearchFilesResult, SubtreeFileCount, TreeEntry,
    };
    use crate::devices::analytics::AnalyticsTag;
    use crate::devices::types::format_datetime;
    use crate::error::AppError;
    use std::collections::BTreeMap;

    pub(in crate::devices) fn map_roots(
        roots: Vec<RootEntry>,
    ) -> ListDeviceFileRootsRsp {
        ListDeviceFileRootsRsp {
            roots: roots.into_iter().map(map_root).collect(),
        }
    }

    pub(in crate::devices) fn map_subtree_counts(
        counts: Vec<SubtreeFileCount>,
    ) -> CountDeviceFileSubtreesRsp {
        CountDeviceFileSubtreesRsp {
            counts: counts
                .into_iter()
                .map(|count| DeviceFileSubtreeCount {
                    entry_id: count.entry_id.hyphenated().to_string(),
                    file_count: count.file_count,
                })
                .collect(),
        }
    }

    pub(in crate::devices) fn map_browse(
        result: BrowseFilesResult,
    ) -> Result<BrowseDeviceFilesRsp, AppError> {
        let BrowseFilesResult {
            breadcrumbs,
            entries,
            entry_path_components,
            next_cursor,
            mut tags_by_file,
        } = result;
        if entries.len() != entry_path_components.len() {
            return Err(AppError::AnyhowError {
                source: anyhow::anyhow!(
                    "browse result context does not match entries"
                ),
            });
        }
        Ok(BrowseDeviceFilesRsp {
            breadcrumbs: breadcrumbs.into_iter().map(map_breadcrumb).collect(),
            entries: entries
                .into_iter()
                .zip(entry_path_components)
                .map(|(entry, path_components)| {
                    let tags = take_tags(
                        &mut tags_by_file,
                        super::tree_entry_id(&entry),
                    );
                    map_tree_entry(entry, path_components, tags)
                })
                .collect(),
            next_cursor,
        })
    }

    pub(in crate::devices) fn map_search(
        result: SearchFilesResult,
    ) -> SearchDeviceFilesRsp {
        let SearchFilesResult {
            entries,
            next_cursor,
            mut tags_by_file,
        } = result;
        SearchDeviceFilesRsp {
            entries: entries
                .into_iter()
                .map(|entry| {
                    let tags = take_tags(
                        &mut tags_by_file,
                        super::search_entry_id(&entry),
                    );
                    map_tree_entry(entry.entry, entry.path_components, tags)
                })
                .collect(),
            next_cursor,
        }
    }

    pub(in crate::devices) fn map_journal(
        result: JournalFilesResult,
    ) -> JournalDeviceFilesRsp {
        let JournalFilesResult {
            entries,
            next_cursor,
            total_count,
            mut tags_by_file,
        } = result;
        JournalDeviceFilesRsp {
            entries: entries
                .into_iter()
                .map(|entry| {
                    let tags = take_tags(&mut tags_by_file, entry.file_id);
                    DeviceFileJournalEntry {
                        file_id: entry.file_id.hyphenated().to_string(),
                        name: entry.name,
                        absolute_path: entry.absolute_path,
                        has_content: entry.has_content,
                        synchronized_at: format_datetime(entry.synchronized_at),
                        tags,
                        revision: entry.revision,
                        sync_id: entry.sync_id.hyphenated().to_string(),
                        source_file_state: entry
                            .source_file_state
                            .map(map_source_file_state),
                    }
                })
                .collect(),
            total_count,
            next_cursor,
        }
    }

    pub(in crate::devices::files) fn map_root(
        root: RootEntry,
    ) -> DeviceFileRoot {
        DeviceFileRoot {
            entry_id: root.entry_id.hyphenated().to_string(),
            device_id: root.device_id.hyphenated().to_string(),
            parent_entry_id: None,
            kind: FileEntryKindDto::Directory,
            name: root.name,
            created_at: format_datetime(root.created_at),
            updated_at: format_datetime(root.updated_at),
            tags: Vec::new(),
        }
    }

    fn map_breadcrumb(breadcrumb: Breadcrumb) -> FileBreadcrumb {
        FileBreadcrumb {
            entry_id: breadcrumb.entry_id.hyphenated().to_string(),
            name: breadcrumb.name,
        }
    }

    fn map_tree_entry(
        entry: TreeEntry,
        path_components: Vec<String>,
        tags: Vec<AnalyticsTag>,
    ) -> DeviceFileTreeEntry {
        match entry {
            TreeEntry::Directory(directory) => DeviceFileTreeEntry {
                entry_id: directory.entry_id.hyphenated().to_string(),
                parent_entry_id: directory
                    .parent_entry_id
                    .hyphenated()
                    .to_string(),
                kind: FileEntryKindDto::Directory,
                file_id: None,
                name: directory.name,
                path_components,
                absolute_path: None,
                has_content: false,
                mime_type: None,
                extension: None,
                file_metadata_created_at: None,
                file_metadata_modified_at: None,
                created_at: format_datetime(directory.created_at),
                updated_at: format_datetime(directory.updated_at),
                tags: Vec::new(),
                revision: None,
                sync_id: None,
                source_file_state: None,
            },
            TreeEntry::File(file) => DeviceFileTreeEntry {
                entry_id: file.file_id.hyphenated().to_string(),
                parent_entry_id: file.parent_entry_id.hyphenated().to_string(),
                kind: FileEntryKindDto::File,
                file_id: Some(file.file_id.hyphenated().to_string()),
                name: file.name,
                path_components,
                absolute_path: Some(file.absolute_path),
                has_content: file.has_content,
                mime_type: file.mime_type,
                extension: file.extension,
                file_metadata_created_at: file
                    .file_metadata_created_at
                    .map(format_datetime),
                file_metadata_modified_at: file
                    .file_metadata_modified_at
                    .map(format_datetime),
                created_at: format_datetime(file.created_at),
                updated_at: format_datetime(file.updated_at),
                revision: Some(file.revision),
                sync_id: Some(file.sync_id.hyphenated().to_string()),
                source_file_state: file
                    .source_file_state
                    .map(map_source_file_state),
                tags,
            },
        }
    }

    pub(in crate::devices::files) fn map_file(
        file: FileEntry,
        root_entry_id: uuid::Uuid,
        path_components: Vec<String>,
        tags: Vec<AnalyticsTag>,
    ) -> DeviceFile {
        DeviceFile {
            file_id: file.file_id.hyphenated().to_string(),
            device_id: file.device_id.hyphenated().to_string(),
            parent_entry_id: file.parent_entry_id.hyphenated().to_string(),
            root_entry_id: root_entry_id.hyphenated().to_string(),
            absolute_path: file.absolute_path,
            has_content: file.has_content,
            name: file.name,
            path_components,
            mime_type: file.mime_type,
            extension: file.extension,
            file_metadata_created_at: file
                .file_metadata_created_at
                .map(format_datetime),
            file_metadata_modified_at: file
                .file_metadata_modified_at
                .map(format_datetime),
            created_at: format_datetime(file.created_at),
            updated_at: format_datetime(file.updated_at),
            revision: file.revision,
            sync_id: file.sync_id.hyphenated().to_string(),
            source_file_state: file
                .source_file_state
                .map(map_source_file_state),
            tags,
        }
    }
    fn take_tags(
        tags_by_file: &mut BTreeMap<uuid::Uuid, Vec<AnalyticsTag>>,
        file_entry_id: uuid::Uuid,
    ) -> Vec<AnalyticsTag> {
        tags_by_file.remove(&file_entry_id).unwrap_or_default()
    }

    fn map_source_file_state(
        source_file_state: NormalizedSourceFileState,
    ) -> SourceFileState {
        SourceFileState {
            state: match source_file_state.state {
                DomainSourceFileStateKind::Scanned => {
                    SourceFileStateKind::Scanned
                }
                DomainSourceFileStateKind::Downloaded => {
                    SourceFileStateKind::Downloaded
                }
                DomainSourceFileStateKind::Changed => {
                    SourceFileStateKind::Changed
                }
            },
            settled_at: source_file_state
                .settled_at
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
            settled_by: source_file_state.settled_by,
        }
    }
}

pub(in crate::devices::files) use mapping::map_file;
pub(in crate::devices) use mapping::{
    map_browse, map_journal, map_roots, map_search, map_subtree_counts,
};
