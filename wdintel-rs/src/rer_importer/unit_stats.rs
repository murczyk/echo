use super::types::{AnalysisStatsUnit, UnitStatsOption, UnitStatsRsp};
use crate::config::{
    ANALYSIS_STATS_UNDEFINED_UNIT_ID, ANALYSIS_STATS_UNDEFINED_UNIT_NAME,
};
use crate::h;
use crate::sigint::unit::types::UnitHierarchyRsp;
use crate::types::{Env, ShortContext};
use std::collections::BTreeMap;

pub(crate) async fn enrich(
    env: &Env,
    units: Vec<AnalysisStatsUnit>,
) -> anyhow::Result<UnitStatsRsp> {
    let hierarchy = crate::sigint::unit::hierarchy::load(env).await.c(h!())?;
    let options = enrich_options(&units, &hierarchy).c(h!())?;
    Ok(UnitStatsRsp { units, options })
}

fn enrich_options(
    units: &[AnalysisStatsUnit],
    hierarchy: &UnitHierarchyRsp,
) -> anyhow::Result<Vec<UnitStatsOption>> {
    let mut options = units
        .iter()
        .filter(|unit| unit.count > 0)
        .map(|unit| {
            let value = if unit.unit_id == ANALYSIS_STATS_UNDEFINED_UNIT_ID {
                ANALYSIS_STATS_UNDEFINED_UNIT_NAME.to_string()
            } else {
                format!("unit-id:{}", unit.unit_id)
            };
            (
                value.clone(),
                UnitStatsOption {
                    value,
                    label: unit.name.clone(),
                    count: unit.count,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let groups = group_counts(units, hierarchy).c(h!())?;
    let names = hierarchy
        .units
        .iter()
        .map(|unit| (unit.id, unit.name.trim()))
        .collect::<BTreeMap<_, _>>();
    for (index, group) in hierarchy.groups.iter().enumerate() {
        let totals = &groups[index];
        if group.level < 2
            || totals.count <= 0
            || (!totals.has_children && totals.unit_ids.len() <= 1)
        {
            continue;
        }
        let label = group_label(hierarchy, index).c(h!())?;
        let unit_id = if totals.unit_ids.len() == 1 {
            totals.unit_ids.first()
        } else {
            totals
                .unit_ids
                .iter()
                .filter(|id| names.get(*id) == Some(&label.as_str()))
                .min()
        };
        let value = unit_id.map_or_else(
            || format!("unit-parent:{}", group.id),
            |id| format!("unit-id:{id}"),
        );
        let label = match options.get(&value) {
            Some(option) => option.label.clone(),
            None => label,
        };
        for id in &totals.unit_ids {
            let unit_value = format!("unit-id:{id}");
            if options
                .get(&unit_value)
                .is_some_and(|option| option.label.trim() == label.trim())
            {
                options.remove(&unit_value);
            }
        }
        options.insert(
            value.clone(),
            UnitStatsOption {
                value,
                label,
                count: totals.count,
            },
        );
    }
    let mut options = options.into_values().collect::<Vec<_>>();
    options.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(options)
}

fn group_label(
    hierarchy: &UnitHierarchyRsp,
    mut index: usize,
) -> anyhow::Result<String> {
    let mut labels = Vec::new();
    loop {
        let group = hierarchy.groups.get(index).c(h!())?;
        if group.level < 2 {
            break;
        }
        labels.push(group.label.as_str());
        let Some(parent) = group.parent_index else {
            break;
        };
        index = parent as usize;
    }
    Ok(labels.join(" "))
}

#[derive(Clone, Default)]
struct GroupCounts {
    count: i64,
    unit_ids: Vec<i64>,
    has_children: bool,
}

fn group_counts(
    units: &[AnalysisStatsUnit],
    hierarchy: &UnitHierarchyRsp,
) -> anyhow::Result<Vec<GroupCounts>> {
    let counts = units
        .iter()
        .map(|unit| (unit.unit_id, unit.count))
        .collect::<BTreeMap<_, _>>();
    let mut groups = vec![GroupCounts::default(); hierarchy.groups.len()];
    for unit in &hierarchy.units {
        if let Some(index) = unit.group_index {
            let group = groups.get_mut(index as usize).c(h!())?;
            group.unit_ids.push(unit.id);
            group.count = group
                .count
                .checked_add(counts.get(&unit.id).copied().unwrap_or(0))
                .c(h!())?;
        }
    }
    for (index, group) in hierarchy.groups.iter().enumerate().rev() {
        if let Some(parent) = group.parent_index {
            let count = groups[index].count;
            let parent = groups.get_mut(parent as usize).c(h!())?;
            parent.has_children = true;
            parent.count = parent.count.checked_add(count).c(h!())?;
        }
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigint::unit::types::{UnitHierarchyGroup, UnitHierarchyUnit};

    #[test]
    fn regression_3527_computed_parent_replaces_matching_catalog_options() {
        let hierarchy = UnitHierarchyRsp {
            revision: String::new(),
            groups: vec![
                UnitHierarchyGroup {
                    id: "group:2:22 А".to_string(),
                    label: "22 А".to_string(),
                    level: 2,
                    parent_index: None,
                },
                UnitHierarchyGroup {
                    id: "group:2:22 А|3:__EMPTY__|4:72 мсд".to_string(),
                    label: "72 мсд".to_string(),
                    level: 4,
                    parent_index: Some(0),
                },
            ],
            units: [
                (30, "22 А", 0),
                (31, "22 А", 0),
                (32, "72 мсд 22 А", 1),
                (33, "Army headquarters", 0),
            ]
            .into_iter()
            .map(|(id, name, group_index)| UnitHierarchyUnit {
                id,
                name: name.to_string(),
                group_index: Some(group_index),
            })
            .collect(),
            selections: Vec::new(),
        };
        let units = hierarchy
            .units
            .iter()
            .zip([2, 3, 5, 7])
            .map(|(unit, count)| AnalysisStatsUnit {
                unit_id: unit.id,
                name: unit.name.clone(),
                count,
            })
            .collect::<Vec<_>>();
        let options = enrich_options(&units, &hierarchy).unwrap();
        let armies = options
            .iter()
            .filter(|option| option.label == "22 А")
            .collect::<Vec<_>>();
        assert_eq!(armies.len(), 1);
        assert_eq!(armies[0].value, "unit-id:30");
        assert_eq!(armies[0].count, 17);
        assert_eq!(options.len(), 3);
        assert_eq!(
            options
                .iter()
                .find(|option| option.value == "unit-id:33")
                .unwrap()
                .count,
            7
        );
    }
}
