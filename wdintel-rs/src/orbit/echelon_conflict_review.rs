use super::tui;
use crate::config::ORBIT_ECHELON_CONFLICT_MANUAL_PERSIST_BATCH_SIZE;
use crate::entities::sigint_unit;
use crate::sigint::unit::orbit::{
    OrbitUnitAttributeChange, OrbitUnitHierarchyChange,
};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, QuerySelect, Statement,
};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use uuid::Uuid;

const UNIQUE_ECHELONS: [UniqueEchelon; 6] = [
    UniqueEchelon::Brigade,
    UniqueEchelon::Division,
    UniqueEchelon::Corps,
    UniqueEchelon::Army,
    UniqueEchelon::ArmyRegion,
    UniqueEchelon::MilitaryDistrict,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum UniqueEchelon {
    Brigade,
    Division,
    Corps,
    Army,
    ArmyRegion,
    MilitaryDistrict,
}

impl UniqueEchelon {
    fn position(self) -> usize {
        match self {
            Self::Brigade => 0,
            Self::Division => 1,
            Self::Corps => 2,
            Self::Army => 3,
            Self::ArmyRegion => 4,
            Self::MilitaryDistrict => 5,
        }
    }

    fn attribute(self) -> &'static str {
        match self {
            Self::Brigade => "brigade",
            Self::Division => "division",
            Self::Corps => "corps",
            Self::Army => "army",
            Self::ArmyRegion => "army_region",
            Self::MilitaryDistrict => "military_district",
        }
    }

    fn orbit_echelon(self) -> super::EchoEchelon {
        match self {
            Self::Brigade => super::EchoEchelon::Brigade,
            Self::Division => super::EchoEchelon::Division,
            Self::Corps => super::EchoEchelon::Corps,
            Self::Army => super::EchoEchelon::Army,
            Self::ArmyRegion => super::EchoEchelon::ArmyRegion,
            Self::MilitaryDistrict => super::EchoEchelon::MilitaryDistrict,
        }
    }

    fn value(self, unit: &HierarchyUnit) -> &str {
        match self {
            Self::Brigade => &unit.brigade,
            Self::Division => &unit.division,
            Self::Corps => &unit.corps,
            Self::Army => &unit.army,
            Self::ArmyRegion => &unit.army_region,
            Self::MilitaryDistrict => &unit.military_district,
        }
    }

    fn set_value(self, unit: &mut HierarchyUnit, value: String) {
        match self {
            Self::Brigade => unit.brigade = value,
            Self::Division => unit.division = value,
            Self::Corps => unit.corps = value,
            Self::Army => unit.army = value,
            Self::ArmyRegion => unit.army_region = value,
            Self::MilitaryDistrict => unit.military_district = value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, sea_orm::FromQueryResult)]
struct HierarchyUnit {
    id: i64,
    name: String,
    active: bool,
    brigade: String,
    division: String,
    corps: String,
    army: String,
    army_region: String,
    military_district: String,
}

#[derive(Debug, FromQueryResult)]
struct LinkedOrbitHierarchyRow {
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
    structural_name_full: Option<String>,
    depth: i32,
    echelon_key: Option<String>,
    preferred_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkedOrbitHierarchyLevel {
    echelon: Option<super::EchoEchelon>,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkedOrbitHierarchy {
    orbit_unit_id: Uuid,
    structural_name_full: Option<String>,
    levels: Vec<LinkedOrbitHierarchyLevel>,
}

type LinkedOrbitHierarchies = BTreeMap<i64, Vec<LinkedOrbitHierarchy>>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct HierarchyAnchor {
    echelon: UniqueEchelon,
    normalized_name: String,
    unit_indexes: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ConflictKey {
    first_unit_id: i64,
    second_unit_id: i64,
    conflicting_echelon: UniqueEchelon,
}

impl ConflictKey {
    fn new(
        first_unit_id: i64,
        second_unit_id: i64,
        conflicting_echelon: UniqueEchelon,
    ) -> Self {
        let (first_unit_id, second_unit_id) = if first_unit_id < second_unit_id
        {
            (first_unit_id, second_unit_id)
        } else {
            (second_unit_id, first_unit_id)
        };
        Self {
            first_unit_id,
            second_unit_id,
            conflicting_echelon,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HierarchyConflict {
    first_index: usize,
    second_index: usize,
    shared_echelon: UniqueEchelon,
    conflicting_echelon: UniqueEchelon,
}

impl HierarchyConflict {
    fn key(&self, units: &[HierarchyUnit]) -> ConflictKey {
        ConflictKey::new(
            units[self.first_index].id,
            units[self.second_index].id,
            self.conflicting_echelon,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyDirection {
    FirstIntoSecond,
    SecondIntoFirst,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReviewedConflictChange {
    first: HierarchyUnit,
    second: HierarchyUnit,
    conflicting_echelon: UniqueEchelon,
    direction: CopyDirection,
}

impl ReviewedConflictChange {
    fn source_and_target(&self) -> (&HierarchyUnit, &HierarchyUnit) {
        match self.direction {
            CopyDirection::FirstIntoSecond => (&self.first, &self.second),
            CopyDirection::SecondIntoFirst => (&self.second, &self.first),
        }
    }

    fn hierarchy_change(&self) -> OrbitUnitHierarchyChange {
        let (source, target) = self.source_and_target();
        OrbitUnitHierarchyChange {
            sigint_unit_id: target.id,
            attributes: vec![OrbitUnitAttributeChange {
                attribute: self.conflicting_echelon.attribute(),
                current: self.conflicting_echelon.value(target).to_string(),
                proposed: self.conflicting_echelon.value(source).to_string(),
            }],
        }
    }
}

#[derive(Debug, Default)]
struct ManualReview {
    selected: Vec<ReviewedConflictChange>,
    reviewed: usize,
    skipped: usize,
    stopped: bool,
}

#[derive(Debug, Default)]
struct PersistSummary {
    changed: usize,
    stale: usize,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(activity_scope) = tui::prompt_unit_activity_scope(
        "Choose echelon-conflict review scope (↑/↓, Enter, Esc: quit)",
    )
    .c(h!())?
    else {
        return Ok(());
    };
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, activity_scope).await.c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<()> {
    let units = load_units(db, None, false, activity_scope).await.c(h!())?;
    let review_context_unit_ids = review_context_unit_ids(&units);
    let linked_orbit_hierarchies =
        load_linked_orbit_hierarchies(db, &review_context_unit_ids)
            .await
            .c(h!())?;
    let review = review_manually(units, &linked_orbit_hierarchies).c(h!())?;
    let accepted = review.selected.len();
    let persisted = persist_changes(db, &review.selected, activity_scope)
        .await
        .c(h!())?;
    println!(
        "SIGINT echelon-conflict review: {} conflicts reviewed, {accepted} accepted, {} skipped, {} stale; {} higher-echelon values changed{}.",
        review.reviewed,
        review.skipped,
        persisted.stale,
        persisted.changed,
        if review.stopped { " (stopped early)" } else { "" },
    );
    Ok(())
}

async fn load_units<C>(
    db: &C,
    unit_ids: Option<&[i64]>,
    lock: bool,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<Vec<HierarchyUnit>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .select_only()
        .columns([
            sigint_unit::Column::Id,
            sigint_unit::Column::Name,
            sigint_unit::Column::Active,
            sigint_unit::Column::Brigade,
            sigint_unit::Column::Division,
            sigint_unit::Column::Corps,
            sigint_unit::Column::Army,
            sigint_unit::Column::ArmyRegion,
            sigint_unit::Column::MilitaryDistrict,
        ])
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_unit::Column::Id);
    if let Some(active) = activity_scope.active() {
        units = units.filter(sigint_unit::Column::Active.eq(active));
    }
    if let Some(unit_ids) = unit_ids {
        if unit_ids.is_empty() {
            return Ok(Vec::new());
        }
        units = units
            .filter(sigint_unit::Column::Id.is_in(unit_ids.iter().copied()));
    }
    if lock {
        units = units.lock_exclusive();
    }
    units.into_model::<HierarchyUnit>().all(db).await.c(h!())
}

async fn load_linked_orbit_hierarchies<C>(
    db: &C,
    sigint_unit_ids: &[i64],
) -> anyhow::Result<LinkedOrbitHierarchies>
where
    C: ConnectionTrait,
{
    if sigint_unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let sql = r#"
        with recursive linked_hierarchy as (
            select
                link.sigint_unit_id,
                link.orbit_unit_id,
                nullif(btrim(unit.generative_unit_name_full), '')
                    as structural_name_full,
                unit.unit_id as hierarchy_unit_id,
                unit.generative_parent_unit_id,
                0::integer as depth,
                array[unit.unit_id]::uuid[] as visited
            from orbit_unit_sigint_unit link
            inner join orbit_unit unit
                on unit.unit_id = link.orbit_unit_id
                and unit.deleted = false
            where link.sigint_unit_id = any($1::bigint[])
              and link.is_suppressed = false

            union all

            select
                hierarchy.sigint_unit_id,
                hierarchy.orbit_unit_id,
                hierarchy.structural_name_full,
                parent.unit_id,
                parent.generative_parent_unit_id,
                hierarchy.depth + 1,
                hierarchy.visited || parent.unit_id
            from linked_hierarchy hierarchy
            inner join orbit_unit parent
                on parent.unit_id = hierarchy.generative_parent_unit_id
                and parent.deleted = false
            where not parent.unit_id = any(hierarchy.visited)
        )
        select
            hierarchy.sigint_unit_id,
            hierarchy.orbit_unit_id,
            hierarchy.structural_name_full,
            hierarchy.depth,
            echelon.key as echelon_key,
            coalesce(
                nullif(btrim(unit.unit_name_short), ''),
                nullif(btrim(unit.unit_name), ''),
                nullif(btrim(unit.unit_name_original), ''),
                nullif(btrim(unit.unit_number), ''),
                unit.unit_id::text
            ) as preferred_name
        from linked_hierarchy hierarchy
        inner join orbit_unit unit
            on unit.unit_id = hierarchy.hierarchy_unit_id
        left join orbit_unit_echelon echelon
            on echelon.id = unit.unit_echelon_id
        order by
            hierarchy.sigint_unit_id,
            hierarchy.orbit_unit_id,
            hierarchy.depth
    "#;
    let rows = LinkedOrbitHierarchyRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [sigint_unit_ids.to_vec().into()],
        ),
    )
    .all(db)
    .await
    .c(h!())?;
    Ok(group_linked_orbit_hierarchies(rows))
}

fn group_linked_orbit_hierarchies(
    rows: Vec<LinkedOrbitHierarchyRow>,
) -> LinkedOrbitHierarchies {
    let mut hierarchy_by_unit = BTreeMap::<
        (i64, Uuid),
        (Option<String>, Vec<(i32, LinkedOrbitHierarchyLevel)>),
    >::new();
    for row in rows {
        let hierarchy = hierarchy_by_unit
            .entry((row.sigint_unit_id, row.orbit_unit_id))
            .or_insert_with(|| (row.structural_name_full.clone(), Vec::new()));
        hierarchy.1.push((
            row.depth,
            LinkedOrbitHierarchyLevel {
                echelon: row
                    .echelon_key
                    .as_deref()
                    .and_then(super::echo_echelon),
                name: row.preferred_name,
            },
        ));
    }
    let mut hierarchies = LinkedOrbitHierarchies::new();
    for ((sigint_unit_id, orbit_unit_id), (structural_name_full, mut levels)) in
        hierarchy_by_unit
    {
        levels.sort_by_key(|(depth, _)| *depth);
        hierarchies.entry(sigint_unit_id).or_default().push(
            LinkedOrbitHierarchy {
                orbit_unit_id,
                structural_name_full,
                levels: levels.into_iter().map(|(_, level)| level).collect(),
            },
        );
    }
    hierarchies
}

fn normalized_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn collect_anchors(
    units: &[HierarchyUnit],
    echelon: UniqueEchelon,
) -> Vec<HierarchyAnchor> {
    let mut unit_indexes_by_name = BTreeMap::<String, Vec<usize>>::new();
    for (unit_index, unit) in units.iter().enumerate() {
        let normalized_name = normalized_name(echelon.value(unit));
        if !normalized_name.is_empty() {
            unit_indexes_by_name
                .entry(normalized_name)
                .or_default()
                .push(unit_index);
        }
    }
    unit_indexes_by_name
        .into_iter()
        .filter(|(_, unit_indexes)| unit_indexes.len() > 1)
        .map(|(normalized_name, unit_indexes)| HierarchyAnchor {
            echelon,
            normalized_name,
            unit_indexes,
        })
        .collect()
}

fn next_conflict_for_anchor(
    units: &[HierarchyUnit],
    anchor: &HierarchyAnchor,
    handled: &HashSet<ConflictKey>,
) -> Option<HierarchyConflict> {
    for conflicting_echelon in
        UNIQUE_ECHELONS.iter().skip(anchor.echelon.position() + 1)
    {
        let values = anchor
            .unit_indexes
            .iter()
            .map(|index| {
                normalized_name(conflicting_echelon.value(&units[*index]))
            })
            .collect::<HashSet<_>>();
        if values.len() < 2 {
            continue;
        }
        for (position, first_index) in anchor.unit_indexes.iter().enumerate() {
            let first_value = normalized_name(
                conflicting_echelon.value(&units[*first_index]),
            );
            for second_index in anchor.unit_indexes.iter().skip(position + 1) {
                if first_value
                    == normalized_name(
                        conflicting_echelon.value(&units[*second_index]),
                    )
                {
                    continue;
                }
                let key = ConflictKey::new(
                    units[*first_index].id,
                    units[*second_index].id,
                    *conflicting_echelon,
                );
                if !handled.contains(&key) {
                    return Some(HierarchyConflict {
                        first_index: *first_index,
                        second_index: *second_index,
                        shared_echelon: anchor.echelon,
                        conflicting_echelon: *conflicting_echelon,
                    });
                }
            }
        }
    }
    None
}

fn review_context_unit_ids(units: &[HierarchyUnit]) -> Vec<i64> {
    let mut unit_ids = BTreeSet::new();
    for echelon in UNIQUE_ECHELONS {
        for anchor in collect_anchors(units, echelon) {
            unit_ids.extend(
                anchor
                    .unit_indexes
                    .into_iter()
                    .map(|unit_index| units[unit_index].id),
            );
        }
    }
    unit_ids.into_iter().collect()
}

fn review_manually(
    mut units: Vec<HierarchyUnit>,
    linked_orbit_hierarchies: &LinkedOrbitHierarchies,
) -> anyhow::Result<ManualReview> {
    let handled = HashSet::new();
    if !UNIQUE_ECHELONS.into_iter().any(|echelon| {
        collect_anchors(&units, echelon).iter().any(|anchor| {
            next_conflict_for_anchor(&units, anchor, &handled).is_some()
        })
    }) {
        return Ok(ManualReview::default());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let result = review_manually_inner(
        &mut terminal,
        &mut units,
        linked_orbit_hierarchies,
    )
    .c(h!());
    tui::restore_terminal(&mut terminal).c(h!())?;
    result
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    units: &mut [HierarchyUnit],
    linked_orbit_hierarchies: &LinkedOrbitHierarchies,
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    let mut handled = HashSet::new();
    'echelons: for echelon in UNIQUE_ECHELONS {
        let anchors = collect_anchors(units, echelon);
        for (anchor_index, anchor) in anchors.iter().enumerate() {
            while let Some(conflict) =
                next_conflict_for_anchor(units, anchor, &handled)
            {
                let tui_review =
                    make_tui_review(units, &conflict, linked_orbit_hierarchies);
                let decision = tui::review_echelon_conflict(
                    terminal,
                    &tui_review,
                    anchor_index + 1,
                    anchors.len(),
                    review.reviewed + 1,
                )
                .c(h!())?;
                if decision == tui::EchelonConflictReviewDecision::Quit {
                    review.stopped = true;
                    break 'echelons;
                }
                handled.insert(conflict.key(units));
                review.reviewed += 1;
                match decision {
                    tui::EchelonConflictReviewDecision::UseFirstInSecond => {
                        review.selected.push(apply_reviewed_choice(
                            units,
                            &conflict,
                            CopyDirection::FirstIntoSecond,
                        ));
                    }
                    tui::EchelonConflictReviewDecision::UseSecondInFirst => {
                        review.selected.push(apply_reviewed_choice(
                            units,
                            &conflict,
                            CopyDirection::SecondIntoFirst,
                        ));
                    }
                    tui::EchelonConflictReviewDecision::Skip => {
                        review.skipped += 1;
                    }
                    tui::EchelonConflictReviewDecision::Quit => unreachable!(),
                }
            }
        }
    }
    Ok(review)
}

fn make_tui_review(
    units: &[HierarchyUnit],
    conflict: &HierarchyConflict,
    linked_orbit_hierarchies: &LinkedOrbitHierarchies,
) -> tui::EchelonConflictReview {
    let first = &units[conflict.first_index];
    let second = &units[conflict.second_index];
    tui::EchelonConflictReview {
        shared_echelon: conflict.shared_echelon.attribute(),
        first_shared_value: conflict.shared_echelon.value(first).to_string(),
        second_shared_value: conflict.shared_echelon.value(second).to_string(),
        conflicting_echelon: conflict.conflicting_echelon.attribute(),
        first: make_tui_review_unit(
            first,
            conflict.conflicting_echelon,
            linked_orbit_hierarchies,
        ),
        second: make_tui_review_unit(
            second,
            conflict.conflicting_echelon,
            linked_orbit_hierarchies,
        ),
    }
}

fn make_tui_review_unit(
    unit: &HierarchyUnit,
    conflicting_echelon: UniqueEchelon,
    linked_orbit_hierarchies: &LinkedOrbitHierarchies,
) -> tui::EchelonConflictReviewUnit {
    tui::EchelonConflictReviewUnit {
        sigint_unit_id: unit.id,
        sigint_unit_name: unit.name.clone(),
        active: unit.active,
        hierarchy: UNIQUE_ECHELONS
            .into_iter()
            .map(|echelon| {
                (echelon.attribute(), echelon.value(unit).to_string())
            })
            .collect(),
        linked_orbit_units: linked_orbit_hierarchies
            .get(&unit.id)
            .into_iter()
            .flatten()
            .map(|orbit_unit| tui::EchelonConflictOrbitUnit {
                orbit_unit_id: orbit_unit.orbit_unit_id,
                structural_hierarchy: orbit_hierarchy_for_review(
                    orbit_unit,
                    conflicting_echelon,
                ),
            })
            .collect(),
    }
}

fn orbit_hierarchy_for_review(
    orbit_unit: &LinkedOrbitHierarchy,
    conflicting_echelon: UniqueEchelon,
) -> Vec<tui::EchelonConflictOrbitHierarchyLevel> {
    let full_name_levels = orbit_unit
        .structural_name_full
        .as_deref()
        .map(|full_name| {
            full_name
                .split(" / ")
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|levels| levels.len() == orbit_unit.levels.len());
    orbit_unit
        .levels
        .iter()
        .enumerate()
        .map(|(index, level)| tui::EchelonConflictOrbitHierarchyLevel {
            name: full_name_levels
                .as_ref()
                .map(|levels| levels[index].to_string())
                .unwrap_or_else(|| level.name.clone()),
            is_conflicting: level.echelon
                == Some(conflicting_echelon.orbit_echelon()),
        })
        .collect()
}

fn apply_reviewed_choice(
    units: &mut [HierarchyUnit],
    conflict: &HierarchyConflict,
    direction: CopyDirection,
) -> ReviewedConflictChange {
    let first = units[conflict.first_index].clone();
    let second = units[conflict.second_index].clone();
    let (source_index, target_index) = match direction {
        CopyDirection::FirstIntoSecond => {
            (conflict.first_index, conflict.second_index)
        }
        CopyDirection::SecondIntoFirst => {
            (conflict.second_index, conflict.first_index)
        }
    };
    let proposed = conflict
        .conflicting_echelon
        .value(&units[source_index])
        .to_string();
    conflict
        .conflicting_echelon
        .set_value(&mut units[target_index], proposed);
    ReviewedConflictChange {
        first,
        second,
        conflicting_echelon: conflict.conflicting_echelon,
        direction,
    }
}

async fn persist_changes(
    db: &sea_orm::DatabaseConnection,
    changes: &[ReviewedConflictChange],
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistSummary> {
    let mut summary = PersistSummary::default();
    for changes in
        changes.chunks(ORBIT_ECHELON_CONFLICT_MANUAL_PERSIST_BATCH_SIZE)
    {
        let persisted = persist_change_batch(db, changes, activity_scope)
            .await
            .c(h!())?;
        summary.changed += persisted.changed;
        summary.stale += persisted.stale;
    }
    Ok(summary)
}

async fn persist_change_batch(
    db: &sea_orm::DatabaseConnection,
    changes: &[ReviewedConflictChange],
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistSummary> {
    if changes.is_empty() {
        return Ok(PersistSummary::default());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let mut summary = PersistSummary::default();
    for reviewed in changes {
        let current = load_units(
            &transaction,
            Some(&[reviewed.first.id, reviewed.second.id]),
            true,
            activity_scope,
        )
        .await
        .c(h!())?;
        let current_first =
            current.iter().find(|unit| unit.id == reviewed.first.id);
        let current_second =
            current.iter().find(|unit| unit.id == reviewed.second.id);
        if current_first != Some(&reviewed.first)
            || current_second != Some(&reviewed.second)
        {
            summary.stale += 1;
            continue;
        }
        let outcome = crate::sigint::unit::orbit::reconcile_sigint_unit_orbit_with_reviewed_change(
            &transaction,
            &login,
            &reviewed.hierarchy_change(),
        )
        .await
        .c(h!())?;
        if outcome.hierarchy_updated {
            summary.changed += 1;
        } else {
            summary.stale += 1;
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        orbit_unit, orbit_unit_echelon, orbit_unit_sigint_unit,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[test]
    fn orders_shared_names_by_echelon_then_case_insensitive_name() {
        let units = vec![
            unit(1, true, ["e", "x", "", "", "", ""]),
            unit(2, true, ["E", "y", "", "", "", ""]),
            unit(3, true, ["D", "m", "", "", "", ""]),
            unit(4, true, ["d", "n", "", "", "", ""]),
            unit(5, true, ["b1", "A", "c", "", "", ""]),
            unit(6, true, ["b2", "a", "d", "", "", ""]),
        ];
        let brigade_anchors = collect_anchors(&units, UniqueEchelon::Brigade);
        let division_anchors = collect_anchors(&units, UniqueEchelon::Division);
        let handled = HashSet::new();
        let brigade_conflicts = brigade_anchors
            .iter()
            .filter_map(|anchor| {
                next_conflict_for_anchor(&units, anchor, &handled)
                    .map(|conflict| (anchor, conflict))
            })
            .collect::<Vec<_>>();

        assert_eq!(brigade_conflicts[0].0.echelon, UniqueEchelon::Brigade);
        assert_eq!(brigade_conflicts[0].0.normalized_name, "d");
        assert_eq!(brigade_conflicts[1].0.echelon, UniqueEchelon::Brigade);
        assert_eq!(brigade_conflicts[1].0.normalized_name, "e");
        assert!(division_anchors.iter().any(|anchor| {
            anchor.echelon == UniqueEchelon::Division
                && anchor.normalized_name == "a"
                && next_conflict_for_anchor(&units, anchor, &handled)
                    .is_some_and(|conflict| {
                        conflict.conflicting_echelon == UniqueEchelon::Corps
                    })
        }));
    }

    #[test]
    fn handles_each_conflicting_higher_echelon_separately() {
        let mut units = vec![
            unit(1, true, ["X", "A", "C", "", "", ""]),
            unit(2, true, ["x", "B", "D", "", "", ""]),
        ];
        let anchor = HierarchyAnchor {
            echelon: UniqueEchelon::Brigade,
            normalized_name: "x".to_string(),
            unit_indexes: vec![0, 1],
        };
        let mut handled = HashSet::new();

        let division =
            next_conflict_for_anchor(&units, &anchor, &handled).unwrap();
        assert_eq!(division.conflicting_echelon, UniqueEchelon::Division);
        handled.insert(division.key(&units));
        apply_reviewed_choice(
            &mut units,
            &division,
            CopyDirection::FirstIntoSecond,
        );

        let corps =
            next_conflict_for_anchor(&units, &anchor, &handled).unwrap();
        assert_eq!(corps.conflicting_echelon, UniqueEchelon::Corps);
    }

    #[test]
    fn loads_context_for_units_that_can_join_a_later_conflict() {
        let units = vec![
            unit(1, true, ["X", "A", "C", "", "", ""]),
            unit(2, true, ["x", "B", "D", "", "", ""]),
            unit(3, true, ["Z", "a", "C", "", "", ""]),
        ];

        assert_eq!(review_context_unit_ids(&units), vec![1, 2, 3]);
    }

    #[test]
    fn can_copy_an_empty_higher_echelon() {
        let mut units = vec![
            unit(1, true, ["X", "", "", "", "", ""]),
            unit(2, true, ["x", "A", "", "", "", ""]),
        ];
        let anchor = HierarchyAnchor {
            echelon: UniqueEchelon::Brigade,
            normalized_name: "x".to_string(),
            unit_indexes: vec![0, 1],
        };
        let conflict =
            next_conflict_for_anchor(&units, &anchor, &HashSet::new()).unwrap();

        let reviewed = apply_reviewed_choice(
            &mut units,
            &conflict,
            CopyDirection::FirstIntoSecond,
        );

        assert_eq!(units[1].division, "");
        assert_eq!(
            reviewed.hierarchy_change().attributes,
            vec![OrbitUnitAttributeChange {
                attribute: "division",
                current: "A".to_string(),
                proposed: String::new(),
            }]
        );
    }

    #[test]
    fn groups_linked_orbit_hierarchies_from_low_to_high() {
        let first_orbit_unit_id = Uuid::new_v4();
        let second_orbit_unit_id = Uuid::new_v4();
        let hierarchies = group_linked_orbit_hierarchies(vec![
            LinkedOrbitHierarchyRow {
                sigint_unit_id: 1,
                orbit_unit_id: first_orbit_unit_id,
                structural_name_full: Some(
                    "74th brigade / 47th division".to_string(),
                ),
                depth: 1,
                echelon_key: Some("division".to_string()),
                preferred_name: "47 тд".to_string(),
            },
            LinkedOrbitHierarchyRow {
                sigint_unit_id: 1,
                orbit_unit_id: first_orbit_unit_id,
                structural_name_full: Some(
                    "74th brigade / 47th division".to_string(),
                ),
                depth: 0,
                echelon_key: Some("brigade".to_string()),
                preferred_name: "74 омсбр".to_string(),
            },
            LinkedOrbitHierarchyRow {
                sigint_unit_id: 1,
                orbit_unit_id: second_orbit_unit_id,
                structural_name_full: None,
                depth: 0,
                echelon_key: None,
                preferred_name: "unknown echelon".to_string(),
            },
        ]);

        let orbit_units = &hierarchies[&1];
        let first = orbit_units
            .iter()
            .find(|unit| unit.orbit_unit_id == first_orbit_unit_id)
            .unwrap();
        assert_eq!(
            first.levels,
            vec![
                LinkedOrbitHierarchyLevel {
                    echelon: Some(super::super::EchoEchelon::Brigade),
                    name: "74 омсбр".to_string(),
                },
                LinkedOrbitHierarchyLevel {
                    echelon: Some(super::super::EchoEchelon::Division),
                    name: "47 тд".to_string(),
                },
            ]
        );
        assert_eq!(
            orbit_hierarchy_for_review(first, UniqueEchelon::Division)
                .into_iter()
                .map(|level| (level.name, level.is_conflicting))
                .collect::<Vec<_>>(),
            vec![
                ("74th brigade".to_string(), false),
                ("47th division".to_string(), true),
            ],
        );
        assert!(orbit_units.iter().any(|unit| {
            unit.orbit_unit_id == second_orbit_unit_id
                && unit.levels[0].echelon.is_none()
        }));
    }

    #[tokio::test]
    #[serial]
    async fn loads_every_linked_structural_hierarchy_without_operational_parents(
    ) {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let brigade_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("brigade"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let division_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("division"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let army_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("fieldArmy"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let structural_parent = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name_short: Set(Some("47 тд".to_string())),
            unit_echelon_id: Set(Some(division_echelon_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let operational_parent = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name_short: Set(Some("1 ТА".to_string())),
            unit_echelon_id: Set(Some(army_echelon_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let first_orbit_unit = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name_short: Set(Some("74 омсбр".to_string())),
            unit_echelon_id: Set(Some(brigade_echelon_id)),
            generative_parent_unit_id: Set(Some(structural_parent.unit_id)),
            operational_parent_unit_id: Set(Some(operational_parent.unit_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let second_orbit_unit = orbit_unit::ActiveModel {
            unit_id: Set(Uuid::new_v4()),
            unit_name_short: Set(Some("75 омсбр".to_string())),
            unit_echelon_id: Set(Some(brigade_echelon_id)),
            generative_parent_unit_id: Set(Some(structural_parent.unit_id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let sigint_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for orbit_unit_id in
            [first_orbit_unit.unit_id, second_orbit_unit.unit_id]
        {
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(orbit_unit_id),
                sigint_unit_id: Set(sigint_unit.id),
                is_manual: Set(true),
                is_suppressed: Set(false),
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }

        let hierarchies =
            load_linked_orbit_hierarchies(&env.dbx, &[sigint_unit.id])
                .await
                .unwrap();

        let orbit_units = &hierarchies[&sigint_unit.id];
        assert_eq!(orbit_units.len(), 2);
        for orbit_unit in orbit_units {
            assert_eq!(
                orbit_unit
                    .levels
                    .iter()
                    .map(|level| level.name.as_str())
                    .collect::<Vec<_>>(),
                vec![
                    if orbit_unit.orbit_unit_id == first_orbit_unit.unit_id {
                        "74 омсбр"
                    } else {
                        "75 омсбр"
                    },
                    "47 тд",
                ]
            );
            assert!(!orbit_unit
                .levels
                .iter()
                .any(|level| level.name == "1 ТА"));
        }
    }

    #[tokio::test]
    #[serial]
    async fn persists_only_reviewed_units_in_the_activity_scope() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let brigade = uuid::Uuid::new_v4().simple().to_string();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("first active".to_string()),
                brigade: Set(brigade.to_uppercase()),
                division: Set("division A".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("second active".to_string()),
                brigade: Set(brigade.clone()),
                division: Set("division B".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inactive = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("inactive".to_string()),
                brigade: Set(brigade.clone()),
                division: Set("division C".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut units =
            load_units(&env.dbx, None, false, tui::UnitActivityScope::Active)
                .await
                .unwrap();
        let anchor = collect_anchors(&units, UniqueEchelon::Brigade)
            .into_iter()
            .find(|anchor| {
                anchor.echelon == UniqueEchelon::Brigade
                    && anchor.normalized_name == brigade
            })
            .unwrap();
        let conflict =
            next_conflict_for_anchor(&units, &anchor, &HashSet::new()).unwrap();
        let reviewed = apply_reviewed_choice(
            &mut units,
            &conflict,
            CopyDirection::FirstIntoSecond,
        );

        let summary = persist_change_batch(
            &env.dbx,
            &[reviewed],
            tui::UnitActivityScope::Active,
        )
        .await
        .unwrap();

        assert_eq!(summary.changed, 1);
        assert_eq!(summary.stale, 0);
        let first = sigint_unit::Entity::find_by_id(first.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let second = sigint_unit::Entity::find_by_id(second.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let inactive = sigint_unit::Entity::find_by_id(inactive.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.division, second.division);
        assert_eq!(inactive.division, "division C");
    }

    fn unit(id: i64, active: bool, hierarchy: [&str; 6]) -> HierarchyUnit {
        let [brigade, division, corps, army, army_region, military_district] =
            hierarchy;
        HierarchyUnit {
            id,
            name: format!("unit {id}"),
            active,
            brigade: brigade.to_string(),
            division: division.to_string(),
            corps: corps.to_string(),
            army: army.to_string(),
            army_region: army_region.to_string(),
            military_district: military_district.to_string(),
        }
    }
}
