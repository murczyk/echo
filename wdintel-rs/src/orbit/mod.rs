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
    TransactionTrait,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use uuid::Uuid;

mod dictionary;
mod duplicate_candidate_review;
mod duplicate_units;
mod generated_unit_names;
mod hierarchy;
mod matching;
mod persistence;
mod snapshot;
mod test_link;
mod tui;
mod types;
mod unit_name_cleanup;
mod unparsed_units;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkProvenance {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum EchoEchelon {
    Other,
    TeamOrCrew,
    Section,
    Squad,
    Platoon,
    Company,
    Battalion,
    Regiment,
    Brigade,
    Division,
    Corps,
    Army,
    MilitaryDistrict,
    ArmyRegion,
}

impl EchoEchelon {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::Other => 0,
            Self::TeamOrCrew => 1,
            Self::Section => 2,
            Self::Squad => 3,
            Self::Platoon => 4,
            Self::Company => 5,
            Self::Battalion => 6,
            Self::Regiment => 7,
            Self::Brigade => 8,
            Self::Division => 9,
            Self::Corps => 10,
            Self::Army => 11,
            Self::MilitaryDistrict => 12,
            Self::ArmyRegion => 13,
        }
    }
}

pub(crate) fn echo_echelon(key: &str) -> Option<EchoEchelon> {
    match key {
        "other" => Some(EchoEchelon::Other),
        "teamOrCrew" => Some(EchoEchelon::TeamOrCrew),
        "section" => Some(EchoEchelon::Section),
        "squad" => Some(EchoEchelon::Squad),
        "platoon" => Some(EchoEchelon::Platoon),
        "company" => Some(EchoEchelon::Company),
        "battalion" => Some(EchoEchelon::Battalion),
        "regiment" => Some(EchoEchelon::Regiment),
        "brigade" => Some(EchoEchelon::Brigade),
        "division" => Some(EchoEchelon::Division),
        "corps" => Some(EchoEchelon::Corps),
        "fieldArmy" => Some(EchoEchelon::Army),
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
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
            with affected_sigint_units as materialized (
                select $1::bigint as id
                union
                select peer_link.sigint_unit_id
                from orbit_unit_sigint_unit changed_link
                inner join orbit_unit changed_orbit_unit
                    on changed_orbit_unit.unit_id = changed_link.orbit_unit_id
                inner join orbit_unit_sigint_unit peer_link
                    on peer_link.orbit_unit_id = changed_link.orbit_unit_id
                inner join sigint_unit peer_unit
                    on peer_unit.id = peer_link.sigint_unit_id
                where changed_link.sigint_unit_id = $1
                  and changed_link.is_suppressed = false
                  and changed_orbit_unit.deleted = false
                  and peer_link.is_suppressed = false
                  and peer_unit.deleted = false
            ),
            candidate_values as (
                select
                    affected.id,
                    exists (
                        select 1
                        from orbit_unit_sigint_unit candidate_link
                        inner join orbit_unit candidate_orbit_unit
                            on candidate_orbit_unit.unit_id = candidate_link.orbit_unit_id
                        inner join orbit_unit_sigint_unit duplicate_link
                            on duplicate_link.orbit_unit_id = candidate_link.orbit_unit_id
                           and duplicate_link.sigint_unit_id <> candidate_link.sigint_unit_id
                        inner join sigint_unit duplicate_unit
                            on duplicate_unit.id = duplicate_link.sigint_unit_id
                        where candidate_link.sigint_unit_id = affected.id
                          and candidate_link.is_suppressed = false
                          and candidate_orbit_unit.deleted = false
                          and duplicate_link.is_suppressed = false
                          and duplicate_unit.deleted = false
                    ) as is_candidate
                from affected_sigint_units affected
            )
            update sigint_unit unit
            set is_deduplicate_candidate = candidate.is_candidate
            from candidate_values candidate
            where unit.id = candidate.id
              and unit.is_deduplicate_candidate
                  is distinct from candidate.is_candidate
        "#,
        [sigint_unit_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct OrbitMatchCandidate {
    pub unit_id: Uuid,
    pub unit_name: Option<String>,
    pub unit_number: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub operational_unit_name_full: Option<String>,
}

impl From<&types::SourceUnit> for OrbitMatchCandidate {
    fn from(unit: &types::SourceUnit) -> Self {
        Self {
            unit_id: unit.unit_id,
            unit_name: unit.unit_name.clone(),
            unit_number: unit.unit_number.clone(),
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

pub async fn tui_merge_unit_duplicates(
    mode: Mode,
    dry_run: bool,
) -> Result<(), AppError> {
    Ok(duplicate_units::run(mode, dry_run).await.c(h!())?)
}

pub async fn tui_resolve_unparsed_units(
    mode: Mode,
    dry_run: bool,
) -> Result<(), AppError> {
    Ok(unparsed_units::run(mode, dry_run).await.c(h!())?)
}

pub async fn tui_fix_unit_names(mode: Mode) -> Result<(), AppError> {
    Ok(unit_name_cleanup::run(mode).await.c(h!())?)
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

pub(crate) async fn try_link_sigint_unit_if_unlinked<C>(
    db: &C,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
    provenance: LinkProvenance,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    if !active_orbit_unit_exists(db, orbit_unit_id).await.c(h!())? {
        return Err(AppError::NotFound);
    }
    if sigint_unit_has_active_orbit_link(db, sigint_unit_id)
        .await
        .c(h!())?
    {
        return Ok(false);
    }
    persistence::replace_sigint_unit_link_in_transaction(
        db,
        sigint_unit_id,
        orbit_unit_id,
        provenance,
    )
    .await
    .c(h!())?;
    Ok(true)
}

pub async fn unlink_sigint_unit_with_lock(
    db: &sea_orm::DatabaseConnection,
    login: &Uuid,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError> {
    let transaction = acquire_import_lock(db).await.c(h!())?;
    crate::sigint::unit::changelog::set_author(&transaction, login)
        .await
        .c(h!())?;
    if !persistence::delete_sigint_unit_link_in_transaction(
        &transaction,
        sigint_unit_id,
        orbit_unit_id,
    )
    .await
    .c(h!())?
    {
        return Err(AppError::NotFound);
    }
    crate::sigint::unit::orbit::reconcile_sigint_unit_orbit(
        &transaction,
        login,
        sigint_unit_id,
        true,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub(crate) async fn matching_orbit_unit_ids_for_sigint_unit<C>(
    db: &C,
    sigint_unit: &sigint_unit::Model,
) -> anyhow::Result<BTreeSet<Uuid>>
where
    C: ConnectionTrait,
{
    if persistence::load_latest_sync(db).await.c(h!())?.is_none() {
        return Ok(BTreeSet::new());
    }
    let units = persistence::load_latest_synced_source_units(db)
        .await
        .c("failed to load the latest synchronized ORBIT units")?;
    Ok(matching::matching_orbit_unit_ids(&units, sigint_unit))
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
    match tui::prompt_start_action().c(h!())? {
        Some(tui::StartAction::PrepareImport) => {
            run_prepare_import(mode).await.c(h!())
        }
        Some(tui::StartAction::Import) => run_import(mode).await.c(h!()),
        Some(tui::StartAction::MergeUnitDuplicates) => {
            duplicate_units::run(mode, false).await.c(h!())
        }
        Some(tui::StartAction::ReviewSigintDuplicateCandidates) => {
            duplicate_candidate_review::run(mode).await.c(h!())
        }
        Some(tui::StartAction::ResolveUnparsedUnits) => {
            unparsed_units::run(mode, false).await.c(h!())
        }
        Some(tui::StartAction::FixUnitNames) => {
            unit_name_cleanup::run(mode).await.c(h!())
        }
        Some(tui::StartAction::ReviewGeneratedUnitNames) => {
            generated_unit_names::run(mode).await.c(h!())
        }
        Some(tui::StartAction::Reimport) => run_reimport(mode).await.c(h!()),
        None => Ok(()),
    }
}

async fn run_prepare_import(mode: Mode) -> anyhow::Result<()> {
    let Some(source_path) = tui::prompt_orbit_source_path().c(h!())? else {
        return Ok(());
    };
    prepare_import_snapshot(mode, PathBuf::from(source_path))
        .await
        .c(h!())?;
    Ok(())
}

async fn run_import(mode: Mode) -> anyhow::Result<()> {
    let snapshot = snapshot::load_latest_snapshot(mode).await.c(h!())?;
    let db = connect_database(mode).await.c(h!())?;
    let import_lock = acquire_import_lock(&db).await.c(h!())?;
    let latest_sync =
        persistence::load_latest_sync(&import_lock).await.c(h!())?;
    if let Some(sync) =
        latest_sync.filter(|sync| sync.archive_md5 == snapshot.archive_md5)
    {
        if !tui::confirm_unchanged_archive(
            &snapshot.archive_md5,
            sync.synced_at,
        )
        .c(h!())?
        {
            return Ok(());
        }
    } else {
        sync_snapshot_units(&import_lock, &snapshot).await.c(h!())?;
    }
    import_lock.commit().await.c(h!())?;
    sync_sigint_units(&db).await.c(h!())
}

async fn run_reimport(mode: Mode) -> anyhow::Result<()> {
    let snapshot = snapshot::load_latest_snapshot(mode).await.c(h!())?;
    if !tui::confirm_reimport().c(h!())? {
        return Ok(());
    }
    let db = connect_database(mode).await.c(h!())?;
    let transaction = acquire_import_lock(&db).await.c(h!())?;
    erase_orbit_data(&transaction).await.c(h!())?;
    sync_snapshot_units(&transaction, &snapshot).await.c(h!())?;
    transaction.commit().await.c(h!())?;
    sync_sigint_units(&db).await.c(h!())
}

async fn sync_sigint_units(
    db: &sea_orm::DatabaseConnection,
) -> anyhow::Result<()> {
    test_link::run_automatic_with_database(db).await.c(h!())?;
    let transaction = acquire_import_lock(db).await.c(h!())?;
    let login = crate::users::system_login_id(&transaction).await.c(h!())?;
    let imported = crate::sigint::unit::orbit::import_unlinked_orbit_units(
        &transaction,
        &login,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    println!(
        "Imported {imported} unmatched ORBIT units as inactive SIGINT units."
    );
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
    use crate::entities::{orbit_sync, orbit_unit_echelon};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[test]
    fn maps_all_orbit_echelons_to_sigint_hierarchy() {
        assert_eq!(echo_echelon("other"), Some(EchoEchelon::Other));
        assert_eq!(echo_echelon("teamOrCrew"), Some(EchoEchelon::TeamOrCrew));
        assert_eq!(echo_echelon("section"), Some(EchoEchelon::Section));
        assert_eq!(echo_echelon("squad"), Some(EchoEchelon::Squad));
        assert_eq!(echo_echelon("platoon"), Some(EchoEchelon::Platoon));
        assert_eq!(echo_echelon("company"), Some(EchoEchelon::Company));
        assert_eq!(echo_echelon("battalion"), Some(EchoEchelon::Battalion));
        assert_eq!(echo_echelon("regiment"), Some(EchoEchelon::Regiment));
        assert_eq!(echo_echelon("brigade"), Some(EchoEchelon::Brigade));
        assert_eq!(echo_echelon("division"), Some(EchoEchelon::Division));
        assert_eq!(echo_echelon("corps"), Some(EchoEchelon::Corps));
        assert_eq!(echo_echelon("fieldArmy"), Some(EchoEchelon::Army));
        assert_eq!(
            echo_echelon("militaryDistrict"),
            Some(EchoEchelon::MilitaryDistrict)
        );
        assert_eq!(echo_echelon("armyRegion"), Some(EchoEchelon::ArmyRegion));
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

    #[tokio::test]
    #[serial]
    async fn sync_links_exact_units_before_importing_unmatched_units() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let synced_at = Utc::now().naive_utc();
        let echelon_id = Uuid::new_v4();
        orbit_unit_echelon::ActiveModel {
            id: Set(echelon_id),
            key: Set("battalion".to_string()),
            name: Set(format!("Battalion-{echelon_id}")),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let exact_orbit_unit_id = Uuid::new_v4();
        let unmatched_orbit_unit_id = Uuid::new_v4();
        orbit_unit::Entity::insert_many([
            orbit_unit_for_sync(
                exact_orbit_unit_id,
                echelon_id,
                "3 мсб",
                synced_at,
            ),
            orbit_unit_for_sync(
                unmatched_orbit_unit_id,
                echelon_id,
                "4 мсб",
                synced_at,
            ),
        ])
        .exec(&env.dbx)
        .await
        .unwrap();
        let sync = persistence::record_sync(
            &env.dbx,
            "0123456789abcdef0123456789abcdef",
            synced_at,
        )
        .await
        .unwrap();
        let exact_sigint_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                battalion: Set("3 мсб".to_string()),
                active: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        sync_sigint_units(&env.dbx).await.unwrap();

        let exact_link = orbit_unit_sigint_unit::Entity::find_by_id((
            exact_orbit_unit_id,
            exact_sigint_unit.id,
        ))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert!(!exact_link.is_manual);
        let unmatched_link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(unmatched_orbit_unit_id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let unmatched_sigint_unit =
            sigint_unit::Entity::find_by_id(unmatched_link.sigint_unit_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(unmatched_link.is_manual);
        assert!(!unmatched_sigint_unit.active);
        assert_eq!(unmatched_sigint_unit.battalion, "4 мсб");

        orbit_sync::Entity::delete_by_id(sync.id)
            .exec(&env.dbx)
            .await
            .unwrap();
    }

    fn orbit_unit_for_sync(
        unit_id: Uuid,
        echelon_id: Uuid,
        name: &str,
        synced_at: chrono::NaiveDateTime,
    ) -> orbit_unit::ActiveModel {
        orbit_unit::ActiveModel {
            unit_id: Set(unit_id),
            unit_name_short: Set(Some(name.to_string())),
            operational_unit_name_full: Set(Some(name.to_string())),
            generative_unit_name_full: Set(Some(name.to_string())),
            unit_echelon_id: Set(Some(echelon_id)),
            updated_at: Set(synced_at),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
    }
}
