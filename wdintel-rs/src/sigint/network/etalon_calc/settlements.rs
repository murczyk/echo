use crate::config::SIGINT_NETWORK_SETTLEMENT_MATCH_DISTANCE_METERS;
use crate::entities::{
    settlement, sigint_inbox_item, sigint_network_settlement,
};
use crate::h;
use crate::location::utils::to_location_list;
use crate::settlement::{
    coordinate_distance_m, normalize_name, SettlementRecord,
};
use crate::types::ShortContext;
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};

type NetworkAnchors = BTreeMap<i64, Vec<(f64, f64)>>;

#[derive(FromQueryResult)]
struct NetworkLocation {
    network_id: i64,
    lat: Option<f64>,
    lon: Option<f64>,
}

pub(super) async fn narrow_by_settlements<C: ConnectionTrait>(
    dbx: &C,
    matched: &mut HashMap<i64, Vec<i64>>,
) -> anyhow::Result<()> {
    let item_ids = matched
        .iter()
        .filter(|(_, networks)| networks.len() > 1)
        .map(|(&item_id, _)| item_id)
        .collect::<Vec<_>>();
    if item_ids.is_empty() {
        return Ok(());
    }
    let names_by_item = load_location_names(dbx, item_ids).await.c(h!())?;
    let names = names_by_item
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(());
    }
    let candidates = crate::settlement::find_by_names(dbx, &names)
        .await
        .c(h!())?;
    let candidates = names
        .into_iter()
        .zip(candidates)
        .collect::<BTreeMap<_, _>>();
    let network_ids = names_by_item
        .keys()
        .flat_map(|id| &matched[id])
        .copied()
        .collect();
    let anchors = load_network_anchors(dbx, network_ids).await.c(h!())?;
    for (item_id, names) in names_by_item {
        let locations = names
            .iter()
            .map(|name| candidates[name].as_slice())
            .collect::<Vec<_>>();
        if let Some(network_id) =
            unique_network(&matched[&item_id], &locations, &anchors)
        {
            matched.insert(item_id, vec![network_id]);
        }
    }
    Ok(())
}

async fn load_location_names<C: ConnectionTrait>(
    dbx: &C,
    item_ids: Vec<i64>,
) -> anyhow::Result<BTreeMap<i64, BTreeSet<String>>> {
    let locations = sigint_inbox_item::Entity::find()
        .select_only()
        .columns([
            sigint_inbox_item::Column::Id,
            sigint_inbox_item::Column::LocationV2,
        ])
        .filter(sigint_inbox_item::Column::Id.is_in(item_ids))
        .into_tuple::<(i64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(locations
        .into_iter()
        .map(|(id, locations)| {
            let names =
                to_location_list(locations.as_deref().unwrap_or_default())
                    .into_iter()
                    .map(|name| normalize_name(&name))
                    .collect();
            (id, names)
        })
        .collect())
}

async fn load_network_anchors<C: ConnectionTrait>(
    dbx: &C,
    network_ids: BTreeSet<i64>,
) -> anyhow::Result<NetworkAnchors> {
    let rows = sigint_network_settlement::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_settlement::Relation::Settlement.def(),
        )
        .select_only()
        .column(sigint_network_settlement::Column::NetworkId)
        .columns([settlement::Column::Lat, settlement::Column::Lon])
        .filter(sigint_network_settlement::Column::NetworkId.is_in(network_ids))
        .into_model::<NetworkLocation>()
        .all(dbx)
        .await
        .c(h!())?;
    let mut anchors: NetworkAnchors = BTreeMap::new();
    for row in rows {
        if let Some((lat, lon)) = row
            .lat
            .zip(row.lon)
            .filter(|&(lat, lon)| valid_coordinate(lat, lon))
        {
            anchors.entry(row.network_id).or_default().push((lat, lon));
        }
    }
    Ok(anchors)
}

fn unique_network(
    networks: &[i64],
    locations: &[&[SettlementRecord]],
    anchors: &NetworkAnchors,
) -> Option<i64> {
    if locations.is_empty() {
        return None;
    }
    let matches = networks
        .iter()
        .copied()
        .filter(|id| {
            anchors.get(id).is_some_and(|anchors| {
                locations.iter().all(|candidates| {
                    candidates
                        .iter()
                        .any(|candidate| close_to_anchors(candidate, anchors))
                })
            })
        })
        .collect::<BTreeSet<_>>();
    (matches.len() == 1).then(|| *matches.first().unwrap())
}

fn close_to_anchors(
    candidate: &SettlementRecord,
    anchors: &[(f64, f64)],
) -> bool {
    let Some((lat, lon)) = candidate
        .lat
        .zip(candidate.lon)
        .filter(|&(lat, lon)| valid_coordinate(lat, lon))
    else {
        return false;
    };
    anchors.iter().any(|&(latitude, longitude)| {
        coordinate_distance_m(lat, lon, latitude, longitude)
            <= SIGINT_NETWORK_SETTLEMENT_MATCH_DISTANCE_METERS
    })
}

fn valid_coordinate(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

#[cfg(test)]
mod tests;
