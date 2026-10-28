use crate::{h, types::ShortContext};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{ConnectionTrait, FromQueryResult};
use serde::{Deserialize, Serialize};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

static CACHE: OnceLock<Mutex<Option<(Instant, AiMonitoring)>>> =
    OnceLock::new();

pub(crate) async fn load_cached<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<AiMonitoring> {
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some((updated_at, monitoring)) = cache.as_ref() {
        if updated_at.elapsed()
            < Duration::from_secs(
                crate::config::AI_WORKER_MONITORING_CACHE_TTL_SECS,
            )
        {
            return Ok(monitoring.clone());
        }
    }
    let monitoring = load(db).await.c(h!())?;
    *cache = Some((Instant::now(), monitoring.clone()));
    Ok(monitoring)
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    FromQueryResult,
)]
pub struct AiQueueMonitoring {
    pub enabled: bool,
    pub last_completed_at_ms: Option<i64>,
    pub latest_processed_entry_created_at_ms: Option<i64>,
    pub oldest_pending_created_at_ms: Option<i64>,
    pub pending_jobs_estimate: i64,
    pub last_error_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AiMonitoring {
    pub callsign: AiQueueMonitoring,
    pub settlement: AiQueueMonitoring,
    pub position: AiQueueMonitoring,
}

pub(crate) async fn load<C: ConnectionTrait>(
    db: &C,
) -> anyhow::Result<AiMonitoring> {
    let mut settlement = queue(db, "settlement").await.c(h!())?;
    settlement.oldest_pending_created_at_ms =
        crate::ai_settlement::worker::oldest_eligible_job_created_at(db)
            .await
            .c(h!())?
            .map(|time| time.and_utc().timestamp_millis());
    Ok(AiMonitoring {
        callsign: queue(db, "callsign").await.c(h!())?,
        settlement,
        position: queue(db, "position").await.c(h!())?,
    })
}

async fn queue<C: ConnectionTrait>(
    db: &C,
    worker: &str,
) -> anyhow::Result<AiQueueMonitoring> {
    let oldest = if worker == "settlement" {
        "select null::timestamp as created_at".to_string()
    } else {
        format!("select created_at from ai_{worker}_worker_job order by created_at limit 1")
    };
    let query = format!(
        r#"
select coalesce(settings.worker_enabled,false) as enabled,
    (extract(epoch from progress.last_completed_at)*1000)::bigint as last_completed_at_ms,
    (extract(epoch from progress.latest_processed_entry_created_at)*1000)::bigint as latest_processed_entry_created_at_ms,
    (extract(epoch from oldest.created_at)*1000)::bigint as oldest_pending_created_at_ms,
    coalesce(stats.n_live_tup,0)::bigint as pending_jobs_estimate,
    (extract(epoch from progress.last_error_at)*1000)::bigint as last_error_at_ms
from (values(1)) singleton(id)
left join ai_{worker}_settings settings on settings.id=singleton.id
left join ai_worker_progress progress on progress.worker=$1
left join lateral ({oldest}) oldest on true
left join pg_stat_user_tables stats on stats.relid='public.ai_{worker}_worker_job'::regclass
"#
    );
    AiQueueMonitoring::find_by_statement(crate::ai_callsign::feedback::sql(
        &query,
        vec![worker.into()],
    ))
    .one(db)
    .await
    .c(h!())?
    .ok_or_else(|| anyhow::anyhow!("AI queue monitoring row is missing"))
    .c(h!())
}
