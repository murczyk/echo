use super::{matching, persistence, tui, EchoEchelon};
use crate::config::{
    ORBIT_AUTOMATIC_PERSIST_BATCH_SIZE,
    ORBIT_ECHELON_MOVE_FIX_MANUAL_PERSIST_BATCH_SIZE,
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
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use std::collections::{BTreeMap, HashMap, HashSet};

const ORBIT_ECHELON_KEYS: [&str; 3] = ["brigade", "fieldArmy", "corps"];
const ECHELON_MOVES: [EchelonMove; 3] = [
    EchelonMove::RegimentToBrigade,
    EchelonMove::CorpsToArmy,
    EchelonMove::ArmyToCorps,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EchelonMove {
    RegimentToBrigade,
    CorpsToArmy,
    ArmyToCorps,
}

impl EchelonMove {
    fn label(self) -> &'static str {
        match self {
            Self::RegimentToBrigade => "regiment → brigade",
            Self::CorpsToArmy => "corps → army",
            Self::ArmyToCorps => "army → corps",
        }
    }

    fn orbit_echelon(self) -> EchoEchelon {
        match self {
            Self::RegimentToBrigade => EchoEchelon::Brigade,
            Self::CorpsToArmy => EchoEchelon::Army,
            Self::ArmyToCorps => EchoEchelon::Corps,
        }
    }

    fn source_attribute(self) -> &'static str {
        match self {
            Self::RegimentToBrigade => "regiment",
            Self::CorpsToArmy => "corps",
            Self::ArmyToCorps => "army",
        }
    }

    fn destination_attribute(self) -> &'static str {
        match self {
            Self::RegimentToBrigade => "brigade",
            Self::CorpsToArmy => "army",
            Self::ArmyToCorps => "corps",
        }
    }

    fn source_column(self) -> sigint_unit::Column {
        match self {
            Self::RegimentToBrigade => sigint_unit::Column::Regiment,
            Self::CorpsToArmy => sigint_unit::Column::Corps,
            Self::ArmyToCorps => sigint_unit::Column::Army,
        }
    }

    fn source_value(self, unit: &sigint_unit::Model) -> &str {
        match self {
            Self::RegimentToBrigade => &unit.regiment,
            Self::CorpsToArmy => &unit.corps,
            Self::ArmyToCorps => &unit.army,
        }
    }

    fn destination_value(self, unit: &sigint_unit::Model) -> &str {
        match self {
            Self::RegimentToBrigade => &unit.brigade,
            Self::CorpsToArmy => &unit.army,
            Self::ArmyToCorps => &unit.corps,
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
    let changes = load_changes(
        db,
        None,
        false,
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
    let units = units.all(db).await.c(h!())?;
    if units.is_empty() {
        return Ok(Vec::new());
    }
    refresh_orbit_value_cache(db, orbit_value_cache)
        .await
        .c(h!())?;
    let orbit_values = orbit_value_cache
        .as_ref()
        .expect("ORBIT value cache must be populated")
        .values
        .get(&echelon_move.orbit_echelon());
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
        .find_also_related(orbit_unit_echelon::Entity)
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::UpdatedAt.eq(orbit_sync.synced_at))
        .filter(orbit_unit_echelon::Column::Key.is_in(ORBIT_ECHELON_KEYS))
        .all(db)
        .await
        .c(h!())?;
    let mut values = HashMap::<EchoEchelon, HashSet<String>>::new();
    for (unit, echelon) in units {
        let Some(echelon) = echelon
            .as_ref()
            .and_then(|echelon| super::echo_echelon(&echelon.key))
        else {
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
    unit: &orbit_unit::Model,
) {
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
        );
    for name in names {
        let name = matching::normalize_name(name);
        if !name.is_empty() {
            values.entry(echelon).or_default().insert(name);
        }
    }
}

fn proposed_change(
    unit: &sigint_unit::Model,
    echelon_move: EchelonMove,
    orbit_values: Option<&HashSet<String>>,
) -> Option<EchelonMoveChange> {
    let source = echelon_move.source_value(unit);
    let normalized_source = matching::normalize_sigint_name_for_echelon(
        echelon_move.orbit_echelon(),
        source,
    );
    let orbit_values = orbit_values?;
    if normalized_source.is_empty()
        || !matching::names_match(
            echelon_move.orbit_echelon(),
            orbit_values,
            &normalized_source,
        )
    {
        return None;
    }
    let destination = echelon_move.destination_value(unit);
    let mut attributes = Vec::with_capacity(2);
    if destination != source {
        attributes.push(OrbitUnitAttributeChange {
            attribute: echelon_move.destination_attribute(),
            current: destination.to_string(),
            proposed: source.to_string(),
        });
    }
    attributes.push(OrbitUnitAttributeChange {
        attribute: echelon_move.source_attribute(),
        current: source.to_string(),
        proposed: String::new(),
    });
    Some(EchelonMoveChange {
        unit_name: unit.name.clone(),
        hierarchy_change: OrbitUnitHierarchyChange {
            sigint_unit_id: unit.id,
            attributes,
        },
    })
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
                "53 зрбр",
                "old brigade",
                "brigade",
                "regiment",
            ),
            (
                EchelonMove::CorpsToArmy,
                "20 ЗВА",
                "old army",
                "army",
                "corps",
            ),
            (
                EchelonMove::ArmyToCorps,
                "11 АК",
                "old corps",
                "corps",
                "army",
            ),
        ];
        for (echelon_move, source, destination, target, cleared) in cases {
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
                EchelonMove::ArmyToCorps => {
                    unit.army = source.to_string();
                    unit.corps = destination.to_string();
                }
            }
            let values = HashSet::from([matching::normalize_name(source)]);

            let change = proposed_change(&unit, echelon_move, Some(&values))
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
        let values = HashSet::from([matching::normalize_name("20 ОА")]);

        assert!(proposed_change(
            &unit,
            EchelonMove::CorpsToArmy,
            Some(&values),
        )
        .is_some());
        assert!(proposed_change(
            &unit,
            EchelonMove::ArmyToCorps,
            Some(&values),
        )
        .is_none());
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
        let brigade = format!("{} зрбр", uuid::Uuid::new_v4().simple());
        orbit_unit::ActiveModel {
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
        let active = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                regiment: Set(brigade.clone()),
                name: Set(format!("active {brigade}")),
                active: Set(true),
                ..Default::default()
            },
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
        assert_eq!(active.regiment, "");
        assert_eq!(active.brigade, brigade);
        assert_eq!(inactive.regiment, brigade);
        assert_eq!(inactive.brigade, "");
    }

    fn sigint_unit() -> sigint_unit::Model {
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
            name: "test unit".to_string(),
            comment: String::new(),
            battalion: String::new(),
            search_tsv: None,
            sigint_origin_id: None,
            original_id: None,
            is_deduplicate_candidate: None,
            orbit_note: None,
            army_region: String::new(),
            military_district: String::new(),
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
