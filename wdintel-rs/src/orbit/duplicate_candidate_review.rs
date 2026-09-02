use super::{matching, tui};
use crate::config::ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE;
use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct ReviewPlan {
    units: BTreeMap<i64, sigint_unit::Model>,
    pairs: Vec<ReviewPair>,
}

#[derive(Debug, Clone)]
struct ReviewPair {
    unit_ids: UnitPairIds,
    shared_orbit_unit_ids: BTreeSet<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct UnitPairIds {
    left_id: i64,
    right_id: i64,
}

impl UnitPairIds {
    fn new(first_id: i64, second_id: i64) -> Option<Self> {
        match first_id.cmp(&second_id) {
            std::cmp::Ordering::Less => Some(Self {
                left_id: first_id,
                right_id: second_id,
            }),
            std::cmp::Ordering::Greater => Some(Self {
                left_id: second_id,
                right_id: first_id,
            }),
            std::cmp::Ordering::Equal => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MergeSelection {
    unit_to_delete_id: i64,
    survivor_id: i64,
}

#[derive(Debug, Default)]
struct ReviewPairTracker {
    representative_by_unit_id: BTreeMap<i64, i64>,
    shown_pairs: BTreeSet<UnitPairIds>,
}

impl ReviewPairTracker {
    fn next_pair(&mut self, source_pair: UnitPairIds) -> Option<UnitPairIds> {
        let left_id = self.canonical_id(source_pair.left_id);
        let right_id = self.canonical_id(source_pair.right_id);
        let pair = UnitPairIds::new(left_id, right_id)?;
        self.shown_pairs.insert(pair).then_some(pair)
    }

    fn record_merge(&mut self, selection: &MergeSelection) {
        let unit_to_delete_id = self.canonical_id(selection.unit_to_delete_id);
        let survivor_id = self.canonical_id(selection.survivor_id);
        if unit_to_delete_id != survivor_id {
            self.representative_by_unit_id
                .insert(unit_to_delete_id, survivor_id);
        }
    }

    fn canonical_id(&self, unit_id: i64) -> i64 {
        let mut unit_id = unit_id;
        let mut seen = BTreeSet::new();
        while seen.insert(unit_id) {
            let Some(next_id) = self.representative_by_unit_id.get(&unit_id)
            else {
                break;
            };
            unit_id = *next_id;
        }
        unit_id
    }
}

pub async fn run(mode: Mode) -> anyhow::Result<()> {
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let plan = load_review_plan(&db).await.c(h!())?;
    let reviewed = plan.pairs.len();
    let selections = review_manually(&plan).c(h!())?;
    let selected = selections.len();
    let merged = persist_selections(&db, &selections).await.c(h!())?;
    println!(
        "SIGINT duplicate-candidate review: {reviewed} possible pairs, {selected} selected, {merged} units merged. Stale pairs were left unchanged."
    );
    Ok(())
}

async fn load_review_plan(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<ReviewPlan> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await
        .c(h!())?;
    let units = load_duplicate_candidate_units(&transaction).await.c(h!())?;
    let candidate_ids = units.keys().copied().collect::<BTreeSet<_>>();
    let links = load_active_candidate_links(&transaction, &candidate_ids)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(build_review_plan(units, &links))
}

async fn load_duplicate_candidate_units<C>(
    db: &C,
) -> anyhow::Result<BTreeMap<i64, sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::IsDeduplicateCandidate.eq(true))
        .order_by_asc(sigint_unit::Column::Id)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect())
}

async fn load_active_candidate_links<C>(
    db: &C,
    candidate_ids: &BTreeSet<i64>,
) -> anyhow::Result<Vec<orbit_unit_sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(
            orbit_unit_sigint_unit::Column::SigintUnitId
                .is_in(candidate_ids.iter().copied()),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())
}

fn build_review_plan(
    units: BTreeMap<i64, sigint_unit::Model>,
    links: &[orbit_unit_sigint_unit::Model],
) -> ReviewPlan {
    let candidate_ids = units.keys().copied().collect::<BTreeSet<_>>();
    let mut unit_ids_by_orbit_unit = BTreeMap::<Uuid, BTreeSet<i64>>::new();
    for link in links {
        if candidate_ids.contains(&link.sigint_unit_id) {
            unit_ids_by_orbit_unit
                .entry(link.orbit_unit_id)
                .or_default()
                .insert(link.sigint_unit_id);
        }
    }

    let mut shared_orbit_unit_ids_by_pair =
        BTreeMap::<UnitPairIds, BTreeSet<Uuid>>::new();
    for (orbit_unit_id, unit_ids) in unit_ids_by_orbit_unit {
        for pair in unit_pairs(&unit_ids) {
            shared_orbit_unit_ids_by_pair
                .entry(pair)
                .or_default()
                .insert(orbit_unit_id);
        }
    }

    let pairs = shared_orbit_unit_ids_by_pair
        .into_iter()
        .map(|(unit_ids, shared_orbit_unit_ids)| ReviewPair {
            unit_ids,
            shared_orbit_unit_ids,
        })
        .collect();

    ReviewPlan { units, pairs }
}

fn unit_pairs(unit_ids: &BTreeSet<i64>) -> Vec<UnitPairIds> {
    let unit_ids = unit_ids.iter().copied().collect::<Vec<_>>();
    let mut pairs = Vec::new();
    for (index, left_id) in unit_ids.iter().enumerate() {
        for right_id in &unit_ids[index + 1..] {
            let pair = UnitPairIds::new(*left_id, *right_id)
                .expect("unit pair must contain two different units");
            pairs.push(pair);
        }
    }
    pairs
}

fn review_manually(plan: &ReviewPlan) -> anyhow::Result<Vec<MergeSelection>> {
    if plan.pairs.is_empty() {
        return Ok(Vec::new());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let review_result = review_manually_inner(&mut terminal, plan);
    tui::restore_terminal(&mut terminal).c(h!())?;
    review_result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    plan: &ReviewPlan,
) -> anyhow::Result<Vec<MergeSelection>> {
    let mut selections = Vec::new();
    let mut tracker = ReviewPairTracker::default();
    let mut projected_units = plan.units.clone();
    let mut displayed = 0;
    for source_pair in &plan.pairs {
        let Some(unit_ids) = tracker.next_pair(source_pair.unit_ids) else {
            continue;
        };
        displayed += 1;
        let pair = review_pair(
            &projected_units,
            unit_ids,
            &source_pair.shared_orbit_unit_ids,
        )
        .c(h!())?;
        match tui::review_sigint_duplicate_pair(
            terminal,
            &pair,
            displayed,
            plan.pairs.len(),
        )
        .c(h!())?
        {
            tui::SigintDuplicatePairReviewDecision::MergeLeftIntoRight => {
                let selection = MergeSelection {
                    unit_to_delete_id: unit_ids.left_id,
                    survivor_id: unit_ids.right_id,
                };
                project_selection(&mut projected_units, &selection).c(h!())?;
                tracker.record_merge(&selection);
                selections.push(selection);
            }
            tui::SigintDuplicatePairReviewDecision::MergeRightIntoLeft => {
                let selection = MergeSelection {
                    unit_to_delete_id: unit_ids.right_id,
                    survivor_id: unit_ids.left_id,
                };
                project_selection(&mut projected_units, &selection).c(h!())?;
                tracker.record_merge(&selection);
                selections.push(selection);
            }
            tui::SigintDuplicatePairReviewDecision::Skip => {}
            tui::SigintDuplicatePairReviewDecision::Quit => {
                return Ok(selections);
            }
        }
    }
    Ok(selections)
}

fn review_pair(
    units: &BTreeMap<i64, sigint_unit::Model>,
    unit_ids: UnitPairIds,
    shared_orbit_unit_ids: &BTreeSet<Uuid>,
) -> anyhow::Result<tui::SigintDuplicateReviewPair> {
    Ok(tui::SigintDuplicateReviewPair {
        left: review_unit(units.get(&unit_ids.left_id).c(h!())?),
        right: review_unit(units.get(&unit_ids.right_id).c(h!())?),
        shared_orbit_unit_ids: shared_orbit_unit_ids.iter().copied().collect(),
    })
}

fn project_selection(
    units: &mut BTreeMap<i64, sigint_unit::Model>,
    selection: &MergeSelection,
) -> anyhow::Result<()> {
    let unit_to_delete =
        units.get(&selection.unit_to_delete_id).cloned().c(h!())?;
    let survivor = units.get_mut(&selection.survivor_id).c(h!())?;
    *survivor =
        crate::sigint::unit::project_merged_unit(survivor, &unit_to_delete);
    Ok(())
}

fn review_unit(unit: &sigint_unit::Model) -> tui::SigintDuplicateReviewUnit {
    tui::SigintDuplicateReviewUnit {
        sigint_unit_id: unit.id,
        sigint_unit_name: unit.name.clone(),
        active: unit.active,
        hierarchy: matching::sigint_hierarchy(unit)
            .into_iter()
            .map(|(echelon, value)| {
                (echelon_label(echelon).to_string(), value.to_string())
            })
            .collect(),
        comment: unit.comment.clone(),
        orbit_note: unit.orbit_note.clone(),
        sigint_origin_id: unit.sigint_origin_id,
        original_id: unit.original_id,
    }
}

fn echelon_label(echelon: super::EchoEchelon) -> &'static str {
    match echelon {
        super::EchoEchelon::Other => "other",
        super::EchoEchelon::TeamOrCrew => "team_or_crew",
        super::EchoEchelon::Section => "section",
        super::EchoEchelon::Squad => "squad",
        super::EchoEchelon::Platoon => "platoon",
        super::EchoEchelon::Company => "company",
        super::EchoEchelon::Battalion => "battalion",
        super::EchoEchelon::Regiment => "regiment",
        super::EchoEchelon::Brigade => "brigade",
        super::EchoEchelon::Division => "division",
        super::EchoEchelon::Corps => "corps",
        super::EchoEchelon::Army => "army",
        super::EchoEchelon::MilitaryDistrict => "military_district",
        super::EchoEchelon::ArmyRegion => "army_region",
    }
}

async fn persist_selections(
    db: &sea_orm::DatabaseConnection,
    selections: &[MergeSelection],
) -> anyhow::Result<usize> {
    let mut merged = 0;
    for selections in
        selections.chunks(ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE)
    {
        merged += persist_selection_batch(db, selections).await.c(h!())?;
    }
    Ok(merged)
}

async fn persist_selection_batch(
    db: &sea_orm::DatabaseConnection,
    selections: &[MergeSelection],
) -> anyhow::Result<usize> {
    if selections.is_empty() {
        return Ok(0);
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await
        .c(h!())?;
    let mut merged = 0;
    for selection in selections {
        merged += usize::from(
            persist_selection(&transaction, login, selection)
                .await
                .c(h!())?,
        );
    }
    transaction.commit().await.c(h!())?;
    Ok(merged)
}

async fn persist_selection<C>(
    db: &C,
    login: Uuid,
    selection: &MergeSelection,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    if !current_merge_units_available(db, selection).await.c(h!())? {
        return Ok(false);
    };
    if active_shared_orbit_unit_ids(
        db,
        selection.unit_to_delete_id,
        selection.survivor_id,
    )
    .await
    .c(h!())?
    .is_empty()
    {
        return Ok(false);
    }
    crate::sigint::unit::merge_units_in_transaction(
        login,
        db,
        selection.unit_to_delete_id,
        selection.survivor_id,
    )
    .await
    .c(h!())?;
    Ok(true)
}

async fn current_merge_units_available<C>(
    db: &C,
    selection: &MergeSelection,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    if selection.unit_to_delete_id == selection.survivor_id {
        return Ok(false);
    }
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::IsDeduplicateCandidate.eq(true))
        .filter(
            sigint_unit::Column::Id
                .is_in([selection.unit_to_delete_id, selection.survivor_id]),
        )
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    let Some(unit_to_delete) = units.get(&selection.unit_to_delete_id) else {
        return Ok(false);
    };
    let Some(survivor) = units.get(&selection.survivor_id) else {
        return Ok(false);
    };
    Ok(unit_to_delete.id != survivor.id)
}

async fn active_shared_orbit_unit_ids<C>(
    db: &C,
    first_sigint_unit_id: i64,
    second_sigint_unit_id: i64,
) -> anyhow::Result<BTreeSet<Uuid>>
where
    C: ConnectionTrait,
{
    let mut orbit_unit_ids_by_sigint_unit_id =
        BTreeMap::<i64, BTreeSet<Uuid>>::new();
    for link in orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(
            orbit_unit_sigint_unit::Column::SigintUnitId
                .is_in([first_sigint_unit_id, second_sigint_unit_id]),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
    {
        orbit_unit_ids_by_sigint_unit_id
            .entry(link.sigint_unit_id)
            .or_default()
            .insert(link.orbit_unit_id);
    }
    let Some(first_orbit_unit_ids) =
        orbit_unit_ids_by_sigint_unit_id.get(&first_sigint_unit_id)
    else {
        return Ok(BTreeSet::new());
    };
    let Some(second_orbit_unit_ids) =
        orbit_unit_ids_by_sigint_unit_id.get(&second_sigint_unit_id)
    else {
        return Ok(BTreeSet::new());
    };
    Ok(first_orbit_unit_ids
        .intersection(second_orbit_unit_ids)
        .copied()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_shows_unordered_pair_once() {
        let mut tracker = ReviewPairTracker::default();
        let pair = UnitPairIds::new(10, 20).unwrap();
        let reversed = UnitPairIds {
            left_id: 20,
            right_id: 10,
        };

        assert_eq!(tracker.next_pair(pair), Some(pair));
        assert_eq!(tracker.next_pair(reversed), None);
    }

    #[test]
    fn tracker_rewrites_pairs_through_selected_survivor() {
        let mut tracker = ReviewPairTracker::default();

        assert_eq!(
            tracker.next_pair(UnitPairIds::new(1, 2).unwrap()),
            UnitPairIds::new(1, 2),
        );
        tracker.record_merge(&MergeSelection {
            unit_to_delete_id: 2,
            survivor_id: 1,
        });

        assert_eq!(
            tracker.next_pair(UnitPairIds::new(2, 3).unwrap()),
            UnitPairIds::new(1, 3),
        );
    }

    #[test]
    fn tracker_skips_pairs_inside_already_merged_component() {
        let mut tracker = ReviewPairTracker::default();
        tracker.record_merge(&MergeSelection {
            unit_to_delete_id: 2,
            survivor_id: 1,
        });
        tracker.record_merge(&MergeSelection {
            unit_to_delete_id: 3,
            survivor_id: 1,
        });

        assert_eq!(tracker.next_pair(UnitPairIds::new(2, 3).unwrap()), None);
    }

    #[test]
    fn unit_pairs_are_sorted_and_unique() {
        assert_eq!(
            unit_pairs(&BTreeSet::from([3, 1, 2])),
            vec![
                UnitPairIds {
                    left_id: 1,
                    right_id: 2,
                },
                UnitPairIds {
                    left_id: 1,
                    right_id: 3,
                },
                UnitPairIds {
                    left_id: 2,
                    right_id: 3,
                },
            ],
        );
    }
}
