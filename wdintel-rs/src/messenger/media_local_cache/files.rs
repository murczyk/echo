use super::settings;
use crate::config::{
    Config, MESSENGER_MEDIA_CACHE_DIR_MODE, MESSENGER_MEDIA_CACHE_FILE_MODE,
    MESSENGER_MEDIA_LOCAL_CACHE_DIR_NAME,
    MESSENGER_MEDIA_LOCAL_CACHE_LOCK_RETRY_MILLIS,
    MESSENGER_MEDIA_LOCAL_CACHE_LOCK_WAIT_MILLIS,
    MESSENGER_MEDIA_LOCAL_CACHE_METADATA_MAX_BYTES,
    MESSENGER_MEDIA_LOCAL_CACHE_ORPHAN_TTL_SECS,
};
use crate::h;
use crate::types::ShortContext;
use anyhow::{bail, Result};
use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub(super) struct Entry {
    pub root: PathBuf,
    pub id: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Metadata {
    pub size: u64,
    pub retain_until: i64,
    pub staged_at: i64,
    pub committed: bool,
    pub playback_size: Option<u64>,
    pub playback_error: Option<String>,
}

/// The local cache has no room for a new object: either the size budget is
/// spent on protected originals or the free-space floor was reached.
#[derive(Debug)]
pub(super) struct CacheFull(&'static str);

impl std::fmt::Display for CacheFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for CacheFull {}

pub(super) struct FileLock(std::fs::File);

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(super) struct Reservation(PathBuf);

impl Drop for Reservation {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) struct TemporaryFile(pub PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) fn root(config: &Config) -> PathBuf {
    crate::messenger::media_cache::media_cache_dir(config)
        .join(MESSENGER_MEDIA_LOCAL_CACHE_DIR_NAME)
}

impl Entry {
    pub fn new(
        config: &Config,
        key: &str,
        size: u64,
        encrypted: bool,
    ) -> Result<Self> {
        let storage = config.s3_config.as_ref().c(h!())?;
        let identity = serde_json::to_vec(&(
            &storage.s3_endpoint,
            &storage.s3_bucket,
            key,
            size,
            encrypted,
        ))
        .c(h!())?;
        Ok(Self {
            root: root(config),
            id: format!("{:x}", Sha256::digest(identity)),
            size,
        })
    }

    pub fn path(&self, suffix: &str) -> PathBuf {
        self.root.join(format!("{}.{suffix}", self.id))
    }

    pub async fn lock(&self) -> Result<FileLock> {
        lock(&self.path("lock")).await.c(h!())
    }

    pub async fn metadata(&self) -> Result<Option<Metadata>> {
        let file = match fs::File::open(self.path("json")).await {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => return Err(error).c(h!()),
        };
        let mut data = Vec::new();
        file.take(MESSENGER_MEDIA_LOCAL_CACHE_METADATA_MAX_BYTES + 1)
            .read_to_end(&mut data)
            .await
            .c(h!())?;
        if data.len() as u64 > MESSENGER_MEDIA_LOCAL_CACHE_METADATA_MAX_BYTES {
            bail!("messenger media cache metadata exceeds its limit");
        }
        Ok(Some(serde_json::from_slice(&data).c(h!())?))
    }

    pub async fn write_metadata(&self, metadata: &Metadata) -> Result<()> {
        let temporary = TemporaryFile(self.path("metadata.tmp"));
        let data = serde_json::to_vec(metadata).c(h!())?;
        write_private_file(&temporary.0, &data).await.c(h!())?;
        fs::rename(&temporary.0, self.path("json")).await.c(h!())?;
        sync_directory(&self.root).await.c(h!())
    }

    pub async fn ready(&self, playback: bool) -> Result<Option<PathBuf>> {
        let Some(metadata) = self.metadata().await.c(h!())? else {
            return Ok(None);
        };
        let (path, size) = if playback {
            let Some(size) = metadata.playback_size else {
                return Ok(None);
            };
            (self.path("playback.mp4"), size)
        } else {
            (self.path("original"), self.size)
        };
        if metadata.size == self.size
            && valid_file(&path, size).await.c(h!())?
        {
            Ok(Some(path))
        } else {
            Ok(None)
        }
    }

    pub async fn remove(&self) -> Result<()> {
        for suffix in [
            "original",
            "playback.mp4",
            "json",
            "original.tmp",
            "playback.tmp",
            "metadata.tmp",
            "reservation",
        ] {
            remove_if_present(&self.path(suffix)).await.c(h!())?;
        }
        sync_directory(&self.root).await.c(h!())
    }

    async fn clear_staging(&self) -> Result<()> {
        for suffix in [
            "reservation",
            "original.tmp",
            "playback.tmp",
            "metadata.tmp",
        ] {
            remove_if_present(&self.path(suffix)).await.c(h!())?;
        }
        Ok(())
    }
}

pub(super) async fn ensure_root(config: &Config) -> Result<()> {
    let root = root(config);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(MESSENGER_MEDIA_CACHE_DIR_MODE);
    builder.create(&root).await.c(h!())?;
    fs::set_permissions(
        &root,
        std::fs::Permissions::from_mode(MESSENGER_MEDIA_CACHE_DIR_MODE),
    )
    .await
    .c(h!())
}

pub(super) async fn try_lock(path: &Path) -> Result<Option<FileLock>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .c(h!())?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(FileLock(file))),
            Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error).c(h!()),
        }
    })
    .await
    .c(h!())?
    .c(h!())
}

async fn lock(path: &Path) -> Result<FileLock> {
    let started = tokio::time::Instant::now();
    loop {
        if let Some(lock) = try_lock(path).await.c(h!())? {
            return Ok(lock);
        }
        if started.elapsed()
            >= Duration::from_millis(
                MESSENGER_MEDIA_LOCAL_CACHE_LOCK_WAIT_MILLIS,
            )
        {
            bail!("messenger media local cache is busy");
        }
        tokio::time::sleep(Duration::from_millis(
            MESSENGER_MEDIA_LOCAL_CACHE_LOCK_RETRY_MILLIS,
        ))
        .await;
    }
}

pub(super) async fn reserve(
    config: &Config,
    entry: &Entry,
    bytes: u64,
) -> Result<Reservation> {
    let _budget = lock(&entry.root.join("budget.lock")).await.c(h!())?;
    entry.clear_staging().await.c(h!())?;
    if check_capacity(config, &entry.root, bytes).await.is_err() {
        cleanup_unlocked(config).await.c(h!())?;
        check_capacity(config, &entry.root, bytes).await.c(h!())?;
    }
    let path = entry.path("reservation");
    write_private_file(&path, &bytes.to_le_bytes())
        .await
        .c(h!())?;
    Ok(Reservation(path))
}

async fn check_capacity(
    config: &Config,
    root: &Path,
    bytes: u64,
) -> Result<()> {
    let config_cache = settings(config).c(h!())?;
    let (used, reserved) = usage(root).await.c(h!())?;
    if used.saturating_add(reserved).saturating_add(bytes)
        > config_cache.max_total_size_bytes
    {
        return Err(CacheFull("messenger media local cache budget exhausted; protected originals were preserved").into());
    }
    let available = fs2::available_space(root).c(h!())?;
    if available
        < config_cache
            .min_free_space_bytes
            .saturating_add(reserved)
            .saturating_add(bytes)
    {
        return Err(CacheFull(
            "messenger media local cache free-space floor reached",
        )
        .into());
    }
    Ok(())
}

async fn usage(root: &Path) -> Result<(u64, u64)> {
    let mut entries = fs::read_dir(root).await.c(h!())?;
    let (mut used, mut reserved) = (0u64, 0u64);
    while let Some(entry) = entries.next_entry().await.c(h!())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".original") || name.ends_with(".playback.mp4") {
            used = used.saturating_add(entry.metadata().await.c(h!())?.len());
        } else if name.ends_with(".reservation") {
            let data = match fs::read(entry.path()).await {
                Ok(data) => data,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error).c(h!()),
            };
            if let Ok(bytes) = <[u8; 8]>::try_from(data) {
                reserved = reserved.saturating_add(u64::from_le_bytes(bytes));
            }
        }
    }
    Ok((used, reserved))
}

pub(super) async fn cleanup(config: &Config) -> Result<()> {
    ensure_root(config).await.c(h!())?;
    let _budget = lock(&root(config).join("budget.lock")).await.c(h!())?;
    cleanup_unlocked(config).await.c(h!())
}

async fn cleanup_unlocked(config: &Config) -> Result<()> {
    let mut paths = fs::read_dir(root(config)).await.c(h!())?;
    let mut visited = HashSet::new();
    while let Some(path) = paths.next_entry().await.c(h!())? {
        let name = path.file_name().to_string_lossy().into_owned();
        let Some((id, suffix)) = name.split_once('.') else {
            continue;
        };
        if suffix == "lock" || !visited.insert(id.to_string()) {
            continue;
        }
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let entry = Entry {
            root: root(config),
            id: id.to_string(),
            size: 0,
        };
        let Some(_lock) = try_lock(&entry.path("lock")).await.c(h!())? else {
            continue;
        };
        cleanup_entry(&entry).await.c(h!())?;
    }
    Ok(())
}

async fn cleanup_entry(entry: &Entry) -> Result<()> {
    let now = Utc::now().timestamp();
    let metadata = entry.metadata().await.c(h!())?;
    if metadata.is_none_or(|metadata| {
        metadata.retain_until <= now
            || (!metadata.committed
                && metadata.staged_at
                    + MESSENGER_MEDIA_LOCAL_CACHE_ORPHAN_TTL_SECS
                    <= now)
    }) {
        entry.remove().await.c(h!())?;
    } else {
        entry.clear_staging().await.c(h!())?;
    }
    Ok(())
}

pub(super) async fn valid_file(path: &Path, size: u64) -> Result<bool> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.is_file() && metadata.len() == size),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).c(h!()),
    }
}

pub(super) async fn create_private_file(path: &Path) -> Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
        .c(h!())
}

async fn write_private_file(path: &Path, data: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(MESSENGER_MEDIA_CACHE_FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .await
        .c(h!())?;
    file.write_all(data).await.c(h!())?;
    file.sync_all().await.c(h!())
}

pub(super) async fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).c(h!()),
    }
}

pub(super) async fn sync_directory(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::File::open(path).c(h!())?.sync_all().c(h!())
    })
    .await
    .c(h!())?
    .c(h!())
}
