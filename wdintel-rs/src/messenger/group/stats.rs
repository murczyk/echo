use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use anyhow::Context;
use chrono::*;
use itertools::Itertools;
use log::*;
use sea_orm::prelude::Json;
use sea_orm::*;
use std::collections::*;
use tokio::time::sleep;

pub async fn worker_calculate_group_stats(mode: Mode) {
    info!("worker_calculate_group_stats started");
    let mut last_calculated = Utc::now().naive_utc() - Duration::days(1);
    loop {
        sleep(std::time::Duration::from_secs(
            WORKER_CALCULATE_GROUP_STATS_SLEEP_SEC,
        ))
        .await;
        let now = Utc::now().naive_utc();
        if last_calculated
            + Duration::minutes(WORKER_CALCULATE_GROUP_STATS_EVERY_MINUTES_NUM)
            > now
        {
            continue;
        }
        let till_ts = now;
        let since_ts =
            now - Duration::minutes(WORKER_CALCULATE_GROUP_STATS_SINCE_MINS);
        let dbx = match crate::new_pg_pool_from_mode(mode).await {
            Ok(db) => db,
            Err(e) => {
                error!("failed to establish db connection at worker_calculate_group_stats: {e:#?}");
                continue;
            }
        };
        if let Err(e) = recalculate_group_stats(&dbx, since_ts, till_ts).await {
            error!("failed to recalculate group stats: {e:#?}");
        }
        last_calculated = now;
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
    pub callsigns: Option<Json>,
    pub location_v2: Option<String>,
    pub unit_v2: Option<String>,
    pub tags: Option<Json>,
}

fn round_to_5min(ts: NaiveDateTime) -> anyhow::Result<NaiveDateTime> {
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
            let locations: Vec<String> = x
                .location_v2
                .map(|x| x.split("|").map(|x| x.to_string()).collect_vec())
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

    recalculate_day_stats_group(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_freq(dbx, freq_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_freq(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_aor_id(dbx, aor_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_aor_id(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_post_id(dbx, post_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_post_id(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_sender(dbx, sender_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_sender(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_callsign(dbx, callsign_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_callsign(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_unit(dbx, unit_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_unit(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_location(dbx, location_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_location(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_5min_stats_tag(dbx, tag_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats_tag(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    let cutoff_5min = Utc::now() - Duration::days(GROUP_STATS_DAY_TTL_DAYS);
    stats_group_freq_day::Entity::delete_many()
        .filter(stats_group_freq_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_aor_id_day::Entity::delete_many()
        .filter(stats_group_aor_id_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_sender_day::Entity::delete_many()
        .filter(stats_group_sender_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_callsign_day::Entity::delete_many()
        .filter(stats_group_callsign_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_unit_day::Entity::delete_many()
        .filter(stats_group_unit_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_location_day::Entity::delete_many()
        .filter(stats_group_location_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_post_id_day::Entity::delete_many()
        .filter(stats_group_post_id_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_tag_day::Entity::delete_many()
        .filter(stats_group_tag_day::Column::CreatedAt.lt(cutoff_5min))
        .exec(dbx)
        .await
        .context(h!())?;
    let cutoff_day = Utc::now() - Duration::days(GROUP_STATS_5MIN_TTL_DAYS);
    stats_group_5min::Entity::delete_many()
        .filter(stats_group_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_day::Entity::delete_many()
        .filter(stats_group_day::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_freq_5min::Entity::delete_many()
        .filter(stats_group_freq_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_aor_id_5min::Entity::delete_many()
        .filter(stats_group_aor_id_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_sender_5min::Entity::delete_many()
        .filter(stats_group_sender_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_callsign_5min::Entity::delete_many()
        .filter(stats_group_callsign_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_unit_5min::Entity::delete_many()
        .filter(stats_group_unit_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_location_5min::Entity::delete_many()
        .filter(stats_group_location_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_post_id_5min::Entity::delete_many()
        .filter(stats_group_post_id_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_tag_5min::Entity::delete_many()
        .filter(stats_group_tag_5min::Column::CreatedAt.lt(cutoff_day))
        .exec(dbx)
        .await
        .context(h!())?;
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_freq_5min::Entity::find()
        .filter(stats_group_freq_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_freq_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_aor_id_5min::Entity::find()
        .filter(stats_group_aor_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_aor_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_post_id_5min::Entity::find()
        .filter(stats_group_post_id_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_post_id_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

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
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_sender_5min::Entity::find()
        .filter(stats_group_sender_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_sender_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_tag_5min::Entity::find()
        .filter(stats_group_tag_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_tag_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
                    Some(((key_1.clone(), key_2.clone()), count))
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

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
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts =
        crate::stats::start_of_day(since_date, get_tz()).c(h!())?;

    let stats_5min = stats_group_unit_5min::Entity::find()
        .filter(stats_group_unit_5min::Column::Dt.gte(since_start_of_day_ts))
        .filter(stats_group_unit_5min::Column::Dt.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.dt.and_utc().with_timezone(&get_tz()).date_naive();
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
