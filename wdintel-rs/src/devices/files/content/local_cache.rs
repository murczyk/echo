use std::future::Future;
use std::time::Duration;

use anyhow::{ensure, Result};
use sea_orm::EntityTrait;
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt, Take};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::{repository::Upload, LockedSpool};
use crate::devices::config::DEVICE_FILE_CONTENT_CACHE_TIMEOUT_SECS;
use crate::file_registry::entities::file_content;
use crate::h;
use crate::messenger::media_local_cache;
use crate::types::{warn, Env, ShortContext};

#[cfg(test)]
#[path = "local_cache_test_support.rs"]
pub(in crate::devices) mod test_support;

pub(super) async fn retain_upload_best_effort(
    env: &Env,
    upload: &Upload,
    spool: &LockedSpool,
) {
    let _ = attempt("capture", async {
        let config = media_local_cache::configured_config_best_effort(
            &env.config,
            &env.dbx,
        )
        .await;
        if !media_local_cache::enabled(&config) {
            return Ok(());
        }
        let content =
            file_content::Entity::find_by_id((upload.file_id, upload.revision))
                .one(env.file_registry_db().c(h!())?.connection())
                .await
                .c(h!())?
                .c(h!())?;
        ensure!(
            content.upload_id == Some(upload.id)
                && content.object_key == upload.object_key
                && content.source_size_bytes as u64 == upload.upload_length
                && content.source_sha256 == upload.expected_sha256,
            "retained upload does not match published content"
        );
        media_local_cache::retain_object_best_effort(
            &config,
            &content.object_key,
            content.source_size_bytes,
            content.is_encrypted,
            spool.source_path(),
            content.created_at.timestamp(),
        )
        .await;
        Ok(())
    })
    .await;
}

pub(super) async fn pin_revision_best_effort(
    env: &Env,
    file_id: Uuid,
    revision: i64,
) {
    let _ = attempt("pin", async {
        let config = media_local_cache::configured_config_best_effort(
            &env.config,
            &env.dbx,
        )
        .await;
        if !media_local_cache::enabled(&config) {
            return Ok(());
        }
        let content = file_content::Entity::find_by_id((file_id, revision))
            .one(env.file_registry_db().c(h!())?.connection())
            .await
            .c(h!())?
            .c(h!())?;
        media_local_cache::pin_object(
            &config,
            &content.object_key,
            u64::try_from(content.source_size_bytes).c(h!())?,
            content.is_encrypted,
            content.created_at.timestamp(),
        )
        .await
        .c(h!())
    })
    .await;
}

pub(super) async fn open(
    env: &Env,
    key: &str,
    size: u64,
    encrypted: bool,
    offset: u64,
) -> Option<File> {
    attempt("open", open_retained(env, key, size, encrypted, offset))
        .await
        .flatten()
}

async fn open_retained(
    env: &Env,
    key: &str,
    size: u64,
    encrypted: bool,
    offset: u64,
) -> Result<Option<File>> {
    let config =
        media_local_cache::configured_config_best_effort(&env.config, &env.dbx)
            .await;
    let Some(path) =
        media_local_cache::ready_object(&config, key, size, encrypted)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
        .c(h!())?;
    let metadata = file.metadata().await.c(h!())?;
    ensure!(
        metadata.is_file() && metadata.len() == size,
        "retained content size mismatch"
    );
    if offset != 0 {
        file.seek(std::io::SeekFrom::Start(offset)).await.c(h!())?;
    }
    Ok(Some(file))
}

pub(in crate::devices) async fn read_bytes(
    env: &Env,
    key: &str,
    size: u64,
    encrypted: bool,
) -> Option<Vec<u8>> {
    attempt("read", async {
        let Some(file) =
            open_retained(env, key, size, encrypted, 0).await.c(h!())?
        else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(size.saturating_add(1))
            .read_to_end(&mut bytes)
            .await
            .c(h!())?;
        ensure!(bytes.len() as u64 == size, "retained content size mismatch");
        Ok(Some(bytes))
    })
    .await
    .flatten()
}

pub(super) fn stream(file: File, length: u64) -> ReaderStream<Take<File>> {
    ReaderStream::new(file.take(length))
}

async fn attempt<T>(
    operation: &'static str,
    future: impl Future<Output = Result<T>>,
) -> Option<T> {
    match tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_CONTENT_CACHE_TIMEOUT_SECS),
        future,
    )
    .await
    {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            warn!("device content retention degraded operation={operation}: {error:#}");
            None
        }
        Err(_) => {
            warn!("device content retention timed out operation={operation}");
            None
        }
    }
}
