use crate::config::ANALYTICS_HEALTH_LOG_INTERVAL_SECS;
use crate::h;
use crate::types::*;
use crate::utils::worker_watch;
use sea_orm::{ConnectionTrait, DbBackend, Statement};

struct AnalyticsHealth {
    healthy: bool,
    fresh: bool,
    checked_age_seconds: Option<i64>,
    detail: String,
}

pub async fn analytics_health_log_worker(
    analytics: AnalyticsPool,
    freshness_max_age_ms: u64,
) {
    let mut was_unhealthy = false;
    loop {
        let _loop_guard =
            worker_watch::loop_guard("analytics_health_log_worker");
        was_unhealthy = check_and_log_health(
            &analytics,
            freshness_max_age_ms,
            was_unhealthy,
        )
        .await;
        tokio::time::sleep(core::time::Duration::from_secs(
            ANALYTICS_HEALTH_LOG_INTERVAL_SECS,
        ))
        .await;
    }
}

async fn check_and_log_health(
    analytics: &AnalyticsPool,
    freshness_max_age_ms: u64,
    was_unhealthy: bool,
) -> bool {
    match query_health(analytics, freshness_max_age_ms).await {
        Ok(health) if health.healthy && health.fresh => {
            if was_unhealthy {
                info!(
                    "analytics replication health recovered: \
                     checked_age_seconds={} detail={}",
                    format_age(health.checked_age_seconds),
                    health.detail,
                );
            }
            false
        }
        Ok(health) => {
            error!(
                "analytics replication is unhealthy: healthy={} fresh={} \
                 checked_age_seconds={} detail={}",
                health.healthy,
                health.fresh,
                format_age(health.checked_age_seconds),
                health.detail,
            );
            true
        }
        Err(err) => {
            error!("analytics replication health query failed: {err:#?}");
            true
        }
    }
}

async fn query_health(
    analytics: &AnalyticsPool,
    freshness_max_age_ms: u64,
) -> Result<AnalyticsHealth, AppError> {
    let freshness_max_age_ms = i64::try_from(freshness_max_age_ms).c(h!())?;
    let health = analytics
        .conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
SELECT healthy,
       checked_at >= CURRENT_TIMESTAMP
           - ($1::bigint * INTERVAL '1 millisecond') AS fresh,
       CASE
           WHEN isfinite(checked_at) THEN
               GREATEST(
                   FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - checked_at)),
                   0
               )::bigint
           ELSE NULL
       END AS checked_age_seconds,
       detail
FROM public.echo_analytics_health
WHERE singleton
"#,
            [freshness_max_age_ms.into()],
        ))
        .await
        .c(h!())?
        .c(h!())?;

    Ok(AnalyticsHealth {
        healthy: health.try_get("", "healthy").c(h!())?,
        fresh: health.try_get("", "fresh").c(h!())?,
        checked_age_seconds: health
            .try_get("", "checked_age_seconds")
            .c(h!())?,
        detail: health.try_get("", "detail").c(h!())?,
    })
}

fn format_age(age_seconds: Option<i64>) -> String {
    age_seconds
        .map(|age_seconds| age_seconds.to_string())
        .unwrap_or_else(|| "never".to_string())
}
