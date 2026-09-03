use super::tui;
use crate::config::{
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
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    run_with_database(&db, cleanup_mode).await.c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    cleanup_mode: tui::LinkMode,
) -> anyhow::Result<()> {
    let changes = load_name_changes(db, None, false).await.c(h!())?;
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
) -> anyhow::Result<Vec<UnitNameChange>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_unit::Column::Corps.ne(""))
                .add(sigint_unit::Column::Army.ne(""))
                .add(sigint_unit::Column::MilitaryDistrict.ne(""))
                .add(sigint_unit::Column::ArmyRegion.ne("")),
        )
        .order_by_asc(sigint_unit::Column::Id);
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
            proposed_name_change(&unit, hierarchy_by_unit_id.get(&unit_id)?)
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
    orbit_echelons: &HashSet<EchoEchelon>,
) -> Option<UnitNameChange> {
    let cleared_echelons = cleanup_echelons(unit)
        .into_iter()
        .filter(|(echelon, _, value)| {
            !value.trim().is_empty()
                && !orbit_echelons.contains(echelon)
                && !is_cleanup_exception(*echelon, value)
        })
        .map(|(_, attribute, value)| ClearedEchelon {
            attribute,
            current: value.to_string(),
        })
        .collect::<Vec<_>>();
    if cleared_echelons.is_empty() {
        return None;
    }
    let proposed_name = proposed_name(unit, &cleared_echelons);
    if proposed_name.is_empty() {
        return None;
    }
    Some(UnitNameChange {
        unit_id: unit.id,
        current_name: unit.name.clone(),
        proposed_name,
        cleared_echelons,
    })
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
) -> String {
    let mut proposed_name = unit.name.clone();
    for echelon in cleared_echelons {
        proposed_name = remove_phrase(&proposed_name, &echelon.current).0;
    }
    proposed_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

fn display_cleared_echelons(change: &UnitNameChange) -> Vec<String> {
    change
        .cleared_echelons
        .iter()
        .map(|echelon| format!("{}: {}", echelon.attribute, echelon.current))
        .collect()
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
    let unit_ids = changes
        .iter()
        .map(|change| change.unit_id)
        .collect::<Vec<_>>();
    let current_changes =
        load_name_changes(&transaction, Some(&unit_ids), true)
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
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[test]
    fn clears_echelons_missing_from_the_orbit_generative_hierarchy() {
        let mut unit =
            sigint_unit("9 мсп 11 АК 20 ЗВА МВО ЗС РФ", "МВО", "ЗС РФ");
        unit.corps = "11 АК".to_string();
        unit.army = "20 ЗВА".to_string();
        let orbit_echelons = HashSet::from([EchoEchelon::Army]);

        assert_eq!(
            proposed_name_change(&unit, &orbit_echelons),
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

        assert_eq!(proposed_name_change(&unit, &orbit_echelons), None);
    }

    #[test]
    fn clears_invalid_echelon_when_its_value_is_absent_from_the_name() {
        let mut unit = sigint_unit("custom unit name", "", "");
        unit.corps = "11 АК".to_string();

        assert_eq!(
            proposed_name_change(&unit, &HashSet::new()),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name.clone(),
                proposed_name: unit.name,
                cleared_echelons: vec![ClearedEchelon {
                    attribute: "corps",
                    current: "11 АК".to_string(),
                }],
            })
        );
    }

    #[test]
    fn removes_complete_echelon_phrases_only() {
        let unit = sigint_unit("1 МВОк", "МВО", "");

        assert_eq!(
            proposed_name_change(&unit, &HashSet::new()),
            Some(UnitNameChange {
                unit_id: 1,
                current_name: unit.name.clone(),
                proposed_name: unit.name,
                cleared_echelons: vec![ClearedEchelon {
                    attribute: "military_district",
                    current: "МВО".to_string(),
                }],
            })
        );
    }

    #[test]
    fn keeps_name_when_clearing_echelons_would_empty_it() {
        let unit = sigint_unit("МВО ЗС РФ", "МВО", "ЗС РФ");

        assert_eq!(proposed_name_change(&unit, &HashSet::new()), None);
    }

    #[test]
    fn keeps_pks_army_and_corps_case_insensitively() {
        let mut army = sigint_unit("1 ртп ПКС", "", "");
        army.army = "ПКС".to_string();
        let mut corps = sigint_unit("1 ртп пКс", "", "");
        corps.corps = "пКс".to_string();

        assert_eq!(proposed_name_change(&army, &HashSet::new()), None);
        assert_eq!(proposed_name_change(&corps, &HashSet::new()), None);
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_persists_the_reviewed_name_and_refreshes_search() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set("RegimentToken".to_string()),
                corps: Set("CorpsToken".to_string()),
                name: Set("RegimentToken CorpsToken".to_string()),
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
        let reviewed = load_name_changes(&env.dbx, Some(&[unit.id]), false)
            .await
            .unwrap()
            .pop()
            .unwrap();

        let actions =
            persist_change_batch(&env.dbx, &[reviewed], tui::LinkMode::Manual)
                .await
                .unwrap();

        assert_eq!(actions.len(), 1);
        let unit = sigint_unit::Entity::find_by_id(unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.name, "RegimentToken");
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
