use super::tui;
use crate::config::{
    ORBIT_UNIT_NAME_CLEANUP_ARMY_NAME_WORDS,
    ORBIT_UNIT_NAME_CLEANUP_CORPS_NAME_WORDS,
    ORBIT_UNIT_NAME_CLEANUP_MANUAL_PERSIST_BATCH_SIZE,
};
use crate::entities::sigint_unit;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
struct UnitNameChange {
    unit_id: i64,
    current_name: String,
    proposed_name: String,
    removed_echelons: Vec<String>,
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
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, cleanup_mode).await.c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    cleanup_mode: tui::LinkMode,
) -> anyhow::Result<()> {
    let changes = load_name_changes(db).await.c(h!())?;
    let candidate_count = changes.len();
    let review = match cleanup_mode {
        tui::LinkMode::Automatic => ManualReview {
            selected: changes,
            ..Default::default()
        },
        tui::LinkMode::Manual => review_manually(&changes).c(h!())?,
    };
    let selected = review.selected.len();
    let actions = persist_changes(db, &review.selected, cleanup_mode)
        .await
        .c(h!())?;
    println!(
        "SIGINT-unit-name cleanup: {candidate_count} candidates, {selected} accepted, {} skipped, {} unreviewed; {} names changed.",
        review.skipped,
        review.unreviewed,
        actions.len(),
    );
    if cleanup_mode == tui::LinkMode::Automatic && !actions.is_empty() {
        println!("Changes:");
        for action in actions {
            println!(
                "SIGINT unit {}: {:?} -> {:?}",
                action.unit_id, action.current_name, action.proposed_name,
            );
        }
    }
    Ok(())
}

async fn load_name_changes<C>(db: &C) -> anyhow::Result<Vec<UnitNameChange>>
where
    C: ConnectionTrait,
{
    Ok(sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_unit::Column::Corps.ne(""))
                .add(sigint_unit::Column::Army.ne(""))
                .add(sigint_unit::Column::MilitaryDistrict.ne(""))
                .add(sigint_unit::Column::ArmyRegion.ne("")),
        )
        .order_by_asc(sigint_unit::Column::Id)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|unit| proposed_name_change(&unit))
        .collect())
}

fn proposed_name_change(unit: &sigint_unit::Model) -> Option<UnitNameChange> {
    let echelons = removable_name_echelons(unit);
    let mut proposed_name = unit.name.clone();
    let mut removed_echelons = Vec::new();
    for echelon in echelons {
        let (next_name, removed) = remove_phrase(&proposed_name, echelon);
        if removed {
            proposed_name = next_name;
            removed_echelons.push(echelon.to_string());
        }
    }
    let proposed_name = proposed_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!proposed_name.is_empty()
        && proposed_name != unit.name
        && !removed_echelons.is_empty())
    .then_some(UnitNameChange {
        unit_id: unit.id,
        current_name: unit.name.clone(),
        proposed_name,
        removed_echelons,
    })
}

fn removable_name_echelons(unit: &sigint_unit::Model) -> Vec<&str> {
    [
        (!contains_name_word(
            &unit.corps,
            ORBIT_UNIT_NAME_CLEANUP_CORPS_NAME_WORDS,
        ))
        .then_some(unit.corps.as_str()),
        (!contains_name_word(
            &unit.army,
            ORBIT_UNIT_NAME_CLEANUP_ARMY_NAME_WORDS,
        ))
        .then_some(unit.army.as_str()),
        Some(unit.military_district.as_str()),
        Some(unit.army_region.as_str()),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|echelon| !echelon.is_empty())
    .collect()
}

fn contains_name_word(value: &str, expected_words: &[&str]) -> bool {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .any(|word| expected_words.contains(&word))
}

fn remove_phrase(value: &str, phrase: &str) -> (String, bool) {
    let value_words = value.split_whitespace().collect::<Vec<_>>();
    let phrase_words = phrase.split_whitespace().collect::<Vec<_>>();
    if phrase_words.is_empty() {
        return (value.to_string(), false);
    }
    let mut kept_words = Vec::new();
    let mut removed = false;
    let mut index = 0;
    while index < value_words.len() {
        let end = index + phrase_words.len();
        if end <= value_words.len()
            && value_words[index..end].iter().zip(&phrase_words).all(
                |(value, phrase)| value.to_lowercase() == phrase.to_lowercase(),
            )
        {
            index = end;
            removed = true;
        } else {
            kept_words.push(value_words[index]);
            index += 1;
        }
    }
    (kept_words.join(" "), removed)
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
            &change.removed_echelons,
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
) -> anyhow::Result<Vec<UnitNameChange>> {
    let batch_size = match cleanup_mode {
        tui::LinkMode::Automatic => 1,
        tui::LinkMode::Manual => {
            ORBIT_UNIT_NAME_CLEANUP_MANUAL_PERSIST_BATCH_SIZE
        }
    };
    let mut actions = Vec::new();
    for changes in changes.chunks(batch_size) {
        actions.extend(
            persist_change_batch(db, changes, cleanup_mode)
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
) -> anyhow::Result<Vec<UnitNameChange>> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let unit_ids = changes.iter().map(|change| change.unit_id);
    let current_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(unit_ids))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(&transaction)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit))
        .collect::<BTreeMap<_, _>>();
    let mut actions = Vec::new();
    for reviewed in changes {
        let Some(unit) = current_units.get(&reviewed.unit_id) else {
            continue;
        };
        let Some(current) = proposed_name_change(unit) else {
            continue;
        };
        if cleanup_mode == tui::LinkMode::Manual && current != *reviewed {
            continue;
        }
        crate::sigint::unit::update_unit_name_in_transaction(
            &transaction,
            &login,
            unit,
            &current.proposed_name,
        )
        .await
        .c(h!())?;
        actions.push(current);
    }
    transaction.commit().await.c(h!())?;
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_echelons_above_army_from_name() {
        let unit =
            sigint_unit("4 мсб 752 мсп 20 ЗВА мво ЗС РФ", "МВО", "ЗС РФ");

        assert_eq!(
            proposed_name_change(&unit),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "4 мсб 752 мсп 20 ЗВА".to_string(),
                removed_echelons: vec!["МВО".to_string(), "ЗС РФ".to_string()],
            })
        );
    }

    #[test]
    fn keeps_partial_word_matches_and_nonempty_names() {
        let unit = sigint_unit("1 МВОк", "МВО", "");
        assert_eq!(proposed_name_change(&unit), None);

        let unit = sigint_unit("МВО ЗС РФ", "МВО", "ЗС РФ");
        assert_eq!(proposed_name_change(&unit), None);
    }

    #[test]
    fn removes_army_and_corps_values_that_do_not_name_those_echelons() {
        let mut unit =
            sigint_unit("9 мсп ТН \"Сумський\" УВ(с) \"Сєвєр\"", "", "");
        unit.corps = "ТН \"Сумський\"".to_string();
        unit.army = "УВ(с) \"Сєвєр\"".to_string();

        assert_eq!(
            proposed_name_change(&unit),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name,
                proposed_name: "9 мсп".to_string(),
                removed_echelons: vec![
                    "ТН \"Сумський\"".to_string(),
                    "УВ(с) \"Сєвєр\"".to_string(),
                ],
            })
        );
    }

    #[test]
    fn keeps_valid_army_and_corps_values() {
        for (corps, army) in [
            ("11 АК", "20 ЗВА"),
            ("11 армійський корпус", "20 загальновійськова армія"),
            ("11 ак", "1 та"),
        ] {
            let mut unit =
                sigint_unit(&format!("9 мсп {corps} {army}"), "", "");
            unit.corps = corps.to_string();
            unit.army = army.to_string();

            assert_eq!(proposed_name_change(&unit), None);
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
            regiment: String::new(),
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
