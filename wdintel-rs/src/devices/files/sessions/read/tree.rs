use super::*;

struct TreePage {
    entries: Vec<TreeEntry>,
    paths: Vec<Vec<String>>,
    next_cursor: Option<String>,
    tags: BTreeMap<Uuid, Vec<AnalyticsTag>>,
}

async fn load_page(
    files: &FileRegistryDb,
    mut query: SessionQuery,
    mut predicate: String,
    limit: u64,
    value: Option<&str>,
    scope: &str,
) -> Result<TreePage, AppError> {
    if let Some(value) = value {
        let (kind, name, id): (String, String, Uuid) =
            cursor::decode(value, scope).c(h!())?;
        if kind != "directory" && kind != "file" {
            return Err(cursor::invalid("cursor"));
        }
        let kind = query.bind(kind);
        let name = query.bind(name);
        let id = query.bind(id);
        predicate.push_str(&format!(" and (entry.kind::text, convert_to(entry.name, 'UTF8'), entry.id) > ({kind}, convert_to({name}, 'UTF8'), {id})"));
    }
    let cap = query.bind((limit + 1) as i64);
    let mut rows = query.all(files.connection(), &format!(
        "select entry.* from session_entries entry where {predicate} order by entry.kind::text, convert_to(entry.name, 'UTF8'), entry.id limit {cap}"
    )).await.c(h!())?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let tags = tags_from_rows(&rows).c(h!())?;
    let next_cursor = if more {
        rows.last()
            .map(|row| {
                let entry =
                    file_entry::Model::from_query_result(row, "").c(h!())?;
                let kind = match entry.kind {
                    DomainFileEntryKind::Directory => "directory",
                    DomainFileEntryKind::File => "file",
                };
                cursor::encode(scope, (kind, entry.name, entry.id))
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    let entries = rows
        .iter()
        .map(|row| {
            let entry =
                file_entry::Model::from_query_result(row, "").c(h!())?;
            query::model::map_tree_model(entry)
                .map_err(bl::map_read_error)
                .c(h!())
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    let paths = query::load_path_components(files, &entries)
        .await
        .map_err(bl::map_read_error)
        .c(h!())?;
    Ok(TreePage {
        entries,
        paths,
        next_cursor,
        tags,
    })
}

pub(in crate::devices) async fn browse(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: BrowseDeviceFilesReq,
) -> Result<BrowseDeviceFilesRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let scope_key = scope_key("browse", &body).c(h!())?;
    let limit = page_limit(body.limit).c(h!())?;
    let filter = normalize_tag_filter(
        files.connection(),
        body.tag_ids.unwrap_or_default(),
        body.tag_match,
        body.untagged.unwrap_or(false),
    )
    .await
    .c(h!())?;
    let parent_id = parse_uuid(&body.parent_entry_id);
    let scope = query::find_directory_scope(files, device_id, parent_id)
        .await
        .map_err(bl::map_read_error)
        .c(h!())?;
    let mut query = SessionQuery::new(device_id, vec![sync_id]);
    let parent = query.bind(parent_id);
    let mut predicate = format!("entry.parent_id = {parent}");
    if filter.is_some() {
        let tags = query.tag_filter("descendant", filter.as_ref());
        predicate.push_str(&format!(" and exists (select 1 from session_files descendant where descendant.hierarchy_path::ltree <@ entry.hierarchy_path::ltree and {tags})"));
    }
    let page = load_page(
        files,
        query,
        predicate,
        limit,
        body.cursor.as_deref(),
        &scope_key,
    )
    .await
    .c(h!())?;
    let breadcrumbs = if body.include_breadcrumbs.unwrap_or(true) {
        query::list_breadcrumbs(files, &scope)
            .await
            .map_err(bl::map_read_error)
            .c(h!())?
    } else {
        Vec::new()
    };
    bl::map_browse(BrowseFilesResult {
        breadcrumbs,
        entries: page.entries,
        entry_path_components: page.paths,
        next_cursor: page.next_cursor,
        tags_by_file: page.tags,
    })
}

pub(in crate::devices) async fn search(
    main: &DatabaseConnection,
    files: &FileRegistryDb,
    login: &login::Model,
    body: SearchDeviceFilesReq,
) -> Result<SearchDeviceFilesRsp, AppError> {
    let (device_id, sync_id) = authorize_request(
        main,
        files,
        login,
        &body.device_id,
        body.sync_id.as_deref(),
    )
    .await
    .c(h!())?;
    let scope_key = scope_key("search", &body).c(h!())?;
    let limit = page_limit(body.limit).c(h!())?;
    let filter = normalize_tag_filter(
        files.connection(),
        body.tag_ids.clone().unwrap_or_default(),
        body.tag_match,
        body.untagged.unwrap_or(false),
    )
    .await
    .c(h!())?;
    let scope = query::find_directory_scope(
        files,
        device_id,
        parse_uuid(&body.scope_entry_id),
    )
    .await
    .map_err(bl::map_read_error)
    .c(h!())?;
    let filters = search_filters(&body).c(h!())?;
    let mut query = SessionQuery::new(device_id, vec![sync_id]);
    let path = query.bind(scope.hierarchy_path().to_owned());
    let id = query.bind(scope.entry_id());
    let mut predicate = format!("entry.parent_id is not null and entry.hierarchy_path::ltree <@ {path}::ltree and entry.id <> {id}");
    append_filters(&mut query, &mut predicate, &filters);
    let tags = query.tag_filter("entry", filter.as_ref());
    predicate.push_str(&format!(" and {tags}"));
    let page = load_page(
        files,
        query,
        predicate,
        limit,
        body.cursor.as_deref(),
        &scope_key,
    )
    .await
    .c(h!())?;
    Ok(bl::map_search(SearchFilesResult {
        entries: page
            .entries
            .into_iter()
            .zip(page.paths)
            .map(|(entry, path_components)| SearchEntry {
                entry,
                path_components,
            })
            .collect(),
        next_cursor: page.next_cursor,
        tags_by_file: page.tags,
    }))
}

fn search_filters(
    body: &SearchDeviceFilesReq,
) -> Result<FileSearchFilters, AppError> {
    FileSearchFilters::try_from(RawFileSearchFilters {
        kinds: body
            .kinds
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(crate::devices::files::map_entry_kind)
            .collect(),
        name_query: body.name_query.clone(),
        mime_types: body.mime_types.clone().unwrap_or_default(),
        extensions: body.extensions.clone().unwrap_or_default(),
        file_metadata_modified_from: body
            .file_metadata_modified_from
            .as_deref()
            .map(crate::devices::types::parse_datetime),
        file_metadata_modified_to: body
            .file_metadata_modified_to
            .as_deref()
            .map(crate::devices::types::parse_datetime),
    })
    .map_err(bl::map_read_error)
}

fn append_filters(
    query: &mut SessionQuery,
    predicate: &mut String,
    filters: &FileSearchFilters,
) {
    if !filters.kinds().is_empty() {
        let kinds = filters
            .kinds()
            .iter()
            .map(|kind| match kind {
                DomainFileEntryKind::Directory => "directory".to_owned(),
                DomainFileEntryKind::File => "file".to_owned(),
            })
            .collect::<Vec<_>>();
        let value = query.bind(kinds);
        predicate
            .push_str(&format!(" and entry.kind::text = any({value}::text[])"));
    }
    if let Some(name) = filters.name_query() {
        let value = query.bind(query::core::literal_name_pattern(name));
        predicate.push_str(&format!(" and entry.name ilike {value}"));
    }
    if filters.requires_file_metadata() {
        predicate.push_str(" and entry.kind = 'file'");
    }
    for (column, values) in [
        ("mime_type", filters.mime_types()),
        ("extension", filters.extensions()),
    ] {
        if !values.is_empty() {
            let value = query.bind(values.to_vec());
            predicate.push_str(&format!(
                " and entry.{column} = any({value}::text[])"
            ));
        }
    }
    for (operator, time) in [
        (">=", filters.file_metadata_modified_from()),
        ("<=", filters.file_metadata_modified_to()),
    ] {
        if let Some(time) = time {
            let value = query.bind(time);
            predicate.push_str(&format!(
                " and entry.file_metadata_modified_at {operator} {value}"
            ));
        }
    }
}
