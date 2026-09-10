use super::{matching, persistence, tui, EchoEchelon};
use crate::config::{
    ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
    ORBIT_ECHELON_MOVE_FIX_MANUAL_PERSIST_BATCH_SIZE,
    ORBIT_ECHELON_MOVE_FIX_QUERY_BATCH_SIZE,
};
use crate::entities::{
    orbit_sync, orbit_unit, orbit_unit_echelon, sigint_unit,
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
use std::collections::{BTreeMap, HashMap, HashSet};

const ORBIT_ECHELON_KEYS: [&str; 7] = [
    "regiment",
    "brigade",
    "division",
    "corps",
    "fieldArmy",
    "militaryDistrict",
    "armyRegion",
];
const ORBIT_ECHELONS: [EchoEchelon; 7] = [
    EchoEchelon::Regiment,
    EchoEchelon::Brigade,
    EchoEchelon::Division,
    EchoEchelon::Corps,
    EchoEchelon::Army,
    EchoEchelon::MilitaryDistrict,
    EchoEchelon::ArmyRegion,
];
const ECHELON_MOVES: [EchelonMove; 5] = [
    EchelonMove::RegimentToBrigade,
    EchelonMove::CorpsToArmy,
    EchelonMove::Army,
    EchelonMove::MilitaryDistrict,
    EchelonMove::ArmyRegion,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EchelonMove {
    RegimentToBrigade,
    CorpsToArmy,
    Army,
    MilitaryDistrict,
    ArmyRegion,
}

impl EchelonMove {
    fn label(self) -> &'static str {
        match self {
            Self::RegimentToBrigade => "regiment → brigade",
            Self::CorpsToArmy => "corps → army",
            Self::Army => "army",
            Self::MilitaryDistrict => "group of armies",
            Self::ArmyRegion => "army region",
        }
    }

    fn source_echelon(self) -> EchoEchelon {
        match self {
            Self::RegimentToBrigade => EchoEchelon::Regiment,
            Self::CorpsToArmy => EchoEchelon::Corps,
            Self::Army => EchoEchelon::Army,
            Self::MilitaryDistrict => EchoEchelon::MilitaryDistrict,
            Self::ArmyRegion => EchoEchelon::ArmyRegion,
        }
    }

    fn accepts_destination(self, destination: EchoEchelon) -> bool {
        match self {
            Self::RegimentToBrigade => destination == EchoEchelon::Brigade,
            Self::CorpsToArmy => destination == EchoEchelon::Army,
            Self::Army | Self::MilitaryDistrict | Self::ArmyRegion => true,
        }
    }

    fn removes_unknown_value(self) -> bool {
        matches!(self, Self::Army | Self::MilitaryDistrict | Self::ArmyRegion)
    }

    fn source_attribute(self) -> &'static str {
        match self {
            Self::RegimentToBrigade => "regiment",
            Self::CorpsToArmy => "corps",
            Self::Army => "army",
            Self::MilitaryDistrict => "military_district",
            Self::ArmyRegion => "army_region",
        }
    }

    fn source_column(self) -> sigint_unit::Column {
        match self {
            Self::RegimentToBrigade => sigint_unit::Column::Regiment,
            Self::CorpsToArmy => sigint_unit::Column::Corps,
            Self::Army => sigint_unit::Column::Army,
            Self::MilitaryDistrict => sigint_unit::Column::MilitaryDistrict,
            Self::ArmyRegion => sigint_unit::Column::ArmyRegion,
        }
    }

    fn source_value(self, unit: &EchelonMoveUnit) -> &str {
        match self {
            Self::RegimentToBrigade => &unit.regiment,
            Self::CorpsToArmy => &unit.corps,
            Self::Army => &unit.army,
            Self::MilitaryDistrict => &unit.military_district,
            Self::ArmyRegion => &unit.army_region,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EchelonMoveChange {
    unit_name: String,
    hierarchy_change: OrbitUnitHierarchyChange,
}

#[derive(Default)]
struct ManualReview {
    selected: Vec<EchelonMoveChange>,
    skipped: usize,
    unreviewed: usize,
    stopped: bool,
}

#[derive(Default)]
struct PersistSummary {
    changed: usize,
    stale: usize,
}

struct OrbitValueCache {
    orbit_sync: orbit_sync::Model,
    values: HashMap<EchoEchelon, HashSet<String>>,
}

#[derive(sea_orm::FromQueryResult)]
struct EchelonMoveUnit {
    id: i64,
    name: String,
    regiment: String,
    brigade: String,
    division: String,
    corps: String,
    army: String,
    military_district: String,
    army_region: String,
}

#[derive(Default, sea_orm::FromQueryResult)]
struct OrbitEchelonIdentity {
    unit_name: Option<String>,
    unit_name_original: Option<String>,
    unit_name_short: Option<String>,
    operational_unit_name_full: Option<String>,
    generative_unit_name_full: Option<String>,
    unit_number: Option<String>,
    unit_alternate_names: Option<Vec<String>>,
    unit_alternate_numbers: Option<Vec<String>>,
    echelon_key: String,
}

pub(super) async fn run(mode: Mode) -> anyhow::Result<()> {
    let Some(fix_mode) = tui::prompt_echelon_move_fix_mode().c(h!())? else {
        return Ok(());
    };
    let Some(activity_scope) = tui::prompt_unit_activity_scope(
        "Choose misplaced-echelon fix scope (↑/↓, Enter, Esc: quit)",
    )
    .c(h!())?
    else {
        return Ok(());
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
    let mut orbit_value_cache = None;
    for echelon_move in ECHELON_MOVES {
        let stopped = run_pass(
            db,
            echelon_move,
            fix_mode,
            activity_scope,
            &mut orbit_value_cache,
        )
        .await
        .c(h!())?;
        if stopped {
            break;
        }
    }
    Ok(())
}

async fn run_pass(
    db: &sea_orm::DatabaseConnection,
    echelon_move: EchelonMove,
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    orbit_value_cache: &mut Option<OrbitValueCache>,
) -> anyhow::Result<bool> {
    let changes = load_initial_changes(
        db,
        echelon_move,
        activity_scope,
        orbit_value_cache,
    )
    .await
    .c(h!())?;
    let candidate_count = changes.len();
    let review = match fix_mode {
        tui::LinkMode::Automatic => ManualReview {
            selected: changes,
            ..Default::default()
        },
        tui::LinkMode::Manual => {
            review_manually(echelon_move, &changes).c(h!())?
        }
    };
    let accepted = review.selected.len();
    let persisted = persist_changes(
        db,
        &review.selected,
        echelon_move,
        fix_mode,
        activity_scope,
        orbit_value_cache,
    )
    .await
    .c(h!())?;
    println!(
        "Misplaced-echelon fix ({}): {candidate_count} candidates, {accepted} accepted, {} skipped, {} stale, {} unreviewed; {} SIGINT units changed.",
        echelon_move.label(),
        review.skipped,
        persisted.stale,
        review.unreviewed,
        persisted.changed,
    );
    Ok(review.stopped)
}

async fn load_initial_changes(
    db: &sea_orm::DatabaseConnection,
    echelon_move: EchelonMove,
    activity_scope: tui::UnitActivityScope,
    orbit_value_cache: &mut Option<OrbitValueCache>,
) -> anyhow::Result<Vec<EchelonMoveChange>> {
    let transaction = super::acquire_import_lock(db).await.c(h!())?;
    let mut changes = Vec::new();
    let mut after_unit_id = None;
    loop {
        let units = load_initial_unit_page(
            &transaction,
            echelon_move,
            activity_scope,
            after_unit_id,
        )
        .await
        .c(h!())?;
        let Some(last_unit_id) = units.last().map(|unit| unit.id) else {
            break;
        };
        after_unit_id = Some(last_unit_id);
        refresh_orbit_value_cache(&transaction, orbit_value_cache)
            .await
            .c(h!())?;
        let orbit_values = &orbit_value_cache
            .as_ref()
            .expect("ORBIT value cache must be populated")
            .values;
        changes.extend(units.into_iter().filter_map(|unit| {
            proposed_change(&unit, echelon_move, orbit_values)
        }));
    }
    transaction.commit().await.c(h!())?;
    Ok(changes)
}

async fn load_initial_unit_page<C>(
    db: &C,
    echelon_move: EchelonMove,
    activity_scope: tui::UnitActivityScope,
    after_unit_id: Option<i64>,
) -> anyhow::Result<Vec<EchelonMoveUnit>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .select_only()
        .columns([
            sigint_unit::Column::Id,
            sigint_unit::Column::Name,
            sigint_unit::Column::Regiment,
            sigint_unit::Column::Brigade,
            sigint_unit::Column::Division,
            sigint_unit::Column::Corps,
            sigint_unit::Column::Army,
            sigint_unit::Column::MilitaryDistrict,
            sigint_unit::Column::ArmyRegion,
        ])
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(echelon_move.source_column().ne(""))
        .order_by_asc(sigint_unit::Column::Id)
        .limit(ORBIT_ECHELON_MOVE_FIX_QUERY_BATCH_SIZE);
    if let Some(active) = activity_scope.active() {
        units = units.filter(sigint_unit::Column::Active.eq(active));
    }
    if let Some(after_unit_id) = after_unit_id {
        units = units.filter(sigint_unit::Column::Id.gt(after_unit_id));
    }
    units.into_model::<EchelonMoveUnit>().all(db).await.c(h!())
}

async fn load_changes<C>(
    db: &C,
    unit_ids: Option<&[i64]>,
    lock: bool,
    echelon_move: EchelonMove,
    activity_scope: tui::UnitActivityScope,
    orbit_value_cache: &mut Option<OrbitValueCache>,
) -> anyhow::Result<Vec<EchelonMoveChange>>
where
    C: ConnectionTrait,
{
    let mut units = sigint_unit::Entity::find()
        .select_only()
        .columns([
            sigint_unit::Column::Id,
            sigint_unit::Column::Name,
            sigint_unit::Column::Regiment,
            sigint_unit::Column::Brigade,
            sigint_unit::Column::Division,
            sigint_unit::Column::Corps,
            sigint_unit::Column::Army,
            sigint_unit::Column::MilitaryDistrict,
            sigint_unit::Column::ArmyRegion,
        ])
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(echelon_move.source_column().ne(""))
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
        .into_model::<EchelonMoveUnit>()
        .all(db)
        .await
        .c(h!())?;
    if units.is_empty() {
        return Ok(Vec::new());
    }
    refresh_orbit_value_cache(db, orbit_value_cache)
        .await
        .c(h!())?;
    let orbit_values = &orbit_value_cache
        .as_ref()
        .expect("ORBIT value cache must be populated")
        .values;
    Ok(units
        .into_iter()
        .filter_map(|unit| proposed_change(&unit, echelon_move, orbit_values))
        .collect())
}

async fn refresh_orbit_value_cache<C>(
    db: &C,
    orbit_value_cache: &mut Option<OrbitValueCache>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let orbit_sync = persistence::load_latest_sync(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("ORBIT data has not been synchronized"))
        .c(h!())?;
    if orbit_value_cache
        .as_ref()
        .is_some_and(|cache| cache.orbit_sync == orbit_sync)
    {
        return Ok(());
    }
    let units = orbit_unit::Entity::find()
        .select_only()
        .columns([
            orbit_unit::Column::UnitName,
            orbit_unit::Column::UnitNameOriginal,
            orbit_unit::Column::UnitNameShort,
            orbit_unit::Column::OperationalUnitNameFull,
            orbit_unit::Column::GenerativeUnitNameFull,
            orbit_unit::Column::UnitNumber,
            orbit_unit::Column::UnitAlternateNames,
            orbit_unit::Column::UnitAlternateNumbers,
        ])
        .column_as(orbit_unit_echelon::Column::Key, "echelon_key")
        .join(
            JoinType::InnerJoin,
            orbit_unit::Relation::OrbitUnitEchelon.def(),
        )
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::UpdatedAt.eq(orbit_sync.synced_at))
        .filter(orbit_unit_echelon::Column::Key.is_in(ORBIT_ECHELON_KEYS))
        .into_model::<OrbitEchelonIdentity>()
        .all(db)
        .await
        .c(h!())?;
    let mut values = HashMap::<EchoEchelon, HashSet<String>>::new();
    for unit in units {
        let Some(echelon) = super::echo_echelon(&unit.echelon_key) else {
            continue;
        };
        insert_orbit_unit_values(&mut values, echelon, &unit);
    }
    *orbit_value_cache = Some(OrbitValueCache { orbit_sync, values });
    Ok(())
}

fn insert_orbit_unit_values(
    values: &mut HashMap<EchoEchelon, HashSet<String>>,
    echelon: EchoEchelon,
    unit: &OrbitEchelonIdentity,
) {
    let hierarchy_roots = [
        unit.operational_unit_name_full.as_deref(),
        unit.generative_unit_name_full.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|name| name.split(" / ").next());
    let names = unit
        .unit_name_short
        .iter()
        .chain(&unit.unit_name)
        .chain(&unit.unit_name_original)
        .chain(&unit.unit_number)
        .map(String::as_str)
        .chain(
            unit.unit_alternate_names
                .iter()
                .flatten()
                .map(String::as_str),
        )
        .chain(
            unit.unit_alternate_numbers
                .iter()
                .flatten()
                .map(String::as_str),
        )
        .chain(hierarchy_roots);
    for name in names {
        let name = matching::normalize_name(name);
        if !name.is_empty() {
            values.entry(echelon).or_default().insert(name);
        }
    }
}

fn matching_echelons(
    value: &str,
    orbit_values: &HashMap<EchoEchelon, HashSet<String>>,
) -> Vec<EchoEchelon> {
    ORBIT_ECHELONS
        .into_iter()
        .filter(|echelon| {
            let candidate =
                matching::normalize_sigint_name_for_echelon(*echelon, value);
            !candidate.is_empty()
                && orbit_values.get(echelon).is_some_and(|names| {
                    matching::names_match(*echelon, names, &candidate)
                })
        })
        .collect()
}

fn proposed_change(
    unit: &EchelonMoveUnit,
    echelon_move: EchelonMove,
    orbit_values: &HashMap<EchoEchelon, HashSet<String>>,
) -> Option<EchelonMoveChange> {
    let source = echelon_move.source_value(unit);
    if source.is_empty() {
        return None;
    }
    let source_echelon = echelon_move.source_echelon();
    let matching_echelons = matching_echelons(source, orbit_values);
    if matching_echelons.contains(&source_echelon) {
        return None;
    }
    let destination = match matching_echelons.as_slice() {
        [destination] if echelon_move.accepts_destination(*destination) => {
            Some(*destination)
        }
        [] if echelon_move.removes_unknown_value() => None,
        _ => return None,
    };
    let attributes = destination.map_or_else(
        || {
            vec![OrbitUnitAttributeChange {
                attribute: echelon_move.source_attribute(),
                current: source.to_string(),
                proposed: String::new(),
            }]
        },
        |destination| {
            move_attributes(
                unit,
                source_echelon,
                destination,
                source,
                orbit_values,
            )
        },
    );
    Some(EchelonMoveChange {
        unit_name: unit.name.clone(),
        hierarchy_change: OrbitUnitHierarchyChange {
            sigint_unit_id: unit.id,
            attributes,
        },
    })
}

fn move_attributes(
    unit: &EchelonMoveUnit,
    source_echelon: EchoEchelon,
    destination_echelon: EchoEchelon,
    source: &str,
    orbit_values: &HashMap<EchoEchelon, HashSet<String>>,
) -> Vec<OrbitUnitAttributeChange> {
    let destination = echelon_value(unit, destination_echelon);
    let mut attributes = Vec::with_capacity(2);
    if destination != source {
        attributes.push(OrbitUnitAttributeChange {
            attribute: echelon_attribute(destination_echelon),
            current: destination.to_string(),
            proposed: source.to_string(),
        });
    }
    let displaced_destination = if destination != source
        && matching_echelons(destination, orbit_values) == [source_echelon]
    {
        destination.to_string()
    } else {
        String::new()
    };
    attributes.push(OrbitUnitAttributeChange {
        attribute: echelon_attribute(source_echelon),
        current: source.to_string(),
        proposed: displaced_destination,
    });
    attributes
}

fn echelon_attribute(echelon: EchoEchelon) -> &'static str {
    match echelon {
        EchoEchelon::Regiment => "regiment",
        EchoEchelon::Brigade => "brigade",
        EchoEchelon::Division => "division",
        EchoEchelon::Corps => "corps",
        EchoEchelon::Army => "army",
        EchoEchelon::MilitaryDistrict => "military_district",
        EchoEchelon::ArmyRegion => "army_region",
        _ => unreachable!("unsupported ORBIT echelon move destination"),
    }
}

fn echelon_value(unit: &EchelonMoveUnit, echelon: EchoEchelon) -> &str {
    match echelon {
        EchoEchelon::Regiment => &unit.regiment,
        EchoEchelon::Brigade => &unit.brigade,
        EchoEchelon::Division => &unit.division,
        EchoEchelon::Corps => &unit.corps,
        EchoEchelon::Army => &unit.army,
        EchoEchelon::MilitaryDistrict => &unit.military_district,
        EchoEchelon::ArmyRegion => &unit.army_region,
        _ => unreachable!("unsupported ORBIT echelon move destination"),
    }
}

fn review_manually(
    echelon_move: EchelonMove,
    changes: &[EchelonMoveChange],
) -> anyhow::Result<ManualReview> {
    if changes.is_empty() {
        return Ok(ManualReview::default());
    }
    let mut terminal = tui::setup_terminal().c(h!())?;
    let result = review_manually_inner(&mut terminal, echelon_move, changes);
    tui::restore_terminal(&mut terminal).c(h!())?;
    result.c(h!())
}

fn review_manually_inner(
    terminal: &mut tui::OrbitTerminal,
    echelon_move: EchelonMove,
    changes: &[EchelonMoveChange],
) -> anyhow::Result<ManualReview> {
    let mut review = ManualReview::default();
    for (index, change) in changes.iter().enumerate() {
        let diffs = change
            .hierarchy_change
            .attributes
            .iter()
            .map(|attribute| tui::EchelonMoveDiff {
                attribute: attribute.attribute,
                current: attribute.current.clone(),
                proposed: attribute.proposed.clone(),
            })
            .collect::<Vec<_>>();
        match tui::review_echelon_move_changes(
            terminal,
            change.hierarchy_change.sigint_unit_id,
            &change.unit_name,
            echelon_move.label(),
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
                review.stopped = true;
                break;
            }
        }
    }
    Ok(review)
}

async fn persist_changes(
    db: &sea_orm::DatabaseConnection,
    changes: &[EchelonMoveChange],
    echelon_move: EchelonMove,
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    orbit_value_cache: &mut Option<OrbitValueCache>,
) -> anyhow::Result<PersistSummary> {
    let batch_size = match fix_mode {
        tui::LinkMode::Automatic => ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
        tui::LinkMode::Manual => {
            ORBIT_ECHELON_MOVE_FIX_MANUAL_PERSIST_BATCH_SIZE
        }
    };
    let mut summary = PersistSummary::default();
    for changes in changes.chunks(batch_size) {
        let persisted = persist_change_batch(
            db,
            changes,
            echelon_move,
            fix_mode,
            activity_scope,
            orbit_value_cache,
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
    changes: &[EchelonMoveChange],
    echelon_move: EchelonMove,
    fix_mode: tui::LinkMode,
    activity_scope: tui::UnitActivityScope,
    orbit_value_cache: &mut Option<OrbitValueCache>,
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
        true,
        echelon_move,
        activity_scope,
        orbit_value_cache,
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
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[test]
    fn proposes_all_requested_echelon_moves() {
        let cases = [
            (
                EchelonMove::RegimentToBrigade,
                EchoEchelon::Brigade,
                "53 зрбр",
                "old brigade",
                "brigade",
                "regiment",
            ),
            (
                EchelonMove::CorpsToArmy,
                EchoEchelon::Army,
                "20 ЗВА",
                "old army",
                "army",
                "corps",
            ),
            (
                EchelonMove::Army,
                EchoEchelon::Corps,
                "11 АК",
                "old corps",
                "corps",
                "army",
            ),
        ];
        for (
            echelon_move,
            destination_echelon,
            source,
            destination,
            target,
            cleared,
        ) in cases
        {
            let mut unit = sigint_unit();
            match echelon_move {
                EchelonMove::RegimentToBrigade => {
                    unit.regiment = source.to_string();
                    unit.brigade = destination.to_string();
                }
                EchelonMove::CorpsToArmy => {
                    unit.corps = source.to_string();
                    unit.army = destination.to_string();
                }
                EchelonMove::Army => {
                    unit.army = source.to_string();
                    unit.corps = destination.to_string();
                }
                EchelonMove::MilitaryDistrict | EchelonMove::ArmyRegion => {
                    unreachable!("test case must have a configured source")
                }
            }
            let values = HashMap::from([(
                destination_echelon,
                HashSet::from([matching::normalize_name(source)]),
            )]);

            let change = proposed_change(&unit, echelon_move, &values)
                .expect("matching ORBIT value must be moved");

            assert_eq!(
                change.hierarchy_change.attributes,
                vec![
                    OrbitUnitAttributeChange {
                        attribute: target,
                        current: destination.to_string(),
                        proposed: source.to_string(),
                    },
                    OrbitUnitAttributeChange {
                        attribute: cleared,
                        current: source.to_string(),
                        proposed: String::new(),
                    },
                ]
            );
        }
    }

    #[test]
    fn uses_standard_orbit_name_normalization() {
        let mut unit = sigint_unit();
        unit.corps = "20 ЗВА".to_string();
        let values = HashMap::from([(
            EchoEchelon::Army,
            HashSet::from([matching::normalize_name("20 ОА")]),
        )]);

        assert!(proposed_change(&unit, EchelonMove::CorpsToArmy, &values,)
            .is_some());
        assert!(proposed_change(&unit, EchelonMove::Army, &values).is_none());
    }

    #[test]
    fn moves_division_values_from_army_and_higher_fields() {
        for echelon_move in [
            EchelonMove::Army,
            EchelonMove::MilitaryDistrict,
            EchelonMove::ArmyRegion,
        ] {
            let mut unit = sigint_unit();
            match echelon_move {
                EchelonMove::Army => unit.army = "47 тд".to_string(),
                EchelonMove::MilitaryDistrict => {
                    unit.military_district = "47 тд".to_string()
                }
                EchelonMove::ArmyRegion => {
                    unit.army_region = "47 тд".to_string()
                }
                _ => unreachable!("test only covers army-and-higher fields"),
            }
            let values = HashMap::from([(
                EchoEchelon::Division,
                HashSet::from([matching::normalize_name("47 тд")]),
            )]);

            let change = proposed_change(&unit, echelon_move, &values)
                .expect("division value must be moved");

            assert_eq!(
                change.hierarchy_change.attributes,
                vec![
                    OrbitUnitAttributeChange {
                        attribute: "division",
                        current: String::new(),
                        proposed: "47 тд".to_string(),
                    },
                    OrbitUnitAttributeChange {
                        attribute: echelon_move.source_attribute(),
                        current: "47 тд".to_string(),
                        proposed: String::new(),
                    },
                ]
            );
        }
    }

    #[test]
    fn moves_or_removes_incorrect_army_and_higher_values() {
        let mut unit = sigint_unit();
        unit.army = "МВО".to_string();
        let values = HashMap::from([(
            EchoEchelon::MilitaryDistrict,
            HashSet::from([matching::normalize_name("МВО")]),
        )]);

        let change = proposed_change(&unit, EchelonMove::Army, &values)
            .expect("misplaced group of armies must be moved");
        assert_eq!(
            change.hierarchy_change.attributes,
            vec![
                OrbitUnitAttributeChange {
                    attribute: "military_district",
                    current: String::new(),
                    proposed: "МВО".to_string(),
                },
                OrbitUnitAttributeChange {
                    attribute: "army",
                    current: "МВО".to_string(),
                    proposed: String::new(),
                },
            ]
        );

        unit.army = "unknown".to_string();
        let change = proposed_change(&unit, EchelonMove::Army, &values)
            .expect("unknown army-and-higher value must be removed");
        assert_eq!(
            change.hierarchy_change.attributes,
            vec![OrbitUnitAttributeChange {
                attribute: "army",
                current: "unknown".to_string(),
                proposed: String::new(),
            }]
        );

        unit.army.clear();
        unit.military_district = "МВО".to_string();
        assert!(
            proposed_change(&unit, EchelonMove::MilitaryDistrict, &values,)
                .is_none()
        );
    }

    #[test]
    fn skips_values_ambiguous_between_echelons() {
        let mut unit = sigint_unit();
        unit.regiment = "shared".to_string();
        let shared = HashSet::from([matching::normalize_name("shared")]);
        let values = HashMap::from([
            (EchoEchelon::Regiment, shared.clone()),
            (EchoEchelon::Brigade, shared),
        ]);

        assert!(proposed_change(
            &unit,
            EchelonMove::RegimentToBrigade,
            &values,
        )
        .is_none());
    }

    #[test]
    fn swaps_reciprocal_army_and_corps_values() {
        let mut unit = sigint_unit();
        unit.corps = "20 ЗВА".to_string();
        unit.army = "11 АК".to_string();
        let values = HashMap::from([
            (
                EchoEchelon::Army,
                HashSet::from([matching::normalize_name("20 ЗВА")]),
            ),
            (
                EchoEchelon::Corps,
                HashSet::from([matching::normalize_name("11 АК")]),
            ),
        ]);

        let change = proposed_change(&unit, EchelonMove::CorpsToArmy, &values)
            .expect("reciprocal values must be swapped");
        assert_eq!(
            change.hierarchy_change.attributes,
            vec![
                OrbitUnitAttributeChange {
                    attribute: "army",
                    current: "11 АК".to_string(),
                    proposed: "20 ЗВА".to_string(),
                },
                OrbitUnitAttributeChange {
                    attribute: "corps",
                    current: "20 ЗВА".to_string(),
                    proposed: "11 АК".to_string(),
                },
            ]
        );
    }

    #[test]
    fn includes_required_orbit_hierarchy_root_names() {
        let orbit_unit = OrbitEchelonIdentity {
            operational_unit_name_full: Some("МВО / ЗС РФ".to_string()),
            ..Default::default()
        };
        let mut values = HashMap::new();

        insert_orbit_unit_values(
            &mut values,
            EchoEchelon::MilitaryDistrict,
            &orbit_unit,
        );

        assert_eq!(
            values[&EchoEchelon::MilitaryDistrict],
            HashSet::from([matching::normalize_name("МВО")]),
        );
    }

    #[tokio::test]
    #[serial]
    async fn automatic_move_honors_activity_scope_and_persists() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let synced_at = chrono::Utc::now().naive_utc();
        persistence::record_sync(
            &env.dbx,
            &uuid::Uuid::new_v4().simple().to_string(),
            synced_at,
        )
        .await
        .unwrap();
        let brigade_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("brigade"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let company_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("company"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let brigade = format!("{} зрбр", uuid::Uuid::new_v4().simple());
        let orbit_brigade = orbit_unit::ActiveModel {
            unit_id: Set(uuid::Uuid::new_v4()),
            unit_name_short: Set(Some(brigade.clone())),
            unit_echelon_id: Set(Some(brigade_echelon_id)),
            deleted: Set(false),
            created_at: Set(synced_at),
            updated_at: Set(synced_at),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let company = format!("{} рота", uuid::Uuid::new_v4().simple());
        let orbit_company = orbit_unit::ActiveModel {
            unit_id: Set(uuid::Uuid::new_v4()),
            unit_name_short: Set(Some(company.clone())),
            unit_echelon_id: Set(Some(company_echelon_id)),
            generative_parent_unit_id: Set(Some(orbit_brigade.unit_id)),
            deleted: Set(false),
            created_at: Set(synced_at),
            updated_at: Set(synced_at),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let parent = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                brigade: Set(brigade.clone()),
                name: Set(format!("parent {brigade}")),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let active = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                company: Set(company),
                regiment: Set(brigade.clone()),
                name: Set(format!("active {brigade}")),
                active: Set(true),
                is_inconsistent: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        persistence::replace_sigint_unit_link(
            &env.dbx,
            active.id,
            orbit_company.unit_id,
        )
        .await
        .unwrap();
        let inactive = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set(brigade.clone()),
                name: Set(format!("inactive {brigade}")),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut orbit_value_cache = None;
        let changes = load_changes(
            &env.dbx,
            None,
            false,
            EchelonMove::RegimentToBrigade,
            tui::UnitActivityScope::Active,
            &mut orbit_value_cache,
        )
        .await
        .unwrap();

        assert_eq!(
            changes
                .iter()
                .map(|change| change.hierarchy_change.sigint_unit_id)
                .collect::<Vec<_>>(),
            vec![active.id],
        );
        let summary = persist_changes(
            &env.dbx,
            &changes,
            EchelonMove::RegimentToBrigade,
            tui::LinkMode::Automatic,
            tui::UnitActivityScope::Active,
            &mut orbit_value_cache,
        )
        .await
        .unwrap();

        assert_eq!(summary.changed, 1);
        assert_eq!(summary.stale, 0);
        let active = sigint_unit::Entity::find_by_id(active.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let inactive = sigint_unit::Entity::find_by_id(inactive.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let parent = sigint_unit::Entity::find_by_id(parent.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(active.regiment, "");
        assert_eq!(active.brigade, brigade);
        assert!(!active.is_inconsistent);
        assert_eq!(inactive.regiment, brigade);
        assert_eq!(inactive.brigade, "");
        assert!(parent.active);
    }

    #[tokio::test]
    #[serial]
    async fn automatic_fix_keeps_army_matching_alternate_orbit_number() {
        let env = crate::functest::tests::cleanup().await.unwrap();
        let synced_at = chrono::Utc::now().naive_utc();
        persistence::record_sync(
            &env.dbx,
            &uuid::Uuid::new_v4().simple().to_string(),
            synced_at,
        )
        .await
        .unwrap();
        let army_echelon_id = orbit_unit_echelon::Entity::find()
            .filter(orbit_unit_echelon::Column::Key.eq("fieldArmy"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        let alternate_number = uuid::Uuid::new_v4().simple().to_string();
        orbit_unit::ActiveModel {
            unit_id: Set(uuid::Uuid::new_v4()),
            unit_alternate_numbers: Set(Some(vec![alternate_number.clone()])),
            unit_echelon_id: Set(Some(army_echelon_id)),
            deleted: Set(false),
            created_at: Set(synced_at),
            updated_at: Set(synced_at),
            is_snapshot_root: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let sigint_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                army: Set(alternate_number),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut orbit_value_cache = None;

        let changes = load_changes(
            &env.dbx,
            Some(&[sigint_unit.id]),
            false,
            EchelonMove::Army,
            tui::UnitActivityScope::Both,
            &mut orbit_value_cache,
        )
        .await
        .unwrap();

        assert!(changes.is_empty());
    }

    fn sigint_unit() -> EchelonMoveUnit {
        EchelonMoveUnit {
            id: 1,
            name: "test unit".to_string(),
            regiment: String::new(),
            brigade: String::new(),
            division: String::new(),
            corps: String::new(),
            army: String::new(),
            military_district: String::new(),
            army_region: String::new(),
        }
    }
}
