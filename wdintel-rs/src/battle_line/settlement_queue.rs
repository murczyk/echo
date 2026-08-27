use crate::battle_line::types::BattleLineLocationResult;
use crate::battle_line::{
    active_battle_line_id, ensure_active_battle_line, lock_updates,
    resolve_inbox_item_aors, resolve_location_groups_to_settlements_with_db,
    resolve_locations_to_settlements_with_db,
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
use crate::location::utils::to_location_list;
use crate::types::{info, warn, Env, Mode, ShortContext};
use crate::utils::parse_local_datetime;
use crate::{h, OneoffLinkInboxSettlementsPs};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, LockType, OnConflict};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[derive(Debug, FromQueryResult)]
struct PendingItemClaim {
    item_id: i64,
    first_row_id: i64,
}

#[derive(Debug, FromQueryResult)]
struct PendingItemLock {
    acquired: bool,
}

struct OneoffItemResolutionRequest {
    item_id: i64,
    location_v2: Option<String>,
    settlement_texts: Vec<String>,
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
    location_v2: Option<&str>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let desired = location_texts(location_v2);
    let existing = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .all(dbx)
        .await
        .c(h!())?;
    let obsolete_ids = existing
        .iter()
        .filter(|row| !desired.contains(&row.settlement_text))
        .map(|row| row.id)
        .collect::<Vec<_>>();
    let removes_linked_settlement = existing.iter().any(|row| {
        !desired.contains(&row.settlement_text) && row.settlement_id.is_some()
    });
    if !obsolete_ids.is_empty() {
        sigint_inbox_item_settlement::Entity::delete_many()
            .filter(
                sigint_inbox_item_settlement::Column::Id.is_in(obsolete_ids),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    let existing_texts = existing
        .into_iter()
        .map(|row| row.settlement_text)
        .collect::<BTreeSet<_>>();
    for settlement_text in desired.difference(&existing_texts) {
        sigint_inbox_item_settlement::Entity::insert(
            sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
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
    if removes_linked_settlement {
        crate::stats::enqueue_group_stats_recalculation_for_message(
            dbx,
            item_id,
            format!("removed settlements from inbox message {item_id}"),
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn requeue_item_settlements<C>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<()>
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

pub async fn inbox_settlement_worker_nofail(env: Arc<Env>) {
    let mut cursor = None;
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
    cursor: &mut Option<i64>,
) -> anyhow::Result<bool> {
    if active_battle_line_id(&env.dbx).await.c(h!())?.is_none() {
        *cursor = None;
        return Ok(false);
    }
    let catalog_txn = env.dbx.begin().await.c(h!())?;
    lock_updates(&catalog_txn).await.c(h!())?;
    if !has_pending_rows(&catalog_txn).await.c(h!())? {
        catalog_txn.commit().await.c(h!())?;
        *cursor = None;
        return Ok(false);
    }
    crate::location::aor_config::refresh_settlements_aor_map(
        &catalog_txn,
        env.settlements.clone(),
    )
    .await
    .c(h!())?;
    let processed = process_pending_rows(env, cursor).await.c(h!())?;
    catalog_txn.commit().await.c(h!())?;
    Ok(processed)
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
        if let Err(error) = resolve_claimed_item(env, &txn, claim.item_id).await
        {
            txn.rollback().await.c(h!())?;
            warn!(
                "Inbox settlement resolution error for item {}: {error:#?}",
                claim.item_id
            );
            continue;
        }
        txn.commit().await.c(h!())?;
        processed = true;
    }
    Ok(processed)
}

async fn claim_pending_item<C>(
    dbx: &C,
    after_id: Option<i64>,
) -> anyhow::Result<Option<PendingItemClaim>>
where
    C: ConnectionTrait,
{
    let candidates =
        PendingItemClaim::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with pending_rows as materialized (
    select id, item_id
    from sigint_inbox_item_settlement
    where settlement_id is null
      and is_undefined is null
      and ($1::bigint is null or id > $1)
    order by id
    limit $2
)
select item_id, min(id) as first_row_id
from pending_rows
group by item_id
order by first_row_id
            "#,
            [
                after_id.into(),
                (INBOX_SETTLEMENT_WORKER_CLAIM_CANDIDATE_SIZE as i64).into(),
            ],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    for candidate in candidates {
        if try_lock_pending_item(dbx, candidate.item_id)
            .await
            .c(h!())?
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

async fn try_lock_pending_item<C>(dbx: &C, item_id: i64) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    PendingItemLock::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
select pg_try_advisory_xact_lock(
    hashtextextended($1::text || $2::text, 0)
) as acquired
        "#,
        [
            INBOX_SETTLEMENT_WORKER_ADVISORY_LOCK_NAMESPACE.into(),
            item_id.into(),
        ],
    ))
    .one(dbx)
    .await
    .c(h!())?
    .map(|row| row.acquired)
    .c(h!())
}

async fn resolve_claimed_item(
    env: &Env,
    txn: &DatabaseTransaction,
    item_id: i64,
) -> anyhow::Result<()> {
    let rows = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .lock(LockType::Update)
        .all(txn)
        .await
        .c(h!())?;
    if rows.is_empty() {
        return Ok(());
    }
    let aor_context =
        resolve_inbox_item_aors(txn, item_id, None).await.c(h!())?;
    let locations = rows
        .iter()
        .map(|row| row.settlement_text.clone())
        .collect::<Vec<_>>();
    let results = resolve_locations_to_settlements_with_db(
        txn,
        env.settlements.clone(),
        locations,
        &aor_context.aor_ids,
    )
    .await
    .c(h!())?;
    for (row, result) in rows.into_iter().zip(results) {
        if row.settlement_id.is_some() || row.is_undefined.is_some() {
            continue;
        }
        persist_settlement_resolution(txn, row, result.chosen_settlement_id)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn persist_settlement_resolution<C>(
    dbx: &C,
    row: sigint_inbox_item_settlement::Model,
    settlement_id: Option<i32>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let item_id = row.item_id;
    let matched = settlement_id.is_some();
    let mut row = row.into_active_model();
    row.settlement_id = Set(settlement_id);
    row.is_undefined = Set((!matched).then_some(true));
    row.update(dbx).await.c(h!())?;
    crate::stats::enqueue_group_stats_recalculation_for_message(
        dbx,
        item_id,
        format!("resolved settlement for inbox message {item_id}"),
    )
    .await
    .c(h!())?;
    Ok(())
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
    let txn = env.dbx.begin().await.c(h!())?;
    lock_updates(&txn).await.c(h!())?;
    ensure_active_battle_line(&txn).await.c(h!())?;
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
    process_oneoff_request_groups(env, &txn, request_groups, &mut stats)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(stats)
}

async fn group_oneoff_resolution_requests(
    txn: &DatabaseTransaction,
    items: &[(NaiveDateTime, i64)],
    item_locations: &BTreeMap<i64, Option<String>>,
) -> anyhow::Result<(BTreeMap<Vec<i64>, Vec<OneoffItemResolutionRequest>>, usize)>
{
    let mut request_groups = BTreeMap::new();
    let mut skipped = 0;
    for (_, item_id) in items {
        let location_v2 = item_locations.get(item_id).c(h!())?.clone();
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
                location_v2,
                settlement_texts,
            });
    }
    Ok((request_groups, skipped))
}

async fn process_oneoff_request_groups(
    env: &Env,
    txn: &DatabaseTransaction,
    request_groups: BTreeMap<Vec<i64>, Vec<OneoffItemResolutionRequest>>,
    stats: &mut OneoffLinkInboxSettlementsStats,
) -> anyhow::Result<()> {
    for (aor_ids, requests) in request_groups {
        let location_groups = requests
            .iter()
            .map(|request| request.settlement_texts.clone())
            .collect();
        let resolution_groups = resolve_location_groups_to_settlements_with_db(
            txn,
            env.settlements.clone(),
            location_groups,
            &aor_ids,
        )
        .await
        .c(h!())?;
        for (request, resolutions) in
            requests.into_iter().zip(resolution_groups)
        {
            process_oneoff_item_in_transaction(
                txn,
                request,
                resolutions,
                stats,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn lock_oneoff_item_locations(
    txn: &DatabaseTransaction,
    items: &[(NaiveDateTime, i64)],
) -> anyhow::Result<BTreeMap<i64, Option<String>>> {
    sigint_inbox_item::Entity::find()
        .filter(
            sigint_inbox_item::Column::Id
                .is_in(items.iter().map(|(_, item_id)| *item_id)),
        )
        .lock(LockType::Update)
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::LocationV2,
        ])
        .into_tuple::<(i64, Option<String>)>()
        .all(txn)
        .await
        .c(h!())
        .map(|rows| rows.into_iter().collect())
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
) -> anyhow::Result<()> {
    reconcile_item_locations(
        txn,
        request.item_id,
        request.location_v2.as_deref(),
    )
    .await
    .c(h!())?;
    sigint_inbox_item_settlement::Entity::update_many()
        .col_expr(
            sigint_inbox_item_settlement::Column::SettlementId,
            Expr::value(Option::<i32>::None),
        )
        .col_expr(
            sigint_inbox_item_settlement::Column::IsUndefined,
            Expr::value(Option::<bool>::None),
        )
        .filter(
            sigint_inbox_item_settlement::Column::ItemId.eq(request.item_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
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
                Expr::value((!matched).then_some(true)),
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
    crate::stats::enqueue_group_stats_recalculation_for_message(
        txn,
        request.item_id,
        format!("linked settlements for inbox message {}", request.item_id),
    )
    .await
    .c(h!())?;
    stats.processed += 1;
    Ok(())
}

async fn load_oneoff_item_page(
    dbx: &DatabaseConnection,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    cursor: Option<(NaiveDateTime, i64)>,
    limit: u64,
) -> anyhow::Result<Vec<(NaiveDateTime, i64)>> {
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
    ) -> anyhow::Result<i64> {
        let message = signal_message::ActiveModel {
            body: Set(Some("#2287 settlement relinking".to_string())),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            location_v2: Set(Some(format!("|{settlement_text}|"))),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message.id),
            settlement_text: Set(settlement_text.to_string()),
            settlement_id: Set(Some(settlement_id)),
            is_undefined: Set(None),
            ..Default::default()
        }
        .insert(txn)
        .await
        .c(h!())?;
        Ok(message.id)
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

    #[tokio::test]
    #[serial_test::serial]
    async fn reconciles_removed_new_and_unchanged_location_texts() {
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
        let item_id = sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap()
        .id;

        reconcile_item_locations(&txn, item_id, Some("|A|B|A|"))
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

        reconcile_item_locations(&txn, item_id, Some("|A|C|"))
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
        assert_eq!(rows[0].is_undefined, Some(true));
        assert_eq!(rows[1].settlement_text, "C");
        assert_eq!(rows[1].settlement_id, None);
        assert_eq!(rows[1].is_undefined, None);

        reconcile_item_locations(&txn, item_id, None).await.unwrap();
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
    async fn oneoff_relinks_existing_settlement_2287() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let txn = dbx.begin().await.unwrap();
        let old_settlement_id = 2_287_214;
        let new_settlement_id = 2_287_215;
        for (id, name) in [
            (old_settlement_id, "#2287 OLD MATCH"),
            (new_settlement_id, "#2287 NEW MATCH"),
        ] {
            insert_relink_test_settlement(&txn, id, name).await.unwrap();
        }
        let item_id = insert_oneoff_relink_test_item(
            &txn,
            "AMBIGUOUS",
            old_settlement_id,
        )
        .await
        .unwrap();
        let request = OneoffItemResolutionRequest {
            item_id,
            location_v2: Some("|AMBIGUOUS|".to_string()),
            settlement_texts: vec!["AMBIGUOUS".to_string()],
        };
        let resolutions = vec![BattleLineLocationResult {
            location: "AMBIGUOUS".to_string(),
            candidates: vec![],
            chosen_settlement_id: Some(new_settlement_id),
            distance_m: Some(1.0),
            invalid_aor_ids: vec![],
        }];
        let mut stats = OneoffLinkInboxSettlementsStats::default();

        process_oneoff_item_in_transaction(
            &txn,
            request,
            resolutions,
            &mut stats,
        )
        .await
        .unwrap();

        let row = sigint_inbox_item_settlement::Entity::find()
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.settlement_id, Some(new_settlement_id));
        assert_eq!(row.is_undefined, None);
        assert_eq!(
            stats,
            OneoffLinkInboxSettlementsStats {
                processed: 1,
                matched: 1,
                ..Default::default()
            }
        );
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn settlement_resolution_enqueues_stats_recalculation() {
        use crate::entities::sea_orm_active_enums::SettlementKind;
        use crate::entities::{
            group_stats_recalculation_task, settlement, signal_group,
            signal_message_group,
        };

        let env = crate::functest::tests::cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let message_ts = Utc::now().naive_utc() - Duration::days(1);
        let group_master_key = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .select_only()
            .column(signal_group::Column::MasterKey)
            .into_tuple::<String>()
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let message = signal_message::ActiveModel {
            body: Set(Some("#2287 settlement stats invalidation".to_string())),
            created_at: Set(message_ts),
            timestamp: Set(Some(message_ts)),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            parsed_unit_v2: Set(false),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group_master_key.clone())),
            created_at: Set(message_ts),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let settlement_id = 2_287_004;
        settlement::ActiveModel {
            id: Set(settlement_id),
            kind: Set(SettlementKind::Village),
            name: Set("#2287 STATS INVALIDATION".to_string()),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let row = sigint_inbox_item_settlement::ActiveModel {
            item_id: Set(message.id),
            settlement_text: Set("STATS INVALIDATION".to_string()),
            settlement_id: Set(None),
            is_undefined: Set(None),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();

        persist_settlement_resolution(&txn, row, Some(settlement_id))
            .await
            .unwrap();

        let task = group_stats_recalculation_task::Entity::find()
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task.group_master_key, group_master_key);

        group_stats_recalculation_task::Entity::delete_many()
            .exec(&txn)
            .await
            .unwrap();
        reconcile_item_locations(&txn, message.id, None)
            .await
            .unwrap();
        assert!(group_stats_recalculation_task::Entity::find()
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        txn.rollback().await.unwrap();
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
        }
        for (item_id, text, linked_settlement_id) in [
            (item_ids[0], "MAP", settlement_id),
            (item_ids[0], "MAP ALIAS", settlement_id),
            (item_ids[1], "MAP", settlement_id),
            (item_ids[1], "NO COORD", missing_coordinate_id),
            (item_ids[0], "MAP SECOND", second_settlement_id),
            (item_ids[1], "MAP SECOND", second_settlement_id),
        ] {
            sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
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
                id: Set(i64::MIN + item.id),
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
        let raw_key_holder = dbx.begin().await.unwrap();
        raw_key_holder
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select pg_advisory_xact_lock($1)",
                [item_ids[0].into()],
            ))
            .await
            .unwrap();

        let first_worker = dbx.begin().await.unwrap();
        let first = claim_pending_item(&first_worker, after_id)
            .await
            .unwrap()
            .expect("first pending item");
        assert_eq!(first.item_id, item_ids[0]);
        let lock_probe = dbx.begin().await.unwrap();
        assert!(!try_lock_pending_item(&lock_probe, first.item_id)
            .await
            .unwrap());
        assert!(try_lock_pending_item(&lock_probe, item_ids[1])
            .await
            .unwrap());
        lock_probe.rollback().await.unwrap();
        let second_worker = dbx.begin().await.unwrap();
        let second = claim_pending_item(&second_worker, after_id)
            .await
            .unwrap()
            .expect("second pending item");
        assert_ne!(first.item_id, second.item_id);
        assert_eq!(
            BTreeSet::from([first.item_id, second.item_id]),
            item_ids.iter().copied().collect()
        );
        second_worker.rollback().await.unwrap();
        first_worker.rollback().await.unwrap();
        raw_key_holder.rollback().await.unwrap();

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
        setup.commit().await.unwrap();
        expected.sort();

        let since = expected.first().unwrap().0;
        let till = expected.last().unwrap().0 + Duration::seconds(1);
        let first_page =
            load_oneoff_item_page(&dbx, Some(since), Some(till), None, 2)
                .await
                .unwrap();
        assert_eq!(first_page.len(), 2);
        let second_page = load_oneoff_item_page(
            &dbx,
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

        sigint_inbox_item::Entity::delete_many()
            .filter(
                sigint_inbox_item::Column::Id
                    .is_in(expected.iter().map(|(_, id)| *id)),
            )
            .exec(&dbx)
            .await
            .unwrap();
        signal_message::Entity::delete_many()
            .filter(
                signal_message::Column::Id
                    .is_in(expected.into_iter().map(|(_, id)| id)),
            )
            .exec(&dbx)
            .await
            .unwrap();
    }
}
