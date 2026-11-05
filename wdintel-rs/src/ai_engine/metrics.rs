use super::client::is_government_url;
use crate::config::AI_PROVIDER_METRICS_OPENAI_HOST;
use crate::entities::ai_engine;
use crate::telemetry::{AiProviderLabels, Metrics};
use reqwest::StatusCode;
use std::sync::Arc;
use tokio::time::Instant;
use url::Url;

const OUTCOME_CANCELLED: &str = "cancelled";
const OUTCOME_COOLDOWN_EXPIRED: &str = "cooldown_expired";
const OUTCOME_LOCAL_ERROR: &str = "local_error";

/// Where a client's provider metrics go.
#[derive(Clone)]
pub(super) struct ProviderMetricsSink {
    pub(super) metrics: Arc<Metrics>,
    pub(super) process: &'static str,
}

impl ProviderMetricsSink {
    fn labels(&self, engine: &ai_engine::Model) -> AiProviderLabels {
        AiProviderLabels {
            provider: provider_label(&engine.url),
            model_name: engine.model_name.clone(),
            process: self.process,
        }
    }
}

struct PendingCall {
    metrics: Arc<Metrics>,
    labels: AiProviderLabels,
    streaming: bool,
}

/// Records one provider call exactly once.
///
/// Callers wrap requests in outer timeouts that drop the future, so code after
/// an await never runs for a hung provider. Dropping an unfinished attempt
/// records it instead of letting the call vanish from the latency data.
pub(super) struct ProviderCallAttempt {
    pending: Option<PendingCall>,
    provider_started_at: Option<Instant>,
}

impl ProviderCallAttempt {
    pub(super) fn start(
        sink: Option<&ProviderMetricsSink>,
        engine: &ai_engine::Model,
        streaming: bool,
    ) -> Self {
        Self {
            pending: sink.map(|sink| PendingCall {
                metrics: sink.metrics.clone(),
                labels: sink.labels(engine),
                streaming,
            }),
            provider_started_at: None,
        }
    }

    /// Starts the clock after any local cooldown, so only the provider is timed.
    pub(super) fn mark_provider_start(&mut self) {
        self.provider_started_at = Some(Instant::now());
    }

    pub(super) fn finish(
        &mut self,
        result: &anyhow::Result<reqwest::Response>,
    ) {
        let outcome = match result {
            Ok(response) => status_outcome(response.status()),
            Err(_) if self.provider_started_at.is_none() => {
                OUTCOME_COOLDOWN_EXPIRED
            }
            Err(error) => error_outcome(error),
        };
        self.record(outcome);
    }

    fn record(&mut self, outcome: &'static str) {
        let Some(call) = self.pending.take() else {
            return;
        };
        let response_start = self
            .provider_started_at
            .filter(|_| outcome != OUTCOME_LOCAL_ERROR)
            .map(|started_at| started_at.elapsed());
        call.metrics.record_ai_provider_call(
            &call.labels,
            call.streaming,
            outcome,
            response_start,
        );
    }
}

impl Drop for ProviderCallAttempt {
    fn drop(&mut self) {
        let outcome = if self.provider_started_at.is_some() {
            OUTCOME_CANCELLED
        } else {
            OUTCOME_COOLDOWN_EXPIRED
        };
        self.record(outcome);
    }
}

/// Records how long a provider stream ran after its response headers.
pub(crate) struct StreamBodyTimer {
    pending: Option<(Arc<Metrics>, AiProviderLabels)>,
    started_at: Instant,
}

impl StreamBodyTimer {
    pub(super) fn start(
        sink: &ProviderMetricsSink,
        engine: &ai_engine::Model,
    ) -> Self {
        Self {
            pending: Some((sink.metrics.clone(), sink.labels(engine))),
            started_at: Instant::now(),
        }
    }

    pub(crate) fn completed(&mut self) {
        self.record("completed");
    }

    pub(crate) fn failed(&mut self) {
        self.record("failed");
    }

    fn record(&mut self, outcome: &'static str) {
        if let Some((metrics, labels)) = self.pending.take() {
            metrics.record_ai_provider_stream(
                &labels,
                outcome,
                self.started_at.elapsed(),
            );
        }
    }
}

impl Drop for StreamBodyTimer {
    fn drop(&mut self) {
        self.record(OUTCOME_CANCELLED);
    }
}

// Both guards are held across awaits in spawned tasks.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<ProviderCallAttempt>();
    assert_send::<StreamBodyTimer>();
};

fn provider_label(url: &str) -> &'static str {
    if is_government_url(url) {
        return "gov_ua";
    }
    let Ok(url) = Url::parse(url) else {
        return "other";
    };
    if url.host_str() == Some(AI_PROVIDER_METRICS_OPENAI_HOST) {
        "openai"
    } else if url.scheme() == "http" {
        "internal"
    } else {
        "other"
    }
}

fn status_outcome(status: StatusCode) -> &'static str {
    if status.is_success() {
        "ok"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limited"
    } else if status.is_server_error() {
        "server_error"
    } else {
        "client_error"
    }
}

fn error_outcome(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        if cause.is::<tokio::time::error::Elapsed>() {
            return "timeout";
        }
        if let Some(error) = cause.downcast_ref::<reqwest::Error>() {
            return reqwest_outcome(error);
        }
    }
    OUTCOME_LOCAL_ERROR
}

fn reqwest_outcome(error: &reqwest::Error) -> &'static str {
    if error.is_builder() {
        OUTCOME_LOCAL_ERROR
    } else if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect_error"
    } else {
        "transport_error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_label_covers_every_engine_kind() {
        for (url, provider) in [
            ("https://inference.ai.mod.gov.ua/v1", "gov_ua"),
            (
                "https://inference.ai.mod.gov.ua/v1/chat/completions",
                "gov_ua",
            ),
            ("https://api.openai.com/v1", "openai"),
            ("http://100.105.172.96:8000/v1", "internal"),
            ("https://models.example.com/v1", "other"),
            ("not a url", "other"),
        ] {
            assert_eq!(provider_label(url), provider, "{url}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn elapsed_deadline_is_a_timeout_under_context_layers() {
        let elapsed = tokio::time::timeout(
            std::time::Duration::from_millis(1),
            std::future::pending::<()>(),
        )
        .await
        .unwrap_err();
        let error = anyhow::Error::new(elapsed).context("outer");
        assert_eq!(error_outcome(&error), "timeout");
    }
}
