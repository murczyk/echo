use super::settlement_clusters::{
    resolve_cluster, resolve_cluster_with_fixed, SettlementAnchor,
};
use crate::battle_line::types::BattleLineLocationResult;
use crate::battle_line::{
    active_battle_line_id, ensure_active_battle_line,
    load_location_resolution_drafts, location_result_from_draft, lock_updates,
    resolve_inbox_item_aors, LocationResolutionDraft,
    SettlementCandidateSource,
};
use crate::config::{
    get_tz, INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE,
    INBOX_SETTLEMENT_ONEOFF_TRANSACTION_BATCH_SIZE,
    INBOX_SETTLEMENT_WORKER_ADVISORY_LOCK_NAMESPACE,
    INBOX_SETTLEMENT_WORKER_BATCH_SIZE,
    INBOX_SETTLEMENT_WORKER_CLAIM_CANDIDATE_SIZE,
    INBOX_SETTLEMENT_WORKER_SLEEP_SECS,
};
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_settlement, signal_message,
};
use crate::error::AppError;
use crate::iggy::settlement_events::{
    persist_settlement_resolution, SettlementLinkEvents,
};
use crate::location::utils::to_location_list;
use crate::settlement::normalize_name;
use crate::types::{info, warn, Env, Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{
    h, OneoffLinkInboxSettlementsPs, OneoffRecalculateHistoricSettlementsPs,
};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, LockType, OnConflict};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, FromQueryResult)]
pub(super) struct PendingSettlementClaim {
    pub(super) owner_id: i64,
    pub(super) first_row_id: i64,
}

#[derive(Debug, FromQueryResult)]
struct PendingItemLock {
    acquired: bool,
}

struct OneoffItemResolutionRequest {
    item_id: i64,
    item_uuid: Option<uuid::Uuid>,
    location_v2: Option<String>,
    settlement_texts: Vec<String>,
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SettlementResolutionCacheKey {
    active_battle_line_version_id: i64,
    aor_ids: Vec<i64>,
    settlement_text: String,
}

#[derive(Default)]
pub(super) struct SettlementResolutionCache {
    database_resolutions:
        BTreeMap<SettlementResolutionCacheKey, LocationResolutionDraft>,
    catalog_resolutions:
        BTreeMap<SettlementResolutionCacheKey, LocationResolutionDraft>,
}

impl SettlementResolutionCache {
    fn key(
        active_battle_line_version_id: i64,
        aor_ids: &[i64],
        settlement_text: &str,
    ) -> SettlementResolutionCacheKey {
        let mut aor_ids = aor_ids.to_vec();
        aor_ids.sort_unstable();
        aor_ids.dedup();
        SettlementResolutionCacheKey {
            active_battle_line_version_id,
            aor_ids,
            settlement_text: normalize_name(settlement_text),
        }
    }

    fn get(
        &self,
        source: &SettlementCandidateSource,
        active_battle_line_version_id: i64,
        aor_ids: &[i64],
        settlement_text: &str,
    ) -> Option<LocationResolutionDraft> {
        let key =
            Self::key(active_battle_line_version_id, aor_ids, settlement_text);
        let resolutions = match source {
            SettlementCandidateSource::Database => &self.database_resolutions,
            SettlementCandidateSource::Catalog(_) => &self.catalog_resolutions,
        };
        resolutions.get(&key).cloned().map(|mut result| {
            result.location = settlement_text.to_string();
            result
        })
    }

    fn insert(
        &mut self,
        source: &SettlementCandidateSource,
        active_battle_line_version_id: i64,
        aor_ids: &[i64],
        result: LocationResolutionDraft,
    ) {
        let key =
            Self::key(active_battle_line_version_id, aor_ids, &result.location);
        let resolutions = match source {
            SettlementCandidateSource::Database => {
                &mut self.database_resolutions
            }
            SettlementCandidateSource::Catalog(_) => {
                &mut self.catalog_resolutions
            }
        };
        resolutions.insert(key, result);
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct OneoffLinkInboxSettlementsStats {
    pub processed: usize,
    pub skipped: usize,
    pub matched: usize,
    pub unmatched: usize,
}

impl OneoffLinkInboxSettlementsStats {
    fn completed(&self) -> usize {
        self.processed + self.skipped
    }

    fn merge(&mut self, other: Self) {
        self.processed += other.processed;
        self.skipped += other.skipped;
        self.matched += other.matched;
        self.unmatched += other.unmatched;
    }
}

pub async fn reconcile_item_locations<C>(
    dbx: &C,
    item_id: i64,
    item_uuid: Option<uuid::Uuid>,
    location_v2: Option<&str>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + TransactionTrait,
{
    let txn = dbx.begin().await.c(h!())?;
    if reconcile_item_location_rows(&txn, item_id, item_uuid, location_v2, true)
        .await
        .c(h!())?
    {
        crate::stats::enqueue_group_stats_recalculation_for_message(
            &txn,
            item_id,
            format!("reconciled settlements for inbox message {item_id}"),
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn reconcile_item_location_rows<C>(
    dbx: &C,
    item_id: i64,
    item_uuid: Option<uuid::Uuid>,
    location_v2: Option<&str>,
    capture_iggy_events: bool,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait + TransactionSession,
{
    let desired = location_texts(location_v2);
    let existing = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .lock(LockType::Update)
        .all(dbx)
        .await
        .c(h!())?;
    let existing_texts = existing
        .iter()
        .map(|row| row.settlement_text.clone())
        .collect::<BTreeSet<_>>();
    if desired == existing_texts {
        return Ok(false);
    }
    let events = if capture_iggy_events {
        Some(SettlementLinkEvents::capture(dbx, item_id).await.c(h!())?)
    } else {
        None
    };
    let obsolete_ids = existing
        .iter()
        .filter(|row| !desired.contains(&row.settlement_text))
        .map(|row| row.id)
        .collect::<Vec<_>>();
    let clears_linked_settlement =
        existing.iter().any(|row| row.settlement_id.is_some());
    if !obsolete_ids.is_empty() {
        sigint_inbox_item_settlement::Entity::delete_many()
            .filter(
                sigint_inbox_item_settlement::Column::Id.is_in(obsolete_ids),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    if existing.iter().any(|row| {
        desired.contains(&row.settlement_text)
            && (row.settlement_id.is_some() || row.is_undefined.is_some())
    }) {
        reset_item_settlements(dbx, item_id).await.c(h!())?;
    }
    for settlement_text in desired.difference(&existing_texts) {
        sigint_inbox_item_settlement::Entity::insert(
            sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
                item_uuid: Set(item_uuid),
                created_at: NotSet,
                item_id: Set(item_id),
                settlement_text: Set(settlement_text.clone()),
                settlement_id: Set(None),
                is_undefined: Set(None),
            },
        )
        .on_conflict(
            OnConflict::columns([
                sigint_inbox_item_settlement::Column::ItemId,
                sigint_inbox_item_settlement::Column::SettlementText,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(dbx)
        .await
        .c(h!())?;
    }
    if let Some(events) = events {
        events.enqueue_changes(dbx).await.c(h!())?;
    }
    Ok(clears_linked_settlement)
}

pub async fn requeue_item_settlements<C>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + TransactionTrait,
{
    let txn = dbx.begin().await.c(h!())?;
    let events = SettlementLinkEvents::capture(&txn, item_id).await.c(h!())?;
    reset_item_settlements(&txn, item_id).await.c(h!())?;
    events.enqueue_changes(&txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn requeue_unresolved_item_settlements<C: ConnectionTrait>(
    dbx: &C,
    item_ids: &[i64],
) -> anyhow::Result<()> {
    if item_ids.is_empty() {
        return Ok(());
    }
    dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres, r#"
update sigint_inbox_item_settlement set is_undefined = null
where item_id = any($1::bigint[]) and settlement_id is null and is_undefined is true
    "#, [item_ids.to_vec().into()])).await.c(h!())?;
    Ok(())
}

async fn reset_item_settlements<C>(dbx: &C, item_id: i64) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    sigint_inbox_item_settlement::Entity::update_many()
        .col_expr(
            sigint_inbox_item_settlement::Column::SettlementId,
            Expr::value(Option::<i32>::None),
        )
        .col_expr(
            sigint_inbox_item_settlement::Column::IsUndefined,
            Expr::value(Option::<bool>::None),
        )
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(())
}

fn location_texts(location_v2: Option<&str>) -> BTreeSet<String> {
    location_v2
        .map(to_location_list)
        .unwrap_or_default()
        .into_iter()
        .collect()
}

#[derive(Default)]
pub struct SettlementWorkerCursor {
    inbox_item: Option<i64>,
    network: Option<i64>,
}

pub async fn inbox_settlement_worker_nofail(env: Arc<Env>) {
    let mut cursor = SettlementWorkerCursor::default();
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("inbox_settlement_worker");
        match run_inbox_settlement_worker_once(&env, &mut cursor).await {
            Ok(true) => {}
            Ok(false) => {
                tokio::time::sleep(std::time::Duration::from_secs(
                    INBOX_SETTLEMENT_WORKER_SLEEP_SECS,
                ))
                .await;
            }
            Err(error) => {
                warn!("Inbox settlement worker error: {error:#?}");
                tokio::time::sleep(std::time::Duration::from_secs(
                    INBOX_SETTLEMENT_WORKER_SLEEP_SECS,
                ))
                .await;
            }
        }
    }
}

pub async fn run_inbox_settlement_worker_once(
    env: &Env,
    cursor: &mut SettlementWorkerCursor,
) -> anyhow::Result<bool> {
    if active_battle_line_id(&env.dbx).await.c(h!())?.is_none() {
        *cursor = SettlementWorkerCursor::default();
        return Ok(false);
    }
    let network_processed =
        super::network_settlements::process_pending_networks(
            env,
            &mut cursor.network,
        )
        .await
        .c(h!())?;
    if !has_pending_rows(&env.dbx).await.c(h!())? {
        cursor.inbox_item = None;
        return Ok(network_processed);
    }
    let active_battle_line_version_id =
        refresh_battle_line_version(env).await.c(h!())?;
    let mut resolution_cache = SettlementResolutionCache::default();
    let processed = process_pending_rows(
        env,
        &mut cursor.inbox_item,
        active_battle_line_version_id,
        &mut resolution_cache,
    )
    .await
    .c(h!())?;
    Ok(processed || network_processed)
}

async fn refresh_battle_line_version(env: &Env) -> anyhow::Result<i64> {
    let version_txn = env.dbx.begin().await.c(h!())?;
    lock_updates(&version_txn).await.c(h!())?;
    let active_battle_line_version_id =
        ensure_active_battle_line(&version_txn).await.c(h!())?;
    version_txn.commit().await.c(h!())?;
    Ok(active_battle_line_version_id)
}

async fn has_pending_rows<C>(dbx: &C) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    Ok(sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::SettlementId.is_null())
        .filter(sigint_inbox_item_settlement::Column::IsUndefined.is_null())
        .one(dbx)
        .await
        .c(h!())?
        .is_some())
}

async fn process_pending_rows(
    env: &Env,
    cursor: &mut Option<i64>,
    active_battle_line_version_id: i64,
    resolution_cache: &mut SettlementResolutionCache,
) -> anyhow::Result<bool> {
    let mut processed = false;
    for _ in 0..INBOX_SETTLEMENT_WORKER_BATCH_SIZE {
        let txn = env.dbx.begin().await.c(h!())?;
        let claim = claim_pending_item(&txn, *cursor).await.c(h!())?;
        let Some(claim) = claim else {
            txn.rollback().await.c(h!())?;
            *cursor = None;
            break;
        };
        *cursor = Some(claim.first_row_id);
        let affected_item_id = match resolve_claimed_item(
            &txn,
            claim.owner_id,
            active_battle_line_version_id,
            resolution_cache,
        )
        .await
        {
            Ok(affected_item_id) => affected_item_id,
            Err(error) => {
                txn.rollback().await.c(h!())?;
                warn!(
                    "Inbox settlement resolution error for item {}: {error:#?}",
                    claim.owner_id
                );
                continue;
            }
        };
        txn.commit().await.c(h!())?;
        if let Some(item_id) = affected_item_id {
            enqueue_stats_invalidations(
                &env.dbx,
                BTreeSet::from([item_id]),
                "resolved settlement for inbox message",
            )
            .await;
        }
        processed = true;
    }
    Ok(processed)
}

async fn claim_pending_item<C>(
    dbx: &C,
    after_id: Option<i64>,
) -> anyhow::Result<Option<PendingSettlementClaim>>
where
    C: ConnectionTrait,
{
    claim_pending_set(dbx, after_id, SettlementQueue::InboxItem)
        .await
        .c(h!())
}

#[derive(Clone, Copy)]
pub(super) enum SettlementQueue {
    InboxItem,
    Network,
}

pub(super) async fn claim_pending_set<C: ConnectionTrait>(
    dbx: &C,
    after_id: Option<i64>,
    queue: SettlementQueue,
) -> anyhow::Result<Option<PendingSettlementClaim>> {
    let (table, owner_column) = match queue {
        SettlementQueue::InboxItem => {
            ("sigint_inbox_item_settlement", "item_id")
        }
        SettlementQueue::Network => ("sigint_network_settlement", "network_id"),
    };
    let candidates = PendingSettlementClaim::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            format!(
                r#"
with pending_rows as materialized (
    select id, {owner_column} as item_id
    from {table}
    where settlement_id is null
      and is_undefined is null
      and ($1::bigint is null or id > $1)
    order by id
    limit $2
)
select item_id as owner_id, min(id) as first_row_id
from pending_rows
group by item_id
order by first_row_id
            "#
            ),
            [
                after_id.into(),
                (INBOX_SETTLEMENT_WORKER_CLAIM_CANDIDATE_SIZE as i64).into(),
            ],
        ),
    )
    .all(dbx)
    .await
    .c(h!())?;
    for candidate in candidates {
        if try_lock_pending_set(dbx, candidate.owner_id, queue)
            .await
            .c(h!())?
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

#[cfg(test)]
async fn try_lock_pending_item<C>(dbx: &C, item_id: i64) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    try_lock_pending_set(dbx, item_id, SettlementQueue::InboxItem)
        .await
        .c(h!())
}

async fn try_lock_pending_set<C: ConnectionTrait>(
    dbx: &C,
    item_id: i64,
    queue: SettlementQueue,
) -> anyhow::Result<bool> {
    let namespace = match queue {
        SettlementQueue::InboxItem => {
            INBOX_SETTLEMENT_WORKER_ADVISORY_LOCK_NAMESPACE
        }
        SettlementQueue::Network => {
            crate::config::NETWORK_SETTLEMENT_WORKER_ADVISORY_LOCK_NAMESPACE
        }
    };
    PendingItemLock::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
select pg_try_advisory_xact_lock(
    hashtextextended($1::text || $2::text, 0)
) as acquired
        "#,
        [namespace.into(), item_id.into()],
    ))
    .one(dbx)
    .await
    .c(h!())?
    .map(|row| row.acquired)
    .c(h!())
}

async fn resolve_claimed_item(
    txn: &DatabaseTransaction,
    item_id: i64,
    active_battle_line_version_id: i64,
    resolution_cache: &mut SettlementResolutionCache,
) -> anyhow::Result<Option<i64>> {
    let rows = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .lock(LockType::Update)
        .all(txn)
        .await
        .c(h!())?;
    if !rows
        .iter()
        .any(|row| row.settlement_id.is_none() && row.is_undefined.is_none())
    {
        return Ok(None);
    }
    let anchors =
        super::network_settlements::load_item_network_anchors(txn, item_id)
            .await
            .c(h!())?;
    let rows = rows
        .into_iter()
        .filter(|row| anchors.is_empty() || row.settlement_id.is_none())
        .collect::<Vec<_>>();
    let aor_context =
        resolve_inbox_item_aors(txn, item_id, None).await.c(h!())?;
    let locations = rows
        .iter()
        .map(|row| row.settlement_text.clone())
        .collect::<Vec<_>>();
    let mut drafts = load_location_drafts_with_cache(
        txn,
        SettlementCandidateSource::Database,
        locations,
        &aor_context.aor_ids,
        active_battle_line_version_id,
        resolution_cache,
    )
    .await
    .c(h!())?;
    resolve_inbox_cluster(&mut drafts, &rows, &anchors);
    let results = drafts.into_iter().map(location_result_from_draft);
    let mut affected_item_id = None;
    for (row, result) in rows.into_iter().zip(results) {
        if row.settlement_id.is_some() {
            continue;
        }
        affected_item_id = Some(
            persist_settlement_resolution(
                txn,
                row,
                result.chosen_settlement_id,
            )
            .await
            .c(h!())?,
        );
    }
    Ok(affected_item_id)
}

fn resolve_inbox_cluster(
    drafts: &mut [LocationResolutionDraft],
    rows: &[sigint_inbox_item_settlement::Model],
    anchors: &[SettlementAnchor],
) {
    if !anchors.is_empty() {
        resolve_cluster(drafts, anchors);
        return;
    }
    let fixed = rows
        .iter()
        .filter_map(|row| {
            row.settlement_id.map(|settlement_id| {
                (normalize_name(&row.settlement_text), settlement_id)
            })
        })
        .collect();
    resolve_cluster_with_fixed(drafts, &fixed);
}

pub(super) async fn resolve_settlement_names<C: ConnectionTrait>(
    dbx: &C,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    locations: Vec<String>,
    aor_ids: &[i64],
    version: i64,
    cache: &mut SettlementResolutionCache,
    anchors: &[SettlementAnchor],
) -> anyhow::Result<Vec<BattleLineLocationResult>> {
    let mut drafts = load_location_drafts_with_cache(
        dbx,
        SettlementCandidateSource::Catalog(settlements),
        locations,
        aor_ids,
        version,
        cache,
    )
    .await
    .c(h!())?;
    resolve_cluster(&mut drafts, anchors);
    Ok(drafts.into_iter().map(location_result_from_draft).collect())
}

async fn load_location_drafts_with_cache<C>(
    dbx: &C,
    source: SettlementCandidateSource,
    locations: Vec<String>,
    aor_ids: &[i64],
    active_battle_line_version_id: i64,
    resolution_cache: &mut SettlementResolutionCache,
) -> anyhow::Result<Vec<LocationResolutionDraft>>
where
    C: ConnectionTrait,
{
    let mut missing_locations = BTreeMap::new();
    for location in &locations {
        if resolution_cache
            .get(&source, active_battle_line_version_id, aor_ids, location)
            .is_none()
        {
            missing_locations
                .entry(SettlementResolutionCache::key(
                    active_battle_line_version_id,
                    aor_ids,
                    location,
                ))
                .or_insert_with(|| location.clone());
        }
    }
    let missing_locations = missing_locations.into_values().collect();
    let missing_results = load_location_resolution_drafts(
        dbx,
        source.clone(),
        missing_locations,
        aor_ids,
    )
    .await
    .c(h!())?;
    for result in missing_results {
        resolution_cache.insert(
            &source,
            active_battle_line_version_id,
            aor_ids,
            result,
        );
    }
    locations
        .into_iter()
        .map(|location| {
            resolution_cache
                .get(&source, active_battle_line_version_id, aor_ids, &location)
                .c(h!())
        })
        .collect()
}

pub async fn oneoff_link_inbox_settlements(
    mode: Mode,
    ps: &OneoffLinkInboxSettlementsPs,
) -> Result<(), AppError> {
    info!("Starting inbox settlement linking one-off");
    let (since_ts, till_ts) = oneoff_bounds(ps).c(h!())?;
    let env = crate::server::new_env(mode).await.c(h!())?;
    let total = count_oneoff_items(&env.dbx, since_ts, till_ts)
        .await
        .c(h!())?;
    println!("Inbox settlement linking: total items={total}");
    let mut stats = OneoffLinkInboxSettlementsStats::default();
    let mut cursor = None;
    loop {
        let items = load_oneoff_item_page(
            &env.dbx,
            since_ts,
            till_ts,
            cursor,
            INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE,
        )
        .await
        .c(h!())?;
        if items.is_empty() {
            break;
        }
        for items in
            items.chunks(INBOX_SETTLEMENT_ONEOFF_TRANSACTION_BATCH_SIZE)
        {
            let batch_stats =
                process_oneoff_batch(&env, items).await.c(h!())?;
            stats.merge(batch_stats);
            print_oneoff_progress(&stats, total);
        }
        cursor = items.last().copied();
        if items.len() < INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE as usize {
            break;
        }
    }
    info!(
        "Inbox settlement linking done: processed={}, skipped={}, matched={}, unmatched={}",
        stats.processed, stats.skipped, stats.matched, stats.unmatched
    );
    Ok(())
}

async fn process_oneoff_batch(
    env: &Env,
    items: &[(NaiveDateTime, i64)],
) -> anyhow::Result<OneoffLinkInboxSettlementsStats> {
    let active_battle_line_version_id =
        refresh_battle_line_version(env).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let item_locations =
        lock_oneoff_item_locations(&txn, items).await.c(h!())?;
    let (request_groups, skipped) =
        group_oneoff_resolution_requests(&txn, items, &item_locations)
            .await
            .c(h!())?;
    let mut stats = OneoffLinkInboxSettlementsStats {
        skipped,
        ..Default::default()
    };
    let mut resolution_cache = SettlementResolutionCache::default();
    let affected_item_ids = process_oneoff_request_groups(
        &txn,
        request_groups,
        active_battle_line_version_id,
        &mut resolution_cache,
        &mut stats,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    enqueue_stats_invalidations(
        &env.dbx,
        affected_item_ids,
        "linked settlements for inbox message",
    )
    .await;
    Ok(stats)
}

async fn group_oneoff_resolution_requests(
    txn: &DatabaseTransaction,
    items: &[(NaiveDateTime, i64)],
    item_locations: &BTreeMap<i64, (Option<String>, Option<uuid::Uuid>)>,
) -> anyhow::Result<(BTreeMap<Vec<i64>, Vec<OneoffItemResolutionRequest>>, usize)>
{
    let mut request_groups = BTreeMap::new();
    let mut skipped = 0;
    for (_, item_id) in items {
        let (location_v2, item_uuid) =
            item_locations.get(item_id).c(h!())?.clone();
        let settlement_texts = location_texts(location_v2.as_deref())
            .into_iter()
            .collect::<Vec<_>>();
        if settlement_texts.is_empty() {
            skipped += 1;
            continue;
        }
        let aor_context =
            resolve_inbox_item_aors(txn, *item_id, None).await.c(h!())?;
        request_groups
            .entry(aor_context.aor_ids)
            .or_insert_with(Vec::new)
            .push(OneoffItemResolutionRequest {
                item_id: *item_id,
                item_uuid,
                location_v2,
                settlement_texts,
            });
    }
    Ok((request_groups, skipped))
}

async fn process_oneoff_request_groups(
    txn: &DatabaseTransaction,
    request_groups: BTreeMap<Vec<i64>, Vec<OneoffItemResolutionRequest>>,
    active_battle_line_version_id: i64,
    resolution_cache: &mut SettlementResolutionCache,
    stats: &mut OneoffLinkInboxSettlementsStats,
) -> anyhow::Result<BTreeSet<i64>> {
    let mut affected_item_ids = BTreeSet::new();
    for (aor_ids, requests) in request_groups {
        let group_lengths = requests
            .iter()
            .map(|request| request.settlement_texts.len())
            .collect::<Vec<_>>();
        let locations = requests
            .iter()
            .flat_map(|request| request.settlement_texts.clone())
            .collect::<Vec<_>>();
        let drafts = load_location_drafts_with_cache(
            txn,
            SettlementCandidateSource::Database,
            locations,
            &aor_ids,
            active_battle_line_version_id,
            resolution_cache,
        )
        .await
        .c(h!())?;
        let mut drafts = drafts.into_iter();
        for (request, group_length) in requests.into_iter().zip(group_lengths) {
            let mut request_drafts =
                drafts.by_ref().take(group_length).collect::<Vec<_>>();
            let anchors =
                super::network_settlements::load_item_network_anchors(
                    txn,
                    request.item_id,
                )
                .await
                .c(h!())?;
            resolve_cluster(&mut request_drafts, &anchors);
            let request_resolutions = request_drafts
                .into_iter()
                .map(location_result_from_draft)
                .collect();
            let affected_item_id = process_oneoff_item_in_transaction(
                txn,
                request,
                request_resolutions,
                stats,
            )
            .await
            .c(h!())?;
            affected_item_ids.insert(affected_item_id);
        }
    }
    Ok(affected_item_ids)
}

async fn lock_oneoff_item_locations(
    txn: &DatabaseTransaction,
    items: &[(NaiveDateTime, i64)],
) -> anyhow::Result<BTreeMap<i64, (Option<String>, Option<uuid::Uuid>)>> {
    sigint_inbox_item::Entity::find()
        .filter(
            sigint_inbox_item::Column::Id
                .is_in(items.iter().map(|(_, item_id)| *item_id)),
        )
        .lock(LockType::Update)
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::IdUuid,
            sigint_inbox_item::Column::LocationV2,
        ])
        .into_tuple::<(i64, Option<uuid::Uuid>, Option<String>)>()
        .all(txn)
        .await
        .c(h!())
        .map(|rows| {
            rows.into_iter()
                .map(|(id, item_uuid, location_v2)| {
                    (id, (location_v2, item_uuid))
                })
                .collect()
        })
}

fn print_oneoff_progress(stats: &OneoffLinkInboxSettlementsStats, total: u64) {
    let completed = stats.completed() as u64;
    println!(
        "Inbox settlement linking: processed items={completed}/{total}, remaining items={}, matched locations={}, unmatched locations={}",
        total.saturating_sub(completed),
        stats.matched,
        stats.unmatched,
    );
}

async fn process_oneoff_item_in_transaction(
    txn: &DatabaseTransaction,
    request: OneoffItemResolutionRequest,
    resolutions: Vec<BattleLineLocationResult>,
    stats: &mut OneoffLinkInboxSettlementsStats,
) -> anyhow::Result<i64> {
    let events = SettlementLinkEvents::capture(txn, request.item_id)
        .await
        .c(h!())?;
    reconcile_item_location_rows(
        txn,
        request.item_id,
        request.item_uuid,
        request.location_v2.as_deref(),
        false,
    )
    .await
    .c(h!())?;
    reset_item_settlements(txn, request.item_id).await.c(h!())?;
    for result in resolutions {
        let settlement_id = result.chosen_settlement_id;
        let matched = settlement_id.is_some();
        sigint_inbox_item_settlement::Entity::update_many()
            .col_expr(
                sigint_inbox_item_settlement::Column::SettlementId,
                Expr::value(settlement_id),
            )
            .col_expr(
                sigint_inbox_item_settlement::Column::IsUndefined,
                Expr::value(Some(!matched)),
            )
            .filter(
                sigint_inbox_item_settlement::Column::ItemId
                    .eq(request.item_id),
            )
            .filter(
                sigint_inbox_item_settlement::Column::SettlementText
                    .eq(result.location),
            )
            .exec(txn)
            .await
            .c(h!())?;
        if matched {
            stats.matched += 1;
        } else {
            stats.unmatched += 1;
        }
    }
    events.enqueue_changes(txn).await.c(h!())?;
    stats.processed += 1;
    Ok(request.item_id)
}

async fn enqueue_stats_invalidations(
    dbx: &DatabaseConnection,
    item_ids: BTreeSet<i64>,
    reason: &str,
) {
    let item_ids = item_ids.into_iter().collect::<Vec<_>>();
    if let Err(error) =
        crate::stats::enqueue_group_stats_recalculation_for_messages(
            dbx, &item_ids, reason,
        )
        .await
    {
        warn!(
            "Post-commit group stats invalidation failed for {} inbox messages: {error:#?}",
            item_ids.len()
        );
    }
}

async fn load_oneoff_item_page<C>(
    dbx: &C,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    cursor: Option<(NaiveDateTime, i64)>,
    limit: u64,
) -> anyhow::Result<Vec<(NaiveDateTime, i64)>>
where
    C: ConnectionTrait,
{
    let mut query = oneoff_items_query(since_ts, till_ts)
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id);
    if let Some((datetime, item_id)) = cursor {
        query = query.filter(
            Condition::any()
                .add(sigint_inbox_item::Column::Datetime.gt(datetime))
                .add(
                    Condition::all()
                        .add(sigint_inbox_item::Column::Datetime.eq(datetime))
                        .add(sigint_inbox_item::Column::Id.gt(item_id)),
                ),
        );
    }
    query
        .select_only()
        .columns([
            sigint_inbox_item::Column::Datetime,
            sigint_inbox_item::Column::Id,
        ])
        .limit(limit)
        .into_tuple::<(NaiveDateTime, i64)>()
        .all(dbx)
        .await
        .c(h!())
}

async fn count_oneoff_items(
    dbx: &DatabaseConnection,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> anyhow::Result<u64> {
    oneoff_items_query(since_ts, till_ts)
        .count(dbx)
        .await
        .c(h!())
}

fn oneoff_items_query(
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
) -> Select<sigint_inbox_item::Entity> {
    let mut query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.is_not_null());
    if let Some(since_ts) = since_ts {
        query = query.filter(sigint_inbox_item::Column::Datetime.gte(since_ts));
    }
    if let Some(till_ts) = till_ts {
        query = query.filter(sigint_inbox_item::Column::Datetime.lt(till_ts));
    }
    query
}

pub async fn oneoff_recalculate_historic_settlements(
    mode: Mode,
    ps: &OneoffRecalculateHistoricSettlementsPs,
) -> Result<(), AppError> {
    info!("Starting historic settlement recalculation");
    let env = crate::server::new_env(mode).await.c(h!())?;
    let mut after_id = ps.after_id;
    let mut scanned_total = 0u64;
    let mut written_total = 0usize;
    let mut skipped_total = 0usize;
    loop {
        let remaining = ps
            .limit
            .map(|limit| limit.saturating_sub(scanned_total));
        if remaining == Some(0) {
            break;
        }
        let page_size = std::cmp::min(
            remaining.unwrap_or(INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE),
            INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE,
        );
        let txn = env.dbx.begin().await.c(h!())?;
        let page = recalculate_historic_settlement_page(
            &txn, after_id, page_size, None,
        )
        .await
        .c(h!())?;
        txn.commit().await.c(h!())?;
        let Some(last_id) = page.last_id else {
            break;
        };
        after_id = last_id;
        scanned_total += page.scanned as u64;
        written_total += page.written;
        skipped_total += page.skipped;
        println!(
            "Historic settlements: scanned={scanned_total}, written={written_total}, skipped={skipped_total}, after-id={after_id}"
        );
        if (page.scanned as u64) < page_size {
            break;
        }
    }
    info!(
        "Historic settlement recalculation done: scanned={scanned_total}, written={written_total}, skipped={skipped_total}, after-id={after_id}"
    );
    Ok(())
}

struct HistoricSettlementRecalcPage {
    last_id: Option<i64>,
    scanned: usize,
    written: usize,
    skipped: usize,
}

async fn recalculate_historic_settlement_page<C>(
    db: &C,
    after_id: i64,
    limit: u64,
    only_item_ids: Option<&[i64]>,
) -> anyhow::Result<HistoricSettlementRecalcPage>
where
    C: ConnectionTrait,
{
    let items =
        missing_settlement_items(db, after_id, limit, only_item_ids)
            .await
            .c(h!())?;
    let last_id = items.last().map(|(item_id, _, _)| *item_id);
    let mut written = 0;
    let mut skipped = 0;
    for (item_id, item_uuid, location_v2) in &items {
        if location_texts(location_v2.as_deref()).is_empty() {
            skipped += 1;
            continue;
        }
        reconcile_item_location_rows(
            db,
            *item_id,
            *item_uuid,
            location_v2.as_deref(),
        )
        .await
        .c(h!())?;
        written += 1;
    }
    Ok(HistoricSettlementRecalcPage {
        last_id,
        scanned: items.len(),
        written,
        skipped,
    })
}

async fn missing_settlement_items<C>(
    db: &C,
    after_id: i64,
    limit: u64,
    only_item_ids: Option<&[i64]>,
) -> anyhow::Result<Vec<(i64, Option<uuid::Uuid>, Option<String>)>>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::LocationV2.is_not_null())
        .filter(sigint_inbox_item::Column::LocationV2.ne(""))
        .filter(sigint_inbox_item::Column::Id.gt(after_id))
        .filter(Expr::exists(settlement_row_exists_query()).not())
        .lock(LockType::Update)
        .order_by_asc(sigint_inbox_item::Column::Id)
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::IdUuid,
            sigint_inbox_item::Column::LocationV2,
        ]);
    if let Some(item_ids) = only_item_ids {
        query = query
            .filter(sigint_inbox_item::Column::Id.is_in(item_ids.to_vec()));
    }
    query
        .limit(limit)
        .into_tuple::<(i64, Option<uuid::Uuid>, Option<String>)>()
        .all(db)
        .await
        .c(h!())
}

fn settlement_row_exists_query() -> sea_orm::sea_query::SelectStatement {
    sea_orm::sea_query::Query::select()
        .expr(Expr::value(1))
        .from(sigint_inbox_item_settlement::Entity)
        .and_where(
            Expr::col((
                sigint_inbox_item_settlement::Entity,
                sigint_inbox_item_settlement::Column::ItemId,
            ))
            .equals((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            )),
        )
        .to_owned()
}

fn oneoff_bounds(
    ps: &OneoffLinkInboxSettlementsPs,
) -> Result<(Option<NaiveDateTime>, Option<NaiveDateTime>), AppError> {
    let today = Utc::now().with_timezone(&get_tz()).date_naive();
    oneoff_bounds_at(ps, today)
}

fn oneoff_bounds_at(
    ps: &OneoffLinkInboxSettlementsPs,
    today: chrono::NaiveDate,
) -> Result<(Option<NaiveDateTime>, Option<NaiveDateTime>), AppError> {
    let mut since_ts = ps
        .since_ts
        .as_deref()
        .map(parse_local_datetime)
        .transpose()
        .c(h!())?;
    let mut till_ts = ps
        .till_ts
        .as_deref()
        .map(parse_local_datetime)
        .transpose()
        .c(h!())?;
    if since_ts.is_none() && till_ts.is_none() {
        since_ts = Some(crate::stats::start_of_day(today).c(h!())?);
        till_ts = Some(
            crate::stats::start_of_day(today + Duration::days(1)).c(h!())?,
        );
    }
    if matches!((since_ts, till_ts), (Some(since), Some(till)) if since >= till)
    {
        return Err(AppError::BL {
            msg: "since_ts must be earlier than till_ts".to_string(),
        });
    }
    Ok((since_ts, till_ts))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_cluster_test_item(
        txn: &DatabaseTransaction,
        names: &[(&str, Option<i32>, Option<bool>)],
    ) -> anyhow::Result<OneoffItemResolutionRequest> {
        let message = crate::functest::tests::mk_signal_message(
            txn,
            signal_message::ActiveModel {
                body: Set(Some("#2133 settlement cluster".to_string())),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
        let settlement_texts = names
            .iter()
            .map(|&(name, _, _)| name.to_string())
            .collect::<Vec<_>>();
        let location_v2 = Some(format!("|{}|", settlement_texts.join("|")));
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            location_v2: Set(location_v2.clone()),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        for &(name, settlement_id, is_undefined) in names {
            sigint_inbox_item_settlement::ActiveModel {
                item_uuid: Set(item.id_uuid),
                item_id: Set(item.id),
                settlement_text: Set(name.to_string()),
                settlement_id: Set(settlement_id),
                is_undefined: Set(is_undefined),
                ..Default::default()
            }
            .insert(txn)
            .await
            .c(h!())?;
        }
        Ok(OneoffItemResolutionRequest {
            item_id: item.id,
            item_uuid: item.id_uuid,
            location_v2,
            settlement_texts,
        })
    }

    async fn setup_cluster_test_catalog(
        env: &Env,
        txn: &DatabaseTransaction,
    ) -> i64 {
        use crate::entities::settlement;
        use crate::location::types::SettlementDetails;

        let version = insert_active_test_battle_line(txn).await.unwrap();
        txn.execute_unprepared(
            "update battle_line_version set geometry = ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(0 0,10 0))', 4326) where retired_at is null",
        ).await.unwrap();
        let mut by_name: BTreeMap<String, Vec<SettlementDetails>> =
            BTreeMap::new();
        let mut by_id = BTreeMap::new();
        for (id, name, lat, lon) in [
            (2_133_101, "#2133 A", 0.1, 1.0),
            (2_133_102, "#2133 B", 0.1, 9.0),
            (2_133_103, "#2133 SHARED", 0.02, 1.01),
            (2_133_104, "#2133 SHARED", 0.01, 9.01),
        ] {
            insert_relink_test_settlement(txn, id, name).await.unwrap();
            let mut settlement = settlement::Entity::find_by_id(id)
                .one(txn)
                .await
                .unwrap()
                .unwrap()
                .into_active_model();
            settlement.lat = Set(Some(lat));
            settlement.lon = Set(Some(lon));
            settlement.update(txn).await.unwrap();
            let details = SettlementDetails {
                id: Some(id),
                name: name.to_string(),
                coords: Some((lat, lon)),
                ..Default::default()
            };
            by_id.insert(id, details.clone());
            by_name.entry(name.to_string()).or_default().push(details);
        }
        env.settlements.write().unwrap().default_settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            by_id,
            by_name,
        ));
        version
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn migration_enqueues_all_non_deleted_network_location_names_2133() {
        use crate::entities::sigint_network;
        use sea_orm_migration::MigratorTrait;
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let now = Utc::now().naive_utc();
        let mut networks = Vec::new();
        for (deleted, active_from, active_to, location) in [
            (false, None, None, "|#2133 A|#2133 B|#2133 a|"),
            (false, Some(now - Duration::days(1)), None, "|#2133 C|"),
            (false, None, Some(now), "|#2133 ARCHIVED|"),
            (true, None, None, "|#2133 DELETED|"),
            (false, Some(now + Duration::days(1)), None, "|#2133 FUTURE|"),
            (false, None, None, ""),
        ] {
            networks.push(
                crate::functest::tests::mk_sigint_network(
                    &txn,
                    sigint_network::ActiveModel {
                        deleted: Set(deleted),
                        active_from: Set(active_from),
                        active_to: Set(active_to),
                        location: Set(location.to_string()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            );
        }
        let migration = echo_migration::Migrator::migrations()
            .into_iter()
            .find(|migration| {
                migration.name() == "m20261022_080838_sigint_network_settlement"
            })
            .unwrap();
        let manager = echo_migration::SchemaManager::new(&txn);
        migration.down(&manager).await.unwrap();
        migration.up(&manager).await.unwrap();
        for (index, expected) in [2, 1, 1, 0, 1, 0].into_iter().enumerate() {
            let rows = network_settlement_rows(&txn, networks[index].id).await;
            assert_eq!(rows.len(), expected);
            assert!(rows
                .iter()
                .all(|row| row.settlement_id.is_none()
                    && row.is_undefined.is_none()));
        }
        for index in [2, 4] {
            let mut network = networks[index].clone().into_active_model();
            network.active_from = Set(None);
            network.active_to = Set(None);
            let network = network.update(&txn).await.unwrap();
            let rows = network_settlement_rows(&txn, network.id).await;
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].settlement_id, None);
            assert_eq!(rows[0].is_undefined, None);
        }
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn shared_worker_resolves_network_anchors_before_inbox_names_2133() {
        use crate::entities::{
            sigint_inbox_item_network, sigint_network,
            sigint_network_settlement,
        };
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        setup_cluster_test_catalog(&env, &setup).await;
        let network = crate::functest::tests::mk_sigint_network(
            &setup,
            sigint_network::ActiveModel {
                location: Set("|#2133 A|".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let item =
            insert_cluster_test_item(&setup, &[("#2133 SHARED", None, None)])
                .await
                .unwrap();
        sigint_inbox_item_network::ActiveModel {
            sigint_inbox_item_id: Set(item.item_id),
            sigint_network_id: Set(network.id),
            ..Default::default()
        }
        .insert(&setup)
        .await
        .unwrap();
        setup.commit().await.unwrap();
        let mut cursor = SettlementWorkerCursor::default();
        assert!(run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
        let network_link = sigint_network_settlement::Entity::find()
            .filter(sigint_network_settlement::Column::NetworkId.eq(network.id))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(network_link.settlement_id, Some(2_133_101));
        let item_link = sigint_inbox_item_settlement::Entity::find()
            .filter(
                sigint_inbox_item_settlement::Column::ItemId.eq(item.item_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(item_link.settlement_id, Some(2_133_103));
        assert!(!run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
        sigint_network::Entity::delete_by_id(network.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        sigint_inbox_item::Entity::delete_by_id(item.item_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        signal_message::Entity::delete_by_id(item.item_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        crate::entities::settlement::Entity::delete_many()
            .filter(
                crate::entities::settlement::Column::Id
                    .is_in([2_133_101, 2_133_102, 2_133_103, 2_133_104]),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_claims_skip_locked_sets_and_use_a_separate_namespace_2133()
    {
        use crate::entities::sigint_network;
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let mut networks = Vec::new();
        for name in ["#2133 CLAIM A", "#2133 CLAIM B"] {
            networks.push(
                crate::functest::tests::mk_sigint_network(
                    &env.dbx,
                    sigint_network::ActiveModel {
                        location: Set(format!("|{name}|")),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            );
        }
        let first_worker = env.dbx.begin().await.unwrap();
        let first =
            claim_pending_set(&first_worker, None, SettlementQueue::Network)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(first.owner_id, networks[0].id);
        let second_worker = env.dbx.begin().await.unwrap();
        assert!(try_lock_pending_set(
            &second_worker,
            first.owner_id,
            SettlementQueue::InboxItem
        )
        .await
        .unwrap());
        let second =
            claim_pending_set(&second_worker, None, SettlementQueue::Network)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(second.owner_id, networks[1].id);
        second_worker.rollback().await.unwrap();
        first_worker.rollback().await.unwrap();
    }

    async fn network_settlement_rows(
        txn: &DatabaseTransaction,
        network_id: i64,
    ) -> Vec<crate::entities::sigint_network_settlement::Model> {
        use crate::entities::sigint_network_settlement;
        sigint_network_settlement::Entity::find()
            .filter(sigint_network_settlement::Column::NetworkId.eq(network_id))
            .order_by_asc(sigint_network_settlement::Column::SettlementText)
            .all(txn)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_aor_changes_requeue_only_affected_settlement_sets_2133() {
        use crate::entities::sigint_network;
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        setup_cluster_test_catalog(&env, &txn).await;
        let mut network_ids = Vec::new();
        let mut aor_ids = Vec::new();
        for name in ["#2133 A", "#2133 B"] {
            let network = crate::functest::tests::mk_sigint_network(
                &txn,
                sigint_network::ActiveModel {
                    location: Set(format!(
                        "|{name}|#2133 SHARED|#2133 FOREST|"
                    )),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            network_ids.push(network.id);
            let aor = crate::functest::tests::mk_aor(&txn, Default::default())
                .await
                .unwrap();
            aor_ids.push(aor.id);
        }
        for (sql, values, pending_networks) in [
            (
                r"insert into sigint_network_aor (network_id, aor_id) values ($1, $2)",
                vec![network_ids[0], aor_ids[0]],
                vec![0],
            ),
            (
                r"update sigint_network_aor set aor_id = aor_id where network_id = $1",
                vec![network_ids[0]],
                vec![],
            ),
            (
                r"update sigint_network_aor set aor_id = $2 where network_id = $1",
                vec![network_ids[0], aor_ids[1]],
                vec![0],
            ),
            (
                r"update sigint_network_aor set network_id = $2 where network_id = $1",
                vec![network_ids[0], network_ids[1]],
                vec![0, 1],
            ),
            (
                r"update area_of_responsibility set deleted = true where id = $1",
                vec![aor_ids[1]],
                vec![1],
            ),
            (
                r"update area_of_responsibility set deleted = true where id = $1",
                vec![aor_ids[1]],
                vec![],
            ),
            (
                r"update area_of_responsibility set deleted = false where id = $1",
                vec![aor_ids[1]],
                vec![1],
            ),
            (
                r#"insert into aor_location_config (aor_id, settlements_configs) values ($1, '["first"]')"#,
                vec![aor_ids[1]],
                vec![1],
            ),
            (
                r"update aor_location_config set settlements_configs = settlements_configs where aor_id = $1",
                vec![aor_ids[1]],
                vec![],
            ),
            (
                r"update aor_location_config set updated_at = now() where aor_id = $1",
                vec![aor_ids[1]],
                vec![],
            ),
            (
                r#"update aor_location_config set settlements_configs = '["second"]' where aor_id = $1"#,
                vec![aor_ids[1]],
                vec![1],
            ),
            (
                r"update aor_location_config set aor_id = $2 where aor_id = $1",
                vec![aor_ids[1], aor_ids[0]],
                vec![1],
            ),
            (
                r"update aor_location_config set aor_id = $2 where aor_id = $1",
                vec![aor_ids[0], aor_ids[1]],
                vec![1],
            ),
            (
                r"insert into sigint_network_aor (network_id, aor_id) values ($1, $2)",
                vec![network_ids[0], aor_ids[1]],
                vec![0],
            ),
            (
                r"update aor_location_config set settlements_configs = '[]' where aor_id = $1",
                vec![aor_ids[1]],
                vec![0, 1],
            ),
            (
                r"delete from aor_location_config where aor_id = $1",
                vec![aor_ids[1]],
                vec![0, 1],
            ),
            (
                r"delete from sigint_network_aor where network_id = $1",
                vec![network_ids[0]],
                vec![0],
            ),
            (
                r"delete from sigint_network_aor where network_id = $1",
                vec![network_ids[1]],
                vec![1],
            ),
            (
                r"insert into sigint_network_aor (network_id, aor_id) values ($1, $2)",
                vec![network_ids[0], aor_ids[1]],
                vec![0],
            ),
            (
                r"delete from area_of_responsibility where id = $1",
                vec![aor_ids[1]],
                vec![0],
            ),
            (
                r"delete from area_of_responsibility where id = $1",
                vec![aor_ids[0]],
                vec![],
            ),
        ] {
            txn.execute_unprepared(
                r#"
update sigint_network_settlement
set settlement_id = case settlement_text
        when '#2133 A' then 2133101
        when '#2133 B' then 2133102
        when '#2133 SHARED' then 2133103
        else null end,
    is_undefined = settlement_text = '#2133 FOREST';
            "#,
            )
            .await
            .unwrap();
            let before = [
                network_settlement_rows(&txn, network_ids[0]).await,
                network_settlement_rows(&txn, network_ids[1]).await,
            ];
            txn.execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                values
                    .into_iter()
                    .map(sea_orm::Value::from)
                    .collect::<Vec<_>>(),
            ))
            .await
            .unwrap();
            for (index, network_id) in network_ids.iter().enumerate() {
                let rows = network_settlement_rows(&txn, *network_id).await;
                if pending_networks.contains(&index) {
                    assert_eq!(rows.len(), 3, "{sql}");
                    assert!(
                        rows.iter().all(|row| row.settlement_id.is_none()
                            && row.is_undefined.is_none()),
                        "{sql}"
                    );
                } else {
                    assert_eq!(rows, before[index], "{sql}");
                }
            }
        }
        txn.rollback().await.unwrap();
    }

    async fn insert_network_catalog_test_config(
        env: &Env,
        txn: &DatabaseTransaction,
        version: i64,
    ) -> crate::entities::aor_location_config::Model {
        use crate::entities::aor_location_config;
        let aor = crate::functest::tests::mk_aor(txn, Default::default())
            .await
            .unwrap();
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into battle_line_aor_geometry
    (version_id, aor_id, geometry, snapped_start, snapped_end)
select id, $1, geometry, ST_SetSRID(ST_MakePoint(0, 0), 4326),
    ST_SetSRID(ST_MakePoint(10, 0), 4326)
from battle_line_version where id = $2
            "#,
            [aor.id.into(), version.into()],
        ))
        .await
        .unwrap();
        {
            let mut settlements = env.settlements.write().unwrap();
            for (name, id) in [("first", 2_133_103), ("second", 2_133_104)] {
                let details =
                    settlements.default_settlements_data.3[&id].clone();
                let data = Arc::new((
                    vec![],
                    vec![],
                    crate::location::trie::Trie::new(),
                    BTreeMap::from([(id, details.clone())]),
                    BTreeMap::from([(details.name.clone(), vec![details])]),
                ));
                settlements.available_settlements_configs.push(name.into());
                settlements
                    .settlements_data_by_config
                    .insert(name.into(), data);
            }
        }
        aor_location_config::ActiveModel {
            aor_id: Set(aor.id),
            settlements_configs: Set(serde_json::json!(["first"])),
            ..Default::default()
        }
        .insert(txn)
        .await
        .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_resolution_reloads_catalog_between_claims_2133() {
        use crate::battle_line::network_settlements::resolve_claimed_network;
        use crate::entities::{
            area_of_responsibility, settlement, sigint_network,
            sigint_network_aor,
        };
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &setup).await;
        let config =
            insert_network_catalog_test_config(&env, &setup, version).await;
        let mut networks = Vec::new();
        for _ in 0..2 {
            let network = crate::functest::tests::mk_sigint_network(
                &setup,
                crate::entities::sigint_network::ActiveModel {
                    location: Set("|#2133 SHARED|".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            sigint_network_aor::ActiveModel {
                network_id: Set(network.id),
                aor_id: Set(config.aor_id),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            networks.push(network);
        }
        setup.commit().await.unwrap();
        crate::location::aor_config::refresh_settlements_aor_map(
            &env.dbx,
            env.settlements.clone(),
        )
        .await
        .unwrap();
        for (network, expected) in networks.iter().zip([2_133_103, 2_133_104]) {
            let txn = env.dbx.begin().await.unwrap();
            resolve_claimed_network(&env, &txn, network.id, version)
                .await
                .unwrap();
            let rows = network_settlement_rows(&txn, network.id).await;
            assert_eq!(rows[0].settlement_id, Some(expected));
            assert_eq!(rows[0].is_undefined, Some(false));
            txn.commit().await.unwrap();
            if expected == 2_133_103 {
                let mut config = config.clone().into_active_model();
                config.settlements_configs = Set(serde_json::json!(["second"]));
                config.update(&env.dbx).await.unwrap();
            }
        }
        sigint_network::Entity::delete_many()
            .filter(
                sigint_network::Column::Id
                    .is_in(networks.iter().map(|network| network.id)),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
        area_of_responsibility::Entity::delete_by_id(config.aor_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        settlement::Entity::delete_many()
            .filter(
                settlement::Column::Id
                    .is_in([2_133_101, 2_133_102, 2_133_103, 2_133_104]),
            )
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_location_edits_reconcile_and_resolve_the_whole_set_2133() {
        use crate::battle_line::network_settlements::resolve_claimed_network;
        use crate::entities::{
            network_invalidation_task, sigint_network, sigint_network_freq,
        };
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let network =
            crate::functest::tests::mk_sigint_network(
                &txn,
                sigint_network::ActiveModel {
                    location: Set(
                        "|#2133 A|#2133 SHARED|#2133 FOREST|".to_string()
                    ),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let frequency = crate::functest::tests::mk_sigint_network_freq(
            &txn,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("213.3".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(
            |row| row.settlement_id.is_none() && row.is_undefined.is_none()
        ));
        let (map_settlements, settlements_pending) =
            crate::sigint::network::bl::get_network_settlements(
                &txn, network.id,
            )
            .await
            .unwrap();
        assert!(map_settlements.is_empty());
        assert!(settlements_pending);
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        let frequency_task = network_invalidation_task::Entity::find()
            .filter(
                network_invalidation_task::Column::Frequency
                    .eq(&frequency.freq),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frequency_task.sigint_network_id, None);
        assert_eq!(frequency_task.since_ts, frequency.active_from);
        let (map_settlements, settlements_pending) =
            crate::sigint::network::bl::get_network_settlements(
                &txn, network.id,
            )
            .await
            .unwrap();
        assert!(!settlements_pending);
        assert_eq!(
            map_settlements
                .iter()
                .map(|settlement| settlement.id)
                .collect::<Vec<_>>(),
            vec![2_133_101, 2_133_103]
        );
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(
            rows.iter().map(|row| row.settlement_id).collect::<Vec<_>>(),
            vec![Some(2_133_101), None, Some(2_133_103)]
        );
        let mut network = network.into_active_model();
        network.location =
            Set("| #2133 shared |#2133 forest|#2133 a|#2133 A|".to_string());
        let network = network.update(&txn).await.unwrap();
        assert_eq!(network_settlement_rows(&txn, network.id).await, rows);
        let mut network = network.into_active_model();
        network.location = Set("|#2133 B|#2133 SHARED|".to_string());
        let network = network.update(&txn).await.unwrap();
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(
            |row| row.settlement_id.is_none() && row.is_undefined.is_none()
        ));
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(
            rows.iter().map(|row| row.settlement_id).collect::<Vec<_>>(),
            vec![Some(2_133_102), Some(2_133_104)]
        );
        let mut network = network.into_active_model();
        network.location = Set("|#2133 SHARED|".to_string());
        let network = network.update(&txn).await.unwrap();
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(rows[0].settlement_id, None);
        assert_eq!(rows[0].is_undefined, Some(true));
        let mut network = network.into_active_model();
        network.location = Set(String::new());
        network.update(&txn).await.unwrap();
        assert!(network_settlement_rows(&txn, rows[0].network_id)
            .await
            .is_empty());
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolved_network_locations_anchor_and_requeue_inbox_names_2133() {
        use crate::battle_line::network_settlements::resolve_claimed_network;
        use crate::entities::{sigint_inbox_item_network, sigint_network};
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let network = crate::functest::tests::mk_sigint_network(
            &txn,
            sigint_network::ActiveModel {
                location: Set("|#2133 A|".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let request =
            insert_cluster_test_item(&txn, &[("#2133 SHARED", None, None)])
                .await
                .unwrap();
        let mut cache = SettlementResolutionCache::default();
        resolve_claimed_item(&txn, request.item_id, version, &mut cache)
            .await
            .unwrap();
        assert_eq!(
            cluster_test_rows(&txn, request.item_id).await.unwrap()[0]
                .is_undefined,
            Some(true)
        );
        sigint_inbox_item_network::ActiveModel {
            sigint_inbox_item_id: Set(request.item_id),
            sigint_network_id: Set(network.id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        crate::entities::settlement::Entity::update_many()
            .col_expr(
                crate::entities::settlement::Column::Lon,
                Expr::value(Some(181.0)),
            )
            .filter(crate::entities::settlement::Column::Id.eq(2_133_101))
            .exec(&txn)
            .await
            .unwrap();
        assert!(
            super::super::network_settlements::load_item_network_anchors(
                &txn,
                request.item_id,
            )
            .await
            .unwrap()
            .is_empty()
        );
        crate::entities::settlement::Entity::update_many()
            .col_expr(
                crate::entities::settlement::Column::Lon,
                Expr::value(Some(1.0)),
            )
            .filter(crate::entities::settlement::Column::Id.eq(2_133_101))
            .exec(&txn)
            .await
            .unwrap();
        requeue_unresolved_item_settlements(&txn, &[request.item_id])
            .await
            .unwrap();
        assert_eq!(
            cluster_test_rows(&txn, request.item_id).await.unwrap()[0]
                .is_undefined,
            None
        );
        resolve_claimed_item(&txn, request.item_id, version, &mut cache)
            .await
            .unwrap();
        assert_eq!(
            cluster_test_rows(&txn, request.item_id).await.unwrap()[0]
                .settlement_id,
            Some(2_133_103)
        );
        sigint_network::Entity::delete_by_id(network.id)
            .exec(&txn)
            .await
            .unwrap();
        sigint_inbox_item_settlement::Entity::update_many()
            .col_expr(
                sigint_inbox_item_settlement::Column::SettlementId,
                Expr::value(Option::<i32>::None),
            )
            .col_expr(
                sigint_inbox_item_settlement::Column::IsUndefined,
                Expr::value(Some(true)),
            )
            .filter(
                sigint_inbox_item_settlement::Column::ItemId
                    .eq(request.item_id),
            )
            .exec(&txn)
            .await
            .unwrap();
        requeue_unresolved_item_settlements(&txn, &[request.item_id])
            .await
            .unwrap();
        assert_eq!(
            cluster_test_rows(&txn, request.item_id).await.unwrap()[0]
                .is_undefined,
            None
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn network_settlement_deletion_requeues_and_network_restoration_rebuilds_2133(
    ) {
        use crate::battle_line::network_settlements::resolve_claimed_network;
        use crate::entities::{settlement, sigint_network};
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let network = crate::functest::tests::mk_sigint_network(
            &txn,
            sigint_network::ActiveModel {
                location: Set("|#2133 A|".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        settlement::Entity::delete_by_id(2_133_101)
            .exec(&txn)
            .await
            .unwrap();
        let rows = network_settlement_rows(&txn, network.id).await;
        assert_eq!(rows[0].settlement_id, None);
        assert_eq!(rows[0].is_undefined, None);
        crate::entities::network_invalidation_task::Entity::delete_many()
            .exec(&txn)
            .await
            .unwrap();
        resolve_claimed_network(&env, &txn, network.id, version)
            .await
            .unwrap();
        assert!(crate::entities::network_invalidation_task::Entity::find()
            .filter(
                crate::entities::network_invalidation_task::Column::SigintNetworkId
                    .eq(network.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        let mut network = network.into_active_model();
        network.deleted = Set(true);
        let network = network.update(&txn).await.unwrap();
        assert!(network_settlement_rows(&txn, network.id).await.is_empty());
        let mut network = network.into_active_model();
        network.deleted = Set(false);
        let network = network.update(&txn).await.unwrap();
        assert_eq!(network_settlement_rows(&txn, network.id).await.len(), 1);
        sigint_network::Entity::delete_by_id(network.id)
            .exec(&txn)
            .await
            .unwrap();
        assert!(network_settlement_rows(&txn, network.id).await.is_empty());
        txn.rollback().await.unwrap();
    }

    fn assert_cluster_test_links(
        rows: &[sigint_inbox_item_settlement::Model],
        first_id: i64,
        second_id: i64,
    ) {
        for (item_id, name, expected) in [
            (first_id, "#2133 A", Some(2_133_101)),
            (first_id, "#2133 SHARED", Some(2_133_103)),
            (first_id, "#2133 FOREST", None),
            (second_id, "#2133 B", Some(2_133_102)),
            (second_id, "#2133 SHARED", Some(2_133_104)),
            (second_id, "#2133 UNDEFINED", None),
        ] {
            let row = rows
                .iter()
                .find(|row| {
                    row.item_id == item_id && row.settlement_text == name
                })
                .unwrap();
            assert_eq!(row.settlement_id, expected, "{name} in {item_id}");
            assert_eq!(row.is_undefined, Some(expected.is_none()));
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn retries_preserve_the_majority_and_reject_distant_outliers_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let request = insert_cluster_test_item(
            &txn,
            &[
                ("#2133 A", None, None),
                ("#2133 SHARED", None, None),
                ("#2133 B", None, None),
            ],
        )
        .await
        .unwrap();
        let mut cache = SettlementResolutionCache::default();
        for _ in 0..3 {
            resolve_claimed_item(&txn, request.item_id, version, &mut cache)
                .await
                .unwrap();
            let rows = cluster_test_rows(&txn, request.item_id).await.unwrap();
            assert_eq!(
                rows.iter().map(|row| row.settlement_id).collect::<Vec<_>>(),
                vec![Some(2_133_101), Some(2_133_103), None]
            );
            assert_eq!(rows[2].is_undefined, Some(true));
            requeue_unresolved_item_settlements(&txn, &[request.item_id])
                .await
                .unwrap();
        }
        txn.rollback().await.unwrap();
    }

    async fn insert_kharkiv_resolution_test_item(
        env: &Env,
        txn: &DatabaseTransaction,
    ) -> (i64, OneoffItemResolutionRequest) {
        let version = insert_active_test_battle_line(txn).await.unwrap();
        txn.execute_unprepared(
            r#"update battle_line_version set geometry = ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(37.8 49,37.8 51))', 4326) where retired_at is null"#,
        ).await.unwrap();
        env.settlements.write().unwrap().default_settlements_data = Arc::new(
            crate::location::load_from_file(
                vec!["settlements_json/kharkivska_oblast.json".to_string()],
                Mode::Test,
            )
            .unwrap(),
        );
        let request = insert_cluster_test_item(
            txn,
            &[
                ("БОЛОГІВКА", None, None),
                ("ДВОРІЧАНСЬКЕ", None, None),
                ("КАМ’ЯНКА", None, None),
            ],
        )
        .await
        .unwrap();
        (version, request)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn kharkiv_inbox_resolution_uses_database_candidates_and_isolates_catalog_cache_2133(
    ) {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let (version, request) =
            insert_kharkiv_resolution_test_item(&env, &txn).await;
        let mut cache = SettlementResolutionCache::default();
        let network_results = resolve_settlement_names(
            &txn,
            env.settlements.clone(),
            request.settlement_texts.clone(),
            &[],
            version,
            &mut cache,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            network_results
                .iter()
                .map(|result| result.chosen_settlement_id)
                .collect::<Vec<_>>(),
            vec![Some(45210), Some(18487), None]
        );
        for _ in 0..3 {
            resolve_claimed_item(&txn, request.item_id, version, &mut cache)
                .await
                .unwrap();
            let rows = cluster_test_rows(&txn, request.item_id).await.unwrap();
            assert_eq!(
                rows.iter().map(|row| row.settlement_id).collect::<Vec<_>>(),
                vec![Some(45210), Some(18487), Some(94886)]
            );
            assert_eq!(rows[2].is_undefined, Some(false));
            requeue_unresolved_item_settlements(&txn, &[request.item_id])
                .await
                .unwrap();
        }
        let row =
            cluster_test_rows(&txn, request.item_id).await.unwrap()[2].clone();
        persist_settlement_resolution(&txn, row, Some(95309))
            .await
            .unwrap();
        *env.settlements.write().unwrap() =
            crate::location::SettlementsDataConfig::default();
        let item_id = request.item_id;
        process_oneoff_request_groups(
            &txn,
            BTreeMap::from([(vec![], vec![request])]),
            version,
            &mut SettlementResolutionCache::default(),
            &mut OneoffLinkInboxSettlementsStats::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            cluster_test_rows(&txn, item_id)
                .await
                .unwrap()
                .iter()
                .map(|row| row.settlement_id)
                .collect::<Vec<_>>(),
            vec![Some(45210), Some(18487), Some(94886)]
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn inbox_uses_database_aliases_and_rejects_dictionary_only_names_and_invalid_coordinates_2133(
    ) {
        use crate::entities::{settlement, settlement_alias};
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let mut dictionary_alias =
            env.settlements.read().unwrap().default_settlements_data.3
                [&2_133_102]
                .clone();
        dictionary_alias.name = "#2133 JSON ONLY".to_string();
        env.settlements.write().unwrap().default_settlements_data = Arc::new((
            vec![],
            vec![],
            crate::location::trie::Trie::new(),
            BTreeMap::from([(2_133_102, dictionary_alias.clone())]),
            BTreeMap::from([(
                dictionary_alias.name.clone(),
                vec![dictionary_alias],
            )]),
        ));
        settlement_alias::ActiveModel {
            id: Set(uuid::Uuid::now_v7()),
            settlement_id: Set(2_133_101),
            text: Set("#2133 DB’ONLY".to_string()),
        }
        .insert(&txn)
        .await
        .unwrap();
        settlement::ActiveModel {
            id: Set(2_133_105),
            kind: Set(
                crate::entities::sea_orm_active_enums::SettlementKind::Village,
            ),
            name: Set("#2133 INVALID".to_string()),
            lat: Set(Some(91.0)),
            lon: Set(Some(1.0)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let mut cache = SettlementResolutionCache::default();
        for (name, expected) in [
            ("#2133 db'only", Some(2_133_101)),
            ("#2133 JSON ONLY", None),
            ("#2133 INVALID", None),
        ] {
            let request = insert_cluster_test_item(&txn, &[(name, None, None)])
                .await
                .unwrap();
            resolve_claimed_item(&txn, request.item_id, version, &mut cache)
                .await
                .unwrap();
            let rows = cluster_test_rows(&txn, request.item_id).await.unwrap();
            assert_eq!(rows[0].settlement_id, expected, "{name}");
            assert_eq!(rows[0].is_undefined, Some(expected.is_none()));
        }
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn isolates_cached_clusters_and_preserves_fixed_links_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let first = insert_cluster_test_item(
            &txn,
            &[
                ("#2133 A", None, None),
                ("#2133 SHARED", None, None),
                ("#2133 FOREST", None, None),
            ],
        )
        .await
        .unwrap();
        let second = insert_cluster_test_item(
            &txn,
            &[
                ("#2133 B", Some(2_133_102), Some(false)),
                ("#2133 SHARED", None, None),
                ("#2133 UNDEFINED", None, Some(true)),
            ],
        )
        .await
        .unwrap();
        let mut cache = SettlementResolutionCache::default();
        for request in [&first, &second] {
            assert_eq!(
                resolve_claimed_item(
                    &txn,
                    request.item_id,
                    version,
                    &mut cache
                )
                .await
                .unwrap(),
                Some(request.item_id)
            );
        }
        let rows = sigint_inbox_item_settlement::Entity::find()
            .filter(
                sigint_inbox_item_settlement::Column::ItemId
                    .is_in([first.item_id, second.item_id]),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_cluster_test_links(&rows, first.item_id, second.item_id);
        assert!(cache
            .get(
                &SettlementCandidateSource::Database,
                version,
                &[],
                "#2133 UNDEFINED"
            )
            .is_some());
        let cached = cache
            .get(
                &SettlementCandidateSource::Database,
                version,
                &[],
                "#2133 SHARED",
            )
            .unwrap();
        assert_eq!(cached.candidates.len(), 2);
        assert_eq!(
            location_result_from_draft(cached).chosen_settlement_id,
            Some(2_133_104)
        );

        let mut stats = OneoffLinkInboxSettlementsStats::default();
        let affected = process_oneoff_request_groups(
            &txn,
            BTreeMap::from([(vec![], vec![first, second])]),
            version,
            &mut cache,
            &mut stats,
        )
        .await
        .unwrap();
        assert_eq!(affected.len(), 2);
        assert_eq!(stats.matched, 4);
        let relinked = sigint_inbox_item_settlement::Entity::find()
            .filter(
                sigint_inbox_item_settlement::Column::ItemId.is_in(affected),
            )
            .order_by_asc(sigint_inbox_item_settlement::Column::Id)
            .all(&txn)
            .await
            .unwrap();
        let mut rows = rows;
        rows.sort_by_key(|row| row.id);
        assert_eq!(relinked, rows);
        txn.rollback().await.unwrap();
    }

    async fn cluster_test_rows(
        txn: &DatabaseTransaction,
        item_id: i64,
    ) -> anyhow::Result<Vec<sigint_inbox_item_settlement::Model>> {
        sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .order_by_asc(sigint_inbox_item_settlement::Column::Id)
            .all(txn)
            .await
            .c(h!())
    }

    async fn change_cluster_test_locations(
        txn: &DatabaseTransaction,
        request: &OneoffItemResolutionRequest,
        locations: &str,
    ) -> anyhow::Result<Vec<sigint_inbox_item_settlement::Model>> {
        sigint_inbox_item::Entity::update_many()
            .col_expr(
                sigint_inbox_item::Column::LocationV2,
                Expr::value(Some(locations)),
            )
            .filter(sigint_inbox_item::Column::Id.eq(request.item_id))
            .exec(txn)
            .await
            .c(h!())?;
        reconcile_item_locations(
            txn,
            request.item_id,
            request.item_uuid,
            Some(locations),
        )
        .await
        .c(h!())?;
        cluster_test_rows(txn, request.item_id).await.c(h!())
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconsiders_cluster_after_location_edits_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let version = setup_cluster_test_catalog(&env, &txn).await;
        let request = insert_cluster_test_item(
            &txn,
            &[("#2133 SHARED", None, None), ("#2133 FOREST", None, None)],
        )
        .await
        .unwrap();
        let mut cache = SettlementResolutionCache::default();
        resolve_claimed_item(&txn, request.item_id, version, &mut cache)
            .await
            .unwrap();
        for (locations, expected) in [
            (
                "|#2133 A|#2133 SHARED|#2133 FOREST|",
                vec![Some(2_133_101), Some(2_133_103), None],
            ),
            ("|#2133 SHARED|#2133 FOREST|", vec![None, None]),
            (
                "|#2133 A|#2133 B|#2133 SHARED|#2133 FOREST|",
                vec![None, None, None, None],
            ),
            (
                "|#2133 A|#2133 SHARED|#2133 FOREST|",
                vec![Some(2_133_101), Some(2_133_103), None],
            ),
        ] {
            let rows = change_cluster_test_locations(&txn, &request, locations)
                .await
                .unwrap();
            assert!(
                rows.iter().all(|row| {
                    row.settlement_id.is_none() && row.is_undefined.is_none()
                }),
                "all joint decisions must be pending after {locations}"
            );
            assert_eq!(
                resolve_claimed_item(
                    &txn,
                    request.item_id,
                    version,
                    &mut cache,
                )
                .await
                .unwrap(),
                Some(request.item_id)
            );
            let rows = cluster_test_rows(&txn, request.item_id).await.unwrap();
            for (name, expected) in
                to_location_list(locations).into_iter().zip(expected)
            {
                let row = rows
                    .iter()
                    .find(|row| row.settlement_text == name)
                    .unwrap();
                assert_eq!(row.settlement_id, expected, "{locations}: {name}");
                assert_eq!(row.is_undefined, Some(expected.is_none()));
            }
            reconcile_item_locations(
                &txn,
                request.item_id,
                request.item_uuid,
                Some(&format!("{locations}{locations}")),
            )
            .await
            .unwrap();
            assert_eq!(
                cluster_test_rows(&txn, request.item_id).await.unwrap(),
                rows,
            );
            assert_eq!(
                resolve_claimed_item(
                    &txn,
                    request.item_id,
                    version,
                    &mut cache,
                )
                .await
                .unwrap(),
                None,
                "unchanged names must preserve linked and undefined rows"
            );
        }
        txn.rollback().await.unwrap();
    }

    async fn insert_relink_test_settlement(
        txn: &DatabaseTransaction,
        id: i32,
        name: &str,
    ) -> anyhow::Result<()> {
        crate::entities::settlement::ActiveModel {
            id: Set(id),
            kind: Set(
                crate::entities::sea_orm_active_enums::SettlementKind::Village,
            ),
            name: Set(name.to_string()),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok(())
    }

    async fn insert_oneoff_relink_test_item(
        txn: &DatabaseTransaction,
        settlement_text: &str,
        settlement_id: i32,
    ) -> anyhow::Result<(i64, Option<uuid::Uuid>)> {
        let message = signal_message::ActiveModel {
            body: Set(Some("#2287 settlement relinking".to_string())),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            location_v2: Set(Some(format!("|{settlement_text}|"))),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        sigint_inbox_item_settlement::ActiveModel {
            item_uuid: Set(item.id_uuid),
            item_id: Set(message.id),
            settlement_text: Set(settlement_text.to_string()),
            settlement_id: Set(Some(settlement_id)),
            is_undefined: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok((message.id, item.id_uuid))
    }

    async fn insert_settlement_stats_test_fixture(
        txn: &DatabaseTransaction,
    ) -> anyhow::Result<(sigint_inbox_item_settlement::Model, String, i32)>
    {
        use crate::entities::sea_orm_active_enums::SettlementKind;
        use crate::entities::{settlement, signal_group, signal_message_group};

        let message_ts = Utc::now().naive_utc() - Duration::days(1);
        let group_master_key = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .select_only()
            .column(signal_group::Column::MasterKey)
            .into_tuple::<String>()
            .one(txn)
            .await
            .c(h!())?
            .c(h!())?;
        let message = signal_message::ActiveModel {
            body: Set(Some("#2133 settlement stats invalidation".to_string())),
            created_at: Set(message_ts),
            timestamp: Set(Some(message_ts)),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group_master_key.clone())),
            created_at: Set(message_ts),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        let settlement_id = 2_287_004;
        settlement::Entity::insert(settlement::ActiveModel {
            id: Set(settlement_id),
            kind: Set(SettlementKind::Village),
            name: Set("#2133 STATS INVALIDATION".to_string()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(settlement::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(txn)
        .await
        .c(h!())?;
        let row = sigint_inbox_item_settlement::ActiveModel {
            item_uuid: Set(item.id_uuid),
            item_id: Set(message.id),
            settlement_text: Set("STATS INVALIDATION".to_string()),
            settlement_id: Set(None),
            is_undefined: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok((row, group_master_key, settlement_id))
    }

    async fn insert_active_test_battle_line(
        txn: &DatabaseTransaction,
    ) -> anyhow::Result<i64> {
        txn.execute_unprepared(
            "update battle_line_version set retired_at = now() at time zone 'utc' where retired_at is null",
        )
        .await
        .c(h!())?;
        let row = txn
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                r#"
insert into battle_line_version
    (geometry, source_file_name, uploaded_by_login_id)
select
    ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(0 0,1 1))', 4326),
    'issue-2133-lock-regression.kml',
    id
from login
where not deleted
order by created_at
limit 1
returning id
                "#,
            ))
            .await
            .c(h!())?
            .c(h!())?;
        row.try_get("", "id").c(h!())
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_renamed_links_and_preserves_undefined_forests_3383() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        *env.settlements.write().unwrap() =
            crate::location::SettlementsDataConfig::default();
        let setup = env.dbx.begin().await.unwrap();
        insert_active_test_battle_line(&setup).await.unwrap();
        setup.execute_unprepared(
            "update battle_line_version set geometry = ST_GeomFromText('GEOMETRYCOLLECTION(LINESTRING(37 49,37 51))', 4326) where retired_at is null",
        ).await.unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &setup,
            signal_message::ActiveModel {
                body: Set(Some("#3383 settlement links".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for (settlement_id, text) in
            [(79948, "Село_3383_перевірка"), (65447, "Рибалкіне")]
        {
            crate::entities::settlement_alias::ActiveModel {
                id: Set(uuid::Uuid::now_v7()),
                settlement_id: Set(settlement_id),
                text: Set(text.to_string()),
            }
            .insert(&setup)
            .await
            .unwrap();
        }
        let location_v2 =
            "|АНИЩИНЕ|ІВАЩИНЕ|РИБАЛКІНЕ|ВЕРХНЄ ГОРІХОВЕ|ЗАЛИВНИЙ|СЕЛО_3383_ПЕРЕВІРКА|";
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            location_v2: Set(Some(location_v2.to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&setup)
        .await
        .unwrap();
        reconcile_item_locations(
            &setup,
            item.id,
            item.id_uuid,
            Some(location_v2),
        )
        .await
        .unwrap();
        setup.commit().await.unwrap();
        let mut cursor = SettlementWorkerCursor::default();
        assert!(run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
        let rows = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item.id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(rows.len(), 6);
        for (text, settlement_id) in [
            ("ІВАЩИНЕ", Some(2_000_000_002)),
            ("АНИЩИНЕ", Some(2_000_000_001)),
            ("СЕЛО_3383_ПЕРЕВІРКА", Some(79948)),
            ("ВЕРХНЄ ГОРІХОВЕ", None),
            ("ЗАЛИВНИЙ", None),
            ("РИБАЛКІНЕ", Some(65447)),
        ] {
            let row =
                rows.iter().find(|row| row.settlement_text == text).unwrap();
            assert_eq!(row.settlement_id, settlement_id);
            assert_eq!(row.is_undefined, Some(settlement_id.is_none()));
        }
        reconcile_item_locations(
            &env.dbx,
            item.id,
            item.id_uuid,
            Some(location_v2),
        )
        .await
        .unwrap();
        assert!(!run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
        let retained = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item.id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(retained, rows);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn requeues_deleted_settlement_links_3383() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let (row, _, settlement_id) =
            insert_settlement_stats_test_fixture(&txn).await.unwrap();
        insert_active_test_battle_line(&txn).await.unwrap();
        persist_settlement_resolution(&txn, row.clone(), Some(settlement_id))
            .await
            .unwrap();
        let linked = sigint_inbox_item_settlement::Entity::find_by_id(row.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(linked.is_undefined, Some(false));
        persist_settlement_resolution(&txn, linked, None)
            .await
            .unwrap();
        let unresolved =
            sigint_inbox_item_settlement::Entity::find_by_id(row.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(unresolved.is_undefined, Some(true));
        persist_settlement_resolution(&txn, unresolved, Some(settlement_id))
            .await
            .unwrap();
        txn.commit().await.unwrap();

        crate::entities::settlement::Entity::delete_by_id(settlement_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        let pending = sigint_inbox_item_settlement::Entity::find_by_id(row.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.settlement_id, None);
        assert_eq!(pending.is_undefined, None);

        let mut cursor = SettlementWorkerCursor::default();
        assert!(run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
        let unresolved =
            sigint_inbox_item_settlement::Entity::find_by_id(row.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(unresolved.settlement_id, None);
        assert_eq!(unresolved.is_undefined, Some(true));
        assert!(!run_inbox_settlement_worker_once(&env, &mut cursor)
            .await
            .unwrap());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn processed_settlement_flag_migration_roundtrips_3383() {
        use echo_migration::MigratorTrait;

        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let (row, _, settlement_id) =
            insert_settlement_stats_test_fixture(&txn).await.unwrap();
        persist_settlement_resolution(&txn, row.clone(), Some(settlement_id))
            .await
            .unwrap();
        let migration = echo_migration::Migrator::migrations()
            .into_iter()
            .find(|migration| {
                migration.name()
                    == "m20261010_073418_inbox_settlement_processed_flag"
            })
            .unwrap();
        let manager = echo_migration::SchemaManager::new(&txn);
        migration.down(&manager).await.unwrap();
        let restored = sigint_inbox_item_settlement::Entity::find_by_id(row.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.settlement_id, Some(settlement_id));
        assert_eq!(restored.is_undefined, None);
        let rejected = txn.begin().await.unwrap();
        assert!(persist_settlement_resolution(
            &rejected,
            restored.clone(),
            Some(settlement_id)
        )
        .await
        .is_err());
        rejected.rollback().await.unwrap();
        migration.up(&manager).await.unwrap();
        persist_settlement_resolution(&txn, restored, Some(settlement_id))
            .await
            .unwrap();
        let rejected = txn.begin().await.unwrap();
        let mut invalid = row.into_active_model();
        invalid.settlement_id = Set(Some(settlement_id));
        invalid.is_undefined = Set(Some(true));
        assert!(invalid.update(&rejected).await.is_err());
        rejected.rollback().await.unwrap();
        txn.rollback().await.unwrap();
    }

    #[test]
    fn oneoff_bounds_are_local_half_open_and_reject_inversion() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 18).unwrap();
        let defaults = oneoff_bounds_at(
            &OneoffLinkInboxSettlementsPs {
                since_ts: None,
                till_ts: None,
            },
            today,
        )
        .unwrap();
        assert_eq!(
            defaults,
            (
                Some(crate::stats::start_of_day(today).unwrap()),
                Some(
                    crate::stats::start_of_day(today + Duration::days(1))
                        .unwrap()
                )
            )
        );

        let explicit = oneoff_bounds_at(
            &OneoffLinkInboxSettlementsPs {
                since_ts: Some("2026-08-18T01:02:03".to_string()),
                till_ts: None,
            },
            today,
        )
        .unwrap();
        assert_eq!(
            explicit.0,
            Some(parse_local_datetime("2026-08-18T01:02:03").unwrap())
        );
        assert_eq!(explicit.1, None);

        assert!(oneoff_bounds_at(
            &OneoffLinkInboxSettlementsPs {
                since_ts: Some("2026-08-19T00:00:00".to_string()),
                till_ts: Some("2026-08-18T00:00:00".to_string()),
            },
            today,
        )
        .is_err());
    }

    #[test]
    fn location_texts_use_the_standard_parser_and_deduplicate() {
        assert_eq!(
            location_texts(Some("| БАЛАКЛІЯ |КУП'ЯНСЬК|БАЛАКЛІЯ|")),
            BTreeSet::from(["БАЛАКЛІЯ".to_string(), "КУП'ЯНСЬК".to_string()])
        );
        assert!(location_texts(Some("||")).is_empty());
        assert!(location_texts(None).is_empty());
    }

    #[test]
    fn resolution_cache_reuses_normalized_text_only_within_snapshot_scope() {
        let result = LocationResolutionDraft {
            location: "КУП'ЯНСЬК".to_string(),
            candidates: vec![],
            chosen_candidate_index: Some(0),
            battle_line_distances: BTreeMap::new(),
            invalid_aor_ids: vec![],
        };
        let source = SettlementCandidateSource::Database;
        let mut resolution_cache = SettlementResolutionCache::default();
        resolution_cache.insert(&source, 7, &[3, 2], result);

        let cached = resolution_cache
            .get(&source, 7, &[2, 3], " купʼянськ ")
            .expect("same battle line and AOR scope must reuse resolution");
        assert_eq!(cached.location, " купʼянськ ");
        assert_eq!(cached.chosen_candidate_index, Some(0));
        assert!(resolution_cache
            .get(&source, 8, &[2, 3], "КУП’ЯНСЬК")
            .is_none());
        assert!(resolution_cache
            .get(&source, 7, &[2], "КУП’ЯНСЬК")
            .is_none());
        let cached = resolution_cache
            .get(&source, 7, &[2, 3], "КУП’ЯНСЬК")
            .unwrap();
        resolution_cache.insert(
            &source,
            7,
            &[2, 3],
            LocationResolutionDraft {
                location: "#3383 Straße".to_string(),
                ..cached
            },
        );
        assert!(resolution_cache
            .get(&source, 7, &[2, 3], "#3383 STRASSE")
            .is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconciles_removed_new_and_unchanged_location_texts_2133() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let message = signal_message::ActiveModel {
            body: Set(Some("#2287 settlement reconciliation".to_string())),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let item_id = item.id;

        reconcile_item_locations(&txn, item_id, item.id_uuid, Some("|A|B|A|"))
            .await
            .unwrap();
        let rows = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        let preserved_id = rows[0].id;
        sigint_inbox_item_settlement::Entity::update_many()
            .col_expr(
                sigint_inbox_item_settlement::Column::IsUndefined,
                Expr::value(Some(true)),
            )
            .filter(sigint_inbox_item_settlement::Column::Id.eq(preserved_id))
            .exec(&txn)
            .await
            .unwrap();

        reconcile_item_locations(&txn, item_id, item.id_uuid, Some("|A|C|"))
            .await
            .unwrap();
        let rows = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, preserved_id);
        assert_eq!(rows[0].settlement_id, None);
        assert_eq!(rows[0].is_undefined, None);
        assert_eq!(rows[1].settlement_text, "C");
        assert_eq!(rows[1].settlement_id, None);
        assert_eq!(rows[1].is_undefined, None);

        reconcile_item_locations(&txn, item_id, item.id_uuid, None)
            .await
            .unwrap();
        assert_eq!(
            sigint_inbox_item_settlement::Entity::find()
                .filter(
                    sigint_inbox_item_settlement::Column::ItemId.eq(item_id),
                )
                .count(&txn)
                .await
                .unwrap(),
            0
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn recalculate_historic_settlements_writes_missing_rows_only() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let missing_id = insert_historic_location_item(
            &txn,
            Some("|КРАСНОЄ|ОХРІМІВКА|"),
        )
        .await
        .unwrap();
        let already_id =
            insert_historic_location_item(&txn, Some("|ALREADY|"))
                .await
                .unwrap();
        reconcile_item_locations(
            &txn,
            already_id,
            None,
            Some("|ALREADY|"),
        )
        .await
        .unwrap();
        let empty_id =
            insert_historic_location_item(&txn, Some("||")).await.unwrap();
        let null_id =
            insert_historic_location_item(&txn, None).await.unwrap();
        let only_ids = [missing_id, already_id, empty_id, null_id];

        let page = recalculate_historic_settlement_page(
            &txn, 0, 10, Some(&only_ids),
        )
        .await
        .unwrap();
        assert_eq!(page.scanned, 2);
        assert_eq!(page.written, 1);
        assert_eq!(page.skipped, 1);
        let texts = sigint_inbox_item_settlement::Entity::find()
            .filter(
                sigint_inbox_item_settlement::Column::ItemId.eq(missing_id),
            )
            .order_by_asc(sigint_inbox_item_settlement::Column::SettlementText)
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(
            texts
                .iter()
                .map(|row| row.settlement_text.as_str())
                .collect::<Vec<_>>(),
            vec!["КРАСНОЄ", "ОХРІМІВКА"]
        );

        let again = recalculate_historic_settlement_page(
            &txn, 0, 10, Some(&only_ids),
        )
        .await
        .unwrap();
        assert_eq!(again.scanned, 1);
        assert_eq!(again.written, 0);
        assert_eq!(again.skipped, 1);
        txn.rollback().await.unwrap();
    }

    async fn insert_historic_location_item(
        txn: &DatabaseTransaction,
        location_v2: Option<&str>,
    ) -> anyhow::Result<i64> {
        let message = signal_message::ActiveModel {
            body: Set(Some("#3308 historic settlement".to_string())),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        let item = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            location_v2: Set(location_v2.map(str::to_string)),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok(item.id)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn oneoff_relinks_existing_settlement_2287() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let integration = crate::entities::api_integration::ActiveModel {
            api_user_login_id: Set(crate::users::system_login_id(&txn)
                .await
                .unwrap()),
            sync_enabled: Set(true),
            has_iggy_connection: Set(true),
            iggy_url: Set(Some("tcp://localhost:8090".to_string())),
            iggy_login: Set(Some("test".to_string())),
            iggy_password: Set(Some("test".to_string())),
            iggy_inbox_topic: Set(Some("test-inbox".to_string())),
            iggy_analytics_topic: Set(Some("test-analytics".to_string())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let old_settlement_id = 2_287_214;
        let new_settlement_id = 2_287_215;
        for (id, name) in [
            (old_settlement_id, "#2287 OLD MATCH"),
            (new_settlement_id, "#2287 NEW MATCH"),
        ] {
            insert_relink_test_settlement(&txn, id, name).await.unwrap();
        }
        let (item_id, item_uuid) = insert_oneoff_relink_test_item(
            &txn,
            "AMBIGUOUS",
            old_settlement_id,
        )
        .await
        .unwrap();
        let mut stats = OneoffLinkInboxSettlementsStats::default();
        for settlement_id in
            [old_settlement_id, new_settlement_id, new_settlement_id]
        {
            let request = OneoffItemResolutionRequest {
                item_id,
                item_uuid,
                location_v2: Some("|RENAMED|".to_string()),
                settlement_texts: vec!["RENAMED".to_string()],
            };
            let resolutions = vec![BattleLineLocationResult {
                location: "RENAMED".to_string(),
                candidates: vec![],
                chosen_settlement_id: Some(settlement_id),
                distance_m: Some(1.0),
                invalid_aor_ids: vec![],
            }];
            process_oneoff_item_in_transaction(
                &txn,
                request,
                resolutions,
                &mut stats,
            )
            .await
            .unwrap();
        }

        let row = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.settlement_id, Some(new_settlement_id));
        assert_eq!(row.is_undefined, Some(false));
        let events = crate::entities::api_integration_iggy_event::Entity::find()
            .filter(
                crate::entities::api_integration_iggy_event::Column::ApiIntegrationId
                    .eq(integration.id),
            )
            .filter(
                crate::entities::api_integration_iggy_event::Column::SigintInboxItemId
                    .eq(item_id),
            )
            .order_by_asc(crate::entities::api_integration_iggy_event::Column::Id)
            .all(&txn)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| {
                event.payload["event_type"].as_str().is_some_and(|kind| {
                    kind.starts_with("sigint_inbox_item_settlement_")
                })
            })
            .map(|event| event.payload)
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                serde_json::json!({
                    "event_type": "sigint_inbox_item_settlement_unlinked",
                    "settlement_id": old_settlement_id,
                }),
                serde_json::json!({
                    "event_type": "sigint_inbox_item_settlement_linked",
                    "settlement_id": new_settlement_id,
                }),
            ]
        );
        assert_eq!(
            stats,
            OneoffLinkInboxSettlementsStats {
                processed: 3,
                matched: 3,
                ..Default::default()
            }
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn iggy_settlement_trigger_removal_roundtrips() {
        use echo_migration::MigratorTrait;

        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let migration = echo_migration::Migrator::migrations()
            .into_iter()
            .find(|migration| {
                migration.name()
                    == "m20261021_091705_remove_iggy_settlement_trigger"
            })
            .unwrap();
        let manager = echo_migration::SchemaManager::new(&txn);
        for (step, restored) in [false, true, false].into_iter().enumerate() {
            if restored {
                migration.down(&manager).await.unwrap();
            } else if step > 0 {
                migration.up(&manager).await.unwrap();
            }
            let installed = txn
                .query_one_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    r#"select exists (
                        select 1 from pg_trigger
                        where tgname = 'sigint_inbox_item_settlement_capture_iggy_link'
                    ) as installed"#,
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<bool>("", "installed")
                .unwrap();
            assert_eq!(installed, restored);
        }
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn settlement_changes_enqueue_stats_only_after_commit() {
        use crate::entities::group_stats_recalculation_task;

        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let (row, group_master_key, settlement_id) =
            insert_settlement_stats_test_fixture(&setup).await.unwrap();
        let item_id = row.item_id;
        let item_uuid = row.item_uuid;
        setup.commit().await.unwrap();

        let update = env.dbx.begin().await.unwrap();
        let affected_item_id =
            persist_settlement_resolution(&update, row, Some(settlement_id))
                .await
                .unwrap();
        assert!(group_stats_recalculation_task::Entity::find()
            .one(&update)
            .await
            .unwrap()
            .is_none());
        update.commit().await.unwrap();

        enqueue_stats_invalidations(
            &env.dbx,
            BTreeSet::from([affected_item_id]),
            "resolved settlement for inbox message",
        )
        .await;
        let task = group_stats_recalculation_task::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task.group_master_key, group_master_key);

        group_stats_recalculation_task::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let removal = env.dbx.begin().await.unwrap();
        let requires_invalidation = reconcile_item_location_rows(
            &removal, item_id, item_uuid, None, true,
        )
        .await
        .unwrap();
        assert!(requires_invalidation);
        assert!(group_stats_recalculation_task::Entity::find()
            .one(&removal)
            .await
            .unwrap()
            .is_none());
        removal.commit().await.unwrap();
        enqueue_stats_invalidations(
            &env.dbx,
            BTreeSet::from([item_id]),
            "removed settlements from inbox message",
        )
        .await;
        assert!(group_stats_recalculation_task::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconciliation_enqueues_stats_for_cleared_cluster_links_2133() {
        use crate::entities::group_stats_recalculation_task;

        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let (row, group_master_key, settlement_id) =
            insert_settlement_stats_test_fixture(&setup).await.unwrap();
        let item_id = row.item_id;
        let item_uuid = row.item_uuid;
        let mut row = row.into_active_model();
        row.settlement_id = Set(Some(settlement_id));
        row.update(&setup).await.unwrap();
        setup.commit().await.unwrap();

        for location_v2 in [
            None,
            Some("|STATS INVALIDATION|EXTRA|"),
            Some("|STATS INVALIDATION|"),
        ] {
            let txn = env.dbx.begin().await.unwrap();
            reconcile_item_locations(&txn, item_id, item_uuid, location_v2)
                .await
                .unwrap();
            let task = group_stats_recalculation_task::Entity::find()
                .one(&txn)
                .await
                .unwrap();
            if location_v2 == Some("|STATS INVALIDATION|") {
                assert!(task.is_none());
            } else {
                assert_eq!(task.unwrap().group_master_key, group_master_key);
            }
            txn.rollback().await.unwrap();
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconciliation_invalidates_concurrently_resolved_removals_3383() {
        use crate::entities::group_stats_recalculation_task;

        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let (row, group_master_key, settlement_id) =
            insert_settlement_stats_test_fixture(&setup).await.unwrap();
        let item_id = row.item_id;
        let item_uuid = row.item_uuid;
        setup.commit().await.unwrap();
        let resolver = env.dbx.begin().await.unwrap();
        persist_settlement_resolution(&resolver, row, Some(settlement_id))
            .await
            .unwrap();
        let (backend_pid_tx, backend_pid_rx) = tokio::sync::oneshot::channel();
        let reconciliation_env = env.clone();
        let reconciliation = tokio::spawn(async move {
            let transaction = reconciliation_env.dbx.begin().await.unwrap();
            let backend = transaction
                .query_one_raw(Statement::from_string(
                    DatabaseBackend::Postgres,
                    "select pg_backend_pid() as pid",
                ))
                .await
                .unwrap()
                .unwrap();
            let backend_pid: i32 = backend.try_get("", "pid").unwrap();
            backend_pid_tx.send(backend_pid).unwrap();
            reconcile_item_locations(&transaction, item_id, item_uuid, None)
                .await
                .unwrap();
            transaction.commit().await.unwrap();
        });
        wait_for_reconciliation_row_lock(&env, backend_pid_rx.await.unwrap())
            .await;
        resolver.commit().await.unwrap();
        reconciliation.await.unwrap();
        assert!(sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        let task = group_stats_recalculation_task::Entity::find()
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task.group_master_key, group_master_key);
    }

    async fn wait_for_reconciliation_row_lock(env: &Env, backend_pid: i32) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let row = env.dbx
                    .query_one_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "select exists(select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock') as blocked",
                        [backend_pid.into()],
                    ))
                    .await
                    .unwrap()
                    .unwrap();
                let blocked: bool = row.try_get("", "blocked").unwrap();
                if blocked {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("reconciliation must wait for the resolver's row lock");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn settlement_update_commits_when_postcommit_stats_enqueue_fails() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let (row, _, settlement_id) =
            insert_settlement_stats_test_fixture(&setup).await.unwrap();
        let row_id = row.id;
        let item_id = row.item_id;
        setup.commit().await.unwrap();
        let blocker = env.dbx.begin().await.unwrap();
        blocker
            .execute_unprepared(
                "lock table group_stats_recalculation_task in access exclusive mode",
            )
            .await
            .unwrap();

        let update = env.dbx.begin().await.unwrap();
        persist_settlement_resolution(&update, row, Some(settlement_id))
            .await
            .unwrap();
        update.commit().await.unwrap();

        let enqueue = env.dbx.begin().await.unwrap();
        enqueue
            .execute_unprepared("set local lock_timeout = '50ms'")
            .await
            .unwrap();
        assert!(crate::stats::enqueue_group_stats_recalculation_for_message(
            &enqueue,
            item_id,
            "post-commit settlement stats enqueue".to_string(),
        )
        .await
        .is_err());
        enqueue.rollback().await.unwrap();

        let row = sigint_inbox_item_settlement::Entity::find_by_id(row_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.settlement_id, Some(settlement_id));
        blocker.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn worker_releases_update_lock_before_blocked_stats_enqueue_2133() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let setup = env.dbx.begin().await.unwrap();
        let (row, _, _) =
            insert_settlement_stats_test_fixture(&setup).await.unwrap();
        let row_id = row.id;
        insert_active_test_battle_line(&setup).await.unwrap();
        setup.commit().await.unwrap();
        let blocker = env.dbx.begin().await.unwrap();
        blocker
            .execute_unprepared(
                "lock table group_stats_recalculation_task in access exclusive mode",
            )
            .await
            .unwrap();

        let worker_env = env.clone();
        let worker = tokio::spawn(async move {
            let mut cursor = SettlementWorkerCursor::default();
            run_inbox_settlement_worker_once(&worker_env, &mut cursor).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let row =
                    sigint_inbox_item_settlement::Entity::find_by_id(row_id)
                        .one(&env.dbx)
                        .await
                        .unwrap()
                        .unwrap();
                if row.settlement_id.is_some() || row.is_undefined.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("settlement update must commit while stats enqueue is blocked");

        let contender = env.dbx.begin().await.unwrap();
        contender
            .execute_unprepared("set local lock_timeout = '100ms'")
            .await
            .unwrap();
        lock_updates(&contender).await.unwrap();
        contender.rollback().await.unwrap();

        blocker.rollback().await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(2),
            worker
        )
        .await
        .expect("worker must finish after stats lock is released")
        .unwrap()
        .unwrap());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn aggregates_distinct_items_and_excludes_missing_coordinates() {
        use crate::entities::sea_orm_active_enums::SettlementKind;
        use crate::entities::settlement;

        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let settlement_id = 2_287_001;
        let missing_coordinate_id = 2_287_002;
        let second_settlement_id = 2_287_003;
        for (id, name, lon, lat) in [
            (settlement_id, "#2287 MAP", Some(36.0), Some(49.0)),
            (missing_coordinate_id, "#2287 NO COORD", None, None),
            (
                second_settlement_id,
                "#2287 MAP SECOND",
                Some(37.0),
                Some(50.0),
            ),
        ] {
            settlement::ActiveModel {
                id: Set(id),
                kind: Set(SettlementKind::Village),
                name: Set(name.to_string()),
                lon: Set(lon),
                lat: Set(lat),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .unwrap();
        }
        let mut item_ids = vec![];
        let mut item_uuids = vec![];
        for suffix in ["one", "two"] {
            let message = signal_message::ActiveModel {
                body: Set(Some(format!("#2287 map {suffix}"))),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .unwrap();
            let item = sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .unwrap();
            item_ids.push(item.id);
            item_uuids.push(item.id_uuid);
        }
        for (item_index, text, linked_settlement_id) in [
            (0, "MAP", settlement_id),
            (0, "MAP ALIAS", settlement_id),
            (1, "MAP", settlement_id),
            (1, "NO COORD", missing_coordinate_id),
            (0, "MAP SECOND", second_settlement_id),
            (1, "MAP SECOND", second_settlement_id),
        ] {
            let item_id = item_ids[item_index];
            sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
                item_uuid: Set(item_uuids[item_index]),
                created_at: NotSet,
                item_id: Set(item_id),
                settlement_text: Set(text.to_string()),
                settlement_id: Set(Some(linked_settlement_id)),
                is_undefined: Set(None),
            }
            .insert(&txn)
            .await
            .unwrap();
        }

        let rows = crate::rer_importer::inbox::bl::get_inbox_map_settlements_for_items(
            &dbx,
            &[],
        )
        .await
        .unwrap();
        assert!(rows.is_empty());
        let rows = crate::rer_importer::inbox::bl::get_inbox_map_settlements_for_items(
            &txn, &item_ids,
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].settlement_id, settlement_id);
        assert_eq!(rows[0].inbox_item_count, 2);
        assert_eq!(rows[1].settlement_id, second_settlement_id);
        assert_eq!(rows[1].inbox_item_count, 2);

        let filtered_ids = format!(
            "select unnest(array[{}]::bigint[]) as id",
            item_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut expected_ids = item_ids.clone();
        expected_ids.sort_unstable_by(|left, right| right.cmp(left));
        let first_page = crate::rer_importer::inbox::bl::get_inbox_map_settlement_message_ids(
            &txn,
            &filtered_ids,
            settlement_id,
            None,
            1,
        )
        .await
        .unwrap();
        assert_eq!(first_page, expected_ids[..1]);
        let second_page = crate::rer_importer::inbox::bl::get_inbox_map_settlement_message_ids(
            &txn,
            &filtered_ids,
            settlement_id,
            first_page.last().copied(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(second_page, expected_ids[1..]);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pending_claims_skip_items_locked_by_another_worker() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let setup = dbx.begin().await.unwrap();
        let mut message_ids = vec![];
        let mut item_ids = vec![];
        let mut row_ids = vec![];
        for suffix in ["one", "two"] {
            let message = signal_message::ActiveModel {
                body: Set(Some(format!("#2287 worker claim {suffix}"))),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            let item = sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            item_ids.push(item.id);
            let row = sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
                item_uuid: Set(item.id_uuid),
                created_at: NotSet,
                item_id: Set(item.id),
                settlement_text: Set(format!("CLAIM {suffix}")),
                settlement_id: Set(None),
                is_undefined: Set(None),
            }
            .insert(&setup)
            .await
            .unwrap();
            message_ids.push(message.id);
            row_ids.push(row.id);
        }
        setup.commit().await.unwrap();
        let after_id = Some(row_ids[0] - 1);
        let first_worker = dbx.begin().await.unwrap();
        assert!(try_lock_pending_item(&first_worker, item_ids[0])
            .await
            .unwrap());
        let second_worker = dbx.begin().await.unwrap();
        let second = claim_pending_item(&second_worker, after_id)
            .await
            .unwrap()
            .expect("second pending item");
        assert_eq!(second.owner_id, item_ids[1]);
        second_worker.rollback().await.unwrap();
        first_worker.rollback().await.unwrap();

        sigint_inbox_item_settlement::Entity::delete_many()
            .filter(sigint_inbox_item_settlement::Column::Id.is_in(row_ids))
            .exec(&dbx)
            .await
            .unwrap();
        sigint_inbox_item::Entity::delete_many()
            .filter(sigint_inbox_item::Column::Id.is_in(message_ids.clone()))
            .exec(&dbx)
            .await
            .unwrap();
        signal_message::Entity::delete_many()
            .filter(signal_message::Column::Id.is_in(message_ids))
            .exec(&dbx)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn oneoff_item_ids_are_paged_in_datetime_then_id_order() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let setup = dbx.begin().await.unwrap();
        let mut expected = vec![];
        for (suffix, time) in [
            ("later", "04:00:00"),
            ("earlier", "03:00:00"),
            ("same-time", "04:00:00"),
        ] {
            let datetime = crate::inbox::datetime::from_date_time_text(
                Some("2099-01-01"),
                Some(time),
            )
            .unwrap()
            .unwrap();
            let message = signal_message::ActiveModel {
                body: Set(Some(format!("#2287 oneoff order {suffix}"))),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                date: Set(Some("2099-01-01".to_string())),
                time: Set(Some(time.to_string())),
                location_v2: Set(Some("|ORDER|".to_string())),
                parsed_unit_v2: Set(false),
                datetime: Set(Some(datetime)),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            expected.push((datetime, message.id));
        }
        expected.sort();

        let since = expected.first().unwrap().0;
        let till = expected.last().unwrap().0 + Duration::seconds(1);
        let first_page =
            load_oneoff_item_page(&setup, Some(since), Some(till), None, 2)
                .await
                .unwrap();
        assert_eq!(first_page.len(), 2);
        let second_page = load_oneoff_item_page(
            &setup,
            Some(since),
            Some(till),
            first_page.last().copied(),
            2,
        )
        .await
        .unwrap();
        let rows = first_page
            .into_iter()
            .chain(second_page)
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter().map(|(_, id)| *id).collect::<Vec<_>>(),
            expected.iter().map(|(_, id)| *id).collect::<Vec<_>>()
        );

        setup.rollback().await.unwrap();
    }
}
