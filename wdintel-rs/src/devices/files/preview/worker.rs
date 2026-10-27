use std::time::Duration;

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use sha2::{Digest, Sha256};
use sqlx::{pool::PoolConnection, Postgres, Row};
use tokio_util::sync::CancellationToken;

use super::query::{self, Preview};
use crate::{devices::config::*, h, types::Env};

pub(crate) async fn run_nofail(env: Env, cancellation: CancellationToken) {
    if env.file_registry_db.is_none()
        || env.s3.is_none()
        || env.s3_config.is_none()
        || env.config.alpine_converter_url.is_none()
    {
        return;
    }
    loop {
        if cancellation.is_cancelled() {
            return;
        }
        if let Err(error) = run_with_lock(&env, &cancellation).await {
            crate::types::warn!("device preview worker failed: {error:#}");
        }
        tokio::select! {
            _=cancellation.cancelled()=>return,
            _=tokio::time::sleep(Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_POLL_SECONDS))=>{}
        }
    }
}

async fn run_with_lock(
    env: &Env,
    cancellation: &CancellationToken,
) -> Result<()> {
    let db = env.file_registry_db().context(h!())?.connection();
    let mut lock = db
        .get_postgres_connection_pool()
        .acquire()
        .await
        .context(h!())?;
    lock.close_on_drop();
    let acquired = sqlx::query("select pg_try_advisory_lock($1) as acquired")
        .bind(DEVICE_FILE_PREVIEW_GEODATA_WORKER_LOCK)
        .fetch_one(&mut *lock)
        .await
        .context(h!())?
        .try_get::<bool, _>("acquired")
        .context(h!())?;
    if !acquired {
        return Ok(());
    }
    loop {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        check_lock(&mut lock).await.context(h!())?;
        if let Some(job) = query::claim(db).await.context(h!())? {
            record(env, "attempt");
            if let Some(metrics) = &env.metrics {
                metrics.record_device_file_preview_queue_age(
                    (chrono::Utc::now().fixed_offset() - job.created_at)
                        .num_milliseconds()
                        .max(0) as f64
                        / 1000.0,
                );
            }
            run_attempt(env, db, &job, &mut lock, cancellation)
                .await
                .context(h!())?;
        } else {
            tokio::select! {
                _=cancellation.cancelled()=>return Ok(()),
                _=tokio::time::sleep(Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_POLL_SECONDS))=>{}
            }
        }
    }
}

async fn check_lock(lock: &mut PoolConnection<Postgres>) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_HEARTBEAT_SECONDS),
        sqlx::query("select 1").execute(&mut **lock),
    )
    .await
    .context(h!())?
    .context(h!())?;
    Ok(())
}

async fn run_attempt(
    env: &Env,
    db: &DatabaseConnection,
    job: &Preview,
    lock: &mut PoolConnection<Postgres>,
    cancellation: &CancellationToken,
) -> Result<()> {
    crate::types::info!(
        "device preview run {} generation {} attempt {}",
        job.run_id,
        job.generation,
        job.attempt
    );
    let remaining = job
        .attempt_deadline
        .context(h!())?
        .signed_duration_since(chrono::Utc::now())
        .to_std()
        .unwrap_or_default();
    let conversion =
        tokio::time::timeout(remaining, convert_and_publish(env, db, job));
    tokio::pin!(conversion);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(
        DEVICE_FILE_PREVIEW_GEODATA_HEARTBEAT_SECONDS,
    ));
    loop {
        tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Ok(()),
            _=heartbeat.tick()=>{
                check_lock(lock).await.context(h!())?;
                if !query::heartbeat(db,job).await.context(h!())? {record(env,"lease_lost");return Ok(());}
            }
            result=&mut conversion=>{
                let result=result.map_err(|_| crate::alpine::DeviceConversionFailure("conversion_timeout").into()).and_then(|result|result);
                if let Err(error)=result {
                    crate::types::warn!("device preview attempt failed: {error:#}");
                    let code=error.downcast_ref::<crate::alpine::DeviceConversionFailure>().map(|failure|failure.0).unwrap_or("storage_unavailable");
                    query::fail(db,job,code,matches!(code,"storage_unavailable"|"conversion_unavailable"|"conversion_timeout")).await.context(h!())?;
                }
                return Ok(());
            }
        }
    }
}

async fn convert_and_publish(
    env: &Env,
    db: &DatabaseConnection,
    job: &Preview,
) -> Result<()> {
    if job.archive_members.is_some() {
        return Err(crate::alpine::DeviceConversionFailure(
            "generation_conflict",
        )
        .into());
    }
    let source = read_bytes(
        env,
        &job.source_object_key,
        job.source_size_bytes as u64,
        job.source_is_encrypted,
        DEVICE_FILE_PREVIEW_GEODATA_SOURCE_CIPHERTEXT_MAX_BYTES,
    )
    .await
    .context(h!())?;
    let source_digest: [u8; 32] = Sha256::digest(&source).into();
    if source.len() as i64 != job.source_size_bytes
        || source_digest.as_slice() != job.source_sha256.as_slice()
    {
        return Err(
            crate::alpine::DeviceConversionFailure("source_invalid").into()
        );
    }
    let name = job.source_name.clone();
    let converted =
        crate::alpine::convert_device_bytes_to_kmz(env, source, name)
            .await
            .map_err(|error| {
                if error
                    .downcast_ref::<crate::alpine::DeviceConversionFailure>()
                    .is_some()
                {
                    error
                } else {
                    anyhow::Error::from(crate::alpine::DeviceConversionFailure(
                        "conversion_unavailable",
                    ))
                    .context(error)
                }
            })
            .context(h!())?;
    let size = converted.len() as i64;
    let digest = Sha256::digest(&converted).to_vec();
    if !query::owned(db, job).await.context(h!())? {
        record(env, "publish_cas_lost");
        return Ok(());
    }
    let storage = env.s3.as_ref().context(h!())?;
    let config = storage_config(env).context(h!())?;
    let key = &env.config.s3_config.as_ref().context(h!())?.strongbox_key;
    tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_STORAGE_SECONDS),
        crate::storage::upload_device_content_encrypted(
            storage,
            &config,
            key,
            &job.output_object_key,
            converted,
            None,
        ),
    )
    .await
    .context(h!())?
    .context(h!())?;
    match query::publish(db, job, size, digest).await {
        Ok(true) => {}
        Ok(false) => record(env, "publish_cas_lost"),
        Err(error) => {
            let authoritative =
                query::load(db, job.generation).await.context(h!())?;
            if !authoritative.is_some_and(|p| {
                p.state == "ready"
                    && p.is_current
                    && p.output_object_key == job.output_object_key
            }) {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub(super) fn storage_config(env: &Env) -> Result<crate::storage::S3Config> {
    let mut config = env.s3_config.clone().context(h!())?;
    config.prefix.clear();
    Ok(config)
}

pub(super) async fn read_bytes(
    env: &Env,
    key: &str,
    size: u64,
    encrypted: bool,
    ciphertext_limit: u64,
) -> Result<Vec<u8>> {
    anyhow::ensure!(
        size <= ciphertext_limit,
        "preview content exceeds read limit"
    );
    let download = async {
        if let Some(bytes) =
            crate::devices::files::content::local_cache::read_bytes(
                env, key, size, encrypted,
            )
            .await
        {
            return Ok(bytes);
        }
        let config = storage_config(env).context(h!())?;
        if encrypted {
            let strongbox_key =
                &env.config.s3_config.as_ref().context(h!())?.strongbox_key;
            crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator_timeout_and_size_limit(&env.s3,&Some(config),strongbox_key,key,Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_STORAGE_SECONDS),ciphertext_limit).await.context(h!())
        } else {
            let storage = env.s3.as_ref().context(h!())?;
            let metadata = storage.stat(key).await.context(h!())?;
            anyhow::ensure!(
                metadata.content_length() == size,
                "preview source size mismatch"
            );
            let mut stream = storage
                .reader(key)
                .await
                .context(h!())?
                .into_bytes_stream(0..size)
                .await
                .context(h!())?;
            let mut bytes = Vec::new();
            while let Some(chunk) =
                futures_util::TryStreamExt::try_next(&mut stream)
                    .await
                    .context(h!())?
            {
                anyhow::ensure!(
                    (bytes.len() as u64).saturating_add(chunk.len() as u64)
                        <= size,
                    "preview source exceeded its verified size"
                );
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        }
    };
    let bytes = tokio::time::timeout(
        Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_STORAGE_SECONDS),
        download,
    )
    .await
    .context(h!())?
    .context(h!())?;
    anyhow::ensure!(
        bytes.len() as u64 == size,
        "preview content size mismatch"
    );
    Ok(bytes)
}

pub(super) async fn cleanup(env: &Env, db: &DatabaseConnection) -> Result<()> {
    let storage = env.s3.as_ref().context(h!())?;
    for job in query::cleanup_candidates(db).await.context(h!())? {
        let deletion = tokio::time::timeout(
            Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_STORAGE_SECONDS),
            async {
                storage.delete(&job.output_object_key).await.context(h!())?;
                anyhow::ensure!(
                    !storage
                        .exists(&job.output_object_key)
                        .await
                        .context(h!())?,
                    "preview object still exists after delete"
                );
                Ok::<_, anyhow::Error>(())
            },
        )
        .await;
        let deleted = matches!(deletion, Ok(Ok(())));
        record(
            env,
            if deleted {
                "cleanup_success"
            } else {
                "cleanup_failure"
            },
        );
        query::cleanup_record(db, &job, deleted)
            .await
            .context(h!())?;
    }
    Ok(())
}

pub(super) fn record(env: &Env, event: &'static str) {
    if let Some(metrics) = &env.metrics {
        metrics.record_device_file_preview_event(event);
    }
}

pub(crate) async fn cleanup_nofail(env: Env, cancellation: CancellationToken) {
    if env.file_registry_db.is_none()
        || env.s3.is_none()
        || env.s3_config.is_none()
    {
        return;
    }
    loop {
        let cleanup = async {
            cleanup(&env, env.file_registry_db().context(h!())?.connection())
                .await
        };
        tokio::select! {
            _=cancellation.cancelled()=>return,
            result=cleanup=>if let Err(error)=result {crate::types::warn!("device preview cleanup failed: {error:#}");}
        }
        tokio::select! {
            _=cancellation.cancelled()=>return,
            _=tokio::time::sleep(Duration::from_secs(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_SECONDS))=>{}
        }
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[actix_web::test]
    #[serial_test::serial]
    async fn geodata_reads_retained_original_without_s3() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let mut env = env.as_ref().clone();
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"<gpx><wpt lat=\"50\" lon=\"30\" /></gpx>";
        crate::devices::files::content::local_cache::test_support::retain_without_storage(
            &mut env, directory.path(), "devices/geodata-source", bytes, true,
        ).await;
        assert_eq!(
            read_bytes(
                &env,
                "devices/geodata-source",
                bytes.len() as u64,
                true,
                1024
            )
            .await
            .unwrap(),
            bytes
        );
        assert!(read_bytes(
            &env,
            "devices/geodata-source",
            bytes.len() as u64,
            true,
            1
        )
        .await
        .is_err());
    }
}
