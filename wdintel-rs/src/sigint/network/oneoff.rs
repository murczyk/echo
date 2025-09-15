use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::sigint::network::bl::*;
use crate::sigint::network::merge::*;
use crate::types::*;
use chrono::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

use log::*;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};

const MERGE_NETWORKS_API_LOGIN: &str = "merge_networks_api";

pub async fn oneoff_merge_all_possible_networks(
    mode: crate::types::Mode,
) -> anyhow::Result<(), AppError> {
    info!("> merge_all_possible_networks start");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;

    // Fetch all active networks (deleted = false) with their unit_id
    let networks_list = sigint_network::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .columns([sigint_network::Column::Id, sigint_network::Column::Name])
        .column(sigint_network_unit::Column::UnitId)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_network::Column::Id)
        .into_tuple::<(i64, String, i64)>()
        .all(&txn)
        .await
        .context(h!())?;

    // Group networks by (name, unit_id)
    let mut grouped_networks: HashMap<(String, i64), Vec<i64>> =
        std::collections::HashMap::new();
    for (id, name, unit_id) in networks_list {
        grouped_networks
            .entry((name, unit_id))
            .or_default()
            .push(id);
    }

    // Keep track of merged networks to avoid duplicate merges
    let mut merged = HashSet::new();

    println!("Starting network merging process...");
    for ((name, unit_id), network_ids) in grouped_networks {
        let mut iter = network_ids.into_iter();
        if let Some(primary_id) = iter.next() {
            for secondary_id in iter {
                if !merged.contains(&secondary_id) {
                    println!(
                        "Merging network {secondary_id} into network {primary_id} (Name: '{name}', Unit ID: {unit_id})"
                    );

                    // Merge networks
                    if let Err(e) = merge_two_networks(
                        &txn,
                        MERGE_NETWORKS_API_LOGIN,
                        true,
                        secondary_id,
                        primary_id,
                    )
                    .await
                    {
                        eprintln!(
                            "❌ Failed to merge network {secondary_id} into {primary_id}: {e}"
                        );
                    }

                    println!(
                        "✅ Successfully merged network {secondary_id} into {primary_id}"
                    );

                    // Mark secondary_id as merged
                    merged.insert(secondary_id);
                }
            }
        }
    }

    println!("Network merging process completed.");
    txn.commit().await.context(h!())?;
    Ok(())
}

pub async fn oneoff_merge_two_networks(
    mode: crate::types::Mode,
    ps: &crate::OneoffMergeNetworksPs,
) -> anyhow::Result<(), AppError> {
    debug!("oneoff_merge_networks");

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;
    let config = crate::config::read_config(mode).context(h!())?;
    let mut redis = crate::new_redis(&config).await.context(h!())?;

    match merge_two_networks(
        &txn,
        MERGE_NETWORKS_API_LOGIN,
        true,
        ps.network_id_from,
        ps.network_id_to,
    )
    .await
    {
        Ok(_) => {
            txn.commit().await.context(h!())?;

            let event = EventMsg::new(EventType::ETNetworkChanged);
            fanout(&mut redis, event).await.context(h!())?;

            info!(
                "✅ Merge successful! Merged network {} into {}",
                ps.network_id_from, ps.network_id_to
            );
        }
        Err(e) => {
            txn.rollback().await.context(h!())?;
            error!("❌ Merge failed: {e:?}");
        }
    }

    debug!("oneoff_merge_networks completed");
    Ok(())
}

pub async fn oneoff_network_activity_stat(
    mode: crate::types::Mode,
    ps: &crate::OneoffGetNetworksActivityStatsPs,
) -> anyhow::Result<(), AppError> {
    debug!("oneoff_network_activity_stat");
    let start_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.start, "%Y-%m-%dT%H:%M:%S")?;
    let end_dt: NaiveDateTime =
        NaiveDateTime::parse_from_str(&ps.end, "%Y-%m-%dT%H:%M:%S")?;

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let groups = crate::users::get_identity_sigint_groups(&dbx, &ps.login)
        .await
        .context(h!())?;

    let freqs_count =
        bl_get_network_active_freqs_count(&dbx, &groups, start_dt, end_dt)
            .await
            .context(h!())?;

    let callsigns_count =
        bl_get_network_active_callsigns_count(&dbx, &groups, start_dt, end_dt)
            .await
            .context(h!())?;

    println!(
        "Інтенсивність роботи радіомереж за період з {start_dt} по {end_dt}"
    );
    println!("-----------------------------------------");
    println!("К-сть виявлених частот:   {freqs_count}");
    println!("К-сть виявлених позивних: {callsigns_count}");

    debug!("oneoff_merge_networks completed");
    Ok(())
}
