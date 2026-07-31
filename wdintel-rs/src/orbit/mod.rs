use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::error::AppError;
use crate::orbit::dictionary::DictionaryMaps;
use crate::orbit::persistence::{ExistingUnit, ImportState, ImportUnit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseTransaction, DbBackend, EntityTrait,
    JoinType, QueryFilter, QuerySelect, RelationTrait, Statement,
    TransactionTrait,
};
use std::collections::HashSet;
use std::path::PathBuf;
use uuid::Uuid;

mod dictionary;
mod hierarchy;
mod matching;
mod persistence;
mod snapshot;
mod tui;
mod types;

#[derive(Debug, Clone)]
pub struct OrbitMatchCandidate {
    pub unit_id: Uuid,
    pub unit_name: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub operational_unit_name_full: Option<String>,
}

impl From<&types::SourceUnit> for OrbitMatchCandidate {
    fn from(unit: &types::SourceUnit) -> Self {
        Self {
            unit_id: unit.unit_id,
            unit_name: unit.unit_name.clone(),
            generative_unit_name_full: unit.generative_unit_name_full.clone(),
            operational_unit_name_full: unit.operational_unit_name_full.clone(),
        }
    }
}

pub async fn prepare_import_snapshot(
    mode: Mode,
    source_path: PathBuf,
) -> anyhow::Result<()> {
    let location = snapshot::prepare_snapshot(mode, &source_path)
        .await
        .c(h!())?;
    println!("{location}");
    Ok(())
}

pub async fn run_import_tui(mode: Mode) -> Result<(), AppError> {
    Ok(run_selected_action(mode).await.c(h!())?)
}

pub async fn closest_orbit_matches_for_sigint_unit(
    db: &sea_orm::DatabaseConnection,
    sigint_unit: &sigint_unit::Model,
) -> anyhow::Result<Vec<OrbitMatchCandidate>> {
    let units = persistence::load_latest_synced_source_units(db)
        .await
        .c("failed to load synchronized ORBIT units for search")?;
    Ok(matching::closest_orbit_matches(&units, sigint_unit)
        .into_iter()
        .map(OrbitMatchCandidate::from)
        .collect())
}

pub async fn link_sigint_unit_if_unlinked_with_lock(
    db: &sea_orm::DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError> {
    let _import_lock = acquire_import_lock(db).await.c(h!())?;
    if !active_orbit_unit_exists(db, orbit_unit_id).await? {
        return Err(AppError::NotFound);
    }
    if sigint_unit_has_active_orbit_link(db, sigint_unit_id).await? {
        return Err(AppError::BL {
            msg: "SIGINT unit already has a linked ORBIT unit".to_string(),
        });
    }
    persistence::replace_sigint_unit_link(db, sigint_unit_id, orbit_unit_id)
        .await
}

async fn active_orbit_unit_exists<C>(
    db: &C,
    orbit_unit_id: Uuid,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit::Entity::find_by_id(orbit_unit_id)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
        .is_some())
}

async fn sigint_unit_has_active_orbit_link<C>(
    db: &C,
    sigint_unit_id: i64,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .one(db)
        .await
        .c(h!())?
        .is_some())
}

async fn run_selected_action(mode: Mode) -> anyhow::Result<()> {
    match tui::prompt_start_action()? {
        Some(tui::StartAction::Import) => run_import(mode).await.c(h!()),
        Some(tui::StartAction::FindMatch) => {
            run_match_search(mode).await.c(h!())
        }
        None => Ok(()),
    }
}

async fn run_import(mode: Mode) -> anyhow::Result<()> {
    let snapshot = snapshot::load_latest_snapshot(mode).await?;
    let db = connect_database(mode).await?;
    let _import_lock = acquire_import_lock(&db).await?;
    let latest_sync = persistence::load_latest_sync(&db).await.c(h!())?;
    if let Some(sync) =
        latest_sync.filter(|sync| sync.archive_md5 == snapshot.archive_md5)
    {
        if !tui::confirm_unchanged_archive(
            &snapshot.archive_md5,
            sync.synced_at,
        )? {
            return Ok(());
        }
    } else {
        sync_snapshot_units(&db, &snapshot).await?;
    }
    rebuild_sigint_unit_links(&db).await
}

async fn sync_snapshot_units(
    db: &sea_orm::DatabaseConnection,
    snapshot: &snapshot::OrbitSnapshot,
) -> anyhow::Result<()> {
    dictionary::ensure_dictionary_entries(db, &snapshot.dictionaries)
        .await
        .c(h!())?;
    let dictionaries = DictionaryMaps::load(db)
        .await
        .c("failed to load ORBIT dictionaries")?;
    let selected_ids = snapshot
        .units
        .iter()
        .map(|unit| unit.unit_id)
        .collect::<HashSet<_>>();
    let snapshot_unit_ids = hierarchy::source_unit_ids(&snapshot.units);
    let hierarchy =
        hierarchy::build_import_hierarchy(&snapshot.units, &selected_ids)
            .context("failed to build the complete ORBIT hierarchy")?;
    let started_at = Utc::now().naive_utc();
    let mut import_units = hierarchy
        .into_iter()
        .map(|unit| ImportUnit::from_hierarchy(unit, &dictionaries))
        .collect::<anyhow::Result<Vec<_>>>()
        .context("failed to resolve dictionaries for the ORBIT hierarchy")?;
    let existing = persistence::load_existing(db)
        .await
        .c("failed to load existing ORBIT units")?;
    for unit in &mut import_units {
        unit.preserve_existing_partial_fields(existing.get(&unit.unit_id));
    }
    for unit in &import_units {
        match persistence::classify(unit, existing.get(&unit.unit_id)) {
            ImportState::New => {
                persistence::insert_unit(db, unit, started_at)
                    .await
                    .c(h!())?;
            }
            ImportState::Unchanged => {
                persistence::touch_unit(db, unit.unit_id, started_at)
                    .await
                    .c(h!())?;
            }
            ImportState::Changed(row) | ImportState::Deleted(row) => {
                persistence::update_unit(db, row, unit, started_at)
                    .await
                    .c(h!())?;
            }
        }
    }
    review_stale_units(db, started_at, &snapshot_unit_ids)
        .await
        .context("failed while reviewing stale ORBIT units")?;
    persistence::record_sync(db, &snapshot.archive_md5, started_at)
        .await
        .c("failed to record the ORBIT archive sync")?;
    log::info!(
        "synchronized {} ORBIT units from archive {}",
        import_units.len(),
        snapshot.archive_md5
    );
    Ok(())
}

async fn rebuild_sigint_unit_links(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    let units = persistence::load_latest_synced_source_units(db)
        .await
        .c("failed to load the latest synchronized ORBIT units")?;
    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(db)
        .await
        .c("failed to load active SIGINT units for ORBIT matching")?;
    let sigint_unit_ids_by_orbit_unit =
        matching::matching_sigint_unit_ids(&units, &sigint_units);
    log::info!(
        "matched {} ORBIT roots to active SIGINT units",
        sigint_unit_ids_by_orbit_unit.len()
    );
    persistence::replace_sigint_unit_links(db, &sigint_unit_ids_by_orbit_unit)
        .await
        .c("failed to replace ORBIT-to-SIGINT links")?;
    Ok(())
}

async fn run_match_search(mode: Mode) -> anyhow::Result<()> {
    let Some(search_term) = tui::prompt_sigint_unit_name()? else {
        return Ok(());
    };
    let db = connect_database(mode).await?;
    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(&db)
        .await
        .c("failed to load active SIGINT units for ORBIT search")?;
    let Some(sigint_unit) =
        find_sigint_unit_by_full_name(sigint_units, &search_term)
    else {
        println!("No active SIGINT unit has full name: {search_term}");
        return Ok(());
    };
    let units = persistence::load_latest_synced_source_units(&db)
        .await
        .c("failed to load synchronized ORBIT units for search")?;
    let candidates = matching::closest_orbit_matches(&units, &sigint_unit);
    if candidates.is_empty() {
        println!("No ORBIT matches found for: {search_term}");
        return Ok(());
    }
    let options = candidates
        .iter()
        .map(|unit| tui::MatchOption {
            unit_id: unit.unit_id,
            operational_full_name: unit
                .operational_unit_name_full
                .clone()
                .unwrap_or_else(|| "-".to_string()),
            generative_full_name: unit
                .generative_unit_name_full
                .clone()
                .unwrap_or_else(|| "-".to_string()),
            original_name: unit
                .unit_name_original
                .clone()
                .unwrap_or_else(|| "-".to_string()),
        })
        .collect::<Vec<_>>();
    let Some(selected) = tui::select_match(&options)? else {
        return Ok(());
    };
    let selected = candidates[selected];
    let _import_lock = acquire_import_lock(&db).await?;
    persistence::replace_sigint_unit_link(
        &db,
        sigint_unit.id,
        selected.unit_id,
    )
    .await
    .c(format!(
        "failed to link SIGINT unit {} to ORBIT unit {}",
        sigint_unit.id, selected.unit_id
    ))?;
    println!(
        "Linked SIGINT unit {} to ORBIT unit {}",
        sigint_unit.id, selected.unit_id
    );
    Ok(())
}

async fn connect_database(
    mode: Mode,
) -> anyhow::Result<sea_orm::DatabaseConnection> {
    log::info!("connecting ORBIT importer to PostgreSQL in {mode:?} mode");
    new_pg_pool_from_mode(mode).await.c(format!(
        "failed to initialize the ORBIT importer database connection in {mode:?} mode"
    ))
}

async fn acquire_import_lock(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<DatabaseTransaction> {
    log::info!("waiting for the ORBIT import advisory lock");
    let transaction = db
        .begin()
        .await
        .c("failed to begin the ORBIT import lock transaction")?;
    transaction
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_advisory_xact_lock($1)",
            [crate::config::ORBIT_IMPORT_ADVISORY_LOCK_KEY.into()],
        ))
        .await
        .c("failed to acquire the ORBIT import advisory lock")?;
    log::info!("acquired the ORBIT import advisory lock");
    Ok(transaction)
}

fn find_sigint_unit_by_full_name(
    mut units: Vec<sigint_unit::Model>,
    search_term: &str,
) -> Option<sigint_unit::Model> {
    let search_term = normalize_full_name(search_term);
    units.sort_by_key(|unit| unit.id);
    units.into_iter().find(|unit| {
        normalize_full_name(&sigint_unit_full_name(unit)) == search_term
    })
}

fn sigint_unit_full_name(unit: &sigint_unit::Model) -> String {
    [
        unit.company.as_str(),
        unit.battalion.as_str(),
        unit.regiment.as_str(),
        unit.division.as_str(),
        unit.army.as_str(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn normalize_full_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

async fn review_stale_units(
    db: &sea_orm::DatabaseConnection,
    started_at: chrono::NaiveDateTime,
    snapshot_unit_ids: &HashSet<Uuid>,
) -> anyhow::Result<()> {
    let stale =
        persistence::load_stale(db, started_at, snapshot_unit_ids).await?;
    if stale.is_empty() {
        return Ok(());
    }
    let mut terminal = tui::setup_terminal()?;
    let result =
        review_stale_units_inner(db, &mut terminal, stale, started_at).await;
    tui::restore_terminal(&mut terminal)?;
    result
}

async fn review_stale_units_inner(
    db: &sea_orm::DatabaseConnection,
    terminal: &mut tui::OrbitTerminal,
    stale: Vec<ExistingUnit>,
    started_at: chrono::NaiveDateTime,
) -> anyhow::Result<()> {
    let total = stale.len();
    for (index, unit) in stale.into_iter().enumerate() {
        let name = unit
            .unit_name_short
            .clone()
            .or_else(|| unit.unit_name.clone())
            .or_else(|| unit.unit_name_original.clone())
            .unwrap_or_else(|| unit.unit_id.to_string());
        let lines = serde_json::to_string_pretty(&unit)?
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let decision = tui::review(
            terminal,
            &format!("Delete stale ORBIT unit {name}?"),
            None,
            &lines,
            &format!("Stale unit {}/{}", index + 1, total),
            tui::Action::Delete,
            true,
        )?;
        match decision {
            tui::Decision::Accept => {
                persistence::soft_delete(db, unit, started_at).await?
            }
            tui::Decision::Skip => {}
            tui::Decision::SkipAll | tui::Decision::Quit => break,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sigint_unit_by_normalized_full_name() {
        let mut higher_id = sigint_unit();
        higher_id.id = 2;
        let mut lower_id = higher_id.clone();
        lower_id.id = 1;
        assert_eq!(
            find_sigint_unit_by_full_name(
                vec![higher_id, lower_id],
                "  1 МСБ   ТрО 4 ОМСБР 3 ЗВА ",
            )
            .map(|unit| unit.id),
            Some(1)
        );
    }

    #[test]
    fn missing_sigint_full_name_is_not_found() {
        assert!(find_sigint_unit_by_full_name(
            vec![sigint_unit()],
            "2 мсб 4 омсбр 3 ЗВА",
        )
        .is_none());
    }

    #[tokio::test]
    async fn import_lock_serializes_database_sessions() {
        crate::tests::test::init().await;
        let first_db = connect_database(Mode::Test).await.unwrap();
        let second_db = connect_database(Mode::Test).await.unwrap();
        let first_lock = acquire_import_lock(&first_db).await.unwrap();
        let second_transaction = second_db.begin().await.unwrap();
        let statement = || {
            Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select pg_try_advisory_xact_lock($1) as acquired",
                [crate::config::ORBIT_IMPORT_ADVISORY_LOCK_KEY.into()],
            )
        };

        let row = second_transaction
            .query_one(statement())
            .await
            .unwrap()
            .unwrap();
        assert!(!row.try_get::<bool>("", "acquired").unwrap());

        first_lock.rollback().await.unwrap();
        let row = second_transaction
            .query_one(statement())
            .await
            .unwrap()
            .unwrap();
        assert!(row.try_get::<bool>("", "acquired").unwrap());
        second_transaction.rollback().await.unwrap();
    }

    fn sigint_unit() -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            company: String::new(),
            battalion: "1 мсб ТрО".to_string(),
            regiment: "4 омсбр".to_string(),
            division: String::new(),
            army: "3 ЗВА".to_string(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: Uuid::new_v4(),
            name: "1 мсб ТрО 4 омсбр 3 ЗВА".to_string(),
            comment: String::new(),
            sigint_origin_id: None,
            original_id: None,
        }
    }
}
