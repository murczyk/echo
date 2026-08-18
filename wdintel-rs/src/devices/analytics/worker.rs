use super::{queue, rules, rules::CompiledTagRules};
use crate::{h, types::Env};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) const WORKER_COUNT: usize = 4;
const PREPARATION_PAGE_SIZE: u64 = 1_000;
const CLAIM_BATCH_SIZE: u64 = 1_000;
const LEASE_DURATION_SECS: i64 = 60;
const INFRASTRUCTURE_ERROR_BACKOFF_SECS: u64 = 2;
const MONITOR_INTERVAL_SECS: u64 = 60;
const STUCK_RUN_ALERT_SECS: u64 = 15 * 60;
const IDLE_SLEEP: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct RuleCache {
    cached: RwLock<HashMap<Uuid, Arc<CompiledTagRules>>>,
}

impl RuleCache {
    async fn get(
        &self,
        file_db: &sea_orm::DatabaseConnection,
        definition_id: Uuid,
    ) -> Result<Arc<CompiledTagRules>> {
        if let Some(rules) = self.cached.read().await.get(&definition_id) {
            return Ok(rules.clone());
        }
        let snapshot = queue::load_rule_snapshot(file_db, definition_id)
            .await
            .context(h!())?;
        let rules = Arc::new(snapshot.compile().context(h!())?);
        let mut cached = self.cached.write().await;
        Ok(cached
            .entry(definition_id)
            .or_insert_with(|| rules.clone())
            .clone())
    }
}

pub(crate) async fn run_nofail(
    env: Arc<Env>,
    cancellation_token: CancellationToken,
    rule_cache: Arc<RuleCache>,
) {
    loop {
        if cancellation_token.is_cancelled() {
            break;
        }
        match run_tick(
            &env,
            &rule_cache,
            PREPARATION_PAGE_SIZE,
            CLAIM_BATCH_SIZE,
            LEASE_DURATION_SECS,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => {
                tokio::select! {
                    () = cancellation_token.cancelled() => break,
                    () = tokio::time::sleep(IDLE_SLEEP) => {}
                }
            }
            Err(error) => {
                if let Some(metrics) = &env.metrics {
                    metrics.record_file_analysis_worker_error();
                }
                log::error!("file analysis worker tick failed: {error:?}");
                tokio::select! {
                    () = cancellation_token.cancelled() => break,
                    () = tokio::time::sleep(Duration::from_secs(
                        INFRASTRUCTURE_ERROR_BACKOFF_SECS,
                    )) => {}
                }
            }
        }
    }
}

pub(crate) async fn monitor_nofail(
    env: Arc<Env>,
    cancellation_token: CancellationToken,
) {
    let mut interval =
        tokio::time::interval(Duration::from_secs(MONITOR_INTERVAL_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = cancellation_token.cancelled() => break,
            _ = interval.tick() => {
                if let Err(error) = record_operational_state(&env).await {
                    if let Some(metrics) = &env.metrics {
                        metrics.record_file_analysis_worker_error();
                    }
                    log::error!(
                        "file analysis operational snapshot failed: {error:?}"
                    );
                }
            }
        }
    }
}

async fn record_operational_state(env: &Env) -> Result<()> {
    let snapshot =
        queue::load_operational_snapshot(env.file_registry_db()?.connection())
            .await
            .context(h!())?;
    if let Some(metrics) = &env.metrics {
        metrics.record_file_analysis_operational_state(
            snapshot.sync_runs,
            snapshot.manual_runs,
            snapshot.preparing_runs,
            snapshot.running_runs,
            snapshot.completed_runs,
            snapshot.active_leases,
            snapshot.expired_leases,
            snapshot.oldest_preparing_age_secs,
            snapshot.oldest_running_age_secs,
        );
    }
    if snapshot.expired_leases > 0 {
        log::warn!(
            "expired file analysis leases await reclaim: count={}",
            snapshot.expired_leases,
        );
    }
    let alert_age_secs = STUCK_RUN_ALERT_SECS as f64;
    if snapshot.oldest_preparing_age_secs >= alert_age_secs {
        log::warn!(
            "file analysis preparation is persistently non-terminal: run_count={}, oldest_age_secs={:.0}",
            snapshot.preparing_runs,
            snapshot.oldest_preparing_age_secs,
        );
    }
    if snapshot.oldest_running_age_secs >= alert_age_secs {
        log::warn!(
            "file analysis execution is persistently non-terminal: run_count={}, oldest_age_secs={:.0}",
            snapshot.running_runs,
            snapshot.oldest_running_age_secs,
        );
    }
    if snapshot.unsupported_nonterminal_runs > 0 {
        log::error!(
            "unsupported file analysis definitions have non-terminal runs: count={}",
            snapshot.unsupported_nonterminal_runs,
        );
    }
    Ok(())
}

pub(crate) async fn run_tick(
    env: &Env,
    rule_cache: &RuleCache,
    preparation_page_size: u64,
    claim_batch_size: u64,
    lease_duration_secs: i64,
) -> Result<bool> {
    let file_db = env.file_registry_db()?.connection();
    let preparation_started_at = Instant::now();
    let preparation = queue::prepare_next_page(file_db, preparation_page_size)
        .await
        .context(h!())?;
    if let Some(metrics) = &env.metrics {
        metrics.record_file_analysis_preparation(
            preparation.inserted_count,
            preparation_started_at.elapsed(),
        );
        if let Some(duration_secs) = preparation.completed_run_duration_secs {
            metrics.record_file_analysis_run_completion_duration(duration_secs);
        }
    }
    let claim_started_at = Instant::now();
    let claimed = queue::claim_analysis_batch(
        file_db,
        claim_batch_size,
        lease_duration_secs,
    )
    .await
    .context(h!())?;
    if let Some(metrics) = &env.metrics {
        metrics.record_file_analysis_claim(claim_started_at.elapsed());
    }
    let Some(first) = claimed.first() else {
        return Ok(preparation.did_work);
    };
    let run_id = first.run_id;
    let definition_id = first.definition_id;
    let lease_token = first.lease_token;
    if claimed.iter().any(|item| {
        item.run_id != run_id
            || item.definition_id != definition_id
            || item.lease_token != lease_token
    }) {
        queue::release_analysis_batch(file_db, lease_token)
            .await
            .context(h!())?;
        return Err(anyhow::anyhow!(
            "analysis claim crossed immutable batch boundaries"
        ));
    }
    let rules = match rule_cache.get(file_db, definition_id).await {
        Ok(rules) => rules,
        Err(error) => {
            let _ = queue::release_analysis_batch(file_db, lease_token).await;
            return Err(error);
        }
    };
    let completed = claimed
        .iter()
        .map(|item| queue::CompletedAnalysisFile {
            run_id: item.run_id,
            file_id: item.file_id,
            metadata_revision: item.metadata_revision,
            matched_tag_ids: rules::analyze(&rules, &item.input()).matched_tags,
        })
        .collect::<Vec<_>>();
    let completion =
        match queue::complete_analysis_batch(file_db, lease_token, &completed)
            .await
        {
            Ok(completion) => completion,
            Err(error) => {
                let _ =
                    queue::release_analysis_batch(file_db, lease_token).await;
                return Err(error);
            }
        };
    if let Some(metrics) = &env.metrics {
        metrics.record_file_analysis_completion(
            completion.completed_count,
            completion.published_count,
            completion.result_write_duration_secs,
            completion.current_publish_duration_secs,
            completion.run_completion_duration_secs,
        );
    }
    log::debug!(
        "file analysis batch completed: run_id={run_id}, definition_id={definition_id}, run_sequence={}, item_count={}",
        first.run_sequence,
        completion.completed_count,
    );
    Ok(true)
}
