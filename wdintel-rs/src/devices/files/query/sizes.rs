use crate::devices::files::types::{DeviceFileTreeEntry, FileEntryKind};
use crate::{h, types::ShortContext};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::HashMap;
use uuid::Uuid;

pub(in crate::devices::files) fn directory_value_sql(
    alias: &str,
    revision: &str,
) -> String {
    format!(
        "(
             select coalesce(sum(member.source_size_bytes),0)::bigint from (
                 select content.source_size_bytes
                 from file_entry descendant
                 join file_content content on content.file_id=descendant.id and content.revision=descendant.revision
                 where {alias}.archive_file_id is null and descendant.archive_file_id is null
                   and descendant.device_id is not distinct from {alias}.device_id and descendant.kind='file'
                   and descendant.hierarchy_path <@ {alias}.hierarchy_path
                 union all
                 select content.source_size_bytes
                 from file_revision directory_revision
                 join file_revision member_revision on member_revision.origin_archive_id=directory_revision.origin_archive_id
                 join file_entry descendant on descendant.device_id=member_revision.device_id and descendant.id=member_revision.id
                 join file_content content on content.file_id=member_revision.id and content.revision=member_revision.revision
                 where {alias}.archive_file_id is not null and directory_revision.id={alias}.id and directory_revision.revision={revision}
                   and descendant.device_id={alias}.device_id and descendant.kind='file'
                   and descendant.hierarchy_path <@ {alias}.hierarchy_path
             ) member
         )"
    )
}

pub(in crate::devices::files) fn value_sql(
    alias: &str,
    revision: &str,
) -> String {
    let directory_size = directory_value_sql(alias, revision);
    format!("case when {alias}.kind::text='directory' then {directory_size} else (select content.source_size_bytes from file_content content where content.file_id={alias}.id and content.revision={revision}) end")
}

pub(in crate::devices::files) async fn hydrate(
    db: &impl ConnectionTrait,
    entries: &mut [DeviceFileTreeEntry],
) -> anyhow::Result<()> {
    let wanted = entries.iter()
        .filter(|entry| entry.kind == FileEntryKind::Directory && entry.size_bytes.is_none())
        .map(|entry| serde_json::json!({"id":entry.entry_id,"revision":entry.revision}))
        .collect::<Vec<_>>();
    if wanted.is_empty() {
        return Ok(());
    }
    let size = value_sql("directory", "directory.revision");
    let rows = db.query_all_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!("select directory.id, {size} as size_bytes
                 from jsonb_to_recordset($1::jsonb) wanted(id uuid, revision bigint)
                 join file_entry entry on entry.id=wanted.id
                 cross join lateral (select entry.id,entry.device_id,entry.kind,entry.hierarchy_path,entry.archive_file_id,coalesce(wanted.revision,entry.revision) as revision) directory"),
        [serde_json::json!(wanted).into()],
    )).await.c(h!())?;
    let sizes = rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.try_get("", "id").c(h!())?;
            Ok((id.to_string(), row.try_get("", "size_bytes").c(h!())?))
        })
        .collect::<anyhow::Result<HashMap<_, _>>>()
        .c(h!())?;
    apply(entries, &sizes);
    Ok(())
}

pub(in crate::devices::files) fn apply(
    entries: &mut [DeviceFileTreeEntry],
    sizes: &HashMap<String, Option<i64>>,
) {
    for entry in entries {
        if let Some(size) = sizes.get(&entry.entry_id) {
            entry.size_bytes = *size;
        }
    }
}
