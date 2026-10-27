use crate::h;
use anyhow::{Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend,
    Statement, TransactionTrait,
};
use uuid::Uuid;

pub(crate) async fn lock_source(
    db: &DatabaseConnection,
    source: Uuid,
) -> Result<(DatabaseTransaction, String)> {
    let transaction = db.begin().await.context(h!())?;
    let key = transaction.query_one_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select source_key from transcription_source where id=$1 for update", [source.into()]))
        .await.context(h!())?.context("transcription source missing").context(h!())?.try_get("", "source_key").context(h!())?;
    Ok((transaction, key))
}

#[cfg(test)]
pub(crate) async fn request(
    db: &DatabaseConnection,
    files: Option<&DatabaseConnection>,
    source: Uuid,
    reason: &str,
    requested_by: Option<&str>,
) -> Result<i32> {
    Ok(coordinate(db, files, source, reason, requested_by, None)
        .await
        .context(h!())?
        .0)
}

pub(crate) async fn request_for_device(
    db: &DatabaseConnection,
    files: &DatabaseConnection,
    source: Uuid,
) -> Result<bool> {
    Ok(
        coordinate(
            db,
            Some(files),
            source,
            "device explicit retry",
            None,
            None,
        )
        .await
        .context(h!())?
        .1,
    )
}

pub(crate) async fn request_if_state(
    db: &DatabaseConnection,
    files: Option<&DatabaseConnection>,
    source: Uuid,
    expected_state: &str,
    reason: &str,
    requested_by: Option<&str>,
) -> Result<bool> {
    Ok(coordinate(
        db,
        files,
        source,
        reason,
        requested_by,
        Some(expected_state),
    )
    .await
    .context(h!())?
    .1)
}

async fn coordinate(
    db: &DatabaseConnection,
    files: Option<&DatabaseConnection>,
    source: Uuid,
    reason: &str,
    requested_by: Option<&str>,
    expected_state: Option<&str>,
) -> Result<(i32, bool)> {
    let (transaction, key) = lock_source(db, source).await.context(h!())?;
    let task = echo_gpu_client::lookup(&transaction, source)
        .await
        .context(h!())?
        .context("native transcription missing")
        .context(h!())?
        .0;
    if expected_state.is_some_and(|state| task.state != state) {
        return Ok((task.reprocess_count, false));
    }
    let final_state = matches!(task.state.as_str(), "terminal" | "completed");
    let mut target = if final_state {
        task.reprocess_count
            .checked_add(1)
            .context("reprocess counter overflow")
            .context(h!())?
    } else {
        task.reprocess_count
    };
    let mut started = final_state;
    if let Some(files) = files {
        let files = files.begin().await.context(h!())?;
        let rows = files.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "select automatic_transcription_pending as pending from device_audio where storage_key=$1 order by id for update", [key.clone().into()])).await.context(h!())?;
        let pending = rows
            .iter()
            .map(|row| row.try_get::<Option<i32>>("", "pending"))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context(h!())?
            .into_iter()
            .flatten()
            .max();
        if let Some(pending) = pending {
            target = pending.max(task.reprocess_count);
            started = false;
        }
        files.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update device_audio set automatic_transcription_pending=$2 where storage_key=$1", [key.into(),target.into()])).await.context(h!())?;
        files.commit().await.context(h!())?;
    }
    reset_to(&transaction, source, target, reason, requested_by)
        .await
        .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok((target, started))
}

pub(crate) async fn reset_to<C: ConnectionTrait>(
    db: &C,
    source: Uuid,
    target: i32,
    reason: &str,
    requested_by: Option<&str>,
) -> Result<()> {
    let task = echo_gpu_client::lookup(db, source)
        .await
        .context(h!())?
        .context("pending native transcription missing")
        .context(h!())?
        .0;
    if task.reprocess_count >= target {
        return Ok(());
    }
    anyhow::ensure!(
        task.reprocess_count.checked_add(1) == Some(target),
        "invalid pending native generation"
    );
    match task.state.as_str() {
        "terminal" => {
            echo_gpu_client::requeue_terminal(
                db,
                source,
                reason,
                requested_by.unwrap_or("echo"),
            )
            .await
            .context(h!())?;
        }
        "completed" => {
            echo_gpu_client::retranscribe_completed(
                db,
                source,
                reason,
                requested_by.unwrap_or("echo"),
            )
            .await
            .context(h!())?;
        }
        _ => (),
    }
    Ok(())
}
