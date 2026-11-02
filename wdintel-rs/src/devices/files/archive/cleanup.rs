use crate::{devices::config::*, h, storage::S3Config, types::ShortContext};
use anyhow::Result;
use futures_util::TryStreamExt;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use std::path::Path;

pub(super) async fn sweep(
    db: &DatabaseConnection,
    config: &S3Config,
    scratch: &Path,
) -> Result<()> {
    // The budget bounds the S3 pass only; unfinished rows resume next tick.
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(
            DEVICE_FILE_ARCHIVE_CLEANUP_BUDGET_SECONDS,
        );
    let storage = crate::storage::build_s3_operator(config).c(h!())?;
    let client = super::storage::Client::new(config).c(h!())?;
    let rows=db.query_all_raw(Statement::from_string(DbBackend::Postgres,
        "select id,state,attempts from file_archive where state<>'running' and next_cleanup_at<=clock_timestamp() and updated_at<clock_timestamp()-interval '120 seconds' order by next_cleanup_at,id limit 64")).await.c(h!())?;
    for row in rows {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let id: uuid::Uuid = row.try_get("", "id").c(h!())?;
        let state: String = row.try_get("", "state").c(h!())?;
        let attempt: i64 = row.try_get("", "attempts").c(h!())?;
        db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            "update file_archive set next_cleanup_at=clock_timestamp()+interval '120 seconds' where id=$1",[id.into()])).await.c(h!())?;
        let Ok(result) = tokio::time::timeout_at(
            deadline,
            sweep_objects(db, &client, &storage, id, &state, attempt),
        )
        .await
        else {
            break;
        };
        if let Err(error) = result {
            crate::types::warn!("Archive cleanup {id}: {error:#}");
        }
    }
    let mut entries = tokio::fs::read_dir(scratch).await.c(h!())?;
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        if !entry.file_type().await.c(h!())?.is_dir()
            || uuid::Uuid::parse_str(&entry.file_name().to_string_lossy())
                .is_err()
        {
            continue;
        }
        let age = entry
            .metadata()
            .await
            .c(h!())?
            .modified()
            .c(h!())?
            .elapsed()
            .unwrap_or_default();
        if age.as_secs() < DEVICE_FILE_ARCHIVE_CLEANUP_QUIET_SECONDS {
            continue;
        }
        if let Ok(_lock) = super::helper::lock(&entry.path()) {
            tokio::fs::remove_dir_all(entry.path()).await.c(h!())?;
        }
    }
    Ok(())
}

async fn sweep_objects(
    db: &DatabaseConnection,
    client: &super::storage::Client,
    storage: &opendal::Operator,
    id: uuid::Uuid,
    state: &str,
    attempt: i64,
) -> Result<()> {
    let prefix = format!("device-file-archive/{id}/");
    for (key, upload) in client.unfinished(&prefix).await.c(h!())? {
        if removable(&key, &prefix, state, attempt) {
            client.abort(&key, &upload).await.c(h!())?;
        }
    }
    let mut entries =
        storage.lister_with(&prefix).recursive(true).await.c(h!())?;
    while let Some(entry) = entries.try_next().await.c(h!())? {
        if !entry.metadata().is_file() {
            continue;
        }
        if !removable(entry.path(), &prefix, state, attempt) {
            continue;
        }
        let used = db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select 1 from file_content where object_key=$1 limit 1",
                [entry.path().into()],
            ))
            .await
            .c(h!())?;
        if used.is_none() {
            client.delete(entry.path()).await.c(h!())?;
        }
    }
    Ok(())
}

fn removable(key: &str, prefix: &str, state: &str, attempt: i64) -> bool {
    key.strip_prefix(prefix)
        .and_then(|suffix| suffix.split('/').next())
        .and_then(|value| value.parse::<i64>().ok())
        .is_some_and(|owner| {
            owner > 0
                && owner <= attempt
                && (state != "ready" || owner < attempt)
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn stale_sweep_cannot_remove_new_attempt_or_ready_objects() {
        assert!(super::removable("job/1/object", "job/", "retry_wait", 1));
        assert!(!super::removable("job/2/object", "job/", "retry_wait", 1));
        assert!(!super::removable("job/2/object", "job/", "ready", 2));
        assert!(super::removable("job/1/object", "job/", "ready", 2));
        assert!(!super::removable("other/1/object", "job/", "failed", 1));
    }
}
