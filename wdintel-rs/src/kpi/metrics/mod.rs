mod accounts;
mod export;
mod history;

#[cfg(test)]
mod tests;

pub(crate) use export::Exporter;

use std::future::Future;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;

use chrono::{DateTime, Utc};
use opentelemetry::KeyValue;
use tokio_util::sync::CancellationToken;

use crate::config::*;
use crate::h;
use crate::kpi::types::KpiPeriod;
use crate::types::{Env, ShortContext};
use export::Snapshot;

pub(crate) async fn run_nofail(env: Arc<Env>, cancel: CancellationToken) {
    let Some(metrics) = &env.metrics else { return };
    let exporter = &metrics.kpi;
    let mut interval = tokio::time::interval(Duration::from_secs(
        KPI_METRICS_COLLECTION_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = interval.tick() => {}
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = collect(&env, exporter, Utc::now()) => {}
        }
    }
}

pub(super) async fn collect(
    env: &Env,
    exporter: &Exporter,
    until: DateTime<Utc>,
) {
    collect_current(env, exporter, until).await;
    let mut requests = history::RequestCache::new();
    for (days, window) in KPI_METRICS_PERIODS {
        let period = KpiPeriod {
            since: (until - chrono::Duration::days(days)).timestamp_millis(),
            until: until.timestamp_millis(),
        };
        collect_period(env, exporter, until, window, &period, &mut requests)
            .await;
    }
}

async fn collect_current(env: &Env, exporter: &Exporter, until: DateTime<Utc>) {
    publish(
        exporter,
        "accounts",
        "current",
        until,
        accounts::collect(env),
    )
    .await;
    publish(
        exporter,
        "reports",
        "all",
        until,
        history::retained_reports(env),
    )
    .await;
    exporter.publish(
        "activity_queue",
        "process",
        until.timestamp_millis(),
        Ok(Some(activity_queue(env))),
    );
}

fn activity_queue(env: &Env) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for (outcome, count) in [
        (
            "enqueued",
            env.session_activity_enqueued.load(Ordering::Relaxed),
        ),
        (
            "dropped",
            env.session_activity_dropped.load(Ordering::Relaxed),
        ),
    ] {
        snapshot.record(
            KPI_METRICS_ACTIVITY_QUEUE,
            count as f64,
            &[KeyValue::new("outcome", outcome)],
        );
    }
    snapshot
}

async fn collect_period(
    env: &Env,
    exporter: &Exporter,
    until: DateTime<Utc>,
    window: &'static str,
    period: &KpiPeriod,
    requests: &mut history::RequestCache,
) {
    publish(
        exporter,
        "reports",
        window,
        until,
        history::reports(env, period),
    )
    .await;
    publish(
        exporter,
        "notifications",
        window,
        until,
        history::notifications(env, period),
    )
    .await;
    publish(
        exporter,
        "activity",
        window,
        until,
        history::activity(env, period),
    )
    .await;
    publish(
        exporter,
        "requests",
        window,
        until,
        history::requests(env, period, requests),
    )
    .await;
}

async fn publish(
    exporter: &Exporter,
    source: &'static str,
    window: &'static str,
    until: DateTime<Utc>,
    collect: impl Future<Output = anyhow::Result<Option<Snapshot>>>,
) {
    let result = tokio::time::timeout(
        Duration::from_secs(KPI_METRICS_SOURCE_TIMEOUT_SECS),
        collect,
    )
    .await
    .c(h!())
    .and_then(|result| result);
    exporter.publish(source, window, until.timestamp_millis(), result);
}
