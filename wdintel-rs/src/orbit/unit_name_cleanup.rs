use super::tui;
use crate::config::{
    ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
    ORBIT_UNIT_NAME_CLEANUP_ARMY_EXCLUDED_WORDS,
    ORBIT_UNIT_NAME_CLEANUP_CORPS_EXCLUDED_WORDS,
    ORBIT_UNIT_NAME_CLEANUP_MANUAL_PERSIST_BATCH_SIZE,
};
use crate::entities::sigint_unit;
use crate::orbit::EchoEchelon;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseBackend, EntityTrait,
    FromQueryResult, QueryFilter, QueryOrder, QuerySelect, Statement,
};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClearedEchelon {
    attribute: &'static str,
    current: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnitNameChange {
    unit_id: i64,
    current_name: String,
    proposed_name: String,
    cleared_echelons: Vec<ClearedEchelon>,
    removed_other: Option<String>,
}

#[derive(Debug, FromQueryResult)]
struct LinkedOrbitHierarchy {
    sigint_unit_id: i64,
    echelon_keys: Vec<String>,
}

#[derive(Debug, Default)]
struct ManualReview {
    selected: Vec<UnitNameChange>,
    skipped: usize,
    unreviewed: usize,
}

pub async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(cleanup_mode) = tui::prompt_unit_name_cleanup_mode().c(h!())?
    else {
        return Ok(());
    };
    let activity_scope = if cleanup_mode == tui::LinkMode::Automatic {
        let Some(activity_scope) = tui::prompt_unit_activity_scope(
            "Choose hierarchy-cleanup automatic scope (↑/↓, Enter, Esc: quit)",
        )
        .c(h!())?
        else {
            return Ok(());
        };
        activity_scope
    } else {
        tui::UnitActivityScope::Both
    };
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, cleanup_mode, activity_scope)
        .await
        .c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    cleanup_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<()> {
    let changes = load_name_changes(db, None, false, activity_scope)
        .await
        .c(h!())?;
    let candidate_count = changes.len();
    let review = match cleanup_mode {
        tui::LinkMode::Automatic => ManualReview {
            selected: changes,
            ..Default::default()
        },
        tui::LinkMode::Manual => review_manually(&changes).c(h!())?,
    };
    let selected = review.selected.len();
    let actions =
        persist_changes(db, &review.selected, cleanup_mode, activity_scope)
            .await
            .c(h!())?;
    println!(
        "SIGINT-unit hierarchy cleanup: {candidate_count} candidates, {selected} accepted, {} skipped, {} unreviewed; {} units changed.",
        review.skipped,
        review.unreviewed,
        actions.len(),
    );
    if cleanup_mode == tui::LinkMode::Automatic && !actions.is_empty() {
        println!("Changes:");
        for action in actions {
            println!(
                "SIGINT unit {}: {:?} -> {:?}; cleared {}",
                action.unit_id,
                action.current_name,
                action.proposed_name,
                display_cleared_echelons(&action).join(", "),
            );
        }
    }
    Ok(())
}

async fn load_name_changes<C>(
    db: &C,
    unit_ids: Option<&[i64]>,
    lock: bool,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<Vec<UnitNameChange>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_unit::Column::Other.ne(""))
                .add(sigint_unit::Column::Corps.ne(""))
                .add(sigint_unit::Column::Army.ne(""))
                .add(sigint_unit::Column::MilitaryDistrict.ne(""))
                .add(sigint_unit::Column::ArmyRegion.ne("")),
        )
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
    let units = units
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let hierarchy_by_unit_id = load_linked_orbit_hierarchies(
        db,
        &units.keys().copied().collect::<Vec<_>>(),
    )
    .await
    .c(h!())?
    .into_iter()
    .map(|hierarchy| {
        let echelons = hierarchy
            .echelon_keys
            .iter()
            .filter_map(|key| super::echo_echelon(key))
            .collect::<HashSet<_>>();
        (hierarchy.sigint_unit_id, echelons)
    })
    .collect::<BTreeMap<_, _>>();
    Ok(units
        .into_iter()
        .filter_map(|(unit_id, unit)| {
            proposed_name_change(&unit, hierarchy_by_unit_id.get(&unit_id))
        })
        .collect())
}

async fn load_linked_orbit_hierarchies<C>(
    db: &C,
    sigint_unit_ids: &[i64],
) -> anyhow::Result<Vec<LinkedOrbitHierarchy>>
where
    C: ConnectionTrait,
{
    let sql = r#"
        with recursive active_links as (
            select
                link.sigint_unit_id,
                link.orbit_unit_id,
                count(*) over (
                    partition by link.sigint_unit_id
                ) as orbit_link_count
            from orbit_unit_sigint_unit link
            inner join orbit_unit unit
                on unit.unit_id = link.orbit_unit_id
                and unit.deleted = false
            where link.is_suppressed = false
                and link.sigint_unit_id = any($1::bigint[])
        ),
        generative_hierarchy as (
            select
                link.sigint_unit_id,
                unit.unit_id,
                unit.generative_parent_unit_id,
                unit.unit_echelon_id,
                unit.unit_name_short,
                unit.unit_name,
                unit.unit_name_original,
                unit.unit_number,
                array[unit.unit_id] as visited
            from active_links link
            inner join orbit_unit unit
                on unit.unit_id = link.orbit_unit_id
            where link.orbit_link_count = 1

            union all

            select
                hierarchy.sigint_unit_id,
                parent.unit_id,
                parent.generative_parent_unit_id,
                parent.unit_echelon_id,
                parent.unit_name_short,
                parent.unit_name,
                parent.unit_name_original,
                parent.unit_number,
                hierarchy.visited || parent.unit_id
            from generative_hierarchy hierarchy
            inner join orbit_unit parent
                on parent.unit_id = hierarchy.generative_parent_unit_id
                and parent.deleted = false
                and not parent.unit_id = any(hierarchy.visited)
        )
        select
            hierarchy.sigint_unit_id,
            coalesce(
                array_agg(distinct echelon.key) filter (
                    where echelon.key is not null
                        and coalesce(
                            nullif(btrim(hierarchy.unit_name_short), ''),
                            nullif(btrim(hierarchy.unit_name), ''),
                            nullif(btrim(hierarchy.unit_name_original), ''),
                            nullif(btrim(hierarchy.unit_number), '')
                        ) is not null
                ),
                array[]::text[]
            ) as echelon_keys
        from generative_hierarchy hierarchy
        left join orbit_unit_echelon echelon
            on echelon.id = hierarchy.unit_echelon_id
        group by hierarchy.sigint_unit_id
        order by hierarchy.sigint_unit_id
    "#;
    LinkedOrbitHierarchy::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [sigint_unit_ids.to_vec().into()],
    ))
    .all(db)
    .await
    .c(h!())
}

fn proposed_name_change(
    unit: &sigint_unit::Model,
    orbit_echelons: Option<&HashSet<EchoEchelon>>,
) -> Option<UnitNameChange> {
    let cleared_echelons = cleanup_echelons(unit)
        .into_iter()
        .filter(|(echelon, _, value)| {
            !value.trim().is_empty()
                && should_clear_echelon(*echelon, value, orbit_echelons)
        })
        .map(|(_, attribute, value)| ClearedEchelon {
            attribute,
            current: value.to_string(),
        })
        .collect::<Vec<_>>();
    let (proposed_name, removed_other) = proposed_name(unit, &cleared_echelons);
    if cleared_echelons.is_empty() && !removed_other {
        return None;
    }
    if proposed_name.is_empty() || proposed_name == unit.name {
        return None;
    }
    Some(UnitNameChange {
        unit_id: unit.id,
        current_name: unit.name.clone(),
        proposed_name,
        cleared_echelons,
        removed_other: removed_other.then(|| unit.other.clone()),
    })
}

fn should_clear_echelon(
    echelon: EchoEchelon,
    value: &str,
    orbit_echelons: Option<&HashSet<EchoEchelon>>,
) -> bool {
    if crate::sigint::unit::unit_name_echelon_is_blacklisted(
        echelon.index(),
        value,
    ) {
        return true;
    }
    let Some(orbit_echelons) = orbit_echelons else {
        return false;
    };
    !orbit_echelons.contains(&echelon) && !is_cleanup_exception(echelon, value)
}

fn is_cleanup_exception(echelon: EchoEchelon, value: &str) -> bool {
    let excluded_words = match echelon {
        EchoEchelon::Army => ORBIT_UNIT_NAME_CLEANUP_ARMY_EXCLUDED_WORDS,
        EchoEchelon::Corps => ORBIT_UNIT_NAME_CLEANUP_CORPS_EXCLUDED_WORDS,
        _ => return false,
    };
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .any(|word| excluded_words.contains(&word))
}

fn cleanup_echelons(
    unit: &sigint_unit::Model,
) -> [(EchoEchelon, &'static str, &str); 4] {
    [
        (EchoEchelon::Corps, "corps", unit.corps.as_str()),
        (EchoEchelon::Army, "army", unit.army.as_str()),
        (
            EchoEchelon::MilitaryDistrict,
            "military_district",
            unit.military_district.as_str(),
        ),
        (
            EchoEchelon::ArmyRegion,
            "army_region",
            unit.army_region.as_str(),
        ),
    ]
}

fn proposed_name(
    unit: &sigint_unit::Model,
    cleared_echelons: &[ClearedEchelon],
) -> (String, bool) {
    if !crate::sigint::unit::unit_has_name_echelon_below_corps(unit) {
        return (unit.name.clone(), false);
    }
    let retained_echelons = retained_echelons(unit, cleared_echelons);
    let (mut proposed_name, removed_other) =
        remove_phrase(&unit.name, &unit.other, &retained_echelons);
    for echelon in cleared_echelons {
        proposed_name =
            remove_phrase(&proposed_name, &echelon.current, &retained_echelons)
                .0;
    }
    (
        proposed_name
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        removed_other,
    )
}

fn retained_echelons<'a>(
    unit: &'a sigint_unit::Model,
    cleared_echelons: &[ClearedEchelon],
) -> Vec<&'a str> {
    crate::sigint::unit::unit_hierarchy(unit)
        .into_iter()
        .enumerate()
        .skip(1)
        .filter(|(index, value)| {
            !value.trim().is_empty()
                && !echelon_is_cleared(*index, cleared_echelons)
        })
        .map(|(_, value)| value)
        .collect()
}

fn echelon_is_cleared(
    index: usize,
    cleared_echelons: &[ClearedEchelon],
) -> bool {
    let attribute = match index {
        index if index == EchoEchelon::Corps.index() => "corps",
        index if index == EchoEchelon::Army.index() => "army",
        index if index == EchoEchelon::MilitaryDistrict.index() => {
            "military_district"
        }
        index if index == EchoEchelon::ArmyRegion.index() => "army_region",
        _ => return false,
    };
    cleared_echelons
        .iter()
        .any(|echelon| echelon.attribute == attribute)
}

fn phrases_equal(left: &str, right: &str) -> bool {
    left.split_whitespace()
        .map(str::to_lowercase)
        .eq(right.split_whitespace().map(str::to_lowercase))
}

fn remove_phrase(
    value: &str,
    phrase: &str,
    retained_echelons: &[&str],
) -> (String, bool) {
    let value_words = value.split_whitespace().collect::<Vec<_>>();
    let phrase_words = phrase.split_whitespace().collect::<Vec<_>>();
    if phrase_words.is_empty() {
        return (value.to_string(), false);
    }
    let matching_echelons = retained_echelons
        .iter()
        .filter(|echelon| phrases_equal(echelon, phrase))
        .count();
    let mut removals = removable_phrase_occurrence_count(
        &value_words,
        &phrase_words,
        phrase,
        retained_echelons,
    )
    .saturating_sub(matching_echelons);
    let mut kept_words = Vec::new();
    let mut removed = false;
    let mut index = 0;
    while index < value_words.len() {
        let end = index + phrase_words.len();
        if phrase_matches_at(&value_words, &phrase_words, index) {
            if removals == 0
                || phrase_overlaps_retained_echelon(
                    &value_words,
                    &phrase_words,
                    phrase,
                    index,
                    retained_echelons,
                )
            {
                kept_words.extend_from_slice(&value_words[index..end]);
            } else {
                removals -= 1;
                removed = true;
            }
            index = end;
        } else {
            kept_words.push(value_words[index]);
            index += 1;
        }
    }
    (kept_words.join(" "), removed)
}

fn removable_phrase_occurrence_count(
    value_words: &[&str],
    phrase_words: &[&str],
    phrase: &str,
    retained_echelons: &[&str],
) -> usize {
    let mut count = 0;
    let mut index = 0;
    while index < value_words.len() {
        if phrase_matches_at(value_words, phrase_words, index) {
            if !phrase_overlaps_retained_echelon(
                value_words,
                phrase_words,
                phrase,
                index,
                retained_echelons,
            ) {
                count += 1;
            }
            index += phrase_words.len();
        } else {
            index += 1;
        }
    }
    count
}

fn phrase_overlaps_retained_echelon(
    value_words: &[&str],
    phrase_words: &[&str],
    phrase: &str,
    phrase_index: usize,
    retained_echelons: &[&str],
) -> bool {
    let phrase_end = phrase_index + phrase_words.len();
    retained_echelons.iter().any(|retained_echelon| {
        if phrases_equal(retained_echelon, phrase) {
            return false;
        }
        let retained_words =
            retained_echelon.split_whitespace().collect::<Vec<_>>();
        (0..value_words.len()).any(|retained_index| {
            phrase_matches_at(value_words, &retained_words, retained_index)
                && phrase_index < retained_index + retained_words.len()
                && retained_index < phrase_end
        })
    })
}

fn phrase_matches_at(
    value_words: &[&str],
    phrase_words: &[&str],
    index: usize,
) -> bool {
    let end = index + phrase_words.len();
    end <= value_words.len()
        && value_words[index..end].iter().zip(phrase_words).all(
            |(value, phrase)| value.to_lowercase() == phrase.to_lowercase(),
        )
}

fn display_cleared_echelons(change: &UnitNameChange) -> Vec<String> {
    let mut details = change
        .cleared_echelons
        .iter()
        .map(|echelon| format!("{}: {}", echelon.attribute, echelon.current))
        .collect::<Vec<_>>();
    if let Some(other) = &change.removed_other {
        details.push(format!("name-only other: {other}"));
    }
    details
}

fn review_manually(changes: &[UnitNameChange]) -> anyhow::Result<ManualReview> {
    if changes.is_empty() {
        return Ok(ManualReview::default());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let result = review_manually_inner(&mut terminal, changes);
    tui::restore_terminal(&mut terminal).c(h!())?;
    result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    changes: &[UnitNameChange],
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    for (index, change) in changes.iter().enumerate() {
        match tui::review_unit_name_change(
            terminal,
            change.unit_id,
            &change.current_name,
            &change.proposed_name,
            &display_cleared_echelons(change),
            index + 1,
            changes.len(),
        )
        .c(h!())?
        {
            tui::UnitNameReviewDecision::Accept => {
                review.selected.push(change.clone())
            }
            tui::UnitNameReviewDecision::Skip => review.skipped += 1,
            tui::UnitNameReviewDecision::Quit => {
                review.unreviewed = changes.len() - index;
                break;
            }
        }
    }
    Ok(review)
}

async fn persist_changes(
    db: &sea_orm::DatabaseConnection,
    changes: &[UnitNameChange],
    cleanup_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<Vec<UnitNameChange>> {
    let batch_size = match cleanup_mode {
        tui::LinkMode::Automatic => ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
        tui::LinkMode::Manual => {
            ORBIT_UNIT_NAME_CLEANUP_MANUAL_PERSIST_BATCH_SIZE
        }
    };
    let mut actions = Vec::new();
    for changes in changes.chunks(batch_size) {
        actions.extend(
            persist_change_batch(db, changes, cleanup_mode, activity_scope)
                .await
                .c(h!())?,
        );
    }
    Ok(actions)
}

async fn persist_change_batch(
    db: &sea_orm::DatabaseConnection,
    changes: &[UnitNameChange],
    cleanup_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<Vec<UnitNameChange>> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let unit_ids = changes
        .iter()
        .map(|change| change.unit_id)
        .collect::<Vec<_>>();
    let current_changes =
        load_name_changes(&transaction, Some(&unit_ids), true, activity_scope)
            .await
            .c(h!())?
            .into_iter()
            .map(|change| (change.unit_id, change))
            .collect::<BTreeMap<_, _>>();
    let mut actions = Vec::new();
    for reviewed in changes {
        let Some(current) = current_changes.get(&reviewed.unit_id) else {
            continue;
        };
        if cleanup_mode == tui::LinkMode::Manual && current != reviewed {
            continue;
        }
        let outcome = crate::sigint::unit::orbit::reconcile_sigint_unit_orbit_with_reviewed_change(
            &transaction,
            &login,
            &orbit_hierarchy_change(current),
        )
        .await
        .c(h!())?;
        if outcome.hierarchy_updated {
            actions.push(current.clone());
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(actions)
}

fn orbit_hierarchy_change(
    change: &UnitNameChange,
) -> crate::sigint::unit::orbit::OrbitUnitHierarchyChange {
    let mut attributes = change
        .cleared_echelons
        .iter()
        .map(
            |echelon| crate::sigint::unit::orbit::OrbitUnitAttributeChange {
                attribute: echelon.attribute,
                current: echelon.current.clone(),
                proposed: String::new(),
            },
        )
        .collect::<Vec<_>>();
    if change.current_name != change.proposed_name {
        attributes.push(crate::sigint::unit::orbit::OrbitUnitAttributeChange {
            attribute: "name",
            current: change.current_name.clone(),
            proposed: change.proposed_name.clone(),
        });
    }
    crate::sigint::unit::orbit::OrbitUnitHierarchyChange {
        sigint_unit_id: change.unit_id,
        attributes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{
        orbit_unit, orbit_unit_sigint_unit, sigint_unit_changelog,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
    use serial_test::serial;

    #[test]
    fn clears_echelons_missing_from_the_orbit_generative_hierarchy() {
        let mut unit =
            sigint_unit("9 мсп 11 АК 20 ЗВА МВО ЗС РФ", "МВО", "ЗС РФ");
        unit.corps = "11 АК".to_string();
        unit.army = "20 ЗВА".to_string();
        let orbit_echelons = HashSet::from([EchoEchelon::Army]);

        assert_eq!(
            proposed_name_change(&unit, Some(&orbit_echelons)),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "9 мсп 20 ЗВА".to_string(),
                cleared_echelons: vec![
                    ClearedEchelon {
                        attribute: "corps",
                        current: "11 АК".to_string(),
                    },
                    ClearedEchelon {
                        attribute: "military_district",
                        current: "МВО".to_string(),
                    },
                    ClearedEchelon {
                        attribute: "army_region",
                        current: "ЗС РФ".to_string(),
                    },
                ],
                removed_other: None,
            })
        );
    }

    #[test]
    fn keeps_sigint_echelons_present_in_the_orbit_generative_hierarchy() {
        let mut unit = sigint_unit("9 мсп 11 АК 20 ЗВА", "", "");
        unit.corps = "11 АК".to_string();
        unit.army = "20 ЗВА".to_string();
        let orbit_echelons =
            HashSet::from([EchoEchelon::Corps, EchoEchelon::Army]);

        assert_eq!(proposed_name_change(&unit, Some(&orbit_echelons)), None);
    }

    #[test]
    fn leaves_unit_unchanged_when_invalid_echelon_is_absent_from_name() {
        let mut unit = sigint_unit("custom unit name", "", "");
        unit.corps = "МВО".to_string();

        assert_eq!(proposed_name_change(&unit, Some(&HashSet::new())), None);
    }

    #[test]
    fn leaves_unit_unchanged_when_echelon_is_only_part_of_name_word() {
        let unit = sigint_unit("1 МВОк", "МВО", "");

        assert_eq!(proposed_name_change(&unit, Some(&HashSet::new())), None);
    }

    #[test]
    fn removes_other_from_the_name_without_clearing_the_echelon() {
        let mut unit = sigint_unit("ВМФ 9 мсп", "", "");
        unit.other = "ВМФ".to_string();

        assert_eq!(
            proposed_name_change(&unit, None),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "9 мсп".to_string(),
                cleared_echelons: Vec::new(),
                removed_other: Some("ВМФ".to_string()),
            })
        );
    }

    #[test]
    fn keeps_other_value_when_it_matches_company() {
        let mut unit = sigint_unit("1 р 9 мсп", "", "");
        unit.other = "1 р".to_string();
        unit.company = "1 р".to_string();

        assert_eq!(proposed_name_change(&unit, None), None);
    }

    #[test]
    fn keeps_other_value_when_it_is_part_of_company() {
        let mut unit = sigint_unit("1 р 9 мсп", "", "");
        unit.other = "1".to_string();
        unit.company = "1 р".to_string();

        assert_eq!(proposed_name_change(&unit, None), None);
    }

    #[test]
    fn removes_standalone_other_without_cropping_company() {
        let mut unit = sigint_unit("1 1 р 9 мсп", "", "");
        unit.other = "1".to_string();
        unit.company = "1 р".to_string();

        assert_eq!(
            proposed_name_change(&unit, None),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "1 р 9 мсп".to_string(),
                cleared_echelons: Vec::new(),
                removed_other: Some("1".to_string()),
            })
        );
    }

    #[test]
    fn keeps_company_when_it_is_part_of_other_value() {
        let mut unit = sigint_unit("1 р 9 мсп", "", "");
        unit.other = "1 р".to_string();
        unit.company = "1".to_string();

        assert_eq!(proposed_name_change(&unit, None), None);
    }

    #[test]
    fn removes_only_extra_other_occurrence_when_it_matches_company() {
        let mut unit = sigint_unit("1 р 1 р 9 мсп", "", "");
        unit.other = "1 р".to_string();
        unit.company = "1 р".to_string();

        assert_eq!(
            proposed_name_change(&unit, None),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "1 р 9 мсп".to_string(),
                cleared_echelons: Vec::new(),
                removed_other: Some("1 р".to_string()),
            })
        );
    }

    #[test]
    fn keeps_company_occurrence_matching_removed_other_and_corps() {
        let mut unit = sigint_unit("1 р 1 р 1 р 9 мсп", "", "");
        unit.other = "1 р".to_string();
        unit.company = "1 р".to_string();
        unit.corps = "1 р".to_string();

        assert_eq!(
            proposed_name_change(&unit, Some(&HashSet::new())),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "1 р 9 мсп".to_string(),
                cleared_echelons: vec![ClearedEchelon {
                    attribute: "corps",
                    current: "1 р".to_string(),
                }],
                removed_other: Some("1 р".to_string()),
            })
        );
    }

    #[test]
    fn keeps_name_when_clearing_echelons_would_empty_it() {
        let unit = sigint_unit("МВО ЗС РФ", "МВО", "ЗС РФ");

        assert_eq!(proposed_name_change(&unit, Some(&HashSet::new())), None);
    }

    #[test]
    fn leaves_unit_unchanged_when_only_echelons_are_corps_or_above() {
        let mut unit = sigint_unit("Повна назва корпусу", "", "");
        unit.regiment.clear();
        unit.corps = "ТН".to_string();
        let orbit_echelons = HashSet::from([EchoEchelon::Corps]);

        assert_eq!(proposed_name_change(&unit, Some(&orbit_echelons)), None);
    }

    #[test]
    fn keeps_army_and_corps_cleanup_exceptions() {
        let mut army = sigint_unit("1 ртп ПКС", "", "");
        army.army = "ПКС".to_string();
        let mut corps = sigint_unit("1 ртп пКс", "", "");
        corps.corps = "пКс".to_string();

        assert_eq!(proposed_name_change(&army, Some(&HashSet::new())), None);
        assert_eq!(proposed_name_change(&corps, Some(&HashSet::new())), None);
    }

    #[test]
    fn clears_blacklisted_army_and_corps_values_case_insensitively() {
        for value in ["УВ(с)", "УВ", "ТН"] {
            let echelon_value = format!("командування {value}");
            let name = format!("1 ртп {echelon_value}");
            let mut army = sigint_unit(&name, "", "");
            army.army.clone_from(&echelon_value);
            let orbit_echelons =
                HashSet::from([EchoEchelon::Army, EchoEchelon::Corps]);
            let army_change =
                proposed_name_change(&army, Some(&orbit_echelons)).unwrap();
            assert_eq!(army_change.proposed_name, "1 ртп");
            assert_eq!(
                army_change.cleared_echelons,
                vec![ClearedEchelon {
                    attribute: "army",
                    current: echelon_value.clone(),
                }]
            );

            let mut corps = sigint_unit(&name, "", "");
            corps.corps.clone_from(&echelon_value);
            let corps_change =
                proposed_name_change(&corps, Some(&orbit_echelons)).unwrap();
            assert_eq!(corps_change.proposed_name, "1 ртп");
            assert_eq!(
                corps_change.cleared_echelons,
                vec![ClearedEchelon {
                    attribute: "corps",
                    current: echelon_value,
                }]
            );
        }
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_persists_the_reviewed_name_and_refreshes_search() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                other: Set("OtherToken".to_string()),
                regiment: Set("RegimentToken".to_string()),
                corps: Set("ТН".to_string()),
                name: Set("OtherToken RegimentToken ТН".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let orbit_unit_id = uuid::Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            unit_name_short: Set(Some("RegimentToken".to_string())),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(unit.id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let reviewed = load_name_changes(
            &env.dbx,
            Some(&[unit.id]),
            false,
            tui::UnitActivityScope::Both,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();

        let unit_id = unit.id;
        let mut unit = unit.into_active_model();
        unit.active = Set(true);
        unit.update(&env.dbx).await.unwrap();

        let actions = persist_change_batch(
            &env.dbx,
            std::slice::from_ref(&reviewed),
            tui::LinkMode::Automatic,
            tui::UnitActivityScope::Inactive,
        )
        .await
        .unwrap();

        assert!(actions.is_empty());

        let actions = persist_change_batch(
            &env.dbx,
            &[reviewed],
            tui::LinkMode::Manual,
            tui::UnitActivityScope::Both,
        )
        .await
        .unwrap();

        assert_eq!(actions.len(), 1);
        let unit = sigint_unit::Entity::find_by_id(unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.name, "RegimentToken");
        assert_eq!(unit.other, "OtherToken");
        assert_eq!(unit.regiment, "RegimentToken");
        assert_eq!(unit.corps, "");
        let search_matches = env
            .dbx
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "select search_tsv @@ plainto_tsquery('russian', $1) as matches from sigint_unit where id = $2",
                ["RegimentToken".into(), unit.id.into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<bool>("", "matches")
            .unwrap();
        assert!(search_matches);
        let changelog = sigint_unit_changelog::Entity::find()
            .filter(sigint_unit_changelog::Column::SigintUnitId.eq(unit.id))
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(changelog.len(), 1);
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_modes_keep_echelon_value_matching_other() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        for cleanup_mode in [tui::LinkMode::Manual, tui::LinkMode::Automatic] {
            let unit = crate::functest::tests::mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    other: Set("Shared".to_string()),
                    company: Set("Shared Company".to_string()),
                    regiment: Set("RegimentToken".to_string()),
                    corps: Set("ТН".to_string()),
                    name: Set("Shared Company RegimentToken ТН".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let reviewed = load_name_changes(
                &env.dbx,
                Some(&[unit.id]),
                false,
                tui::UnitActivityScope::Both,
            )
            .await
            .unwrap()
            .pop()
            .unwrap();

            assert_eq!(reviewed.proposed_name, "Shared Company RegimentToken");

            let actions = persist_change_batch(
                &env.dbx,
                &[reviewed],
                cleanup_mode,
                tui::UnitActivityScope::Both,
            )
            .await
            .unwrap();

            assert_eq!(actions.len(), 1);
            let unit = sigint_unit::Entity::find_by_id(unit.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(unit.name, "Shared Company RegimentToken");
            assert_eq!(unit.other, "Shared");
            assert_eq!(unit.company, "Shared Company");
            assert_eq!(unit.corps, "");
        }
    }

    fn sigint_unit(
        name: &str,
        military_district: &str,
        army_region: &str,
    ) -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            company: String::new(),
            regiment: "9 мсп".to_string(),
            division: String::new(),
            army: String::new(),
            active: true,
            deleted: false,
            created_at: Default::default(),
            created_by_login_id: uuid::Uuid::nil(),
            name: name.to_string(),
            comment: String::new(),
            battalion: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            army_region: army_region.to_string(),
            military_district: military_district.to_string(),
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            brigade: String::new(),
            corps: String::new(),
            is_inconsistent: false,
            updated_at: Default::default(),
        }
    }
}
