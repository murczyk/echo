use super::tui;
use crate::config::ORBIT_GENERATED_UNIT_NAME_MANUAL_PERSIST_BATCH_SIZE;
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
    let db = new_pg_pool_from_mode(mode).await.c(h!())?;
    let changes = load_name_changes(&db, None, false).await.c(h!())?;
    let candidate_count = changes.len();
    let review = review_manually(&changes).c(h!())?;
    let accepted = review.selected.len();
    let persisted = persist_changes(&db, &review.selected).await.c(h!())?;
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
) -> anyhow::Result<Vec<GeneratedNameChange>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
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
    if unit.name == generated_name {
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
) -> anyhow::Result<PersistReview> {
    let mut review = PersistReview::default();
    for changes in
        changes.chunks(ORBIT_GENERATED_UNIT_NAME_MANUAL_PERSIST_BATCH_SIZE)
    {
        let batch = persist_change_batch(db, changes).await.c(h!())?;
        review.changed += batch.changed;
        review.stale += batch.stale;
    }
    Ok(review)
}

async fn persist_change_batch(
    db: &sea_orm::DatabaseConnection,
    changes: &[GeneratedNameChange],
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
        load_name_changes(&transaction, Some(&unit_ids), true)
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
        if current != reviewed {
            review.stale += 1;
            continue;
        }
        let outcome = crate::sigint::unit::orbit::reconcile_sigint_unit_orbit_with_reviewed_change(
            &transaction,
            &login,
            &name_change(current),
        )
        .await
        .c(h!())?;
        review.changed += usize::from(outcome.hierarchy_updated);
    }
    transaction.commit().await.c(h!())?;
    Ok(review)
}

fn name_change(
    change: &GeneratedNameChange,
) -> crate::sigint::unit::orbit::OrbitUnitHierarchyChange {
    crate::sigint::unit::orbit::OrbitUnitHierarchyChange {
        sigint_unit_id: change.unit_id,
        attributes: vec![
            crate::sigint::unit::orbit::OrbitUnitAttributeChange {
                attribute: "name",
                current: change.current_name.clone(),
                proposed: change.generated_name.clone(),
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_unit_changelog;
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, IntoActiveModel};
    use serial_test::serial;

    #[test]
    fn generates_names_in_canonical_echelon_order() {
        let mut unit = sigint_unit("custom name");
        unit.company = "2 р".to_string();
        unit.battalion = "1 мсб".to_string();
        unit.brigade = "10 омсбр".to_string();

        let change = proposed_name_change(unit).unwrap();

        assert_eq!(change.generated_name, "2 р 1 мсб 10 омсбр");
    }

    #[test]
    fn includes_exact_name_differences_and_empty_generated_names() {
        assert_eq!(
            proposed_name_change(sigint_unit("current name"))
                .unwrap()
                .generated_name,
            ""
        );
        assert!(proposed_name_change(sigint_unit("")).is_none());
    }

    #[tokio::test]
    #[serial]
    async fn persists_only_an_unchanged_reviewed_name() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                company: Set("GeneratedToken".to_string()),
                name: Set("Custom name".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let reviewed = load_name_changes(&env.dbx, Some(&[unit.id]), false)
            .await
            .unwrap()
            .pop()
            .unwrap();

        let persisted =
            persist_change_batch(&env.dbx, std::slice::from_ref(&reviewed))
                .await
                .unwrap();

        assert_eq!(persisted.changed, 1);
        assert_eq!(persisted.stale, 0);
        let unit = sigint_unit::Entity::find_by_id(unit.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unit.name, "GeneratedToken");
        assert_eq!(unit.company, "GeneratedToken");
        let search_matches = env
            .dbx
            .query_one_raw(sea_orm::Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "select search_tsv @@ plainto_tsquery('russian', $1) as matches from sigint_unit where id = $2",
                ["GeneratedToken".into(), unit.id.into()],
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
        let reviewed = load_name_changes(&env.dbx, Some(&[unit.id]), false)
            .await
            .unwrap()
            .pop()
            .unwrap();
        let mut unit = unit.into_active_model();
        unit.company = Set("ChangedToken".to_string());
        unit.update(&env.dbx).await.unwrap();

        let persisted =
            persist_change_batch(&env.dbx, &[reviewed]).await.unwrap();

        assert_eq!(persisted.changed, 0);
        assert_eq!(persisted.stale, 1);
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
