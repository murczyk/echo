use super::{cleanup, job::Processor, repository};
use crate::{
    devices::config::*,
    h,
    types::{Env, ShortContext},
};
use anyhow::{Context, Result};
use base64::Engine;
use sqlx::Row;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) async fn run_nofail(env: Arc<Env>, cancel: CancellationToken) {
    let mut tick = tokio::time::interval(Duration::from_secs(
        DEVICE_FILE_ARCHIVE_HEARTBEAT_SECONDS,
    ));
    loop {
        tokio::select! {_=cancel.cancelled()=>return,_=tick.tick()=>{}}
        if let Err(error) = run(&env, &cancel).await {
            crate::types::warn!("Archive worker: {error:#}");
        }
    }
}

async fn run(env: &Env, cancel: &CancellationToken) -> Result<()> {
    let db = env.file_registry_db().c(h!())?.connection();
    let mut connection = db
        .get_postgres_connection_pool()
        .acquire()
        .await
        .c(h!())?
        .detach();
    let locked: bool =
        sqlx::query("select pg_try_advisory_lock(3778,1) as locked")
            .fetch_one(&mut connection)
            .await
            .c(h!())?
            .try_get("locked")
            .c(h!())?;
    if !locked {
        return Ok(());
    }
    let mut storage = env.s3_config.clone().c(h!())?;
    storage.prefix.clear();
    let key = base64::engine::general_purpose::STANDARD
        .decode(&env.config.s3_config.as_ref().c(h!())?.strongbox_key)
        .c(h!())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid archive encryption key"))?;
    let processor = Processor { storage, key };
    let root = std::path::Path::new(&env.config.storage_dir)
        .join("device-file-archive");
    tokio::fs::create_dir_all(&root).await.c(h!())?;
    anyhow::ensure!(
        tokio::fs::symlink_metadata(&root)
            .await
            .c(h!())?
            .file_type()
            .is_dir(),
        "archive scratch root must be a directory"
    );
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
        .await
        .c(h!())?;
    repository::recover(db).await.context(h!())?;
    let mut tick = tokio::time::interval(Duration::from_millis(
        DEVICE_FILE_ARCHIVE_POLL_MILLIS,
    ));
    loop {
        tokio::select! {_=cancel.cancelled()=>return Ok(()),_=tick.tick()=>{}}
        sqlx::query("select 1")
            .execute(&mut connection)
            .await
            .c(h!())?;
        let cleanup = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = cleanup::sweep(db, &processor.storage, &root) => result,
        };
        if let Err(error) = cleanup {
            crate::types::warn!("Archive cleanup: {error:#}");
        }
        if fs2::available_space(&root).c(h!())?
            < DEVICE_FILE_ARCHIVE_FREE_FLOOR_BYTES
        {
            continue;
        }
        let Some((attempt, archive)) =
            repository::claim(db).await.context(h!())?
        else {
            continue;
        };
        let scratch = root.join(attempt.run_id.to_string());
        let result = processor
            .run(db, &mut connection, &attempt, &archive, &scratch, cancel)
            .await;
        if let Err(error) = result {
            repository::fail(db, &attempt, &error).await.context(h!())?;
        }
        let _ = tokio::fs::remove_dir_all(scratch).await;
    }
}

pub(super) fn configured(env: &Env) -> bool {
    env.s3_config.is_some()
        && env.config.s3_config.as_ref().is_some_and(|config| {
            base64::engine::general_purpose::STANDARD
                .decode(&config.strongbox_key)
                .is_ok_and(|key| key.len() == 32)
        })
}
