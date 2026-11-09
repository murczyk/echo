use super::{access, policy::Policy};
use crate::{h, types::ShortContext};
use anyhow::{Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, FromQueryResult, Statement,
    TransactionTrait,
};
use uuid::Uuid;

mod connection;

pub(in crate::devices::files) use connection::SqlxConnection;

pub(in crate::devices::files) async fn ensure_sqlx_in(
    transaction: &mut sqlx::PgConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Uuid>> {
    let connection = SqlxConnection(tokio::sync::Mutex::new(transaction));
    ensure_in(&connection, device_id, file_id, revision)
        .await
        .context(h!())
}

pub(super) async fn ensure(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Uuid>> {
    let tx = db.begin().await.c(h!())?;
    let archive = ensure_in(&tx, device_id, file_id, revision)
        .await
        .context(h!())?;
    tx.commit().await.c(h!())?;
    Ok(archive)
}

pub(in crate::devices::files) async fn ensure_in(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Uuid>> {
    if let Some(id) = existing(db, device_id, file_id, revision)
        .await
        .context(h!())?
    {
        return Ok(Some(id));
    }
    let Some(source) =
        access::find_published_content(db, device_id, file_id, revision)
            .await
            .context(h!())?
    else {
        return Ok(None);
    };
    if !super::super::preview::is_archive(
        &source.name,
        source.extension.as_deref(),
        source.mime_type.as_deref(),
    ) {
        return Ok(None);
    }
    let parent=Parent::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select a.id,a.root_id,a.depth,a.policy from file_revision r join file_archive a on a.id=r.origin_archive_id where r.id=$1 and r.revision=$2 and r.device_id=$3",
        [file_id.into(),revision.into(),device_id.into()])).one(db).await.c(h!())?;
    let policy = parent
        .as_ref()
        .map(|parent| parent.policy.clone())
        .unwrap_or(serde_json::to_value(Policy::default()).c(h!())?);
    let limits: Policy = serde_json::from_value(policy.clone()).c(h!())?;
    let id = Uuid::new_v4();
    let depth = parent.as_ref().map(|parent| parent.depth + 1).unwrap_or(1);
    let root = parent.as_ref().map(|parent| parent.root_id).unwrap_or(id);
    let too_large = source.source_size_bytes as u64 > limits.source_bytes;
    let too_deep = depth as u64 > limits.max_depth;
    let reason = if too_deep {
        Some("safety_limit")
    } else if too_large {
        Some("source_too_large")
    } else {
        None
    };
    let limit = too_deep.then_some("depth");
    let inserted=db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into file_archive(id,device_id,source_file_id,source_revision,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,root_id,parent_id,depth,policy,state,error_code,exhausted_limit) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict(device_id,source_file_id,source_revision) do nothing returning id",
        vec![id.into(),device_id.into(),file_id.into(),revision.into(),source.object_key.into(),source.source_sha256.into(),source.source_size_bytes.into(),source.is_encrypted.into(),root.into(),parent.as_ref().map(|parent|parent.id).into(),depth.into(),policy.into(),if reason.is_some(){"failed"}else{"queued"}.into(),reason.into(),limit.into()])).await.c(h!())?;
    if inserted.is_none() {
        return existing(db, device_id, file_id, revision)
            .await
            .context(h!());
    }
    Ok(Some(id))
}

#[derive(FromQueryResult)]
struct Parent {
    id: Uuid,
    root_id: Uuid,
    depth: i64,
    policy: serde_json::Value,
}

async fn existing(
    db: &impl ConnectionTrait,
    device: Uuid,
    file: Uuid,
    revision: i64,
) -> Result<Option<Uuid>> {
    db.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select id from file_archive where device_id=$1 and source_file_id=$2 and source_revision=$3",
        [device.into(),file.into(),revision.into()])).await.c(h!())?
        .map(|row|row.try_get("","id").c(h!())).transpose()
}
