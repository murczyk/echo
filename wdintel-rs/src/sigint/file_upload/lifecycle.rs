use crate::config::{
    SIGINT_FILE_UPLOAD_DIRECTORY_CLEANUP_BATCH,
    SIGINT_FILE_UPLOAD_FREE_SPACE_RESERVE_BYTES,
    SIGINT_FILE_UPLOAD_LOCK_RETRY_MS, SIGINT_FILE_UPLOAD_LOCK_TIMEOUT_MS,
};
use crate::error::AppError;
use crate::types::*;
use base64::Engine;
use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;

pub(crate) struct UploadLock(File);

impl UploadLock {
    pub(super) async fn run<T: Send + 'static>(
        self,
        operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        tokio::task::spawn_blocking(move || {
            let _lock = self;
            operation()
        })
        .await
        .c(h!())?
        .c(h!())
    }

    pub(super) async fn acquire(
        root: &Path,
        file_id: Uuid,
    ) -> anyhow::Result<Self> {
        let name = file_id.to_string();
        acquire_named(root, &name).await.c(h!())
    }

    fn try_acquire(root: &Path, file_id: Uuid) -> anyhow::Result<Option<Self>> {
        try_lock(root, &file_id.to_string()).c(h!())
    }
}

impl Drop for UploadLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

fn try_lock(root: &Path, name: &str) -> anyhow::Result<Option<UploadLock>> {
    let directory = root.join("locks");
    std::fs::create_dir_all(&directory).c(h!())?;
    anyhow::ensure!(
        std::fs::symlink_metadata(&directory).c(h!())?.is_dir(),
        "invalid upload lock directory"
    );
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join(name))
        .c(h!())?;
    anyhow::ensure!(
        file.metadata().c(h!())?.is_file(),
        "invalid upload lock file"
    );
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(UploadLock(file))),
        Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error).c(h!()),
    }
}

async fn acquire_named(root: &Path, name: &str) -> anyhow::Result<UploadLock> {
    let deadline = Instant::now()
        + Duration::from_millis(SIGINT_FILE_UPLOAD_LOCK_TIMEOUT_MS);
    loop {
        if let Some(lock) = try_lock(root, name).c(h!())? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err(AppError::ServiceUnavailable {
                msg: "attachment upload is busy; retry the request".to_string(),
                retry_after_secs: 1,
            }
            .into());
        }
        tokio::time::sleep(Duration::from_millis(
            SIGINT_FILE_UPLOAD_LOCK_RETRY_MS,
        ))
        .await;
    }
}

pub(super) async fn admission_lock(root: &Path) -> anyhow::Result<UploadLock> {
    acquire_named(root, "admission").await.c(h!())
}

pub(super) async fn admit(
    root: &Path,
    requested_bytes: u64,
) -> anyhow::Result<UploadLock> {
    let lock = admission_lock(root).await.c(h!())?;
    let root_copy = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let free_bytes = fs2::available_space(&root_copy).c(h!())?;
        ensure_capacity(requested_bytes, free_bytes).c(h!())?;
        Ok::<_, anyhow::Error>(lock)
    })
    .await
    .c(h!())?
    .c(h!())
}

async fn prune_empty_login_directories(root: &Path) -> anyhow::Result<()> {
    let root_copy = root.to_path_buf();
    let directories =
        tokio::task::spawn_blocking(move || login_directories(&root_copy))
            .await
            .c(h!())?
            .c(h!())?;
    for directories in
        directories.chunks(SIGINT_FILE_UPLOAD_DIRECTORY_CLEANUP_BATCH)
    {
        let directories = directories.to_vec();
        admission_lock(root)
            .await
            .c(h!())?
            .run(move || {
                for directory in directories {
                    remove_empty_directory(&directory).c(h!())?;
                }
                Ok(())
            })
            .await
            .c(h!())?;
    }
    Ok(())
}

fn login_directories(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut directories = Vec::new();
    for state in ["pending", "completed"] {
        let entries = match std::fs::read_dir(root.join(state)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error).c(h!()),
        };
        for entry in entries {
            let entry = entry.c(h!())?;
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => directories.push(entry.path()),
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error).c(h!()),
            }
        }
    }
    Ok(directories)
}

pub(super) fn remove_empty_directory(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error).c(h!()),
    }
}

fn ensure_capacity(
    requested_bytes: u64,
    free_bytes: u64,
) -> anyhow::Result<()> {
    let fits = requested_bytes
        .checked_add(SIGINT_FILE_UPLOAD_FREE_SPACE_RESERVE_BYTES)
        .is_some_and(|bytes| bytes <= free_bytes);
    if !fits {
        return Err(AppError::ServiceUnavailable {
            msg: "attachment upload capacity is exhausted; finish or remove pending uploads".to_string(),
            retry_after_secs: 60,
        }.into());
    }
    Ok(())
}

fn artifact_paths(root: &Path) -> anyhow::Result<Vec<(PathBuf, bool)>> {
    let mut paths = Vec::new();
    for directory in login_directories(root).c(h!())? {
        let pending = directory
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|state| state == "pending");
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error).c(h!()),
        };
        for entry in entries {
            paths.push((entry.c(h!())?.path(), pending));
        }
    }
    Ok(paths)
}

fn artifact_id(path: &Path) -> Option<(Uuid, u64)> {
    let name = path.file_name()?.to_str()?;
    let name = name.strip_suffix(".json").unwrap_or(name);
    let name = name.strip_prefix('.').unwrap_or(name);
    let fallback = name.ends_with(".fallback");
    let name = name.strip_suffix(".fallback").unwrap_or(name);
    super::tus::parse_request_file(name).or_else(|| {
        fallback
            .then(|| Uuid::try_parse(name).ok())
            .flatten()
            .map(|file_id| {
                (file_id, crate::config::SIGINT_FILE_UPLOAD_MAX_BYTES)
            })
    })
}

pub(super) async fn remove_artifacts(
    root: &Path,
    path: &Path,
) -> anyhow::Result<()> {
    let _admission = admission_lock(root).await.c(h!())?;
    remove_artifacts_locked(path).c(h!())
}

fn metadata_path(path: &Path) -> PathBuf {
    let mut path = path.as_os_str().to_os_string();
    path.push(".json");
    PathBuf::from(path)
}

fn remove_if_present(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).c(h!()),
    }
}

fn remove_artifacts_locked(path: &Path) -> anyhow::Result<()> {
    remove_if_present(path).c(h!())?;
    remove_if_present(&metadata_path(path)).c(h!())?;
    remove_empty_directory(path.parent().c(h!())?).c(h!())
}

pub(super) async fn cleanup(
    root: &Path,
    pending_ttl: Duration,
    completed_ttl: Duration,
) -> anyhow::Result<()> {
    prune_empty_login_directories(root).await.c(h!())?;
    let root_copy = root.to_path_buf();
    let paths = tokio::task::spawn_blocking(move || artifact_paths(&root_copy))
        .await
        .c(h!())?
        .c(h!())?;
    for (path, pending) in paths {
        let Some((file_id, _)) = artifact_id(&path) else {
            continue;
        };
        let Some(_lock) = UploadLock::try_acquire(root, file_id).c(h!())?
        else {
            continue;
        };
        let _admission = admission_lock(root).await.c(h!())?;
        let result = cleanup_artifact(
            &path,
            if pending { pending_ttl } else { completed_ttl },
        );
        if let Err(error) = result {
            log::error!(
                "failed to clean attachment upload {}: {error:?}",
                path.display()
            );
        }
    }
    Ok(())
}

fn cleanup_artifact(path: &Path, ttl: Duration) -> anyhow::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).c(h!()),
    };
    if path
        .extension()
        .is_some_and(|extension| extension == "json")
    {
        let source = path.with_extension("");
        if !source.try_exists().c(h!())? {
            remove_if_present(path).c(h!())?;
            remove_empty_directory(path.parent().c(h!())?).c(h!())?;
        }
    } else {
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .c(h!())?;
        if created + ttl <= SystemTime::now() {
            remove_artifacts_locked(path).c(h!())?;
        }
    }
    Ok(())
}

fn completed_source(path: &Path) -> Option<(&Path, Uuid)> {
    let (file_id, _) = artifact_id(path)?;
    let login_dir = path.parent()?;
    let completed_dir = login_dir.parent()?;
    let root = completed_dir.parent()?;
    if completed_dir
        .file_name()
        .is_none_or(|name| name != "completed")
        || root
            .file_name()
            .is_none_or(|name| name != "file_upload_tus")
        || login_dir
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(name)
                    .ok()
            })
            .is_none_or(|login| login.len() != 16)
    {
        return None;
    }
    Some((root, file_id))
}

pub(super) async fn lock_source(
    path: &Path,
) -> anyhow::Result<Option<UploadLock>> {
    let Some((root, file_id)) = completed_source(path) else {
        return Ok(None);
    };
    Ok(Some(UploadLock::acquire(root, file_id).await.c(h!())?))
}

pub(super) async fn remove_consumed(path: &Path) -> anyhow::Result<bool> {
    let Some((root, file_id)) = completed_source(path) else {
        return Ok(false);
    };
    let _lock = UploadLock::acquire(root, file_id).await.c(h!())?;
    remove_artifacts(root, path).await.c(h!())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_preserves_the_free_space_floor_without_overflow() {
        assert!(ensure_capacity(
            3,
            SIGINT_FILE_UPLOAD_FREE_SPACE_RESERVE_BYTES + 3
        )
        .is_ok());
        assert!(ensure_capacity(
            3,
            SIGINT_FILE_UPLOAD_FREE_SPACE_RESERVE_BYTES + 2
        )
        .is_err());
        assert!(ensure_capacity(u64::MAX, u64::MAX).is_err());
    }

    #[actix_web::test]
    async fn separate_handlers_share_persistent_locks_with_bounded_wait() {
        let directory = tempfile::tempdir().unwrap();
        let file_id = Uuid::from_u128(1);
        let first = UploadLock::acquire(directory.path(), file_id)
            .await
            .unwrap();
        let independent =
            UploadLock::acquire(directory.path(), Uuid::from_u128(257))
                .await
                .unwrap();
        drop(independent);
        let started = Instant::now();
        let error = UploadLock::acquire(directory.path(), file_id)
            .await
            .err()
            .unwrap();
        assert!(matches!(
            AppError::from(error),
            AppError::ServiceUnavailable {
                retry_after_secs: 1,
                ..
            }
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(first);
        UploadLock::acquire(directory.path(), file_id)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_dir(directory.path().join("locks"))
                .unwrap()
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn admission_leaves_unrelated_history_for_the_cleanup_worker() {
        let directory = tempfile::tempdir().unwrap();
        seed_capacity_audit_history(directory.path(), 0, 100);
        seed_admission_audit_files(directory.path(), 8);
        let before = login_directories(directory.path()).unwrap();
        drop(admit(directory.path(), 1).await.unwrap());
        assert_eq!(
            login_directories(directory.path()).unwrap().len(),
            before.len()
        );
        assert!(before.iter().all(|path| path.is_dir()));
        let files = artifact_paths(directory.path()).unwrap();
        assert_eq!(files.len(), 16);
    }

    #[tokio::test]
    async fn pruning_legacy_history_preserves_concurrent_uploads() {
        let directory = tempfile::tempdir().unwrap();
        seed_capacity_audit_history(directory.path(), 0, 100);
        let login = Uuid::from_u128(1);
        let uploads = futures_util::future::join_all((0..8).map(|index| {
            let root = directory.path().to_path_buf();
            async move {
                let admission = admit(&root, 10).await.unwrap();
                admission
                    .run(move || {
                        let parent = root
                            .join("pending")
                            .join(super::super::tus::login_dir(&login));
                        std::fs::create_dir_all(&parent).c(h!())?;
                        std::fs::write(
                            parent.join(format!(
                                "{}.10",
                                Uuid::from_u128(index + 1)
                            )),
                            b"x",
                        )
                        .c(h!())?;
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
        }));
        let (results, cleaned) = tokio::join!(
            uploads,
            cleanup(
                directory.path(),
                Duration::from_secs(60),
                Duration::from_secs(60)
            )
        );
        cleaned.unwrap();
        assert_eq!(results.len(), 8);
        prune_empty_login_directories(directory.path())
            .await
            .unwrap();
        assert_eq!(login_directories(directory.path()).unwrap().len(), 1);
        assert_eq!(artifact_paths(directory.path()).unwrap().len(), 8);
        for (path, _) in artifact_paths(directory.path()).unwrap() {
            remove_artifacts(directory.path(), &path).await.unwrap();
        }
        assert!(login_directories(directory.path()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_filesystem_operation_keeps_admission_until_file_exists()
    {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let login = Uuid::new_v4();
        let admission = admit(&root, 10).await.unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let path = root
            .join("pending")
            .join(super::super::tus::login_dir(&login))
            .join(format!("{}.10", Uuid::new_v4()));
        let task = tokio::spawn(async move {
            admission
                .run(move || {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    std::fs::write(path, b"x").unwrap();
                    done_tx.send(()).unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(try_lock(directory.path(), "admission").unwrap().is_none());
        release_tx.send(()).unwrap();
        done_rx.await.unwrap();
        prune_empty_login_directories(directory.path())
            .await
            .unwrap();
        let paths = artifact_paths(directory.path()).unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(std::fs::read(&paths[0].0).unwrap(), b"x");
    }

    fn seed_capacity_audit_history(root: &Path, previous: u64, next: u64) {
        for index in previous..next {
            let login = super::super::tus::login_dir(&Uuid::from_u128(
                u128::from(index + 100_000),
            ));
            for state in ["pending", "completed"] {
                std::fs::create_dir_all(root.join(state).join(&login)).unwrap();
            }
        }
    }

    #[tokio::test]
    #[ignore = "explicit filesystem admission audit on isolated temporary directories"]
    async fn audit_admission_history_and_active_files() {
        for active_files in [0, 256] {
            for historical_logins in [0, 10_000, 50_000] {
                for concurrency in [1, 8] {
                    let directory = tempfile::tempdir().unwrap();
                    seed_capacity_audit_history(
                        directory.path(),
                        0,
                        historical_logins,
                    );
                    seed_admission_audit_files(directory.path(), active_files);
                    for phase in ["cold", "warm"] {
                        record_admission_audit(
                            directory.path(),
                            active_files,
                            historical_logins,
                            0,
                            concurrency,
                            phase,
                        )
                        .await;
                        if phase == "cold" {
                            cleanup(
                                directory.path(),
                                Duration::from_secs(600),
                                Duration::from_secs(600),
                            )
                            .await
                            .unwrap();
                        }
                    }
                    let files = artifact_paths(directory.path()).unwrap();
                    assert_eq!(files.len(), active_files * 2);
                    for (path, _) in files {
                        let expected: &[u8] =
                            if path.extension().unwrap() == "json" {
                                b"{}"
                            } else {
                                b"x"
                            };
                        assert_eq!(std::fs::read(path).unwrap(), expected);
                    }
                }
            }
        }
        for historical_locks in [0, 50_000, 200_000] {
            let directory = tempfile::tempdir().unwrap();
            let locks = directory.path().join("locks");
            std::fs::create_dir_all(&locks).unwrap();
            for index in 0..historical_locks {
                File::create(
                    locks.join(Uuid::from_u128(index as u128 + 1).to_string()),
                )
                .unwrap();
            }
            for concurrency in [1, 8] {
                record_admission_audit(
                    directory.path(),
                    0,
                    0,
                    historical_locks,
                    concurrency,
                    "retained_uuid_locks",
                )
                .await;
            }
            assert_eq!(
                std::fs::read_dir(locks).unwrap().count(),
                historical_locks + 1
            );
        }
    }

    fn seed_admission_audit_files(root: &Path, count: usize) {
        for index in 0..count {
            let login = super::super::tus::login_dir(&Uuid::from_u128(
                (index % 32 + 1) as u128,
            ));
            let directory = root
                .join(if index % 2 == 0 {
                    "pending"
                } else {
                    "completed"
                })
                .join(login);
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join(format!(
                "{}.8388608",
                Uuid::from_u128(index as u128 + 1)
            ));
            std::fs::write(&path, b"x").unwrap();
            std::fs::write(metadata_path(&path), b"{}").unwrap();
        }
    }

    async fn record_admission_audit(
        root: &Path,
        active_files: usize,
        historical_logins: u64,
        historical_locks: usize,
        concurrency: usize,
        phase: &str,
    ) {
        let free_bytes = fs2::available_space(root).unwrap();
        let results = futures_util::future::join_all((0..concurrency).map(|_| async {
            let started = Instant::now();
            let accepted = match admit(root, 1).await {
                Ok(lock) => { drop(lock); true }
                Err(error) => {
                    assert!(matches!(AppError::from(error), AppError::ServiceUnavailable { retry_after_secs: 1, .. }));
                    false
                }
            };
            serde_json::json!({"accepted": accepted,"latency_ms": started.elapsed().as_secs_f64()*1000.0})
        })).await;
        println!(
            "SIGINT_ADMISSION_AUDIT_JSON {}",
            serde_json::json!({
                "active_files": active_files,
                "historical_logins": historical_logins,
                "historical_empty_directories": historical_logins*2,
                "historical_lock_files": historical_locks,
                "concurrency": concurrency,
                "phase": phase,
                "available_bytes_before": free_bytes,
                "remaining_login_directories": login_directories(root).unwrap().len(),
                "results": results,
                "scope": "production admission; physical-free-space semantics; immediately released locks and no new files"
            })
        );
    }
}
