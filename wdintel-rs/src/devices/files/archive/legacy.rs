use super::{
    access,
    query::{self, Rejection},
    types::DeviceFileContentRef,
};
use crate::{devices::config::*, h, types::ShortContext};
use anyhow::{Context, Result};
use sea_orm::{ConnectionTrait, DbBackend, Statement};

pub(in crate::devices::files) async fn resolve(
    db: &impl ConnectionTrait,
    mut target: DeviceFileContentRef,
    ordinals: &[usize],
) -> Result<DeviceFileContentRef> {
    if ordinals.is_empty()
        || ordinals.len() as u64 > DEVICE_FILE_ARCHIVE_MAX_DEPTH
    {
        return Err(Rejection("invalid_request").into());
    }
    for ordinal in ordinals {
        query::source(db, &target).await.context(h!())?;
        let archive = query::archive(db, &target)
            .await
            .context(h!())?
            .filter(|archive| archive.state == "ready")
            .ok_or(Rejection("archive_not_ready"))
            .context(h!())?;
        let member = db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select r.id as file_id from file_revision r join file_entry e on e.id=r.id where r.origin_archive_id=$1 and r.archive_member_index=$2 and e.kind='file'",
            [archive.id.into(),(*ordinal as i64).into()])).await.c(h!())?.ok_or(Rejection("not_found")).context(h!())?;
        target.file_id = member.try_get("", "file_id").c(h!())?;
        target.revision = archive.source_revision;
        access::find_published_content(
            db,
            target.device_id,
            target.file_id,
            target.revision,
        )
        .await
        .context(h!())?
        .ok_or(Rejection("not_found"))
        .context(h!())?;
    }
    Ok(target)
}
