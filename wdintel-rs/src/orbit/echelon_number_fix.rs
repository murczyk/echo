use super::{persistence, tui};
use crate::config::ORBIT_ECHELON_NUMBER_FIX_PERSIST_BATCH_SIZE;
use crate::entities::{
    orbit_sync, orbit_unit, orbit_unit_sigint_unit, sigint_unit,
};
use crate::sigint::unit::orbit::{
    OrbitUnitAttributeChange, OrbitUnitHierarchyChange,
};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait,
};
use std::collections::BTreeMap;
use uuid::Uuid;

const ECHELON_ATTRIBUTES: [&str; 14] = [
    "other",
    "team_or_crew",
    "section",
    "squad",
    "platoon",
    "company",
    "battalion",
    "regiment",
    "brigade",
    "division",
    "corps",
    "army",
    "military_district",
    "army_region",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct EchelonNumberChange {
    unit_name: String,
    hierarchy_change: OrbitUnitHierarchyChange,
}

#[derive(Default)]
struct ManualReview {
    selected: Vec<EchelonNumberChange>,
    skipped: usize,
    unreviewed: usize,
}

#[derive(Default)]
struct PersistSummary {
    changed: usize,
    stale: usize,
}

struct SourceHierarchyCache {
    orbit_sync: orbit_sync::Model,
    hierarchies: BTreeMap<Uuid, [String; 14]>,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(fix_mode) = tui::prompt_echelon_number_fix_mode().c(h!())? else {
        return Ok(());
    };
    let activity_scope = if fix_mode == tui::LinkMode::Automatic {
        let Some(activity_scope) = tui::prompt_unit_activity_scope(
            "Choose automatic echelon-number fix scope (↑/↓, Enter, Esc: quit)",
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
    run_with_database(&db, fix_mode, activity_scope)
        .await
        .c(h!())
}

async fn run_with_database(
    db: &sea_orm::DatabaseConnection,
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
) -> anyhow::Result<()> {
    let mut source_cache = None;
    let changes = load_changes(db, None, activity_scope, &mut source_cache)
        .await
        .c(h!())?;
    let candidate_count = changes.len();
    let review = match fix_mode {
        tui::LinkMode::Automatic => ManualReview {
            selected: changes,
            ..Default::default()
        },
        tui::LinkMode::Manual => review_manually(&changes).c(h!())?,
    };
    let accepted = review.selected.len();
    let persisted = persist_changes(
        db,
        &review.selected,
        fix_mode,
        activity_scope,
        &mut source_cache,
    )
    .await
    .c(h!())?;
    println!(
        "Linked echelon-number fix: {candidate_count} candidates, {accepted} accepted, {} skipped, {} stale, {} unreviewed; {} SIGINT units changed.",
        review.skipped,
        persisted.stale,
        review.unreviewed,
        persisted.changed,
    );
    Ok(())
}

async fn load_changes<C>(
    db: &C,
    unit_ids: Option<&[i64]>,
    activity_scope: tui::UnitActivityScope,
    source_cache: &mut Option<SourceHierarchyCache>,
) -> anyhow::Result<Vec<EchelonNumberChange>>
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
    let units = units.all(db).await.c(h!())?;
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let links = load_orbit_links(
        db,
        &units.iter().map(|unit| unit.id).collect::<Vec<_>>(),
    )
    .await
    .c(h!())?;
    refresh_source_hierarchy_cache(db, source_cache)
        .await
        .c(h!())?;
    let orbit_hierarchies = &source_cache
        .as_ref()
        .expect("source hierarchy cache must be populated")
        .hierarchies;
    Ok(units
        .into_iter()
        .filter_map(|unit| {
            let orbit_unit_ids = links.get(&unit.id)?;
            let [orbit_unit_id] = orbit_unit_ids.as_slice() else {
                return None;
            };
            let orbit_hierarchy = orbit_hierarchies.get(orbit_unit_id)?;
            proposed_change(&unit, orbit_hierarchy)
        })
        .collect())
}

async fn refresh_source_hierarchy_cache<C>(
    db: &C,
    source_cache: &mut Option<SourceHierarchyCache>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let orbit_sync = persistence::load_latest_sync(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("ORBIT data has not been synchronized"))
        .c(h!())?;
    if source_cache
        .as_ref()
        .is_some_and(|cache| cache.orbit_sync == orbit_sync)
    {
        return Ok(());
    }
    let hierarchies = persistence::load_synced_source_units(db, &orbit_sync)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| (unit.unit_id, source_hierarchy(&unit)))
        .collect();
    *source_cache = Some(SourceHierarchyCache {
        orbit_sync,
        hierarchies,
    });
    Ok(())
}

async fn load_orbit_links<C>(
    db: &C,
    sigint_unit_ids: &[i64],
) -> anyhow::Result<BTreeMap<i64, Vec<Uuid>>>
where
    C: ConnectionTrait,
{
    let links = orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .select_only()
        .column(orbit_unit_sigint_unit::Column::SigintUnitId)
        .column(orbit_unit_sigint_unit::Column::OrbitUnitId)
        .filter(
            orbit_unit_sigint_unit::Column::SigintUnitId
                .is_in(sigint_unit_ids.iter().copied()),
        )
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .into_tuple::<(i64, Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    let mut links_by_unit = BTreeMap::<i64, Vec<Uuid>>::new();
    for (sigint_unit_id, orbit_unit_id) in links {
        links_by_unit
            .entry(sigint_unit_id)
            .or_default()
            .push(orbit_unit_id);
    }
    Ok(links_by_unit)
}

fn source_hierarchy(unit: &super::types::SourceUnit) -> [String; 14] {
    let mut hierarchy = std::array::from_fn(|_| String::new());
    fill_source_hierarchy_level(unit, &mut hierarchy);
    for parent in &unit.generative_parent_units {
        fill_source_hierarchy_level(parent, &mut hierarchy);
    }
    hierarchy
}

fn fill_source_hierarchy_level(
    unit: &super::types::SourceUnit,
    hierarchy: &mut [String; 14],
) {
    let Some(echelon) = unit
        .unit_echelon
        .as_ref()
        .and_then(|echelon| echelon.key.as_str())
        .and_then(super::echo_echelon)
    else {
        return;
    };
    let Some(name) = source_unit_name(unit) else {
        return;
    };
    let value = &mut hierarchy[echelon.index()];
    if value.is_empty() {
        *value = name.to_string();
    }
}

fn source_unit_name(unit: &super::types::SourceUnit) -> Option<&str> {
    [
        unit.unit_name_short.as_deref(),
        unit.unit_name.as_deref(),
        unit.unit_name_original.as_deref(),
        unit.unit_number.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|name| !name.is_empty())
}

fn proposed_change(
    unit: &sigint_unit::Model,
    orbit_hierarchy: &[String; 14],
) -> Option<EchelonNumberChange> {
    let sigint_hierarchy = super::matching::sigint_hierarchy(unit);
    let attributes = sigint_hierarchy
        .into_iter()
        .enumerate()
        .filter_map(|(index, (_, current))| {
            let proposed = &orbit_hierarchy[index];
            has_number_mismatch(current, proposed).then(|| {
                OrbitUnitAttributeChange {
                    attribute: ECHELON_ATTRIBUTES[index],
                    current: current.to_string(),
                    proposed: proposed.clone(),
                }
            })
        })
        .collect::<Vec<_>>();
    (!attributes.is_empty()).then(|| EchelonNumberChange {
        unit_name: unit.name.clone(),
        hierarchy_change: OrbitUnitHierarchyChange {
            sigint_unit_id: unit.id,
            attributes,
        },
    })
}

fn has_number_mismatch(current: &str, proposed: &str) -> bool {
    if !current.chars().any(char::is_alphabetic)
        || !proposed.chars().any(char::is_alphabetic)
    {
        return false;
    }
    let current_numbers = echelon_numbers(current);
    let proposed_numbers = echelon_numbers(proposed);
    !current_numbers.is_empty()
        && !proposed_numbers.is_empty()
        && current_numbers != proposed_numbers
}

fn echelon_numbers(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|number| !number.is_empty())
        .map(|number| {
            let number = number.trim_start_matches('0');
            if number.is_empty() {
                "0".to_string()
            } else {
                number.to_string()
            }
        })
        .collect()
}

fn review_manually(
    changes: &[EchelonNumberChange],
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
    changes: &[EchelonNumberChange],
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    for (index, change) in changes.iter().enumerate() {
        let diffs = change
            .hierarchy_change
            .attributes
            .iter()
            .map(|attribute| tui::EchelonNumberDiff {
                attribute: attribute.attribute,
                current: attribute.current.clone(),
                proposed: attribute.proposed.clone(),
            })
            .collect::<Vec<_>>();
        match tui::review_echelon_number_changes(
            terminal,
            change.hierarchy_change.sigint_unit_id,
            &change.unit_name,
            &diffs,
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
    changes: &[EchelonNumberChange],
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    source_cache: &mut Option<SourceHierarchyCache>,
) -> anyhow::Result<PersistSummary> {
    let mut summary = PersistSummary::default();
    for changes in changes.chunks(ORBIT_ECHELON_NUMBER_FIX_PERSIST_BATCH_SIZE) {
        let persisted = persist_change_batch(
            db,
            changes,
            fix_mode,
            activity_scope,
            source_cache,
        )
        .await
        .c(h!())?;
        summary.changed += persisted.changed;
        summary.stale += persisted.stale;
    }
    Ok(summary)
}

async fn persist_change_batch(
    db: &sea_orm::DatabaseConnection,
    changes: &[EchelonNumberChange],
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    source_cache: &mut Option<SourceHierarchyCache>,
) -> anyhow::Result<PersistSummary> {
    if changes.is_empty() {
        return Ok(PersistSummary::default());
    }
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let current_changes = load_changes(
        &transaction,
        Some(
            &changes
                .iter()
                .map(|change| change.hierarchy_change.sigint_unit_id)
                .collect::<Vec<_>>(),
        ),
        activity_scope,
        source_cache,
    )
    .await
    .c(h!())?
    .into_iter()
    .map(|change| (change.hierarchy_change.sigint_unit_id, change))
    .collect::<BTreeMap<_, _>>();
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let mut summary = PersistSummary::default();
    for reviewed in changes {
        let Some(current) =
            current_changes.get(&reviewed.hierarchy_change.sigint_unit_id)
        else {
            summary.stale += 1;
            continue;
        };
        if fix_mode == tui::LinkMode::Manual && current != reviewed {
            summary.stale += 1;
            continue;
        }
        let outcome = crate::sigint::unit::orbit::reconcile_sigint_unit_orbit_with_reviewed_change(
            &transaction,
            &login,
            &current.hierarchy_change,
        )
        .await
        .c(h!())?;
        if outcome.hierarchy_updated {
            summary.changed += 1;
        } else {
            summary.stale += 1;
        }
    }
    transaction.commit().await.c(h!())?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_different_numeric_parts() {
        assert!(has_number_mismatch("36 А", "35 армія"));
        assert!(!has_number_mismatch("35 А", "35 армія"));
        assert!(!has_number_mismatch("А", "35 армія"));
        assert!(!has_number_mismatch("35", "36 армія"));
        assert!(!has_number_mismatch("035 А", "35 армія"));
    }
}
