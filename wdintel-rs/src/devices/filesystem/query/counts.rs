use crate::devices::filesystem::{
    map_database_error, FileEntryKind, FilesystemError, SubtreeFileCount,
};
use crate::h;
use sea_orm::{ConnectionTrait, DbBackend, FromQueryResult, Statement};
use uuid::Uuid;

#[derive(Debug, FromQueryResult)]
struct SubtreeFileCountRow {
    entry_id: Uuid,
    file_count: i64,
}

#[derive(Debug, FromQueryResult)]
struct TotalFileCountRow {
    file_count: i64,
}

pub(in crate::devices::filesystem) async fn count_file_subtrees(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    parent_entry_id: Option<Uuid>,
    directory_entry_ids: &[Uuid],
) -> Result<Vec<SubtreeFileCount>, FilesystemError> {
    let rows =
        SubtreeFileCountRow::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
            with requested as (
                select entry_id, ordinality
                from unnest($3::uuid[]) with ordinality
                    as requested(entry_id, ordinality)
            ),
            requested_directories as (
                select
                    requested.entry_id,
                    requested.ordinality,
                    directory.hierarchy_path
                from requested
                join file_entry directory
                    on directory.id = requested.entry_id
                    and directory.device_id = $1
                    and directory.kind = $2
                    and directory.parent_id is not distinct from $4::uuid
            ),
            scope as (
                select
                    parent.hierarchy_path as parent_hierarchy_path,
                    nlevel(parent.hierarchy_path) + 1 as child_depth
                from file_entry parent
                where $4::uuid is not null
                    and parent.id = $4
                    and parent.device_id = $1
                    and parent.kind = $2

                union all

                select null::public.ltree, 1
                where $4::uuid is null
            ),
            file_counts as (
                select
                    subpath(file.hierarchy_path, 0, scope.child_depth)::text
                        as hierarchy_path,
                    count(*)::bigint as file_count
                from scope
                join file_entry file
                    on file.device_id = $1
                    and file.kind = $5
                    and (
                        scope.parent_hierarchy_path is null
                        or file.hierarchy_path <@ scope.parent_hierarchy_path
                    )
                group by
                    subpath(file.hierarchy_path, 0, scope.child_depth)::text
            )
            select
                requested_directories.entry_id,
                coalesce(file_counts.file_count, 0)::bigint as file_count
            from requested_directories
            left join file_counts
                on file_counts.hierarchy_path =
                    requested_directories.hierarchy_path::text
            order by requested_directories.ordinality
            "#,
            vec![
                device_id.into(),
                FileEntryKind::Directory.as_db_str().into(),
                directory_entry_ids.to_vec().into(),
                parent_entry_id.into(),
                FileEntryKind::File.as_db_str().into(),
            ],
        ))
        .all(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?;

    rows.into_iter()
        .map(|row| {
            Ok(SubtreeFileCount {
                entry_id: row.entry_id,
                file_count: checked_file_count(row.file_count)?,
            })
        })
        .collect()
}

pub(in crate::devices::filesystem) async fn count_device_files(
    db: &impl ConnectionTrait,
    device_id: Uuid,
) -> Result<u64, FilesystemError> {
    let row =
        TotalFileCountRow::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
            select count(*)::bigint as file_count
            from file_entry
            where device_id = $1
                and kind = $2
            "#,
            [device_id.into(), FileEntryKind::File.as_db_str().into()],
        ))
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant("missing_file_count"))?;

    checked_file_count(row.file_count)
}

fn checked_file_count(file_count: i64) -> Result<u64, FilesystemError> {
    file_count
        .try_into()
        .map_err(|_| FilesystemError::Invariant("negative_file_count"))
}
