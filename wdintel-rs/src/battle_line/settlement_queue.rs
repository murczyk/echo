use crate::battle_line::{
    active_battle_line_id, ensure_active_battle_line, lock_updates,
    resolve_inbox_item_aors, resolve_location_to_settlement,
    resolve_location_to_settlement_with_db,
};
use crate::config::{
    get_tz, INBOX_SETTLEMENT_ONEOFF_PAGE_SIZE,
    INBOX_SETTLEMENT_WORKER_BATCH_SIZE, INBOX_SETTLEMENT_WORKER_SLEEP_SECS,
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
use sea_orm::sea_query::{Expr, LockBehavior, LockType, OnConflict};
use sea_orm::*;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct OneoffLinkInboxSettlementsStats {
    pub processed: usize,
    pub skipped: usize,
    pub matched: usize,
    pub unmatched: usize,
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
    loop {
        let _loop_guard =
            crate::utils::worker_watch::loop_guard("inbox_settlement_worker");
        match run_inbox_settlement_worker_once(&env).await {
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
) -> anyhow::Result<bool> {
    if active_battle_line_id(&env.dbx).await.c(h!())?.is_none() {
        return Ok(false);
    }
    let mut processed = false;
    let mut cursor = None;
    for _ in 0..INBOX_SETTLEMENT_WORKER_BATCH_SIZE {
        let txn = env.dbx.begin().await.c(h!())?;
        let row = claim_pending_row(&txn, cursor).await.c(h!())?;
        let Some(row) = row else {
            txn.rollback().await.c(h!())?;
            break;
        };
        cursor = Some(row.id);
        let row_id = row.id;
        if let Err(error) = resolve_claimed_row(env, &txn, row).await {
            txn.rollback().await.c(h!())?;
            warn!(
                "Inbox settlement resolution error for row {row_id}: {error:#?}"
            );
            continue;
        }
        txn.commit().await.c(h!())?;
        processed = true;
    }
    Ok(processed)
}

async fn claim_pending_row<C>(
    dbx: &C,
    after_id: Option<i64>,
) -> anyhow::Result<Option<sigint_inbox_item_settlement::Model>>
where
    C: ConnectionTrait,
{
    let mut query = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::SettlementId.is_null())
        .filter(sigint_inbox_item_settlement::Column::IsUndefined.is_null())
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .limit(1);
    if let Some(after_id) = after_id {
        query =
            query.filter(sigint_inbox_item_settlement::Column::Id.gt(after_id));
    }
    query
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(dbx)
        .await
        .c(h!())
}

async fn resolve_claimed_row(
    env: &Env,
    txn: &DatabaseTransaction,
    row: sigint_inbox_item_settlement::Model,
) -> anyhow::Result<()> {
    let aor_context = resolve_inbox_item_aors(&env.dbx, row.item_id, None)
        .await
        .c(h!())?;
    let result = resolve_location_to_settlement(
        env,
        row.settlement_text.clone(),
        &aor_context.aor_ids,
    )
    .await
    .c(h!())?;
    let mut row = row.into_active_model();
    match result.chosen_settlement_id {
        Some(settlement_id) => {
            row.settlement_id = Set(Some(settlement_id));
            row.is_undefined = Set(None);
        }
        None => {
            row.settlement_id = Set(None);
            row.is_undefined = Set(Some(true));
        }
    }
    row.update(txn).await.c(h!())?;
    Ok(())
}

pub async fn oneoff_link_inbox_settlements(
    mode: Mode,
    ps: &OneoffLinkInboxSettlementsPs,
) -> Result<(), AppError> {
    info!("Starting inbox settlement linking one-off");
    let env = crate::server::new_env(mode).await.c(h!())?;
    let (since_ts, till_ts) = oneoff_bounds(ps).c(h!())?;
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
        for (_, item_id) in &items {
            process_oneoff_item(&env, *item_id, &mut stats)
                .await
                .c(h!())?;
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

async fn process_oneoff_item(
    env: &Env,
    item_id: i64,
    stats: &mut OneoffLinkInboxSettlementsStats,
) -> anyhow::Result<()> {
    let txn = env.dbx.begin().await.c(h!())?;
    lock_updates(&txn).await.c(h!())?;
    ensure_active_battle_line(&txn).await.c(h!())?;
    let location_v2 = sigint_inbox_item::Entity::find_by_id(item_id)
        .lock(LockType::Update)
        .one(&txn)
        .await
        .c(h!())?
        .c(h!())?
        .location_v2;
    let settlement_texts = location_texts(location_v2.as_deref());
    if settlement_texts.is_empty() {
        txn.rollback().await.c(h!())?;
        stats.skipped += 1;
        return Ok(());
    }
    let aor_context =
        resolve_inbox_item_aors(&txn, item_id, None).await.c(h!())?;
    let mut resolutions = vec![];
    for settlement_text in settlement_texts {
        let result = resolve_location_to_settlement_with_db(
            &txn,
            env,
            settlement_text.clone(),
            &aor_context.aor_ids,
        )
        .await
        .c(h!())?;
        resolutions.push((settlement_text, result.chosen_settlement_id));
    }
    reconcile_item_locations(&txn, item_id, location_v2.as_deref())
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
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
        .exec(&txn)
        .await
        .c(h!())?;
    for (settlement_text, settlement_id) in resolutions {
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
            .filter(sigint_inbox_item_settlement::Column::ItemId.eq(item_id))
            .filter(
                sigint_inbox_item_settlement::Column::SettlementText
                    .eq(settlement_text),
            )
            .exec(&txn)
            .await
            .c(h!())?;
        if matched {
            stats.matched += 1;
        } else {
            stats.unmatched += 1;
        }
    }
    txn.commit().await.c(h!())?;
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
    let mut query = sigint_inbox_item::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SignalMessage.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.is_not_null())
        .order_by_asc(sigint_inbox_item::Column::Datetime)
        .order_by_asc(sigint_inbox_item::Column::Id);
    if let Some(since_ts) = since_ts {
        query = query.filter(sigint_inbox_item::Column::Datetime.gte(since_ts));
    }
    if let Some(till_ts) = till_ts {
        query = query.filter(sigint_inbox_item::Column::Datetime.lt(till_ts));
    }
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
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pending_claims_skip_rows_locked_by_another_worker() {
        let config =
            crate::config::read_config(crate::types::Mode::Test).unwrap();
        let dbx = crate::new_pg_pool_from_config(&config).await.unwrap();
        let setup = dbx.begin().await.unwrap();
        let mut message_ids = vec![];
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
            let row = sigint_inbox_item_settlement::ActiveModel {
                id: NotSet,
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

        let first_worker = dbx.begin().await.unwrap();
        let first = claim_pending_row(&first_worker, None)
            .await
            .unwrap()
            .expect("first pending row");
        let second_worker = dbx.begin().await.unwrap();
        let second = claim_pending_row(&second_worker, None)
            .await
            .unwrap()
            .expect("second pending row");
        assert_ne!(first.id, second.id);
        assert_eq!(
            BTreeSet::from([first.id, second.id]),
            row_ids.iter().copied().collect()
        );
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
            let message = signal_message::ActiveModel {
                body: Set(Some(format!("#2287 oneoff order {suffix}"))),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            let item = sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                date: Set(Some("2099-01-01".to_string())),
                time: Set(Some(time.to_string())),
                location_v2: Set(Some("|ORDER|".to_string())),
                parsed_unit_v2: Set(false),
                ..Default::default()
            }
            .insert(&setup)
            .await
            .unwrap();
            expected.push((item.datetime.unwrap(), message.id));
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
