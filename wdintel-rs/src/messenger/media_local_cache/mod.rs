mod files;
pub(crate) mod playback;
#[cfg(test)]
mod tests;
mod worker;

use crate::config::{Config, MessengerMediaCacheConfig};
use crate::entities::signal_message_media;
use crate::h;
use crate::types::{warn, Env, ShortContext};
use anyhow::{bail, Result};
use chrono::Utc;
use files::{Entry, Metadata, TemporaryFile};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncReadExt;

pub(crate) use playback::playback_status;
pub(crate) use worker::run_nofail;

pub(crate) async fn configured_config(
    config: &Config,
    dbx: &impl sea_orm::ConnectionTrait,
) -> Result<Config> {
    use crate::config::*;
    let active = crate::system_settings::get_active_system_settings(dbx)
        .await
        .c(h!())?;
    let mut config = config.clone();
    config.messenger_media_cache = active
        .filter(|active| active.messenger_media_cache_enabled.unwrap_or(false))
        .map(|active| MessengerMediaCacheConfig {
            enabled: true,
            retention_secs: active
                .messenger_media_cache_retention_hours
                .unwrap_or(MESSENGER_MEDIA_CACHE_RETENTION_HOURS_DEFAULT)
                .clamp(24, MESSENGER_MEDIA_CACHE_RETENTION_HOURS_MAX)
                as u64
                * 3600,
            max_total_size_bytes: active
                .messenger_media_cache_max_size_gib
                .unwrap_or(MESSENGER_MEDIA_CACHE_MAX_SIZE_GIB_DEFAULT)
                .clamp(1, MESSENGER_MEDIA_CACHE_SIZE_GIB_MAX)
                as u64
                * 1024
                * 1024
                * 1024,
            min_free_space_bytes: active
                .messenger_media_cache_min_free_gib
                .unwrap_or(MESSENGER_MEDIA_CACHE_MIN_FREE_GIB_DEFAULT)
                .clamp(0, MESSENGER_MEDIA_CACHE_SIZE_GIB_MAX)
                as u64
                * 1024
                * 1024
                * 1024,
        });
    Ok(config)
}

pub(super) async fn configured_env(env: &Env) -> Result<Env> {
    let mut configured = env.clone();
    configured.config =
        configured_config(&env.config, &env.dbx).await.c(h!())?;
    Ok(configured)
}

pub(crate) async fn configured_config_best_effort(
    config: &Config,
    dbx: &impl sea_orm::ConnectionTrait,
) -> Config {
    match configured_config(config, dbx).await {
        Ok(config) => config,
        Err(error) => {
            warn!("failed to load media cache settings: {error:#}");
            let mut config = config.clone();
            config.messenger_media_cache = None;
            config
        }
    }
}

pub(super) fn settings(config: &Config) -> Option<&MessengerMediaCacheConfig> {
    config.messenger_media_cache.as_ref().filter(|settings| {
        settings.enabled
            && settings.retention_secs > 0
            && settings.retention_secs <= i64::MAX as u64
            && settings.max_total_size_bytes > 0
    })
}

pub(crate) fn enabled(config: &Config) -> bool {
    settings(config).is_some()
}

fn entry(
    config: &Config,
    media: &signal_message_media::Model,
) -> Result<Entry> {
    Entry::new(
        config,
        &crate::messenger::media::media_object_key(media),
        u64::try_from(media.size_bytes).c(h!())?,
        media.is_encrypted,
    )
    .c(h!())
}

pub(crate) async fn ready_original(
    config: &Config,
    media: &signal_message_media::Model,
) -> Result<Option<PathBuf>> {
    if !enabled(config) {
        return Ok(None);
    }
    entry(config, media).c(h!())?.ready(false).await.c(h!())
}

pub(crate) async fn stage_upload_best_effort(
    config: &Config,
    key: &str,
    size: i64,
    encrypted: bool,
    source: &Path,
    sealed: bool,
) {
    if !enabled(config) {
        return;
    }
    if let Err(error) =
        stage_upload(config, key, size, encrypted, source, sealed).await
    {
        warn!("messenger media retention degraded object={key}: {error:#}");
    }
}

async fn stage_upload(
    config: &Config,
    key: &str,
    size: i64,
    encrypted: bool,
    source: &Path,
    sealed: bool,
) -> Result<()> {
    files::ensure_root(config).await.c(h!())?;
    let entry =
        Entry::new(config, key, u64::try_from(size).c(h!())?, encrypted)
            .c(h!())?;
    let _lock = entry.lock().await.c(h!())?;
    if entry.ready(false).await.c(h!())?.is_some() {
        return Ok(());
    }
    let _reservation =
        files::reserve(config, &entry, entry.size).await.c(h!())?;
    let temporary = TemporaryFile(entry.path("original.tmp"));
    files::remove_if_present(&temporary.0).await.c(h!())?;
    stage_source(source, &temporary.0, entry.size, sealed)
        .await
        .c(h!())?;
    fs::rename(&temporary.0, entry.path("original"))
        .await
        .c(h!())?;
    let now = Utc::now().timestamp();
    let metadata = Metadata {
        size: entry.size,
        retain_until: now
            .saturating_add(settings(config).c(h!())?.retention_secs as i64),
        staged_at: now,
        committed: false,
        playback_size: None,
        playback_error: None,
    };
    entry.write_metadata(&metadata).await.c(h!())
}

async fn stage_source(
    source: &Path,
    target: &Path,
    expected_size: u64,
    sealed: bool,
) -> Result<()> {
    if !files::valid_file(source, expected_size).await.c(h!())? {
        bail!("local attachment source changed before cache staging");
    }
    if sealed && fs::hard_link(source, target).await.is_ok() {
        fs::File::open(target)
            .await
            .c(h!())?
            .sync_all()
            .await
            .c(h!())?;
        return Ok(());
    }
    let source = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source)
        .await
        .c(h!())?;
    let mut source = source.take(expected_size.saturating_add(1));
    let mut target = files::create_private_file(target).await.c(h!())?;
    let copied = tokio::io::copy(&mut source, &mut target).await.c(h!())?;
    if copied != expected_size {
        bail!("local attachment cache size mismatch")
    }
    target.sync_all().await.c(h!())
}

pub(crate) async fn discard_upload_best_effort(
    config: &Config,
    key: &str,
    size: i64,
    encrypted: bool,
) {
    let result = async {
        if !fs::try_exists(files::root(config)).await.c(h!())? {
            return Ok(());
        }
        let entry =
            Entry::new(config, key, u64::try_from(size).c(h!())?, encrypted)
                .c(h!())?;
        let _lock = entry.lock().await.c(h!())?;
        if entry
            .metadata()
            .await
            .c(h!())?
            .is_some_and(|metadata| !metadata.committed)
        {
            entry.remove().await.c(h!())?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        warn!("failed to discard staged media cache object={key}: {error:#}")
    }
}

pub(crate) async fn pin_media_best_effort(
    dbx: &impl sea_orm::ConnectionTrait,
    config: &Config,
    media: &[signal_message_media::Model],
) {
    let config = configured_config_best_effort(config, dbx).await;
    if !enabled(&config) {
        return;
    }
    for media in media {
        if let Err(error) =
            pin_media(&config, media, Utc::now().timestamp()).await
        {
            warn!(
                "messenger media retention degraded media_id={}: {error:#}",
                media.id
            );
        }
    }
}

pub(crate) async fn remove_unreferenced_best_effort(
    config: &Config,
    media: &signal_message_media::Model,
) {
    let result = async {
        if !fs::try_exists(files::root(config)).await.c(h!())? {
            return Ok(());
        }
        let entry = entry(config, media).c(h!())?;
        files::ensure_root(config).await.c(h!())?;
        let _lock = entry.lock().await.c(h!())?;
        entry.remove().await.c(h!())
    }
    .await;
    if let Err(error) = result {
        warn!("failed to remove unreferenced retained media media_id={}: {error:#}", media.id);
    }
}

pub(super) async fn pin_media(
    config: &Config,
    media: &signal_message_media::Model,
    published_at: i64,
) -> Result<()> {
    let entry = entry(config, media).c(h!())?;
    let _lock = entry.lock().await.c(h!())?;
    let Some(mut metadata) = entry.metadata().await.c(h!())? else {
        return Ok(());
    };
    let retain_until = published_at
        .saturating_add(settings(config).c(h!())?.retention_secs as i64);
    if !metadata.committed || metadata.retain_until < retain_until {
        metadata.committed = true;
        metadata.retain_until = metadata.retain_until.max(retain_until);
        entry.write_metadata(&metadata).await.c(h!())?;
    }
    Ok(())
}

pub(crate) async fn pin_message_best_effort(env: &Env, message_id: i64) {
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    match signal_message_media::Entity::find()
        .filter(signal_message_media::Column::SignalMessageId.eq(message_id))
        .all(&env.dbx).await {
        Ok(media) => pin_media_best_effort(&env.dbx, &env.config, &media).await,
        Err(error) => warn!("failed to pin published message media message_id={message_id}: {error:?}"),
    }
}
