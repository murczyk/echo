use crate::devices::files::{
    map_database_error, DomainFileEntryKind, FilesystemError, SubtreeFileCount,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::{
    extension::postgres::PgExpr, Alias, Expr, Func, JoinType, Query,
};
use sea_orm::{
    ActiveEnum, Condition, ConnectionTrait, ExprTrait, FromQueryResult,
};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, FromQueryResult)]
struct SubtreeFileCountRow {
    entry_id: Uuid,
    file_count: i64,
}

pub(in crate::devices::files) async fn count_file_subtrees(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    parent_entry_id: Option<Uuid>,
    directory_entry_ids: &[Uuid],
) -> Result<Vec<SubtreeFileCount>, FilesystemError> {
    if directory_entry_ids.is_empty() {
        return Ok(Vec::new());
    }

    let directory = Alias::new("directory");
    let file = Alias::new("file");
    let file_join =
        Condition::all()
            .add(Expr::col((file.clone(), file_entry::Column::DeviceId)).eq(
                Expr::col((directory.clone(), file_entry::Column::DeviceId)),
            ))
            .add(
                Expr::col((file.clone(), file_entry::Column::Kind))
                    .eq(DomainFileEntryKind::File.to_value()),
            )
            .add(
                Expr::col((file.clone(), file_entry::Column::HierarchyPath))
                    .contained(Expr::col((
                        directory.clone(),
                        file_entry::Column::HierarchyPath,
                    ))),
            );
    let parent_filter = match parent_entry_id {
        Some(parent_entry_id) => {
            Expr::col((directory.clone(), file_entry::Column::ParentId))
                .eq(parent_entry_id)
        }
        None => Expr::col((directory.clone(), file_entry::Column::ParentId))
            .is_null(),
    };
    let query = Query::select()
        .expr_as(
            Expr::col((directory.clone(), file_entry::Column::Id)),
            Alias::new("entry_id"),
        )
        .expr_as(
            Func::count(Expr::col((file.clone(), file_entry::Column::Id))),
            Alias::new("file_count"),
        )
        .from_as(file_entry::Entity, directory.clone())
        .join_as(JoinType::LeftJoin, file_entry::Entity, file, file_join)
        .and_where(
            Expr::col((directory.clone(), file_entry::Column::DeviceId))
                .eq(device_id),
        )
        .and_where(
            Expr::col((directory.clone(), file_entry::Column::Kind))
                .eq(DomainFileEntryKind::Directory.to_value()),
        )
        .and_where(
            Expr::col((directory.clone(), file_entry::Column::Id))
                .is_in(directory_entry_ids.iter().copied()),
        )
        .and_where(parent_filter)
        .group_by_col((directory, file_entry::Column::Id))
        .to_owned();
    let rows = SubtreeFileCountRow::find_by_statement(
        db.get_database_backend().build(&query),
    )
    .all(db)
    .await
    .map_err(|error| {
        map_database_error(anyhow::Error::new(error).context(h!()))
    })?;
    let file_counts = rows
        .into_iter()
        .map(|row| (row.entry_id, row.file_count))
        .collect::<HashMap<_, _>>();

    directory_entry_ids
        .iter()
        .filter_map(|entry_id| {
            file_counts
                .get(entry_id)
                .map(|file_count| (*entry_id, *file_count))
        })
        .map(|(entry_id, file_count)| {
            Ok(SubtreeFileCount {
                entry_id,
                file_count: checked_file_count(file_count)?,
            })
        })
        .collect()
}

fn checked_file_count(file_count: i64) -> Result<u64, FilesystemError> {
    file_count
        .try_into()
        .map_err(|_| FilesystemError::Invariant("negative_file_count"))
}
