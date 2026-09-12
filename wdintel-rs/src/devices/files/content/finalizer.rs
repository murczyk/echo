use std::sync::Arc;

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use super::protocol::ContentError;
use super::repository::{
    self, CompletedContent, PublishOutcome, RevalidateOutcome, Upload,
    UploadStatus,
};
use super::{DeviceFileContentRuntime, LockedSpool};
use crate::config::{
    DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
    DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES,
    DEVICE_FILE_CONTENT_FINALIZATION_WAIT_MILLIS,
    DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
};
use crate::h;
use crate::types::{warn, Env};

pub(crate) async fn acquire_permit(
    runtime: &DeviceFileContentRuntime,
) -> Result<Arc<tokio::sync::OwnedSemaphorePermit>, ContentError> {
    if let Ok(permit) = runtime.finalization_permits.clone().try_acquire_owned()
    {
        return Ok(Arc::new(permit));
    }
    let _waiting = runtime
        .finalization_waiters
        .clone()
        .try_acquire_owned()
        .map_err(|_| finalization_busy())?;
    tokio::time::timeout(
        std::time::Duration::from_millis(
            DEVICE_FILE_CONTENT_FINALIZATION_WAIT_MILLIS,
        ),
        runtime.finalization_permits.clone().acquire_owned(),
    )
    .await
    .map_err(|_| finalization_busy())?
    .map(Arc::new)
    .map_err(|_| finalization_busy())
}

fn finalization_busy() -> ContentError {
    ContentError::unavailable(
        "finalization_busy",
        DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
    )
}

pub(crate) async fn finalize(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    login_id: Uuid,
    upload: Upload,
    spool: &LockedSpool,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<CompletedContent, ContentError> {
    let offset = match spool.offset() {
        Ok(offset) => offset,
        Err(error) => {
            return refresh_retryable_upload(
                runtime,
                &upload,
                spool_unavailable(error.context(h!())),
            )
            .await;
        }
    };
    if offset != upload.upload_length {
        return Err(ContentError::conflict("upload_incomplete"));
    }

    let probe = match read_probe(runtime, spool, &upload).await {
        Ok(probe) => probe,
        Err(error) if error.is_unavailable() => {
            drop(permit);
            return refresh_retryable_upload(runtime, &upload, error).await;
        }
        Err(error) => return Err(error),
    };
    let encrypt = upload.upload_length
        <= DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES
        && !crate::messenger::media::device_content_probe_is_excluded_video(
            &probe,
        );
    let upload_result = if encrypt {
        upload_encrypted(runtime, spool, &upload, permit.clone()).await
    } else {
        upload_plaintext(runtime, spool, &upload).await
    };
    if let Err(error) = upload_result {
        drop(permit);
        return handle_storage_failure(runtime, &upload, error).await;
    }

    if let Err(error) = crate::devices::access::authorize_file_sync_snapshot(
        &env.dbx,
        &login_id,
        upload.device_id,
    )
    .await
    {
        safe_delete_object(runtime, &upload).await;
        return Err(ContentError::from_app(error));
    }

    let now = Utc::now().fixed_offset();
    let publish = match repository::publish(
        runtime.file_registry_db.connection(),
        &upload,
        encrypt,
        now,
        runtime.metrics.as_ref(),
    )
    .await
    {
        Ok(publish) => publish,
        Err(error) => {
            warn!("device content publication failed: {error:#?}");
            record_failure(runtime);
            drop(permit);
            safe_delete_object(runtime, &upload).await;
            return refresh_retryable_upload(
                runtime,
                &upload,
                ContentError::unavailable(
                    "file_registry_unavailable",
                    DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
                ),
            )
            .await;
        }
    };
    let completed = match publish {
        PublishOutcome::Completed(completed) => completed,
        PublishOutcome::Terminal(status) => {
            drop(permit);
            safe_delete_object(runtime, &upload).await;
            return Err(terminal_error(status));
        }
        PublishOutcome::ContentAlreadyCommitted => {
            drop(permit);
            safe_delete_object(runtime, &upload).await;
            return Err(ContentError::conflict("content_already_committed"));
        }
        PublishOutcome::Missing => {
            drop(permit);
            safe_delete_object(runtime, &upload).await;
            return Err(ContentError::not_found());
        }
        PublishOutcome::UnknownCommit(error) => {
            warn!("unknown device content publication outcome: {error:#?}");
            match repository::reconcile_publication(
                runtime.file_registry_db.connection(),
                upload.id,
            )
            .await
            {
                Ok(Some(completed)) => {
                    if let Some(metrics) = &runtime.metrics {
                        metrics
                            .record_device_file_content_terminal("completed");
                    }
                    completed
                }
                Ok(None) => {
                    drop(permit);
                    return refresh_retryable_upload(
                        runtime,
                        &upload,
                        ContentError::unavailable(
                            "publication_outcome_unknown",
                            DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
                        ),
                    )
                    .await;
                }
                Err(error) => {
                    drop(permit);
                    warn!("failed to reconcile device content publication: {error:#?}");
                    return Err(ContentError::unavailable(
                        "publication_outcome_unknown",
                        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
                    ));
                }
            }
        }
    };
    drop(permit);
    cleanup_completed(runtime, spool, &upload).await;
    Ok(completed)
}

async fn read_probe(
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    upload: &Upload,
) -> Result<Vec<u8>, ContentError> {
    let Some(file) = spool
        .open_source()
        .map_err(|error| spool_unavailable(error.context(h!())))?
    else {
        return if upload.upload_length == 0 {
            Ok(Vec::new())
        } else {
            Err(ContentError::conflict("upload_incomplete"))
        };
    };
    let probe_len = runtime
        .config
        .probe_size_bytes
        .min(usize::try_from(upload.upload_length).unwrap_or(usize::MAX));
    let mut probe = Vec::with_capacity(probe_len);
    file.take(u64::try_from(probe_len).unwrap_or(upload.upload_length))
        .read_to_end(&mut probe)
        .await
        .map_err(|error| {
            spool_unavailable(
                anyhow::Error::new(error)
                    .context("read content probe")
                    .context(h!()),
            )
        })?;
    Ok(probe)
}

async fn upload_encrypted(
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    upload: &Upload,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<(), StorageFailure> {
    let mut data = Vec::with_capacity(
        usize::try_from(upload.upload_length).map_err(|error| {
            StorageFailure::Internal(anyhow::Error::new(error).context(h!()))
        })?,
    );
    if let Some(file) = spool
        .open_source()
        .map_err(|error| StorageFailure::Internal(error.context(h!())))?
    {
        file.take(upload.upload_length.saturating_add(1))
            .read_to_end(&mut data)
            .await
            .map_err(|error| {
                StorageFailure::Internal(
                    anyhow::Error::new(error).context(h!()),
                )
            })?;
    }
    if u64::try_from(data.len()).ok() != Some(upload.upload_length) {
        return Err(StorageFailure::Sha256Mismatch);
    }
    let hashing_permit = permit.clone();
    let (data, digest) = tokio::task::spawn_blocking(move || {
        let _permit = hashing_permit;
        let digest: [u8; 32] = Sha256::digest(&data).into();
        (data, digest)
    })
    .await
    .map_err(|error| {
        StorageFailure::Internal(anyhow::Error::new(error).context(h!()))
    })?;
    if digest != upload.expected_sha256 {
        return Err(StorageFailure::Sha256Mismatch);
    }
    crate::storage::upload_device_content_encrypted(
        &runtime.storage,
        &runtime.storage_config,
        &runtime.strongbox_key,
        &upload.object_key,
        data.into(),
        Some(permit),
    )
    .await
    .map_err(|error| {
        StorageFailure::Internal(anyhow::Error::new(error).context(h!()))
    })
}

async fn upload_plaintext(
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    upload: &Upload,
) -> Result<(), StorageFailure> {
    let file = spool
        .open_source()
        .map_err(|error| StorageFailure::Internal(error.context(h!())))?
        .ok_or(StorageFailure::SourceMissing)?;
    crate::storage::upload_device_content_plaintext(
        &runtime.storage,
        &runtime.storage_config,
        &upload.object_key,
        file,
        upload.upload_length,
        &upload.expected_sha256,
    )
    .await
    .map_err(|error| match error {
        crate::storage::DeviceContentUploadError::Sha256Mismatch => {
            StorageFailure::Sha256Mismatch
        }
        crate::storage::DeviceContentUploadError::Internal(error) => {
            StorageFailure::Internal(anyhow::Error::new(error).context(h!()))
        }
    })
}

async fn handle_storage_failure(
    runtime: &DeviceFileContentRuntime,
    upload: &Upload,
    error: StorageFailure,
) -> Result<CompletedContent, ContentError> {
    match error {
        StorageFailure::Sha256Mismatch => {
            match repository::transition_open(
                runtime.file_registry_db.connection(),
                upload,
                UploadStatus::Rejected,
                Utc::now().fixed_offset(),
                runtime.metrics.as_ref(),
            )
            .await
            .map_err(|error| repository_unavailable(error.context(h!())))?
            {
                RevalidateOutcome::Terminal(UploadStatus::Rejected) => {
                    Err(ContentError::unprocessable("sha256_mismatch"))
                }
                RevalidateOutcome::Terminal(status) => {
                    Err(terminal_error(status))
                }
                RevalidateOutcome::Completed(content) => Ok(content),
                RevalidateOutcome::ContentAlreadyCommitted => {
                    Err(ContentError::conflict("content_already_committed"))
                }
                RevalidateOutcome::Missing => Err(ContentError::not_found()),
                RevalidateOutcome::Open(_) => {
                    unreachable!("transition returned open")
                }
            }
        }
        StorageFailure::SourceMissing => {
            Err(ContentError::conflict("upload_incomplete"))
        }
        StorageFailure::Internal(error) => {
            warn!("device content storage failed: {error:#?}");
            record_failure(runtime);
            match repository::refresh_open(
                runtime.file_registry_db.connection(),
                upload,
                Utc::now().fixed_offset(),
                false,
                &runtime.config,
                runtime.metrics.as_ref(),
            )
            .await
            {
                Ok(RevalidateOutcome::Terminal(status)) => {
                    Err(terminal_error(status))
                }
                Ok(RevalidateOutcome::Completed(content)) => Ok(content),
                Ok(RevalidateOutcome::ContentAlreadyCommitted) => {
                    Err(ContentError::conflict("content_already_committed"))
                }
                Ok(RevalidateOutcome::Missing) => {
                    Err(ContentError::not_found())
                }
                Ok(RevalidateOutcome::Open(_)) | Err(_) => {
                    Err(ContentError::unavailable(
                        "storage_unavailable",
                        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
                    ))
                }
            }
        }
    }
}

pub(super) async fn refresh_retryable_upload(
    runtime: &DeviceFileContentRuntime,
    upload: &Upload,
    fallback: ContentError,
) -> Result<CompletedContent, ContentError> {
    match repository::refresh_open(
        runtime.file_registry_db.connection(),
        upload,
        Utc::now().fixed_offset(),
        false,
        &runtime.config,
        runtime.metrics.as_ref(),
    )
    .await
    {
        Ok(RevalidateOutcome::Open(_)) => Err(fallback),
        Ok(RevalidateOutcome::Terminal(status)) => Err(terminal_error(status)),
        Ok(RevalidateOutcome::Completed(content)) => Ok(content),
        Ok(RevalidateOutcome::ContentAlreadyCommitted) => {
            Err(ContentError::conflict("content_already_committed"))
        }
        Ok(RevalidateOutcome::Missing) => Err(ContentError::not_found()),
        Err(error) => {
            warn!(
                "failed to refresh retryable device content upload: {error:#?}"
            );
            Err(fallback)
        }
    }
}

fn record_failure(runtime: &DeviceFileContentRuntime) {
    if let Some(metrics) = &runtime.metrics {
        metrics.record_device_file_content_failure("finalization");
    }
}

async fn cleanup_completed(
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    upload: &Upload,
) {
    if let Err(error) = spool.remove_local().await {
        warn!("failed to remove completed device content spool: {error:#?}");
        return;
    }
    if let Err(error) = repository::mark_spool_removed(
        runtime.file_registry_db.connection(),
        upload.id,
        Utc::now().fixed_offset(),
    )
    .await
    {
        warn!(
            "failed to mark completed device content spool removed: {error:#?}"
        );
    }
}

pub(crate) async fn safe_delete_object(
    runtime: &DeviceFileContentRuntime,
    upload: &Upload,
) {
    match repository::object_is_referenced(
        runtime.file_registry_db.connection(),
        &upload.object_key,
    )
    .await
    {
        Ok(false) => {
            if let Err(error) = crate::storage::delete_device_content_object(
                &runtime.storage,
                &upload.object_key,
            )
            .await
            {
                warn!("failed to remove unreferenced device content object: {error:#?}");
            }
        }
        Ok(true) => {}
        Err(error) => {
            warn!("could not prove device content object unreferenced: {error:#?}");
        }
    }
}

fn terminal_error(status: UploadStatus) -> ContentError {
    match status {
        UploadStatus::Completed => {
            ContentError::conflict("content_already_committed")
        }
        UploadStatus::Open => ContentError::unavailable(
            "temporarily_unavailable",
            DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
        ),
        status => ContentError::gone(status.code()),
    }
}

fn repository_unavailable(error: anyhow::Error) -> ContentError {
    warn!("device content repository failed: {error:#?}");
    ContentError::unavailable(
        "file_registry_unavailable",
        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
    )
}

fn spool_unavailable(error: anyhow::Error) -> ContentError {
    warn!("device content spool failed: {error:#?}");
    ContentError::unavailable(
        "spool_unavailable",
        DEVICE_FILE_CONTENT_STORAGE_RETRY_AFTER_SECS,
    )
}

#[derive(Debug)]
enum StorageFailure {
    Sha256Mismatch,
    SourceMissing,
    Internal(anyhow::Error),
}
