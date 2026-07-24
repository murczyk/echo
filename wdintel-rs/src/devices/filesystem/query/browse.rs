use super::{core, model};
use crate::devices::filesystem::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FilesystemError, KeysetPage, KeysetPageRequest, TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::Expr;
use sea_orm::{
    Condition, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect, Select,
};

pub(in crate::devices::filesystem) async fn list_children(
    db: &impl ConnectionTrait,
    scope: &DirectoryScope,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
    let entries = children_query(scope, page.after())
        .limit(page.limit() + 1)
        .all(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .into_iter()
        .map(model::map_tree_model)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(core::finalize_page(
        entries,
        page.limit(),
        core::entry_sort_key,
    ))
}

pub(super) fn children_query(
    scope: &DirectoryScope,
    after: Option<&EntrySortKey>,
) -> Select<file_entry::Entity> {
    let parent_id = scope.entry_id();
    let scope = EntryQueryScope::Browse(scope);
    let mut query = core::apply_entry_scope(file_entry::Entity::find(), &scope);
    query = core::apply_entry_order(query);
    if let Some(after) = after {
        query = query.filter(children_strict_after_condition(parent_id, after));
    }
    query
}

fn children_strict_after_condition(
    parent_id: uuid::Uuid,
    after: &EntrySortKey,
) -> Condition {
    Condition::all().add(
        Expr::tuple([
            Expr::col((file_entry::Entity, file_entry::Column::ParentId))
                .into(),
            Expr::col((file_entry::Entity, file_entry::Column::Kind)).into(),
            Expr::col((file_entry::Entity, file_entry::Column::NameKey)).into(),
            Expr::col((file_entry::Entity, file_entry::Column::Id)).into(),
        ])
        .gt(Expr::tuple([
            Expr::val(parent_id).into(),
            Expr::val(after.kind().as_db_str()).into(),
            Expr::val(after.name_key().to_vec()).into(),
            Expr::val(after.entry_id()).into(),
        ])),
    )
}
