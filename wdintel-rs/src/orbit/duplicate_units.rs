use super::{matching, persistence, test_link, tui};
use crate::config::ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE;
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
}

#[derive(Debug, Clone)]
struct DuplicateGroup {
    orbit_unit_id: Uuid,
    candidates: Vec<DuplicateCandidate>,
    would_automatically_resolve: bool,
}

#[derive(Debug, Clone)]
struct DuplicateSelection {
    orbit_unit_id: Uuid,
    reviewed_unit_ids: BTreeSet<i64>,
    survivor_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MergeAction {
    survivor_id: i64,
    survivor_name: String,
    duplicate_id: i64,
    duplicate_name: String,
}

pub async fn run(mode: Mode) -> anyhow::Result<()> {
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
    let groups = load_duplicate_groups(db, &matcher, link_mode)
        .await
        .c(h!())?;
    let reviewed = groups.len();
    let selections = match link_mode {
        tui::LinkMode::Automatic => {
            groups.iter().map(automatic_selection).collect::<Vec<_>>()
        }
        tui::LinkMode::Manual => review_manually(&groups).c(h!())?,
    };
    let selected = selections.len();
    let actions = persist_selections(db, &selections, link_mode)
        .await
        .c(h!())?;
    if link_mode == tui::LinkMode::Automatic {
        for action in &actions {
            println!(
                "merged {} [id {}] and {} [id {}]",
                action.survivor_name,
                action.survivor_id,
                action.duplicate_name,
                action.duplicate_id,
            );
        }
    }
    let merged = actions.len();
    println!(
        "Duplicate-unit review: {reviewed} safe groups, {selected} selected, {merged} units merged. Groups rejected by ORBIT matching were left unchanged."
    );
    Ok(())
}

async fn load_duplicate_groups<C>(
    db: &C,
    matcher: &matching::TestLinkMatcher,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<DuplicateGroup>>
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
    let mut groups = Vec::new();
    for (orbit_unit_id, unit_ids) in sigint_unit_ids_by_orbit_unit {
        if unit_ids.len() < 2
            || !has_only_shared_orbit_link(
                &unit_ids,
                &orbit_unit_ids_by_sigint_unit,
                orbit_unit_id,
            )
        {
            continue;
        }
        let candidates = unit_ids
            .iter()
            .filter_map(|unit_id| units.get(unit_id))
            .filter_map(|unit| {
                test_link::review_match_for_orbit(
                    unit,
                    matcher,
                    link_mode,
                    orbit_unit_id,
                )
                .map(|orbit_match| DuplicateCandidate {
                    unit: unit.clone(),
                    orbit_match,
                })
            })
            .collect::<Vec<_>>();
        if candidates.len() != unit_ids.len() {
            continue;
        }
        let mut group = DuplicateGroup {
            orbit_unit_id,
            candidates,
            would_automatically_resolve: unit_ids.iter().all(|unit_id| {
                units.get(unit_id).is_some_and(|unit| {
                    test_link::review_match_for_orbit(
                        unit,
                        matcher,
                        tui::LinkMode::Automatic,
                        orbit_unit_id,
                    )
                    .is_some()
                })
            }),
        };
        sort_candidates(&mut group.candidates);
        groups.push(group);
    }
    Ok(groups)
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
            std::cmp::Reverse(candidate.orbit_match.rating),
            candidate.orbit_match.distance,
            !candidate.unit.active,
            candidate.unit.id,
        )
    });
}

fn automatic_selection(group: &DuplicateGroup) -> DuplicateSelection {
    selection(group, group.candidates[0].unit.id)
}

fn selection(group: &DuplicateGroup, survivor_id: i64) -> DuplicateSelection {
    DuplicateSelection {
        orbit_unit_id: group.orbit_unit_id,
        reviewed_unit_ids: group
            .candidates
            .iter()
            .map(|candidate| candidate.unit.id)
            .collect(),
        survivor_id,
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
            group.would_automatically_resolve,
            group_index + 1,
            groups.len(),
        )
        .c(h!())?
        {
            tui::DuplicateReviewDecision::Select(candidate_index) => {
                selections.push(selection(
                    group,
                    group.candidates[candidate_index].unit.id,
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
    for selections in
        selections.chunks(ORBIT_DUPLICATE_UNITS_PERSIST_BATCH_SIZE)
    {
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
        load_duplicate_groups(&transaction, &matcher, link_mode)
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
        let survivor_id = match link_mode {
            tui::LinkMode::Automatic => automatic_selection(group).survivor_id,
            tui::LinkMode::Manual => reviewed.survivor_id,
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
                survivor_id,
                survivor_name: survivor_name.clone(),
                duplicate_id,
                duplicate_name,
            });
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
