use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::*;
use crate::types::{Env, Mode, ShortContext};
use crate::{config, h};
use actix_web::web::{Data, Json};
use anyhow::Context;
use chrono::*;
use log::info;
use sea_orm::*;
use std::collections::HashMap;

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

pub async fn should_read_stats_from_db(
    req: &Json<AnalysisStatsReq>,
    env: &Data<Env>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<bool> {
    if dt_till - dt_since < Duration::minutes(STATS_READ_FROM_TABLE_MINIMUM_MIN)
    {
        return Ok(false);
    }
    if !env.config.use_group_stats_for_counters.unwrap_or(false) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_groups) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_senders) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_freqs) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_posts) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_callsigns) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_units) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_locations) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_aors) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_tags) {
        return Ok(false);
    }
    if !is_filter_empty(&req.selected_networks) {
        return Ok(false);
    }
    match req.search.clone() {
        None => Ok(false),
        Some(q) => Ok(!q.is_empty()),
    }
}

fn is_filter_empty<T>(values: &Option<Vec<T>>) -> bool {
    match values {
        None => true,
        Some(values) => values.is_empty(),
    }
}

pub async fn read_group_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsGroup>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_5min::Column::Dt
            .gte(since)
            .and(stats_group_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> = stats_group_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_5min::Column::GroupMasterKey.is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.group_master_key).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.group_master_key).or_insert(0) +=
                    s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (master_key, count) in stats {
        result.push(AnalysisStatsGroup { master_key, count });
    }
    Ok(result)
}

pub async fn read_sender_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsSender>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_sender_5min::Column::Dt
            .gte(since)
            .and(stats_group_sender_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> =
        stats_group_sender_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_sender_5min::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.sender).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_sender_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_sender_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_sender_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.sender).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (uuid, count) in stats {
        result.push(AnalysisStatsSender { uuid, count });
    }
    Ok(result)
}

pub async fn read_post_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsPost>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_post_id_5min::Column::Dt
            .gte(since)
            .and(stats_group_post_id_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<i64, i64> = stats_group_post_id_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_post_id_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.post_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_post_id_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_post_id_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_post_id_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.post_id).or_insert(0) += s.quantity as i64;
            });
    };
    let posts = sigint_post::Entity::find()
        .filter(sigint_post::Column::Id.is_in(stats.keys().copied()))
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|m| (m.id, m.name))
        .collect::<HashMap<_, _>>();

    let mut result = vec![];
    for (post_id, count) in stats {
        let post = posts.get(&post_id).cloned().unwrap_or("".to_string());
        result.push(AnalysisStatsPost { post, count });
    }
    Ok(result)
}

pub async fn read_aor_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsAor>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_aor_id_5min::Column::Dt
            .gte(since)
            .and(stats_group_aor_id_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<i64, i64> = stats_group_aor_id_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_aor_id_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.aor_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_aor_id_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_aor_id_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_aor_id_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.aor_id).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (aor_id, count) in stats {
        result.push(AnalysisStatsAor { aor_id, count });
    }
    Ok(result)
}

pub async fn read_frequency_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsFreq>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_freq_5min::Column::Dt
            .gte(since)
            .and(stats_group_freq_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> = stats_group_freq_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_freq_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.frequency).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_freq_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_freq_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_freq_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.frequency).or_insert(0) += s.quantity as i64;
            });
    };

    let new_freqs = crate::rer_importer::analysis::stats::get_new_freqs(
        &env.dbx, dt_since, dt_till,
    )
    .await
    .context(h!())?;
    let mut result = vec![];
    for (freq, count) in stats {
        let is_new = new_freqs.contains(&freq);
        result.push(AnalysisStatsFreq {
            is_new,
            freq,
            count,
        });
    }
    Ok(result)
}

pub async fn read_callsign_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsCallsign>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_callsign_5min::Column::Dt
            .gte(since)
            .and(stats_group_callsign_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> =
        stats_group_callsign_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_callsign_5min::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.callsign).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_callsign_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_callsign_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_callsign_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.callsign).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (callsign, count) in stats {
        result.push(AnalysisStatsCallsign { callsign, count });
    }
    Ok(result)
}

pub async fn read_tag_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsTag>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_tag_5min::Column::Dt
            .gte(since)
            .and(stats_group_tag_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<i64, i64> = stats_group_tag_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_tag_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.tag_id).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_tag_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_tag_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_tag_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.tag_id).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (tag_id, count) in stats {
        result.push(AnalysisStatsTag { tag_id, count });
    }
    Ok(result)
}

pub async fn read_unit_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsUnit>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_unit_5min::Column::Dt
            .gte(since)
            .and(stats_group_unit_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> = stats_group_unit_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_unit_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .fold(HashMap::new(), |mut acc, s| {
            *acc.entry(s.unit).or_insert(0) += s.quantity as i64;
            acc
        });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_unit_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_unit_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_unit_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.unit).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (unit, count) in stats {
        result.push(AnalysisStatsUnit { unit, count });
    }
    Ok(result)
}

pub async fn read_location_stats_from_table(
    env: &Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<AnalysisStatsLocation>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_location_5min::Column::Dt
            .gte(since)
            .and(stats_group_location_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let mut stats: HashMap<String, i64> =
        stats_group_location_5min::Entity::find()
            .filter(interval_5mins_filter)
            .filter(
                stats_group_location_5min::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s.location).or_insert(0) += s.quantity as i64;
                acc
            });

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_location_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        stats_group_location_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_location_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?
            .into_iter()
            .for_each(|s| {
                *stats.entry(s.location).or_insert(0) += s.quantity as i64;
            });
    };
    let mut result = vec![];
    for (location, count) in stats {
        result.push(AnalysisStatsLocation { location, count });
    }
    Ok(result)
}

fn collect_time_intervals_for_stats(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<(Vec<(NaiveDateTime, NaiveDateTime)>, Vec<NaiveDate>)> {
    let mut intervals_5min = vec![];
    let mut days = vec![];
    if dt_till - dt_since < Duration::days(2) {
        intervals_5min.push((dt_since, dt_till));
    } else {
        let date_after_since_dt =
            dt_since.and_utc().with_timezone(&get_tz()).date_naive()
                + Duration::days(1);
        let dt_since_eod =
            start_of_day(date_after_since_dt, get_tz()).c(h!())?;
        intervals_5min.push((dt_since, dt_since_eod));

        let date_till_dt =
            dt_till.and_utc().with_timezone(&get_tz()).date_naive();
        let dt_till_sod = start_of_day(date_till_dt, get_tz()).c(h!())?;
        intervals_5min.push((dt_till_sod, dt_till));

        let mut date = date_after_since_dt;
        while date <= date_till_dt {
            days.push(date);
            date += Duration::days(1);
        }
    }
    Ok((intervals_5min, days))
}

pub fn start_of_day<Tz: TimeZone>(
    since_date: NaiveDate,
    timezone: Tz,
) -> Result<NaiveDateTime, AppError> {
    Ok(NaiveDateTime::new(
        since_date,
        NaiveTime::from_hms_opt(0, 0, 0).c(h!())?,
    )
    .and_local_timezone(timezone)
    .earliest()
    .c(h!())?
    .naive_utc())
}

// TODO unit tests on time functions
