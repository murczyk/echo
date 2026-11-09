mod collect;
mod export;

#[cfg(test)]
mod tests;

pub(crate) use collect::read_transaction;
pub(crate) use export::{Exporter, Snapshot};

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use echo_im::observation::{
    SignalError, SignalErrorKind, SignalErrorObserver, SignalOperation,
};
use opentelemetry::KeyValue;
use tokio_util::sync::CancellationToken;

use crate::config::*;
use crate::types::Env;

pub(crate) async fn run(env: Arc<Env>, cancel: CancellationToken) {
    let Some(metrics) = &env.metrics else { return };
    let mut interval = tokio::time::interval(Duration::from_secs(
        OPERATIONAL_METRICS_INTERVAL_SECS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = interval.tick() => {}
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = collect::collect(&env, &metrics.operational, Utc::now()) => {}
        }
    }
}

pub(crate) fn process() -> &'static str {
    crate::pg_runtime_pool_role().map_or(
        AI_PROVIDER_METRICS_PROCESS_ONEOFF,
        crate::PgRuntimePoolRole::application_name,
    )
}

pub(crate) struct SignalObserver {
    pub(crate) metrics: crate::telemetry::Metrics,
    pub(crate) client_id: Option<i32>,
    pub(crate) account_id: Option<String>,
    pub(crate) datasource_id: i64,
}

impl std::fmt::Debug for SignalObserver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SignalObserver")
            .finish_non_exhaustive()
    }
}

impl SignalErrorObserver for SignalObserver {
    fn record(&self, error: SignalError) {
        let mut labels = vec![
            KeyValue::new("messenger", "signal"),
            KeyValue::new("path", "echo_im"),
            KeyValue::new("process", process()),
            KeyValue::new(
                "operation",
                match error.operation {
                    SignalOperation::Receive => "receive",
                    SignalOperation::Send => "send",
                    SignalOperation::Request => "request",
                },
            ),
            KeyValue::new(
                "error_kind",
                match error.kind {
                    SignalErrorKind::Timeout => "timeout",
                    SignalErrorKind::Other => "other",
                },
            ),
        ];
        if let Some(id) = self.client_id {
            labels.push(KeyValue::new("client_id", id.to_string()));
        }
        if let Some(id) = error.account_id {
            labels.push(KeyValue::new("account_id", id.to_string()));
            if self.account_id.as_deref() == Some(id.to_string().as_str()) {
                labels.push(KeyValue::new(
                    "datasource_id",
                    self.datasource_id.to_string(),
                ));
            }
        }
        self.metrics.operational.errors.add(1, &labels);
    }
}
