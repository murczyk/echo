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

pub fn source_unit_ids(units: &[SourceUnit]) -> HashSet<Uuid> {
    let mut unit_ids = HashSet::new();
    for unit in units {
        collect_source_unit_ids(unit, &mut unit_ids);
    }
    unit_ids
}

fn collect_source_unit_ids(unit: &SourceUnit, unit_ids: &mut HashSet<Uuid>) {
    unit_ids.insert(unit.unit_id);
    for parent in unit
        .generative_parent_units
        .iter()
        .chain(&unit.operational_parent_units)
    {
        collect_source_unit_ids(parent, unit_ids);
    }
}

pub fn build_import_hierarchy(
    units: &[SourceUnit],
    selected_ids: &HashSet<Uuid>,
) -> anyhow::Result<Vec<HierarchyUnit>> {
    let top_level_ids = units.iter().map(|unit| unit.unit_id).collect();
    let mut builder = HierarchyBuilder {
        nodes: HashMap::new(),
        top_level_ids,
        generative_parents: ParentLinks::default(),
        operational_parents: ParentLinks::default(),
    };
    for unit in units {
        builder.add_unit(unit, true)?;
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
    generative_parents: ParentLinks,
    operational_parents: ParentLinks,
}

#[derive(Default)]
struct ParentLinks {
    authoritative: HashMap<Uuid, Option<Uuid>>,
    embedded: HashMap<Uuid, HashSet<Uuid>>,
}

impl HierarchyBuilder {
    fn add_unit(
        &mut self,
        unit: &SourceUnit,
        top_level: bool,
    ) -> anyhow::Result<()> {
        self.add_node(unit)?;
        self.add_chain(
            unit.unit_id,
            &unit.generative_parent_units,
            HierarchyKind::Generative,
            top_level,
        )?;
        self.add_chain(
            unit.unit_id,
            &unit.operational_parent_units,
            HierarchyKind::Operational,
            top_level,
        )?;
        for parent in unit
            .generative_parent_units
            .iter()
            .chain(&unit.operational_parent_units)
        {
            self.add_unit(parent, false)?;
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
        top_level: bool,
    ) -> anyhow::Result<()> {
        if parents.is_empty() {
            if top_level {
                self.add_authoritative_parent(unit_id, None, kind)?;
            }
            return Ok(());
        }
        let mut parents = parents.iter().collect::<Vec<_>>();
        parents.sort_by_key(|parent| parent.path_level);
        for parent in &parents {
            self.add_node(parent)?;
        }
        for pair in parents.windows(2) {
            self.add_embedded_parent(pair[1].unit_id, pair[0].unit_id, kind);
        }
        let parent_id = parents.last().unwrap().unit_id;
        if top_level {
            self.add_authoritative_parent(unit_id, Some(parent_id), kind)
        } else {
            self.add_embedded_parent(unit_id, parent_id, kind);
            Ok(())
        }
    }

    fn add_authoritative_parent(
        &mut self,
        unit_id: Uuid,
        parent_id: Option<Uuid>,
        kind: HierarchyKind,
    ) -> anyhow::Result<()> {
        let links = match kind {
            HierarchyKind::Generative => &mut self.generative_parents,
            HierarchyKind::Operational => &mut self.operational_parents,
        };
        match links.authoritative.insert(unit_id, parent_id) {
            Some(existing) if existing != parent_id => anyhow::bail!(
                "ORBIT unit {unit_id} has conflicting {} top-level parents: {existing:?} and {parent_id:?}",
                kind.name(),
            ),
            _ => Ok(()),
        }
    }

    fn add_embedded_parent(
        &mut self,
        unit_id: Uuid,
        parent_id: Uuid,
        kind: HierarchyKind,
    ) {
        let links = match kind {
            HierarchyKind::Generative => &mut self.generative_parents,
            HierarchyKind::Operational => &mut self.operational_parents,
        };
        links.embedded.entry(unit_id).or_default().insert(parent_id);
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
        let generative_parent_unit_id = self
            .generative_parents
            .resolve(unit_id, HierarchyKind::Generative)?;
        let operational_parent_unit_id = self
            .operational_parents
            .resolve(unit_id, HierarchyKind::Operational)?;
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

impl ParentLinks {
    fn resolve(
        &self,
        unit_id: Uuid,
        kind: HierarchyKind,
    ) -> anyhow::Result<Option<Uuid>> {
        if let Some(parent_id) = self.authoritative.get(&unit_id) {
            return Ok(*parent_id);
        }
        let Some(parent_ids) = self.embedded.get(&unit_id) else {
            return Ok(None);
        };
        if parent_ids.len() > 1 {
            let mut parent_ids = parent_ids.iter().copied().collect::<Vec<_>>();
            parent_ids.sort_unstable();
            anyhow::bail!(
                "ORBIT unit {unit_id} has conflicting embedded {} parents: {}",
                kind.name(),
                parent_ids
                    .into_iter()
                    .map(|parent_id| parent_id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        Ok(parent_ids.iter().next().copied())
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
    fn top_level_parent_overrides_conflicting_embedded_path() {
        let sample = include_str!(
            "../../../deploy/2026-07-29-orbit-dictionaries/orbit_sample.json"
        );
        let (mut units, _) = parse_units(sample).unwrap();
        let target = units[0].clone();
        let authoritative_parent_id = target
            .operational_parent_units
            .iter()
            .max_by_key(|parent| parent.path_level)
            .unwrap()
            .unit_id;
        let mut alternate_parent =
            target.operational_parent_units.first().unwrap().clone();
        alternate_parent.path_level = Some(0);
        alternate_parent.operational_parent_units.clear();
        alternate_parent.generative_parent_units.clear();
        let mut embedded_target = target.clone();
        embedded_target.path_level = Some(1);
        embedded_target.operational_unit_name_full = None;
        embedded_target.generative_unit_name_full = None;
        embedded_target.operational_parent_units.clear();
        embedded_target.generative_parent_units.clear();
        let mut child = target;
        child.unit_id = Uuid::new_v4();
        child.unit_name = Some("child".to_string());
        child.unit_name_short = Some("child".to_string());
        child.operational_unit_name_full =
            Some("child / батрурлр / ОУВ(с)".to_string());
        child.generative_unit_name_full = None;
        child.operational_parent_units =
            vec![alternate_parent, embedded_target];
        child.generative_parent_units.clear();
        let child_id = child.unit_id;
        units.push(child);

        let hierarchy =
            build_import_hierarchy(&units, &HashSet::from([child_id])).unwrap();
        let target = hierarchy
            .iter()
            .find(|unit| unit.data.unit_id == units[0].unit_id)
            .unwrap();

        assert_eq!(
            target.operational_parent_unit_id,
            Some(authoritative_parent_id)
        );
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
