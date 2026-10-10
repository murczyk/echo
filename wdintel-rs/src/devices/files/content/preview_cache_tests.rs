use super::*;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

fn source(bytes: &[u8]) -> CacheKey {
    CacheKey {
        device_id: Uuid::new_v4(),
        file_id: Uuid::new_v4(),
        revision: 1,
        object_key: Uuid::new_v4().to_string(),
        sha256: Sha256::digest(bytes).into(),
        size: bytes.len() as u64,
        version: DEVICE_FILE_PREVIEW_MEDIA_CACHE_VERSION,
    }
}

fn cache(root: &Path, max_bytes: u64, wait: Duration) -> Arc<PreviewCache> {
    PreviewCache::new(
        root.to_path_buf(),
        CacheLimits {
            max_bytes,
            max_entries: 2,
            free_reserve_bytes: 0,
            idle_ttl: Duration::ZERO,
            wait,
            cleanup_batch: 100,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn cache_rejects_hash_and_size_corruption_without_publishing_plaintext() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 100, Duration::from_secs(2));
    for bytes in [b"wrong".to_vec(), b"too long".to_vec()] {
        let key = source(b"right");
        assert!(cache.read(key, async move { Ok(bytes) }).await.is_err());
        assert_eq!(cache.state.lock().unwrap().entries.len(), 0);
        let files = std::fs::read_dir(cache.namespace.path()).unwrap().count();
        assert_eq!(files, 1, "only the owner lock may remain after rejection");
    }
    let lease = cache
        .read(source(b"right"), async { Ok(b"right".to_vec()) })
        .await
        .unwrap();
    assert_eq!(std::fs::read(lease.path()).unwrap(), b"right");
}

#[tokio::test]
async fn cache_single_flight_survives_a_canceled_reader() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 100, Duration::from_secs(2));
    let key = source(b"secret");
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let first = {
        let cache = cache.clone();
        let key = key.clone();
        let entered = entered.clone();
        let release = release.clone();
        tokio::spawn(async move {
            cache
                .read(key, async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(b"secret".to_vec())
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    first.abort();
    let second = {
        let cache = cache.clone();
        let key = key.clone();
        tokio::spawn(async move {
            cache
                .read(key, async {
                    panic!("joined reader must not populate twice")
                })
                .await
        })
    };
    release.notify_one();
    let lease = second.await.unwrap().unwrap();
    assert_eq!(std::fs::read(lease.path()).unwrap(), b"secret");
    assert_eq!(
        std::fs::metadata(lease.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(cache.namespace.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[tokio::test]
async fn cache_admission_keeps_live_lease_and_counts_pending_reservation() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 6, Duration::from_secs(2));
    let lease = cache
        .read(source(b"secret"), async { Ok(b"secret".to_vec()) })
        .await
        .unwrap();
    let path = lease.path().to_owned();
    assert!(cache
        .read(source(b"next"), async { Ok(b"next".to_vec()) })
        .await
        .is_err());
    cache.cleanup().unwrap();
    assert!(path.exists());
    drop(lease);
    let next = cache
        .read(source(b"next"), async { Ok(b"next".to_vec()) })
        .await
        .unwrap();
    assert_eq!(std::fs::read(next.path()).unwrap(), b"next");
    assert!(!path.exists());
}

#[tokio::test]
async fn cache_entry_limit_denies_without_starting_another_population() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 100, Duration::from_secs(2));
    let first = cache
        .read(source(b"first"), async { Ok(b"first".to_vec()) })
        .await
        .unwrap();
    let second = cache
        .read(source(b"second"), async { Ok(b"second".to_vec()) })
        .await
        .unwrap();
    let third = source(b"third");
    assert!(cache
        .read(third.clone(), async {
            panic!("entry admission must precede population")
        })
        .await
        .is_err());
    assert_eq!(cache.state.lock().unwrap().entries.len(), 2);
    assert_eq!(cache.busy.load(Ordering::Relaxed), 1);
    drop(first);
    let third = cache
        .read(third, async { Ok(b"third".to_vec()) })
        .await
        .unwrap();
    assert_eq!(std::fs::read(third.path()).unwrap(), b"third");
    assert_eq!(std::fs::read(second.path()).unwrap(), b"second");
}

#[tokio::test]
async fn cache_deadline_keeps_population_slot_until_blocking_work_finishes() {
    let root = tempfile::tempdir().unwrap();
    let cache = cache(root.path(), 100, Duration::from_millis(10));
    let entered = Arc::new(Notify::new());
    let barrier =
        Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let key = source(b"secret");
    let pending = {
        let cache = cache.clone();
        let key = key.clone();
        let entered = entered.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            cache
                .read(key, async move {
                    tokio::task::spawn_blocking(move || {
                        entered.notify_one();
                        let (mutex, changed) = &*barrier;
                        let mut ready = mutex.lock().unwrap();
                        while !*ready {
                            ready = changed.wait(ready).unwrap();
                        }
                        b"secret".to_vec()
                    })
                    .await
                    .context(h!())
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    assert!(pending.await.unwrap().is_err());
    assert_eq!(cache.population.available_permits(), 0);
    assert_eq!(
        cache
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .map(|entry| entry.size)
            .sum::<u64>(),
        6
    );
    assert!(cache
        .read(source(b"next"), async { Ok(b"next".to_vec()) })
        .await
        .is_err());
    {
        let (mutex, changed) = &*barrier;
        *mutex.lock().unwrap() = true;
        changed.notify_one();
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        let permit = cache.population.acquire().await.unwrap();
        drop(permit);
    })
    .await
    .unwrap();
    assert_eq!(cache.state.lock().unwrap().entries.len(), 0);
}

#[tokio::test]
async fn cache_janitor_skips_live_owner_and_removes_dead_namespace() {
    let root = tempfile::tempdir().unwrap();
    let orphan = root.path().join("owner-orphan");
    std::fs::create_dir(&orphan).unwrap();
    let owner = owner_lock(&orphan).unwrap();
    fs2::FileExt::lock_exclusive(&owner).unwrap();
    std::fs::write(orphan.join("data"), b"retained").unwrap();
    let cache = cache(root.path(), 100, Duration::from_secs(2));
    cache.cleanup().unwrap();
    assert!(orphan.join("data").exists());
    fs2::FileExt::unlock(&owner).unwrap();
    cache.cleanup().unwrap();
    assert!(!orphan.exists());
}

#[tokio::test]
async fn cache_admission_includes_retained_dead_owner_bytes() {
    let root = tempfile::tempdir().unwrap();
    let orphan = root.path().join("owner-orphan");
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("data"), b"retained").unwrap();
    let cache = PreviewCache::new(
        root.path().to_owned(),
        CacheLimits {
            max_bytes: 10,
            max_entries: 2,
            free_reserve_bytes: 0,
            idle_ttl: Duration::ZERO,
            wait: Duration::from_secs(2),
            cleanup_batch: 0,
        },
    )
    .unwrap();
    assert!(cache
        .read(source(b"secret"), async { Ok(b"secret".to_vec()) })
        .await
        .is_err());
    assert_eq!(std::fs::read(orphan.join("data")).unwrap(), b"retained");
    assert_eq!(cache.state.lock().unwrap().entries.len(), 0);
}

#[tokio::test]
async fn cache_reserves_free_disk_before_starting_population() {
    let root = tempfile::tempdir().unwrap();
    let cache = PreviewCache::new(
        root.path().to_owned(),
        CacheLimits {
            max_bytes: 100,
            max_entries: 2,
            free_reserve_bytes: u64::MAX,
            idle_ttl: Duration::ZERO,
            wait: Duration::from_secs(2),
            cleanup_batch: 100,
        },
    )
    .unwrap();
    assert!(cache
        .read(source(b"secret"), async {
            panic!("free-space denial must precede population")
        })
        .await
        .is_err());
    assert_eq!(cache.state.lock().unwrap().entries.len(), 0);
}
