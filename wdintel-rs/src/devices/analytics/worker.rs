use super::types::{FileAnalysisInput, TagRuleDefinition};
use super::{query, queue, rules};
use crate::types::Env;
use crate::utils::worker_watch;
use anyhow::{ensure, Context};
use sea_orm::{DatabaseConnection, DatabaseTransaction, TransactionTrait};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const IDLE_SLEEP: Duration = Duration::from_millis(250);
const ERROR_SLEEP: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub(super) struct RuleSnapshot {
    pub revision: i64,
    pub rules: Arc<rules::CompiledTagRules>,
}

#[derive(Default)]
pub(crate) struct RuleCache {
    cached: RwLock<Option<RuleSnapshot>>,
}

impl RuleCache {
    pub(super) async fn load_rules(
        &self,
        file_db: &DatabaseConnection,
    ) -> anyhow::Result<RuleSnapshot> {
        let observed_revision = query::rule_set_revision(file_db)
            .await
            .context("read analytics tag rule revision")?;
        {
            let cached = self.cached.read().await;
            if let Some(cached) = cached.as_ref() {
                if cached.revision == observed_revision {
                    return Ok(cached.clone());
                }
            }
        }

        let mut cached = self.cached.write().await;
        if let Some(cached) = cached.as_ref() {
            if cached.revision == observed_revision {
                return Ok(cached.clone());
            }
        }

        let transaction = file_db
            .begin()
            .await
            .context("begin analytics rule snapshot transaction")?;
        let revision = query::lock_rule_set_revision(&transaction)
            .await
            .context("lock analytics tag rule revision")?;
        if let Some(cached) = cached.as_ref() {
            if cached.revision == revision {
                transaction
                    .commit()
                    .await
                    .context("commit cached analytics rule snapshot")?;
                return Ok(cached.clone());
            }
        }

        let active_rules = query::load_active_tag_rules(&transaction)
            .await
            .context("load active analytics tag rules")?;
        let mut definitions = Vec::with_capacity(active_rules.len());
        for active_rule in active_rules {
            let rule_expression =
                rules::deserialize_rule_expression(active_rule.rule_expression)
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "analytics tag {} has invalid rule {} at {}: {}",
                            active_rule.tag_id,
                            error.code,
                            error.path,
                            error.message
                        )
                    })?;
            definitions.push(TagRuleDefinition {
                tag_id: active_rule.tag_id,
                rule_expression,
            });
        }
        let rules = Arc::new(rules::compile_tag_rules(definitions).map_err(
            |error| {
                anyhow::anyhow!(
                    "analytics rule validation failed with {} at {}: {}",
                    error.code,
                    error.path,
                    error.message
                )
            },
        )?);
        transaction
            .commit()
            .await
            .context("commit analytics rule snapshot")?;

        let snapshot = RuleSnapshot { revision, rules };
        *cached = Some(snapshot.clone());
        Ok(snapshot)
    }
}

pub(crate) async fn run_nofail(
    env: Arc<Env>,
    cancellation_token: CancellationToken,
    rule_cache: Arc<RuleCache>,
    batch_size: u64,
) {
    log::info!(
        "device_file_analytics_worker started with batch_size={batch_size}"
    );
    loop {
        if cancellation_token.is_cancelled() {
            log::info!(
                "device_file_analytics_worker received cancellation token"
            );
            break;
        }
        let _loop_guard =
            worker_watch::loop_guard("device_file_analytics_worker");
        let sleep =
            match run_tick_with(env.as_ref(), rule_cache.as_ref(), batch_size)
                .await
            {
                Ok(true) => continue,
                Ok(false) => IDLE_SLEEP,
                Err(error) => {
                    log::error!(
                        "device_file_analytics_worker failed: {error:#}"
                    );
                    ERROR_SLEEP
                }
            };
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(sleep) => {}
        }
    }
}

#[cfg(test)]
pub(in crate::devices) async fn run_tick(env: &Env) -> anyhow::Result<bool> {
    let batch_size = env
        .config
        .file_registry
        .as_ref()
        .context("file registry configuration is unavailable")?
        .device_file_analytics_batch_size;
    run_tick_with(env, &RuleCache::default(), batch_size).await
}

pub(super) async fn run_tick_with(
    env: &Env,
    rule_cache: &RuleCache,
    batch_size: u64,
) -> anyhow::Result<bool> {
    ensure!(batch_size > 0, "file analytics batch size must be positive");
    let file_registry_db = env
        .file_registry_db()
        .context("file registry database is unavailable")?;
    let file_db = file_registry_db.connection();
    let backfilled =
        queue::backfill_missing_analysis_state(file_db, batch_size)
            .await
            .context("backfill missing file analysis state")?;
    let expanded = queue::expand_next_reanalysis_job(file_db, batch_size)
        .await
        .context("expand file reanalysis job")?;
    let recovered = queue::recover_expired_analysis_leases(file_db, batch_size)
        .await
        .context("recover expired file analysis leases")?;
    let rule_snapshot = rule_cache.load_rules(file_db).await?;
    let batch = queue::claim_pending_analysis_files(file_db, batch_size)
        .await
        .context("claim pending file analytics rows")?;
    if batch.files.is_empty() {
        return Ok(backfilled || expanded || recovered > 0);
    }

    let lease_token = batch.lease_token;
    if let Err(error) = process_claimed_batch(env, &rule_snapshot, batch).await
    {
        let error_text = format!("{error:#}");
        if let Err(release_error) =
            queue::release_claim_with_error(file_db, lease_token, &error_text)
                .await
        {
            return Err(error.context(format!(
                "additionally failed to release file analysis lease: {release_error}"
            )));
        }
        return Err(error);
    }
    Ok(true)
}

pub(super) async fn process_claimed_batch(
    env: &Env,
    rule_snapshot: &RuleSnapshot,
    batch: queue::ClaimedAnalysisBatch,
) -> anyhow::Result<()> {
    let mut matched_tags_by_file = batch
        .files
        .iter()
        .map(|file| {
            let result = rules::analyze(
                &rule_snapshot.rules,
                &FileAnalysisInput {
                    name: &file.name,
                    absolute_path: file
                        .absolute_path
                        .as_deref()
                        .unwrap_or_default(),
                    extension: file.extension.as_deref(),
                },
            );
            (file.file_entry_id, result.matched_tags)
        })
        .collect::<HashMap<_, _>>();

    let file_db = env
        .file_registry_db()
        .context("file registry database is unavailable")?
        .connection();
    let transaction = file_db
        .begin()
        .await
        .context("begin file analysis finalization transaction")?;
    let result = finalize_claimed_batch(
        rule_snapshot,
        &batch,
        &mut matched_tags_by_file,
        &transaction,
    )
    .await;
    match result {
        Ok(()) => transaction
            .commit()
            .await
            .context("commit file analysis finalization"),
        Err(error) => {
            if let Err(rollback_error) = transaction.rollback().await {
                return Err(error.context(format!(
                    "additionally failed to roll back file analysis finalization: {rollback_error}"
                )));
            }
            Err(error)
        }
    }
}

async fn finalize_claimed_batch(
    rule_snapshot: &RuleSnapshot,
    batch: &queue::ClaimedAnalysisBatch,
    matched_tags_by_file: &mut HashMap<Uuid, Vec<Uuid>>,
    file_transaction: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let file_entry_ids = batch
        .files
        .iter()
        .map(|file| file.file_entry_id)
        .collect::<Vec<_>>();
    let states = queue::lock_claim_states(
        file_transaction,
        batch.lease_token,
        &file_entry_ids,
    )
    .await
    .context("lock claimed file analysis state")?;
    let claimed_by_id = batch
        .files
        .iter()
        .map(|file| (file.file_entry_id, file))
        .collect::<HashMap<_, _>>();
    let valid_file_ids = states
        .iter()
        .filter_map(|state| {
            let claimed = claimed_by_id.get(&state.file_entry_id)?;
            (state.source_revision == claimed.source_revision
                && state.required_generation == claimed.required_generation)
                .then_some(state.file_entry_id)
        })
        .collect::<HashSet<_>>();

    if valid_file_ids.is_empty() {
        queue::release_claim(file_transaction, batch.lease_token)
            .await
            .context("release stale file analysis claim")?;
        return Ok(());
    }

    let mut valid_files = batch
        .files
        .iter()
        .filter(|file| valid_file_ids.contains(&file.file_entry_id))
        .collect::<Vec<_>>();
    valid_files.sort_unstable_by_key(|file| file.file_entry_id);
    let valid_file_entry_ids = valid_files
        .iter()
        .map(|file| file.file_entry_id)
        .collect::<Vec<_>>();
    let mut assignments = Vec::new();
    for file in valid_files {
        let file_entry_created_at =
            query::file_created_at_with_timezone(file.file_entry_created_at);
        for tag_id in matched_tags_by_file
            .remove(&file.file_entry_id)
            .unwrap_or_default()
        {
            assignments.push(query::FileTagAssignment {
                file_entry_id: file.file_entry_id,
                device_id: file.device_id,
                file_entry_created_at,
                tag_id,
            });
        }
    }

    let current_rule_revision = query::lock_rule_set_revision(file_transaction)
        .await
        .context("lock analytics rule revision for finalization")?;
    if current_rule_revision != rule_snapshot.revision {
        queue::release_claim(file_transaction, batch.lease_token)
            .await
            .context("release claim after analytics rule revision change")?;
        return Ok(());
    }
    let delta = query::reconcile_file_tags(
        file_transaction,
        &valid_file_entry_ids,
        &assignments,
    )
    .await
    .context("reconcile analyzed file tags")?;

    let acknowledged = queue::acknowledge_claim(
        file_transaction,
        batch.lease_token,
        &valid_file_entry_ids,
        rule_snapshot.revision,
    )
    .await
    .context("acknowledge file analysis claim")?;
    ensure!(
        acknowledged == valid_file_entry_ids.len() as u64,
        "acknowledged {acknowledged} of {} file analytics rows",
        valid_file_entry_ids.len()
    );
    queue::release_claim(file_transaction, batch.lease_token)
        .await
        .context("release stale rows from file analysis claim")?;

    log::debug!(
        "device file analytics tag delta: files={}, inserted={}, deleted={}, unchanged={}",
        valid_file_entry_ids.len(),
        delta.inserted,
        delta.deleted,
        delta.unchanged,
    );
    Ok(())
}
