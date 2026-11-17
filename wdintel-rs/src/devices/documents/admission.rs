use crate::{
    devices::config::*,
    h,
    types::{Env, ShortContext},
};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::Instant};

pub(crate) type SharedAdmission = Arc<Mutex<Admission>>;

pub(crate) struct Admission {
    next_check: Instant,
    failures: u32,
    submission_failures: u32,
}

#[derive(Deserialize)]
struct Capacity {
    limit: u64,
    active: u64,
    available: u64,
    retry_after_seconds: u64,
}

impl Admission {
    pub(crate) fn shared() -> SharedAdmission {
        Arc::new(Mutex::new(Self {
            next_check: Instant::now(),
            failures: 0,
            submission_failures: 0,
        }))
    }

    pub(crate) async fn available(&mut self, env: &Env) -> bool {
        if Instant::now() < self.next_check {
            return false;
        }
        match capacity(env).await {
            Ok(capacity) => {
                self.failures = 0;
                if capacity.available > 0 {
                    return true;
                }
                self.defer(Duration::from_secs(capacity.retry_after_seconds));
            }
            Err(error) => {
                self.failures = self.failures.saturating_add(1);
                let seconds = DEVICE_DOCUMENT_CAPACITY_POLL_SECS
                    .saturating_mul(1 << self.failures.saturating_sub(1).min(4))
                    .min(DEVICE_DOCUMENT_CAPACITY_MAX_BACKOFF_SECS);
                self.defer(Duration::from_secs(seconds));
                crate::types::warn!("device document capacity unavailable; retry_in_secs={seconds}: {error:#}");
            }
        }
        false
    }

    pub(super) fn submission_succeeded(&mut self) {
        self.submission_failures = 0;
    }

    pub(super) fn submission_failed(&mut self) {
        self.submission_failures = self.submission_failures.saturating_add(1);
        let seconds = DEVICE_DOCUMENT_CAPACITY_POLL_SECS
            .saturating_mul(
                1 << self.submission_failures.saturating_sub(1).min(4),
            )
            .min(DEVICE_DOCUMENT_CAPACITY_MAX_BACKOFF_SECS);
        self.defer(Duration::from_secs(seconds));
    }

    pub(crate) fn defer(&mut self, delay: Duration) {
        let delay =
            delay.max(Duration::from_secs(DEVICE_DOCUMENT_CAPACITY_POLL_SECS));
        self.next_check = self.next_check.max(Instant::now() + delay);
    }
}

async fn capacity(env: &Env) -> anyhow::Result<Capacity> {
    let config = crate::attachments::store::extractor_config(env).c(h!())?;
    let capacity: Capacity = env
        .rq
        .get(format!("{}/v1/capacity", config.base_url))
        .bearer_auth(&config.token)
        .timeout(Duration::from_secs(DEVICE_DOCUMENT_CAPACITY_TIMEOUT_SECS))
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?
        .json()
        .await
        .c(h!())?;
    anyhow::ensure!(
        capacity.limit > 0
            && capacity.available
                == capacity.limit.saturating_sub(capacity.active),
        "invalid document extractor capacity"
    );
    anyhow::ensure!(
        capacity.retry_after_seconds
            <= DEVICE_DOCUMENT_CAPACITY_MAX_BACKOFF_SECS,
        "invalid document extractor retry delay"
    );
    Ok(capacity)
}

pub(super) fn retry_delay(response: &reqwest::Response) -> Duration {
    let seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEVICE_DOCUMENT_CAPACITY_POLL_SECS);
    Duration::from_secs(seconds.clamp(
        DEVICE_DOCUMENT_CAPACITY_POLL_SECS,
        DEVICE_DOCUMENT_CAPACITY_MAX_BACKOFF_SECS,
    ))
}
