use super::{load_callsign_priority_unit_ids, types::FreqCallsignSummary};
use crate::entities::{sigint_network, sigint_network_freq, sigint_unit};
use crate::h;
use crate::rer_importer::callsigns::callsign_match_key;
use crate::sigint::network::bl::get_networks_units;
use crate::types::ShortContext;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(FromQueryResult)]
struct FreqNetworkId {
    freq: String,
    network_id: i64,
}

#[derive(FromQueryResult)]
struct PreviewUnit {
    id: i64,
    army_region: String,
    military_district: String,
    army: String,
    division: String,
    regiment: String,
    battalion: String,
    company: String,
}

impl PreviewUnit {
    fn levels(&self) -> [&str; 7] {
        [
            &self.army_region,
            &self.military_district,
            &self.army,
            &self.division,
            &self.regiment,
            &self.battalion,
            &self.company,
        ]
    }
}

struct PreviewContext {
    catalog_unit_ids: HashMap<String, Vec<i64>>,
    catalog_unit_ids_unique: HashSet<i64>,
    network_unit_ids_by_freq: HashMap<String, Vec<i64>>,
    units: HashMap<i64, PreviewUnit>,
}

pub(super) async fn build(
    dbx: &DatabaseConnection,
    callsigns_by_freq: HashMap<String, BTreeSet<String>>,
) -> anyhow::Result<HashMap<String, FreqCallsignSummary>> {
    if callsigns_by_freq.is_empty() {
        return Ok(HashMap::new());
    }
    let context = load_context(dbx, &callsigns_by_freq).await.c(h!())?;
    Ok(callsigns_by_freq
        .into_iter()
        .map(|(freq, callsigns)| {
            let count = callsigns.len() as i64;
            let preview = ranked_preview(&freq, callsigns, &context);
            (freq, FreqCallsignSummary { count, preview })
        })
        .collect())
}

async fn load_context(
    dbx: &DatabaseConnection,
    callsigns_by_freq: &HashMap<String, BTreeSet<String>>,
) -> anyhow::Result<PreviewContext> {
    let callsigns = callsigns_by_freq
        .values()
        .flat_map(|callsigns| callsigns.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let catalog_unit_ids = load_callsign_priority_unit_ids(dbx, &callsigns)
        .await
        .c(h!())?;
    let network_unit_ids_by_freq =
        load_network_unit_ids_by_freq(dbx, callsigns_by_freq.keys())
            .await
            .c(h!())?;
    let catalog_unit_ids_unique = catalog_unit_ids
        .values()
        .flat_map(|ids| ids.iter().copied())
        .collect::<HashSet<_>>();
    let unit_ids = catalog_unit_ids_unique
        .iter()
        .copied()
        .chain(
            network_unit_ids_by_freq
                .values()
                .flat_map(|ids| ids.iter().copied()),
        )
        .collect::<HashSet<_>>();
    let units = if unit_ids.is_empty() {
        HashMap::new()
    } else {
        sigint_unit::Entity::find()
            .select_only()
            .columns([
                sigint_unit::Column::Id,
                sigint_unit::Column::ArmyRegion,
                sigint_unit::Column::MilitaryDistrict,
                sigint_unit::Column::Army,
                sigint_unit::Column::Division,
                sigint_unit::Column::Regiment,
                sigint_unit::Column::Battalion,
                sigint_unit::Column::Company,
            ])
            .filter(sigint_unit::Column::Id.is_in(unit_ids))
            .into_model::<PreviewUnit>()
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|unit| (unit.id, unit))
            .collect()
    };
    Ok(PreviewContext {
        catalog_unit_ids,
        catalog_unit_ids_unique,
        network_unit_ids_by_freq,
        units,
    })
}

async fn load_network_unit_ids_by_freq<'a>(
    dbx: &DatabaseConnection,
    freqs: impl Iterator<Item = &'a String>,
) -> anyhow::Result<HashMap<String, Vec<i64>>> {
    let rows = sigint_network_freq::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network_freq::Column::NetworkId)
        .filter(sigint_network_freq::Column::Freq.is_in(freqs.cloned()))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_network::Column::ActiveTo.is_null())
                .add(sigint_network_freq::Column::ActiveTo.is_null()),
        )
        .into_model::<FreqNetworkId>()
        .all(dbx)
        .await
        .c(h!())?;
    let network_ids = rows
        .iter()
        .map(|row| row.network_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let unit_ids_by_network =
        get_networks_units(dbx, &network_ids).await.c(h!())?;
    let mut unit_ids_by_freq = HashMap::<String, Vec<i64>>::new();
    for row in rows {
        if let Some(unit_ids) = unit_ids_by_network.get(&row.network_id) {
            unit_ids_by_freq
                .entry(row.freq)
                .or_default()
                .extend(unit_ids.iter().copied());
        }
    }
    Ok(unit_ids_by_freq)
}

fn ranked_preview(
    freq: &str,
    callsigns: BTreeSet<String>,
    context: &PreviewContext,
) -> Vec<String> {
    let network_units = context
        .network_unit_ids_by_freq
        .get(freq)
        .into_iter()
        .flat_map(|ids| ids.iter())
        .filter_map(|id| context.units.get(id))
        .collect::<Vec<_>>();
    let related_unit_ids = context
        .catalog_unit_ids_unique
        .iter()
        .filter_map(|id| context.units.get(id))
        .filter(|unit| {
            network_units
                .iter()
                .any(|network| is_related(unit, network))
        })
        .map(|unit| unit.id)
        .collect::<HashSet<_>>();
    let mut ranked = callsigns
        .into_iter()
        .map(|callsign| {
            let unit_ids = context
                .catalog_unit_ids
                .get(&callsign_match_key(&callsign))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let related_count = unit_ids
                .iter()
                .filter(|id| related_unit_ids.contains(id))
                .count();
            let priority = if related_count > 0 {
                (1, std::cmp::Reverse(related_count))
            } else {
                (2, std::cmp::Reverse(unit_ids.len()))
            };
            (priority, callsign)
        })
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(priority, _)| *priority);
    ranked
        .into_iter()
        .take(3)
        .map(|(_, callsign)| callsign)
        .collect()
}

fn is_related(left: &PreviewUnit, right: &PreviewUnit) -> bool {
    left.id == right.id || is_child_of(left, right) || is_child_of(right, left)
}

fn is_child_of(parent: &PreviewUnit, child: &PreviewUnit) -> bool {
    let parent_levels = parent.levels();
    let child_levels = child.levels();
    let parent_last =
        parent_levels.iter().rev().find(|level| !level.is_empty());
    let child_last = child_levels.iter().rev().find(|level| !level.is_empty());
    matches!((parent_last, child_last), (Some(parent), Some(child)) if child > parent)
        && parent_levels
            .iter()
            .zip(child_levels.iter())
            .all(|(parent, child)| parent.is_empty() || parent == child)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(id: i64, army: &str, division: &str) -> PreviewUnit {
        PreviewUnit {
            id,
            army_region: String::new(),
            military_district: String::new(),
            army: army.into(),
            division: division.into(),
            regiment: String::new(),
            battalion: String::new(),
            company: String::new(),
        }
    }

    #[test]
    fn preview_prioritizes_related_units_and_preserves_name_order_for_ties() {
        let units = [unit(1, "A", ""), unit(2, "A", "B"), unit(3, "C", "D")]
            .into_iter()
            .map(|unit| (unit.id, unit))
            .collect();
        let context = PreviewContext {
            catalog_unit_ids: HashMap::from([
                ("bravo".into(), vec![3]),
                ("charlie".into(), vec![2]),
            ]),
            catalog_unit_ids_unique: HashSet::from([2, 3]),
            network_unit_ids_by_freq: HashMap::from([("123".into(), vec![1])]),
            units,
        };
        let callsigns = ["alpha", "bravo", "charlie", "delta"]
            .into_iter()
            .map(String::from)
            .collect();

        assert_eq!(
            ranked_preview("123", callsigns, &context),
            vec!["charlie", "bravo", "alpha"]
        );
    }
}
