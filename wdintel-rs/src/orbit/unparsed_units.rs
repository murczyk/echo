use super::{matching, persistence, test_link, tui, EchoEchelon};
use crate::config::{
    ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
    ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE, ORBIT_DRY_RUN_REPORT_TOP_LIMIT,
    ORBIT_TEST_LINK_UNITS_MAX_RATING, ORBIT_UNPARSED_UNITS_PERSIST_BATCH_SIZE,
};
use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::inbox::unit_resolution::normalize_unit_label;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

type LinkInventory = BTreeMap<Uuid, BTreeSet<i64>>;

pub(super) struct UnitTextSigintResolver {
    matcher: matching::TestLinkMatcher,
    link_inventory: LinkInventory,
}

impl UnitTextSigintResolver {
    pub(super) async fn load<C>(db: &C) -> anyhow::Result<Self>
    where
        C: ConnectionTrait,
    {
        let orbit_units = persistence::load_latest_synced_source_units(db)
            .await
            .c(h!())?;
        Ok(Self {
            matcher: matching::TestLinkMatcher::from_units(orbit_units),
            link_inventory: load_link_inventory(db).await.c(h!())?,
        })
    }

    pub(super) fn resolve(
        &self,
        unit_txt: &str,
    ) -> anyhow::Result<Option<i64>> {
        let Some(hierarchy) = parsed_hierarchy(unit_txt) else {
            return Ok(None);
        };
        let hierarchy = hierarchy
            .iter()
            .map(|(echelon, name)| (*echelon, name.as_str()))
            .collect::<Vec<_>>();
        let Some(review_unit) = test_link::prepare_review_hierarchy(
            1,
            unit_txt,
            test_link::ReviewSubjectKind::UnparsedUnit,
            &hierarchy,
            &self.matcher,
            tui::LinkMode::Automatic,
            &BTreeSet::new(),
        ) else {
            return Ok(None);
        };
        let Some((_, orbit_unit_id)) =
            test_link::automatically_approved_link(&review_unit)
        else {
            return Ok(None);
        };
        let Some(sigint_unit_ids) = self.link_inventory.get(&orbit_unit_id)
        else {
            return Ok(None);
        };
        Ok(sigint_unit_ids
            .first()
            .copied()
            .filter(|_| sigint_unit_ids.len() == 1))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum UnparsedBlocker {
    ParserRejected,
    NonUnitAutoArchive,
    NoOrbitMatch,
    AmbiguousOrbitMatch,
    MatchQualityRejected,
    OrbitHasNoSigintLink,
    OrbitHasMultipleSigintLinks,
    AutomaticallyResolvable,
}

impl UnparsedBlocker {
    fn label(self) -> &'static str {
        match self {
            Self::ParserRejected => "parser rejected",
            Self::NonUnitAutoArchive => "non-unit auto-archive",
            Self::NoOrbitMatch => "no ORBIT match",
            Self::AmbiguousOrbitMatch => "ambiguous ORBIT match",
            Self::MatchQualityRejected => "match distance/rating rejected",
            Self::OrbitHasNoSigintLink => "ORBIT has no SIGINT link",
            Self::OrbitHasMultipleSigintLinks => {
                "ORBIT has multiple SIGINT links"
            }
            Self::AutomaticallyResolvable => "automatically resolvable",
        }
    }
}

#[derive(Debug)]
struct UnparsedReportRow {
    blocker: UnparsedBlocker,
    unit_txt: String,
    quantity: i64,
    candidates: Vec<test_link::ReviewMatch>,
}

#[derive(Debug, Clone)]
struct UnparsedSelection {
    subject_id: i64,
    unit_txt: String,
    orbit_unit_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LabelLinkAction {
    unit_txt: String,
    sigint_unit_name: String,
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
    let labels =
        crate::inbox::unresolved_units::load_new_unresolved_unit_labels(db)
            .await
            .c(h!())?;
    let orbit_units = persistence::load_latest_synced_source_units(db)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let link_inventory = load_link_inventory(db).await.c(h!())?;
    let review_units =
        prepare_review_units(&labels, &matcher, &link_inventory, link_mode)
            .c(h!())?;
    let (summary, links) = match link_mode {
        tui::LinkMode::Manual => {
            test_link::review_manually(review_units).c(h!())?
        }
        tui::LinkMode::Automatic => test_link::approve_automatic(review_units),
    };
    let labels_by_subject_id = labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            Ok((i64::try_from(index + 1).c(h!())?, label.unit_txt.clone()))
        })
        .collect::<anyhow::Result<BTreeMap<_, _>>>()
        .c(h!())?;
    let selections = links
        .into_iter()
        .filter_map(|(subject_id, orbit_unit_id)| {
            labels_by_subject_id.get(&subject_id).map(|unit_txt| {
                UnparsedSelection {
                    subject_id,
                    unit_txt: unit_txt.clone(),
                    orbit_unit_id,
                }
            })
        })
        .collect::<Vec<_>>();
    let actions = persist_selections(db, &selections, link_mode)
        .await
        .c(h!())?;
    let archived = if link_mode == tui::LinkMode::Automatic {
        archive_non_unit_labels(db, &labels).await.c(h!())?
    } else {
        0
    };
    if link_mode == tui::LinkMode::Automatic {
        for action in &actions {
            println!(
                "linked label {:?} to unit {}",
                action.unit_txt, action.sigint_unit_name,
            );
        }
    }
    let resolved = actions.len();
    println!(
        "Unparsed-unit review: accepted {}, denied {}, unreviewed {}; resolved {resolved} labels, archived {archived} non-unit labels.",
        summary.accepted, summary.denied, summary.unreviewed,
    );
    Ok(())
}

async fn print_dry_run_report(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let labels =
        crate::inbox::unresolved_units::load_new_unresolved_unit_labels(db)
            .await
            .c(h!())?;
    let orbit_units = persistence::load_latest_synced_source_units(db)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let link_inventory = load_link_inventory(db).await.c(h!())?;
    let rows = labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            classify_unparsed_label(
                i64::try_from(index + 1).c(h!())?,
                label,
                &matcher,
                &link_inventory,
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()
        .c(h!())?;
    println!("Unparsed-unit dry run: {} normalized labels.", rows.len());
    for blocker in [
        UnparsedBlocker::ParserRejected,
        UnparsedBlocker::NonUnitAutoArchive,
        UnparsedBlocker::NoOrbitMatch,
        UnparsedBlocker::AmbiguousOrbitMatch,
        UnparsedBlocker::MatchQualityRejected,
        UnparsedBlocker::OrbitHasNoSigintLink,
        UnparsedBlocker::OrbitHasMultipleSigintLinks,
        UnparsedBlocker::AutomaticallyResolvable,
    ] {
        let mut matching_rows = rows
            .iter()
            .filter(|row| row.blocker == blocker)
            .collect::<Vec<_>>();
        matching_rows.sort_by_key(|row| std::cmp::Reverse(row.quantity));
        let quantity =
            matching_rows.iter().map(|row| row.quantity).sum::<i64>();
        println!(
            "{}: {} labels / {} failed rows",
            blocker.label(),
            matching_rows.len(),
            quantity,
        );
        for row in matching_rows
            .into_iter()
            .take(ORBIT_DRY_RUN_REPORT_TOP_LIMIT)
        {
            println!(
                "  {:?}: {} rows; {}",
                row.unit_txt,
                row.quantity,
                format_report_candidates(&row.candidates, &link_inventory),
            );
        }
    }
    Ok(())
}

fn classify_unparsed_label(
    subject_id: i64,
    label: &crate::inbox::unresolved_units::UnresolvedUnitLabel,
    matcher: &matching::TestLinkMatcher,
    link_inventory: &LinkInventory,
) -> anyhow::Result<UnparsedReportRow> {
    let Some(hierarchy) = parsed_hierarchy(&label.unit_txt) else {
        let blocker =
            if crate::inbox::unit_resolution::should_auto_archive_failed_unit(
                &label.unit_txt,
            ) {
                UnparsedBlocker::NonUnitAutoArchive
            } else {
                UnparsedBlocker::ParserRejected
            };
        return Ok(UnparsedReportRow {
            blocker,
            unit_txt: label.unit_txt.clone(),
            quantity: label.quantity,
            candidates: Vec::new(),
        });
    };
    let hierarchy = hierarchy
        .iter()
        .map(|(echelon, name)| (*echelon, name.as_str()))
        .collect::<Vec<_>>();
    let manual = test_link::prepare_review_hierarchy(
        subject_id,
        &label.unit_txt,
        test_link::ReviewSubjectKind::UnparsedUnit,
        &hierarchy,
        matcher,
        tui::LinkMode::Manual,
        &BTreeSet::new(),
    );
    let Some(automatic) = test_link::prepare_review_hierarchy(
        subject_id,
        &label.unit_txt,
        test_link::ReviewSubjectKind::UnparsedUnit,
        &hierarchy,
        matcher,
        tui::LinkMode::Automatic,
        &BTreeSet::new(),
    ) else {
        return Ok(UnparsedReportRow {
            blocker: UnparsedBlocker::NoOrbitMatch,
            unit_txt: label.unit_txt.clone(),
            quantity: label.quantity,
            candidates: manual.map_or_else(Vec::new, |unit| unit.matches),
        });
    };
    let automatically_approved =
        test_link::automatically_approved_link(&automatic);
    let blocker = match automatically_approved {
        None if automatic_match_is_ambiguous(&automatic) => {
            UnparsedBlocker::AmbiguousOrbitMatch
        }
        None => UnparsedBlocker::MatchQualityRejected,
        Some((_, orbit_unit_id)) => {
            match link_inventory.get(&orbit_unit_id).map_or(0, BTreeSet::len) {
                0 => UnparsedBlocker::OrbitHasNoSigintLink,
                1 => UnparsedBlocker::AutomaticallyResolvable,
                _ => UnparsedBlocker::OrbitHasMultipleSigintLinks,
            }
        }
    };
    Ok(UnparsedReportRow {
        blocker,
        unit_txt: label.unit_txt.clone(),
        quantity: label.quantity,
        candidates: automatic.matches,
    })
}

fn automatic_match_is_ambiguous(unit: &test_link::ReviewUnit) -> bool {
    let minimum_distance = unit
        .matches
        .iter()
        .filter(|candidate| {
            candidate.rating == ORBIT_TEST_LINK_UNITS_MAX_RATING
                && candidate.distance
                    <= ORBIT_AUTO_LINK_MAX_LEVENSHTEIN_DISTANCE
        })
        .map(|candidate| candidate.distance)
        .min();
    minimum_distance.is_some_and(|minimum_distance| {
        unit.matches
            .iter()
            .filter(|candidate| {
                candidate.rating == ORBIT_TEST_LINK_UNITS_MAX_RATING
                    && candidate.distance == minimum_distance
            })
            .count()
            > 1
    })
}

fn format_report_candidates(
    candidates: &[test_link::ReviewMatch],
    link_inventory: &LinkInventory,
) -> String {
    if candidates.is_empty() {
        return "candidates: none".to_string();
    }
    candidates
        .iter()
        .map(|candidate| {
            let sigint_unit_ids = link_inventory
                .get(&candidate.unit_id)
                .map(|ids| {
                    ids.iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            format!(
                "ORBIT {} rating={} distance={} SIGINT=[{}] name={:?}",
                candidate.unit_id,
                candidate.rating,
                candidate.distance,
                sigint_unit_ids,
                candidate.orbit_name,
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn prepare_review_units(
    labels: &[crate::inbox::unresolved_units::UnresolvedUnitLabel],
    matcher: &matching::TestLinkMatcher,
    link_inventory: &LinkInventory,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<test_link::ReviewUnit>> {
    let mut review_units = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        if let Some(review_unit) = prepare_review_unit(
            i64::try_from(index + 1).c(h!())?,
            &label.unit_txt,
            matcher,
            link_inventory,
            link_mode,
        )
        .c(h!())?
        {
            review_units.push(review_unit);
        }
    }
    Ok(review_units)
}

fn prepare_review_unit(
    subject_id: i64,
    unit_txt: &str,
    matcher: &matching::TestLinkMatcher,
    link_inventory: &LinkInventory,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Option<test_link::ReviewUnit>> {
    let would_automatically_resolve = if link_mode == tui::LinkMode::Manual {
        Some(
            prepare_review_unit(
                subject_id,
                unit_txt,
                matcher,
                link_inventory,
                tui::LinkMode::Automatic,
            )
            .c(h!())?
            .is_some(),
        )
    } else {
        None
    };
    let Some(hierarchy) = parsed_hierarchy(unit_txt) else {
        return Ok(None);
    };
    let hierarchy = hierarchy
        .iter()
        .map(|(echelon, name)| (*echelon, name.as_str()))
        .collect::<Vec<_>>();
    let Some(mut review_unit) = test_link::prepare_review_hierarchy(
        subject_id,
        unit_txt,
        test_link::ReviewSubjectKind::UnparsedUnit,
        &hierarchy,
        matcher,
        link_mode,
        &BTreeSet::new(),
    ) else {
        return Ok(None);
    };
    let automatically_approved = (link_mode == tui::LinkMode::Automatic)
        .then(|| test_link::automatically_approved_link(&review_unit))
        .flatten();
    review_unit.matches.retain(|candidate| {
        let link_count = link_inventory
            .get(&candidate.unit_id)
            .map_or(0, BTreeSet::len);
        let link_is_eligible = match link_mode {
            tui::LinkMode::Manual => link_count <= 1,
            tui::LinkMode::Automatic => link_count == 1,
        };
        link_is_eligible
            && automatically_approved.is_none_or(|(_, orbit_unit_id)| {
                candidate.unit_id == orbit_unit_id
            })
    });
    if link_mode == tui::LinkMode::Automatic && automatically_approved.is_none()
    {
        review_unit.matches.clear();
    }
    review_unit.would_automatically_resolve = would_automatically_resolve;
    Ok((!review_unit.matches.is_empty()).then_some(review_unit))
}

fn parsed_hierarchy(unit_txt: &str) -> Option<Vec<(EchoEchelon, String)>> {
    crate::unit::parse_library_unit_typed_segments(unit_txt).map(|segments| {
        segments
            .into_iter()
            .map(|(unit_type, name)| {
                let echelon = match unit_type {
                    crate::unit::UnitType::COMPANY => EchoEchelon::Company,
                    crate::unit::UnitType::BATTALION => EchoEchelon::Battalion,
                    crate::unit::UnitType::REGIMENT => EchoEchelon::Regiment,
                    crate::unit::UnitType::BRIGADE => EchoEchelon::Brigade,
                    crate::unit::UnitType::DIVISION => EchoEchelon::Division,
                    crate::unit::UnitType::CORPS => EchoEchelon::Corps,
                    crate::unit::UnitType::ARMY => EchoEchelon::Army,
                };
                (echelon, name)
            })
            .collect()
    })
}

async fn load_link_inventory<C>(db: &C) -> anyhow::Result<LinkInventory>
where
    C: ConnectionTrait,
{
    let links = orbit_unit_sigint_unit::Entity::find()
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
        .c(h!())?;
    let mut sigint_unit_ids = LinkInventory::new();
    for link in links {
        sigint_unit_ids
            .entry(link.orbit_unit_id)
            .or_default()
            .insert(link.sigint_unit_id);
    }
    Ok(sigint_unit_ids)
}

fn unique_sigint_links(link_inventory: &LinkInventory) -> BTreeMap<Uuid, i64> {
    link_inventory
        .iter()
        .filter(|(_, sigint_unit_ids)| sigint_unit_ids.len() == 1)
        .map(|(orbit_unit_id, sigint_unit_ids)| {
            (
                *orbit_unit_id,
                *sigint_unit_ids
                    .first()
                    .expect("one SIGINT unit ID must exist"),
            )
        })
        .collect()
}

async fn persist_selections(
    db: &sea_orm::DatabaseConnection,
    selections: &[UnparsedSelection],
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<LabelLinkAction>> {
    let mut actions = Vec::new();
    let batch_size = match link_mode {
        tui::LinkMode::Automatic => ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
        tui::LinkMode::Manual => ORBIT_UNPARSED_UNITS_PERSIST_BATCH_SIZE,
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
    selections: &[UnparsedSelection],
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<LabelLinkAction>> {
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
    let mut link_inventory = load_link_inventory(&transaction).await.c(h!())?;
    let mut unique_links = unique_sigint_links(&link_inventory);
    let mut sigint_units =
        load_selected_sigint_units(&transaction, selections, &unique_links)
            .await
            .c(h!())?;
    let current_labels =
        crate::inbox::unresolved_units::load_new_unresolved_unit_labels(
            &transaction,
        )
        .await
        .c(h!())?
        .into_iter()
        .map(|label| normalize_unit_label(&label.unit_txt))
        .collect::<BTreeSet<_>>();
    let mut actions = Vec::new();
    for selection in selections {
        if !current_labels.contains(&normalize_unit_label(&selection.unit_txt))
        {
            continue;
        }
        let Some(review_unit) = prepare_review_unit(
            selection.subject_id,
            &selection.unit_txt,
            &matcher,
            &link_inventory,
            link_mode,
        )
        .c(h!())?
        else {
            continue;
        };
        let selected_is_current = match link_mode {
            tui::LinkMode::Manual => review_unit
                .matches
                .iter()
                .any(|candidate| candidate.unit_id == selection.orbit_unit_id),
            tui::LinkMode::Automatic => {
                test_link::automatically_approved_link(&review_unit)
                    == Some((selection.subject_id, selection.orbit_unit_id))
            }
        };
        if !selected_is_current {
            continue;
        }
        let sigint_unit = if let Some(sigint_unit_id) =
            unique_links.get(&selection.orbit_unit_id).copied()
        {
            sigint_units
                .get(&sigint_unit_id)
                .expect("linked SIGINT unit must be present")
                .clone()
        } else if link_mode == tui::LinkMode::Manual
            && link_inventory
                .get(&selection.orbit_unit_id)
                .is_none_or(BTreeSet::is_empty)
        {
            let sigint_unit =
                crate::sigint::unit::orbit::import_unlinked_orbit_unit_in_transaction(
                    &transaction,
                    &login,
                    selection.orbit_unit_id,
                )
                .await
                .c(h!())?;
            link_inventory
                .entry(selection.orbit_unit_id)
                .or_default()
                .insert(sigint_unit.id);
            unique_links.insert(selection.orbit_unit_id, sigint_unit.id);
            sigint_units.insert(sigint_unit.id, sigint_unit.clone());
            sigint_unit
        } else {
            continue;
        };
        crate::inbox::unresolved_units::resolve_unresolved_unit_label_in_transaction(
            &transaction,
            &login,
            &selection.unit_txt,
            &selection.unit_txt,
            sigint_unit.id,
        )
        .await
        .c(h!())?;
        actions.push(LabelLinkAction {
            unit_txt: selection.unit_txt.clone(),
            sigint_unit_name: sigint_unit.name,
        });
    }
    transaction.commit().await.c(h!())?;
    Ok(actions)
}

async fn archive_non_unit_labels<C>(
    db: &C,
    labels: &[crate::inbox::unresolved_units::UnresolvedUnitLabel],
) -> anyhow::Result<usize>
where
    C: ConnectionTrait,
{
    let mut archived = 0;
    for label in labels.iter().filter(|label| {
        crate::inbox::unit_resolution::should_auto_archive_failed_unit(
            &label.unit_txt,
        )
    }) {
        archived += usize::from(
            crate::inbox::unresolved_units::archive_unresolved_unit_label_in_transaction(
                db,
                &label.unit_txt,
            )
            .await
            .c(h!())?
                > 0,
        );
    }
    Ok(archived)
}

async fn load_selected_sigint_units<C>(
    db: &C,
    selections: &[UnparsedSelection],
    unique_links: &BTreeMap<Uuid, i64>,
) -> anyhow::Result<BTreeMap<i64, sigint_unit::Model>>
where
    C: ConnectionTrait,
{
    let sigint_unit_ids = selections
        .iter()
        .filter_map(|selection| unique_links.get(&selection.orbit_unit_id))
        .copied()
        .collect::<BTreeSet<_>>();
    if sigint_unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|sigint_unit| (sigint_unit.id, sigint_unit))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        failed_unit_label, orbit_unit_echelon, sigint_inbox_item,
        sigint_inbox_item_failed_unit_label, sigint_unit_label,
    };
    use crate::orbit::types::{DictionaryValue, SourceUnit};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serde_json::json;
    use serial_test::serial;

    #[test]
    fn parses_unparsed_unit_into_the_link_matcher_hierarchy() {
        assert_eq!(
            parsed_hierarchy("4 мсб 752 мсп 3 мсд 20 ЗВА"),
            Some(vec![
                (EchoEchelon::Battalion, "4 мсб".to_string()),
                (EchoEchelon::Regiment, "752 мсп".to_string()),
                (EchoEchelon::Division, "3 мсд".to_string()),
                (EchoEchelon::Army, "20 зва".to_string()),
            ])
        );
    }

    #[test]
    fn parses_brigade_and_corps_hierarchy_levels() {
        assert_eq!(
            parsed_hierarchy("60 омсбр 5 а"),
            Some(vec![
                (EchoEchelon::Brigade, "60 омсбр".to_string()),
                (EchoEchelon::Army, "5 а".to_string()),
            ])
        );
        assert_eq!(
            parsed_hierarchy("38 омсбр 35 а"),
            Some(vec![
                (EchoEchelon::Brigade, "38 омсбр".to_string()),
                (EchoEchelon::Army, "35 а".to_string()),
            ])
        );
        assert_eq!(
            parsed_hierarchy("1 мсб 68 ак"),
            Some(vec![
                (EchoEchelon::Battalion, "1 мсб".to_string()),
                (EchoEchelon::Corps, "68 ак".to_string()),
            ])
        );
    }

    #[test]
    fn rejects_decreasing_or_repeated_echelons() {
        assert_eq!(parsed_hierarchy("60 омсбр 1 мсб"), None);
        assert_eq!(parsed_hierarchy("60 омсбр 38 омсбр"), None);
    }

    #[test]
    fn rejects_multiple_units_combined_into_one_unparsed_label() {
        assert_eq!(parsed_hierarchy("4 мсб 752 мсп 5 мсб 753 мсп"), None);
    }

    #[test]
    fn automatic_resolution_preserves_ambiguity_before_link_filtering() {
        let first = source_unit("4 мсб");
        let second = source_unit("4 мсб");
        let first_id = first.unit_id;
        let matcher =
            matching::TestLinkMatcher::from_units(vec![first, second]);
        let link_inventory = BTreeMap::from([(first_id, BTreeSet::from([17]))]);

        assert!(prepare_review_unit(
            1,
            "4 мсб",
            &matcher,
            &link_inventory,
            tui::LinkMode::Automatic,
        )
        .unwrap()
        .is_none());

        let review_unit = prepare_review_unit(
            1,
            "4 мсб",
            &matcher,
            &link_inventory,
            tui::LinkMode::Manual,
        )
        .unwrap()
        .unwrap();
        assert_eq!(review_unit.would_automatically_resolve, Some(false));
    }

    #[test]
    fn unit_text_resolver_preserves_ambiguous_closest_search_matches() {
        let mut first = source_unit("4 мсб");
        first.unit_id = Uuid::from_u128(1);
        let mut second = source_unit("4 мсб");
        second.unit_id = Uuid::from_u128(2);
        let resolver = UnitTextSigintResolver {
            matcher: matching::TestLinkMatcher::from_units(vec![second, first]),
            link_inventory: BTreeMap::from([
                (Uuid::from_u128(1), BTreeSet::from([17])),
                (Uuid::from_u128(2), BTreeSet::from([18])),
            ]),
        };

        assert_eq!(resolver.resolve("4 мсб").unwrap(), None);
    }

    #[test]
    fn manual_review_includes_a_uniquely_matched_unlinked_orbit_root() {
        let orbit_unit = source_unit("4 мсб");
        let orbit_unit_id = orbit_unit.unit_id;
        let matcher = matching::TestLinkMatcher::from_units(vec![orbit_unit]);
        let link_inventory = LinkInventory::new();

        let review_unit = prepare_review_unit(
            1,
            "4 мсб",
            &matcher,
            &link_inventory,
            tui::LinkMode::Manual,
        )
        .unwrap()
        .unwrap();
        assert_eq!(review_unit.matches[0].unit_id, orbit_unit_id);
        assert_eq!(review_unit.would_automatically_resolve, Some(false));
        assert!(prepare_review_unit(
            1,
            "4 мсб",
            &matcher,
            &link_inventory,
            tui::LinkMode::Automatic,
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn dry_run_classifies_unparsed_label_blockers() {
        let matching_unit = source_unit("4 мсб");
        let matching_unit_id = matching_unit.unit_id;
        let matching_matcher =
            matching::TestLinkMatcher::from_units(vec![matching_unit]);
        let empty_matcher = matching::TestLinkMatcher::from_units(Vec::new());

        assert_blocker(
            "невідомий підрозділ",
            &empty_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::ParserRejected,
        );
        assert_blocker(
            "УКХ радіомережа управління",
            &empty_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::NonUnitAutoArchive,
        );
        assert_blocker(
            "4 мсб",
            &empty_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::NoOrbitMatch,
        );
        assert_blocker(
            "4 мсб",
            &matching_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::OrbitHasNoSigintLink,
        );
        assert_blocker(
            "4 мсб",
            &matching_matcher,
            &BTreeMap::from([(matching_unit_id, BTreeSet::from([17, 18]))]),
            UnparsedBlocker::OrbitHasMultipleSigintLinks,
        );
        assert_blocker(
            "4 мсб",
            &matching_matcher,
            &BTreeMap::from([(matching_unit_id, BTreeSet::from([17]))]),
            UnparsedBlocker::AutomaticallyResolvable,
        );
    }

    #[test]
    fn dry_run_distinguishes_ambiguity_from_match_quality() {
        let first = source_unit("4 мсб");
        let second = source_unit("4 мсб");
        let ambiguous_matcher =
            matching::TestLinkMatcher::from_units(vec![first, second]);
        assert_blocker(
            "4 мсб",
            &ambiguous_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::AmbiguousOrbitMatch,
        );

        let number_only_matcher =
            matching::TestLinkMatcher::from_units(vec![source_unit("4 тб")]);
        assert_blocker(
            "4 мсб",
            &number_only_matcher,
            &LinkInventory::new(),
            UnparsedBlocker::MatchQualityRejected,
        );
    }

    #[tokio::test]
    #[serial]
    async fn manual_batch_imports_one_unlinked_root_for_multiple_labels() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let synced_at = chrono::Utc::now().naive_utc();
        let echelon_id = Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(echelon_id),
            key: Set("battalion".to_string()),
            name: Set(format!("test battalion {echelon_id}")),
            created_at: Set(synced_at),
            updated_at: Set(synced_at),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let orbit_unit_id = Uuid::new_v4();
        persistence::insert_unit(
            &env.dbx,
            &persistence::ImportUnit {
                unit_id: orbit_unit_id,
                unit_name: Some("4 мсб (на БМП)".to_string()),
                unit_name_original: None,
                unit_name_short: Some("4 мсб (на БМП)".to_string()),
                operational_unit_name_full: Some("4 мсб (на БМП)".to_string()),
                generative_unit_name_full: None,
                unit_number: None,
                unit_alternate_names: None,
                unit_alternate_numbers: None,
                unit_echelon_id: Some(echelon_id),
                combat_unit_type_id: None,
                grouping_of_forces_ids: None,
                generative_parent_unit_id: None,
                operational_parent_unit_id: None,
                partial: false,
            },
            synced_at,
        )
        .await
        .unwrap();
        let sync = persistence::record_sync(
            &env.dbx,
            &orbit_unit_id.simple().to_string(),
            synced_at,
        )
        .await
        .unwrap();
        for label in ["4 мсб", "4 мсб (на БМП)"] {
            insert_failed_label(&env.dbx, label).await;
        }

        let actions = persist_selections(
            &env.dbx,
            &[
                UnparsedSelection {
                    subject_id: 1,
                    unit_txt: "4 мсб".to_string(),
                    orbit_unit_id,
                },
                UnparsedSelection {
                    subject_id: 2,
                    unit_txt: "4 мсб (на БМП)".to_string(),
                    orbit_unit_id,
                },
            ],
            tui::LinkMode::Manual,
        )
        .await
        .unwrap();

        assert_eq!(actions.len(), 2);
        let links = load_link_inventory(&env.dbx).await.unwrap();
        let linked_unit_ids = links.get(&orbit_unit_id).unwrap();
        assert_eq!(linked_unit_ids.len(), 1);
        let sigint_unit_id = *linked_unit_ids.first().unwrap();
        assert!(
            sigint_unit::Entity::find_by_id(sigint_unit_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
        assert_eq!(
            sigint_unit_label::Entity::find()
                .filter(
                    sigint_unit_label::Column::SigintUnitId.eq(sigint_unit_id),
                )
                .all(&env.dbx)
                .await
                .unwrap()
                .len(),
            2,
        );
        let failures = sigint_inbox_item_failed_unit_label::Entity::find()
            .find_also_related(failed_unit_label::Entity)
            .filter(
                failed_unit_label::Column::UnitTxt
                    .is_in(["4 мсб", "4 мсб (на БМП)"]),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(failures.len(), 2);
        assert!(failures.iter().all(|(failure, _)| failure.deleted));

        orbit_unit::Entity::delete_by_id(orbit_unit_id)
            .exec(&env.dbx)
            .await
            .unwrap();
        crate::entities::orbit_sync::Entity::delete_by_id(sync.id)
            .exec(&env.dbx)
            .await
            .unwrap();
        orbit_unit_echelon::Entity::delete_by_id(echelon_id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    async fn insert_failed_label(
        db: &sea_orm::DatabaseConnection,
        unit_txt: &str,
    ) {
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            db,
            sigint_inbox_item::ActiveModel {
                unit: Set(Some(unit_txt.to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::inbox::unit_resolution::upsert_failure(
            db,
            inbox_item.id,
            inbox_item.id_uuid,
            unit_txt,
        )
        .await
        .unwrap();
    }

    fn assert_blocker(
        unit_txt: &str,
        matcher: &matching::TestLinkMatcher,
        link_inventory: &LinkInventory,
        expected: UnparsedBlocker,
    ) {
        let label = crate::inbox::unresolved_units::UnresolvedUnitLabel {
            unit_txt: unit_txt.to_string(),
            quantity: 3,
            note: String::new(),
            is_archived: false,
        };
        assert_eq!(
            classify_unparsed_label(1, &label, matcher, link_inventory)
                .unwrap()
                .blocker,
            expected,
        );
    }

    fn source_unit(name: &str) -> SourceUnit {
        SourceUnit {
            unit_id: Uuid::new_v4(),
            unit_name: Some(name.to_string()),
            unit_name_original: None,
            unit_name_short: Some(name.to_string()),
            operational_unit_name_full: Some(name.to_string()),
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon: Some(DictionaryValue {
                key: json!("battalion"),
                name: json!("Battalion"),
            }),
            combat_unit_type: None,
            grouping_of_forces: None,
            operational_parent_units: Vec::new(),
            generative_parent_units: Vec::new(),
            path_level: None,
        }
    }
}
