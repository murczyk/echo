use opentelemetry::KeyValue;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};

use super::export::Snapshot;
use crate::config::*;
use crate::h;
use crate::kpi::{history, observations, types::*};
use crate::types::{Env, ShortContext};

pub(super) async fn retained_reports(
    env: &Env,
) -> anyhow::Result<Option<Snapshot>> {
    let transaction = crate::kpi::read_transaction(env).await.c(h!())?;
    let count = crate::entities::report_history::Entity::find()
        .filter(crate::entities::report_history::Column::Status.eq("done"))
        .count(&transaction)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    let mut snapshot = Snapshot::default();
    snapshot.record(
        KPI_METRICS_REPORTS,
        count as f64,
        &[KeyValue::new("status", "done")],
    );
    Ok(Some(snapshot))
}

pub(super) async fn reports(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<Option<Snapshot>> {
    let reports = history::reports(env, period).await.c(h!())?;
    let mut snapshot = Snapshot::default();
    for (status, count) in [
        ("done", reports.done),
        ("failed", reports.failed),
        ("other", reports.total - reports.done - reports.failed),
    ] {
        snapshot.record(
            KPI_METRICS_REPORTS,
            count as f64,
            &[KeyValue::new("status", status)],
        );
    }
    for kind in reports.by_kind {
        snapshot.record(
            KPI_METRICS_REPORT_KIND,
            kind.count as f64,
            &[KeyValue::new("kind", kind.id)],
        );
    }
    duration(
        &mut snapshot,
        KPI_METRICS_REPORT_DURATION,
        KPI_METRICS_REPORT_SAMPLES,
        reports.generation,
    );
    Ok(Some(snapshot))
}

pub(super) async fn notifications(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<Option<Snapshot>> {
    let notifications = history::notifications(env, period).await.c(h!())?;
    let mut snapshot = Snapshot::default();
    for status in ["queued", "sending", "sent", "failed", "skipped"] {
        let count = notifications
            .by_status
            .iter()
            .find(|row| row.id == status)
            .map_or(0, |row| row.count);
        snapshot.record(
            KPI_METRICS_NOTIFICATIONS,
            count as f64,
            &[KeyValue::new("status", status)],
        );
    }
    duration(
        &mut snapshot,
        KPI_METRICS_NOTIFICATION_DURATION,
        KPI_METRICS_NOTIFICATION_SAMPLES,
        notifications.transport,
    );
    Ok(Some(snapshot))
}

fn duration(
    snapshot: &mut Snapshot,
    name: &'static str,
    samples: &'static str,
    duration: KpiDuration,
) {
    for (outcome, count) in [
        ("included", duration.samples),
        ("excluded", duration.excluded),
    ] {
        snapshot.record(
            samples,
            count as f64,
            &[KeyValue::new("outcome", outcome)],
        );
    }
    for (statistic, value) in [
        ("median", duration.median_seconds),
        ("p90", duration.p90_seconds),
    ] {
        if let Some(value) = value {
            snapshot.record(
                name,
                value,
                &[KeyValue::new("statistic", statistic)],
            );
        }
    }
}

pub(super) async fn activity(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<Option<Snapshot>> {
    let activity = observations::activity(env, period).await.c(h!())?;
    if !activity.available {
        return Ok(None);
    }
    let mut snapshot = Snapshot::default();
    if let Some(accounts) = activity.accounts {
        snapshot.record(KPI_METRICS_ACTIVITY, accounts as f64, &[]);
    }
    snapshot.record(
        KPI_METRICS_ACTIVITY_UNMAPPED,
        activity.unmapped_account_groups as f64,
        &[],
    );
    Ok(Some(snapshot))
}

pub(super) async fn requests(
    env: &Env,
    period: &KpiPeriod,
) -> anyhow::Result<Option<Snapshot>> {
    let mut counts = std::collections::BTreeMap::<String, i64>::new();
    let mut since = period.since;
    let chunk = chrono::Duration::hours(KPI_METRICS_REQUEST_CHUNK_HOURS)
        .num_milliseconds();
    let mut available = false;
    while since < period.until {
        let until = (since + chunk).min(period.until);
        let responses =
            observations::requests(env, &KpiPeriod { since, until })
                .await
                .c(h!())?;
        if !responses.available && responses.total.is_none() {
            return Ok(None);
        }
        available |= responses.available;
        for status in responses.by_status {
            *counts.entry(status.id).or_default() += status.count;
        }
        since = until;
    }
    if !available {
        return Ok(None);
    }
    request_snapshot(counts).map(Some).c(h!())
}

fn request_snapshot(
    counts: std::collections::BTreeMap<String, i64>,
) -> anyhow::Result<Snapshot> {
    let mut snapshot = Snapshot::default();
    let mut total = 0;
    let mut errors = 0;
    for (status, count) in counts {
        total += count;
        if status.parse::<u16>().c(h!())? >= 400 {
            errors += count;
        }
        snapshot.record(
            KPI_METRICS_API_RESPONSES,
            count as f64,
            &[KeyValue::new("status", status)],
        );
    }
    if total > 0 {
        snapshot.record(
            KPI_METRICS_API_ERROR_RATIO,
            errors as f64 / total as f64,
            &[],
        );
    }
    Ok(snapshot)
}
