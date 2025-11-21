use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::rer_importer::types::*;
use crate::sigint::freq::types::FreqGroupsMessageCountByDay;
use crate::types::{Env, Mode, ShortContext};
use anyhow::Context;
use chrono::*;
use itertools::Itertools;
use log::info;
use log::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

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
        None => start_of_day(till_ts.date() - Duration::days(1)).c(h!())?,
    };
    let config = read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    recalculate_group_stats(&dbx, since_ts, till_ts, true)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn oneoff_calculate_historic_stats(
    mode: Mode,
) -> Result<(), AppError> {
    let config = read_config(mode).context(h!())?;
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

    // calculate for part of the day today in order to proceed with rest of the days from start to finish
    let date_till_dt = get_local_date(till_ts);
    let dt_till_sod = start_of_day(date_till_dt).c(h!())?;
    recalculate_group_stats(&dbx, dt_till_sod, till_ts, true)
        .await
        .context(h!())?;
    till_ts = dt_till_sod;

    //calculate for all the remaining days
    while till_ts > min_since_ts {
        let since_ts = till_ts - Duration::days(1);
        let duration = (since_ts - min_since_ts).num_days();
        info!("oneoff_calculate_historic_stats: from {since_ts} to {till_ts}, remaining {duration} days");
        recalculate_group_stats(&dbx, since_ts, till_ts, true)
            .await
            .context(h!())?;
        till_ts = since_ts;
    }
    info!("oneoff_calculate_historic_stats: done");
    Ok(())
}

pub fn can_read_stats_aggregated(
    config: &Config,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> bool {
    if dt_till - dt_since < Duration::minutes(STATS_READ_FROM_TABLE_MINIMUM_MIN)
    {
        return false;
    }
    config
        .feature_group_stats_aggregated
        .unwrap_or(FEATURE_GROUP_STATS_AGGREGATED_DEFAULT)
}

pub fn should_read_stats_aggregated(
    req: &actix_web::web::Json<AnalysisStatsReq>,
    env: &actix_web::web::Data<Env>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<bool> {
    if !can_read_stats_aggregated(&env.config, dt_since, dt_till) {
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
        None => Ok(true),
        Some(q) => Ok(q.is_empty()),
    }
}

pub async fn get_last_hour_stats(
    dbx: &DatabaseConnection,
    master_keys: Vec<String>,
) -> anyhow::Result<Vec<(NaiveDateTime, HashMap<String, i32>)>> {
    let now = round_to_5min(Utc::now().naive_utc()).c(h!())?;
    let stats = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::GroupMasterKey.is_in(master_keys))
        .filter(stats_group_5min::Column::Dt.lte(now))
        .filter(stats_group_5min::Column::Dt.gt(now - Duration::hours(1)))
        .all(dbx)
        .await
        .c(h!())?;
    let mut ts = now - Duration::hours(1);
    let mut result = vec![];
    while ts < now {
        ts += Duration::minutes(5);
        let group_stats = stats
            .clone()
            .into_iter()
            .filter(|x| x.dt.eq(&ts))
            .fold(HashMap::new(), |mut acc, m| {
                *acc.entry(m.group_master_key).or_insert(0) += m.quantity;
                acc
            });
        result.push((ts, group_stats));
    }
    Ok(result)
}

pub async fn read_group_stats_aggregated(
    dbx: &DatabaseConnection,
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
        .all(dbx)
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
            .all(dbx)
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

pub async fn read_sender_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_post_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_aor_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_frequency_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_frequency_stats_day(
    env: &actix_web::web::Data<Env>,
    master_keys: Vec<String>,
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<Vec<FreqGroupsMessageCountByDay>> {
    let (intervals_5min, days) =
        collect_time_intervals_for_stats(dt_since, dt_till).c(h!())?;

    let mut interval_5mins_filter = Condition::any();
    for (since, till) in intervals_5min {
        let filter = stats_group_freq_5min::Column::Dt
            .gte(since)
            .and(stats_group_freq_5min::Column::Dt.lt(till));
        interval_5mins_filter = interval_5mins_filter.add(filter);
    }

    let stats = stats_group_freq_5min::Entity::find()
        .filter(interval_5mins_filter)
        .filter(
            stats_group_freq_5min::Column::GroupMasterKey
                .is_in(master_keys.clone()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?;

    #[derive(Hash, Eq, PartialEq)]
    pub struct Key {
        pub freq: String,
        pub group: String,
        pub day: i64,
    }

    let mut result = HashMap::new();
    for s in stats {
        let key = Key {
            freq: s.frequency,
            group: s.group_master_key,
            day: start_of_day(get_local_date(s.dt))
                .c(h!())?
                .and_utc()
                .timestamp_millis(),
        };
        *result.entry(key).or_insert(0) += s.quantity;
    }

    if !days.is_empty() {
        let mut interval_day_filter = Condition::any();
        for d in days {
            let filter = stats_group_freq_day::Column::Dt.eq(d);
            interval_day_filter = interval_day_filter.add(filter);
        }
        let day_stats = stats_group_freq_day::Entity::find()
            .filter(interval_day_filter)
            .filter(
                stats_group_freq_day::Column::GroupMasterKey
                    .is_in(master_keys.clone()),
            )
            .all(&env.dbx)
            .await
            .c(h!())?;
        for s in day_stats {
            let key = Key {
                freq: s.frequency,
                group: s.group_master_key,
                day: start_of_day(s.dt).c(h!())?.and_utc().timestamp_millis(),
            };
            *result.entry(key).or_insert(0) += s.quantity;
        }
    };
    let result = result
        .into_iter()
        .map(|(key, count)| FreqGroupsMessageCountByDay {
            freq: key.freq,
            count: count as i64,
            group: key.group,
            day: key.day,
        })
        .collect();
    Ok(result)
}

pub async fn read_callsign_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_tag_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_unit_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

pub async fn read_location_stats_aggregated(
    env: &actix_web::web::Data<Env>,
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

fn is_filter_empty<T>(values: &Option<Vec<T>>) -> bool {
    match values {
        None => true,
        Some(values) => values.is_empty(),
    }
}

#[derive(FromQueryResult, Clone)]
struct StatsRow {
    pub created_at: NaiveDateTime,
    pub datetime: Option<NaiveDateTime>,
    pub group_master_key: String,
    pub freq: Option<String>,
    pub aor_id: Option<i64>,
    pub post_id: Option<i64>,
    pub sender: Option<String>,
    pub callsigns: Option<sea_orm::prelude::Json>,
    pub tags: Option<sea_orm::prelude::Json>,
    pub location_v2: Option<String>,
    pub unit_v2: Option<String>,
}

pub(crate) fn round_to_5min(
    ts: NaiveDateTime,
) -> anyhow::Result<NaiveDateTime> {
    let hour = ts.time().hour();
    let minute_raw = ts.time().minute();
    let minute = minute_raw - minute_raw % 5;
    let time = NaiveTime::from_hms_opt(hour, minute, 0).c(h!())?;
    Ok(NaiveDateTime::new(ts.date(), time))
}

pub async fn recalculate_group_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
    recalculate_day_stats: bool,
) -> Result<(), AppError> {
    let since_filter_1 = sigint_inbox_item::Column::Datetime
        .is_null()
        .and(signal_message::Column::CreatedAt.gte(since_ts));
    let since_filter_2 = sigint_inbox_item::Column::Datetime
        .is_not_null()
        .and(sigint_inbox_item::Column::Datetime.gte(since_ts));

    let till_filter_1 = sigint_inbox_item::Column::Datetime
        .is_null()
        .and(signal_message::Column::CreatedAt.lt(till_ts));
    let till_filter_2 = sigint_inbox_item::Column::Datetime
        .is_not_null()
        .and(sigint_inbox_item::Column::Datetime.lt(till_ts));

    let generic_stats = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            datasource_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_group::Relation::SignalGroupAor.def(),
        )
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::CreatedAt)
        .column(sigint_inbox_item::Column::Datetime)
        .column(datasource_group::Column::GroupMasterKey)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Callsigns)
        .column(sigint_inbox_item::Column::LocationV2)
        .column(sigint_inbox_item::Column::UnitV2)
        .column(sigint_inbox_item::Column::PostId)
        .column(sigint_inbox_item::Column::Tags)
        .column(signal_message::Column::Sender)
        .column(signal_group_aor::Column::AorId)
        .filter(since_filter_1.or(since_filter_2))
        .filter(till_filter_1.or(till_filter_2))
        .into_model::<StatsRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let group_stats = generic_stats
        .clone()
        .into_iter()
        .map(|x| (x.group_master_key, x.datetime.unwrap_or(x.created_at)))
        .collect_vec();
    let freq_stats = generic_stats
        .clone()
        .into_iter()
        .map(|x| {
            (
                (x.group_master_key, x.freq.unwrap_or("".to_string())),
                x.datetime.unwrap_or(x.created_at),
            )
        })
        .collect_vec();
    let sender_stats = generic_stats
        .clone()
        .into_iter()
        .map(|x| {
            (
                (x.group_master_key, x.sender.unwrap_or("".to_string())),
                x.datetime.unwrap_or(x.created_at),
            )
        })
        .collect_vec();
    let unit_stats = generic_stats
        .clone()
        .into_iter()
        .map(|x| {
            (
                (x.group_master_key, x.unit_v2.unwrap_or("".to_string())),
                x.datetime.unwrap_or(x.created_at),
            )
        })
        .collect_vec();
    let aor_stats = generic_stats
        .clone()
        .into_iter()
        .filter_map(|x| {
            x.aor_id.map(|aor_id| {
                (
                    (x.group_master_key, aor_id),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
        })
        .collect_vec();
    let post_stats = generic_stats
        .clone()
        .into_iter()
        .filter_map(|x| {
            x.post_id.map(|post_id| {
                (
                    (x.group_master_key, post_id),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
        })
        .collect_vec();
    let callsign_stats = generic_stats
        .clone()
        .into_iter()
        .flat_map(|x| {
            let callsign: Vec<String> = x
                .callsigns
                .and_then(move |c| serde_json::from_value(c).ok())
                .unwrap_or_default();
            callsign.into_iter().map(move |c| {
                (
                    (x.group_master_key.clone(), c),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
        })
        .collect_vec();
    let tag_stats = generic_stats
        .clone()
        .into_iter()
        .flat_map(|x| {
            let tags: Vec<i64> = x
                .tags
                .and_then(|c| serde_json::from_value(c).ok())
                .unwrap_or_default();
            tags.into_iter().map(move |t| {
                (
                    (x.group_master_key.clone(), t),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
        })
        .collect_vec();
    let location_stats = generic_stats
        .clone()
        .into_iter()
        .flat_map(|x| {
            let locations = x
                .location_v2
                .map(|x| {
                    x.split("|")
                        .map(|x| x.trim().to_string())
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default();
            locations.into_iter().map(move |l| {
                (
                    (x.group_master_key.clone(), l),
                    x.datetime.unwrap_or(x.created_at),
                )
            })
        })
        .collect_vec();

    let since_ts = round_to_5min(since_ts).c(h!())?;
    let till_ts = round_to_5min(till_ts).c(h!())?;

    update_5min_stats_group(dbx, group_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_group(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_freq(dbx, freq_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_freq(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_aor_id(dbx, aor_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_aor_id(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_post_id(dbx, post_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_post_id(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_sender(dbx, sender_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_sender(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_callsign(dbx, callsign_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_callsign(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_unit(dbx, unit_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_unit(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_location(dbx, location_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_location(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    update_5min_stats_tag(dbx, tag_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    if recalculate_day_stats {
        recalculate_day_stats_tag(dbx, since_ts, till_ts)
            .await
            .c(h!())?;
    }

    // FIXME uncomment
    // if recalculate_day_stats {
    //     let cutoff_short =
    //         Utc::now() - Duration::days(GROUP_STATS_5MIN_TTL_DAYS);
    //     stats_group_freq_5min::Entity::delete_many()
    //         .filter(stats_group_freq_5min::Column::CreatedAt.lt(cutoff_short))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_aor_id_5min::Entity::delete_many()
    //         .filter(stats_group_aor_id_5min::Column::CreatedAt.lt(cutoff_short))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_sender_5min::Entity::delete_many()
    //         .filter(stats_group_sender_5min::Column::CreatedAt.lt(cutoff_short))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_callsign_5min::Entity::delete_many()
    //         .filter(
    //             stats_group_callsign_5min::Column::CreatedAt.lt(cutoff_short),
    //         )
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_unit_5min::Entity::delete_many()
    //         .filter(stats_group_unit_5min::Column::CreatedAt.lt(cutoff_short))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_location_5min::Entity::delete_many()
    //         .filter(
    //             stats_group_location_5min::Column::CreatedAt.lt(cutoff_short),
    //         )
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_post_id_5min::Entity::delete_many()
    //         .filter(
    //             stats_group_post_id_5min::Column::CreatedAt.lt(cutoff_short),
    //         )
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_tag_5min::Entity::delete_many()
    //         .filter(stats_group_tag_5min::Column::CreatedAt.lt(cutoff_short))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //
    //     let cutoff_long = Utc::now() - Duration::days(GROUP_STATS_DAY_TTL_DAYS);
    //     stats_group_5min::Entity::delete_many()
    //         .filter(stats_group_5min::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_day::Entity::delete_many()
    //         .filter(stats_group_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_freq_day::Entity::delete_many()
    //         .filter(stats_group_freq_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_aor_id_day::Entity::delete_many()
    //         .filter(stats_group_aor_id_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_sender_day::Entity::delete_many()
    //         .filter(stats_group_sender_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_callsign_day::Entity::delete_many()
    //         .filter(stats_group_callsign_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_unit_day::Entity::delete_many()
    //         .filter(stats_group_unit_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_location_day::Entity::delete_many()
    //         .filter(stats_group_location_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_post_id_day::Entity::delete_many()
    //         .filter(stats_group_post_id_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    //     stats_group_tag_day::Entity::delete_many()
    //         .filter(stats_group_tag_day::Column::CreatedAt.lt(cutoff_long))
    //         .exec(dbx)
    //         .await
    //         .context(h!())?;
    // }
    Ok(())
}

async fn update_5min_stats_group(
    dbx: &DatabaseConnection,
    stats: Vec<(String, NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<String, i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for (group_master_key, count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_group(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.quantity));
    }

    let old_stats = stats_group_day::Entity::find()
        .filter(stats_group_day::Column::Dt.gte(since_date))
        .filter(stats_group_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<String, i32> = stats
            .iter()
            .filter_map(|(date, key, count)| {
                if current_date.eq(date) {
                    Some((key.clone(), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for (group_master_key, count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_freq(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_freq_5min::Entity::find()
        .filter(stats_group_freq_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_freq_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, frequency), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.frequency.eq(&frequency))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and frequency {frequency} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_freq_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    frequency: Set(frequency),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_freq(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_freq_5min::Entity::find()
        .filter(stats_group_freq_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_freq_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.frequency, rec.quantity));
    }

    let old_stats = stats_group_freq_day::Entity::find()
        .filter(stats_group_freq_day::Column::Dt.gte(since_date))
        .filter(stats_group_freq_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, frequency), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.frequency.eq(&frequency))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and frequency {frequency} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_freq_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    frequency: Set(frequency),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_aor_id(
    dbx: &DatabaseConnection,
    stats: Vec<((String, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_aor_id_5min::Entity::find()
        .filter(stats_group_aor_id_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_aor_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, aor_id), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.aor_id.eq(&aor_id))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and aor_id {aor_id} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_aor_id_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    aor_id: Set(aor_id),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_aor_id(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_aor_id_5min::Entity::find()
        .filter(stats_group_aor_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_aor_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.aor_id, rec.quantity));
    }

    let old_stats = stats_group_aor_id_day::Entity::find()
        .filter(stats_group_aor_id_day::Column::Dt.gte(since_date))
        .filter(stats_group_aor_id_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, aor_id), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.aor_id.eq(&aor_id))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and aor_id {aor_id} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_aor_id_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    aor_id: Set(aor_id),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_post_id(
    dbx: &DatabaseConnection,
    stats: Vec<((String, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_post_id_5min::Entity::find()
        .filter(stats_group_post_id_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_post_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, post_id), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.post_id.eq(&post_id))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and post_id {post_id} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_post_id_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    post_id: Set(post_id),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_post_id(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_post_id_5min::Entity::find()
        .filter(stats_group_post_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_post_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.post_id, rec.quantity));
    }

    let old_stats = stats_group_post_id_day::Entity::find()
        .filter(stats_group_post_id_day::Column::Dt.gte(since_date))
        .filter(stats_group_post_id_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, post_id), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.post_id.eq(&post_id))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and post_id {post_id} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_post_id_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    post_id: Set(post_id),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_location(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_location_5min::Entity::find()
        .filter(stats_group_location_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_location_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, location), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.location.eq(&location))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and location {location} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_location_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    location: Set(location),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_location(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_location_5min::Entity::find()
        .filter(
            stats_group_location_5min::Column::Dt.gte(since_start_of_day_ts),
        )
        .filter(stats_group_location_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.location, rec.quantity));
    }

    let old_stats = stats_group_location_day::Entity::find()
        .filter(stats_group_location_day::Column::Dt.gte(since_date))
        .filter(stats_group_location_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, location), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.location.eq(&location))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and location {location} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_location_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    location: Set(location),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_sender(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_sender_5min::Entity::find()
        .filter(stats_group_sender_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_sender_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, sender), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.sender.eq(&sender))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and sender {sender} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_sender_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    sender: Set(sender),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_sender(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_sender_5min::Entity::find()
        .filter(stats_group_sender_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_sender_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.sender, rec.quantity));
    }

    let old_stats = stats_group_sender_day::Entity::find()
        .filter(stats_group_sender_day::Column::Dt.gte(since_date))
        .filter(stats_group_sender_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, sender), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.sender.eq(&sender))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and sender {sender} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_sender_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    sender: Set(sender),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_tag(
    dbx: &DatabaseConnection,
    stats: Vec<((String, i64), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_tag_5min::Entity::find()
        .filter(stats_group_tag_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_tag_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, tag_id), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.tag_id.eq(&tag_id))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and tag {tag_id} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_tag_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    tag_id: Set(tag_id),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_tag(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_tag_5min::Entity::find()
        .filter(stats_group_tag_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_tag_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.tag_id, rec.quantity));
    }

    let old_stats = stats_group_tag_day::Entity::find()
        .filter(stats_group_tag_day::Column::Dt.gte(since_date))
        .filter(stats_group_tag_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, i64), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), *key_2), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, tag), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.tag_id.eq(&tag))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and tag {tag} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_tag_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    tag_id: Set(tag),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_callsign(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_callsign_5min::Entity::find()
        .filter(stats_group_callsign_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_callsign_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, callsign), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.callsign.eq(&callsign))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and callsign {callsign} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_callsign_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    callsign: Set(callsign),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_callsign(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_callsign_5min::Entity::find()
        .filter(
            stats_group_callsign_5min::Column::Dt.gte(since_start_of_day_ts),
        )
        .filter(stats_group_callsign_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.callsign, rec.quantity));
    }

    let old_stats = stats_group_callsign_day::Entity::find()
        .filter(stats_group_callsign_day::Column::Dt.gte(since_date))
        .filter(stats_group_callsign_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, callsign), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.callsign.eq(&callsign))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and callsign {callsign} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_callsign_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    callsign: Set(callsign),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn update_5min_stats_unit(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_unit_5min::Entity::find()
        .filter(stats_group_unit_5min::Column::Dt.gte(since_ts))
        .filter(stats_group_unit_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut old_stat_ids = vec![];

    let mut current_ts = since_ts;
    while current_ts <= till_ts {
        let since_ts = current_ts;
        let till_ts = current_ts + Duration::minutes(5);
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(key, ts)| {
                if !since_ts.gt(ts) && till_ts.gt(ts) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, s| {
                *acc.entry(s).or_insert(0) += 1;
                acc
            });
        let old_stats = old_stats_5min
            .iter()
            .filter(|s| s.dt.eq(&since_ts))
            .cloned()
            .collect_vec();
        for ((group_master_key, unit), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.unit.eq(&unit))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and unit {unit} at {since_ts}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_unit_5min::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    unit: Set(unit),
                    dt: Set(since_ts),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_ts = till_ts;
    }

    for e in old_stats_5min {
        if !old_stat_ids.contains(&e.id) {
            // deleting non-existent stats that are erroneous or for a deleted group
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

async fn recalculate_day_stats_unit(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = get_local_date(since_ts);
    let till_date = get_local_date(till_ts);
    let since_start_of_day_ts = start_of_day(since_date).c(h!())?;

    let stats_5min = stats_group_unit_5min::Entity::find()
        .filter(stats_group_unit_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_unit_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = get_local_date(rec.dt);
        stats.push((date, rec.group_master_key, rec.unit, rec.quantity));
    }

    let old_stats = stats_group_unit_day::Entity::find()
        .filter(stats_group_unit_day::Column::Dt.gte(since_date))
        .filter(stats_group_unit_day::Column::Dt.lte(till_date))
        .all(dbx)
        .await
        .context(h!())?;
    let mut old_stat_ids = vec![];

    let mut current_date = since_date;
    while current_date <= till_date {
        let group_stats: HashMap<(String, String), i32> = stats
            .iter()
            .filter_map(|(date, key_1, key_2, count)| {
                if current_date.eq(date) {
                    Some(((key_1.clone(), key_2.clone()), count))
                } else {
                    None
                }
            })
            .fold(HashMap::new(), |mut acc, (key, count)| {
                *acc.entry(key).or_insert(0) += count;
                acc
            });
        for ((group_master_key, unit), count) in group_stats {
            let mut old_entry = None;
            let old_stats = old_stats
                .iter()
                .filter(|s| s.dt.eq(&current_date))
                .filter(|s| s.group_master_key.eq(&group_master_key))
                .filter(|s| s.unit.eq(&unit))
                .cloned()
                .collect_vec();
            if old_stats.len() > 1 {
                error!("unexpected multiple stats for group {group_master_key} and unit {unit} at {since_date}: {old_stats:?}");
                for s in old_stats {
                    old_stat_ids.push(s.id);
                    s.delete(dbx).await.c(h!())?;
                }
            } else {
                old_entry = old_stats.first().cloned();
            }
            if let Some(entry) = old_entry {
                old_stat_ids.push(entry.id);
                if entry.quantity != count {
                    let mut model = entry.into_active_model();
                    model.quantity = Set(count);
                    model.update(dbx).await.c(h!())?;
                }
            } else {
                stats_group_unit_day::ActiveModel {
                    id: NotSet,
                    quantity: Set(count),
                    group_master_key: Set(group_master_key),
                    unit: Set(unit),
                    dt: Set(current_date),
                    created_at: NotSet,
                }
                .insert(dbx)
                .await
                .c(h!())?;
            }
        }
        current_date += Duration::days(1);
    }

    for e in old_stats {
        if !old_stat_ids.contains(&e.id) {
            e.delete(dbx).await.c(h!())?;
        }
    }
    Ok(())
}

fn collect_time_intervals_for_stats(
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> anyhow::Result<(Vec<(NaiveDateTime, NaiveDateTime)>, Vec<NaiveDate>)> {
    let mut intervals_5min = vec![];
    let mut days = vec![];
    if dt_till - dt_since < Duration::days(STATS_5MIN_MAX_NUM_DAYS) {
        intervals_5min.push((dt_since, dt_till));
    } else {
        let date_after_since_dt = get_local_date(dt_since) + Duration::days(1);
        let dt_since_eod = start_of_day(date_after_since_dt).c(h!())?;
        intervals_5min.push((dt_since, dt_since_eod));

        let date_till_dt = get_local_date(dt_till);
        let dt_till_sod = start_of_day(date_till_dt).c(h!())?;
        intervals_5min.push((dt_till_sod, dt_till));

        let mut date = date_after_since_dt;
        while date <= date_till_dt {
            days.push(date);
            date += Duration::days(1);
        }
    }
    Ok((intervals_5min, days))
}

pub fn start_of_day(since_date: NaiveDate) -> Result<NaiveDateTime, AppError> {
    Ok(NaiveDateTime::new(since_date, NaiveTime::MIN)
        .and_local_timezone(get_tz())
        .earliest()
        .c(h!())?
        .naive_utc())
}

fn get_local_date(since_ts: NaiveDateTime) -> NaiveDate {
    since_ts.and_utc().with_timezone(&get_tz()).date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_get_local_date() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(11, 5, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date);
    }

    #[test]
    fn test_get_local_date_early() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(1, 55, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date);
    }

    #[test]
    fn test_get_local_date_late() {
        let utc_date = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let ts = NaiveDateTime::new(
            utc_date,
            NaiveTime::from_hms_opt(21, 5, 0).unwrap(),
        );
        let actual_date = get_local_date(ts);
        assert_eq!(actual_date, utc_date + Duration::days(1));
    }

    #[test]
    fn test_start_of_day() {
        let dt = NaiveDate::from_ymd_opt(2025, 6, 6).unwrap();
        let expected_ts = NaiveDateTime::new(
            dt - Duration::days(1),
            NaiveTime::from_hms_opt(21, 0, 0).unwrap(),
        );
        let actual_ts = start_of_day(dt).unwrap();
        assert_eq!(actual_ts, expected_ts);
    }

    #[test]
    fn test_start_of_day_dst() {
        let dt = NaiveDate::from_ymd_opt(2025, 11, 11).unwrap();
        let expected_ts = NaiveDateTime::new(
            dt - Duration::days(1),
            NaiveTime::from_hms_opt(22, 0, 0).unwrap(),
        );
        let actual_ts = start_of_day(dt).unwrap();
        assert_eq!(actual_ts, expected_ts);
    }

    #[test]
    fn test_collect_time_intervals_for_stats_short_duration_if_branch() {
        // 2 days and 1 second
        let dt_since = ndt(2025, 10, 10, 10, 0);
        let dt_till = ndt(2025, 10, 12, 9, 59);

        assert!(dt_till - dt_since < Duration::days(STATS_5MIN_MAX_NUM_DAYS));

        let (intervals, days) =
            collect_time_intervals_for_stats(dt_since, dt_till).unwrap();
        assert_eq!(intervals.len(), 1, "Should have exactly one interval.");
        assert_eq!(
            intervals[0],
            (dt_since, dt_till),
            "The single interval should cover the whole range."
        );
        assert!(days.is_empty(), "The days vector should be empty.");
    }

    #[test]
    fn test_collect_time_intervals_for_stats_long_duration_else_branch() {
        let dt_since = ndt(2025, 10, 10, 10, 30);
        let dt_till = ndt(2025, 10, 15, 5, 15);
        assert!(dt_till - dt_since >= Duration::days(STATS_5MIN_MAX_NUM_DAYS));
        let (intervals, days) =
            collect_time_intervals_for_stats(dt_since, dt_till).unwrap();
        let tz = get_tz();
        let date_after_since_dt =
            dt_since.and_utc().with_timezone(&tz).date_naive()
                + Duration::days(1);
        let dt_since_eod = start_of_day(date_after_since_dt).unwrap();
        let date_till_dt = dt_till.and_utc().with_timezone(&tz).date_naive();
        let dt_till_sod = start_of_day(date_till_dt).unwrap();
        let expected_days = vec![
            NaiveDate::from_ymd_opt(2025, 10, 11).unwrap(),
            NaiveDate::from_ymd_opt(2025, 10, 12).unwrap(),
            NaiveDate::from_ymd_opt(2025, 10, 13).unwrap(),
            NaiveDate::from_ymd_opt(2025, 10, 14).unwrap(),
            NaiveDate::from_ymd_opt(2025, 10, 15).unwrap(),
        ];
        assert_eq!(
            intervals.len(),
            2,
            "Should have exactly two intervals (start and end parts)."
        );
        assert_eq!(
            intervals[0],
            (dt_since, dt_since_eod),
            "First interval should be from dt_since to start of the next day."
        );
        assert_eq!(
            intervals[1],
            (dt_till_sod, dt_till),
            "Second interval should be from start of the till day to dt_till."
        );
        assert_eq!(days, expected_days, "Days vector should contain all dates from the day after dt_since to the day of dt_till.");
    }

    fn ndt(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
    ) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }
}
