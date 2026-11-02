use super::{aad, key_from_b64, PlaintextUploadWriter, S3Config};
use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::TryStreamExt;
use opendal::Operator;
use openssl::sha::{sha256, Sha256};
use sea_orm::DatabaseConnection;
use std::sync::Arc;
use std::time::Duration;
use strong_box::{StaticStrongBox, StrongBox};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use crate::devices::upload_finalization::{query, resources, types::*};
use crate::h;

#[derive(Clone)]
pub(crate) struct ManagedStorage {
    operator: Operator,
    config: S3Config,
    key: strong_box::Key,
}

#[derive(Clone, Debug)]
pub(crate) struct ManagedObject {
    pub attempt_id: Uuid,
    pub object_key: String,
    pub size: u64,
    pub sha256: [u8; 32],
    pub is_encrypted: bool,
}

pub(crate) enum ManagedPayload {
    Encrypted(Bytes),
    Plaintext(tokio::fs::File),
}

#[derive(Debug)]
pub(crate) enum ManagedWriteOutcome {
    Acknowledged,
    DefinitelyNotDispatched(anyhow::Error),
    PossiblyDispatched(anyhow::Error),
}

impl ManagedStorage {
    pub(crate) fn new(config: S3Config, key: &str) -> Result<Self> {
        anyhow::ensure!(
            config.prefix.is_empty(),
            "managed storage must be prefix-free"
        );
        let builder = super::s3_builder(&config).context(h!())?;
        // A transient 5xx on one part must not abort a multi-GB upload.
        let operator = Operator::new(builder)
            .context(h!())?
            .layer(super::s3_retry_layer())
            .finish();
        Ok(Self {
            operator,
            config,
            key: key_from_b64(key).context(h!())?,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        operator: Operator,
        config: S3Config,
        key: &str,
    ) -> Result<Self> {
        Ok(Self {
            operator,
            config,
            key: key_from_b64(key).context(h!())?,
        })
    }

    pub(crate) fn encrypt(
        &self,
        object: ManagedObject,
        plaintext: Bytes,
        guard: resources::ResourceGuard,
    ) -> resources::OwnedOperation<Result<Bytes>> {
        let key = self.key.clone();
        let object_aad = aad(&self.config.bucket, &object.object_key);
        resources::spawn_blocking_owned(guard, move || {
            anyhow::ensure!(object.is_encrypted && object.size <= crate::devices::config::DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES,
                "invalid managed encryption size or policy");
            anyhow::ensure!(
                plaintext.len() as u64 == object.size
                    && sha256(&plaintext) == object.sha256,
                FinalizationFailure::SourceDigestMismatch
            );
            let strongbox = StaticStrongBox::new(key.clone(), vec![key]);
            Ok(strongbox
                .encrypt(&plaintext, object_aad.as_bytes())
                .map_err(|_| anyhow::anyhow!("managed encryption failed"))
                .context(h!())?
                .into())
        })
    }

    pub(crate) fn dispatch(
        self: Arc<Self>,
        db: DatabaseConnection,
        claim: ClaimedFinalizationJob,
        object: ManagedObject,
        payload: ManagedPayload,
        guard: resources::ResourceGuard,
        limit: u32,
        timeout: Duration,
    ) -> resources::OwnedOperation<ManagedWriteOutcome> {
        let write_guard = guard.clone();
        resources::spawn_owned(guard, async move {
            if let Err(error) = validate_attempt(&db, &claim, &object).await {
                return ManagedWriteOutcome::DefinitelyNotDispatched(error);
            }
            match query::record_write_intent(
                &db,
                &claim,
                object.attempt_id,
                limit,
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => {
                    return ManagedWriteOutcome::DefinitelyNotDispatched(
                        FinalizationFailure::StaleClaim.into(),
                    )
                }
                Err(error) => {
                    retain_not_dispatched(&db, &claim, object.attempt_id).await;
                    return ManagedWriteOutcome::DefinitelyNotDispatched(error);
                }
            }
            crate::devices::upload_finalization::fault::point(
                "write_intent",
                claim.job_id,
            )
            .await;
            let result = tokio::time::timeout(
                timeout,
                self.write_once(&object, payload, write_guard),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    crate::devices::upload_finalization::fault::point(
                        "storage_written",
                        claim.job_id,
                    )
                    .await;
                    if let Err(error) = query::record_write_resolution(
                        &db,
                        &claim,
                        object.attempt_id,
                        WriteResolution::Acknowledged,
                    )
                    .await
                    {
                        return ManagedWriteOutcome::PossiblyDispatched(error);
                    }
                    if let Err(error) =
                        query::release_write_credit(&db, object.attempt_id)
                            .await
                    {
                        return ManagedWriteOutcome::PossiblyDispatched(error);
                    }
                    ManagedWriteOutcome::Acknowledged
                }
                Ok(Err(error)) => {
                    ManagedWriteOutcome::PossiblyDispatched(error)
                }
                Err(error) => ManagedWriteOutcome::PossiblyDispatched(
                    anyhow::Error::new(error).context(h!()),
                ),
            }
        })
    }

    async fn write_once(
        &self,
        object: &ManagedObject,
        payload: ManagedPayload,
        guard: resources::ResourceGuard,
    ) -> Result<()> {
        #[cfg(test)]
        crate::devices::upload_finalization::fault::storage_dispatch(
            object.attempt_id,
        );
        match payload {
            ManagedPayload::Encrypted(bytes) => {
                anyhow::ensure!(
                    object.is_encrypted,
                    "managed payload policy mismatch"
                );
                self.operator
                    .write(&object.object_key, bytes)
                    .await
                    .context(h!())?;
            }
            ManagedPayload::Plaintext(file) => {
                anyhow::ensure!(
                    !object.is_encrypted,
                    "managed payload policy mismatch"
                );
                let writer = self.operator.writer_with(&object.object_key)
                    .chunk(crate::devices::config::DEVICE_FILE_CONTENT_STREAM_CHUNK_BYTES).await.context(h!())?;
                let mut writer = PlaintextUploadWriter::new(
                    writer,
                    object.object_key.clone(),
                );
                writer.admission = Some(Arc::new(guard));
                let mut stream = tokio_util::io::ReaderStream::with_capacity(file.take(object.size.checked_add(1).context(h!())?),
                    crate::devices::config::DEVICE_FILE_CONTENT_STREAM_CHUNK_BYTES);
                let mut hash = Sha256::new();
                let mut length = 0_u64;
                while let Some(bytes) = stream.try_next().await.context(h!())? {
                    length =
                        length.checked_add(bytes.len() as u64).context(h!())?;
                    anyhow::ensure!(
                        length <= object.size,
                        FinalizationFailure::SourceDigestMismatch
                    );
                    hash.update(&bytes);
                    writer.writer().write(bytes).await.context(h!())?;
                }
                anyhow::ensure!(
                    length == object.size && hash.finish() == object.sha256,
                    FinalizationFailure::SourceDigestMismatch
                );
                writer.close().await.context(h!())?;
            }
        }
        Ok(())
    }

    pub(crate) fn verify(
        self: Arc<Self>,
        object: ManagedObject,
        guard: resources::ResourceGuard,
        timeout: Duration,
    ) -> resources::OwnedOperation<Result<()>> {
        let child_guard = guard.clone();
        resources::spawn_owned(guard, async move {
            tokio::time::timeout(
                timeout,
                self.verify_full(&object, Some(child_guard)),
            )
            .await
            .context(h!())?
            .context(h!())
        })
    }

    async fn verify_full(
        &self,
        object: &ManagedObject,
        guard: Option<resources::ResourceGuard>,
    ) -> Result<()> {
        let metadata =
            self.operator.stat(&object.object_key).await.context(h!())?;
        if object.is_encrypted {
            anyhow::ensure!(object.size <= crate::devices::config::DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES
                && metadata.content_length() <= crate::devices::config::DEVICE_FILE_CONTENT_DOWNLOAD_MAX_ENCRYPTED_BYTES,
                "managed ciphertext exceeds bounded readback");
            let ciphertext = self
                .operator
                .read_with(&object.object_key)
                .range(0..metadata.content_length())
                .await
                .context(h!())?
                .to_vec();
            anyhow::ensure!(
                ciphertext.len() as u64 == metadata.content_length(),
                "incomplete managed readback"
            );
            let key = self.key.clone();
            let object_aad = aad(&self.config.bucket, &object.object_key);
            let object = object.clone();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _guard = guard;
                let strongbox = StaticStrongBox::new(key.clone(), vec![key]);
                let plaintext = strongbox
                    .decrypt(&ciphertext, object_aad.as_bytes())
                    .map_err(|_| {
                        anyhow::anyhow!("managed authentication failed")
                    })
                    .context(h!())?;
                anyhow::ensure!(
                    plaintext.len() as u64 == object.size
                        && sha256(&plaintext) == object.sha256,
                    FinalizationFailure::SourceDigestMismatch
                );
                Ok(())
            })
            .await
            .context(h!())?
            .context(h!())?;
        } else {
            anyhow::ensure!(
                metadata.content_length() == object.size,
                FinalizationFailure::SourceDigestMismatch
            );
            let mut stream = self
                .operator
                .reader(&object.object_key)
                .await
                .context(h!())?
                .into_bytes_stream(0..object.size)
                .await
                .context(h!())?;
            let mut hash = Sha256::new();
            let mut length = 0_u64;
            while let Some(bytes) = stream.try_next().await.context(h!())? {
                length =
                    length.checked_add(bytes.len() as u64).context(h!())?;
                anyhow::ensure!(
                    length <= object.size,
                    FinalizationFailure::SourceDigestMismatch
                );
                hash.update(&bytes);
            }
            anyhow::ensure!(
                length == object.size && hash.finish() == object.sha256,
                FinalizationFailure::SourceDigestMismatch
            );
        }
        Ok(())
    }

    pub(crate) async fn reconcile(
        self: Arc<Self>,
        db: &DatabaseConnection,
        claim: &ClaimedFinalizationJob,
        guard: resources::ResourceGuard,
        timeout: Duration,
    ) -> Result<crate::devices::upload_finalization::recovery::Reconciliation>
    {
        use crate::devices::upload_finalization::recovery::Reconciliation;
        if query::exact_publication(db, claim).await.context(h!())? {
            return Ok(Reconciliation::Published);
        }
        let Some(object) =
            query::active_object(db, claim).await.context(h!())?
        else {
            return Ok(Reconciliation::Unresolved);
        };
        let managed = ManagedObject {
            attempt_id: object.attempt_id,
            object_key: object.object_key.clone(),
            size: u64::try_from(object.source_size_bytes).context(h!())?,
            sha256: object.source_sha256,
            is_encrypted: object.is_encrypted,
        };
        // The probe and the readback share one phase deadline, so a stalled
        // endpoint cannot hold the slots past the phase timeout.
        let deadline = tokio::time::Instant::now() + timeout;
        match tokio::time::timeout_at(
            deadline,
            self.operator.stat(&managed.object_key),
        )
        .await
        {
            Ok(Err(error)) if error.kind() == opendal::ErrorKind::NotFound => {
                return Ok(Reconciliation::Missing(object.attempt_id));
            }
            Ok(_) => {}
            Err(_) => {
                log::warn!(
                    "managed object reconciliation probe timed out for {}",
                    object.attempt_id
                );
                return Ok(Reconciliation::Unresolved);
            }
        }
        let remaining =
            deadline.saturating_duration_since(tokio::time::Instant::now());
        if let Err(error) =
            self.verify(managed, guard, remaining).await.context(h!())?
        {
            log::warn!(
                "managed object reconciliation unresolved for {}: {error:#}",
                object.attempt_id
            );
            return Ok(Reconciliation::Unresolved);
        }
        if !query::record_verified(db, claim, object.attempt_id)
            .await
            .context(h!())?
        {
            return Err(FinalizationFailure::StaleClaim.into());
        }
        Ok(Reconciliation::Verified(object))
    }

    pub(crate) async fn cleanup_retired(
        &self,
        db: &DatabaseConnection,
        attempt_id: Uuid,
        timeout: Duration,
    ) -> Result<bool> {
        let key: Option<String> = sqlx::query_scalar("select a.object_key from device_upload_finalization_attempt a where a.id=$1 and a.phase='retired' and not exists(select 1 from file_content_upload_object o where o.object_key=a.object_key) and not exists(select 1 from device_audio audio where audio.storage_key=a.object_key)")
            .bind(attempt_id).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
        let Some(key) = key else {
            return Ok(false);
        };
        tokio::time::timeout(timeout, self.operator.delete(&key))
            .await
            .context(h!())?
            .context(h!())?;
        sqlx::query("update device_upload_finalization_attempt set cleanup_confirmed_at=coalesce(cleanup_confirmed_at,clock_timestamp()),cleanup_next_at=case when late_write_possible then clock_timestamp()+$2*interval '1 second' else null end,updated_at=clock_timestamp() where id=$1 and phase='retired'")
            .bind(attempt_id).bind(crate::config::DEVICE_UPLOAD_FINALIZATION_RETRY_MAX_SECONDS as i64).execute(db.get_postgres_connection_pool()).await.context(h!())?;
        Ok(true)
    }
}

async fn retain_not_dispatched(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
) {
    let cancellation = resources::shutdown_cancellation();
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = query::record_not_dispatched(db, claim, attempt_id) => {
                match result {
                    Ok(()) => return,
                    Err(error) => log::warn!("finalization no-dispatch evidence deferred for {attempt_id}: {error:#}"),
                }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(
                crate::config::DEVICE_UPLOAD_FINALIZATION_NO_DISPATCH_RETRY_SECONDS,
            )) => {}
        }
    }
}

async fn validate_attempt(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    object: &ManagedObject,
) -> Result<()> {
    let matches: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id where a.id=$1 and j.id=$2 and a.origin='async' and a.phase='prepared' and a.object_key=$3 and a.source_size_bytes=$4 and a.source_sha256=$5 and a.is_encrypted=$6 and j.active_attempt_id=a.id)")
        .bind(object.attempt_id).bind(claim.job_id).bind(&object.object_key)
        .bind(i64::try_from(object.size).context(h!())?).bind(object.sha256.as_slice()).bind(object.is_encrypted)
        .fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
    anyhow::ensure!(matches, FinalizationFailure::StaleClaim);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn full_readback_rejects_corruption_beyond_first_byte_and_wrong_aad()
    {
        let operator = Operator::new(opendal::services::Memory::default())
            .unwrap()
            .finish();
        let key = key_from_b64(&crate::storage::generate_strongbox_key_b64())
            .unwrap();
        let config = S3Config {
            bucket: "fixture".into(),
            region: String::new(),
            endpoint: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            prefix: String::new(),
        };
        let storage = ManagedStorage {
            operator,
            config,
            key,
        };
        let payload = b"correct plaintext";
        let mut object = ManagedObject {
            attempt_id: Uuid::new_v4(),
            object_key: "unique-attempt".into(),
            size: payload.len() as u64,
            sha256: Sha256::digest(payload).into(),
            is_encrypted: false,
        };
        storage
            .operator
            .write(&object.object_key, payload.to_vec())
            .await
            .unwrap();
        storage.verify_full(&object, None).await.unwrap();
        storage
            .operator
            .write(&object.object_key, b"corrupt plaintext".to_vec())
            .await
            .unwrap();
        assert!(storage.verify_full(&object, None).await.is_err());
        object.is_encrypted = true;
        let strongbox = StaticStrongBox::new(
            storage.key.clone(),
            vec![storage.key.clone()],
        );
        let encrypted = strongbox
            .encrypt(payload, aad("fixture", "unique-attempt").as_bytes())
            .unwrap();
        storage
            .operator
            .write(&object.object_key, encrypted.clone())
            .await
            .unwrap();
        storage.verify_full(&object, None).await.unwrap();
        object.object_key = "different-attempt".into();
        storage
            .operator
            .write(&object.object_key, encrypted)
            .await
            .unwrap();
        assert!(storage.verify_full(&object, None).await.is_err());
    }
}
