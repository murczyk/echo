use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures_util::{Stream, StreamExt};
use uuid::Uuid;

use crate::config::{
    DEVICE_FILE_CONTENT_LOCK_RETRY_MILLIS, DEVICE_FILE_CONTENT_LOCK_WAIT_MILLIS,
};
use crate::h;

#[derive(Clone, Debug)]
pub(crate) struct Spool {
    root: Arc<PathBuf>,
}

#[derive(Debug)]
pub(crate) struct LockedSpool {
    lock: Arc<File>,
    lock_path: PathBuf,
    data_path: PathBuf,
    created_lock: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AppendOutcome {
    pub offset: u64,
    pub accepted_bytes: u64,
}

#[derive(Debug)]
pub(crate) enum AcquireError {
    Busy,
    Internal(anyhow::Error),
}

#[derive(Debug)]
pub(crate) enum AppendError {
    Payload(actix_web::error::PayloadError),
    ExceedsLength { offset: u64 },
    Internal(anyhow::Error),
}

impl Spool {
    pub(crate) async fn initialize(
        root: PathBuf,
        required_capacity: u64,
    ) -> Result<Self> {
        if root.as_os_str().is_empty() {
            return Err(anyhow!("device content spool path is empty"));
        }
        tokio::fs::create_dir_all(&root)
            .await
            .with_context(|| {
                format!("create device content spool {}", root.display())
            })
            .context(h!())?;
        validate_directory(&root).context(h!())?;
        tokio::fs::set_permissions(
            &root,
            std::fs::Permissions::from_mode(0o700),
        )
        .await
        .with_context(|| {
            format!("set device content spool mode {}", root.display())
        })
        .context(h!())?;
        validate_directory(&root).context(h!())?;
        let total = fs2::total_space(&root)
            .with_context(|| format!("read spool capacity {}", root.display()))
            .context(h!())?;
        if total < required_capacity {
            return Err(anyhow!(
                "device content spool capacity {total} is below required {required_capacity}"
            ));
        }
        Ok(Self {
            root: Arc::new(root),
        })
    }

    #[cfg(test)]
    pub(crate) async fn for_test(root: PathBuf) -> Result<Self> {
        Self::initialize(root, 1).await.context(h!())
    }

    pub(crate) fn preflight(&self) -> Result<()> {
        validate_directory(&self.root).context(h!())?;
        fs2::available_space(self.root.as_ref())
            .with_context(|| {
                format!("read spool free space {}", self.root.display())
            })
            .context(h!())?;
        Ok(())
    }

    pub(crate) fn available_bytes(&self) -> Result<u64> {
        validate_directory(&self.root).context(h!())?;
        fs2::available_space(self.root.as_ref())
            .with_context(|| {
                format!("read spool free space {}", self.root.display())
            })
            .context(h!())
    }

    pub(crate) async fn acquire(
        &self,
        upload_id: Uuid,
    ) -> std::result::Result<LockedSpool, AcquireError> {
        let deadline = Instant::now()
            + Duration::from_millis(DEVICE_FILE_CONTENT_LOCK_WAIT_MILLIS);
        let lock = self
            .open_lock(upload_id)
            .map_err(|error| AcquireError::Internal(error.context(h!())))?;
        loop {
            match fs2::FileExt::try_lock_exclusive(lock.lock.as_ref()) {
                Ok(()) => return Ok(lock),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(AcquireError::Busy);
                    }
                    tokio::time::sleep(Duration::from_millis(
                        DEVICE_FILE_CONTENT_LOCK_RETRY_MILLIS,
                    ))
                    .await;
                }
                Err(error) => {
                    return Err(AcquireError::Internal(
                        anyhow::Error::new(error)
                            .context("lock device content upload")
                            .context(h!()),
                    ));
                }
            }
        }
    }

    pub(crate) fn try_acquire_cleanup(
        &self,
        upload_id: Uuid,
    ) -> std::result::Result<Option<LockedSpool>, anyhow::Error> {
        let lock = self.open_lock(upload_id).context(h!())?;
        match fs2::FileExt::try_lock_exclusive(lock.lock.as_ref()) {
            Ok(()) => Ok(Some(lock)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(anyhow::Error::new(error)
                .context("lock device content upload for cleanup")
                .context(h!())),
        }
    }

    fn open_lock(&self, upload_id: Uuid) -> Result<LockedSpool> {
        validate_directory(&self.root).context(h!())?;
        let lock_path = self.root.join(format!("{upload_id}.lock"));
        let data_path = self.root.join(format!("{upload_id}.data"));
        let created_lock = !lock_path
            .try_exists()
            .with_context(|| {
                format!("inspect device content lock {}", lock_path.display())
            })
            .context(h!())?;
        let lock = open_regular(&lock_path, true, true, false).context(h!())?;
        Ok(LockedSpool {
            lock: Arc::new(lock),
            lock_path,
            data_path,
            created_lock,
        })
    }
}

impl LockedSpool {
    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let lock = self.lock.clone();
        tokio::task::spawn_blocking(move || {
            // Filesystem work must retain the lock after request cancellation.
            let _lock = lock;
            operation()
        })
        .await
        .context(h!())?
        .context(h!())
    }

    pub(crate) fn offset(&self) -> Result<u64> {
        match open_regular(&self.data_path, false, false, false) {
            Ok(file) => Ok(file
                .metadata()
                .context("read spool metadata")
                .context(h!())?
                .len()),
            Err(error) if is_not_found(&error) => Ok(0),
            Err(error) => Err(error.context(h!())),
        }
    }

    pub(crate) async fn append<S>(
        &self,
        mut payload: S,
        expected_offset: u64,
        upload_length: u64,
    ) -> std::result::Result<AppendOutcome, AppendError>
    where
        S: Stream<
                Item = std::result::Result<
                    bytes::Bytes,
                    actix_web::error::PayloadError,
                >,
            > + Unpin,
    {
        let actual = self
            .offset()
            .map_err(|error| AppendError::Internal(error.context(h!())))?;
        if actual != expected_offset {
            return Ok(AppendOutcome {
                offset: actual,
                accepted_bytes: 0,
            });
        }

        let existed = self.data_path.try_exists().map_err(|error| {
            AppendError::Internal(
                anyhow::Error::new(error)
                    .context("inspect device content data")
                    .context(h!()),
            )
        })?;
        let mut file = None;
        let mut offset = actual;
        while let Some(item) = payload.next().await {
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.sync_pending(&mut file).await.map_err(|error| {
                        AppendError::Internal(error.context(h!()))
                    })?;
                    return Err(AppendError::Payload(error));
                }
            };
            if bytes.is_empty() {
                continue;
            }
            let chunk_len = u64::try_from(bytes.len()).map_err(|error| {
                AppendError::Internal(
                    anyhow::Error::new(error)
                        .context("convert upload chunk length")
                        .context(h!()),
                )
            })?;
            let Some(next_offset) = offset.checked_add(chunk_len) else {
                self.rollback(file.take(), actual, existed).await.map_err(
                    |error| AppendError::Internal(error.context(h!())),
                )?;
                return Err(AppendError::ExceedsLength { offset: actual });
            };
            if next_offset > upload_length {
                self.rollback(file.take(), actual, existed).await.map_err(
                    |error| AppendError::Internal(error.context(h!())),
                )?;
                return Err(AppendError::ExceedsLength { offset: actual });
            }
            if file.is_none() {
                let std_file = open_regular(&self.data_path, true, true, true)
                    .map_err(|error| {
                        AppendError::Internal(error.context(h!()))
                    })?;
                let current = std_file
                    .metadata()
                    .map_err(|error| {
                        AppendError::Internal(
                            anyhow::Error::new(error)
                                .context("read append spool metadata")
                                .context(h!()),
                        )
                    })?
                    .len();
                if current != actual {
                    return Ok(AppendOutcome {
                        offset: current,
                        accepted_bytes: 0,
                    });
                }
                file = Some(std_file);
            }
            let mut pending = file.take().expect("spool data file initialized");
            let (pending, written) = self
                .run(move || {
                    let written = pending.write_all(&bytes);
                    Ok((pending, written))
                })
                .await
                .map_err(|error| AppendError::Internal(error.context(h!())))?;
            file = Some(pending);
            if let Err(error) = written {
                let _ = self.sync_pending(&mut file).await;
                return Err(AppendError::Internal(
                    anyhow::Error::new(error)
                        .context("append device content chunk")
                        .context(h!()),
                ));
            }
            offset = next_offset;
        }
        self.sync_pending(&mut file)
            .await
            .map_err(|error| AppendError::Internal(error.context(h!())))?;
        Ok(AppendOutcome {
            offset,
            accepted_bytes: offset - actual,
        })
    }

    pub(crate) fn open_source(&self) -> Result<Option<tokio::fs::File>> {
        match open_regular(&self.data_path, false, false, false) {
            Ok(file) => Ok(Some(tokio::fs::File::from_std(file))),
            Err(error) if is_not_found(&error) => Ok(None),
            Err(error) => Err(error.context(h!())),
        }
    }

    pub(crate) async fn truncate(&self, offset: u64) -> Result<()> {
        let path = self.data_path.clone();
        self.run(move || {
            let file = open_regular(&path, false, true, false).context(h!())?;
            file.set_len(offset)
                .context("truncate device content spool")
                .context(h!())?;
            file.sync_data()
                .context("sync truncated device content spool")
                .context(h!())
        })
        .await
        .context(h!())
    }

    pub(crate) async fn remove_local(&self) -> Result<()> {
        let data_path = self.data_path.clone();
        let lock_path = self.lock_path.clone();
        self.run(move || {
            remove_if_exists(&data_path).context(h!())?;
            remove_if_exists(&lock_path).context(h!())
        })
        .await
        .context(h!())
    }

    pub(crate) async fn remove_created_lock(&self) -> Result<()> {
        if self.created_lock {
            let path = self.lock_path.clone();
            self.run(move || remove_if_exists(&path).context(h!()))
                .await
                .context(h!())?;
        }
        Ok(())
    }

    async fn sync_pending(&self, file: &mut Option<File>) -> Result<()> {
        if let Some(file) = file.take() {
            self.run(move || {
                file.sync_data()
                    .context("sync device content spool")
                    .context(h!())
            })
            .await
            .context(h!())?;
        }
        Ok(())
    }

    async fn rollback(
        &self,
        file: Option<File>,
        offset: u64,
        existed: bool,
    ) -> Result<()> {
        let path = self.data_path.clone();
        self.run(move || rollback(file, &path, offset, existed).context(h!()))
            .await
            .context(h!())
    }
}

fn validate_directory(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect spool directory {}", path.display()))
        .context(h!())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "device content spool is not a regular directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn open_regular(
    path: &Path,
    create: bool,
    write: bool,
    append: bool,
) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        .append(append)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = options
        .open(path)
        .with_context(|| format!("open regular spool file {}", path.display()))
        .context(h!())?;
    if !file
        .metadata()
        .with_context(|| format!("inspect spool file {}", path.display()))
        .context(h!())?
        .is_file()
    {
        return Err(anyhow!(
            "spool path is not a regular file: {}",
            path.display()
        ));
    }
    Ok(file)
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
        || error.chain().any(|source| {
            source
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
        })
}

fn rollback(
    file: Option<File>,
    path: &Path,
    offset: u64,
    existed: bool,
) -> Result<()> {
    if let Some(file) = file {
        file.set_len(offset)
            .context("truncate oversized upload chunk")
            .context(h!())?;
        file.sync_data()
            .context("sync rolled back upload chunk")
            .context(h!())?;
    }
    if !existed && offset == 0 {
        remove_if_exists(path).context(h!())?;
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::Error::new(error)
            .context(format!("remove spool file {}", path.display()))
            .context(h!())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use futures_util::stream;
    use std::os::unix::fs::symlink;

    fn cancellation_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
    }

    fn pause_filesystem_work() -> std::sync::mpsc::Sender<()> {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        release_tx
    }

    #[test]
    fn cancelled_append_keeps_lock_until_pending_write_finishes() {
        cancellation_runtime().block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let spool =
                Spool::for_test(temp.path().to_path_buf()).await.unwrap();
            let id = Uuid::new_v4();
            let locked = spool.acquire(id).await.unwrap();
            let pause = pause_filesystem_work();
            let mut request = Box::pin(async move {
                locked
                    .append(
                        stream::iter([Ok(Bytes::from_static(b"abc"))]),
                        0,
                        3,
                    )
                    .await
            });
            assert!(futures_util::poll!(request.as_mut()).is_pending());
            assert_eq!(
                std::fs::metadata(temp.path().join(format!("{id}.data")))
                    .unwrap()
                    .len(),
                0
            );
            drop(request);
            assert!(spool.try_acquire_cleanup(id).unwrap().is_none());
            drop(pause);

            let locked = spool.acquire(id).await.unwrap();
            assert_eq!(locked.offset().unwrap(), 3);
            let retry = locked
                .append(stream::iter([Ok(Bytes::from_static(b"abc"))]), 0, 3)
                .await
                .unwrap();
            assert_eq!(
                retry,
                AppendOutcome {
                    offset: 3,
                    accepted_bytes: 0
                }
            );
            assert_eq!(std::fs::read(&locked.data_path).unwrap(), b"abc");
        });
    }

    #[test]
    fn cancelled_truncate_keeps_lock_until_pending_truncation_finishes() {
        cancellation_runtime().block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let spool =
                Spool::for_test(temp.path().to_path_buf()).await.unwrap();
            let id = Uuid::new_v4();
            let locked = spool.acquire(id).await.unwrap();
            std::fs::write(&locked.data_path, b"abcdef").unwrap();
            let pause = pause_filesystem_work();
            let mut request = Box::pin(async move { locked.truncate(3).await });
            assert!(futures_util::poll!(request.as_mut()).is_pending());
            drop(request);
            assert!(spool.try_acquire_cleanup(id).unwrap().is_none());
            drop(pause);

            let locked = spool.acquire(id).await.unwrap();
            assert_eq!(locked.offset().unwrap(), 3);
            let retry = locked
                .append(stream::iter([Ok(Bytes::from_static(b"xyz"))]), 3, 6)
                .await
                .unwrap();
            assert_eq!(retry.offset, 6);
            assert_eq!(std::fs::read(&locked.data_path).unwrap(), b"abcxyz");
        });
    }

    #[test]
    fn cancelled_oversized_append_finishes_rollback_before_unlocking() {
        cancellation_runtime().block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
            let id = Uuid::new_v4();
            let locked = spool.acquire(id).await.unwrap();
            std::fs::write(&locked.data_path, b"ab").unwrap();
            let mut pause = None;
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let mut started_tx = Some(started_tx);
            let mut payload = [b"c".as_slice(), b"de".as_slice()].into_iter();
            let payload = stream::poll_fn(|_| {
                let bytes = payload.next().unwrap();
                if bytes == b"de" {
                    pause = Some(pause_filesystem_work());
                    started_tx.take().unwrap().send(()).unwrap();
                }
                std::task::Poll::Ready(Some(Ok(Bytes::from_static(bytes))))
            });
            let mut request = Box::pin(async move { locked.append(payload, 2, 4).await });
            tokio::select! {
                result = &mut request => panic!("append unexpectedly finished: {result:?}"),
                result = tokio::time::timeout(Duration::from_secs(5), started_rx) => result.unwrap().unwrap(),
            }
            drop(request);
            assert!(pause.is_some());
            assert!(spool.try_acquire_cleanup(id).unwrap().is_none());
            drop(pause);

            let locked = spool.acquire(id).await.unwrap();
            assert_eq!(locked.offset().unwrap(), 2);
            let retry = locked
                .append(stream::iter([Ok(Bytes::from_static(b"xy"))]), 2, 4)
                .await
                .unwrap();
            assert_eq!(retry.offset, 4);
            assert_eq!(std::fs::read(&locked.data_path).unwrap(), b"abxy");
        });
    }

    #[test]
    fn opening_a_fifo_fails_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::sync::mpsc;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.data");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = mpsc::channel();
        let source = path.clone();
        let thread = std::thread::spawn(move || {
            sender
                .send(open_regular(&source, false, false, false))
                .unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(1));
        if result.is_err() {
            let _writer = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path);
            thread.join().unwrap();
            panic!("opening a FIFO blocked the request worker");
        }
        assert!(result.unwrap().is_err());
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn symlink_root_is_rejected_without_changing_target_mode() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        tokio::fs::create_dir(&target).await.unwrap();
        tokio::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(0o755),
        )
        .await
        .unwrap();
        let root = temp.path().join("spool");
        symlink(&target, &root).unwrap();

        assert!(Spool::initialize(root, 1).await.is_err());
        assert_eq!(
            tokio::fs::metadata(target)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[tokio::test]
    async fn zero_offset_does_not_create_data_file() {
        let temp = tempfile::tempdir().unwrap();
        let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
        let id = Uuid::new_v4();
        let locked = spool.acquire(id).await.unwrap();
        let payload = stream::empty::<
            std::result::Result<Bytes, actix_web::error::PayloadError>,
        >();
        let outcome = locked.append(payload, 0, 0).await.unwrap();
        assert_eq!(outcome.offset, 0);
        assert!(!temp.path().join(format!("{id}.data")).exists());
    }

    #[tokio::test]
    async fn overflow_rolls_back_new_file() {
        let temp = tempfile::tempdir().unwrap();
        let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
        let id = Uuid::new_v4();
        let locked = spool.acquire(id).await.unwrap();
        let payload = stream::iter([Ok::<_, actix_web::error::PayloadError>(
            Bytes::from_static(b"abcd"),
        )]);
        assert!(matches!(
            locked.append(payload, 0, 3).await,
            Err(AppendError::ExceedsLength { offset: 0 })
        ));
        assert!(!temp.path().join(format!("{id}.data")).exists());
    }

    #[tokio::test]
    async fn overflow_restores_existing_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
        let id = Uuid::new_v4();
        let locked = spool.acquire(id).await.unwrap();
        let initial = stream::iter([Ok::<_, actix_web::error::PayloadError>(
            Bytes::from_static(b"ab"),
        )]);
        locked.append(initial, 0, 3).await.unwrap();

        let oversized = stream::iter([
            Ok::<_, actix_web::error::PayloadError>(Bytes::from_static(b"c")),
            Ok(Bytes::from_static(b"d")),
        ]);
        assert!(matches!(
            locked.append(oversized, 2, 3).await,
            Err(AppendError::ExceedsLength { offset: 2 })
        ));
        assert_eq!(
            tokio::fs::read(temp.path().join(format!("{id}.data")))
                .await
                .unwrap(),
            b"ab"
        );
    }

    #[tokio::test]
    async fn interrupted_payload_keeps_the_durable_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
        let id = Uuid::new_v4();
        let locked = spool.acquire(id).await.unwrap();
        let payload = stream::iter([
            Ok::<_, actix_web::error::PayloadError>(Bytes::from_static(b"abc")),
            Err(actix_web::error::PayloadError::Incomplete(None)),
        ]);

        assert!(matches!(
            locked.append(payload, 0, 4).await,
            Err(AppendError::Payload(_))
        ));
        assert_eq!(locked.offset().unwrap(), 3);
    }

    #[tokio::test]
    async fn concurrent_acquire_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let spool = Spool::for_test(temp.path().to_path_buf()).await.unwrap();
        let id = Uuid::new_v4();
        let _locked = spool.acquire(id).await.unwrap();

        assert!(matches!(spool.acquire(id).await, Err(AcquireError::Busy)));
    }
}
