use crate::entities::{orbit_unit, orbit_unit_sigint_unit, sigint_unit};
use crate::error::AppError;
use crate::orbit::dictionary::DictionaryMaps;
use crate::orbit::persistence::{ExistingUnit, ImportState, ImportUnit};
use crate::types::{Mode, ShortContext};
use crate::{h, new_pg_pool_from_mode};
use anyhow::Context;
use chrono::Utc;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseTransaction, DbBackend,
    EntityTrait, JoinType, QueryFilter, QuerySelect, RelationTrait, Statement,
    TransactionSession, TransactionTrait,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use uuid::Uuid;

mod dictionary;
mod hierarchy;
mod matching;
mod persistence;
mod snapshot;
mod tui;
mod types;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum EchoEchelon {
    Company,
    Battalion,
    Regiment,
    Division,
    Army,
    MilitaryDistrict,
    ArmyRegion,
}

impl EchoEchelon {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::Company => 0,
            Self::Battalion => 1,
            Self::Regiment => 2,
            Self::Division => 3,
            Self::Army => 4,
            Self::MilitaryDistrict => 5,
            Self::ArmyRegion => 6,
        }
    }
}

pub(crate) fn echo_echelon(key: &str) -> Option<EchoEchelon> {
    match key {
        "platoon" | "company" => Some(EchoEchelon::Company),
        "battalion" => Some(EchoEchelon::Battalion),
        "regiment" | "brigade" => Some(EchoEchelon::Regiment),
        "division" => Some(EchoEchelon::Division),
        "corps" | "fieldArmy" => Some(EchoEchelon::Army),
        "militaryDistrict" => Some(EchoEchelon::MilitaryDistrict),
        "armyRegion" => Some(EchoEchelon::ArmyRegion),
        _ => None,
    }
}

pub(crate) async fn reconcile_sigint_unit_deduplicate_candidates<C>(
    db: &C,
) -> Result<(), AppError>
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
    let mut sigint_unit_ids_by_orbit_unit =
        HashMap::<Uuid, HashSet<i64>>::new();
    for link in links {
        sigint_unit_ids_by_orbit_unit
            .entry(link.orbit_unit_id)
            .or_default()
            .insert(link.sigint_unit_id);
    }
    let duplicate_sigint_unit_ids = sigint_unit_ids_by_orbit_unit
        .into_values()
        .filter(|sigint_unit_ids| sigint_unit_ids.len() > 1)
        .flatten()
        .collect::<HashSet<_>>();
    if !duplicate_sigint_unit_ids.is_empty() {
        sigint_unit::Entity::update_many()
            .col_expr(
                sigint_unit::Column::IsDeduplicateCandidate,
                sea_orm::sea_query::Expr::value(true),
            )
            .filter(
                Condition::any()
                    .add(sigint_unit::Column::IsDeduplicateCandidate.ne(true))
                    .add(sigint_unit::Column::IsDeduplicateCandidate.is_null()),
            )
            .filter(
                sigint_unit::Column::Id
                    .is_in(duplicate_sigint_unit_ids.iter().copied()),
            )
            .exec(db)
            .await
            .c(h!())?;
    }
    let mut non_duplicate_units = sigint_unit::Entity::update_many()
        .col_expr(
            sigint_unit::Column::IsDeduplicateCandidate,
            sea_orm::sea_query::Expr::value(false),
        )
        .filter(
            Condition::any()
                .add(sigint_unit::Column::IsDeduplicateCandidate.ne(false))
                .add(sigint_unit::Column::IsDeduplicateCandidate.is_null()),
        );
    if !duplicate_sigint_unit_ids.is_empty() {
        non_duplicate_units = non_duplicate_units.filter(
            sigint_unit::Column::Id
                .is_not_in(duplicate_sigint_unit_ids.iter().copied()),
        );
    }
    non_duplicate_units.exec(db).await.c(h!())?;
    Ok(())
}

pub(crate) async fn reevaluate_sigint_unit_deduplicate_candidate<C>(
    db: &C,
    sigint_unit_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    sigint_unit::Entity::update_many()
        .col_expr(
            sigint_unit::Column::IsDeduplicateCandidate,
            sea_orm::sea_query::Expr::value(Option::<bool>::None),
        )
        .filter(sigint_unit::Column::Id.eq(sigint_unit_id))
        .exec(db)
        .await
        .c(h!())?;
    reconcile_sigint_unit_deduplicate_candidates(db).await
}

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
    let transaction = acquire_import_lock(db).await.c(h!())?;
    link_sigint_unit_if_unlinked(&transaction, sigint_unit_id, orbit_unit_id)
        .await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn link_sigint_unit_if_unlinked<C>(
    db: &C,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if !active_orbit_unit_exists(db, orbit_unit_id).await? {
        return Err(AppError::NotFound);
    }
    if sigint_unit_has_active_orbit_link(db, sigint_unit_id).await? {
        return Err(AppError::BL {
            msg: "SIGINT unit already has a linked ORBIT unit".to_string(),
        });
    }
    persistence::replace_sigint_unit_link_in_transaction(
        db,
        sigint_unit_id,
        orbit_unit_id,
    )
    .await
}

pub async fn unlink_sigint_unit_with_lock(
    db: &sea_orm::DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError> {
    let _import_lock = acquire_import_lock(db).await.c(h!())?;
    if persistence::delete_sigint_unit_link(db, sigint_unit_id, orbit_unit_id)
        .await?
    {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn link_new_sigint_unit_with_lock(
    db: &sea_orm::DatabaseConnection,
    sigint_unit_id: i64,
) -> anyhow::Result<()> {
    let transaction = acquire_import_lock(db).await?;
    if persistence::load_latest_sync(db).await.c(h!())?.is_none() {
        return Ok(());
    }
    let units = persistence::load_latest_synced_source_units(db)
        .await
        .c("failed to load the latest synchronized ORBIT units")?;
    let sigint_units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .all(&transaction)
        .await
        .c("failed to load active SIGINT units for ORBIT matching")?;
    let sigint_unit_ids_by_orbit_unit =
        matching::matching_sigint_unit_ids(&units, &sigint_units);
    let orbit_unit_ids = sigint_unit_ids_by_orbit_unit
        .into_iter()
        .filter_map(|(orbit_unit_id, sigint_unit_ids)| {
            sigint_unit_ids
                .contains(&sigint_unit_id)
                .then_some(orbit_unit_id)
        })
        .collect::<BTreeSet<_>>();
    persistence::replace_automatic_sigint_unit_links_in_transaction(
        &transaction,
        sigint_unit_id,
        &orbit_unit_ids,
    )
    .await
    .c("failed to link the new SIGINT unit to ORBIT")?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    crate::sigint::unit::orbit::materialize_automatic_link_parent_chains(
        &transaction,
        &login,
        &orbit_unit_ids,
    )
    .await
    .c("failed to materialize parent chains for the new ORBIT link")?;
    transaction.commit().await.c(h!())?;
    Ok(())
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
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
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
        Some(tui::StartAction::Reimport) => run_reimport(mode).await.c(h!()),
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

async fn run_reimport(mode: Mode) -> anyhow::Result<()> {
    let snapshot = snapshot::load_latest_snapshot(mode).await?;
    if !tui::confirm_reimport()? {
        return Ok(());
    }
    let db = connect_database(mode).await?;
    let transaction = acquire_import_lock(&db).await?;
    erase_orbit_data(&transaction).await?;
    sync_snapshot_units(&transaction, &snapshot).await?;
    rebuild_sigint_unit_links(&transaction).await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn erase_orbit_data<C>(db: &C) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    db.execute_unprepared(
        r#"
truncate table
    orbit_unit_sigint_unit,
    orbit_unit_grouping_of_forces,
    orbit_unit,
    orbit_sync,
    orbit_unit_echelon,
    orbit_combat_unit_type,
    orbit_grouping_of_forces
restart identity;
"#,
    )
    .await
    .c("failed to erase ORBIT data")?;
    Ok(())
}

async fn sync_snapshot_units<C>(
    db: &C,
    snapshot: &snapshot::OrbitSnapshot,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + TransactionTrait,
{
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

async fn rebuild_sigint_unit_links<C>(db: &C) -> anyhow::Result<()>
where
    C: ConnectionTrait + TransactionTrait,
{
    if persistence::load_latest_sync(db).await.c(h!())?.is_none() {
        return Ok(());
    }
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
    let transaction = db.begin().await.c(h!())?;
    persistence::replace_sigint_unit_links_in_transaction(
        &transaction,
        &sigint_unit_ids_by_orbit_unit,
    )
    .await
    .c("failed to replace ORBIT-to-SIGINT links")?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let orbit_unit_ids = sigint_unit_ids_by_orbit_unit
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();
    crate::sigint::unit::orbit::materialize_automatic_link_parent_chains(
        &transaction,
        &login,
        &orbit_unit_ids,
    )
    .await
    .c("failed to materialize parent chains for automatic ORBIT links")?;
    transaction.commit().await.c(h!())?;
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

pub(crate) async fn acquire_import_lock(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<DatabaseTransaction> {
    log::info!("waiting for the ORBIT import advisory lock");
    let transaction = db
        .begin()
        .await
        .c("failed to begin the ORBIT import lock transaction")?;
    transaction
        .query_one_raw(Statement::from_sql_and_values(
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
        unit.military_district.as_str(),
        unit.army_region.as_str(),
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

async fn review_stale_units<C>(
    db: &C,
    started_at: chrono::NaiveDateTime,
    snapshot_unit_ids: &HashSet<Uuid>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
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

async fn review_stale_units_inner<C>(
    db: &C,
    terminal: &mut tui::OrbitTerminal,
    stale: Vec<ExistingUnit>,
    started_at: chrono::NaiveDateTime,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
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
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[test]
    fn maps_all_orbit_echelons_to_sigint_hierarchy() {
        assert_eq!(echo_echelon("platoon"), Some(EchoEchelon::Company));
        assert_eq!(echo_echelon("company"), Some(EchoEchelon::Company));
        assert_eq!(echo_echelon("battalion"), Some(EchoEchelon::Battalion));
        assert_eq!(echo_echelon("regiment"), Some(EchoEchelon::Regiment));
        assert_eq!(echo_echelon("brigade"), Some(EchoEchelon::Regiment));
        assert_eq!(echo_echelon("division"), Some(EchoEchelon::Division));
        assert_eq!(echo_echelon("corps"), Some(EchoEchelon::Army));
        assert_eq!(echo_echelon("fieldArmy"), Some(EchoEchelon::Army));
        assert_eq!(
            echo_echelon("militaryDistrict"),
            Some(EchoEchelon::MilitaryDistrict)
        );
        assert_eq!(echo_echelon("armyRegion"), Some(EchoEchelon::ArmyRegion));
    }

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
            .query_one_raw(statement())
            .await
            .unwrap()
            .unwrap();
        assert!(!row.try_get::<bool>("", "acquired").unwrap());

        first_lock.rollback().await.unwrap();
        let row = second_transaction
            .query_one_raw(statement())
            .await
            .unwrap()
            .unwrap();
        assert!(row.try_get::<bool>("", "acquired").unwrap());
        second_transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn orbit_data_erase_rolls_back_with_its_transaction() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        orbit_unit::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let orbit_unit_id = Uuid::new_v4();
        orbit_unit::ActiveModel {
            unit_id: Set(orbit_unit_id),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let transaction = env.dbx.begin().await.unwrap();

        erase_orbit_data(&transaction).await.unwrap();

        assert!(orbit_unit::Entity::find_by_id(orbit_unit_id)
            .one(&transaction)
            .await
            .unwrap()
            .is_none());
        transaction.rollback().await.unwrap();
        assert!(orbit_unit::Entity::find_by_id(orbit_unit_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
    }

    fn sigint_unit() -> sigint_unit::Model {
        sigint_unit::Model {
            id: 1,
            company: String::new(),
            battalion: "1 мсб ТрО".to_string(),
            regiment: "4 омсбр".to_string(),
            division: String::new(),
            army: "3 ЗВА".to_string(),
            army_region: String::new(),
            military_district: String::new(),
            active: true,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            created_by_login_id: Uuid::new_v4(),
            name: "1 мсб ТрО 4 омсбр 3 ЗВА".to_string(),
            comment: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
        }
    }
}
