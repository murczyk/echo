use super::*;

struct TreePage {
    entries: Vec<TreeEntry>,
    paths: Vec<Vec<String>>,
    next_cursor: Option<String>,
    tags: BTreeMap<Uuid, Vec<AnalyticsTag>>,
    sizes: std::collections::HashMap<String, Option<i64>>,
}

enum TreePageOrder {
    Listing(crate::devices::files::sorting::FileListingSort),
    Relevance { term: String, path: String },
}

async fn load_page(
    files: &FileRegistryDb,
    mut query: SessionQuery,
    mut predicate: String,
    limit: u64,
    value: Option<&str>,
    scope: &str,
    sort: TreePageOrder,
) -> Result<TreePage, AppError> {
    let order = match &sort {
        TreePageOrder::Listing(sort) => sort.order_sql("entry"),
        TreePageOrder::Relevance { term, path } => {
            let term = query.bind(term.clone());
            let path = query.bind(path.clone());
            query::search_ranking::key_sql("entry", &term, &path)
        }
    };
    if let Some(value) = value {
        let (kind, name, id): (String, String, Uuid) =
            cursor::decode(value, scope).c(h!())?;
        if kind != "directory" && kind != "file" {
            return Err(cursor::invalid("cursor"));
        }
        let name = query.bind(name);
        let id = query.bind(id);
        let after = match &sort {
            TreePageOrder::Listing(sort) => {
                sort.after_sql("entry", "session_entries", &name, &id)
            }
            TreePageOrder::Relevance { .. } => {
                let boundary = order.replace("entry.", "boundary.");
                format!("row({order}) > (select {boundary} from session_entries boundary where boundary.id={id} and boundary.name={name} order by boundary.revision desc nulls last limit 1)")
            }
        };
        predicate.push_str(&format!(" and {after}"));
    }
    let cap = query.bind((limit + 1) as i64);
    let mut rows = query.all(files.connection(), &format!(
        "select entry.* from session_entries entry where {predicate} order by {order} limit {cap}"
    )).await.c(h!())?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let tags = tags_from_rows(&rows).c(h!())?;
    let sizes = rows
        .iter()
        .map(|row| {
            let id: Uuid = row.try_get("", "id").c(h!())?;
            Ok((id.to_string(), row.try_get("", "size_bytes").c(h!())?))
        })
        .collect::<anyhow::Result<_>>()
        .c(h!())?;
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
    let paths = query::ancestors::load_path_components_with_root(
        files.connection(),
        &entries,
        matches!(sort, TreePageOrder::Relevance { .. }),
    )
    .await
    .map_err(bl::map_read_error)
    .c(h!())?;
    Ok(TreePage {
        entries,
        paths,
        next_cursor,
        tags,
        sizes,
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
    let scope_key = browse_scope_key("browse", &body).c(h!())?;
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
    let mut query =
        SessionQuery::new(device_id, vec![sync_id]).include_archives();
    let parent = query.bind(parent_id);
    let mut predicate = format!("entry.parent_id = {parent}");
    if filter.is_some() || body.has_content.is_some() {
        let tags = query.tag_filter("descendant", filter.as_ref());
        let content = match body.has_content {
            Some(true) => "descendant.content_path is not null",
            Some(false) => "descendant.content_path is null",
            None => "true",
        };
        predicate.push_str(&format!(" and exists (select 1 from session_files descendant where descendant.hierarchy_path::ltree <@ entry.hierarchy_path::ltree and {tags} and {content})"));
    }
    let page = load_page(
        files,
        query,
        predicate,
        limit,
        body.cursor.as_deref(),
        &scope_key,
        TreePageOrder::Listing(
            crate::devices::files::sorting::FileListingSort::new(
                body.sort_by,
                body.sort_direction,
            ),
        ),
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
    let mut response = bl::map_browse(BrowseFilesResult {
        breadcrumbs,
        entries: page.entries,
        entry_path_components: page.paths,
        next_cursor: page.next_cursor,
        tags_by_file: page.tags,
    })
    .c(h!())?;
    query::sizes::apply(&mut response.entries, &page.sizes);
    Ok(response)
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
    let scope = query::find_search_scope(
        files,
        device_id,
        parse_uuid(&body.scope_entry_id),
    )
    .await
    .map_err(bl::map_read_error)
    .c(h!())?;
    let query = SessionQuery::new(device_id, vec![sync_id]).include_archives();
    let cursor_scope = scope_key("search", &body).c(h!())?;
    Ok(search_snapshot(
        files,
        body,
        query,
        scope.hierarchy_path(),
        &cursor_scope,
    )
    .await
    .c(h!())?)
}

pub(in crate::devices::files) async fn search_snapshot(
    files: &FileRegistryDb,
    body: SearchDeviceFilesReq,
    mut query: SessionQuery,
    scope_path: &str,
    cursor_scope: &str,
) -> Result<SearchDeviceFilesRsp, AppError> {
    let filters = search_filters(&body).c(h!())?;
    let limit = page_limit(body.limit).c(h!())?;
    let filter = normalize_tag_filter(
        files.connection(),
        body.tag_ids.clone().unwrap_or_default(),
        body.tag_match,
        body.untagged.unwrap_or(false),
    )
    .await
    .c(h!())?;
    let path = query.bind(scope_path.to_owned());
    let id = query.bind(parse_uuid(&body.scope_entry_id));
    let mut predicate = if body.global_search.unwrap_or(false) {
        "entry.parent_id is not null".to_owned()
    } else {
        format!("entry.parent_id is not null and entry.hierarchy_path::ltree <@ {path}::ltree and entry.id <> {id}")
    };
    append_filters(&mut query, &mut predicate, &filters);
    let tags = query.tag_filter("entry", filter.as_ref());
    predicate.push_str(&format!(" and {tags}"));
    let page = load_page(
        files,
        query,
        predicate,
        limit,
        body.cursor.as_deref(),
        cursor_scope,
        if body.rank_by_relevance.unwrap_or(false) {
            TreePageOrder::Relevance {
                term: filters.name_query().unwrap_or_default().to_owned(),
                path: scope_path.to_owned(),
            }
        } else {
            TreePageOrder::Listing(
                crate::devices::files::sorting::FileListingSort::new(
                    body.sort_by,
                    body.sort_direction,
                ),
            )
        },
    )
    .await
    .c(h!())?;
    let mut response = bl::map_search(SearchFilesResult {
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
    });
    query::sizes::apply(&mut response.entries, &page.sizes);
    Ok(response)
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
