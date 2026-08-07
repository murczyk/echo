use super::types::{FileAnalysisInput, TagRuleDefinition};
use super::{bl, query, rules};
use crate::types::Env;
use crate::utils::worker_watch;
use anyhow::{ensure, Context};
use sea_orm::TransactionTrait;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const ANALYSIS_BATCH_SIZE: u64 = 1_000;
const IDLE_SLEEP: Duration = Duration::from_millis(250);
const ERROR_SLEEP: Duration = Duration::from_secs(2);

pub(crate) async fn run_nofail(
    env: Arc<Env>,
    cancellation_token: CancellationToken,
) {
    log::info!("device_file_analytics_worker started");
    loop {
        if cancellation_token.is_cancelled() {
            log::info!(
                "device_file_analytics_worker received cancellation token"
            );
            break;
        }
        let _loop_guard =
            worker_watch::loop_guard("device_file_analytics_worker");
        let sleep = match run_tick(env.as_ref()).await {
            Ok(true) => continue,
            Ok(false) => IDLE_SLEEP,
            Err(error) => {
                log::error!("device_file_analytics_worker failed: {error:#}");
                ERROR_SLEEP
            }
        };
        tokio::select! {
            _ = cancellation_token.cancelled() => break,
            _ = tokio::time::sleep(sleep) => {}
        }
    }
}

pub(in crate::devices) async fn run_tick(env: &Env) -> anyhow::Result<bool> {
    let file_registry_db = env
        .file_registry_db()
        .context("file registry database is unavailable")?;
    let file_transaction = file_registry_db
        .connection()
        .begin()
        .await
        .context("begin file analytics transaction")?;
    let files =
        query::lock_pending_files(&file_transaction, ANALYSIS_BATCH_SIZE)
            .await
            .context("lock pending file analytics rows")?;
    if files.is_empty() {
        file_transaction
            .commit()
            .await
            .context("commit empty file analytics transaction")?;
        return Ok(false);
    }

    let main_transaction = env
        .dbx
        .begin()
        .await
        .context("begin main analytics transaction")?;
    let active_rules = query::load_active_tag_rules(&main_transaction)
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
    let compiled_rules =
        rules::compile_tag_rules(definitions).map_err(|error| {
            anyhow::anyhow!(
                "analytics rule validation failed with {} at {}: {}",
                error.code,
                error.path,
                error.message
            )
        })?;

    let file_entry_ids = files.iter().map(|file| file.id).collect::<Vec<_>>();
    let mut assignments = Vec::new();
    for file in &files {
        let result = rules::analyze(
            &compiled_rules,
            &FileAnalysisInput {
                name: file.name.clone(),
                absolute_path: file.absolute_path.clone().unwrap_or_default(),
                extension: file.extension.clone(),
            },
        );
        assignments.extend(bl::assignments_for_file(file, result.matched_tags));
    }
    query::replace_file_tags(&main_transaction, &file_entry_ids, &assignments)
        .await
        .context("replace analyzed file tags")?;
    main_transaction
        .commit()
        .await
        .context("commit analyzed file tags")?;

    let marked = query::mark_files_analyzed(&file_transaction, &file_entry_ids)
        .await
        .context("mark file analytics rows complete")?;
    ensure!(
        marked == file_entry_ids.len() as u64,
        "marked {marked} of {} file analytics rows complete",
        file_entry_ids.len()
    );
    file_transaction
        .commit()
        .await
        .context("commit file analytics completion")?;
    Ok(true)
}
