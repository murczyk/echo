use super::{core, model};
use crate::devices::analytics::types::TagFilter;
use crate::devices::files::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FilesystemError, KeysetPage, KeysetPageRequest, TreeEntry,
};
use crate::file_registry::entities::{
    file_entry, sea_orm_active_enums::FileEntryKind,
};
use crate::h;
use sea_orm::sea_query::{extension::postgres::PgExpr, Alias, Expr, Query};
use sea_orm::{
    ActiveEnum, Condition, ConnectionTrait, EntityTrait, ExprTrait,
    FromQueryResult, QueryFilter, QuerySelect, Select,
};
use std::collections::BTreeSet;
use uuid::Uuid;

pub(in crate::devices::files) async fn list_children(
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

#[derive(Debug, FromQueryResult)]
struct MatchingTreeEntryId {
    entry_id: Uuid,
}

pub(in crate::devices::files) async fn find_matching_tree_entry_ids(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    entry_ids: &[Uuid],
    tag_filter: &TagFilter,
) -> Result<BTreeSet<Uuid>, FilesystemError> {
    if entry_ids.is_empty() {
        return Ok(BTreeSet::new());
    }

    let candidate = Alias::new("candidate");
    let matching_file = Alias::new("matching_file");
    let matching_file_query = Query::select()
        .expr(Expr::value(1))
        .from_as(file_entry::Entity, matching_file.clone())
        .and_where(
            Expr::col((matching_file.clone(), file_entry::Column::DeviceId))
                .eq(Expr::col((
                    candidate.clone(),
                    file_entry::Column::DeviceId,
                ))),
        )
        .and_where(
            Expr::col((matching_file.clone(), file_entry::Column::Kind))
                .eq(FileEntryKind::File.to_value()),
        )
        .and_where(
            Condition::any()
                .add(
                    Expr::col((matching_file.clone(), file_entry::Column::Id))
                        .eq(Expr::col((
                            candidate.clone(),
                            file_entry::Column::Id,
                        ))),
                )
                .add(
                    Condition::all()
                        .add(
                            Expr::col((
                                candidate.clone(),
                                file_entry::Column::Kind,
                            ))
                            .eq(FileEntryKind::Directory.to_value()),
                        )
                        .add(
                            Expr::col((
                                matching_file.clone(),
                                file_entry::Column::HierarchyPath,
                            ))
                            .contained(Expr::col(
                                (
                                    candidate.clone(),
                                    file_entry::Column::HierarchyPath,
                                ),
                            )),
                        ),
                )
                .into(),
        )
        .and_where(core::file_tag_filter(matching_file, tag_filter))
        .to_owned();
    let query = Query::select()
        .expr_as(
            Expr::col((candidate.clone(), file_entry::Column::Id)),
            Alias::new("entry_id"),
        )
        .from_as(file_entry::Entity, candidate.clone())
        .and_where(
            Expr::col((candidate.clone(), file_entry::Column::DeviceId))
                .eq(device_id),
        )
        .and_where(
            Expr::col((candidate, file_entry::Column::Id))
                .is_in(entry_ids.iter().copied()),
        )
        .and_where(Expr::exists(matching_file_query))
        .to_owned();

    MatchingTreeEntryId::find_by_statement(
        db.get_database_backend().build(&query),
    )
    .all(db)
    .await
    .map(|rows| rows.into_iter().map(|row| row.entry_id).collect())
    .map_err(|error| {
        map_database_error(anyhow::Error::new(error).context(h!()))
    })
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
            Expr::col((file_entry::Entity, file_entry::Column::ParentId)),
            Expr::col((file_entry::Entity, file_entry::Column::Kind)),
            Expr::col((file_entry::Entity, file_entry::Column::Name)),
            Expr::col((file_entry::Entity, file_entry::Column::Id)),
        ])
        .gt(Expr::tuple([
            Expr::val(parent_id),
            ActiveEnum::as_enum(&after.kind()),
            Expr::val(after.name()),
            Expr::val(after.entry_id()),
        ])),
    )
}
