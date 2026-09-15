use crate::config::*;
use crate::types::*;
use chrono::*;
use sea_orm::DatabaseConnection;
use tokio::time::{sleep_until, Duration, Instant};

pub async fn worker_calculate_group_stats_and_network_recalculations(
    env: Arc<Env>,
) {
    info!("group stats and network recalculation worker started");
    let mut last_calculated =
        Utc::now().naive_utc() - chrono::Duration::days(1);
    let mut prefer_historical = false;
    let stats_redis =
        crate::stats::redis::GroupStatsRedis::new(env.stats_redis.clone());
    let mut group_stats_at = Instant::now();
    let mut network_recalculation_at = Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = sleep_until(group_stats_at) => {
                match worker_calculate_group_stats_inner(
                    &env.dbx,
                    &stats_redis,
                    last_calculated,
                    &env.config,
                    &mut prefer_historical,
                )
                .await
                {
                    Ok(ts) => {
                        last_calculated = ts;
                    }
                    Err(e) => {
                        error!(
                            "worker_calculate_group_stats_inner encountered an error: {:#?}",
                            e
                        );
                    }
                }
                group_stats_at = Instant::now()
                    + Duration::from_secs(
                        WORKER_CALCULATE_GROUP_STATS_SLEEP_SEC,
                    );
            }
            _ = sleep_until(network_recalculation_at) => {
                let started_at = Instant::now();
                if let Err(e) = crate::sigint::network::recalculation::run_pending(
                    &env.dbx,
                )
                .await
                {
                    error!("network recalculation encountered an error: {e:#?}");
                }
                network_recalculation_at = started_at
                    + Duration::from_secs(
                        NETWORK_RECALCULATION_WORKER_INTERVAL_SECS,
                    );
            }
        }
    }
}

async fn worker_calculate_group_stats_inner(
    dbx: &DatabaseConnection,
    stats_redis: &crate::stats::redis::GroupStatsRedis,
    last_calculated: NaiveDateTime,
    config: &Config,
    prefer_historical: &mut bool,
) -> anyhow::Result<NaiveDateTime> {
    let mut last_calculated = last_calculated;
    let now = Utc::now().naive_utc();

    let log_suffix = if last_calculated
        + chrono::Duration::minutes(
            WORKER_CALCULATE_GROUP_STATS_EVERY_MINUTES_NUM,
        )
        > now
    {
        let since = crate::stats::round_to_5min(now).c(h!())?;
        let till_ts = since + chrono::Duration::minutes(5);
        crate::stats::recalculate_group_stats(
            dbx,
            stats_redis,
            since,
            till_ts,
            false,
            true,
        )
        .await
        .c(h!())?;
        "short loop"
    } else {
        let till_ts = now;
        let since_ts = now
            - chrono::Duration::minutes(
                WORKER_CALCULATE_GROUP_STATS_SINCE_MINS,
            );
        crate::stats::recalculate_group_stats(
            dbx,
            stats_redis,
            since_ts,
            till_ts,
            true,
            true,
        )
        .await
        .c(h!())?;
        last_calculated = now;
        "full loop"
    };
    let duration = (Utc::now().naive_utc() - now).num_seconds();
    info!("worker_calculate_group_stats took {duration}s ({log_suffix})");

    let queued = crate::stats::process_pending_group_stats_recalculation_task(
        dbx,
        stats_redis,
        !check_is_worker_night_shift(config),
        *prefer_historical,
    )
    .await
    .c(h!());
    *prefer_historical = !*prefer_historical;
    if let Err(e) = queued {
        error!(
            "process_pending_group_stats_recalculation_task encountered an error: {:#?}",
            e
        );
    }

    Ok(last_calculated)
}
