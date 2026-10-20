use super::{query, types::DeviceArchiveOrigin};
use crate::{
    devices::files::types::{DeviceFileJournalEntry, DeviceFileTreeEntry},
    h,
    types::ShortContext,
};
use anyhow::{Context, Result};
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::BTreeMap;
use uuid::Uuid;

struct Attributes {
    is_archive: bool,
    origin: Option<DeviceArchiveOrigin>,
    path: Option<String>,
}

async fn attributes(
    db: &impl ConnectionTrait,
    device: Uuid,
    targets: &[(Uuid, i64)],
) -> Result<BTreeMap<(Uuid, i64), Attributes>> {
    let wanted=serde_json::to_value(targets.iter().map(|(id,revision)|serde_json::json!({"id":id,"revision":revision})).collect::<Vec<_>>()).c(h!())?;
    let rows=db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select r.id,r.revision,r.name,r.extension,r.mime_type,r.is_archive,a.id as origin,a.source_file_id,a.source_revision,
                case when e.archive_file_id is not null then (select source.absolute_path||'/'||(select string_agg(part.name,'/' order by nlevel(part.hierarchy_path)) from file_entry part where part.device_id=e.device_id and part.hierarchy_path @> e.hierarchy_path and part.hierarchy_path <@ source.hierarchy_path and part.id<>source.id) from file_entry source where source.device_id=e.device_id and source.absolute_path is not null and source.hierarchy_path @> e.hierarchy_path order by nlevel(source.hierarchy_path) limit 1) end as virtual_path
         from jsonb_to_recordset($2) as wanted(id uuid,revision bigint) join file_revision r on r.id=wanted.id and r.revision=wanted.revision and r.device_id=$1 join file_entry e on e.id=r.id left join file_archive a on a.id=r.origin_archive_id and a.state='ready'",
        [device.into(),wanted.into()])).await.c(h!())?;
    let mut result = BTreeMap::new();
    for row in rows {
        let id = row.try_get("", "id").c(h!())?;
        let revision = row.try_get("", "revision").c(h!())?;
        let name: String = row.try_get("", "name").c(h!())?;
        let extension: Option<String> = row.try_get("", "extension").c(h!())?;
        let mime: Option<String> = row.try_get("", "mime_type").c(h!())?;
        let origin: Option<Uuid> = row.try_get("", "origin").c(h!())?;
        let origin = origin
            .map(|archive_id| {
                Ok::<_, anyhow::Error>(DeviceArchiveOrigin {
                    archive_id,
                    source_file_id: row
                        .try_get("", "source_file_id")
                        .c(h!())?,
                    source_revision: row
                        .try_get("", "source_revision")
                        .c(h!())?,
                })
            })
            .transpose()?;
        result.insert(
            (id, revision),
            Attributes {
                is_archive: row
                    .try_get::<Option<bool>>("", "is_archive")
                    .c(h!())?
                    .unwrap_or_else(|| {
                        super::super::preview::is_archive(
                            &name,
                            extension.as_deref(),
                            mime.as_deref(),
                        )
                    }),
                origin,
                path: row.try_get("", "virtual_path").c(h!())?,
            },
        );
    }
    Ok(result)
}

pub(in crate::devices::files) async fn tree(
    db: &impl ConnectionTrait,
    device: Uuid,
    entries: &mut [DeviceFileTreeEntry],
) -> Result<()> {
    let identities = entries
        .iter()
        .filter_map(|entry| {
            entry.revision.map(|revision| (&entry.entry_id, revision))
        })
        .map(|(id, revision)| Ok((Uuid::parse_str(id).c(h!())?, revision)))
        .collect::<Result<Vec<_>>>()?;
    let summaries = query::summaries(db, device, &identities)
        .await
        .context(h!())?;
    let attributes = attributes(db, device, &identities).await?;
    for entry in entries {
        let Some(revision) = entry.revision else {
            continue;
        };
        let identity = (Uuid::parse_str(&entry.entry_id).c(h!())?, revision);
        entry.archive = summaries.get(&identity).cloned();
        if let Some(attributes) = attributes.get(&identity) {
            entry.is_archive = attributes.is_archive;
            entry.archive_origin = attributes.origin.clone();
            entry.virtual_path = attributes.path.clone();
        }
    }
    Ok(())
}

pub(in crate::devices::files) async fn journal(
    db: &impl ConnectionTrait,
    device: Uuid,
    entries: &mut [DeviceFileJournalEntry],
) -> Result<()> {
    let identities = entries
        .iter()
        .map(|entry| {
            Ok((Uuid::parse_str(&entry.file_id).c(h!())?, entry.revision))
        })
        .collect::<Result<Vec<_>>>()?;
    let summaries = query::summaries(db, device, &identities).await?;
    for (entry, identity) in entries.iter_mut().zip(identities) {
        entry.archive = summaries.get(&identity).cloned();
    }
    Ok(())
}
