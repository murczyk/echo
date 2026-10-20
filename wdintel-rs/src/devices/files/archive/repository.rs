use super::{manifest::Manifest, policy::Policy};
use crate::{
    devices::config::*, file_registry::entities::file_archive, h,
    types::ShortContext,
};
use anyhow::{ensure, Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, FromQueryResult, Statement,
    TransactionTrait,
};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub(super) struct Attempt {
    pub archive_id: Uuid,
    pub run_id: Uuid,
}

pub(super) async fn claim(
    db: &DatabaseConnection,
) -> Result<Option<(Attempt, file_archive::Model)>> {
    let run = Uuid::new_v4();
    let archive = file_archive::Model::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set state='running',attempts=attempts+1,run_id=$1,heartbeat_at=clock_timestamp(),first_started_at=coalesce(first_started_at,clock_timestamp()),deadline=coalesce(deadline,clock_timestamp()+make_interval(secs=>$2)),updated_at=clock_timestamp()
         where id=(select id from file_archive where state in ('queued','retry_wait') and not_before<=clock_timestamp() order by not_before,id for update skip locked limit 1) returning *",
        [run.into(),(DEVICE_FILE_ARCHIVE_RECOVERY_SECONDS as f64).into()])).one(db).await.c(h!())?;
    Ok(archive.map(|archive| {
        (
            Attempt {
                archive_id: archive.id,
                run_id: run,
            },
            archive,
        )
    }))
}

pub(super) async fn renew(
    db: &DatabaseConnection,
    attempt: &Attempt,
) -> Result<()> {
    let changed=db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set heartbeat_at=clock_timestamp() where id=$1 and run_id=$2 and state='running' and deadline>clock_timestamp()",
        [attempt.archive_id.into(),attempt.run_id.into()])).await.c(h!())?;
    ensure!(changed.rows_affected() == 1, "stale archive worker");
    Ok(())
}

pub(super) async fn admit(
    db: &DatabaseConnection,
    attempt: &Attempt,
    manifest: &Manifest,
) -> Result<()> {
    let tx = db.begin().await.c(h!())?;
    let archive=file_archive::Model::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select * from file_archive where id=$1 and run_id=$2 and state='running' for update",[attempt.archive_id.into(),attempt.run_id.into()])).one(&tx).await.c(h!())?.c(h!())?;
    if archive.budgeted_attempt == archive.attempts {
        return Ok(());
    }
    let policy: Policy =
        serde_json::from_value(archive.policy.clone()).c(h!())?;
    let bytes = manifest
        .members
        .iter()
        .try_fold(0u64, |n, m| n.checked_add(m.size).c(h!()))?;
    let nodes = manifest.members.len() as u64;
    let reserved=tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set expanded_bytes=expanded_bytes+$2,node_count=node_count+$3 where id=$1 and expanded_bytes+$2<=least($4,source_size_bytes::numeric*$5) and node_count+$3<=$6 and (deadline is null or deadline>clock_timestamp())",
        vec![archive.root_id.into(),(bytes as i64).into(),if archive.declared_nodes.is_none(){nodes as i64}else{0}.into(),(policy.expanded_bytes as i64).into(),(policy.root_ratio as i64).into(),(policy.manifest.nodes as i64).into()])).await.c(h!())?;
    super::error::require(
        reserved.rows_affected() == 1,
        super::error::Failure::Limit("root_budget"),
    )
    .context(h!())?;
    tx.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set declared_nodes=$2,budgeted_attempt=attempts where id=$1",[archive.id.into(),(nodes as i64).into()])).await.c(h!())?;
    tx.commit().await.c(h!())
}

pub(super) async fn fail(
    db: &DatabaseConnection,
    attempt: &Attempt,
    error: &anyhow::Error,
) -> Result<()> {
    let archive=file_archive::Model::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select * from file_archive where id=$1 and run_id=$2 and state='running'",[attempt.archive_id.into(),attempt.run_id.into()])).one(db).await.c(h!())?;
    let Some(archive) = archive else {
        return Ok(());
    };
    let policy: Policy = serde_json::from_value(archive.policy).c(h!())?;
    let (reason, limit) = super::error::classify(error);
    let delay = policy
        .retry_seconds
        .get(archive.attempts.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(0);
    let retry = reason.is_none()
        && archive.attempts < (policy.max_attempts as i64)
        && delay > 0
        && archive.deadline.is_some_and(|d| {
            d > chrono::Utc::now() + chrono::Duration::seconds(delay as i64)
        });
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_archive set state=$3,error_code=$4,exhausted_limit=$5,not_before=clock_timestamp()+make_interval(secs=>$6),heartbeat_at=null,updated_at=clock_timestamp() where id=$1 and run_id=$2 and state='running'",
        vec![attempt.archive_id.into(),attempt.run_id.into(),if retry{"retry_wait"}else{"failed"}.into(),if retry{None}else{Some(reason.unwrap_or("retry_exhausted"))}.into(),limit.into(),(delay as f64).into()])).await.c(h!())?;
    Ok(())
}

pub(super) async fn recover(db: &DatabaseConnection) -> Result<()> {
    let jobs = file_archive::Model::find_by_statement(Statement::from_string(
        DbBackend::Postgres,
        "select * from file_archive where state='running' order by id",
    ))
    .all(db)
    .await
    .c(h!())?;
    for job in jobs {
        fail(
            db,
            &Attempt {
                archive_id: job.id,
                run_id: job.run_id.c(h!())?,
            },
            &std::io::Error::from(std::io::ErrorKind::Interrupted).into(),
        )
        .await
        .context(h!())?;
    }
    db.execute_unprepared("update file_archive a set state='failed',error_code='retry_exhausted',updated_at=clock_timestamp() from file_archive root where a.root_id=root.id and a.state in ('queued','retry_wait') and root.deadline<=clock_timestamp()").await.c(h!())?;
    Ok(())
}
