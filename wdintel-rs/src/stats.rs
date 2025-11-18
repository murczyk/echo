use crate::config::*;
use crate::entities::{signal_message, stats_group_5min};
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{config, h};
use anyhow::Context;
use chrono::{DateTime, Duration, NaiveDateTime, NaiveTime, Utc};
use log::info;
use sea_orm::*;

pub async fn oneoff_calculate_stats(
    mode: Mode,
    since_epoch_ms: Option<i64>,
    till_epoch_ms: Option<i64>,
) -> Result<(), AppError> {
    let till_ts = match till_epoch_ms {
        Some(ts) => DateTime::from_timestamp_millis(ts).c(h!())?.naive_utc(),
        None => Utc::now().naive_utc(),
    };
    let since_ts = match since_epoch_ms {
        Some(ts) => DateTime::from_timestamp_millis(ts).c(h!())?.naive_utc(),
        None => NaiveDateTime::new(
            (till_ts - Duration::days(1)).date(),
            NaiveTime::MIN,
        )
        .and_local_timezone(get_tz())
        .earliest()
        .c(h!())?
        .naive_utc(),
    };
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    crate::messenger::group::stats::recalculate_group_stats(
        &dbx, since_ts, till_ts,
    )
    .await
    .context(h!())?;
    Ok(())
}

pub async fn oneoff_calculate_historic_stats(
    mode: Mode,
) -> Result<(), AppError> {
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let min_since_ts =
        Utc::now().naive_utc() - Duration::days(STATS_MIN_DATETIME_DAYS);
    let min_since_ts = signal_message::Entity::find()
        .filter(signal_message::Column::Deleted.eq(false))
        .order_by_asc(signal_message::Column::CreatedAt)
        .one(&dbx)
        .await
        .c(h!())?
        .map(|x| x.created_at)
        .filter(|ts| min_since_ts.lt(ts))
        .unwrap_or(min_since_ts);
    let mut till_ts = stats_group_5min::Entity::find()
        .order_by_asc(stats_group_5min::Column::Dt)
        .one(&dbx)
        .await
        .c(h!())?
        .map(|x| x.dt)
        .unwrap_or(Utc::now().naive_utc())
        + Duration::days(1);
    while till_ts > min_since_ts {
        let since_ts = till_ts - Duration::days(1);
        let duration = (since_ts - min_since_ts).num_days();
        info!("oneoff_calculate_historic_stats: from {min_since_ts} to {till_ts}, remaining {duration} days");
        crate::messenger::group::stats::recalculate_group_stats(
            &dbx, since_ts, till_ts,
        )
        .await
        .context(h!())?;
        till_ts = since_ts;
    }
    info!("oneoff_calculate_historic_stats: done");
    Ok(())
}
