use crate::config::*;
use crate::types::*;
use chrono::*;
use sea_orm::DatabaseConnection;
use tokio::time::{sleep, Duration};

pub async fn worker_calculate_group_stats(env: Arc<Env>) {
    info!("worker_calculate_group_stats started");
    let mut last_calculated =
        Utc::now().naive_utc() - chrono::Duration::days(1);
    let stats_redis =
        crate::stats::redis::GroupStatsRedis::new(env.stats_redis.clone());
    loop {
        match worker_calculate_group_stats_inner(
            &env.dbx,
            &stats_redis,
            last_calculated,
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
        sleep(Duration::from_secs(WORKER_CALCULATE_GROUP_STATS_SLEEP_SEC))
            .await;
    }
}

async fn worker_calculate_group_stats_inner(
    dbx: &DatabaseConnection,
    stats_redis: &crate::stats::redis::GroupStatsRedis,
    last_calculated: NaiveDateTime,
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

    if let Err(e) =
        crate::stats::process_pending_group_stats_recalculation_task(
            dbx,
            stats_redis,
        )
        .await
        .c(h!())
    {
        error!(
            "process_pending_group_stats_recalculation_task encountered an error: {:#?}",
            e
        );
    }

    Ok(last_calculated)
}
