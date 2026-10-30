use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use tokio::task::{AbortHandle, JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::types::{FinalizationFailure, FinalizationKind};
use crate::h;
use crate::types::{DeviceUploadFinalizationSettings, Env};

pub(crate) type OperationGuard = std::sync::Arc<dyn Send + Sync>;

tokio::task_local! {
    static WORK_SCOPE: WorkScope;
}

#[derive(Clone)]
pub(crate) struct WorkScope(Arc<WorkScopeState>);

struct WorkScopeState {
    tasks: TaskTracker,
    cancellation: CancellationToken,
    aborts: Mutex<Vec<AbortHandle>>,
}

impl WorkScope {
    pub(crate) fn new() -> Self {
        Self(Arc::new(WorkScopeState {
            tasks: TaskTracker::new(),
            cancellation: CancellationToken::new(),
            aborts: Mutex::new(Vec::new()),
        }))
    }

    pub(crate) async fn run<F: Future>(&self, operation: F) -> F::Output {
        WORK_SCOPE.scope(self.clone(), operation).await
    }

    pub(crate) fn stop(&self) {
        self.0.cancellation.cancel();
        for task in self
            .0
            .aborts
            .lock()
            .expect("finalization task registry poisoned")
            .iter()
        {
            task.abort();
        }
    }

    pub(crate) async fn wait(&self) {
        self.0.tasks.close();
        self.0.tasks.wait().await;
    }

    fn track_abort(&self, task: AbortHandle) {
        let mut tasks = self
            .0
            .aborts
            .lock()
            .expect("finalization task registry poisoned");
        tasks.retain(|task| !task.is_finished());
        if self.0.cancellation.is_cancelled() {
            task.abort();
        }
        tasks.push(task);
    }
}

pub(crate) fn shutdown_cancellation() -> CancellationToken {
    WORK_SCOPE
        .try_with(|scope| scope.0.cancellation.clone())
        .unwrap_or_default()
}

pub(crate) async fn ensure_source_available(
    database: &sea_orm::DatabaseConnection,
    kind: FinalizationKind,
    source_identity: &str,
) -> Result<()> {
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM device_upload_finalization_job
         WHERE kind = $1 AND source_identity = $2
         AND status IN ('queued', 'processing', 'retry_wait', 'outcome_unknown'))",
    )
    .bind(kind.as_str())
    .bind(source_identity)
    .fetch_one(database.get_postgres_connection_pool())
    .await
    .context(h!())?;
    if owned {
        return Err(FinalizationFailure::SourceOwned.into());
    }
    Ok(())
}

pub(crate) async fn legacy_slot(
    env: &Env,
    kind: ResourceKind,
) -> Result<Option<ResourceGuard>> {
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .filter(DeviceUploadFinalizationSettings::is_valid)
        .unwrap_or_default();
    let database = env
        .file_registry_db
        .as_ref()
        .ok_or(FinalizationFailure::DependencyUnavailable)
        .context(h!())?;
    legacy_slot_with_settings(
        Path::new(&env.config.storage_dir),
        database.connection(),
        &settings,
        kind.for_file(),
    )
    .await
    .context(h!())
}

pub(crate) async fn legacy_slot_with_settings(
    root: &Path,
    database: &sea_orm::DatabaseConnection,
    settings: &DeviceUploadFinalizationSettings,
    kind: ResourceKind,
) -> Result<Option<ResourceGuard>> {
    let count = match kind {
        ResourceKind::File => settings.file_slots,
        ResourceKind::Audio => settings.audio_slots,
        ResourceKind::Decode => settings.decode_slots,
        ResourceKind::Encryption | ResourceKind::FileEncryption => {
            settings.encryption_slots
        }
        ResourceKind::Readback | ResourceKind::FileReadback => {
            settings.readback_slots
        }
    };
    match try_acquire(root, kind, count) {
        Ok(Some(guard)) => Ok(Some(guard)),
        Ok(None) => Err(FinalizationFailure::CapacityUnavailable.into()),
        Err(error) => {
            if !settings.enabled {
                let active: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM device_upload_finalization_job
                     WHERE status IN ('queued', 'retry_wait'))
                     OR EXISTS (SELECT 1 FROM device_upload_finalization_job WHERE status = 'processing')
                     OR EXISTS (SELECT 1 FROM device_upload_finalization_job WHERE status = 'outcome_unknown')",
                )
                .fetch_one(database.get_postgres_connection_pool())
                .await
                .context(h!())?;
                if !active {
                    log::warn!("shared finalization slots unavailable for legacy-only workflow: {error:#}");
                    return Ok(None);
                }
            }
            Err(error)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) enum ResourceKind {
    File,
    Audio,
    Decode,
    Encryption,
    Readback,
    FileEncryption,
    FileReadback,
}

impl ResourceKind {
    fn for_file(self) -> Self {
        match self {
            Self::Encryption => Self::FileEncryption,
            Self::Readback => Self::FileReadback,
            _ => self,
        }
    }

    fn directory(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Audio => "audio",
            Self::Decode => "decode",
            Self::Encryption => "encryption",
            Self::Readback => "readback",
            Self::FileEncryption => "file-encryption",
            Self::FileReadback => "file-readback",
        }
    }
}

#[derive(Clone)]
pub(crate) struct ResourceGuard {
    _lock: std::sync::Arc<SlotLock>,
    owner: Option<OperationGuard>,
}

impl ResourceGuard {
    pub(crate) fn with_owner(mut self, owner: OperationGuard) -> Self {
        self.owner = Some(owner);
        self
    }
}

impl std::fmt::Debug for ResourceGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResourceGuard")
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct SlotLock {
    file: File,
}

impl Drop for SlotLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

pub(crate) fn try_acquire(
    root: &Path,
    kind: ResourceKind,
    count: usize,
) -> Result<Option<ResourceGuard>> {
    anyhow::ensure!(
        !root.as_os_str().is_empty() && count > 0,
        "invalid finalization slot configuration"
    );
    let directory = root
        .join("device-upload-finalization-slots")
        .join(kind.directory());
    std::fs::create_dir_all(&directory).context(h!())?;
    for index in 0..count {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(format!("{index}.lock")))
            .context(h!())?;
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                return Ok(Some(ResourceGuard {
                    _lock: std::sync::Arc::new(SlotLock { file }),
                    owner: None,
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error).context(h!()),
        }
    }
    Ok(None)
}

pub(crate) fn try_acquire_file(
    root: &Path,
    kind: ResourceKind,
    count: usize,
) -> Result<Option<ResourceGuard>> {
    try_acquire(root, kind.for_file(), count).context(h!())
}

pub(crate) async fn acquire(
    root: &Path,
    kind: ResourceKind,
    count: usize,
    timeout: std::time::Duration,
) -> Result<ResourceGuard> {
    let shutdown = shutdown_cancellation();
    let wait = async {
        loop {
            if let Some(guard) = try_acquire(root, kind, count).context(h!())? {
                return Ok(guard);
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                crate::config::DEVICE_UPLOAD_FINALIZATION_RESOURCE_POLL_MILLIS,
            ))
            .await;
        }
    };
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => anyhow::bail!("finalization shutdown"),
        result = tokio::time::timeout(timeout, wait) => result
            .map_err(|_| FinalizationFailure::CapacityUnavailable)
            .context(h!())?,
    }
}

pub(crate) async fn acquire_file(
    root: &Path,
    kind: ResourceKind,
    count: usize,
    timeout: std::time::Duration,
) -> Result<ResourceGuard> {
    acquire(root, kind.for_file(), count, timeout)
        .await
        .context(h!())
}

pub(crate) fn try_acquire_ordered(
    root: &Path,
    slots: &[(ResourceKind, usize)],
) -> Result<Option<Vec<ResourceGuard>>> {
    anyhow::ensure!(
        slots.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "resource acquisition order is invalid"
    );
    let mut guards = Vec::with_capacity(slots.len());
    for (kind, count) in slots {
        let Some(guard) = try_acquire(root, *kind, *count).context(h!())?
        else {
            return Ok(None);
        };
        guards.push(guard);
    }
    Ok(Some(guards))
}

// Dropping the waiter detaches the operation. Only the operation releases its resources.
pub(crate) struct OwnedOperation<T> {
    join: JoinHandle<T>,
}

impl<T> Future for OwnedOperation<T> {
    type Output = Result<T, JoinError>;
    fn poll(
        mut self: Pin<&mut Self>,
        context: &mut TaskContext<'_>,
    ) -> Poll<Self::Output> {
        Pin::new(&mut self.join).poll(context)
    }
}

pub(crate) fn spawn_task<T, F>(operation: F) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    spawn_tracked(operation, true)
}

// Process supervisors must run their kill-and-wait path before releasing guards.
pub(crate) fn spawn_child_task<T, F>(operation: F) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    spawn_tracked(operation, false)
}

fn spawn_tracked<T, F>(operation: F, abortable: bool) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let join = if let Ok(scope) = WORK_SCOPE.try_with(Clone::clone) {
        let inherited = scope.clone();
        let join = scope
            .0
            .tasks
            .spawn(async move { inherited.run(operation).await });
        if abortable {
            scope.track_abort(join.abort_handle());
        }
        join
    } else {
        tokio::spawn(operation)
    };
    OwnedOperation { join }
}

pub(crate) fn spawn_owned<T, F>(
    guard: ResourceGuard,
    operation: F,
) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    spawn_task(async move {
        let _guard = guard;
        operation.await
    })
}

pub(crate) fn spawn_blocking_task<T, F>(operation: F) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let join = if let Ok(scope) = WORK_SCOPE.try_with(Clone::clone) {
        scope.0.tasks.spawn_blocking(operation)
    } else {
        tokio::task::spawn_blocking(operation)
    };
    OwnedOperation { join }
}

pub(crate) fn spawn_blocking_owned<T, F>(
    guard: ResourceGuard,
    operation: F,
) -> OwnedOperation<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    spawn_blocking_task(move || {
        let _guard = guard;
        operation()
    })
}

pub(crate) fn supervise_child(
    guard: ResourceGuard,
    mut command: tokio::process::Command,
    cancellation: CancellationToken,
) -> OwnedOperation<Result<std::process::ExitStatus>> {
    let shutdown = shutdown_cancellation();
    spawn_child_task(async move {
        let _guard = guard;
        let mut child = command.kill_on_drop(true).spawn().context(h!())?;
        let cancelled = async {
            tokio::select! {
                _ = cancellation.cancelled() => {},
                _ = shutdown.cancelled() => {},
            }
        };
        tokio::select! {
            status = child.wait() => status.context(h!()),
            _ = cancelled => {
                let killed = child.start_kill();
                let status = child.wait().await.context(h!())?;
                if !status.success() { killed.context(h!())?; }
                Ok(status)
            }
        }
    })
}
