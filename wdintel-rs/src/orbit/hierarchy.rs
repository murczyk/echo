use crate::orbit::types::{SourceUnit, SourceUnitData};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub struct HierarchyUnit {
    pub data: SourceUnitData,
    pub generative_parent_unit_id: Option<Uuid>,
    pub operational_parent_unit_id: Option<Uuid>,
    pub partial: bool,
}

pub fn build_import_hierarchy(
    units: &[SourceUnit],
    selected_ids: &HashSet<Uuid>,
) -> anyhow::Result<Vec<HierarchyUnit>> {
    let top_level_ids = units.iter().map(|unit| unit.unit_id).collect();
    let mut builder = HierarchyBuilder {
        nodes: HashMap::new(),
        top_level_ids,
        generative_parents: HashMap::new(),
        operational_parents: HashMap::new(),
    };
    for unit in units {
        builder.add_unit(unit)?;
    }
    let selected_ids_in_source_order = units
        .iter()
        .filter(|unit| selected_ids.contains(&unit.unit_id))
        .map(|unit| unit.unit_id)
        .collect::<Vec<_>>();
    if selected_ids_in_source_order.len() != selected_ids.len() {
        anyhow::bail!("ORBIT hierarchy selection contains an unknown unit");
    }
    builder.finish(&selected_ids_in_source_order)
}

struct HierarchyBuilder {
    nodes: HashMap<Uuid, SourceUnitData>,
    top_level_ids: HashSet<Uuid>,
    generative_parents: HashMap<Uuid, Uuid>,
    operational_parents: HashMap<Uuid, Uuid>,
}

impl HierarchyBuilder {
    fn add_unit(&mut self, unit: &SourceUnit) -> anyhow::Result<()> {
        self.add_node(unit)?;
        self.add_chain(
            unit.unit_id,
            &unit.generative_parent_units,
            HierarchyKind::Generative,
        )?;
        self.add_chain(
            unit.unit_id,
            &unit.operational_parent_units,
            HierarchyKind::Operational,
        )?;
        for parent in unit
            .generative_parent_units
            .iter()
            .chain(&unit.operational_parent_units)
        {
            self.add_unit(parent)?;
        }
        Ok(())
    }

    fn add_node(&mut self, unit: &SourceUnit) -> anyhow::Result<()> {
        let data = SourceUnitData::from(unit);
        match self.nodes.get_mut(&unit.unit_id) {
            Some(existing) => existing.merge(&data),
            None => {
                self.nodes.insert(unit.unit_id, data);
                Ok(())
            }
        }
    }

    fn add_chain(
        &mut self,
        unit_id: Uuid,
        parents: &[SourceUnit],
        kind: HierarchyKind,
    ) -> anyhow::Result<()> {
        if parents.is_empty() {
            return Ok(());
        }
        let mut parents = parents.iter().collect::<Vec<_>>();
        parents.sort_by_key(|parent| parent.path_level);
        for parent in &parents {
            self.add_node(parent)?;
        }
        for pair in parents.windows(2) {
            self.add_parent(pair[1].unit_id, pair[0].unit_id, kind)?;
        }
        self.add_parent(unit_id, parents.last().unwrap().unit_id, kind)
    }

    fn add_parent(
        &mut self,
        unit_id: Uuid,
        parent_id: Uuid,
        kind: HierarchyKind,
    ) -> anyhow::Result<()> {
        let parents = match kind {
            HierarchyKind::Generative => &mut self.generative_parents,
            HierarchyKind::Operational => &mut self.operational_parents,
        };
        match parents.insert(unit_id, parent_id) {
            Some(existing) if existing != parent_id => anyhow::bail!(
                "ORBIT unit {unit_id} has conflicting {} parents: {existing} and {parent_id}",
                kind.name()
            ),
            _ => Ok(()),
        }
    }

    fn finish(
        self,
        selected_ids: &[Uuid],
    ) -> anyhow::Result<Vec<HierarchyUnit>> {
        let mut ordered = Vec::new();
        let mut completed = HashSet::new();
        let mut visiting = HashSet::new();
        for unit_id in selected_ids {
            self.visit(*unit_id, &mut visiting, &mut completed, &mut ordered)?;
        }
        Ok(ordered)
    }

    fn visit(
        &self,
        unit_id: Uuid,
        visiting: &mut HashSet<Uuid>,
        completed: &mut HashSet<Uuid>,
        ordered: &mut Vec<HierarchyUnit>,
    ) -> anyhow::Result<()> {
        if completed.contains(&unit_id) {
            return Ok(());
        }
        if !visiting.insert(unit_id) {
            anyhow::bail!("ORBIT hierarchy contains a cycle at unit {unit_id}");
        }
        let data = self.nodes.get(&unit_id).ok_or_else(|| {
            anyhow::anyhow!("ORBIT hierarchy references missing unit {unit_id}")
        })?;
        let generative_parent_unit_id =
            self.generative_parents.get(&unit_id).copied();
        let operational_parent_unit_id =
            self.operational_parents.get(&unit_id).copied();
        for parent_id in [generative_parent_unit_id, operational_parent_unit_id]
            .into_iter()
            .flatten()
        {
            self.visit(parent_id, visiting, completed, ordered)?;
        }
        visiting.remove(&unit_id);
        completed.insert(unit_id);
        ordered.push(HierarchyUnit {
            data: data.clone(),
            generative_parent_unit_id,
            operational_parent_unit_id,
            partial: !self.top_level_ids.contains(&unit_id),
        });
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum HierarchyKind {
    Generative,
    Operational,
}

impl HierarchyKind {
    fn name(self) -> &'static str {
        match self {
            Self::Generative => "generative",
            Self::Operational => "operational",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::parse_units;

    #[test]
    fn sample_selects_both_parent_chains_in_parent_first_order() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (units, _) = parse_units(sample).unwrap();
        let selected = HashSet::from([units[0].unit_id]);
        let hierarchy = build_import_hierarchy(&units, &selected).unwrap();
        assert_eq!(hierarchy.len(), 6);
        assert_eq!(hierarchy.last().unwrap().data.unit_id, units[0].unit_id);
        assert!(hierarchy[..5].iter().all(|unit| unit.partial));
        assert_eq!(
            hierarchy.last().unwrap().operational_parent_unit_id,
            Some(
                units[0]
                    .operational_parent_units
                    .iter()
                    .max_by_key(|parent| parent.path_level)
                    .unwrap()
                    .unit_id
            )
        );
    }

    #[test]
    fn conflicting_parent_links_are_rejected() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (mut units, _) = parse_units(sample).unwrap();
        let mut duplicate = units[0].clone();
        duplicate.unit_id = Uuid::new_v4();
        duplicate
            .operational_parent_units
            .last_mut()
            .unwrap()
            .unit_id = units[0].unit_id;
        units.push(duplicate);
        let selected = HashSet::from([units[1].unit_id]);
        assert!(build_import_hierarchy(&units, &selected).is_err());
    }

    #[test]
    fn selected_roots_follow_source_order() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (mut units, _) = parse_units(sample).unwrap();
        let mut second = units[0].clone();
        second.unit_id = Uuid::new_v4();
        units.push(second);
        let selected = HashSet::from([units[1].unit_id, units[0].unit_id]);

        let hierarchy = build_import_hierarchy(&units, &selected).unwrap();
        let first_index = hierarchy
            .iter()
            .position(|unit| unit.data.unit_id == units[0].unit_id)
            .unwrap();
        let second_index = hierarchy
            .iter()
            .position(|unit| unit.data.unit_id == units[1].unit_id)
            .unwrap();

        assert!(first_index < second_index);
    }
}
