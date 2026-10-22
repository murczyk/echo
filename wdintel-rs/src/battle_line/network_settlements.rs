use super::settlement_clusters::SettlementAnchor;
use super::settlement_queue::{
    claim_pending_set, refresh_settlement_catalog, resolve_settlement_names,
    SettlementQueue, SettlementResolutionCache,
};
use super::types::BattleLineCoordinate;
use crate::config::INBOX_SETTLEMENT_WORKER_BATCH_SIZE;
use crate::entities::{
    area_of_responsibility, sigint_network, sigint_network_aor,
    sigint_network_settlement,
};
use crate::h;
use crate::types::{warn, Env, ShortContext};
use sea_orm::sea_query::LockType;
use sea_orm::*;
use std::sync::{Arc, RwLock};

pub(super) async fn process_pending_networks(
    env: &Env,
    cursor: &mut Option<i64>,
) -> anyhow::Result<bool> {
    if sigint_network_settlement::Entity::find()
        .filter(sigint_network_settlement::Column::SettlementId.is_null())
        .filter(sigint_network_settlement::Column::IsUndefined.is_null())
        .one(&env.dbx)
        .await
        .c(h!())?
        .is_none()
    {
        *cursor = None;
        return Ok(false);
    }
    let version = refresh_settlement_catalog(env).await.c(h!())?;
    let mut processed = false;
    for _ in 0..INBOX_SETTLEMENT_WORKER_BATCH_SIZE {
        let txn = env.dbx.begin().await.c(h!())?;
        let Some(claim) =
            claim_pending_set(&txn, *cursor, SettlementQueue::Network)
                .await
                .c(h!())?
        else {
            txn.rollback().await.c(h!())?;
            *cursor = None;
            break;
        };
        *cursor = Some(claim.first_row_id);
        match resolve_claimed_network(env, &txn, claim.owner_id, version).await
        {
            Ok(()) => {
                txn.commit().await.c(h!())?;
                processed = true;
            }
            Err(error) => {
                txn.rollback().await.c(h!())?;
                warn!(
                    "Network settlement resolution error for {}: {error:#?}",
                    claim.owner_id
                );
            }
        }
    }
    Ok(processed)
}

pub(super) async fn resolve_claimed_network(
    env: &Env,
    txn: &DatabaseTransaction,
    network_id: i64,
    version: i64,
) -> anyhow::Result<()> {
    let Some(network) = sigint_network::Entity::find_by_id(network_id)
        .lock(LockType::Update)
        .one(txn)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    let rows = sigint_network_settlement::Entity::find()
        .filter(sigint_network_settlement::Column::NetworkId.eq(network_id))
        .order_by_asc(sigint_network_settlement::Column::Id)
        .lock(LockType::Update)
        .all(txn)
        .await
        .c(h!())?;
    if !rows
        .iter()
        .any(|row| row.settlement_id.is_none() && row.is_undefined.is_none())
    {
        return Ok(());
    }
    let aor_ids = sigint_network_aor::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    let names = rows.iter().map(|row| row.settlement_text.clone()).collect();
    let results = if network.deleted {
        vec![]
    } else {
        let settlements = env
            .settlements
            .read()
            .map_err(|error| anyhow::anyhow!("{error:?}"))
            .c(h!())?
            .clone();
        let settlements = Arc::new(RwLock::new(settlements));
        crate::location::aor_config::refresh_settlements_aor_map(
            txn,
            settlements.clone(),
        )
        .await
        .c(h!())?;
        resolve_settlement_names(
            txn,
            settlements,
            names,
            &aor_ids,
            version,
            &mut SettlementResolutionCache::default(),
            &[],
        )
        .await
        .c(h!())?
    };
    for (index, row) in rows.into_iter().enumerate() {
        let settlement_id = results
            .get(index)
            .and_then(|result| result.chosen_settlement_id);
        let mut row = row.into_active_model();
        row.settlement_id = Set(settlement_id);
        row.is_undefined = Set(Some(settlement_id.is_none()));
        row.update(txn).await.c(h!())?;
    }
    crate::sigint::network::etalon_calc::invalidate_network_settlement_inbox(
        network, txn,
    )
    .await
    .c(h!())?;
    Ok(())
}

#[derive(FromQueryResult)]
struct NetworkAnchorRow {
    id: i32,
    lat: Option<f64>,
    lon: Option<f64>,
}

pub(super) async fn load_item_network_anchors<C: ConnectionTrait>(
    dbx: &C,
    item_id: i64,
) -> anyhow::Result<Vec<SettlementAnchor>> {
    let rows =
        NetworkAnchorRow::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select distinct s.id, s.lat, s.lon
from sigint_inbox_item_network links
join sigint_network n on n.id = links.sigint_network_id and not n.deleted
join sigint_network_settlement ns on ns.network_id = n.id
join settlement s on s.id = ns.settlement_id
where links.sigint_inbox_item_id = $1
    and s.lat between -90 and 90 and s.lon between -180 and 180
order by s.id
        "#,
            [item_id.into()],
        ))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(SettlementAnchor {
                settlement_id: row.id,
                coordinate: BattleLineCoordinate {
                    lat: row.lat?,
                    lon: row.lon?,
                },
            })
        })
        .collect())
}
