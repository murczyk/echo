use super::{ancestors, core, model};
use crate::devices::files::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileSearchFilters, FilesystemError, KeysetPage, KeysetPageRequest,
    SearchEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::{
    Alias, CommonTableExpression, Condition, Expr, JoinType,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, QueryFilter,
    QuerySelect, QueryTrait, Select,
};

pub(in crate::devices::files) async fn search_entries(
    db: &impl ConnectionTrait,
    scope: &DirectoryScope,
    filters: &FileSearchFilters,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<SearchEntry, EntrySortKey>, FilesystemError> {
    let entries = search_query(scope, filters, page.after())
        .limit(page.limit() + 1)
        .all(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .into_iter()
        .map(model::map_tree_model)
        .collect::<Result<Vec<_>, _>>()?;
    let page = core::finalize_page(entries, page.limit(), core::entry_sort_key);
    let path_components =
        ancestors::load_path_components(db, &page.entries).await?;

    Ok(KeysetPage {
        entries: page
            .entries
            .into_iter()
            .zip(path_components)
            .map(|(entry, path_components)| SearchEntry {
                entry,
                path_components,
            })
            .collect(),
        next: page.next,
    })
}

pub(super) fn search_query(
    directory: &DirectoryScope,
    filters: &FileSearchFilters,
    after: Option<&EntrySortKey>,
) -> Select<file_entry::Entity> {
    let mut query = if filters.requires_file_metadata() {
        metadata_search_query(directory, filters)
    } else {
        match directory {
            DirectoryScope::Root(_) => base_search_query(directory, filters),
            DirectoryScope::Directory { .. } => {
                scoped_search_query(directory, filters)
            }
        }
    };
    query = core::apply_entry_order(query);
    if let Some(after) = after {
        query = query.filter(core::entry_strict_after_condition(after));
    }
    query
}

fn base_search_query(
    directory: &DirectoryScope,
    filters: &FileSearchFilters,
) -> Select<file_entry::Entity> {
    let scope = EntryQueryScope::Search { directory, filters };
    core::apply_entry_scope(file_entry::Entity::find(), &scope)
}

fn scoped_search_query(
    directory: &DirectoryScope,
    filters: &FileSearchFilters,
) -> Select<file_entry::Entity> {
    let scope = EntryQueryScope::Search { directory, filters };
    let candidates = core::apply_entry_scope(candidate_ids_query(), &scope);
    materialized_candidate_query(candidates, file_entry::Entity::find())
}

fn metadata_search_query(
    directory: &DirectoryScope,
    filters: &FileSearchFilters,
) -> Select<file_entry::Entity> {
    let candidates = core::apply_search_filters(
        candidate_ids_query()
            .filter(file_entry::Column::DeviceId.eq(directory.device_id()))
            .filter(file_entry::Column::ParentId.is_not_null()),
        filters,
    );
    let query = core::apply_search_scope(
        file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(directory.device_id())),
        directory,
    );
    materialized_candidate_query(candidates, query)
}

fn candidate_ids_query() -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .select_only()
        .column(file_entry::Column::DeviceId)
        .column(file_entry::Column::Id)
}

fn materialized_candidate_query(
    candidates: Select<file_entry::Entity>,
    mut query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    let cte_name = Alias::new("scoped_file_entry");
    let cte = CommonTableExpression::new()
        .table_name(cte_name.clone())
        .query(candidates.into_query())
        .materialized(true)
        .to_owned();
    let join_condition = Condition::all()
        .add(
            Expr::col((file_entry::Entity, file_entry::Column::DeviceId))
                .eq(Expr::col((cte_name.clone(), Alias::new("device_id")))),
        )
        .add(
            Expr::col((file_entry::Entity, file_entry::Column::Id))
                .eq(Expr::col((cte_name.clone(), Alias::new("id")))),
        );
    QueryTrait::query(&mut query)
        .join(JoinType::InnerJoin, cte_name, join_condition)
        .with_cte(cte);
    query
}
