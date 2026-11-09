//! AI certainty for messages that match several networks. See README.md.

use crate::config::{
    AI_NETWORK_MATCH_CONFIDENT_MIN_CERTAINTY,
    AI_NETWORK_MATCH_CONFIDENT_MIN_LEAD,
    AI_NETWORK_MATCH_ENQUEUE_MAX_AGE_HOURS,
    AI_NETWORK_MATCH_INSTRUCTIONS_MAX_CHARS,
};
use crate::entities::ai_network_match_result;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use chrono::{Duration, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, EntityTrait, Statement, Value,
};
use std::collections::{HashMap, HashSet};

mod context;
mod inference;
#[cfg(test)]
mod tests;
pub mod types;
pub mod worker;

pub use types::{InboxNetworkMatch, NetworkMatchCandidate};

/// Trims «Опис для ШІ»; blank text clears it.
pub fn normalize_instructions(value: String) -> anyhow::Result<Option<String>> {
    let value = value.trim();
    anyhow::ensure!(
        value.chars().count() <= AI_NETWORK_MATCH_INSTRUCTIONS_MAX_CHARS,
        AppError::BL {
            msg: format!(
                "Опис для ШІ задовгий: максимум {AI_NETWORK_MATCH_INSTRUCTIONS_MAX_CHARS} символів"
            )
        }
    );
    Ok((!value.is_empty()).then(|| value.to_string()))
}

/// Sorted unique network ids, which identify a candidate set.
pub(crate) fn candidate_set(network_ids: &[i64]) -> Vec<i64> {
    let mut network_ids = network_ids.to_vec();
    network_ids.sort_unstable();
    network_ids.dedup();
    network_ids
}

/// The feature flag and an enabled callsign worker, whose engines are used.
pub(crate) async fn enabled<C: ConnectionTrait>(
    dbx: &C,
) -> anyhow::Result<bool> {
    Ok(crate::system_settings::ai_network_match_enabled(dbx)
        .await
        .c(h!())?
        && crate::ai_callsign::worker::worker_enabled(dbx)
            .await
            .c(h!())?)
}

/// Queues scoring for freshly recalculated messages that match several
/// networks. Called by `calculate_sigint_inbox_item_networks`, the only
/// writer of message–network links, so every candidate change passes here.
pub async fn enqueue_for_calculated<C: ConnectionTrait>(
    dbx: &C,
    networks_by_item: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<()> {
    let candidates = multi_network_items(networks_by_item);
    if candidates.is_empty() || !enabled(dbx).await.c(h!())? {
        return Ok(());
    }
    let scored = items_with_current_result(dbx, &candidates).await.c(h!())?;
    let item_ids = candidates
        .into_keys()
        .filter(|item_id| !scored.contains(item_id))
        .collect::<Vec<_>>();
    if item_ids.is_empty() {
        return Ok(());
    }
    insert_recent_jobs(dbx, item_ids).await.c(h!())
}

/// Drops the stored scores after an edit, so the following network
/// recalculation queues the message again.
pub async fn forget_result<C: ConnectionTrait>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> anyhow::Result<()> {
    ai_network_match_result::Entity::delete_by_id(sigint_inbox_item_id)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

/// Scores for messages whose stored candidates equal their current networks.
/// Empty when the feature is off, which keeps the old full network list.
pub async fn load_for_messages<C: ConnectionTrait>(
    dbx: &C,
    networks_by_message: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<HashMap<i64, InboxNetworkMatch>> {
    let candidates = multi_network_items(networks_by_message);
    if candidates.is_empty()
        || !crate::system_settings::ai_network_match_enabled(dbx)
            .await
            .c(h!())?
    {
        return Ok(HashMap::new());
    }
    let results = load_results(dbx, &candidates).await.c(h!())?;
    results
        .into_iter()
        .map(|result| {
            let item_id = result.sigint_inbox_item_id;
            Ok((item_id, to_inbox_match(result).c(h!())?))
        })
        .collect()
}

fn multi_network_items(
    networks_by_item: &HashMap<i64, Vec<i64>>,
) -> HashMap<i64, Vec<i64>> {
    networks_by_item
        .iter()
        .map(|(item_id, network_ids)| (*item_id, candidate_set(network_ids)))
        .filter(|(_, network_ids)| network_ids.len() >= 2)
        .collect()
}

async fn items_with_current_result<C: ConnectionTrait>(
    dbx: &C,
    candidates: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<HashSet<i64>> {
    Ok(load_results(dbx, candidates)
        .await
        .c(h!())?
        .into_iter()
        .map(|result| result.sigint_inbox_item_id)
        .collect())
}

/// Stored results whose candidate set is still the current one.
async fn load_results<C: ConnectionTrait>(
    dbx: &C,
    candidates: &HashMap<i64, Vec<i64>>,
) -> anyhow::Result<Vec<ai_network_match_result::Model>> {
    let item_ids = candidates.keys().copied().collect::<Vec<_>>();
    let results = ai_network_match_result::Entity::find()
        .from_raw_sql(sql(
            "select * from ai_network_match_result where sigint_inbox_item_id = any($1)",
            vec![item_ids.into()],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(results
        .into_iter()
        .filter(|result| {
            candidates.get(&result.sigint_inbox_item_id)
                == Some(&result.candidate_network_ids)
        })
        .collect())
}

/// Only recent messages are queued: network edits recalculate old messages
/// in bulk, and historical imports arrive with old intercept times.
async fn insert_recent_jobs<C: ConnectionTrait>(
    dbx: &C,
    item_ids: Vec<i64>,
) -> anyhow::Result<()> {
    let cutoff = (Utc::now()
        - Duration::hours(AI_NETWORK_MATCH_ENQUEUE_MAX_AGE_HOURS))
    .naive_utc();
    dbx.execute_raw(sql(
        "insert into ai_network_match_worker_job (sigint_inbox_item_id) select item.id from sigint_inbox_item item join signal_message message on message.id = item.id where item.id = any($1) and not message.deleted and message.created_at >= $2 and coalesce(item.datetime, message.created_at) >= $2 on conflict (sigint_inbox_item_id) do nothing",
        vec![item_ids.into(), cutoff.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

fn to_inbox_match(
    result: ai_network_match_result::Model,
) -> anyhow::Result<InboxNetworkMatch> {
    let mut candidates: Vec<NetworkMatchCandidate> =
        serde_json::from_value(result.certainties).c(h!())?;
    candidates.sort_by(|a, b| {
        b.certainty
            .cmp(&a.certainty)
            .then(a.network_id.cmp(&b.network_id))
    });
    Ok(InboxNetworkMatch {
        confident_network_id: confident_network_id(&candidates),
        candidates,
    })
}

/// `candidates` are ordered by certainty, highest first.
pub(crate) fn confident_network_id(
    candidates: &[NetworkMatchCandidate],
) -> Option<i64> {
    let best = candidates.first()?;
    let runner_up = candidates.get(1).map_or(0, |c| c.certainty);
    (best.certainty >= AI_NETWORK_MATCH_CONFIDENT_MIN_CERTAINTY
        && best.certainty - runner_up >= AI_NETWORK_MATCH_CONFIDENT_MIN_LEAD)
        .then_some(best.network_id)
}

pub(crate) fn sql(query: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, query, values)
}
