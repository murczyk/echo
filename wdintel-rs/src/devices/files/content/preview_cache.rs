use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::os::unix::fs::{
    DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::devices::config::*;
use crate::h;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct CacheKey {
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub object_key: String,
    pub sha256: [u8; 32],
    pub size: u64,
    pub version: u32,
}

struct CacheLimits {
    max_bytes: u64,
    max_entries: usize,
    free_reserve_bytes: u64,
    idle_ttl: Duration,
    wait: Duration,
    cleanup_batch: usize,
}

impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            max_bytes: DEVICE_FILE_PREVIEW_MEDIA_CACHE_MAX_BYTES,
            max_entries: DEVICE_FILE_PREVIEW_MEDIA_CACHE_MAX_ENTRIES,
            free_reserve_bytes:
                DEVICE_FILE_PREVIEW_MEDIA_CACHE_FREE_RESERVE_BYTES,
            idle_ttl: Duration::from_secs(
                DEVICE_FILE_PREVIEW_MEDIA_CACHE_IDLE_TTL_SECS,
            ),
            wait: Duration::from_secs(
                DEVICE_FILE_PREVIEW_MEDIA_POPULATION_TIMEOUT_SECS,
            ),
            cleanup_batch: DEVICE_FILE_PREVIEW_MEDIA_CACHE_CLEANUP_BATCH_SIZE,
        }
    }
}

#[derive(Clone)]
enum Population {
    Pending,
    Ready,
    Failed { message: String, busy: bool },
}

struct Entry {
    path: PathBuf,
    partial: PathBuf,
    status: watch::Sender<Population>,
    last_used: Mutex<Instant>,
    size: u64,
}

impl Drop for Entry {
    fn drop(&mut self) {
        for path in [&self.path, &self.partial] {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "device file media cache file cleanup failed: {error}"
                    );
                }
            }
        }
    }
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<CacheKey, Arc<Entry>>,
}

pub(super) struct PreviewCache {
    root: PathBuf,
    namespace: tempfile::TempDir,
    _owner: std::fs::File,
    limits: CacheLimits,
    state: Mutex<CacheState>,
    population: Arc<Semaphore>,
    background_running: AtomicBool,
    hits: AtomicU64,
    misses: AtomicU64,
    busy: AtomicU64,
}

pub(super) struct CacheLease {
    entry: Arc<Entry>,
}

impl CacheLease {
    pub(super) fn path(&self) -> &Path {
        &self.entry.path
    }
}

impl Drop for CacheLease {
    fn drop(&mut self) {
        if let Ok(mut last_used) = self.entry.last_used.lock() {
            *last_used = Instant::now();
        }
    }
}

#[derive(Debug)]
pub(super) struct CacheBusy;

impl std::fmt::Display for CacheBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Device media cache is busy or unavailable")
    }
}

impl std::error::Error for CacheBusy {}

static CACHE: OnceLock<Arc<PreviewCache>> = OnceLock::new();

pub(super) fn cache() -> Result<Arc<PreviewCache>> {
    if let Some(cache) = CACHE.get() {
        cache.start_cleanup();
        return Ok(cache.clone());
    }
    let cache = PreviewCache::new(
        std::env::temp_dir().join("echo-device-file-preview-media"),
        CacheLimits::default(),
    )
    .context(h!())?;
    let _ = CACHE.set(cache);
    let cache = CACHE.get().context(h!())?.clone();
    cache.start_cleanup();
    Ok(cache)
}

impl PreviewCache {
    fn new(root: PathBuf, limits: CacheLimits) -> Result<Arc<Self>> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .context(h!())?;
        let metadata = std::fs::symlink_metadata(&root).context(h!())?;
        anyhow::ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "Invalid media cache root owner"
        );
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .context(h!())?;
        let namespace = tempfile::Builder::new()
            .prefix("owner-")
            .tempdir_in(&root)
            .context(h!())?;
        std::fs::set_permissions(
            namespace.path(),
            std::fs::Permissions::from_mode(0o700),
        )
        .context(h!())?;
        let owner = owner_lock(namespace.path()).context(h!())?;
        fs2::FileExt::lock_exclusive(&owner).context(h!())?;
        let cache = Arc::new(Self {
            root,
            namespace,
            _owner: owner,
            limits,
            state: Mutex::new(CacheState::default()),
            population: Arc::new(Semaphore::new(1)),
            background_running: AtomicBool::new(false),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            busy: AtomicU64::new(0),
        });
        cache.cleanup().context(h!())?;
        Ok(cache)
    }

    pub(super) async fn read<F>(
        self: &Arc<Self>,
        key: CacheKey,
        populate: F,
    ) -> Result<CacheLease>
    where
        F: Future<Output = Result<Vec<u8>>> + Send + 'static,
    {
        let entry = self
            .reserve(&key, populate)
            .inspect_err(|error| {
                if error.downcast_ref::<CacheBusy>().is_some() {
                    self.busy.fetch_add(1, Ordering::Relaxed);
                }
            })
            .context(h!())?;
        let mut status = entry.status.subscribe();
        let wait = async {
            loop {
                let population = status.borrow().clone();
                match population {
                    Population::Ready => {
                        return Ok(CacheLease {
                            entry: entry.clone(),
                        })
                    }
                    Population::Failed { busy: true, .. } => {
                        return Err(CacheBusy.into())
                    }
                    Population::Failed { message, .. } => {
                        anyhow::bail!(message)
                    }
                    Population::Pending => {
                        status.changed().await.context(h!())?
                    }
                }
            }
        };
        let result = tokio::time::timeout(self.limits.wait, wait)
            .await
            .map_err(|_| {
                self.busy.fetch_add(1, Ordering::Relaxed);
                anyhow::Error::new(CacheBusy)
            })
            .context(h!())?;
        if result
            .as_ref()
            .is_err_and(|error| error.downcast_ref::<CacheBusy>().is_some())
        {
            self.busy.fetch_add(1, Ordering::Relaxed);
        }
        result
    }

    fn reserve<F>(
        self: &Arc<Self>,
        key: &CacheKey,
        populate: F,
    ) -> Result<Arc<Entry>>
    where
        F: Future<Output = Result<Vec<u8>>> + Send + 'static,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("media cache lock poisoned"))
            .context(h!())?;
        if let Some(entry) = state.entries.get(key) {
            self.hits.fetch_add(1, Ordering::Relaxed);
            *entry
                .last_used
                .lock()
                .map_err(|_| anyhow::anyhow!("media cache clock poisoned"))
                .context(h!())? = Instant::now();
            return Ok(entry.clone());
        }
        let permit = self
            .population
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::Error::new(CacheBusy))
            .context(h!())?;
        let orphans = self
            .clean_orphans(&state)
            .map_err(|_| CacheBusy)
            .context(h!())?;
        self.admit(&mut state, key.size, orphans).context(h!())?;
        let entry = new_entry(self.namespace.path(), key.size);
        state.entries.insert(key.clone(), entry.clone());
        self.misses.fetch_add(1, Ordering::Relaxed);
        self.start_population(key.clone(), entry.clone(), populate, permit);
        Ok(entry)
    }

    fn start_population<F>(
        self: &Arc<Self>,
        key: CacheKey,
        entry: Arc<Entry>,
        populate: F,
        permit: OwnedSemaphorePermit,
    ) where
        F: Future<Output = Result<Vec<u8>>> + Send + 'static,
    {
        let cache = self.clone();
        tokio::spawn(async move {
            let result = cache.populate(&key, &entry, populate).await;
            match result {
                Ok(()) => {
                    entry.status.send_replace(Population::Ready);
                }
                Err(error) => {
                    entry.status.send_replace(Population::Failed {
                        message: error.to_string(),
                        busy: error.downcast_ref::<CacheBusy>().is_some(),
                    });
                    if let Ok(mut state) = cache.state.lock() {
                        state.entries.remove(&key);
                    }
                }
            }
            drop(entry);
            drop(permit);
        });
    }

    fn admit(
        &self,
        state: &mut CacheState,
        size: u64,
        orphans: u64,
    ) -> Result<()> {
        let available = fs2::available_space(&self.root)
            .map_err(|_| CacheBusy)
            .context(h!())?;
        if size > self.limits.max_bytes
            || available < size.saturating_add(self.limits.free_reserve_bytes)
        {
            return Err(CacheBusy).context(h!());
        }
        loop {
            let used =
                state.entries.values().map(|entry| entry.size).sum::<u64>();
            if used.saturating_add(orphans).saturating_add(size)
                <= self.limits.max_bytes
                && state.entries.len() < self.limits.max_entries
            {
                return Ok(());
            }
            let oldest = state
                .entries
                .iter()
                .filter(|(_, entry)| Arc::strong_count(entry) == 1)
                .min_by_key(|(_, entry)| {
                    entry
                        .last_used
                        .lock()
                        .map(|clock| *clock)
                        .unwrap_or_else(|_| Instant::now())
                })
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                return Err(CacheBusy).context(h!());
            };
            state.entries.remove(&oldest);
        }
    }

    async fn populate<F>(
        &self,
        key: &CacheKey,
        entry: &Arc<Entry>,
        populate: F,
    ) -> Result<()>
    where
        F: Future<Output = Result<Vec<u8>>> + Send + 'static,
    {
        let started = Instant::now();
        let bytes = populate.await.context(h!())?;
        if started.elapsed() >= self.limits.wait {
            return Err(CacheBusy).context(h!());
        }
        let key = key.clone();
        let entry = entry.clone();
        tokio::task::spawn_blocking(move || publish_file(&key, &entry, &bytes))
            .await
            .context(h!())?
            .context(h!())?;
        if started.elapsed() >= self.limits.wait {
            return Err(CacheBusy).context(h!());
        }
        Ok(())
    }

    fn cleanup(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("media cache lock poisoned"))
            .context(h!())?;
        let expired = state
            .entries
            .iter()
            .filter(|(_, entry)| {
                Arc::strong_count(entry) == 1
                    && entry.last_used.lock().is_ok_and(|clock| {
                        clock.elapsed() >= self.limits.idle_ttl
                    })
            })
            .take(self.limits.cleanup_batch)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired {
            state.entries.remove(&key);
        }
        let orphans = self.clean_orphans(&state).context(h!())?;
        let reserved = state
            .entries
            .values()
            .filter(|entry| {
                matches!(*entry.status.borrow(), Population::Pending)
            })
            .collect::<Vec<_>>();
        log::debug!("device media cache entries={} bytes={} orphan_bytes={} reservations={} reserved_bytes={} hits={} misses={} busy={}", state.entries.len(),
            state.entries.values().map(|entry| entry.size).sum::<u64>(), orphans,
            reserved.len(), reserved.iter().map(|entry| entry.size).sum::<u64>(),
            self.hits.load(Ordering::Relaxed), self.misses.load(Ordering::Relaxed), self.busy.load(Ordering::Relaxed));
        Ok(())
    }

    fn clean_orphans(&self, state: &CacheState) -> Result<u64> {
        let janitor =
            lock_file(&self.root.join("janitor.lock")).context(h!())?;
        fs2::FileExt::lock_exclusive(&janitor).context(h!())?;
        let mut budget = self.limits.cleanup_batch;
        let mut bytes = 0u64;
        let active = state
            .entries
            .values()
            .flat_map(|entry| [entry.path.clone(), entry.partial.clone()])
            .collect::<HashSet<_>>();
        bytes = bytes.saturating_add(
            clean_files(self.namespace.path(), &active, &mut budget)
                .context(h!())?,
        );
        for directory in std::fs::read_dir(&self.root).context(h!())? {
            let directory = directory.context(h!())?;
            if directory.path() == self.namespace.path()
                || !directory
                    .file_name()
                    .to_string_lossy()
                    .starts_with("owner-")
                || !directory.file_type().context(h!())?.is_dir()
            {
                continue;
            }
            bytes = bytes.saturating_add(
                clean_dead_namespace(&directory.path(), &mut budget)
                    .context(h!())?,
            );
        }
        Ok(bytes)
    }

    fn start_cleanup(self: &Arc<Self>) {
        if self.background_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let guard = BackgroundGuard(self.clone());
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(
                DEVICE_FILE_PREVIEW_MEDIA_CACHE_CLEANUP_INTERVAL_SECS,
            ));
            loop {
                interval.tick().await;
                if let Err(error) = guard.0.cleanup() {
                    log::warn!("device media cache cleanup failed: {error:#}");
                }
            }
        });
    }
}

fn new_entry(directory: &Path, size: u64) -> Arc<Entry> {
    let filename = Uuid::new_v4().to_string();
    let (status, _) = watch::channel(Population::Pending);
    Arc::new(Entry {
        path: directory.join(format!("{filename}.plain")),
        partial: directory.join(format!("{filename}.partial")),
        status,
        last_used: Mutex::new(Instant::now()),
        size,
    })
}

fn clean_dead_namespace(directory: &Path, budget: &mut usize) -> Result<u64> {
    let owner = match owner_lock(directory) {
        Ok(owner) => owner,
        Err(error) if io_not_found(&error) => return Ok(0),
        Err(error) => return Err(error).context(h!()),
    };
    match fs2::FileExt::try_lock_exclusive(&owner) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            return Ok(0)
        }
        Err(error) => return Err(error).context(h!()),
    }
    let retained =
        clean_files(directory, &HashSet::new(), budget).context(h!())?;
    if retained == 0 {
        let _ = std::fs::remove_file(directory.join("owner.lock"));
        let _ = std::fs::remove_dir(directory);
    }
    Ok(retained)
}

struct BackgroundGuard(Arc<PreviewCache>);

impl Drop for BackgroundGuard {
    fn drop(&mut self) {
        self.0.background_running.store(false, Ordering::Release);
    }
}

fn publish_file(key: &CacheKey, entry: &Entry, bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.len() as u64 == key.size,
        "Device media source size mismatch"
    );
    anyhow::ensure!(
        <[u8; 32]>::from(Sha256::digest(bytes)) == key.sha256,
        "Device media source hash mismatch"
    );
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&entry.partial)
        .map_err(|_| CacheBusy)
        .context(h!())?;
    file.write_all(bytes).map_err(|_| CacheBusy).context(h!())?;
    file.sync_all().map_err(|_| CacheBusy).context(h!())?;
    std::fs::rename(&entry.partial, &entry.path)
        .map_err(|_| CacheBusy)
        .context(h!())
}

fn clean_files(
    directory: &Path,
    active: &HashSet<PathBuf>,
    budget: &mut usize,
) -> Result<u64> {
    let mut retained = 0u64;
    for file in std::fs::read_dir(directory).context(h!())? {
        let file = file.context(h!())?;
        if file.file_name() == "owner.lock" || active.contains(&file.path()) {
            continue;
        }
        let metadata = file.metadata().context(h!())?;
        if metadata.is_dir() {
            continue;
        }
        if *budget > 0 && std::fs::remove_file(file.path()).is_ok() {
            *budget -= 1;
        } else {
            retained = retained.saturating_add(metadata.len());
        }
    }
    Ok(retained)
}

fn io_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn owner_lock(directory: &Path) -> Result<std::fs::File> {
    lock_file(&directory.join("owner.lock")).context(h!())
}

fn lock_file(path: &Path) -> Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .context(h!())
}

#[cfg(test)]
#[path = "preview_cache_tests.rs"]
mod tests;
