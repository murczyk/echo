use crate::{config::AI_ENGINE_GLM_5_3_COOLDOWN_SECS, h, types::ShortContext};
use chrono::{DateTime, Utc};
use reqwest::{header, StatusCode};
use std::time::Duration;
use tokio::{sync::Mutex, time::Instant};

#[derive(Default)]
pub(super) struct GlmCooldown {
    retry_at: Mutex<Option<Instant>>,
}

impl GlmCooldown {
    pub(super) async fn wait(&self) {
        loop {
            let retry_at = {
                let mut retry_at = self.retry_at.lock().await;
                match *retry_at {
                    Some(retry_at) if retry_at > Instant::now() => retry_at,
                    _ => {
                        *retry_at = None;
                        return;
                    }
                }
            };
            tokio::time::sleep_until(retry_at).await;
        }
    }

    pub(super) async fn observe(
        &self,
        status: StatusCode,
        headers: &header::HeaderMap,
    ) -> anyhow::Result<()> {
        if status != StatusCode::TOO_MANY_REQUESTS {
            return Ok(());
        }
        let retry_at = Instant::now()
            .checked_add(retry_after(headers, Utc::now()))
            .c(h!())?;
        let mut current = self.retry_at.lock().await;
        *current =
            Some(current.map_or(retry_at, |current| current.max(retry_at)));
        Ok(())
    }
}

fn retry_after(headers: &header::HeaderMap, now: DateTime<Utc>) -> Duration {
    let fallback = Duration::from_secs(AI_ENGINE_GLM_5_3_COOLDOWN_SECS);
    let Some(value) = headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
    else {
        return fallback;
    };
    if let Ok(seconds) = value.trim().parse() {
        return Duration::from_secs(seconds);
    }
    DateTime::parse_from_rfc2822(value)
        .map(|retry_at| {
            (retry_at.with_timezone(&Utc) - now)
                .to_std()
                .unwrap_or_default()
        })
        .unwrap_or(fallback)
}

#[cfg(test)]
#[path = "cooldown_tests.rs"]
mod tests;
