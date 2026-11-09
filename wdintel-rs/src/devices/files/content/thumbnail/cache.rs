use anyhow::{Context, Result};
use std::collections::HashMap;
use std::future::Future;
use std::os::unix::fs::{
    DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::{Failure, Key};
use crate::devices::config::*;
use crate::h;
use crate::telemetry::Metrics;

#[derive(Clone)]
enum State {
    Pending,
    Ready(u64),
    Failed(Failure, Instant),
}

pub(super) struct Entry {
    path: PathBuf,
    state: Mutex<State>,
    last_used: Mutex<Instant>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Entry {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    fn reserved(&self) -> u64 {
        match *self.state.lock().unwrap_or_else(|error| error.into_inner()) {
            State::Pending => DEVICE_FILE_THUMBNAIL_MAX_BYTES,
            State::Ready(size) => size,
            State::Failed(..) => 0,
        }
    }

    fn removable(&self, now: Instant, idle: Duration) -> bool {
        match *self.state.lock().unwrap_or_else(|error| error.into_inner()) {
            State::Pending => false,
            State::Failed(_, retry_at) => now >= retry_at,
            State::Ready(_) => {
                now.duration_since(
                    *self
                        .last_used
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()),
                ) >= idle
            }
        }
    }
}

pub(super) enum Lookup {
    Ready(Arc<Entry>),
    Pending,
    Failed(Failure),
}

pub(super) struct Limits {
    pub max_bytes: u64,
    pub max_entries: usize,
    pub free_bytes: u64,
    pub idle: Duration,
    pub jobs: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: DEVICE_FILE_THUMBNAIL_CACHE_MAX_BYTES,
            max_entries: DEVICE_FILE_THUMBNAIL_CACHE_MAX_ENTRIES,
            free_bytes: DEVICE_FILE_THUMBNAIL_FREE_RESERVE_BYTES,
            idle: Duration::from_secs(DEVICE_FILE_THUMBNAIL_CACHE_TTL_SECS),
            jobs: DEVICE_FILE_THUMBNAIL_ACTIVE_JOBS
                + DEVICE_FILE_THUMBNAIL_QUEUED_JOBS,
        }
    }
}

pub(super) struct Cache {
    root: PathBuf,
    namespace: tempfile::TempDir,
    _owner: std::fs::File,
    limits: Limits,
    entries: Mutex<HashMap<Key, Arc<Entry>>>,
    jobs: Arc<Semaphore>,
    active: Arc<Semaphore>,
}

static CACHE: OnceLock<Arc<Cache>> = OnceLock::new();

pub(super) fn cache() -> Result<Arc<Cache>> {
    if let Some(cache) = CACHE.get() {
        return Ok(cache.clone());
    }
    let cache = Cache::new(
        std::env::temp_dir().join("echo-device-file-thumbnails"),
        Limits::default(),
    )
    .context(h!())?;
    if CACHE.set(cache.clone()).is_ok() {
        let weak = Arc::downgrade(&cache);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(
                    DEVICE_FILE_THUMBNAIL_CLEANUP_INTERVAL_SECS,
                ))
                .await;
                let Some(cache) = weak.upgrade() else { break };
                if let Err(error) = cache.cleanup() {
                    log::warn!("device thumbnail cleanup failed: {error:#}");
                }
            }
        });
    }
    Ok(CACHE.get().context(h!())?.clone())
}

impl Cache {
    pub(super) fn new(root: PathBuf, limits: Limits) -> Result<Arc<Self>> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .context(h!())?;
        let metadata = std::fs::symlink_metadata(&root).context(h!())?;
        anyhow::ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "Invalid thumbnail cache root"
        );
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .context(h!())?;
        let janitor = lock_file(&root.join("janitor.lock")).context(h!())?;
        fs2::FileExt::lock_exclusive(&janitor).context(h!())?;
        let namespace = tempfile::Builder::new()
            .prefix("owner-")
            .tempdir_in(&root)
            .context(h!())?;
        std::fs::set_permissions(
            namespace.path(),
            std::fs::Permissions::from_mode(0o700),
        )
        .context(h!())?;
        let owner =
            lock_file(&namespace.path().join("owner.lock")).context(h!())?;
        fs2::FileExt::lock_exclusive(&owner).context(h!())?;
        let cache = Arc::new(Self {
            root,
            namespace,
            _owner: owner,
            jobs: Arc::new(Semaphore::new(limits.jobs)),
            active: Arc::new(Semaphore::new(DEVICE_FILE_THUMBNAIL_ACTIVE_JOBS)),
            limits,
            entries: Mutex::new(HashMap::new()),
        });
        drop(janitor);
        cache.cleanup().context(h!())?;
        Ok(cache)
    }

    pub(super) fn request<F, Fut>(
        self: &Arc<Self>,
        key: Key,
        metrics: Option<Metrics>,
        generate: F,
    ) -> Lookup
    where
        F: FnOnce(PathBuf) -> Fut + Send + 'static,
        Fut: Future<Output = Result<u64, Failure>> + Send + 'static,
    {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(entry) = entries.get(&key) {
            let state = entry
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            match state {
                State::Pending => return Lookup::Pending,
                State::Ready(_) if entry.path.is_file() => {
                    *entry
                        .last_used
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) =
                        Instant::now();
                    event(&metrics, "thumbnail_hit");
                    return Lookup::Ready(entry.clone());
                }
                State::Failed(failure, retry_at)
                    if Instant::now() < retry_at =>
                {
                    return Lookup::Failed(failure)
                }
                _ => {
                    entries.remove(&key);
                }
            }
        }
        event(&metrics, "thumbnail_miss");
        let Ok(slot) = self.jobs.clone().try_acquire_owned() else {
            event(&metrics, "thumbnail_capacity");
            return Lookup::Failed(Failure::Transient);
        };
        self.evict(&mut entries, DEVICE_FILE_THUMBNAIL_MAX_BYTES);
        let reserved: u64 =
            entries.values().map(|entry| entry.reserved()).sum();
        if entries.len() >= self.limits.max_entries
            || reserved.saturating_add(DEVICE_FILE_THUMBNAIL_MAX_BYTES)
                > self.limits.max_bytes
        {
            event(&metrics, "thumbnail_capacity");
            return Lookup::Failed(Failure::Transient);
        }
        let entry = Arc::new(Entry {
            path: self
                .namespace
                .path()
                .join(format!("{}.jpg", Uuid::new_v4())),
            state: Mutex::new(State::Pending),
            last_used: Mutex::new(Instant::now()),
        });
        entries.insert(key, entry.clone());
        event(&metrics, "thumbnail_queued");
        drop(entries);
        let cache = self.clone();
        tokio::spawn(async move {
            let _slot = slot;
            cache.run_job(key, entry, metrics, generate).await;
        });
        Lookup::Pending
    }

    async fn run_job<F, Fut>(
        &self,
        key: Key,
        entry: Arc<Entry>,
        metrics: Option<Metrics>,
        generate: F,
    ) where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<u64, Failure>>,
    {
        let guard = JobGuard(entry.clone());
        let Ok(_active) = self.active.acquire().await else {
            return;
        };
        let started = Instant::now();
        let enough_space = fs2::available_space(self.namespace.path())
            .is_ok_and(|available| {
                available
                    >= self
                        .limits
                        .free_bytes
                        .saturating_add(key.size)
                        .saturating_add(DEVICE_FILE_THUMBNAIL_MAX_BYTES)
            });
        let result = if enough_space {
            generate(entry.path.clone()).await
        } else {
            event(&metrics, "thumbnail_capacity");
            Err(Failure::Transient)
        };
        let state = completed_state(result, &metrics);
        if let Some(metrics) = &metrics {
            metrics.record_device_file_thumbnail_duration(started.elapsed());
        }
        if !matches!(state, State::Ready(_)) {
            let _ = tokio::fs::remove_file(&entry.path).await;
        }
        log::debug!(
            "device thumbnail job seconds={} ready={}",
            started.elapsed().as_secs_f64(),
            matches!(state, State::Ready(_))
        );
        *entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = state;
        drop(guard);
    }

    fn evict(&self, entries: &mut HashMap<Key, Arc<Entry>>, needed: u64) {
        let mut reserved: u64 =
            entries.values().map(|entry| entry.reserved()).sum();
        if entries.len() < self.limits.max_entries
            && reserved.saturating_add(needed) <= self.limits.max_bytes
        {
            return;
        }
        let mut candidates = entries
            .iter()
            .filter(|(_, entry)| {
                Arc::strong_count(entry) == 1
                    && !matches!(
                        *entry
                            .state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner()),
                        State::Pending
                    )
            })
            .map(|(key, entry)| {
                (
                    *key,
                    *entry
                        .last_used
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()),
                )
            })
            .collect::<Vec<_>>();
        candidates.sort_unstable_by_key(|(_, used)| *used);
        for (key, _) in candidates {
            if entries.len() < self.limits.max_entries
                && reserved.saturating_add(needed) <= self.limits.max_bytes
            {
                break;
            }
            if let Some(entry) = entries.remove(&key) {
                reserved = reserved.saturating_sub(entry.reserved());
            }
        }
    }

    pub(super) fn invalidate(&self, key: &Key, entry: &Arc<Entry>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if entries
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            entries.remove(key);
        }
    }

    fn cleanup(&self) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        entries.retain(|_, entry| {
            Arc::strong_count(entry) > 1
                || !entry.removable(now, self.limits.idle)
        });
        drop(entries);
        clean_dead_namespaces(&self.root, self.namespace.path()).context(h!())
    }
}

fn completed_state(
    result: Result<u64, Failure>,
    metrics: &Option<Metrics>,
) -> State {
    let (failure, seconds) = match result {
        Ok(size) if size > 0 && size <= DEVICE_FILE_THUMBNAIL_MAX_BYTES => {
            event(metrics, "thumbnail_generated");
            return State::Ready(size);
        }
        Ok(_) | Err(Failure::Terminal) => {
            event(metrics, "thumbnail_failed");
            (Failure::Terminal, DEVICE_FILE_THUMBNAIL_FAILED_TTL_SECS)
        }
        Err(failure) => {
            event(metrics, "thumbnail_retry");
            (
                failure,
                if failure == Failure::Access {
                    0
                } else {
                    DEVICE_FILE_THUMBNAIL_TRANSIENT_TTL_SECS
                },
            )
        }
    };
    State::Failed(failure, Instant::now() + Duration::from_secs(seconds))
}

struct JobGuard(Arc<Entry>);

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if matches!(*state, State::Pending) {
            *state = State::Failed(Failure::Transient, Instant::now());
        }
    }
}

fn event(metrics: &Option<Metrics>, event: &'static str) {
    if let Some(metrics) = metrics {
        metrics.record_device_file_preview_event(event);
    }
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

fn clean_dead_namespaces(root: &Path, own: &Path) -> Result<()> {
    let janitor = lock_file(&root.join("janitor.lock")).context(h!())?;
    if fs2::FileExt::try_lock_exclusive(&janitor).is_err() {
        return Ok(());
    }
    let mut remaining = DEVICE_FILE_THUMBNAIL_CLEANUP_BATCH;
    for directory in std::fs::read_dir(root).context(h!())? {
        let directory = directory.context(h!())?;
        if remaining == 0 {
            break;
        }
        if directory.path() == own
            || !directory
                .file_name()
                .to_string_lossy()
                .starts_with("owner-")
            || !directory.file_type().context(h!())?.is_dir()
        {
            continue;
        }
        let owner =
            lock_file(&directory.path().join("owner.lock")).context(h!())?;
        if fs2::FileExt::try_lock_exclusive(&owner).is_err() {
            continue;
        }
        let mut retained = false;
        for file in std::fs::read_dir(directory.path()).context(h!())? {
            let file = file.context(h!())?;
            if file.file_name() == "owner.lock" {
                continue;
            }
            if remaining == 0 || file.file_type().context(h!())?.is_dir() {
                retained = true;
                continue;
            }
            std::fs::remove_file(file.path()).context(h!())?;
            remaining -= 1;
        }
        if !retained {
            std::fs::remove_file(directory.path().join("owner.lock"))
                .context(h!())?;
            std::fs::remove_dir(directory.path()).context(h!())?;
        }
    }
    Ok(())
}
