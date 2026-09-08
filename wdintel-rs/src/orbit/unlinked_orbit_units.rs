use super::{matching, persistence, test_link, tui, LinkProvenance};
use crate::entities::{orbit_sync, orbit_unit_sigint_unit, sigint_unit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
enum LinkAction {
    Link {
        orbit_unit_id: Uuid,
        sigint_unit_id: i64,
    },
    CreateInactive {
        orbit_unit_id: Uuid,
    },
}

#[derive(Default)]
struct ManualReview {
    actions: Vec<LinkAction>,
    skipped: usize,
    unreviewed: usize,
}

#[derive(Default)]
struct PersistSummary {
    linked: usize,
    created: usize,
    stale: usize,
}

impl PersistSummary {
    fn add(&mut self, other: Self) {
        self.linked += other.linked;
        self.created += other.created;
        self.stale += other.stale;
    }
}

struct ReviewData {
    orbit_sync: orbit_sync::Model,
    matcher: matching::TestLinkMatcher,
    reviews: Vec<tui::OrbitSigintLinkReview>,
    automatic_sigint_ids_by_orbit: BTreeMap<Uuid, BTreeSet<i64>>,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(link_mode) = tui::prompt_link_mode().c(h!())? else {
        return Ok(());
    };
    let activity_scope = if link_mode == tui::LinkMode::Automatic {
        let Some(activity_scope) = tui::prompt_unit_activity_scope(
            "Choose automatic ORBIT-to-SIGINT linking scope (↑/↓, Enter, Esc: quit)",
        )
        .c(h!())?
        else {
            return Ok(());
        };
        activity_scope
    } else {
        tui::UnitActivityScope::Both
    };
    let create_missing = if link_mode == tui::LinkMode::Automatic {
        let Some(action) = tui::prompt_missing_sigint_unit_action().c(h!())?
        else {
            return Ok(());
        };
        action == tui::MissingSigintUnitAction::CreateInactive
    } else {
        false
    };
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, link_mode, activity_scope, create_missing)
        .await
        .c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    link_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    create_missing: bool,
) -> anyhow::Result<()> {
    let review_data = load_review_data(db, activity_scope).await.c(h!())?;
    let candidate_count = review_data.reviews.len();
    let review = match link_mode {
        tui::LinkMode::Manual => {
            review_manually(&review_data.reviews).c(h!())?
        }
        tui::LinkMode::Automatic => {
            automatic_review(&review_data, create_missing)
        }
    };
    let selected = review.actions.len();
    let persisted =
        persist_actions(db, &review.actions, link_mode, activity_scope)
            .await
            .c(h!())?;
    println!(
        "ORBIT-to-SIGINT linking: {candidate_count} unlinked ORBIT units, {selected} selected, {} skipped, {} stale, {} unreviewed; {} linked and {} created inactive.",
        review.skipped,
        persisted.stale,
        review.unreviewed,
        persisted.linked,
        persisted.created,
    );
    Ok(())
}

async fn load_review_data<C>(
    db: &C,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<ReviewData>
where
    C: ConnectionTrait,
{
    let orbit_sync = persistence::load_latest_sync(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("ORBIT data has not been synchronized"))
        .c(h!())?;
    let linked_orbit_unit_ids = load_linked_orbit_unit_ids(db).await.c(h!())?;
    let matcher = persistence::load_test_link_matcher_excluding(
        db,
        &orbit_sync,
        &linked_orbit_unit_ids,
    )
    .await
    .c(h!())?;
    let sigint_units =
        test_link::load_linkable_sigint_units(db, false, activity_scope)
            .await
            .c(h!())?;
    let suppressed_links =
        test_link::load_suppressed_links(db).await.c(h!())?;
    let manual_matches = test_link::prepare_review_units(
        &sigint_units,
        &matcher,
        tui::LinkMode::Manual,
        &suppressed_links,
    );
    let automatic_matches = test_link::prepare_review_units(
        &sigint_units,
        &matcher,
        tui::LinkMode::Automatic,
        &suppressed_links,
    );
    let reviews =
        orbit_sigint_link_reviews(&matcher, &sigint_units, &manual_matches);
    Ok(ReviewData {
        orbit_sync,
        matcher,
        reviews,
        automatic_sigint_ids_by_orbit: automatic_sigint_ids_by_orbit(
            automatic_matches,
        ),
    })
}

async fn load_linked_orbit_unit_ids<C>(db: &C) -> anyhow::Result<BTreeSet<Uuid>>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .column(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .into_tuple::<Uuid>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect())
}

fn orbit_sigint_link_reviews(
    matcher: &matching::TestLinkMatcher,
    sigint_units: &[sigint_unit::Model],
    manual_matches: &[test_link::ReviewUnit],
) -> Vec<tui::OrbitSigintLinkReview> {
    let sigint_units = sigint_units
        .iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    let mut candidates_by_orbit =
        BTreeMap::<Uuid, Vec<tui::OrbitSigintLinkCandidate>>::new();
    for review in manual_matches {
        let Some(sigint_unit) = sigint_units.get(&review.sigint_unit_id) else {
            continue;
        };
        for candidate in &review.matches {
            candidates_by_orbit
                .entry(candidate.unit_id)
                .or_default()
                .push(tui::OrbitSigintLinkCandidate {
                    sigint_unit_id: review.sigint_unit_id,
                    sigint_unit_name: review.sigint_unit_name.clone(),
                    active: sigint_unit.active,
                    echelons: review.echelons.clone(),
                    rating: candidate.rating,
                    distance: candidate.distance,
                    orbit_name: candidate.orbit_name.clone(),
                });
        }
    }
    matcher
        .matchable_units()
        .map(|orbit_unit| {
            let mut candidates = candidates_by_orbit
                .remove(&orbit_unit.unit_id)
                .unwrap_or_default();
            candidates.sort_by_key(|candidate| {
                (
                    candidate.distance,
                    Reverse(candidate.rating),
                    candidate.sigint_unit_id,
                )
            });
            tui::OrbitSigintLinkReview {
                orbit_unit_id: orbit_unit.unit_id,
                orbit_name: orbit_display_name(orbit_unit),
                candidates,
            }
        })
        .collect()
}

fn orbit_display_name(unit: &super::types::SourceUnit) -> String {
    unit.operational_unit_name_full
        .as_deref()
        .or(unit.generative_unit_name_full.as_deref())
        .or(unit.unit_name.as_deref())
        .or(unit.unit_name_short.as_deref())
        .or(unit.unit_number.as_deref())
        .unwrap_or("<unnamed>")
        .to_string()
}

fn automatic_sigint_ids_by_orbit(
    review_units: Vec<test_link::ReviewUnit>,
) -> BTreeMap<Uuid, BTreeSet<i64>> {
    review_units
        .iter()
        .filter_map(test_link::automatically_approved_link)
        .fold(
            BTreeMap::new(),
            |mut matches, (sigint_unit_id, orbit_unit_id)| {
                matches
                    .entry(orbit_unit_id)
                    .or_insert_with(BTreeSet::new)
                    .insert(sigint_unit_id);
                matches
            },
        )
}

fn automatic_review(
    review_data: &ReviewData,
    create_missing: bool,
) -> ManualReview {
    let mut review = ManualReview::default();
    for candidate in &review_data.reviews {
        let automatic_matches = review_data
            .automatic_sigint_ids_by_orbit
            .get(&candidate.orbit_unit_id);
        match automatic_matches {
            Some(matches) if matches.len() == 1 => {
                review.actions.push(LinkAction::Link {
                    orbit_unit_id: candidate.orbit_unit_id,
                    sigint_unit_id: *matches
                        .first()
                        .expect("one automatic SIGINT match must exist"),
                });
            }
            None if candidate.candidates.is_empty() && create_missing => {
                review.actions.push(LinkAction::CreateInactive {
                    orbit_unit_id: candidate.orbit_unit_id,
                });
            }
            _ => review.skipped += 1,
        }
    }
    review
}

fn review_manually(
    reviews: &[tui::OrbitSigintLinkReview],
) -> anyhow::Result<ManualReview> {
    if reviews.is_empty() {
        return Ok(ManualReview::default());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let result = review_manually_inner(&mut terminal, reviews);
    tui::restore_terminal(&mut terminal).c(h!())?;
    result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    reviews: &[tui::OrbitSigintLinkReview],
) -> anyhow::Result<ManualReview> {
    let mut result = ManualReview::default();
    for (index, review) in reviews.iter().enumerate() {
        match tui::review_orbit_sigint_link(
            terminal,
            review,
            index + 1,
            reviews.len(),
        )
        .c(h!())?
        {
            tui::OrbitSigintLinkDecision::Link(sigint_unit_id) => {
                result.actions.push(LinkAction::Link {
                    orbit_unit_id: review.orbit_unit_id,
                    sigint_unit_id,
                });
            }
            tui::OrbitSigintLinkDecision::CreateInactive => {
                result.actions.push(LinkAction::CreateInactive {
                    orbit_unit_id: review.orbit_unit_id,
                });
            }
            tui::OrbitSigintLinkDecision::Skip => result.skipped += 1,
            tui::OrbitSigintLinkDecision::Quit => {
                if tui::confirm_test_link_exit(terminal).c(h!())? {
                    result.unreviewed = reviews.len() - index;
                    break;
                }
            }
        }
    }
    Ok(result)
}

async fn persist_actions(
    db: &sea_orm::DatabaseConnection,
    actions: &[LinkAction],
    link_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistSummary> {
    if actions.is_empty() {
        return Ok(PersistSummary::default());
    }
    if link_mode == tui::LinkMode::Automatic {
        return persist_automatic_actions(db, actions, activity_scope)
            .await
            .c(h!());
    }
    persist_action_batch(db, actions, link_mode, activity_scope)
        .await
        .c(h!())
}

async fn persist_automatic_actions(
    db: &sea_orm::DatabaseConnection,
    actions: &[LinkAction],
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistSummary> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let current = load_review_data(&transaction, activity_scope)
        .await
        .c(h!())?;
    let reviews = current
        .reviews
        .iter()
        .map(|review| (review.orbit_unit_id, review))
        .collect::<BTreeMap<_, _>>();
    let reviewed_action_count = actions.len();
    let actions = actions
        .iter()
        .filter(|action| {
            action_is_current(
                action,
                tui::LinkMode::Automatic,
                &current,
                &reviews,
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut summary = PersistSummary {
        stale: reviewed_action_count - actions.len(),
        ..Default::default()
    };
    transaction.commit().await.c(h!())?;
    for action in &actions {
        summary.add(
            persist_revalidated_automatic_action(
                db,
                action,
                activity_scope,
                &current,
            )
            .await
            .c(h!())?,
        );
    }
    Ok(summary)
}

async fn persist_action_batch(
    db: &sea_orm::DatabaseConnection,
    actions: &[LinkAction],
    link_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistSummary> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let current = load_review_data(&transaction, activity_scope)
        .await
        .c(h!())?;
    let reviews = current
        .reviews
        .iter()
        .map(|review| (review.orbit_unit_id, review))
        .collect::<BTreeMap<_, _>>();
    let mut summary = PersistSummary::default();
    for action in actions {
        if !action_is_current(action, link_mode, &current, &reviews) {
            summary.stale += 1;
            continue;
        }
        match action {
            LinkAction::Link {
                orbit_unit_id,
                sigint_unit_id,
            } => {
                let provenance = match link_mode {
                    tui::LinkMode::Automatic => LinkProvenance::Automatic,
                    tui::LinkMode::Manual => LinkProvenance::Manual,
                };
                let linked = crate::sigint::unit::orbit::link_orbit_unit_with_deferred_deduplicate_reconciliation(
                    &transaction,
                    &login,
                    *sigint_unit_id,
                    *orbit_unit_id,
                    provenance,
                )
                .await
                .c(h!())?
                .is_some();
                if linked {
                    summary.linked += 1;
                } else {
                    summary.stale += 1;
                }
            }
            LinkAction::CreateInactive { orbit_unit_id } => {
                let provenance = match link_mode {
                    tui::LinkMode::Automatic => LinkProvenance::Automatic,
                    tui::LinkMode::Manual => LinkProvenance::Manual,
                };
                match crate::sigint::unit::orbit::import_unlinked_orbit_unit_with_deferred_deduplicate_reconciliation(
                    &transaction,
                    &login,
                    *orbit_unit_id,
                    provenance,
                )
                .await {
                    Ok(Some(_)) => summary.created += 1,
                    Ok(None) => summary.stale += 1,
                    Err(err) => return Err(err).c(h!())?,
                }
            }
        }
    }
    if summary.linked > 0 || summary.created > 0 {
        super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

async fn persist_revalidated_automatic_action(
    db: &sea_orm::DatabaseConnection,
    action: &LinkAction,
    activity_scope: tui::UnitActivityScope,
    review_data: &ReviewData,
) -> anyhow::Result<PersistSummary> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let mut summary = PersistSummary::default();
    let latest_sync =
        persistence::load_latest_sync(&transaction).await.c(h!())?;
    if latest_sync.as_ref() != Some(&review_data.orbit_sync) {
        summary.stale += 1;
    } else {
        let login =
            crate::users::system_login_id(&transaction).await.c(h!())?;
        match action {
            LinkAction::Link {
                orbit_unit_id,
                sigint_unit_id,
            } => {
                let mut sigint_unit = sigint_unit::Entity::find_by_id(
                    *sigint_unit_id,
                )
                .filter(sigint_unit::Column::Deleted.eq(false));
                if let Some(active) = activity_scope.active() {
                    sigint_unit =
                        sigint_unit.filter(sigint_unit::Column::Active.eq(active));
                }
                let sigint_unit = sigint_unit
                    .lock_exclusive()
                    .one(&transaction)
                    .await
                    .c(h!())?;
                let suppressed = orbit_unit_sigint_unit::Entity::find_by_id((
                    *orbit_unit_id,
                    *sigint_unit_id,
                ))
                .one(&transaction)
                .await
                .c(h!())?
                .is_some_and(|link| link.is_suppressed);
                let orbit_linked = crate::sigint::unit::orbit::orbit_unit_has_active_sigint_link(
                    &transaction,
                    *orbit_unit_id,
                )
                .await
                .c(h!())?;
                let matches = sigint_unit.as_ref().is_some_and(|sigint_unit| {
                    test_link::review_match_for_orbit(
                        sigint_unit,
                        &review_data.matcher,
                        tui::LinkMode::Automatic,
                        *orbit_unit_id,
                    )
                    .is_some()
                });
                if suppressed || orbit_linked || !matches {
                    summary.stale += 1;
                } else {
                    let linked = crate::sigint::unit::orbit::link_orbit_unit_with_deferred_deduplicate_reconciliation(
                        &transaction,
                        &login,
                        *sigint_unit_id,
                        *orbit_unit_id,
                        LinkProvenance::Automatic,
                    )
                    .await
                    .c(h!())?
                    .is_some();
                    if linked {
                        summary.linked += 1;
                    } else {
                        summary.stale += 1;
                    }
                }
            }
            LinkAction::CreateInactive { orbit_unit_id } => {
                match crate::sigint::unit::orbit::import_unlinked_orbit_unit_with_deferred_deduplicate_reconciliation(
                    &transaction,
                    &login,
                    *orbit_unit_id,
                    LinkProvenance::Automatic,
                )
                .await {
                    Ok(Some(_)) => summary.created += 1,
                    Ok(None) => summary.stale += 1,
                    Err(err) => return Err(err).c(h!())?,
                }
            }
        }
    }
    if summary.linked > 0 || summary.created > 0 {
        super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

fn action_is_current(
    action: &LinkAction,
    link_mode: tui::LinkMode,
    current: &ReviewData,
    reviews: &BTreeMap<Uuid, &tui::OrbitSigintLinkReview>,
) -> bool {
    match action {
        LinkAction::Link {
            orbit_unit_id,
            sigint_unit_id,
        } => {
            let Some(review) = reviews.get(orbit_unit_id) else {
                return false;
            };
            match link_mode {
                tui::LinkMode::Manual => {
                    review.candidates.iter().any(|candidate| {
                        candidate.sigint_unit_id == *sigint_unit_id
                    })
                }
                tui::LinkMode::Automatic => current
                    .automatic_sigint_ids_by_orbit
                    .get(orbit_unit_id)
                    .is_some_and(|matches| {
                        matches.len() == 1 && matches.contains(sigint_unit_id)
                    }),
            }
        }
        LinkAction::CreateInactive { orbit_unit_id } => reviews
            .get(orbit_unit_id)
            .is_some_and(|review| review.candidates.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_review_links_unique_matches_and_only_creates_without_matches()
    {
        let linked_orbit_unit_id = Uuid::new_v4();
        let ambiguous_orbit_unit_id = Uuid::new_v4();
        let unmatched_orbit_unit_id = Uuid::new_v4();
        let candidate =
            |orbit_unit_id, candidates| tui::OrbitSigintLinkReview {
                orbit_unit_id,
                orbit_name: "unit".to_string(),
                candidates: (0..candidates)
                    .map(|index| tui::OrbitSigintLinkCandidate {
                        sigint_unit_id: index + 1,
                        sigint_unit_name: "unit".to_string(),
                        active: true,
                        echelons: Vec::new(),
                        rating: 100,
                        distance: 0,
                        orbit_name: "unit".to_string(),
                    })
                    .collect(),
            };
        let review_data = ReviewData {
            orbit_sync: orbit_sync::Model {
                id: 1,
                synced_at: chrono::Utc::now().naive_utc(),
                archive_md5: "archive".to_string(),
            },
            matcher: matching::TestLinkMatcher::from_units(Vec::new()),
            reviews: vec![
                candidate(linked_orbit_unit_id, 1),
                candidate(ambiguous_orbit_unit_id, 2),
                candidate(unmatched_orbit_unit_id, 0),
            ],
            automatic_sigint_ids_by_orbit: BTreeMap::from([
                (linked_orbit_unit_id, BTreeSet::from([1])),
                (ambiguous_orbit_unit_id, BTreeSet::from([1, 2])),
            ]),
        };

        let review = automatic_review(&review_data, true);

        assert_eq!(
            review.actions,
            vec![
                LinkAction::Link {
                    orbit_unit_id: linked_orbit_unit_id,
                    sigint_unit_id: 1,
                },
                LinkAction::CreateInactive {
                    orbit_unit_id: unmatched_orbit_unit_id,
                },
            ]
        );
        assert_eq!(review.skipped, 1);
    }
}
