use super::tui;
use crate::config::{
    ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
    ORBIT_GENERATED_UNIT_NAME_MANUAL_PERSIST_BATCH_SIZE,
};
use crate::entities::sigint_unit;
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeneratedNameChange {
    unit_id: i64,
    current_name: String,
    generated_name: String,
    hierarchy: [String; 14],
}

#[derive(Debug, Default)]
struct ManualReview {
    selected: Vec<GeneratedNameChange>,
    skipped: usize,
    unreviewed: usize,
}

#[derive(Debug, Default)]
struct PersistReview {
    changed: usize,
    stale: usize,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(review_mode) = tui::prompt_generated_unit_name_mode().c(h!())?
    else {
        return Ok(());
    };
    let activity_scope = if review_mode == tui::LinkMode::Automatic {
        let Some(activity_scope) = tui::prompt_unit_activity_scope(
            "Choose generated-name automatic scope (↑/↓, Enter, Esc: quit)",
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
    run_with_database(&db, review_mode, activity_scope)
        .await
        .c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    review_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<()> {
    let changes = load_name_changes(db, None, false, activity_scope)
        .await
        .c(h!())?;
    let candidate_count = changes.len();
    let review = match review_mode {
        tui::LinkMode::Automatic => ManualReview {
            selected: changes,
            ..Default::default()
        },
        tui::LinkMode::Manual => review_manually(&changes).c(h!())?,
    };
    let accepted = review.selected.len();
    let persisted =
        persist_changes(db, &review.selected, review_mode, activity_scope)
            .await
            .c(h!())?;
    println!(
        "Generated SIGINT-unit name review: {candidate_count} candidates, {accepted} accepted, {} skipped, {} stale, {} unreviewed; {} units changed.",
        review.skipped, persisted.stale, review.unreviewed, persisted.changed,
    );
    Ok(())
}

async fn load_name_changes<C>(
    db: &C,
    unit_ids: Option<&[i64]>,
    lock: bool,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<Vec<GeneratedNameChange>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
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
    Ok(units
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(proposed_name_change)
        .collect())
}

fn proposed_name_change(
    unit: sigint_unit::Model,
) -> Option<GeneratedNameChange> {
    let generated_name = crate::sigint::unit::generated_unit_name(&unit);
    if generated_name.is_empty() || unit.name == generated_name {
        return None;
    }
    let hierarchy =
        crate::sigint::unit::unit_hierarchy(&unit).map(str::to_string);
    Some(GeneratedNameChange {
        unit_id: unit.id,
        current_name: unit.name,
        generated_name,
        hierarchy,
    })
}

fn review_manually(
    changes: &[GeneratedNameChange],
) -> anyhow::Result<ManualReview> {
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
    changes: &[GeneratedNameChange],
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    for (index, change) in changes.iter().enumerate() {
        let hierarchy = change
            .hierarchy
            .iter()
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>();
        match tui::review_unit_name_change(
            terminal,
            change.unit_id,
            &change.current_name,
            &change.generated_name,
            &hierarchy,
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
    changes: &[GeneratedNameChange],
    review_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistReview> {
    let batch_size = match review_mode {
        tui::LinkMode::Automatic => ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
        tui::LinkMode::Manual => {
            ORBIT_GENERATED_UNIT_NAME_MANUAL_PERSIST_BATCH_SIZE
        }
    };
    let mut review = PersistReview::default();
    for changes in changes.chunks(batch_size) {
        let batch =
            persist_change_batch(db, changes, review_mode, activity_scope)
                .await
                .c(h!())?;
        review.changed += batch.changed;
        review.stale += batch.stale;
    }
    Ok(review)
}

async fn persist_change_batch(
    db: &sea_orm::DatabaseConnection,
    changes: &[GeneratedNameChange],
    review_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<PersistReview> {
    if changes.is_empty() {
        return Ok(PersistReview::default());
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
    let mut review = PersistReview::default();
    for reviewed in changes {
        let Some(current) = current_changes.get(&reviewed.unit_id) else {
            review.stale += 1;
            continue;
        };
        if review_mode == tui::LinkMode::Manual && current != reviewed {
            review.stale += 1;
            continue;
        }
        let outcome = crate::sigint::unit::orbit::update_sigint_unit_name_with_reviewed_change(
            &transaction,
            &login,
            current.unit_id,
            &current.current_name,
            &current.generated_name,
        )
        .await
        .c(h!())?;
        review.changed += usize::from(outcome.hierarchy_updated);
    }
    transaction.commit().await.c(h!())?;
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_unit_changelog;
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
    use serial_test::serial;

    #[test]
    fn generates_names_through_army_in_canonical_echelon_order() {
        let mut unit = sigint_unit("custom name");
        unit.company = "2 р".to_string();
        unit.battalion = "1 мсб".to_string();
        unit.brigade = "10 омсбр".to_string();
        unit.army = "20 ЗВА".to_string();
        unit.other = "ВМФ".to_string();
        unit.military_district = "Західний ВО".to_string();
        unit.army_region = "ЗС РФ".to_string();

        let change = proposed_name_change(unit).unwrap();

        assert_eq!(change.generated_name, "2 р 1 мсб 10 омсбр 20 ЗВА");
    }

    #[test]
    fn keeps_company_value_matching_other_in_generated_name() {
        let mut unit = sigint_unit("custom name");
        unit.other = "1 р".to_string();
        unit.company = "1 р".to_string();

        let change = proposed_name_change(unit).unwrap();

        assert_eq!(change.generated_name, "1 р");
    }

    #[test]
    fn keeps_company_when_other_is_part_of_its_value() {
        let mut unit = sigint_unit("custom name");
        unit.other = "1".to_string();
        unit.company = "1 р".to_string();

        let change = proposed_name_change(unit).unwrap();

        assert_eq!(change.generated_name, "1 р");
    }

    #[test]
    fn filters_higher_echelon_labels_stored_in_legacy_lower_fields() {
        let mut unit = sigint_unit("custom name");
        unit.battalion = "1 мсб".to_string();
        unit.regiment = "ТН \"Шебекино\"".to_string();
        unit.division = "УВ \"Бєлгород\"".to_string();
        unit.army = "УВ \"Север\"".to_string();

        let change = proposed_name_change(unit).unwrap();

        assert_eq!(change.generated_name, "1 мсб");
    }

    #[test]
    fn skips_empty_generated_names() {
        assert!(proposed_name_change(sigint_unit("current name")).is_none());
        assert!(proposed_name_change(sigint_unit("")).is_none());
        let mut high_echelon_unit = sigint_unit("Західний ВО ЗС РФ");
        high_echelon_unit.corps = "11 АК".to_string();
        high_echelon_unit.army = "20 ЗВА".to_string();
        high_echelon_unit.military_district = "Західний ВО".to_string();
        high_echelon_unit.army_region = "ЗС РФ".to_string();
        assert!(proposed_name_change(high_echelon_unit).is_none());
    }

    #[tokio::test]
    #[serial]
    async fn persists_reviewed_names_according_to_mode() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                other: Set("Generated".to_string()),
                company: Set("Generated Token".to_string()),
                name: Set("Custom name".to_string()),
                is_inconsistent: Set(true),
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

        let persisted = persist_change_batch(
            &env.dbx,
            std::slice::from_ref(&reviewed),
            tui::LinkMode::Manual,
            tui::UnitActivityScope::Both,
        )
        .await
        .unwrap();

        assert_eq!(persisted.changed, 1);
        assert_eq!(persisted.stale, 0);
        let unit = sigint_unit::Entity::find_by_id(unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.name, "Generated Token");
        assert_eq!(unit.other, "Generated");
        assert_eq!(unit.company, "Generated Token");
        assert!(unit.is_inconsistent);
        let search_matches = env
            .dbx
            .query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "select search_tsv @@ plainto_tsquery('russian', $1) as matches from sigint_unit where id = $2",
                ["Generated Token".into(), unit.id.into()],
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

        let mut unit = unit.into_active_model();
        unit.name = Set("Another custom name".to_string());
        let unit = unit.update(&env.dbx).await.unwrap();
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
        unit.other = Set("Changed".to_string());
        unit.company = Set("Changed Token".to_string());
        unit.active = Set(false);
        unit.update(&env.dbx).await.unwrap();

        let persisted = persist_change_batch(
            &env.dbx,
            std::slice::from_ref(&reviewed),
            tui::LinkMode::Manual,
            tui::UnitActivityScope::Both,
        )
        .await
        .unwrap();

        assert_eq!(persisted.changed, 0);
        assert_eq!(persisted.stale, 1);

        let persisted = persist_change_batch(
            &env.dbx,
            std::slice::from_ref(&reviewed),
            tui::LinkMode::Automatic,
            tui::UnitActivityScope::Active,
        )
        .await
        .unwrap();

        assert_eq!(persisted.changed, 0);
        assert_eq!(persisted.stale, 1);

        let persisted = persist_change_batch(
            &env.dbx,
            &[reviewed],
            tui::LinkMode::Automatic,
            tui::UnitActivityScope::Inactive,
        )
        .await
        .unwrap();

        assert_eq!(persisted.changed, 1);
        assert_eq!(persisted.stale, 0);
        let unit = sigint_unit::Entity::find_by_id(unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.name, "Changed Token");
        assert_eq!(unit.other, "Changed");
        assert_eq!(unit.company, "Changed Token");
    }

    fn sigint_unit(name: &str) -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            other: String::new(),
            team_or_crew: String::new(),
            section: String::new(),
            squad: String::new(),
            platoon: String::new(),
            company: String::new(),
            battalion: String::new(),
            regiment: String::new(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: uuid::Uuid::nil(),
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
