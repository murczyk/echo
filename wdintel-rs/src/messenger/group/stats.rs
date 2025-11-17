use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use anyhow::Context;
use chrono::*;
use itertools::Itertools;
use log::*;
use sea_orm::*;
use std::collections::*;
use tokio::time::sleep;

pub async fn worker_calculate_group_stats(mode: Mode) {
    info!("worker_calculate_group_stats started");
    let mut last_calculated = Utc::now().naive_utc() - Duration::days(1);
    loop {
        sleep(std::time::Duration::from_secs(10)).await;
        let now = Utc::now().naive_utc();
        if last_calculated
            + Duration::minutes(WORKER_CALCULATE_GROUP_STATS_EVERY_MINUTES_NUM)
            > now
        {
            continue;
        }
        let till_ts = now;
        let since_ts = now - Duration::hours(1);
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
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::CreatedAt)
        .column(sigint_inbox_item::Column::Datetime)
        .column(datasource_group::Column::GroupMasterKey)
        .column(sigint_inbox_item::Column::Freq)
        .filter(since_filter_1.or(since_filter_2))
        .filter(till_filter_1.or(till_filter_2))
        .into_model::<StatsRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let stats = generic_stats
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

    let since_ts = round_to_5min(since_ts).c(h!())?;
    let till_ts = round_to_5min(till_ts).c(h!())?;

    update_stats_5min(dbx, stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_stats(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    update_freq_stats_5min(dbx, freq_stats, since_ts, till_ts)
        .await
        .c(h!())?;

    recalculate_day_freq_stats(dbx, since_ts, till_ts)
        .await
        .c(h!())?;

    //TODO calculate freq stats
    let cutoff = Utc::now() - Duration::days(GROUP_STATS_FREQ_TTL_DAYS);
    stats_group_freq_day::Entity::delete_many()
        .filter(stats_group_freq_day::Column::CreatedAt.lt(cutoff))
        .exec(dbx)
        .await
        .context(h!())?;
    stats_group_freq_5min::Entity::delete_many()
        .filter(stats_group_freq_5min::Column::CreatedAt.lt(cutoff))
        .exec(dbx)
        .await
        .context(h!())?;
    Ok(())
}

async fn update_stats_5min(
    dbx: &DatabaseConnection,
    stats: Vec<(String, NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::StartTs.gte(since_ts))
        .filter(stats_group_5min::Column::StartTs.lt(till_ts))
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
            .filter(|s| s.start_ts.eq(&since_ts))
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
                    start_ts: Set(since_ts),
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

async fn update_freq_stats_5min(
    dbx: &DatabaseConnection,
    stats: Vec<((String, String), NaiveDateTime)>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let old_stats_5min = stats_group_freq_5min::Entity::find()
        .filter(stats_group_freq_5min::Column::StartTs.gte(since_ts))
        .filter(stats_group_freq_5min::Column::StartTs.lt(till_ts))
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
            .filter(|s| s.start_ts.eq(&since_ts))
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
                    start_ts: Set(since_ts),
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

async fn recalculate_day_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts = NaiveDateTime::new(
        since_date,
        NaiveTime::from_hms_opt(0, 0, 0).c(h!())?,
    )
    .and_local_timezone(get_tz())
    .earliest()
    .c(h!())?
    .naive_utc();

    let stats_5min = stats_group_5min::Entity::find()
        .filter(stats_group_5min::Column::StartTs.gte(since_start_of_day_ts))
        .filter(stats_group_5min::Column::StartTs.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.start_ts.and_utc().with_timezone(&get_tz()).date_naive();
        stats.push((date, rec.group_master_key, rec.quantity));
    }

    let old_stats = stats_group_day::Entity::find()
        .filter(stats_group_day::Column::StatsDt.gte(since_date))
        .filter(stats_group_day::Column::StatsDt.lte(till_date))
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
                .filter(|s| s.stats_dt.eq(&current_date))
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
                    stats_dt: Set(current_date),
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

async fn recalculate_day_freq_stats(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<(), AppError> {
    let since_date = since_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let till_date = till_ts.and_utc().with_timezone(&get_tz()).date_naive();
    let since_start_of_day_ts = NaiveDateTime::new(
        since_date,
        NaiveTime::from_hms_opt(0, 0, 0).c(h!())?,
    )
    .and_local_timezone(get_tz())
    .earliest()
    .c(h!())?
    .naive_utc();

    let stats_5min = stats_group_freq_5min::Entity::find()
        .filter(
            stats_group_freq_5min::Column::StartTs.gte(since_start_of_day_ts),
        )
        .filter(stats_group_freq_5min::Column::StartTs.lt(till_ts))
        .all(dbx)
        .await
        .context(h!())?;

    let mut stats = vec![];
    for rec in stats_5min {
        let date = rec.start_ts.and_utc().with_timezone(&get_tz()).date_naive();
        stats.push((date, rec.group_master_key, rec.frequency, rec.quantity));
    }

    let old_stats = stats_group_freq_day::Entity::find()
        .filter(stats_group_freq_day::Column::StatsDt.gte(since_date))
        .filter(stats_group_freq_day::Column::StatsDt.lte(till_date))
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
                .filter(|s| s.stats_dt.eq(&current_date))
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
                    stats_dt: Set(current_date),
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

fn round_to_5min(ts: NaiveDateTime) -> anyhow::Result<NaiveDateTime> {
    let hour = ts.time().hour();
    let minute_raw = ts.time().minute();
    let minute = minute_raw - minute_raw % 5;
    let time = NaiveTime::from_hms_opt(hour, minute, 0).c(h!())?;
    Ok(NaiveDateTime::new(ts.date(), time))
}
