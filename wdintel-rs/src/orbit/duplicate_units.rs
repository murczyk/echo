use super::{matching, persistence, test_link, tui};
use crate::config::{
    ORBIT_DRY_RUN_REPORT_TOP_LIMIT, ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE,
};
use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
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

impl MergeTier {
    fn label(self) -> &'static str {
        match self {
            Self::ExactName => "exact-name",
            Self::NormalizedHierarchy => "normalized-hierarchy",
            Self::InactiveSystemCreated => "inactive-system-created",
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::ExactName => "all SIGINT names are identical",
            Self::NormalizedHierarchy => {
                "all populated hierarchy fields normalize identically"
            }
            Self::InactiveSystemCreated => {
                "the inactive system-created unit has no hierarchy conflict with the active survivor"
            }
        }
    }
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
    automatic_merge: Option<AutomaticMerge>,
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
    reviewed_unit_ids: BTreeSet<i64>,
    survivor_id: i64,
    automatic_merge: Option<AutomaticMerge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MergeAction {
    orbit_unit_id: Uuid,
    survivor_id: i64,
    survivor_name: String,
    duplicate_id: i64,
    duplicate_name: String,
    automatic_merge: Option<AutomaticMerge>,
}

pub async fn run(mode: Mode, dry_run: bool) -> anyhow::Result<()> {
    if dry_run {
        let db = new_pg_pool_from_mode(mode).await.c(h!())?;
        return print_dry_run_report(&db).await.c(h!());
    }
    let Some(link_mode) = tui::prompt_link_mode().c(h!())? else {
        return Ok(());
    };
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, link_mode).await.c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    link_mode: tui::LinkMode,
) -> anyhow::Result<()> {
    let orbit_units = persistence::load_latest_synced_source_units(db)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let system_login_id = crate::users::system_login_id(db).await.c(h!())?;
    let groups =
        load_duplicate_groups(db, &matcher, link_mode, system_login_id)
            .await
            .c(h!())?;
    let reviewed = groups.len();
    let selections = match link_mode {
        tui::LinkMode::Automatic => groups
            .iter()
            .filter_map(automatic_selection)
            .collect::<Vec<_>>(),
        tui::LinkMode::Manual => review_manually(&groups).c(h!())?,
    };
    let selected = selections.len();
    let actions = persist_selections(db, &selections, link_mode)
        .await
        .c(h!())?;
    if link_mode == tui::LinkMode::Automatic {
        for action in &actions {
            let automatic_merge = action
                .automatic_merge
                .as_ref()
                .expect("automatic merge action must have a tier");
            println!(
                "auto-merged ORBIT {}: deleted {} [id {}], survivor {} [id {}], tier={}, reason={}",
                action.orbit_unit_id,
                action.duplicate_name,
                action.duplicate_id,
                action.survivor_name,
                action.survivor_id,
                automatic_merge.tier.label(),
                automatic_merge.tier.reason(),
            );
        }
    }
    let merged = actions.len();
    println!(
        "Duplicate-unit review: {reviewed} safe groups, {selected} selected, {merged} units merged. Blocked groups were left unchanged."
    );
    Ok(())
}

async fn print_dry_run_report(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let orbit_units = persistence::load_latest_synced_source_units(db)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let system_login_id = crate::users::system_login_id(db).await.c(h!())?;
    let rows = load_duplicate_report_rows(db, &matcher, system_login_id)
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
    link_mode: tui::LinkMode,
    system_login_id: Uuid,
) -> anyhow::Result<Vec<DuplicateGroup>>
where
    C: ConnectionTrait,
{
    Ok(load_duplicate_report_rows(db, matcher, system_login_id)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|row| row.group)
        .filter(|group| {
            link_mode == tui::LinkMode::Manual
                || group.automatic_merge.is_some()
        })
        .collect())
}

async fn load_duplicate_report_rows<C>(
    db: &C,
    matcher: &matching::TestLinkMatcher,
    system_login_id: Uuid,
) -> anyhow::Result<Vec<DuplicateReportRow>>
where
    C: ConnectionTrait,
{
    let links = active_links(db).await.c(h!())?;
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
    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(duplicate_unit_ids))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    Ok(build_duplicate_report_rows(
        sigint_unit_ids_by_orbit_unit,
        &orbit_unit_ids_by_sigint_unit,
        &units,
        matcher,
        system_login_id,
    ))
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
                    automatic_merge,
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
) -> anyhow::Result<Vec<orbit_unit_sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    orbit_unit_sigint_unit::Entity::find()
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
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())
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
        || unit.name
            == matching::sigint_hierarchy(unit)
                .into_iter()
                .map(|(_, value)| value.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
}

fn automatic_selection(group: &DuplicateGroup) -> Option<DuplicateSelection> {
    let automatic_merge = group.automatic_merge.clone()?;
    Some(selection(
        group,
        automatic_merge.survivor_id,
        Some(automatic_merge),
    ))
}

fn selection(
    group: &DuplicateGroup,
    survivor_id: i64,
    automatic_merge: Option<AutomaticMerge>,
) -> DuplicateSelection {
    DuplicateSelection {
        orbit_unit_id: group.orbit_unit_id,
        reviewed_unit_ids: group
            .candidates
            .iter()
            .map(|candidate| candidate.unit.id)
            .collect(),
        survivor_id,
        automatic_merge,
    }
}

fn review_manually(
    groups: &[DuplicateGroup],
) -> anyhow::Result<Vec<DuplicateSelection>> {
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let review_result = review_manually_inner(&mut terminal, groups);
    tui::restore_terminal(&mut terminal).c(h!())?;
    review_result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    groups: &[DuplicateGroup],
) -> anyhow::Result<Vec<DuplicateSelection>> {
    let mut selections = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        let candidates = group
            .candidates
            .iter()
            .map(duplicate_review_candidate)
            .collect::<Vec<_>>();
        match tui::review_duplicate_unit_group(
            terminal,
            &candidates,
            group.automatic_merge.is_some(),
            group_index + 1,
            groups.len(),
        )
        .c(h!())?
        {
            tui::DuplicateReviewDecision::Select(candidate_index) => {
                selections.push(selection(
                    group,
                    group.candidates[candidate_index].unit.id,
                    None,
                ));
            }
            tui::DuplicateReviewDecision::Skip => {}
            tui::DuplicateReviewDecision::Quit => return Ok(selections),
        }
    }
    Ok(selections)
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
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<MergeAction>> {
    let mut actions = Vec::new();
    let batch_size = match link_mode {
        tui::LinkMode::Automatic => 1,
        tui::LinkMode::Manual => ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE,
    };
    for selections in selections.chunks(batch_size) {
        actions.extend(
            persist_selection_batch(db, selections, link_mode)
                .await
                .c(h!())?,
        );
    }
    Ok(actions)
}

async fn persist_selection_batch(
    db: &sea_orm::DatabaseConnection,
    selections: &[DuplicateSelection],
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<MergeAction>> {
    if selections.is_empty() {
        return Ok(Vec::new());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let orbit_units =
        persistence::load_latest_synced_source_units(&transaction)
            .await
            .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let current_groups =
        load_duplicate_groups(&transaction, &matcher, link_mode, login)
            .await
            .c(h!())?
            .into_iter()
            .map(|group| (group.orbit_unit_id, group))
            .collect::<BTreeMap<_, _>>();
    let mut actions = Vec::new();
    for reviewed in selections {
        let Some(group) = current_groups.get(&reviewed.orbit_unit_id) else {
            continue;
        };
        let current_unit_ids = group
            .candidates
            .iter()
            .map(|candidate| candidate.unit.id)
            .collect::<BTreeSet<_>>();
        if current_unit_ids != reviewed.reviewed_unit_ids {
            continue;
        }
        let (survivor_id, automatic_merge) = match link_mode {
            tui::LinkMode::Automatic => {
                let Some(automatic_merge) = group.automatic_merge.clone()
                else {
                    continue;
                };
                if reviewed.automatic_merge.as_ref() != Some(&automatic_merge) {
                    continue;
                }
                (automatic_merge.survivor_id, Some(automatic_merge))
            }
            tui::LinkMode::Manual => (reviewed.survivor_id, None),
        };
        if !current_unit_ids.contains(&survivor_id) {
            continue;
        }
        let survivor_name = group
            .candidates
            .iter()
            .find(|candidate| candidate.unit.id == survivor_id)
            .expect("selected survivor must be present")
            .unit
            .name
            .clone();
        for duplicate_id in current_unit_ids
            .into_iter()
            .filter(|unit_id| *unit_id != survivor_id)
        {
            let duplicate_name = group
                .candidates
                .iter()
                .find(|candidate| candidate.unit.id == duplicate_id)
                .expect("duplicate must be present")
                .unit
                .name
                .clone();
            crate::sigint::unit::merge_units_in_transaction(
                login,
                &transaction,
                duplicate_id,
                survivor_id,
            )
            .await
            .c(h!())?;
            actions.push(MergeAction {
                orbit_unit_id: group.orbit_unit_id,
                survivor_id,
                survivor_name: survivor_name.clone(),
                duplicate_id,
                duplicate_name,
                automatic_merge: automatic_merge.clone(),
            });
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

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
