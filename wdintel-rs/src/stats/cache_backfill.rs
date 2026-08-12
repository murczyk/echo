use crate::config::STATS_MIN_DATETIME_DAYS;
use crate::delta::{bgtask_log, finish_bgtask};
use crate::entities::bgtask;
use crate::error::AppError;
use crate::h;
use crate::report_history::set_bgtask_progress;
use crate::types::{Env, ShortContext};
use crate::users::ensure_admin;
use actix_web::{post, web::Data, web::Json};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::*;
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

static CACHE_BACKFILL_GATE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(1)));

#[post("/api/admin/group-stats-cache/backfill")]
pub async fn start_group_stats_cache_backfill(
    env: Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<i64>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let permit =
        CACHE_BACKFILL_GATE
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::BL {
                msg: "Перерахунок кешу статистики вже виконується.".to_string(),
            })?;
    let loglines = vec![
        format!("$ cache-backfill --retention-days {STATS_MIN_DATETIME_DAYS}"),
        "Підготовка перерахунку кешу статистики…".to_string(),
    ];
    let bgtask = bgtask::ActiveModel {
        id: NotSet,
        progress: Set(0),
        loglines: Set(serde_json::to_value(loglines).c(h!())?),
        running: Set(true),
        finished_with_error: Set(None),
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;
    let bgtask_id = bgtask.id;
    let env = env.clone();

    tokio::spawn(async move {
        let _permit = permit;
        let result = run_group_stats_cache_backfill(&env, bgtask_id).await;
        if let Err(error) = &result {
            let _ = bgtask_log(
                Some(bgtask_id),
                &format!("ПОМИЛКА: {error:?}"),
                &env.dbx,
            )
            .await;
        }
        if let Err(error) =
            finish_bgtask(Some(bgtask_id), &env.dbx, &result).await
        {
            eprintln!(
                "failed to finish group stats cache backfill task {bgtask_id}: {error:?}"
            );
        }
    });

    Ok(Json(bgtask_id))
}

async fn run_group_stats_cache_backfill(
    env: &Env,
    bgtask_id: i64,
) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    let ranges = cache_backfill_ranges(now)?;
    let range_count = ranges.len();
    let stats_redis =
        super::redis::GroupStatsRedis::new(env.stats_redis.clone());

    for (index, (since_ts, till_ts)) in ranges.into_iter().enumerate() {
        let stage = index + 1;
        bgtask_log(
            Some(bgtask_id),
            &format!("[{stage}/{range_count}] {since_ts} — {till_ts}"),
            &env.dbx,
        )
        .await
        .c(h!())?;
        super::recalculate_group_stats(
            &env.dbx,
            &stats_redis,
            since_ts,
            till_ts,
            true,
            true,
        )
        .await
        .c(h!())?;
        set_bgtask_progress(
            &env.dbx,
            bgtask_id,
            ((stage * 100) / range_count) as i64,
        )
        .await
        .c(h!())?;
    }

    set_bgtask_progress(&env.dbx, bgtask_id, 100)
        .await
        .c(h!())?;
    bgtask_log(
        Some(bgtask_id),
        "Готово. Кеш статистики перераховано.",
        &env.dbx,
    )
    .await
    .c(h!())?;
    Ok(())
}

fn cache_backfill_ranges(
    now: NaiveDateTime,
) -> Result<Vec<(NaiveDateTime, NaiveDateTime)>, AppError> {
    let min_since_ts = now - Duration::days(STATS_MIN_DATETIME_DAYS);
    let mut till_ts = now;
    let mut ranges = Vec::new();

    while till_ts > min_since_ts {
        let previous_date = super::get_local_date(
            till_ts
                .checked_sub_signed(Duration::nanoseconds(1))
                .c(h!())?,
        );
        let since_ts = super::start_of_day(previous_date).c(h!())?;
        ranges.push((since_ts, till_ts));
        till_ts = since_ts;
    }

    Ok(ranges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn cache_ranges_start_with_the_current_day_and_are_contiguous() {
        let now = NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(10, 41, 0)
            .unwrap();
        let ranges = cache_backfill_ranges(now).unwrap();

        assert_eq!(ranges.first().unwrap().1, now);
        assert!(ranges.last().unwrap().0 <= now - Duration::days(366));
        assert!(ranges.windows(2).all(|pair| pair[0].0 == pair[1].1));
    }
}
