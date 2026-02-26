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
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let since_ts = parse_m_ts(ps.start).ok();
    let till_ts = parse_m_ts(ps.end).ok();
    backfill_inbox_networks(&db, since_ts, till_ts)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn backfill_inbox_networks(
    db: &DatabaseConnection,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> anyhow::Result<()> {
    let since_ts = since_ts.unwrap_or(
        Utc::now().naive_utc()
            - chrono::Duration::days(GROUP_STATS_DAY_TTL_DAYS),
    );
    let till_ts = till_ts.unwrap_or(Utc::now().naive_utc());
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
        group_master_key: NotSet,
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

fn parse_m_ts(m_ts_txt: Option<String>) -> anyhow::Result<NaiveDateTime> {
    let ts_txt = m_ts_txt.c(h!())?;
    NaiveDateTime::parse_from_str(&ts_txt, "%Y-%m-%dT%H:%M:%S").c(h!())
}
