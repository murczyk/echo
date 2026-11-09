use crate::devices::files::{map_database_error, FilesystemError};
use crate::file_registry::entities::file_entry;
use crate::{h, types::ShortContext};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::HashMap;
use uuid::Uuid;

pub(in crate::devices::files) fn aggregate_sql(alias: &str) -> String {
    aggregate_revision_sql(alias, &format!("{alias}.revision"))
}

pub(in crate::devices::files) fn aggregate_revision_sql(
    alias: &str,
    revision: &str,
) -> String {
    format!(
        "select min(files.created_at) as created_at, max(files.modified_at) as modified_at
         from (
             select descendant.file_metadata_created_at as created_at,
                    descendant.file_metadata_modified_at as modified_at
             from file_entry descendant
             where {alias}.archive_file_id is null and descendant.archive_file_id is null
               and descendant.device_id is not distinct from {alias}.device_id and descendant.kind='file'
               and descendant.hierarchy_path <@ {alias}.hierarchy_path
             union all
             select member_revision.file_metadata_created_at at time zone 'UTC',
                    member_revision.file_metadata_modified_at at time zone 'UTC'
             from file_revision directory_revision
             join file_revision member_revision on member_revision.origin_archive_id=directory_revision.origin_archive_id
             join file_entry descendant on descendant.device_id=member_revision.device_id and descendant.id=member_revision.id
             where {alias}.archive_file_id is not null and directory_revision.id={alias}.id and directory_revision.revision={revision}
               and descendant.device_id={alias}.device_id and descendant.kind='file'
               and descendant.hierarchy_path <@ {alias}.hierarchy_path
         ) files"
    )
}

pub(in crate::devices::files) fn value_sql(
    alias: &str,
    created: bool,
) -> String {
    let (column, aggregate) = if created {
        ("file_metadata_created_at", "created_at")
    } else {
        ("file_metadata_modified_at", "modified_at")
    };
    let dates = aggregate_sql(alias);
    format!("case when {alias}.kind::text='directory' then (select dates.{aggregate} from ({dates}) dates) else {alias}.{column} end")
}

pub(in crate::devices::files) async fn hydrate(
    db: &impl ConnectionTrait,
    entries: &mut [file_entry::Model],
) -> Result<(), FilesystemError> {
    hydrate_dates(db, entries).await.map_err(map_database_error)
}

async fn hydrate_dates(
    db: &impl ConnectionTrait,
    entries: &mut [file_entry::Model],
) -> anyhow::Result<()> {
    let directories = entries.iter().filter(|entry| {
        entry.kind == crate::devices::files::DomainFileEntryKind::Directory
    });
    let wanted = directories
        .map(|entry| serde_json::json!({"id":entry.id,"revision":entry.revision}))
        .collect::<Vec<_>>();
    if wanted.is_empty() {
        return Ok(());
    }
    let dates = aggregate_sql("directory");
    let rows = db.query_all_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!("select directory.id, dates.*
                 from jsonb_to_recordset($1::jsonb) wanted(id uuid, revision bigint)
                 join file_entry entry on entry.id=wanted.id
                 cross join lateral (select entry.id,entry.device_id,entry.kind,entry.hierarchy_path,entry.archive_file_id,wanted.revision) directory
                 cross join lateral ({dates}) dates"),
        [serde_json::json!(wanted).into()],
    )).await.c(h!())?;
    let mut dates = HashMap::new();
    for row in rows {
        let id: Uuid = row.try_get("", "id").c(h!())?;
        dates.insert(
            id,
            (
                row.try_get("", "created_at").c(h!())?,
                row.try_get("", "modified_at").c(h!())?,
            ),
        );
    }
    for entry in entries {
        if let Some((created, modified)) = dates.remove(&entry.id) {
            entry.file_metadata_created_at = created;
            entry.file_metadata_modified_at = modified;
        }
    }
    Ok(())
}
