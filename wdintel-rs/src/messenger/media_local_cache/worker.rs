use super::{entry, files, pin_media, playback, settings};
use crate::config::{
    MESSENGER_MEDIA_LOCAL_CACHE_RECOVERY_BATCH_SIZE,
    MESSENGER_MEDIA_LOCAL_CACHE_RECOVERY_CONCURRENCY,
    MESSENGER_MEDIA_LOCAL_CACHE_WORKER_INTERVAL_SECS,
};
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{info, warn, Env, ShortContext};
use anyhow::{bail, Result};
use chrono::Utc;
use futures_util::{stream, StreamExt, TryStreamExt};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub(crate) async fn run_nofail(env: Arc<Env>) {
    let mut first_cycle = true;
    loop {
        if let Err(error) = reconcile(&env, first_cycle).await {
            warn!("messenger media local retention recovery failed: {error:#}");
        }
        first_cycle = false;
        tokio::time::sleep(Duration::from_secs(
            MESSENGER_MEDIA_LOCAL_CACHE_WORKER_INTERVAL_SECS,
        ))
        .await;
    }
}

async fn reconcile(env: &Env, first_cycle: bool) -> Result<()> {
    let env = super::configured_env(env).await.c(h!())?;
    if settings(&env.config).is_none() {
        if first_cycle {
            warn!("messenger media local retention is disabled; enable it in admin system settings");
        }
        return Ok(());
    }
    let env = &env;
    files::ensure_root(&env.config).await.c(h!())?;
    let Some(_worker) =
        files::try_lock(&files::root(&env.config).join("worker.lock"))
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    let retention = settings(&env.config).c(h!())?.retention_secs as i64;
    let since = Utc::now()
        .checked_sub_signed(chrono::Duration::try_seconds(retention).c(h!())?)
        .c(h!())?
        .naive_utc();
    let mut cursor = None;
    let mut missing = 0;
    loop {
        let batch = recent_batch(env, since, cursor).await.c(h!())?;
        if batch.is_empty() {
            break;
        }
        let last = batch.last().c(h!())?;
        cursor = Some((last.created_at, last.id));
        missing += recover_batch(env, batch).await;
    }
    files::cleanup(&env.config).await.c(h!())?;
    info!(
        "messenger media retention reconciliation missing_protected={missing}"
    );
    Ok(())
}

async fn recent_batch(
    env: &Env,
    since: chrono::NaiveDateTime,
    cursor: Option<(chrono::NaiveDateTime, uuid::Uuid)>,
) -> Result<Vec<signal_message_media::Model>> {
    let mut query = signal_message_media::Entity::find()
        .filter(signal_message_media::Column::CreatedAt.gte(since));
    if let Some((created_at, id)) = cursor {
        query = query.filter(sea_orm::sea_query::Expr::cust_with_values(
            "(signal_message_media.created_at, signal_message_media.id) > (?, ?)",
            [sea_orm::Value::from(created_at), sea_orm::Value::from(id)],
        ));
    }
    query
        .order_by_asc(signal_message_media::Column::CreatedAt)
        .order_by_asc(signal_message_media::Column::Id)
        .limit(MESSENGER_MEDIA_LOCAL_CACHE_RECOVERY_BATCH_SIZE)
        .all(&env.dbx)
        .await
        .c(h!())
}

async fn recover_batch(
    env: &Env,
    batch: Vec<signal_message_media::Model>,
) -> usize {
    let playback_media = batch.clone();
    let results = stream::iter(batch)
        .map(|media| async move {
            let published_at = media.created_at.and_utc().timestamp();
            let result = async {
                pin_media(&env.config, &media, published_at).await.c(h!())?;
                recover_original(env, &media, published_at).await.c(h!())?;
                if entry(&env.config, &media)
                    .c(h!())?
                    .ready(false)
                    .await
                    .c(h!())?
                    .is_none()
                {
                    bail!("protected media is still awaiting local recovery");
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                warn!(
                    "messenger media retention degraded media_id={}: {error:#}",
                    media.id
                );
                return 1;
            }
            0
        })
        .buffer_unordered(MESSENGER_MEDIA_LOCAL_CACHE_RECOVERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for media in playback_media {
        if let Err(error) = playback::prepare(env, &media).await {
            warn!("messenger media playback preparation failed media_id={}: {error:#}", media.id);
        }
    }
    results.into_iter().sum()
}

pub(super) async fn recover_original(
    env: &Env,
    media: &signal_message_media::Model,
    published_at: i64,
) -> Result<()> {
    files::ensure_root(&env.config).await.c(h!())?;
    let entry = entry(&env.config, media).c(h!())?;
    let Some(_lock) = files::try_lock(&entry.path("lock")).await.c(h!())?
    else {
        return Ok(());
    };
    if entry.ready(false).await.c(h!())?.is_some() {
        return Ok(());
    }
    let _download = download_slot(&entry).await.c(h!())?;
    let _reservation = files::reserve(&env.config, &entry, entry.size)
        .await
        .c(h!())?;
    let temporary = files::TemporaryFile(entry.path("original.tmp"));
    files::remove_if_present(&temporary.0).await.c(h!())?;
    let mut file = files::create_private_file(&temporary.0).await.c(h!())?;
    let transferred = tokio::time::timeout(
        Duration::from_secs(
            crate::config::MESSENGER_MEDIA_CACHE_DOWNLOAD_TIMEOUT_SECS,
        ),
        download_original(env, media, &mut file),
    )
    .await
    .c(h!())?
    .c(h!())?;
    if transferred != entry.size {
        bail!("recovered attachment cache size mismatch")
    }
    file.sync_all().await.c(h!())?;
    fs::rename(&temporary.0, entry.path("original"))
        .await
        .c(h!())?;
    let now = Utc::now().timestamp();
    let previous = entry.metadata().await.c(h!())?;
    let retain_until = published_at
        .saturating_add(settings(&env.config).c(h!())?.retention_secs as i64);
    let metadata = files::Metadata {
        size: entry.size,
        retain_until: previous.as_ref().map_or(retain_until, |metadata| {
            metadata.retain_until.max(retain_until)
        }),
        staged_at: now,
        committed: true,
        playback_size: None,
        playback_error: None,
    };
    entry.write_metadata(&metadata).await.c(h!())?;
    info!(
        "recovered local messenger media media_id={} bytes={transferred}",
        media.id
    );
    Ok(())
}

async fn download_original(
    env: &Env,
    media: &signal_message_media::Model,
    file: &mut fs::File,
) -> Result<u64> {
    if media.is_encrypted {
        let data = crate::messenger::media::fetch_media_bytes(env, media)
            .await
            .c(h!())?;
        file.write_all(&data).await.c(h!())?;
        return Ok(data.len() as u64);
    }
    let size = u64::try_from(media.size_bytes).c(h!())?;
    if size == 0 {
        return Ok(0);
    }
    let mut stream = crate::messenger::media::stream_plaintext_media_range(
        env,
        media,
        0..size,
    )
    .await
    .c(h!())?;
    let mut transferred = 0u64;
    while let Some(bytes) = stream.try_next().await.c(h!())? {
        transferred = transferred.saturating_add(bytes.len() as u64);
        if transferred > size {
            bail!("attachment range stream exceeded declared size")
        }
        file.write_all(&bytes).await.c(h!())?;
    }
    Ok(transferred)
}

async fn download_slot(entry: &files::Entry) -> Result<files::FileLock> {
    for slot in 0..MESSENGER_MEDIA_LOCAL_CACHE_RECOVERY_CONCURRENCY {
        if let Some(lock) =
            files::try_lock(&entry.root.join(format!("download-{slot}.lock")))
                .await
                .c(h!())?
        {
            return Ok(lock);
        }
    }
    bail!("messenger media cache recovery downloads are busy")
}
