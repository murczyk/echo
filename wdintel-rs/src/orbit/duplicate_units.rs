use super::{matching, persistence, test_link, tui};
use crate::config::{
    ORBIT_DRY_RUN_REPORT_TOP_LIMIT, ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE,
};
use crate::entities::{
    orbit_sync, orbit_unit, orbit_unit_sigint_unit, sigint_unit,
};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct DuplicateCandidate {
    unit: sigint_unit::Model,
    orbit_match: test_link::ReviewMatch,
    automatically_matches: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MergeTier {
    ExactName,
    NormalizedHierarchy,
    InactiveSystemCreated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutomaticMerge {
    survivor_id: i64,
    tier: MergeTier,
}

#[derive(Debug, Clone)]
struct DuplicateGroup {
    orbit_unit_id: Uuid,
    candidates: Vec<DuplicateCandidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum DuplicateBlocker {
    MultiLinkMember,
    NoLongerMatches,
    AutomaticMatchRejected,
    IneligibleHierarchyConflict,
    SafeExactName,
    SafeNormalizedHierarchy,
    SafeInactiveSystemCreated,
}

impl DuplicateBlocker {
    fn label(self) -> &'static str {
        match self {
            Self::MultiLinkMember => "multi-link member",
            Self::NoLongerMatches => "no-longer-matching member",
            Self::AutomaticMatchRejected => "automatic match rejected",
            Self::IneligibleHierarchyConflict => {
                "ineligible hierarchy or metadata conflict"
            }
            Self::SafeExactName => "safe exact-name tier",
            Self::SafeNormalizedHierarchy => "safe normalized-hierarchy tier",
            Self::SafeInactiveSystemCreated => {
                "safe inactive-system-created tier"
            }
        }
    }
}

#[derive(Debug)]
struct DuplicateReportRow {
    blocker: DuplicateBlocker,
    orbit_unit_id: Uuid,
    units: Vec<sigint_unit::Model>,
    group: Option<DuplicateGroup>,
}

#[derive(Debug, Clone)]
struct DuplicateSelection {
    orbit_unit_id: Uuid,
    reviewed_orbit_sync: orbit_sync::Model,
    reviewed_units: BTreeMap<i64, sigint_unit::Model>,
    survivor_id: i64,
}

#[derive(Debug, Default)]
struct ManualReview {
    selections: Vec<DuplicateSelection>,
    skipped: usize,
    unreviewed: usize,
}

#[derive(Debug, Default)]
struct PersistReview {
    merged: usize,
    stale: usize,
}

pub async fn run(mode: Mode, dry_run: bool) -> anyhow::Result<()> {
    if dry_run {
        let db = new_pg_pool_from_mode(mode).await.c(h!())?;
        return print_dry_run_report(&db).await.c(h!());
    }
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db).await.c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let (orbit_sync, matcher) =
        persistence::load_latest_test_link_matcher_with_sync(db)
            .await
            .c(h!())?;
    let system_login_id = crate::users::system_login_id(db).await.c(h!())?;
    let groups =
        load_duplicate_groups(db, &matcher, system_login_id, false, None)
            .await
            .c(h!())?;
    let orbit_unit_ids = groups
        .iter()
        .map(|group| group.orbit_unit_id)
        .collect::<BTreeSet<_>>();
    let orbit_hierarchies =
        super::duplicate_candidate_review::load_orbit_hierarchies_for_unit_ids(
            db,
            &orbit_unit_ids,
        )
        .await
        .c(h!())?;
    let candidate_count = groups.len();
    let review =
        review_manually(&groups, &orbit_hierarchies, &orbit_sync).c(h!())?;
    let accepted = review.selections.len();
    let persisted = persist_selections(db, &review.selections).await.c(h!())?;
    let merged = persisted.merged;
    println!(
        "Duplicate-unit review: {candidate_count} candidates, {accepted} accepted, {} skipped, {} stale, {} unreviewed; {merged} units merged. Blocked groups were left unchanged.",
        review.skipped, persisted.stale, review.unreviewed,
    );
    Ok(())
}

async fn print_dry_run_report(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let (_, matcher) =
        persistence::load_latest_test_link_matcher_with_sync(db)
            .await
            .c(h!())?;
    let system_login_id = crate::users::system_login_id(db).await.c(h!())?;
    let rows =
        load_duplicate_report_rows(db, &matcher, system_login_id, false, None)
            .await
            .c(h!())?;
    println!(
        "Duplicate-unit dry run: {} duplicate ORBIT groups.",
        rows.len()
    );
    for blocker in [
        DuplicateBlocker::MultiLinkMember,
        DuplicateBlocker::NoLongerMatches,
        DuplicateBlocker::AutomaticMatchRejected,
        DuplicateBlocker::IneligibleHierarchyConflict,
        DuplicateBlocker::SafeExactName,
        DuplicateBlocker::SafeNormalizedHierarchy,
        DuplicateBlocker::SafeInactiveSystemCreated,
    ] {
        let mut matching_rows = rows
            .iter()
            .filter(|row| row.blocker == blocker)
            .collect::<Vec<_>>();
        matching_rows.sort_by_key(|row| {
            (std::cmp::Reverse(row.units.len()), row.orbit_unit_id)
        });
        let member_count = matching_rows
            .iter()
            .map(|row| row.units.len())
            .sum::<usize>();
        println!(
            "{}: {} groups / {} SIGINT members",
            blocker.label(),
            matching_rows.len(),
            member_count,
        );
        for row in matching_rows
            .into_iter()
            .take(ORBIT_DRY_RUN_REPORT_TOP_LIMIT)
        {
            println!(
                "  ORBIT {}: {}",
                row.orbit_unit_id,
                format_report_units(row),
            );
        }
    }
    Ok(())
}

fn format_report_units(row: &DuplicateReportRow) -> String {
    row.units
        .iter()
        .map(|unit| {
            let orbit_match = row.group.as_ref().and_then(|group| {
                group
                    .candidates
                    .iter()
                    .find(|candidate| candidate.unit.id == unit.id)
                    .map(|candidate| {
                        format!(
                            "rating={} distance={}",
                            candidate.orbit_match.rating,
                            candidate.orbit_match.distance,
                        )
                    })
            });
            format!(
                "SIGINT {} active={} name={:?}{}",
                unit.id,
                unit.active,
                unit.name,
                orbit_match
                    .map(|orbit_match| format!(" {orbit_match}"))
                    .unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

async fn load_duplicate_groups<C>(
    db: &C,
    matcher: &matching::TestLinkMatcher,
    system_login_id: Uuid,
    lock: bool,
    orbit_unit_ids: Option<&BTreeSet<Uuid>>,
) -> anyhow::Result<Vec<DuplicateGroup>>
where
    C: ConnectionTrait,
{
    Ok(load_duplicate_report_rows(
        db,
        matcher,
        system_login_id,
        lock,
        orbit_unit_ids,
    )
    .await
    .c(h!())?
    .into_iter()
    .filter_map(|row| row.group)
    .collect())
}

async fn load_duplicate_report_rows<C>(
    db: &C,
    matcher: &matching::TestLinkMatcher,
    system_login_id: Uuid,
    lock: bool,
    selected_orbit_unit_ids: Option<&BTreeSet<Uuid>>,
) -> anyhow::Result<Vec<DuplicateReportRow>>
where
    C: ConnectionTrait,
{
    let links = load_duplicate_links(db, selected_orbit_unit_ids, lock)
        .await
        .c(h!())?;
    let mut orbit_unit_ids_by_sigint_unit =
        BTreeMap::<i64, BTreeSet<Uuid>>::new();
    let mut sigint_unit_ids_by_orbit_unit =
        BTreeMap::<Uuid, BTreeSet<i64>>::new();
    for link in &links {
        orbit_unit_ids_by_sigint_unit
            .entry(link.sigint_unit_id)
            .or_default()
            .insert(link.orbit_unit_id);
        sigint_unit_ids_by_orbit_unit
            .entry(link.orbit_unit_id)
            .or_default()
            .insert(link.sigint_unit_id);
    }
    let duplicate_unit_ids = sigint_unit_ids_by_orbit_unit
        .values()
        .filter(|unit_ids| unit_ids.len() > 1)
        .flatten()
        .copied()
        .collect::<BTreeSet<_>>();
    if duplicate_unit_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(duplicate_unit_ids))
        .filter(sigint_unit::Column::Deleted.eq(false));
    if lock {
        units = units.lock_exclusive();
    }
    let units = units
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    let rows = build_duplicate_report_rows(
        sigint_unit_ids_by_orbit_unit,
        &orbit_unit_ids_by_sigint_unit,
        &units,
        matcher,
        system_login_id,
    );
    Ok(match selected_orbit_unit_ids {
        Some(orbit_unit_ids) => rows
            .into_iter()
            .filter(|row| orbit_unit_ids.contains(&row.orbit_unit_id))
            .collect(),
        None => rows,
    })
}

async fn load_duplicate_links<C>(
    db: &C,
    selected_orbit_unit_ids: Option<&BTreeSet<Uuid>>,
    lock: bool,
) -> anyhow::Result<Vec<orbit_unit_sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    Ok(match selected_orbit_unit_ids {
        Some(orbit_unit_ids) => {
            if orbit_unit_ids.is_empty() {
                return Ok(Vec::new());
            }
            let sigint_unit_ids =
                active_linked_sigint_unit_ids(db, orbit_unit_ids)
                    .await
                    .c(h!())?;
            if lock {
                lock_sigint_units(db, &sigint_unit_ids).await.c(h!())?;
                lock_orbit_units(db, orbit_unit_ids).await.c(h!())?;
                let locked_sigint_unit_ids =
                    active_linked_sigint_unit_ids(db, orbit_unit_ids)
                        .await
                        .c(h!())?;
                if locked_sigint_unit_ids != sigint_unit_ids {
                    return Ok(Vec::new());
                }
            }
            active_links(db, Some(&sigint_unit_ids), lock)
                .await
                .c(h!())?
        }
        None => active_links(db, None, lock).await.c(h!())?,
    })
}

fn build_duplicate_report_rows(
    sigint_unit_ids_by_orbit_unit: BTreeMap<Uuid, BTreeSet<i64>>,
    orbit_unit_ids_by_sigint_unit: &BTreeMap<i64, BTreeSet<Uuid>>,
    units: &BTreeMap<i64, sigint_unit::Model>,
    matcher: &matching::TestLinkMatcher,
    system_login_id: Uuid,
) -> Vec<DuplicateReportRow> {
    sigint_unit_ids_by_orbit_unit
        .into_iter()
        .filter(|(_, unit_ids)| unit_ids.len() > 1)
        .map(|(orbit_unit_id, unit_ids)| {
            let group_units = unit_ids
                .iter()
                .filter_map(|unit_id| units.get(unit_id).cloned())
                .collect::<Vec<_>>();
            if group_units.len() != unit_ids.len()
                || !has_only_shared_orbit_link(
                    &unit_ids,
                    orbit_unit_ids_by_sigint_unit,
                    orbit_unit_id,
                )
            {
                return DuplicateReportRow {
                    blocker: DuplicateBlocker::MultiLinkMember,
                    orbit_unit_id,
                    units: group_units,
                    group: None,
                };
            }
            let mut candidates = group_units
                .iter()
                .filter_map(|unit| {
                    test_link::review_match_for_orbit(
                        unit,
                        matcher,
                        tui::LinkMode::Manual,
                        orbit_unit_id,
                    )
                    .map(|orbit_match| {
                        DuplicateCandidate {
                            automatically_matches:
                                test_link::review_match_for_orbit(
                                    unit,
                                    matcher,
                                    tui::LinkMode::Automatic,
                                    orbit_unit_id,
                                )
                                .is_some(),
                            unit: unit.clone(),
                            orbit_match,
                        }
                    })
                })
                .collect::<Vec<_>>();
            if candidates.len() != unit_ids.len() {
                return DuplicateReportRow {
                    blocker: DuplicateBlocker::NoLongerMatches,
                    orbit_unit_id,
                    units: group_units,
                    group: None,
                };
            }
            sort_candidates(&mut candidates);
            let automatic_merge = automatic_merge(&candidates, system_login_id);
            let blocker = if candidates
                .iter()
                .any(|candidate| !candidate.automatically_matches)
            {
                DuplicateBlocker::AutomaticMatchRejected
            } else {
                match automatic_merge.as_ref().map(|merge| merge.tier) {
                    Some(MergeTier::ExactName) => {
                        DuplicateBlocker::SafeExactName
                    }
                    Some(MergeTier::NormalizedHierarchy) => {
                        DuplicateBlocker::SafeNormalizedHierarchy
                    }
                    Some(MergeTier::InactiveSystemCreated) => {
                        DuplicateBlocker::SafeInactiveSystemCreated
                    }
                    None => DuplicateBlocker::IneligibleHierarchyConflict,
                }
            };
            DuplicateReportRow {
                blocker,
                orbit_unit_id,
                units: group_units,
                group: Some(DuplicateGroup {
                    orbit_unit_id,
                    candidates,
                }),
            }
        })
        .collect()
}

fn has_only_shared_orbit_link(
    unit_ids: &BTreeSet<i64>,
    orbit_unit_ids_by_sigint_unit: &BTreeMap<i64, BTreeSet<Uuid>>,
    orbit_unit_id: Uuid,
) -> bool {
    unit_ids.iter().all(|unit_id| {
        orbit_unit_ids_by_sigint_unit.get(unit_id).is_some_and(
            |orbit_unit_ids| {
                orbit_unit_ids.len() == 1
                    && orbit_unit_ids.contains(&orbit_unit_id)
            },
        )
    })
}

async fn active_links<C>(
    db: &C,
    sigint_unit_ids: Option<&BTreeSet<i64>>,
    lock: bool,
) -> anyhow::Result<Vec<orbit_unit_sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let mut links = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false));
    if let Some(sigint_unit_ids) = sigint_unit_ids {
        if sigint_unit_ids.is_empty() {
            return Ok(Vec::new());
        }
        links = links.filter(
            orbit_unit_sigint_unit::Column::SigintUnitId
                .is_in(sigint_unit_ids.iter().copied()),
        );
    }
    if lock {
        links = links.lock_exclusive();
    }
    links.all(db).await.c(h!())
}

async fn lock_orbit_units<C>(
    db: &C,
    orbit_unit_ids: &BTreeSet<Uuid>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    orbit_unit::Entity::find()
        .filter(
            orbit_unit::Column::UnitId.is_in(orbit_unit_ids.iter().copied()),
        )
        .order_by_asc(orbit_unit::Column::UnitId)
        .lock_exclusive()
        .all(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn lock_sigint_units<C>(
    db: &C,
    sigint_unit_ids: &BTreeSet<i64>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if sigint_unit_ids.is_empty() {
        return Ok(());
    }
    sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids.iter().copied()))
        .order_by_asc(sigint_unit::Column::Id)
        .lock_exclusive()
        .all(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn active_linked_sigint_unit_ids<C>(
    db: &C,
    orbit_unit_ids: &BTreeSet<Uuid>,
) -> anyhow::Result<BTreeSet<i64>>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .select_only()
        .column(orbit_unit_sigint_unit::Column::SigintUnitId)
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .filter(
            orbit_unit_sigint_unit::Column::OrbitUnitId
                .is_in(orbit_unit_ids.iter().copied()),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

fn sort_candidates(candidates: &mut [DuplicateCandidate]) {
    candidates.sort_by_key(|candidate| {
        (
            !candidate.unit.active,
            std::cmp::Reverse(populated_field_count(&candidate.unit)),
            candidate.unit.id,
        )
    });
}

fn automatic_merge(
    candidates: &[DuplicateCandidate],
    system_login_id: Uuid,
) -> Option<AutomaticMerge> {
    if candidates.len() < 2
        || candidates
            .iter()
            .any(|candidate| !candidate.automatically_matches)
    {
        return None;
    }
    let survivor_id = preferred_survivor(candidates)?.unit.id;
    let tier = if exact_names(candidates) {
        MergeTier::ExactName
    } else if normalized_hierarchies_are_equivalent(candidates)
        && metadata_is_merge_safe(candidates, survivor_id)
    {
        MergeTier::NormalizedHierarchy
    } else if inactive_system_created_pair_is_safe(
        candidates,
        survivor_id,
        system_login_id,
    ) {
        MergeTier::InactiveSystemCreated
    } else {
        return None;
    };
    Some(AutomaticMerge { survivor_id, tier })
}

fn preferred_survivor(
    candidates: &[DuplicateCandidate],
) -> Option<&DuplicateCandidate> {
    candidates.iter().min_by_key(|candidate| {
        (
            !candidate.unit.active,
            std::cmp::Reverse(populated_field_count(&candidate.unit)),
            candidate.unit.id,
        )
    })
}

fn populated_field_count(unit: &sigint_unit::Model) -> usize {
    matching::sigint_hierarchy(unit)
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .count()
        + usize::from(!unit.comment.trim().is_empty())
        + usize::from(
            unit.orbit_note
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
        )
        + usize::from(unit.sigint_origin_id.is_some())
        + usize::from(unit.original_id.is_some())
        + usize::from(!unit_name_is_derived(unit))
}

fn exact_names(candidates: &[DuplicateCandidate]) -> bool {
    let Some(name) = candidates
        .first()
        .map(|candidate| candidate.unit.name.trim())
        .filter(|name| !name.is_empty())
    else {
        return false;
    };
    candidates
        .iter()
        .all(|candidate| candidate.unit.name.trim() == name)
}

fn normalized_hierarchy(unit: &sigint_unit::Model) -> Vec<String> {
    matching::sigint_hierarchy(unit)
        .into_iter()
        .map(|(echelon, value)| {
            matching::normalize_sigint_name_for_echelon(echelon, value)
        })
        .collect()
}

fn normalized_hierarchies_are_equivalent(
    candidates: &[DuplicateCandidate],
) -> bool {
    let Some(first) = candidates.first() else {
        return false;
    };
    let hierarchy = normalized_hierarchy(&first.unit);
    hierarchy.iter().any(|value| !value.is_empty())
        && candidates
            .iter()
            .skip(1)
            .all(|candidate| normalized_hierarchy(&candidate.unit) == hierarchy)
}

fn hierarchies_are_compatible(candidates: &[DuplicateCandidate]) -> bool {
    let normalized = candidates
        .iter()
        .map(|candidate| normalized_hierarchy(&candidate.unit))
        .collect::<Vec<_>>();
    for index in 0..matching::sigint_hierarchy(&candidates[0].unit).len() {
        let values = normalized
            .iter()
            .map(|hierarchy| hierarchy[index].as_str())
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>();
        if values.len() > 1 {
            return false;
        }
    }
    true
}

fn inactive_system_created_pair_is_safe(
    candidates: &[DuplicateCandidate],
    survivor_id: i64,
    system_login_id: Uuid,
) -> bool {
    if candidates.len() != 2 {
        return false;
    }
    let active = candidates
        .iter()
        .filter(|candidate| candidate.unit.active)
        .collect::<Vec<_>>();
    let inactive = candidates
        .iter()
        .filter(|candidate| !candidate.unit.active)
        .collect::<Vec<_>>();
    active.len() == 1
        && inactive.len() == 1
        && active[0].unit.id == survivor_id
        && inactive[0].unit.created_by_login_id == system_login_id
        && hierarchies_are_compatible(candidates)
        && metadata_is_merge_safe(candidates, survivor_id)
}

fn metadata_is_merge_safe(
    candidates: &[DuplicateCandidate],
    survivor_id: i64,
) -> bool {
    let Some(survivor) = candidates
        .iter()
        .find(|candidate| candidate.unit.id == survivor_id)
        .map(|candidate| &candidate.unit)
    else {
        return false;
    };
    string_values_are_compatible(
        candidates
            .iter()
            .map(|candidate| candidate.unit.comment.as_str()),
    ) && string_values_are_compatible(
        candidates
            .iter()
            .filter_map(|candidate| candidate.unit.orbit_note.as_deref()),
    ) && custom_names_are_preserved(candidates, survivor)
        && candidates.iter().all(|candidate| {
            option_is_preserved(
                survivor.sigint_origin_id,
                candidate.unit.sigint_origin_id,
            ) && option_is_preserved(
                survivor.original_id,
                candidate.unit.original_id,
            )
        })
}

fn string_values_are_compatible<'a>(
    values: impl Iterator<Item = &'a str>,
) -> bool {
    values
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .len()
        <= 1
}

fn custom_names_are_preserved(
    candidates: &[DuplicateCandidate],
    survivor: &sigint_unit::Model,
) -> bool {
    let custom_names = candidates
        .iter()
        .filter(|candidate| !unit_name_is_derived(&candidate.unit))
        .map(|candidate| matching::normalize_name(&candidate.unit.name))
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>();
    custom_names.is_empty()
        || (!unit_name_is_derived(survivor)
            && custom_names.len() == 1
            && custom_names.contains(&matching::normalize_name(&survivor.name)))
}

fn option_is_preserved<T: Copy + PartialEq>(
    survivor: Option<T>,
    duplicate: Option<T>,
) -> bool {
    duplicate.is_none() || duplicate == survivor
}

fn unit_name_is_derived(unit: &sigint_unit::Model) -> bool {
    unit.name.trim().is_empty()
        || unit.name == crate::sigint::unit::generated_unit_name(unit)
}

fn selection(
    group: &DuplicateGroup,
    survivor_id: i64,
    orbit_sync: &orbit_sync::Model,
) -> DuplicateSelection {
    DuplicateSelection {
        orbit_unit_id: group.orbit_unit_id,
        reviewed_orbit_sync: orbit_sync.clone(),
        reviewed_units: group
            .candidates
            .iter()
            .map(|candidate| (candidate.unit.id, candidate.unit.clone()))
            .collect(),
        survivor_id,
    }
}

fn review_manually(
    groups: &[DuplicateGroup],
    orbit_hierarchies: &BTreeMap<Uuid, [String; 14]>,
    orbit_sync: &orbit_sync::Model,
) -> anyhow::Result<ManualReview> {
    if groups.is_empty() {
        return Ok(ManualReview::default());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let review_result = review_manually_inner(
        &mut terminal,
        groups,
        orbit_hierarchies,
        orbit_sync,
    );
    tui::restore_terminal(&mut terminal).c(h!())?;
    review_result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    groups: &[DuplicateGroup],
    orbit_hierarchies: &BTreeMap<Uuid, [String; 14]>,
    orbit_sync: &orbit_sync::Model,
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    for (group_index, group) in groups.iter().enumerate() {
        let candidates = group
            .candidates
            .iter()
            .map(duplicate_review_candidate)
            .collect::<Vec<_>>();
        match tui::review_duplicate_unit_group(
            terminal,
            &candidates,
            group_index + 1,
            groups.len(),
        )
        .c(h!())?
        {
            tui::DuplicateReviewDecision::Select(candidate_index) => {
                let selection = selection(
                    group,
                    group.candidates[candidate_index].unit.id,
                    orbit_sync,
                );
                let merge_review = duplicate_merge_review(
                    group,
                    selection.survivor_id,
                    orbit_hierarchies.get(&group.orbit_unit_id),
                )
                .c(h!())?;
                match tui::review_sigint_duplicate_merge(
                    terminal,
                    &merge_review,
                    group_index + 1,
                    groups.len(),
                )
                .c(h!())?
                {
                    tui::UnitNameReviewDecision::Accept => {
                        review.selections.push(selection)
                    }
                    tui::UnitNameReviewDecision::Skip => review.skipped += 1,
                    tui::UnitNameReviewDecision::Quit => {
                        review.unreviewed = groups.len() - group_index;
                        break;
                    }
                }
            }
            tui::DuplicateReviewDecision::Skip => review.skipped += 1,
            tui::DuplicateReviewDecision::Quit => {
                review.unreviewed = groups.len() - group_index;
                break;
            }
        }
    }
    Ok(review)
}

fn duplicate_merge_review(
    group: &DuplicateGroup,
    survivor_id: i64,
    orbit_hierarchy: Option<&[String; 14]>,
) -> anyhow::Result<tui::SigintDuplicateMergeReview> {
    let survivor = group
        .candidates
        .iter()
        .find(|candidate| candidate.unit.id == survivor_id)
        .c(h!())?
        .unit
        .clone();
    let mut projected_survivor = survivor.clone();
    let mut merged_units = group
        .candidates
        .iter()
        .filter(|candidate| candidate.unit.id != survivor_id)
        .map(|candidate| candidate.unit.clone())
        .collect::<Vec<_>>();
    merged_units.sort_by_key(|unit| unit.id);
    for unit in &merged_units {
        projected_survivor =
            crate::sigint::unit::project_merged_unit_preserving_name(
                &projected_survivor,
                unit,
            );
        if let Some(orbit_hierarchy) = orbit_hierarchy {
            crate::sigint::unit::orbit::propagate_orbit_hierarchy(
                &mut projected_survivor,
                orbit_hierarchy,
            );
        }
    }
    Ok(tui::SigintDuplicateMergeReview {
        orbit_unit_id: group.orbit_unit_id,
        survivor: duplicate_merge_review_unit(&survivor),
        projected_survivor: duplicate_merge_review_unit(&projected_survivor),
        merged_units: merged_units
            .iter()
            .map(duplicate_merge_review_unit)
            .collect(),
    })
}

fn duplicate_merge_review_unit(
    unit: &sigint_unit::Model,
) -> tui::SigintDuplicateReviewUnit {
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

fn duplicate_review_candidate(
    candidate: &DuplicateCandidate,
) -> tui::DuplicateReviewCandidate {
    let echelons = matching::sigint_hierarchy(&candidate.unit)
        .into_iter()
        .map(|(_, name)| name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    tui::DuplicateReviewCandidate {
        unit: test_link::ReviewUnit {
            sigint_unit_id: candidate.unit.id,
            sigint_unit_name: candidate.unit.name.clone(),
            subject_kind: test_link::ReviewSubjectKind::SigintUnit,
            echelons,
            matches: vec![candidate.orbit_match.clone()],
            would_automatically_resolve: None,
        },
        active: candidate.unit.active,
    }
}

async fn persist_selections(
    db: &sea_orm::DatabaseConnection,
    selections: &[DuplicateSelection],
) -> anyhow::Result<PersistReview> {
    let mut review = PersistReview::default();
    for selections in
        selections.chunks(ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE)
    {
        let batch = persist_selection_batch(db, selections).await.c(h!())?;
        review.merged += batch.merged;
        review.stale += batch.stale;
    }
    Ok(review)
}

async fn persist_selection_batch(
    db: &sea_orm::DatabaseConnection,
    selections: &[DuplicateSelection],
) -> anyhow::Result<PersistReview> {
    if selections.is_empty() {
        return Ok(PersistReview::default());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let (orbit_sync, matcher) =
        persistence::load_latest_test_link_matcher_with_sync(&transaction)
            .await
            .c(h!())?;
    let current_selections = selections
        .iter()
        .filter(|selection| selection.reviewed_orbit_sync == orbit_sync)
        .collect::<Vec<_>>();
    let mut review = PersistReview {
        stale: selections.len() - current_selections.len(),
        ..Default::default()
    };
    if current_selections.is_empty() {
        transaction.commit().await.c(h!())?;
        return Ok(review);
    }
    let selected_orbit_unit_ids = current_selections
        .iter()
        .map(|selection| selection.orbit_unit_id)
        .collect::<BTreeSet<_>>();
    let current_groups = load_duplicate_groups(
        &transaction,
        &matcher,
        login,
        true,
        Some(&selected_orbit_unit_ids),
    )
    .await
    .c(h!())?
    .into_iter()
    .map(|group| (group.orbit_unit_id, group))
    .collect::<BTreeMap<_, _>>();
    for reviewed in current_selections {
        let Some(group) = current_groups.get(&reviewed.orbit_unit_id) else {
            review.stale += 1;
            continue;
        };
        let current_units = group
            .candidates
            .iter()
            .map(|candidate| (candidate.unit.id, candidate.unit.clone()))
            .collect::<BTreeMap<_, _>>();
        if current_units != reviewed.reviewed_units {
            review.stale += 1;
            continue;
        }
        let survivor_id = reviewed.survivor_id;
        if !current_units.contains_key(&survivor_id) {
            review.stale += 1;
            continue;
        }
        for duplicate_id in current_units
            .into_keys()
            .filter(|unit_id| *unit_id != survivor_id)
        {
            crate::sigint::unit::merge_units_in_transaction_preserving_name(
                login,
                &transaction,
                duplicate_id,
                survivor_id,
            )
            .await
            .c(h!())?;
            review.merged += 1;
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serial_test::serial;

    #[test]
    fn duplicate_merge_rejects_units_with_another_orbit_link() {
        let shared = Uuid::new_v4();
        let other = Uuid::new_v4();
        let unit_ids = BTreeSet::from([1, 2]);
        let links = BTreeMap::from([
            (1, BTreeSet::from([shared])),
            (2, BTreeSet::from([shared, other])),
        ]);

        assert!(!has_only_shared_orbit_link(&unit_ids, &links, shared));
    }

    #[test]
    fn exact_name_tier_prefers_active_survivor() {
        let system_login_id = Uuid::new_v4();
        let candidates = vec![
            candidate(unit(1, "4 мсб", false, system_login_id, "4 мсб", "")),
            candidate(unit(2, "4 мсб", true, Uuid::new_v4(), "4 мсб", "")),
        ];

        assert_eq!(
            automatic_merge(&candidates, system_login_id),
            Some(AutomaticMerge {
                survivor_id: 2,
                tier: MergeTier::ExactName,
            })
        );
    }

    #[test]
    fn normalized_hierarchy_tier_accepts_safe_qualifier_variants() {
        let candidates = vec![
            candidate(unit(
                1,
                "4 мсб (на БМП)",
                true,
                Uuid::new_v4(),
                "4 мсб (на БМП)",
                "",
            )),
            candidate(unit(2, "4 мсб", true, Uuid::new_v4(), "4 мсб", "")),
        ];

        assert_eq!(
            automatic_merge(&candidates, Uuid::new_v4())
                .map(|merge| merge.tier),
            Some(MergeTier::NormalizedHierarchy)
        );
    }

    #[test]
    fn inactive_system_created_tier_rejects_populated_hierarchy_conflict() {
        let system_login_id = Uuid::new_v4();
        let candidates = vec![
            candidate(unit(
                1,
                "4 мсб 60 омсбр",
                true,
                Uuid::new_v4(),
                "4 мсб",
                "60 омсбр",
            )),
            candidate(unit(
                2,
                "4 мсб 61 омсбр",
                false,
                system_login_id,
                "4 мсб",
                "61 омсбр",
            )),
        ];

        assert_eq!(automatic_merge(&candidates, system_login_id), None);
    }

    #[test]
    fn inactive_system_created_tier_accepts_missing_parent_fields() {
        let system_login_id = Uuid::new_v4();
        let candidates = vec![
            candidate(unit(1, "4 мсб", true, Uuid::new_v4(), "4 мсб", "")),
            candidate(unit(
                2,
                "4 мсб 60 омсбр",
                false,
                system_login_id,
                "4 мсб",
                "60 омсбр",
            )),
        ];

        assert_eq!(
            automatic_merge(&candidates, system_login_id),
            Some(AutomaticMerge {
                survivor_id: 1,
                tier: MergeTier::InactiveSystemCreated,
            })
        );
    }

    #[test]
    fn automatic_merge_rejects_a_custom_name_that_the_survivor_would_lose() {
        let system_login_id = Uuid::new_v4();
        let active = unit(1, "4 мсб", true, Uuid::new_v4(), "4 мсб", "");
        let inactive = unit(
            2,
            "Користувацька назва",
            false,
            system_login_id,
            "4 мсб",
            "60 омсбр",
        );
        let candidates = vec![candidate(active), candidate(inactive)];

        assert_eq!(automatic_merge(&candidates, system_login_id), None);
    }

    #[test]
    fn manual_merge_preview_preserves_the_survivor_name() {
        let survivor = unit(1, "4 мсб", true, Uuid::new_v4(), "4 мсб", "");
        let duplicate =
            unit(2, "60 омсбр", true, Uuid::new_v4(), "", "60 омсбр");
        let group = DuplicateGroup {
            orbit_unit_id: Uuid::new_v4(),
            candidates: vec![candidate(survivor), candidate(duplicate)],
        };
        let mut orbit_hierarchy = std::array::from_fn(|_| String::new());
        orbit_hierarchy[crate::orbit::EchoEchelon::Army.index()] =
            "20 ЗВА".to_string();

        let review =
            duplicate_merge_review(&group, 1, Some(&orbit_hierarchy)).unwrap();

        assert_eq!(review.projected_survivor.sigint_unit_name, "4 мсб");
        assert!(review.projected_survivor.hierarchy.iter().any(
            |(echelon, value)| {
                echelon == "brigade" && value == "60 омсбр"
            }
        ));
        assert!(review.projected_survivor.hierarchy.iter().any(
            |(echelon, value)| { echelon == "army" && value == "20 ЗВА" }
        ));
    }

    #[tokio::test]
    #[serial]
    async fn duplicate_selection_is_stale_after_an_orbit_revision_change() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let synced_at = Utc::now().naive_utc();
        let reviewed_synced_at = persistence::load_latest_sync(&env.dbx)
            .await
            .unwrap()
            .map(|orbit_sync| {
                synced_at
                    .max(orbit_sync.synced_at + chrono::Duration::seconds(1))
            })
            .unwrap_or(synced_at);
        let reviewed_orbit_sync = persistence::record_sync(
            &env.dbx,
            "11111111111111111111111111111111",
            reviewed_synced_at,
        )
        .await
        .unwrap();
        let current_orbit_sync = persistence::record_sync(
            &env.dbx,
            "22222222222222222222222222222222",
            reviewed_orbit_sync.synced_at + chrono::Duration::seconds(1),
        )
        .await
        .unwrap();
        let selection = DuplicateSelection {
            orbit_unit_id: Uuid::new_v4(),
            reviewed_orbit_sync: reviewed_orbit_sync.clone(),
            reviewed_units: BTreeMap::new(),
            survivor_id: 1,
        };

        let review = persist_selection_batch(&env.dbx, &[selection])
            .await
            .unwrap();
        orbit_sync::Entity::delete_by_id(current_orbit_sync.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        orbit_sync::Entity::delete_by_id(reviewed_orbit_sync.id)
            .exec(&env.dbx)
            .await
            .unwrap();

        assert_eq!(review.merged, 0);
        assert_eq!(review.stale, 1);
    }

    #[test]
    fn survivor_prefers_richer_unit_before_lower_id() {
        let candidates = vec![
            candidate(unit(1, "4 мсб", true, Uuid::new_v4(), "4 мсб", "")),
            candidate(unit(
                2,
                "4 мсб 60 омсбр",
                true,
                Uuid::new_v4(),
                "4 мсб",
                "60 омсбр",
            )),
        ];

        assert_eq!(preferred_survivor(&candidates).unwrap().unit.id, 2);
    }

    fn candidate(unit: sigint_unit::Model) -> DuplicateCandidate {
        DuplicateCandidate {
            orbit_match: test_link::ReviewMatch {
                unit_id: Uuid::new_v4(),
                rating: 100,
                distance: 0,
                orbit_name: unit.name.clone(),
            },
            unit,
            automatically_matches: true,
        }
    }

    fn unit(
        id: i64,
        name: &str,
        active: bool,
        created_by_login_id: Uuid,
        battalion: &str,
        brigade: &str,
    ) -> sigint_unit::Model {
        sigint_unit::Model {
            id,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            battalion: battalion.to_string(),
            regiment: String::new(),
            brigade: brigade.to_string(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            active,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id,
            name: name.to_string(),
            comment: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            is_inconsistent: false,
            updated_at: Utc::now().naive_utc(),
        }
    }
}
