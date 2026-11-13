use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use sqlx::Row;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{cleanup, query, recovery, resources::WorkScope, types::*};
use crate::{
    h,
    types::{error, DeviceUploadFinalizationSettings},
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum ClaimLane {
    Work,
    Reconcile,
}

pub(crate) async fn claim_due(
    db: &DatabaseConnection,
    kind: FinalizationKind,
    owner: Uuid,
    lane: ClaimLane,
    lease_seconds: u64,
) -> Result<Option<ClaimedFinalizationJob>> {
    let lease = i64::try_from(lease_seconds).context(h!())?;
    anyhow::ensure!(lease > 0, "invalid finalization lease duration");
    let reconcile = matches!(lane, ClaimLane::Reconcile);
    let row = sqlx::query(r#"
        with candidate as (
            select j.id from device_upload_finalization_job j
            where j.kind=$1 and (
                (not $2 and j.status in ('queued','retry_wait') and j.next_run_at<=statement_timestamp())
                or ($2 and j.status='outcome_unknown' and j.next_run_at<=statement_timestamp()
                    and (j.lease_until is null or j.lease_until<=statement_timestamp()))
                or (j.status='processing' and j.lease_until<=statement_timestamp())
            ) and ($2 = (j.status='outcome_unknown' or exists (
                select 1 from device_upload_finalization_attempt a where a.job_id=j.id
                and ((a.write_intent_at is not null and a.phase not in ('retired','selected')) or a.write_credit_held)
            )))
            order by case when j.status='processing' then j.lease_until else j.next_run_at end,j.created_at,j.id
            for update of j skip locked limit 1
        )
        update device_upload_finalization_job j set status=case when $2 then 'outcome_unknown' else 'processing' end,
            lease_owner=$3,lease_epoch=j.lease_epoch+1,lease_until=clock_timestamp()+$4*interval '1 second',
            attempt_count=j.attempt_count+1,updated_at=clock_timestamp(),
            error_code=case when $2 then 'storage_outcome_unknown' else null end,
            error_message=case when $2 then 'Storage outcome requires reconciliation' else null end,
            error_action=case when $2 then 'retry_poll' else null end
        from candidate where j.id=candidate.id returning j.id,j.lease_epoch
    "#).bind(kind.as_str()).bind(reconcile).bind(owner).bind(lease)
        .fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    row.map(|row| {
        Ok(ClaimedFinalizationJob {
            job_id: row.try_get("id").context(h!())?,
            lease_epoch: row.try_get("lease_epoch").context(h!())?,
            owner,
            kind,
            requires_reconciliation: reconcile,
        })
    })
    .transpose()
}

#[async_trait::async_trait]
pub(crate) trait FinalizationExecutor: Send + Sync + 'static {
    fn metrics(&self) -> Option<&crate::telemetry::metrics::Metrics> {
        None
    }
    async fn execute(&self, claim: &ClaimedFinalizationJob) -> Result<()>;
    async fn reconcile(&self, claim: &ClaimedFinalizationJob) -> Result<()>;
}

pub(crate) struct WorkerRegistration {
    cancellation: CancellationToken,
    workers: Vec<tokio::task::JoinHandle<()>>,
    grace: Duration,
    scope: WorkScope,
}

impl WorkerRegistration {
    pub(crate) async fn shutdown(mut self) {
        self.cancellation.cancel();
        let drained = tokio::time::timeout(self.grace / 2, async {
            self.join_workers().await;
            self.scope.wait().await;
        })
        .await;
        if drained.is_err() {
            self.scope.stop();
            for worker in &self.workers {
                worker.abort();
            }
            self.join_workers().await;
            self.scope.wait().await;
        }
    }

    async fn join_workers(&mut self) {
        while let Some(worker) = self.workers.last_mut() {
            let _ = worker.await;
            self.workers.pop();
        }
    }
}

impl Drop for WorkerRegistration {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.scope.stop();
        for worker in &self.workers {
            worker.abort();
        }
    }
}

pub(crate) fn register(
    db: DatabaseConnection,
    settings: DeviceUploadFinalizationSettings,
    executor: Arc<dyn FinalizationExecutor>,
    cancellation: CancellationToken,
) -> WorkerRegistration {
    register_kinds(
        db,
        settings,
        executor,
        cancellation,
        &[
            FinalizationKind::FinalizationFileKind,
            FinalizationKind::FinalizationAudioKind,
        ],
    )
}

fn register_kinds(
    db: DatabaseConnection,
    settings: DeviceUploadFinalizationSettings,
    executor: Arc<dyn FinalizationExecutor>,
    cancellation: CancellationToken,
    kinds: &[FinalizationKind],
) -> WorkerRegistration {
    let mut workers = Vec::new();
    let scope = WorkScope::new();
    for &kind in kinds {
        let slots = match kind {
            FinalizationKind::FinalizationFileKind => settings.file_slots,
            FinalizationKind::FinalizationAudioKind => settings.audio_slots,
        };
        for lane in std::iter::repeat_n(ClaimLane::Work, slots)
            .chain(std::iter::once(ClaimLane::Reconcile))
        {
            let (db, settings, executor, cancellation) = (
                db.clone(),
                settings.clone(),
                executor.clone(),
                cancellation.clone(),
            );
            let scope = scope.clone();
            workers.push(tokio::spawn(async move {
                scope
                    .run(run_nofail(
                        db,
                        settings,
                        executor,
                        cancellation,
                        kind,
                        lane,
                    ))
                    .await;
            }));
        }
    }
    WorkerRegistration {
        cancellation,
        workers,
        grace: Duration::from_secs(settings.shutdown_grace_seconds),
        scope,
    }
}

async fn run_nofail(
    db: DatabaseConnection,
    settings: DeviceUploadFinalizationSettings,
    executor: Arc<dyn FinalizationExecutor>,
    cancellation: CancellationToken,
    kind: FinalizationKind,
    lane: ClaimLane,
) {
    let owner = Uuid::new_v4();
    while !cancellation.is_cancelled() {
        let claimed = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            claimed = claim_due(&db, kind, owner, lane, settings.lease_seconds) => claimed,
        };
        if cancellation.is_cancelled() {
            break;
        }
        match claimed {
            Ok(Some(claim)) => {
                if let Err(_error) =
                    run_claim(&db, &settings, executor.as_ref(), &claim).await
                {
                    error!("device upload finalization {} failed: dependency_unavailable", claim.job_id);
                } else {
                    continue;
                }
            }
            Ok(None) => {}
            Err(_) => {
                error!("device upload finalization claim failed: dependency_unavailable")
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(settings.poll_seconds)) => {},
        }
    }
}

async fn run_claim(
    db: &DatabaseConnection,
    settings: &DeviceUploadFinalizationSettings,
    executor: &dyn FinalizationExecutor,
    claim: &ClaimedFinalizationJob,
) -> Result<()> {
    let started = Instant::now();
    let result = run_claim_inner(db, settings, executor, claim).await;
    let duration = started.elapsed();
    if let Some(metrics) = executor.metrics() {
        if super::metrics::record_attempt(db, metrics, claim, duration)
            .await
            .is_err()
        {
            metrics.record_upload_finalization_event(
                claim.kind.as_str(),
                "attempt",
                "metrics_unavailable",
            );
            metrics.record_upload_finalization_duration(
                claim.kind.as_str(),
                "processing",
                "metrics_unavailable",
                duration.as_secs_f64(),
            );
        }
    }
    result.context(h!())
}

async fn run_claim_inner(
    db: &DatabaseConnection,
    settings: &DeviceUploadFinalizationSettings,
    executor: &dyn FinalizationExecutor,
    claim: &ClaimedFinalizationJob,
) -> Result<()> {
    let operation = async {
        if claim.requires_reconciliation {
            executor.reconcile(claim).await
        } else {
            executor.execute(claim).await
        }
    };
    tokio::pin!(operation);
    let mut heartbeat =
        tokio::time::interval(Duration::from_secs(settings.heartbeat_seconds));
    let mut lease_current = true;
    let result = loop {
        tokio::select! {
            result = &mut operation => break result,
            current = async {
                heartbeat.tick().await;
                query::heartbeat(db,claim,settings.lease_seconds).await.unwrap_or(false)
            }, if lease_current => {
                lease_current = current;
            }
        }
    };
    if result.is_err() && lease_current {
        let attempts: i64 = sqlx::query_scalar("select attempt_count from device_upload_finalization_job where id=$1")
            .bind(claim.job_id).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
        recovery::schedule_retry(
            db,
            claim,
            &FinalizationFailure::DependencyUnavailable,
            claim.requires_reconciliation,
            recovery::retry_delay(settings, attempts, None),
        )
        .await
        .context(h!())?;
    }
    result.context(h!())
}

pub(crate) async fn run_files(
    env: Arc<crate::types::Env>,
    runtime: Arc<crate::devices::files::content::DeviceFileContentRuntime>,
    cancellation: CancellationToken,
) {
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .filter(DeviceUploadFinalizationSettings::is_valid)
        .unwrap_or_default();
    let Some(database) = env.file_registry_db.as_ref() else {
        return;
    };
    let executor = Arc::new(FileExecutor {
        env: env.clone(),
        runtime: runtime.clone(),
    });
    let registration = register_kinds(
        database.connection().clone(),
        settings,
        executor,
        cancellation.clone(),
        &[FinalizationKind::FinalizationFileKind],
    );
    tokio::join!(
        crate::devices::files::content::worker::run_finalization_cleanup_nofail(
            env.clone(),
            runtime,
            cancellation.clone(),
        ),
        cleanup::run_accounting_nofail(
            database.connection().clone(),
            FinalizationKind::FinalizationFileKind,
            cancellation,
        ),
    );
    registration.shutdown().await;
}

struct FileExecutor {
    env: Arc<crate::types::Env>,
    runtime: Arc<crate::devices::files::content::DeviceFileContentRuntime>,
}

#[cfg(test)]
pub(crate) async fn execute_file_for_test(
    env: Arc<crate::types::Env>,
    runtime: Arc<crate::devices::files::content::DeviceFileContentRuntime>,
    claim: ClaimedFinalizationJob,
) -> Result<()> {
    FileExecutor { env, runtime }
        .execute(&claim)
        .await
        .context(h!())
}

pub(crate) async fn run_audio(
    env: Arc<crate::types::Env>,
    runtime: Arc<crate::devices::audio::DeviceAudioRuntime>,
    cancellation: CancellationToken,
) {
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .filter(DeviceUploadFinalizationSettings::is_valid)
        .unwrap_or_default();
    let Some(database) = env.file_registry_db.as_ref() else {
        return;
    };
    let registration = register_kinds(
        database.connection().clone(),
        settings,
        Arc::new(AudioExecutor {
            env: env.clone(),
            runtime: runtime.clone(),
        }),
        cancellation.clone(),
        &[FinalizationKind::FinalizationAudioKind],
    );
    tokio::join!(
        crate::devices::audio::async_cleanup::run_nofail(
            env.clone(),
            runtime,
            cancellation.clone(),
        ),
        cleanup::run_accounting_nofail(
            database.connection().clone(),
            FinalizationKind::FinalizationAudioKind,
            cancellation,
        ),
    );
    registration.shutdown().await;
}

struct AudioExecutor {
    env: Arc<crate::types::Env>,
    runtime: Arc<crate::devices::audio::DeviceAudioRuntime>,
}

#[async_trait::async_trait]
impl FinalizationExecutor for AudioExecutor {
    fn metrics(&self) -> Option<&crate::telemetry::metrics::Metrics> {
        self.env.metrics.as_ref()
    }
    async fn execute(&self, claim: &ClaimedFinalizationJob) -> Result<()> {
        crate::devices::audio::ingest::finalize_claim(
            &self.env,
            &self.runtime,
            claim.clone(),
        )
        .await
        .context(h!())?;
        if let Err(error) =
            crate::devices::audio::async_cleanup::cleanup_source(
                &self.runtime,
                claim.job_id,
            )
            .await
        {
            log::warn!("audio finalization source cleanup deferred: {error:#}");
        }
        Ok(())
    }
    async fn reconcile(&self, claim: &ClaimedFinalizationJob) -> Result<()> {
        self.execute(claim).await.context(h!())
    }
}

#[async_trait::async_trait]
impl FinalizationExecutor for FileExecutor {
    fn metrics(&self) -> Option<&crate::telemetry::metrics::Metrics> {
        self.env.metrics.as_ref()
    }
    async fn execute(&self, claim: &ClaimedFinalizationJob) -> Result<()> {
        crate::devices::files::content::finalizer::finalize_claim(
            &self.env,
            &self.runtime,
            claim.clone(),
        )
        .await
        .context(h!())?;
        if let Err(error) =
            crate::devices::files::content::async_cleanup::cleanup_source(
                &self.env,
                &self.runtime,
                claim.job_id,
            )
            .await
        {
            log::warn!("file finalization source cleanup deferred: {error:#}");
        }
        Ok(())
    }

    async fn reconcile(&self, claim: &ClaimedFinalizationJob) -> Result<()> {
        self.execute(claim).await.context(h!())
    }
}
