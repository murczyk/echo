use super::{matching, persistence, test_link, tui, EchoEchelon};
use crate::config::ORBIT_UNPARSED_UNITS_PERSIST_BATCH_SIZE;
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

#[derive(Debug, Clone)]
struct UnparsedSelection {
    subject_id: i64,
    unit_txt: String,
    orbit_unit_id: Uuid,
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
    let labels =
        crate::inbox::unresolved_units::load_new_unresolved_unit_labels(db)
            .await
            .c(h!())?;
    let orbit_units = persistence::load_latest_synced_source_units(db)
        .await
        .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let unique_links = load_unique_sigint_links(db).await.c(h!())?;
    let review_units =
        prepare_review_units(&labels, &matcher, &unique_links, link_mode)
            .c(h!())?;
    let (summary, links) = match link_mode {
        tui::LinkMode::Manual => {
            test_link::review_manually(review_units).c(h!())?
        }
        tui::LinkMode::Automatic => test_link::approve_automatic(review_units),
    };
    let labels_by_subject_id = labels
        .into_iter()
        .enumerate()
        .map(|(index, label)| {
            Ok((i64::try_from(index + 1).c(h!())?, label.unit_txt))
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
    let resolved = persist_selections(db, &selections, link_mode)
        .await
        .c(h!())?;
    println!(
        "Unparsed-unit review: accepted {}, denied {}, unreviewed {}; resolved {resolved} labels.",
        summary.accepted, summary.denied, summary.unreviewed,
    );
    Ok(())
}

fn prepare_review_units(
    labels: &[crate::inbox::unresolved_units::UnresolvedUnitLabel],
    matcher: &matching::TestLinkMatcher,
    unique_links: &BTreeMap<Uuid, i64>,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Vec<test_link::ReviewUnit>> {
    let mut review_units = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        if let Some(review_unit) = prepare_review_unit(
            i64::try_from(index + 1).c(h!())?,
            &label.unit_txt,
            matcher,
            unique_links,
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
    unique_links: &BTreeMap<Uuid, i64>,
    link_mode: tui::LinkMode,
) -> anyhow::Result<Option<test_link::ReviewUnit>> {
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
        unique_links.contains_key(&candidate.unit_id)
            && automatically_approved.is_none_or(|(_, orbit_unit_id)| {
                candidate.unit_id == orbit_unit_id
            })
    });
    if link_mode == tui::LinkMode::Automatic && automatically_approved.is_none()
    {
        review_unit.matches.clear();
    }
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
                    crate::unit::UnitType::DIVISION => EchoEchelon::Division,
                    crate::unit::UnitType::ARMY => EchoEchelon::Army,
                };
                (echelon, name)
            })
            .collect()
    })
}

async fn load_unique_sigint_links<C>(
    db: &C,
) -> anyhow::Result<BTreeMap<Uuid, i64>>
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
    let mut sigint_unit_ids = BTreeMap::<Uuid, BTreeSet<i64>>::new();
    for link in links {
        sigint_unit_ids
            .entry(link.orbit_unit_id)
            .or_default()
            .insert(link.sigint_unit_id);
    }
    Ok(sigint_unit_ids
        .into_iter()
        .filter_map(|(orbit_unit_id, sigint_unit_ids)| {
            (sigint_unit_ids.len() == 1).then(|| {
                (
                    orbit_unit_id,
                    *sigint_unit_ids
                        .first()
                        .expect("one SIGINT unit ID must exist"),
                )
            })
        })
        .collect())
}

async fn persist_selections(
    db: &sea_orm::DatabaseConnection,
    selections: &[UnparsedSelection],
    link_mode: tui::LinkMode,
) -> anyhow::Result<usize> {
    let mut resolved = 0;
    for selections in selections.chunks(ORBIT_UNPARSED_UNITS_PERSIST_BATCH_SIZE)
    {
        resolved += persist_selection_batch(db, selections, link_mode)
            .await
            .c(h!())?;
    }
    Ok(resolved)
}

async fn persist_selection_batch(
    db: &sea_orm::DatabaseConnection,
    selections: &[UnparsedSelection],
    link_mode: tui::LinkMode,
) -> anyhow::Result<usize> {
    if selections.is_empty() {
        return Ok(0);
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let orbit_units =
        persistence::load_latest_synced_source_units(&transaction)
            .await
            .c(h!())?;
    let matcher = matching::TestLinkMatcher::from_units(orbit_units);
    let unique_links = load_unique_sigint_links(&transaction).await.c(h!())?;
    let current_labels =
        crate::inbox::unresolved_units::load_new_unresolved_unit_labels(
            &transaction,
        )
        .await
        .c(h!())?
        .into_iter()
        .map(|label| normalize_unit_label(&label.unit_txt))
        .collect::<BTreeSet<_>>();
    let mut resolved = 0;
    for selection in selections {
        if !current_labels.contains(&normalize_unit_label(&selection.unit_txt))
        {
            continue;
        }
        let Some(review_unit) = prepare_review_unit(
            selection.subject_id,
            &selection.unit_txt,
            &matcher,
            &unique_links,
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
        let Some(sigint_unit_id) =
            unique_links.get(&selection.orbit_unit_id).copied()
        else {
            continue;
        };
        crate::inbox::unresolved_units::resolve_unresolved_unit_label_in_transaction(
            &transaction,
            &login,
            &selection.unit_txt,
            &selection.unit_txt,
            sigint_unit_id,
        )
        .await
        .c(h!())?;
        resolved += 1;
    }
    transaction.commit().await.c(h!())?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::types::{DictionaryValue, SourceUnit};
    use serde_json::json;

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
        let unique_links = BTreeMap::from([(first_id, 17)]);

        assert!(prepare_review_unit(
            1,
            "4 мсб",
            &matcher,
            &unique_links,
            tui::LinkMode::Automatic,
        )
        .unwrap()
        .is_none());
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
