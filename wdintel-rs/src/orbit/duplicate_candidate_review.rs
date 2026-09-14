use super::{matching, tui};
use crate::config::ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE;
use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait,
    FromQueryResult, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationTrait, Statement,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct ReviewPlan {
    units: BTreeMap<i64, sigint_unit::Model>,
    links_by_unit_id:
        BTreeMap<i64, BTreeMap<Uuid, orbit_unit_sigint_unit::Model>>,
    orbit_hierarchies: BTreeMap<Uuid, [String; 14]>,
    pairs: Vec<ReviewPair>,
}

#[derive(Debug, Clone)]
struct ReviewPair {
    unit_ids: UnitPairIds,
}

#[derive(Debug, FromQueryResult)]
struct OrbitHierarchyUnit {
    unit_id: Uuid,
    generative_parent_unit_id: Option<Uuid>,
    echelon_key: Option<String>,
    preferred_name: Option<String>,
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
    reviewed_unit_to_delete: ReviewedUnitContents,
    reviewed_survivor: ReviewedUnitContents,
    reviewed_unit_to_delete_orbit_unit_ids: BTreeSet<Uuid>,
    reviewed_survivor_orbit_unit_ids: BTreeSet<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReviewedUnitContents {
    id: i64,
    name: String,
    active: bool,
    hierarchy: [String; 14],
    comment: String,
    orbit_note: Option<String>,
    sigint_origin_id: Option<i64>,
    original_id: Option<i64>,
}

impl From<&sigint_unit::Model> for ReviewedUnitContents {
    fn from(unit: &sigint_unit::Model) -> Self {
        Self {
            id: unit.id,
            name: unit.name.clone(),
            active: unit.active,
            hierarchy: matching::sigint_hierarchy(unit)
                .map(|(_, value)| value.to_string()),
            comment: unit.comment.clone(),
            orbit_note: unit.orbit_note.clone(),
            sigint_origin_id: unit.sigint_origin_id,
            original_id: unit.original_id,
        }
    }
}

#[derive(Debug, Default)]
struct PersistSelectionBatchOutcome {
    merged: usize,
    stale_selection: bool,
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

    fn record_merge(&mut self, unit_to_delete_id: i64, survivor_id: i64) {
        let unit_to_delete_id = self.canonical_id(unit_to_delete_id);
        let survivor_id = self.canonical_id(survivor_id);
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
        "SIGINT duplicate-candidate review: {reviewed} possible pairs, {selected} selected, {merged} units merged. A stale selection leaves it and all remaining selections unchanged."
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
    let links = load_candidate_links(&transaction, &candidate_ids)
        .await
        .c(h!())?;
    let orbit_hierarchies =
        load_orbit_hierarchies(&transaction, &links).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(build_review_plan(units, links, orbit_hierarchies))
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

async fn load_candidate_links<C>(
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
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())
}

async fn load_orbit_hierarchies<C>(
    db: &C,
    links: &[orbit_unit_sigint_unit::Model],
) -> anyhow::Result<BTreeMap<Uuid, [String; 14]>>
where
    C: ConnectionTrait,
{
    let orbit_unit_ids = links
        .iter()
        .map(|link| link.orbit_unit_id)
        .collect::<BTreeSet<_>>();
    load_orbit_hierarchies_for_unit_ids(db, &orbit_unit_ids)
        .await
        .c(h!())
}

pub(super) async fn load_orbit_hierarchies_for_unit_ids<C>(
    db: &C,
    orbit_unit_ids: &BTreeSet<Uuid>,
) -> anyhow::Result<BTreeMap<Uuid, [String; 14]>>
where
    C: ConnectionTrait,
{
    if orbit_unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let sql = r#"
        with recursive hierarchy_unit_ids(unit_id) as (
            select unnest($1::uuid[])

            union

            select parent.unit_id
            from hierarchy_unit_ids hierarchy
            inner join orbit_unit unit
                on unit.unit_id = hierarchy.unit_id
                and unit.deleted = false
            inner join orbit_unit parent
                on parent.unit_id = unit.generative_parent_unit_id
                and parent.deleted = false
        )
        select
            unit.unit_id,
            unit.generative_parent_unit_id,
            echelon.key as echelon_key,
            coalesce(
                nullif(btrim(unit.unit_name_short), ''),
                nullif(btrim(unit.unit_name), ''),
                nullif(btrim(unit.unit_name_original), ''),
                nullif(btrim(unit.unit_number), '')
            ) as preferred_name
        from hierarchy_unit_ids hierarchy
        inner join orbit_unit unit
            on unit.unit_id = hierarchy.unit_id
            and unit.deleted = false
        left join orbit_unit_echelon echelon
            on echelon.id = unit.unit_echelon_id
        order by unit.unit_id
    "#;
    let hierarchy_units =
        OrbitHierarchyUnit::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            sql,
            [orbit_unit_ids.iter().copied().collect::<Vec<_>>().into()],
        ))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect::<BTreeMap<_, _>>();
    let mut orbit_hierarchies = BTreeMap::new();
    for orbit_unit_id in orbit_unit_ids.iter().copied() {
        if let Some(hierarchy) =
            orbit_hierarchy_for_propagation(orbit_unit_id, &hierarchy_units)
                .c(h!())?
        {
            orbit_hierarchies.insert(orbit_unit_id, hierarchy);
        }
    }
    Ok(orbit_hierarchies)
}

fn orbit_hierarchy_for_propagation(
    orbit_unit_id: Uuid,
    hierarchy_units: &BTreeMap<Uuid, OrbitHierarchyUnit>,
) -> anyhow::Result<Option<[String; 14]>> {
    let orbit_unit = hierarchy_units.get(&orbit_unit_id).c(h!())?;
    let mut hierarchy = std::array::from_fn(|_| String::new());
    if !fill_orbit_hierarchy_level(orbit_unit, &mut hierarchy) {
        return Ok(None);
    }
    let mut visited = BTreeSet::from([orbit_unit_id]);
    let mut parent_id = orbit_unit.generative_parent_unit_id;
    while let Some(orbit_unit_id) = parent_id {
        if !visited.insert(orbit_unit_id) {
            return Ok(None);
        }
        let orbit_unit = hierarchy_units.get(&orbit_unit_id).c(h!())?;
        parent_id = orbit_unit.generative_parent_unit_id;
        fill_orbit_hierarchy_level(orbit_unit, &mut hierarchy);
    }
    Ok(Some(hierarchy))
}

fn fill_orbit_hierarchy_level(
    orbit_unit: &OrbitHierarchyUnit,
    hierarchy: &mut [String; 14],
) -> bool {
    let Some(echelon) = orbit_unit
        .echelon_key
        .as_deref()
        .and_then(super::echo_echelon)
    else {
        return false;
    };
    let Some(name) = orbit_unit.preferred_name.as_ref() else {
        return false;
    };
    let value = &mut hierarchy[echelon.index()];
    if !value.is_empty() {
        return false;
    }
    value.clone_from(name);
    true
}

fn build_review_plan(
    units: BTreeMap<i64, sigint_unit::Model>,
    links: Vec<orbit_unit_sigint_unit::Model>,
    orbit_hierarchies: BTreeMap<Uuid, [String; 14]>,
) -> ReviewPlan {
    let candidate_ids = units.keys().copied().collect::<BTreeSet<_>>();
    let mut unit_ids_by_orbit_unit = BTreeMap::<Uuid, BTreeSet<i64>>::new();
    let mut links_by_unit_id =
        BTreeMap::<i64, BTreeMap<Uuid, orbit_unit_sigint_unit::Model>>::new();
    for link in links {
        if candidate_ids.contains(&link.sigint_unit_id) && !link.is_suppressed {
            unit_ids_by_orbit_unit
                .entry(link.orbit_unit_id)
                .or_default()
                .insert(link.sigint_unit_id);
        }
        links_by_unit_id
            .entry(link.sigint_unit_id)
            .or_default()
            .insert(link.orbit_unit_id, link);
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
        .into_keys()
        .map(|unit_ids| ReviewPair { unit_ids })
        .collect();

    ReviewPlan {
        units,
        links_by_unit_id,
        orbit_hierarchies,
        pairs,
    }
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
    let mut projected_links_by_unit_id = plan.links_by_unit_id.clone();
    let mut displayed = 0;
    for source_pair in &plan.pairs {
        let Some(unit_ids) = tracker.next_pair(source_pair.unit_ids) else {
            continue;
        };
        let shared_orbit_unit_ids = projected_shared_orbit_unit_ids(
            &projected_links_by_unit_id,
            unit_ids,
        );
        if shared_orbit_unit_ids.is_empty() {
            continue;
        }
        displayed += 1;
        let pair = review_pair(
            &projected_units,
            &projected_links_by_unit_id,
            unit_ids,
            &shared_orbit_unit_ids,
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
                let selection = merge_selection(
                    &projected_units,
                    &projected_links_by_unit_id,
                    unit_ids.left_id,
                    unit_ids.right_id,
                )
                .c(h!())?;
                project_selection(
                    &mut projected_units,
                    &mut projected_links_by_unit_id,
                    &plan.orbit_hierarchies,
                    &selection,
                )
                .c(h!())?;
                tracker.record_merge(
                    selection.unit_to_delete_id,
                    selection.survivor_id,
                );
                selections.push(selection);
            }
            tui::SigintDuplicatePairReviewDecision::MergeRightIntoLeft => {
                let selection = merge_selection(
                    &projected_units,
                    &projected_links_by_unit_id,
                    unit_ids.right_id,
                    unit_ids.left_id,
                )
                .c(h!())?;
                project_selection(
                    &mut projected_units,
                    &mut projected_links_by_unit_id,
                    &plan.orbit_hierarchies,
                    &selection,
                )
                .c(h!())?;
                tracker.record_merge(
                    selection.unit_to_delete_id,
                    selection.survivor_id,
                );
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

fn merge_selection(
    units: &BTreeMap<i64, sigint_unit::Model>,
    links_by_unit_id: &BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    unit_to_delete_id: i64,
    survivor_id: i64,
) -> anyhow::Result<MergeSelection> {
    Ok(MergeSelection {
        unit_to_delete_id,
        survivor_id,
        reviewed_unit_to_delete: units.get(&unit_to_delete_id).c(h!())?.into(),
        reviewed_survivor: units.get(&survivor_id).c(h!())?.into(),
        reviewed_unit_to_delete_orbit_unit_ids: projected_active_orbit_unit_ids(
            links_by_unit_id,
            unit_to_delete_id,
        ),
        reviewed_survivor_orbit_unit_ids: projected_active_orbit_unit_ids(
            links_by_unit_id,
            survivor_id,
        ),
    })
}

fn projected_shared_orbit_unit_ids(
    links_by_unit_id: &BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    unit_ids: UnitPairIds,
) -> BTreeSet<Uuid> {
    let left_orbit_unit_ids =
        projected_active_orbit_unit_ids(links_by_unit_id, unit_ids.left_id);
    let right_orbit_unit_ids =
        projected_active_orbit_unit_ids(links_by_unit_id, unit_ids.right_id);
    left_orbit_unit_ids
        .intersection(&right_orbit_unit_ids)
        .copied()
        .collect()
}

fn projected_active_orbit_unit_ids(
    links_by_unit_id: &BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    unit_id: i64,
) -> BTreeSet<Uuid> {
    links_by_unit_id
        .get(&unit_id)
        .into_iter()
        .flat_map(BTreeMap::values)
        .filter(|link| !link.is_suppressed)
        .map(|link| link.orbit_unit_id)
        .collect()
}

fn review_pair(
    units: &BTreeMap<i64, sigint_unit::Model>,
    links_by_unit_id: &BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    unit_ids: UnitPairIds,
    shared_orbit_unit_ids: &BTreeSet<Uuid>,
) -> anyhow::Result<tui::SigintDuplicateReviewPair> {
    Ok(tui::SigintDuplicateReviewPair {
        left: review_unit(units.get(&unit_ids.left_id).c(h!())?),
        right: review_unit(units.get(&unit_ids.right_id).c(h!())?),
        left_orbit_unit_ids: projected_active_orbit_unit_ids(
            links_by_unit_id,
            unit_ids.left_id,
        )
        .into_iter()
        .collect(),
        right_orbit_unit_ids: projected_active_orbit_unit_ids(
            links_by_unit_id,
            unit_ids.right_id,
        )
        .into_iter()
        .collect(),
        shared_orbit_unit_ids: shared_orbit_unit_ids.iter().copied().collect(),
    })
}

fn project_selection(
    units: &mut BTreeMap<i64, sigint_unit::Model>,
    links_by_unit_id: &mut BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    orbit_hierarchies: &BTreeMap<Uuid, [String; 14]>,
    selection: &MergeSelection,
) -> anyhow::Result<()> {
    let unit_to_delete =
        units.get(&selection.unit_to_delete_id).cloned().c(h!())?;
    let survivor = units.get_mut(&selection.survivor_id).c(h!())?;
    *survivor = crate::sigint::unit::project_merged_unit_preserving_name(
        survivor,
        &unit_to_delete,
    );
    project_orbit_links(links_by_unit_id, selection);
    let active_orbit_unit_ids = links_by_unit_id
        .get(&selection.survivor_id)
        .into_iter()
        .flat_map(BTreeMap::values)
        .filter(|link| !link.is_suppressed)
        .map(|link| link.orbit_unit_id)
        .collect::<Vec<_>>();
    if let [orbit_unit_id] = active_orbit_unit_ids.as_slice() {
        if let Some(orbit_hierarchy) = orbit_hierarchies.get(orbit_unit_id) {
            crate::sigint::unit::orbit::propagate_orbit_hierarchy(
                survivor,
                orbit_hierarchy,
            );
        }
    }
    Ok(())
}

fn project_orbit_links(
    links_by_unit_id: &mut BTreeMap<
        i64,
        BTreeMap<Uuid, orbit_unit_sigint_unit::Model>,
    >,
    selection: &MergeSelection,
) {
    let links = links_by_unit_id
        .remove(&selection.unit_to_delete_id)
        .unwrap_or_default();
    let survivor_links =
        links_by_unit_id.entry(selection.survivor_id).or_default();
    for (_, mut link) in links {
        let existing_link = survivor_links.get(&link.orbit_unit_id);
        let is_manual =
            link.is_manual || existing_link.is_some_and(|link| link.is_manual);
        link.sigint_unit_id = selection.survivor_id;
        link.is_manual = is_manual;
        link.is_suppressed = !is_manual
            && (link.is_suppressed
                || existing_link.is_some_and(|link| link.is_suppressed));
        survivor_links.insert(link.orbit_unit_id, link);
    }
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
        let outcome = persist_selection_batch(db, selections).await.c(h!())?;
        merged += outcome.merged;
        if outcome.stale_selection {
            break;
        }
    }
    Ok(merged)
}

async fn persist_selection_batch(
    db: &sea_orm::DatabaseConnection,
    selections: &[MergeSelection],
) -> anyhow::Result<PersistSelectionBatchOutcome> {
    if selections.is_empty() {
        return Ok(PersistSelectionBatchOutcome::default());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let unit_ids = selections
        .iter()
        .flat_map(|selection| {
            [selection.unit_to_delete_id, selection.survivor_id]
        })
        .collect::<Vec<_>>();
    crate::sigint::unit::acquire_unit_merge_locks_for_ids(
        &transaction,
        &unit_ids,
    )
    .await
    .c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
        .await
        .c(h!())?;
    let mut outcome = PersistSelectionBatchOutcome::default();
    for selection in selections {
        if !persist_selection(&transaction, login, selection)
            .await
            .c(h!())?
        {
            outcome.stale_selection = true;
            break;
        }
        outcome.merged += 1;
    }
    transaction.commit().await.c(h!())?;
    Ok(outcome)
}

async fn persist_selection<C>(
    db: &C,
    login: Uuid,
    selection: &MergeSelection,
) -> anyhow::Result<bool>
where
    C: ConnectionTrait,
{
    if !current_merge_units_match_review(db, selection)
        .await
        .c(h!())?
    {
        return Ok(false);
    };
    let orbit_unit_ids_by_sigint_unit_id =
        active_orbit_unit_ids_by_sigint_unit_id(
            db,
            selection.unit_to_delete_id,
            selection.survivor_id,
        )
        .await
        .c(h!())?;
    let unit_to_delete_orbit_unit_ids = orbit_unit_ids_by_sigint_unit_id
        .get(&selection.unit_to_delete_id)
        .cloned()
        .unwrap_or_default();
    let survivor_orbit_unit_ids = orbit_unit_ids_by_sigint_unit_id
        .get(&selection.survivor_id)
        .cloned()
        .unwrap_or_default();
    if unit_to_delete_orbit_unit_ids.is_disjoint(&survivor_orbit_unit_ids)
        || unit_to_delete_orbit_unit_ids
            != selection.reviewed_unit_to_delete_orbit_unit_ids
        || survivor_orbit_unit_ids != selection.reviewed_survivor_orbit_unit_ids
    {
        return Ok(false);
    }
    crate::sigint::unit::merge_units_in_transaction_preserving_name(
        login,
        db,
        selection.unit_to_delete_id,
        selection.survivor_id,
    )
    .await
    .c(h!())?;
    Ok(true)
}

async fn current_merge_units_match_review<C>(
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
        .lock_exclusive()
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
    Ok(ReviewedUnitContents::from(unit_to_delete)
        == selection.reviewed_unit_to_delete
        && ReviewedUnitContents::from(survivor) == selection.reviewed_survivor)
}

async fn active_orbit_unit_ids_by_sigint_unit_id<C>(
    db: &C,
    first_sigint_unit_id: i64,
    second_sigint_unit_id: i64,
) -> anyhow::Result<BTreeMap<i64, BTreeSet<Uuid>>>
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
    Ok(orbit_unit_ids_by_sigint_unit_id)
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
        tracker.record_merge(2, 1);

        assert_eq!(
            tracker.next_pair(UnitPairIds::new(2, 3).unwrap()),
            UnitPairIds::new(1, 3),
        );
    }

    #[test]
    fn tracker_skips_pairs_inside_already_merged_component() {
        let mut tracker = ReviewPairTracker::default();
        tracker.record_merge(2, 1);
        tracker.record_merge(3, 1);

        assert_eq!(tracker.next_pair(UnitPairIds::new(2, 3).unwrap()), None);
    }
}
