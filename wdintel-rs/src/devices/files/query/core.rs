use super::super::ltree;
use super::model;
use crate::devices::analytics::types::{TagFilter, TagMatch};
use crate::devices::files::{
    map_database_error, DirectoryScope, DomainFileEntryKind, EntryQueryScope,
    EntrySortKey, FileSearchFilters, FilesystemError, KeysetPage, TreeEntry,
};
use crate::file_registry::entities::{
    analytics_tag, device_file_tag, file_entry,
};
use crate::h;
use sea_orm::sea_query::{
    extension::postgres::PgExpr, Alias, Expr, Func, IntoIden, JoinType,
    LikeExpr, Query, SelectStatement, SimpleExpr,
};
use sea_orm::{
    ActiveEnum, ColumnTrait, Condition, ConnectionTrait, EntityTrait,
    ExprTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use uuid::Uuid;

pub(super) fn file_tag_filter<T>(
    file_table: T,
    tag_filter: &TagFilter,
) -> SimpleExpr
where
    T: IntoIden + Clone + 'static,
{
    if tag_filter.untagged {
        return Expr::exists(active_file_tag_query(file_table, None)).not();
    }

    match tag_filter.tag_match {
        TagMatch::TagAny => Expr::exists(active_file_tag_query(
            file_table,
            Some(&tag_filter.tag_ids),
        )),
        TagMatch::TagAll => tag_filter
            .tag_ids
            .iter()
            .fold(Condition::all(), |condition, tag_id| {
                condition.add(Expr::exists(active_file_tag_query(
                    file_table.clone(),
                    Some(std::slice::from_ref(tag_id)),
                )))
            })
            .into(),
    }
}

fn active_file_tag_query<T>(
    file_table: T,
    tag_ids: Option<&[Uuid]>,
) -> SelectStatement
where
    T: IntoIden + 'static,
{
    let mut query = Query::select()
        .expr(Expr::value(1))
        .from(device_file_tag::Entity)
        .join(
            JoinType::InnerJoin,
            analytics_tag::Entity,
            Condition::all()
                .add(
                    Expr::col((
                        analytics_tag::Entity,
                        analytics_tag::Column::Id,
                    ))
                    .equals((
                        device_file_tag::Entity,
                        device_file_tag::Column::TagId,
                    )),
                )
                .add(
                    Expr::col((
                        analytics_tag::Entity,
                        analytics_tag::Column::ArchivedAt,
                    ))
                    .is_null(),
                ),
        )
        .and_where(
            Expr::col((
                device_file_tag::Entity,
                device_file_tag::Column::FileEntryId,
            ))
            .eq(Expr::col((file_table, file_entry::Column::Id))),
        )
        .to_owned();
    if let Some(tag_ids) = tag_ids {
        query.and_where(
            Expr::col((
                device_file_tag::Entity,
                device_file_tag::Column::TagId,
            ))
            .is_in(tag_ids.iter().copied()),
        );
    }
    query
}

pub(in crate::devices::files) async fn find_directory_scope(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    entry_id: Uuid,
) -> Result<DirectoryScope, FilesystemError> {
    let entry = directory_scope_query(device_id, entry_id)
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::NotFound)?;
    let root_context = if entry.parent_id.is_some() {
        Some(resolve_root_context(db, device_id, &entry.hierarchy_path).await?)
    } else {
        None
    };

    model::map_directory_scope(entry, root_context)
}

pub(super) fn directory_scope_query(
    device_id: Uuid,
    entry_id: Uuid,
) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Id.eq(entry_id))
        .filter(file_entry::Column::Kind.eq(DomainFileEntryKind::Directory))
}

async fn resolve_root_context(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    target_hierarchy_path: &str,
) -> Result<Uuid, FilesystemError> {
    root_context_query(device_id, target_hierarchy_path)
        .into_tuple::<Uuid>()
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "directory_scope_root_context_missing",
        ))
}

pub(super) fn root_context_query(
    device_id: Uuid,
    target_hierarchy_path: &str,
) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .select_only()
        .column(file_entry::Column::Id)
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(file_entry::Column::Kind.eq(DomainFileEntryKind::Directory))
        .filter(ltree::ancestor_expr(target_hierarchy_path))
}

pub(in crate::devices::files) fn apply_entry_scope(
    query: Select<file_entry::Entity>,
    scope: &EntryQueryScope<'_>,
) -> Select<file_entry::Entity> {
    let query =
        query.filter(file_entry::Column::DeviceId.eq(scope.device_id()));

    match scope {
        EntryQueryScope::Browse(directory) => query
            .filter(file_entry::Column::ParentId.is_not_null())
            .filter(file_entry::Column::ParentId.eq(directory.entry_id())),
        EntryQueryScope::Search { directory, filters } => {
            apply_search_filters(apply_search_scope(query, directory), filters)
        }
    }
}

pub(super) fn apply_search_scope(
    query: Select<file_entry::Entity>,
    directory: &DirectoryScope,
) -> Select<file_entry::Entity> {
    query
        .filter(file_entry::Column::ParentId.is_not_null())
        .filter(ltree::descendant_expr(directory.hierarchy_path()))
        .filter(file_entry::Column::Id.ne(directory.entry_id()))
}

pub(super) fn apply_search_filters(
    mut query: Select<file_entry::Entity>,
    filters: &FileSearchFilters,
) -> Select<file_entry::Entity> {
    if !filters.kinds().is_empty() {
        query = query
            .filter(file_entry::Column::Kind.is_in(filters.kinds().to_vec()));
    }
    if let Some(name_query) = filters.name_query() {
        query = query.filter(
            Expr::col((file_entry::Entity, file_entry::Column::Name))
                .ilike(LikeExpr::new(literal_name_pattern(name_query))),
        );
    }
    if filters.requires_file_metadata() {
        query = query
            .filter(file_entry::Column::Kind.eq(DomainFileEntryKind::File));
    }
    if !filters.mime_types().is_empty() {
        query = query.filter(
            file_entry::Column::MimeType.is_in(filters.mime_types().to_vec()),
        );
    }
    if !filters.extensions().is_empty() {
        query = query.filter(
            file_entry::Column::Extension.is_in(filters.extensions().to_vec()),
        );
    }
    if let Some(modified_from) = filters.file_metadata_modified_from() {
        query = query.filter(
            file_entry::Column::FileMetadataModifiedAt.gte(modified_from),
        );
    }
    if let Some(modified_to) = filters.file_metadata_modified_to() {
        query = query.filter(
            file_entry::Column::FileMetadataModifiedAt.lte(modified_to),
        );
    }
    query
}

pub(super) fn literal_name_pattern(name_query: &str) -> String {
    let mut pattern = String::with_capacity(
        name_query.len().saturating_mul(2).saturating_add(2),
    );
    pattern.push('%');
    for character in name_query.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

fn utf8_name_bytes_expr() -> SimpleExpr {
    Func::cust(Alias::new("convert_to"))
        .arg(Expr::col((file_entry::Entity, file_entry::Column::Name)))
        .arg(Expr::val("UTF8"))
        .into()
}

fn utf8_bytes_value(value: &str) -> SimpleExpr {
    Func::cust(Alias::new("convert_to"))
        .arg(Expr::val(value))
        .arg(Expr::val("UTF8"))
        .into()
}

pub(super) fn apply_root_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(utf8_name_bytes_expr())
        .order_by_asc(file_entry::Column::Id)
}

pub(in crate::devices::files) fn apply_entry_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(file_entry::Column::Kind)
        .order_by_asc(utf8_name_bytes_expr())
        .order_by_asc(file_entry::Column::Id)
}

pub(in crate::devices::files) fn entry_strict_after_condition(
    after: &EntrySortKey,
) -> Condition {
    Condition::all().add(
        Expr::tuple([
            Expr::col((file_entry::Entity, file_entry::Column::Kind)),
            utf8_name_bytes_expr(),
            Expr::col((file_entry::Entity, file_entry::Column::Id)),
        ])
        .gt(Expr::tuple([
            ActiveEnum::as_enum(&after.kind()),
            utf8_bytes_value(after.name()),
            Expr::val(after.entry_id()),
        ])),
    )
}

pub(in crate::devices::files) fn finalize_page<T, K>(
    mut rows: Vec<T>,
    limit: u64,
    sort_key: impl Fn(&T) -> K,
) -> KeysetPage<T, K> {
    let limit = usize::try_from(limit)
        .expect("validated keyset page limit must fit usize");
    if rows.len() <= limit {
        return KeysetPage {
            entries: rows,
            next: None,
        };
    }

    rows.truncate(limit);
    let next = rows.last().map(sort_key);
    KeysetPage {
        entries: rows,
        next,
    }
}

pub(in crate::devices::files) async fn resolve_cursor_entry_sort_key(
    db: &impl ConnectionTrait,
    boundary_entry_id: Uuid,
    scope: &EntryQueryScope<'_>,
) -> Result<EntrySortKey, FilesystemError> {
    let entry = apply_entry_scope(file_entry::Entity::find(), scope)
        .filter(file_entry::Column::Id.eq(boundary_entry_id))
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or_else(FilesystemError::invalid_cursor)?;
    let entry = model::map_tree_model(entry)?;

    Ok(entry_sort_key(&entry))
}

pub(super) fn entry_sort_key(entry: &TreeEntry) -> EntrySortKey {
    match entry {
        TreeEntry::Directory(directory) => EntrySortKey::new(
            DomainFileEntryKind::Directory,
            directory.name.clone(),
            directory.entry_id,
        ),
        TreeEntry::File(file) => EntrySortKey::new(
            DomainFileEntryKind::File,
            file.name.clone(),
            file.file_id,
        ),
    }
}
