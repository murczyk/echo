use crate::config::get_tz;
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{config, h};
use anyhow::Context;
use chrono::{DateTime, Duration, NaiveDateTime, NaiveTime, Utc};

pub async fn oneoff_calculate_group_stats(
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
