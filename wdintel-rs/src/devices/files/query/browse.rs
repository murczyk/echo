use super::{core, model};
use crate::devices::analytics::types::{TagFilter, TagMatch};
use crate::devices::files::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FilesystemError, KeysetPage, KeysetPageRequest, TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, Condition, ConnectionTrait, DatabaseBackend, EntityTrait,
    ExprTrait, FromQueryResult, QueryFilter, QuerySelect, Select, Statement,
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

    let tag_predicate = if tag_filter.untagged {
        r#"
        not exists (
            select 1
            from device_file_tag as link
            join analytics_tag as tag
              on tag.id = link.tag_id
             and tag.archived_at is null
            where link.file_entry_id = matching_file.id
        )
        "#
    } else {
        match tag_filter.tag_match {
            TagMatch::TagAny => {
                r#"
                exists (
                    select 1
                    from device_file_tag as link
                    join analytics_tag as tag
                      on tag.id = link.tag_id
                     and tag.archived_at is null
                    where link.file_entry_id = matching_file.id
                      and link.tag_id = any($3::uuid[])
                )
                "#
            }
            TagMatch::TagAll => {
                r#"
                not exists (
                    select 1
                    from unnest($3::uuid[]) as requested(tag_id)
                    where not exists (
                        select 1
                        from device_file_tag as link
                        join analytics_tag as tag
                          on tag.id = link.tag_id
                         and tag.archived_at is null
                        where link.file_entry_id = matching_file.id
                          and link.tag_id = requested.tag_id
                    )
                )
                "#
            }
        }
    };
    let sql = format!(
        r#"
        select candidate.id as entry_id
        from file_entry as candidate
        where candidate.device_id = $1
          and candidate.id = any($2::uuid[])
          and exists (
              select 1
              from file_entry as matching_file
              where matching_file.device_id = candidate.device_id
                and matching_file.kind = 'file'
                and (
                    matching_file.id = candidate.id
                    or (
                        candidate.kind = 'directory'
                        and matching_file.hierarchy_path <@ candidate.hierarchy_path
                    )
                )
                and ({tag_predicate})
          )
        "#,
    );
    let mut values = vec![device_id.into(), entry_ids.to_vec().into()];
    if !tag_filter.untagged {
        values.push(tag_filter.tag_ids.clone().into());
    }
    MatchingTreeEntryId::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
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
