use crate::config::GROUP_STATS_DAY_TTL_DAYS;
use crate::entities::network_invalidation_task;
use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode, OneoffBackfillInboxNetworksPs};
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;

pub async fn oneoff_backfill_inbox_networks(
    mode: Mode,
    ps: OneoffBackfillInboxNetworksPs,
) -> Result<(), AppError> {
    let since_ts = parse_m_ts(ps.start).unwrap_or(
        Utc::now().naive_utc()
            - chrono::Duration::days(GROUP_STATS_DAY_TTL_DAYS),
    );
    let till_ts = parse_m_ts(ps.end).unwrap_or(Utc::now().naive_utc());
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    network_invalidation_task::ActiveModel {
        since_ts: Set(since_ts),
        till_ts: Set(till_ts),
        sigint_network_id: Set(None),
        id: NotSet,
        frequency: NotSet,
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        is_for_old_worker: NotSet,
        group_master_key: NotSet,
    }
    .insert(&db)
    .await
    .c(h!())?;
    // workers will pick up this work later on
    Ok(())
}

fn parse_m_ts(m_ts_txt: Option<String>) -> anyhow::Result<NaiveDateTime> {
    let ts_txt = m_ts_txt.c(h!())?;
    NaiveDateTime::parse_from_str(&ts_txt, "%Y-%m-%dT%H:%M:%S").c(h!())
}
