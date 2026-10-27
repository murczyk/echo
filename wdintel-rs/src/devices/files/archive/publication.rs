use super::{enqueue, manifest::Member, protocol::Output, repository::Attempt};
use crate::{file_registry::entities::file_archive, h, types::ShortContext};
use anyhow::{ensure, Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend,
    FromQueryResult, Statement, TransactionTrait,
};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) async fn publish(
    db: &DatabaseConnection,
    attempt: &Attempt,
    outputs: &[Output],
) -> Result<()> {
    let tx = db.begin().await.c(h!())?;
    tx.execute_unprepared(&format!(
        "set local statement_timeout='{}ms'; set local lock_timeout='{}ms'",
        crate::devices::config::DEVICE_FILE_ARCHIVE_STATEMENT_TIMEOUT_MS,
        crate::devices::config::DEVICE_FILE_ARCHIVE_LOCK_TIMEOUT_MS,
    ))
    .await
    .c(h!())?;
    let archive =
        file_archive::Model::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select * from file_archive where id=$1 for update",
            [attempt.archive_id.into()],
        ))
        .one(&tx)
        .await
        .c(h!())?
        .c(h!())?;
    if archive.state == "ready" {
        return Ok(());
    }
    ensure!(
        archive.state == "running"
            && archive.run_id == Some(attempt.run_id)
            && archive
                .deadline
                .is_some_and(|deadline| deadline > chrono::Utc::now()),
        "stale publisher"
    );
    let root=tx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select 1 from file_archive where id=$1 and deadline>clock_timestamp() for update",[archive.root_id.into()])).await.c(h!())?;
    ensure!(root.is_some(), "archive root expired");
    ensure!(
        archive.declared_nodes == Some(outputs.len() as i64),
        "incomplete archive result"
    );
    publish_members(&tx, &archive, outputs).await?;
    finish(&tx, &archive, attempt).await?;
    tx.commit().await.c(h!())
}

async fn publish_members(
    tx: &DatabaseTransaction,
    archive: &file_archive::Model,
    outputs: &[Output],
) -> Result<()> {
    let source = tx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select e.hierarchy_path::text as hierarchy_path,r.sync_id from file_entry e join file_revision r on r.id=e.id where e.id=$1 and r.revision=$2",
        [archive.source_file_id.into(),archive.source_revision.into()])).await.c(h!())?.c(h!())?;
    let sync: Uuid = source.try_get("", "sync_id").c(h!())?;
    let hierarchy: String = source.try_get("", "hierarchy_path").c(h!())?;
    let mut parents =
        BTreeMap::from([(String::new(), (archive.source_file_id, hierarchy))]);
    let mut ordered = outputs.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|output| {
        (output.member.path.matches('/').count(), &output.member.path)
    });
    for output in ordered {
        let parent_path = output
            .member
            .path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let (parent, hierarchy) = parents.get(parent_path).c(h!())?;
        let (id, hierarchy) =
            publish_member(tx, archive, sync, output, *parent, hierarchy)
                .await?;
        if output.member.directory {
            parents.insert(output.member.path.clone(), (id, hierarchy));
        }
    }
    Ok(())
}

async fn publish_member(
    tx: &DatabaseTransaction,
    archive: &file_archive::Model,
    sync: Uuid,
    output: &Output,
    parent: Uuid,
    hierarchy: &str,
) -> Result<(Uuid, String)> {
    let member = &output.member;
    let name = member.path.rsplit('/').next().c(h!())?;
    super::path::validate(&member.path, member.directory, &Default::default())
        .context(h!())?;
    let kind = if member.directory {
        "directory"
    } else {
        "file"
    };
    let candidate = Uuid::new_v4();
    let row = tx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into file_entry(id,device_id,parent_id,kind,name,hierarchy_path,revision,sync_id,archive_file_id,archive_relative_path,is_archive,created_at,updated_at)
             values($1,$2,$3,$4::public.file_entry_kind,$5,$6::ltree||file_entry_uuid_label($1),$7,$8,$9,$10,$11,clock_timestamp(),clock_timestamp())
             on conflict(archive_file_id,archive_relative_path,kind) do nothing returning id,hierarchy_path::text as hierarchy_path",
            vec![candidate.into(),archive.device_id.into(),parent.into(),kind.into(),name.into(),hierarchy.into(),archive.source_revision.into(),sync.into(),archive.source_file_id.into(),member.path.clone().into(),is_archive(member).into()])).await.c(h!())?;
    let row = match row { Some(row) => row, None => tx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select id,hierarchy_path::text as hierarchy_path from file_entry where archive_file_id=$1 and archive_relative_path=$2 and kind=$3::public.file_entry_kind for update",
            [archive.source_file_id.into(),member.path.clone().into(),kind.into()])).await.c(h!())?.c(h!())? };
    let id: Uuid = row.try_get("", "id").c(h!())?;
    let extension = (!member.directory)
        .then(|| {
            std::path::Path::new(name)
                .extension()
                .map(|ext| ext.to_string_lossy().to_string())
        })
        .flatten();
    let mime = (!member.directory)
        .then(|| mime_guess::from_path(name).first_raw().map(str::to_owned))
        .flatten();
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "insert into file_revision(id,revision,device_id,sync_id,name,mime_type,extension,origin_archive_id,archive_member_index,is_archive,file_metadata_modified_at,created_at)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())",
            vec![id.into(),archive.source_revision.into(),archive.device_id.into(),sync.into(),name.into(),mime.clone().into(),extension.clone().into(),archive.id.into(),member.ordinal.map(|n|n as i64).into(),is_archive(member).into(),if member.directory {None}else{member.modified_at.map(|time|time.and_utc())}.into()])).await.c(h!())?;
    if !member.directory {
        let bytes = output.bytes.as_ref().c(h!())?;
        let key = output.object_key.as_ref().c(h!())?;
        ensure!(
            key.starts_with(&format!(
                "device-file-archive/{}/{}/",
                archive.id, archive.attempts
            )),
            "output namespace mismatch"
        );
        ensure!(
            bytes.size == member.size && bytes.crc32 == member.crc32,
            "output verification mismatch"
        );
        tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "insert into file_content(file_id,revision,origin_archive_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp())",
                vec![id.into(),archive.source_revision.into(),archive.id.into(),key.clone().into(),(bytes.size as i64).into(),bytes.sha256.to_vec().into(),output.encrypted.into()])).await.c(h!())?;
    }
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update file_entry set revision=$2,sync_id=$3,mime_type=$4,extension=$5,is_archive=$6,content_path=$7,file_metadata_modified_at=$8,updated_at=clock_timestamp() where id=$1 and revision<=$2",
            vec![id.into(),archive.source_revision.into(),sync.into(),mime.into(),extension.into(),is_archive(member).into(),output.object_key.clone().into(),if member.directory {None}else{member.modified_at}.into()])).await.c(h!())?;
    Ok((id, row.try_get("", "hierarchy_path").c(h!())?))
}

async fn finish(
    tx: &DatabaseTransaction,
    archive: &file_archive::Model,
    attempt: &Attempt,
) -> Result<()> {
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set state='ready',heartbeat_at=null,updated_at=clock_timestamp() where id=$1 and run_id=$2 and state='running'",[archive.id.into(),attempt.run_id.into()])).await.c(h!())?;
    let nested = tx.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select id from file_revision where origin_archive_id=$1 and is_archive",[archive.id.into()])).await.c(h!())?;
    for row in nested {
        enqueue::ensure_in(
            tx,
            archive.device_id,
            row.try_get("", "id").c(h!())?,
            archive.source_revision,
        )
        .await
        .context(h!())?;
    }
    Ok(())
}

fn is_archive(member: &Member) -> bool {
    !member.directory
        && super::super::preview::is_archive(&member.path, None, None)
}
