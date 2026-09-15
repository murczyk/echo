use anyhow::{ensure, Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend,
    FromQueryResult, Statement, TransactionTrait,
};
use uuid::Uuid;

use super::{ReuseReceipt, ReuseRequest};
use crate::config::DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS;
use crate::devices::files::content::protocol::ContentError;
use crate::h;

#[derive(FromQueryResult)]
struct Target {
    device_id: Uuid,
    kind: String,
    revision: Option<i64>,
}

#[derive(FromQueryResult)]
struct Source {
    revision: i64,
    status: String,
    verified: bool,
    size: i64,
    sha256: String,
}

#[derive(FromQueryResult)]
struct Binding {
    upload_id: Uuid,
    size: i64,
    sha256: String,
}

pub(super) async fn require_schema(
    db: &DatabaseConnection,
) -> Result<(), ContentError> {
    let row = db.query_one_raw(Statement::from_string(DbBackend::Postgres,
        "select exists(select 1 from pg_catalog.pg_constraint where conrelid = to_regclass('public.file_content') and conname = 'file_content_verified_upload_binding_fk') as ready"))
        .await.context(h!()).map_err(unavailable)?;
    let ready = row
        .context(h!())
        .and_then(|row| row.try_get::<bool>("", "ready").context(h!()))
        .map_err(unavailable)?;
    if !ready {
        return Err(ContentError::unavailable(
            "content_reuse_unavailable",
            DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
        ));
    }
    Ok(())
}

pub(super) async fn reuse(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    request: &ReuseRequest,
) -> Result<ReuseReceipt, ContentError> {
    require_schema(db).await?;
    let tx = db.begin().await.context(h!()).map_err(unavailable)?;
    let receipt = reuse_in(&tx, device_id, file_id, revision, request).await?;
    tx.commit().await.context(h!()).map_err(|_| {
        ContentError::unavailable(
            "publication_outcome_unknown",
            DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
        )
    })?;
    Ok(receipt)
}

async fn reuse_in(
    tx: &DatabaseTransaction,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    request: &ReuseRequest,
) -> Result<ReuseReceipt, ContentError> {
    let target = Target::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select device_id, kind::text as kind, revision from file_entry where id=$1 for update",
        [file_id.into()]))
        .one(tx).await.context(h!()).map_err(unavailable)?
        .filter(|target| target.device_id == device_id && target.kind == "file")
        .ok_or_else(ContentError::not_found)?;
    let source =
        load_source(tx, device_id, file_id, request.source_upload_id).await?;
    if source.status != "completed" || !source.verified {
        return Err(ContentError::conflict("content_not_verified"));
    }
    if source.size as u64 != request.expected_size
        || source.sha256 != request.expected_sha256
    {
        return Err(ContentError::conflict("content_identity_mismatch"));
    }
    if source.revision >= revision {
        return Err(ContentError::conflict("invalid_source_revision"));
    }
    let receipt = ReuseReceipt {
        status: "reused",
        device_id,
        file_id,
        revision,
        source_upload_id: request.source_upload_id,
        source_revision: source.revision,
        size: request.expected_size,
        sha256: source.sha256,
    };
    if let Some(binding) = load_binding(tx, file_id, revision).await? {
        if binding.upload_id == request.source_upload_id
            && binding.size as u64 == request.expected_size
            && binding.sha256 == request.expected_sha256
        {
            return Ok(receipt);
        }
        return Err(ContentError::conflict("content_already_committed"));
    }
    if target.revision != Some(revision) {
        return Err(ContentError::conflict("revision_stale"));
    }
    let open = tx.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select id from file_content_upload where file_id=$1 and revision=$2 and status='open' limit 1",
        [file_id.into(), revision.into()]))
        .await.context(h!()).map_err(unavailable)?;
    if open.is_some() {
        return Err(ContentError::conflict("upload_in_progress"));
    }
    bind(tx, file_id, revision, request.source_upload_id)
        .await
        .map_err(unavailable)?;
    Ok(receipt)
}

async fn load_source(
    tx: &DatabaseTransaction,
    device_id: Uuid,
    file_id: Uuid,
    upload_id: Uuid,
) -> Result<Source, ContentError> {
    Source::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select u.revision, u.status::text as status, c.upload_id is not null as verified,
                u.upload_length as size, encode(u.expected_sha256,'hex') as sha256
         from file_content_upload u
         left join file_content c on c.file_id=u.file_id and c.revision=u.revision and c.upload_id=u.id
         where u.id=$1 and u.device_id=$2 and u.file_id=$3",
        [upload_id.into(), device_id.into(), file_id.into()]))
        .one(tx).await.context(h!()).map_err(unavailable)?
        .ok_or_else(ContentError::not_found)
}

async fn load_binding(
    tx: &DatabaseTransaction,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Binding>, ContentError> {
    Binding::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select upload_id, source_size_bytes as size, encode(source_sha256,'hex') as sha256 from file_content where file_id=$1 and revision=$2",
        [file_id.into(), revision.into()]))
        .one(tx).await.context(h!()).map_err(unavailable)
}

async fn bind(
    tx: &DatabaseTransaction,
    file_id: Uuid,
    revision: i64,
    upload_id: Uuid,
) -> Result<()> {
    let inserted = tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into file_content (file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at)
         select c.file_id,$2,c.upload_id,c.object_key,c.source_size_bytes,c.source_sha256,c.is_encrypted,clock_timestamp()
         from file_content c join file_content_upload u on u.id=c.upload_id
         where c.file_id=$1 and c.revision=u.revision and u.id=$3 and u.status='completed'",
        [file_id.into(), revision.into(), upload_id.into()]))
        .await.context(h!())?;
    ensure!(
        inserted.rows_affected() == 1,
        "verified source content missing"
    );
    let updated = tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_entry e set content_path=c.object_key from file_content c where e.id=$1 and e.revision=$2 and c.file_id=e.id and c.revision=e.revision",
        [file_id.into(), revision.into()]))
        .await.context(h!())?;
    ensure!(updated.rows_affected() == 1, "content reuse target changed");
    Ok(())
}

fn unavailable(error: anyhow::Error) -> ContentError {
    super::super::repository_unavailable(error.context(h!()))
}
