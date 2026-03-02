use crate::entities::*;
use crate::sigint::network::etalon_calc::consistency::InboxItem;
use crate::types::*;
use crate::{config, h};
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::*;

mod consistency;
pub mod oneoff;
pub mod tui;
pub mod worker;

pub async fn invalidate_network_inbox_for_group_with_key<'a, 'async_trait, C>(
    db: &'a C,
    master_key: &str,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let group = signal_group::Entity::find_by_id(master_key.to_string())
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    invalidate_network_inbox_for_group(db, &group, context_msg).await
}

pub async fn invalidate_network_inbox_for_group<'a, 'async_trait, C>(
    db: &'a C,
    group: &signal_group::Model,
    context_msg: String,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(group.created_at),
        till_ts: Set(Utc::now().naive_utc()),
        group_master_key: Set(Some(group.master_key.clone())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: NotSet,
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn invalidate_network_inbox_for_aor(
    db: &DatabaseConnection,
    aor: &area_of_responsibility::Model,
    context_msg: String,
) -> anyhow::Result<()> {
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(aor.created_at),
        till_ts: Set(Utc::now().naive_utc()),
        group_master_key: NotSet,
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: Set(Some(aor.id)),
        sigint_network_id: NotSet,
        tag: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn invalidate_network_inbox_for_freq(
    freq: &str,
    since_ts: Option<NaiveDateTime>,
    till_ts: Option<NaiveDateTime>,
    db: &DatabaseConnection,
    context_msg: String,
) -> anyhow::Result<()> {
    info!("network invalidation task created, reason: {}", context_msg);
    network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: Set(Some(freq.to_string())),
        since_ts: Set(since_ts.unwrap_or(
            Utc::now().naive_utc()
                - Duration::days(config::GROUP_STATS_DAY_TTL_DAYS),
        )),
        till_ts: Set(till_ts.unwrap_or(Utc::now().naive_utc())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: NotSet,
        tag: NotSet,
        group_master_key: NotSet,
    }
    .insert(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn invalidate_network_inbox(
    network: sigint_network::Model,
    frequencies: Vec<String>,
    db: &DatabaseConnection,
    context_msg: String,
) -> anyhow::Result<()> {
    let frequencies_desc = if frequencies.is_empty() {
        "all".to_string()
    } else {
        frequencies.join(" ,")
    };
    info!("network invalidation task created for network #{}, frequencies: {frequencies_desc}; reason: {context_msg}", network.id);
    let backfill_task = network_invalidation_task::ActiveModel {
        id: NotSet,
        frequency: NotSet,
        since_ts: Set(network
            .active_from
            .unwrap_or(Utc::now().naive_utc() - Duration::days(365))),
        till_ts: Set(network.active_to.unwrap_or(Utc::now().naive_utc())),
        started_at: NotSet,
        completed_at: NotSet,
        created_at: NotSet,
        aor_id: NotSet,
        sigint_network_id: Set(Some(network.id)),
        group_master_key: NotSet,
        tag: NotSet,
    };
    backfill_task.clone().insert(db).await.c(h!())?;
    let mut sigint_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network.id))
        .all(db)
        .await
        .c(h!())?;
    if !frequencies.is_empty() {
        sigint_freqs.retain(|f| frequencies.contains(&f.freq))
    }
    for freq in sigint_freqs {
        let mut backfill_task = backfill_task.clone();
        backfill_task.since_ts = Set(freq.active_from);
        backfill_task.till_ts =
            Set(freq.active_to.unwrap_or(Utc::now().naive_utc()));
        backfill_task.frequency = Set(Some(freq.freq));
        backfill_task.insert(db).await.c(h!())?;
    }

    Ok(())
}
pub async fn calculate_sigint_inbox_item_networks<'a, 'async_trait, C>(
    sigint_inbox_items: Vec<sigint_inbox_item::Model>,
    dbx: &'a C,
) -> anyhow::Result<HashMap<i64, Vec<i64>>>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
    let sigint_inbox_item_ids =
        sigint_inbox_items.iter().map(|i| i.id).collect::<Vec<_>>();
    sigint_inbox_item_network::Entity::delete_many()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .is_in(sigint_inbox_item_ids),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    let items_to_process = sigint_inbox_items
        .into_iter()
        .map(|i| InboxItem {
            id: i.id,
            timestamp: i.datetime,
            freq: i.freq,
            unit: i.unit_v2,
        })
        .collect::<Vec<_>>();
    let network_ids_per_item =
        consistency::load_networks_for_inbox_items(dbx, &items_to_process)
            .await
            .c(h!())?;
    let mut models_to_insert = Vec::new();
    for (item_id, network_ids) in network_ids_per_item {
        for network_id in network_ids {
            let active_model = sigint_inbox_item_network::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(item_id),
                sigint_network_id: Set(network_id),
                created_at: NotSet,
            };
            models_to_insert.push(active_model);
            result.entry(item_id).or_default().push(network_id);
        }
    }
    sigint_inbox_item_network::Entity::insert_many(models_to_insert)
        .exec_without_returning(dbx)
        .await
        .c(h!())?;
    Ok(result)
}
