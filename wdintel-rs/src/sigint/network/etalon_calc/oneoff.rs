use crate::error::AppError;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode, OneoffBackfillInboxNetworksPs};
use chrono::NaiveDateTime;
use sea_orm::DatabaseConnection;

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
    super::enqueue_network_invalidation_task(
        db,
        since_ts,
        till_ts,
        super::NetworkInvalidationScope::default(),
        "oneoff inbox network backfill".to_string(),
    )
    .await
    .c(h!())
}

fn parse_m_ts(m_ts_txt: Option<String>) -> anyhow::Result<NaiveDateTime> {
    let ts_txt = m_ts_txt.c(h!())?;
    NaiveDateTime::parse_from_str(&ts_txt, "%Y-%m-%dT%H:%M:%S").c(h!())
}
