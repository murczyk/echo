use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use sqlx::{pool::PoolConnection, Postgres, Row};
use tokio_util::sync::CancellationToken;

use crate::{
    config::{
        DEVICE_UPLOAD_FINALIZATION_METRICS_INTERVAL_SECONDS,
        DEVICE_UPLOAD_FINALIZATION_METRICS_LOCK,
        DEVICE_UPLOAD_FINALIZATION_METRICS_TIMEOUT_MILLIS,
    },
    h,
    telemetry::metrics::Metrics,
    types::{warn, DeviceUploadFinalizationSettings, Env},
};

const KINDS: [&str; 2] = ["file", "audio"];
const STATES: [&str; 6] = [
    "queued",
    "processing",
    "retry_wait",
    "outcome_unknown",
    "completed",
    "failed",
];

pub(super) const JOB_STATE_SQL: &str = r#"
select kind,status,jobs,
    greatest(0,extract(epoch from statement_timestamp()-oldest_created_at))::float8 as age
from (
    select kind,status,count(*)::bigint as jobs,min(created_at) as oldest_created_at
    from device_upload_finalization_job
    where status in ('queued','processing','retry_wait','outcome_unknown')
    group by kind,status
    union all
    select kind,status,jobs,oldest_created_at
    from device_upload_finalization_terminal_metric
) states
"#;
pub(super) const BUDGET_SQL: &str = "select scope,reserved_source_bytes,unresolved_writes from device_upload_finalization_budget where scope in ('global:file','global:audio')";

pub(super) async fn elect(
    db: &DatabaseConnection,
) -> Result<Option<PoolConnection<Postgres>>> {
    let mut connection = db
        .get_postgres_connection_pool()
        .acquire()
        .await
        .context(h!())?;
    // A session lock must never survive in an idle pool connection, even if this future is aborted.
    connection.close_on_drop();
    sqlx::query("select set_config('statement_timeout',$1,false)")
        .bind(DEVICE_UPLOAD_FINALIZATION_METRICS_TIMEOUT_MILLIS.to_string())
        .execute(&mut *connection)
        .await
        .context(h!())?;
    let elected: bool = sqlx::query_scalar("select pg_try_advisory_lock($1)")
        .bind(DEVICE_UPLOAD_FINALIZATION_METRICS_LOCK)
        .fetch_one(&mut *connection)
        .await
        .context(h!())?;
    Ok(elected.then_some(connection))
}

pub(super) async fn collect(
    connection: &mut sqlx::PgConnection,
    metrics: &Metrics,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<()> {
    let jobs = sqlx::query(JOB_STATE_SQL)
        .fetch_all(&mut *connection)
        .await
        .context(h!())?;
    let budgets = sqlx::query(BUDGET_SQL)
        .fetch_all(&mut *connection)
        .await
        .context(h!())?;
    for kind in KINDS {
        for state in STATES {
            let row = jobs.iter().find(|row| {
                row.get::<&str, _>("kind") == kind
                    && row.get::<&str, _>("status") == state
            });
            let (count, age) = match row {
                Some(row) => (
                    row.try_get::<i64, _>("jobs").context(h!())? as u64,
                    row.try_get::<f64, _>("age").context(h!())?,
                ),
                None => (0, 0.0),
            };
            metrics.record_upload_finalization_jobs(kind, state, count, age);
        }
        let scope = format!("global:{kind}");
        let row = budgets
            .iter()
            .find(|row| row.get::<&str, _>("scope") == scope);
        let (bytes, credits) = match row {
            Some(row) => (
                row.try_get::<i64, _>("reserved_source_bytes")
                    .context(h!())? as u64,
                row.try_get::<i64, _>("unresolved_writes").context(h!())?
                    as u64,
            ),
            None => (0, 0),
        };
        let limit = if kind == "file" {
            settings.file_unresolved_writes
        } else {
            settings.audio_unresolved_writes
        };
        metrics.record_upload_finalization_budget(
            kind,
            bytes,
            credits,
            credits >= u64::from(limit),
        );
    }
    metrics.record_upload_finalization_exporter(true);
    Ok(())
}

pub(super) fn reset(metrics: &Metrics) {
    for kind in KINDS {
        for state in STATES {
            metrics.record_upload_finalization_jobs(kind, state, 0, 0.0);
        }
        metrics.record_upload_finalization_budget(kind, 0, 0, false);
    }
    metrics.record_upload_finalization_exporter(false);
}

pub(super) async fn collect_elected(
    db: &DatabaseConnection,
    leader: &mut Option<PoolConnection<Postgres>>,
    metrics: &Metrics,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<()> {
    if leader.is_none() {
        *leader = elect(db).await.context(h!())?;
    }
    if let Some(connection) = leader {
        if let Err(error) = collect(connection, metrics, settings).await {
            reset(metrics);
            leader.take();
            return Err(error).context(h!());
        }
    }
    Ok(())
}

pub(crate) async fn run_nofail(env: Arc<Env>, cancellation: CancellationToken) {
    let (Some(database), Some(metrics)) = (&env.file_registry_db, &env.metrics)
    else {
        return;
    };
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .filter(DeviceUploadFinalizationSettings::is_valid)
        .unwrap_or_default();
    let mut leader = None;
    let mut interval = tokio::time::interval(Duration::from_secs(
        DEVICE_UPLOAD_FINALIZATION_METRICS_INTERVAL_SECONDS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            _ = interval.tick() => {},
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break,
            result = collect_elected(database.connection(), &mut leader, metrics, &settings) => result,
        };
        if result.is_err() {
            // Infrastructure errors can contain endpoints or credentials; keep diagnostics bounded.
            warn!("device upload finalization metrics collection unavailable");
        }
    }
    if leader.is_some() {
        reset(metrics);
    }
}

pub(super) async fn record_attempt(
    db: &DatabaseConnection,
    metrics: &Metrics,
    claim: &super::types::ClaimedFinalizationJob,
    duration: Duration,
) -> Result<()> {
    let row = sqlx::query("select status,error_code,lease_epoch,extract(epoch from finished_at-created_at)::float8 as completion_seconds from device_upload_finalization_job where id=$1")
        .bind(claim.job_id).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
    let epoch: i64 = row.try_get("lease_epoch").context(h!())?;
    let state = if epoch == claim.lease_epoch {
        bounded_state(row.try_get("status").context(h!())?)
    } else {
        "stale_claim"
    };
    let kind = claim.kind.as_str();
    metrics.record_upload_finalization_event(kind, "attempt", state);
    metrics.record_upload_finalization_duration(
        kind,
        "processing",
        state,
        duration.as_secs_f64(),
    );
    if claim.requires_reconciliation {
        metrics.record_upload_finalization_event(kind, "reconciliation", state);
    }
    if matches!(state, "retry_wait" | "outcome_unknown") {
        metrics.record_upload_finalization_event(kind, "retry", state);
    }
    if matches!(state, "retry_wait" | "outcome_unknown" | "failed") {
        let code: Option<&str> = row.try_get("error_code").context(h!())?;
        metrics.record_upload_finalization_event(
            kind,
            "failure",
            bounded_failure(code),
        );
    }
    if matches!(state, "completed" | "failed") {
        if let Some(seconds) = row
            .try_get::<Option<f64>, _>("completion_seconds")
            .context(h!())?
        {
            metrics.record_upload_finalization_duration(
                kind,
                "completion",
                state,
                seconds,
            );
        }
    }
    Ok(())
}

fn bounded_state(state: &str) -> &'static str {
    STATES
        .into_iter()
        .find(|value| *value == state)
        .unwrap_or("unknown")
}

fn bounded_failure(code: Option<&str>) -> &'static str {
    match code {
        Some("invalid_audio") => "invalid_audio",
        Some("unsupported_audio") => "unsupported_audio",
        Some("device_audio_name_conflict") => "device_audio_name_conflict",
        Some("target_revision_changed") => "target_revision_changed",
        Some("target_unavailable") => "target_unavailable",
        Some("publication_forbidden") => "publication_forbidden",
        Some("source_lost") => "source_lost",
        Some("source_digest_mismatch") => "source_digest_mismatch",
        Some("storage_outcome_unknown") => "storage_outcome_unknown",
        Some("execution_capacity_unavailable") => {
            "execution_capacity_unavailable"
        }
        Some("command_conflict") => "command_conflict",
        Some("dependency_unavailable") => "dependency_unavailable",
        _ => "unknown",
    }
}
