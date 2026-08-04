use crate::config::ORBIT_STALE_GRACE_SECONDS;
use crate::entities::{
    orbit_sync, orbit_unit, orbit_unit_grouping_of_forces,
    orbit_unit_sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::orbit::dictionary::{DictionaryKind, DictionaryMaps};
use crate::orbit::hierarchy::HierarchyUnit;
use crate::orbit::types::SourceUnit;
use crate::types::ShortContext;
use chrono::{Duration, NaiveDateTime};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition,
    ConnectionTrait, DatabaseConnection, EntityTrait, IntoActiveModel,
    JoinType, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
    TransactionTrait,
};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportUnit {
    pub unit_id: Uuid,
    pub unit_name: Option<String>,
    pub unit_name_original: Option<String>,
    pub unit_name_short: Option<String>,
    pub operational_unit_name_full: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub unit_number: Option<String>,
    pub unit_alternate_names: Option<Vec<String>>,
    pub unit_alternate_numbers: Option<Vec<String>>,
    pub unit_echelon_id: Option<Uuid>,
    pub combat_unit_type_id: Option<Uuid>,
    pub grouping_of_forces_ids: Option<BTreeSet<Uuid>>,
    pub generative_parent_unit_id: Option<Uuid>,
    pub operational_parent_unit_id: Option<Uuid>,
    pub partial: bool,
}

#[derive(Debug, Clone)]
pub enum ImportState {
    New,
    Unchanged,
    Changed(ExistingUnit),
    Deleted(ExistingUnit),
}

#[derive(Debug, Clone, Serialize)]
pub struct ExistingUnit {
    #[serde(flatten)]
    pub unit: orbit_unit::Model,
    pub grouping_of_forces_ids: BTreeSet<Uuid>,
}

impl Deref for ExistingUnit {
    type Target = orbit_unit::Model;

    fn deref(&self) -> &Self::Target {
        &self.unit
    }
}

impl DerefMut for ExistingUnit {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.unit
    }
}

impl ImportUnit {
    pub fn from_hierarchy(
        unit: HierarchyUnit,
        dictionaries: &DictionaryMaps,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            unit_id: unit.data.unit_id,
            unit_name: unit.data.unit_name,
            unit_name_original: unit.data.unit_name_original,
            unit_name_short: unit.data.unit_name_short,
            operational_unit_name_full: unit.data.operational_unit_name_full,
            generative_unit_name_full: unit.data.generative_unit_name_full,
            unit_number: unit.data.unit_number,
            unit_alternate_names: unit.data.unit_alternate_names,
            unit_alternate_numbers: unit.data.unit_alternate_numbers,
            unit_echelon_id: dictionaries.resolve(
                DictionaryKind::UnitEchelon,
                unit.data.unit_echelon.as_ref(),
            )?,
            combat_unit_type_id: dictionaries.resolve(
                DictionaryKind::CombatUnitType,
                unit.data.combat_unit_type.as_ref(),
            )?,
            grouping_of_forces_ids: dictionaries.resolve_all(
                DictionaryKind::GroupingOfForces,
                unit.data.grouping_of_forces.as_deref(),
            )?,
            generative_parent_unit_id: unit.generative_parent_unit_id,
            operational_parent_unit_id: unit.operational_parent_unit_id,
            partial: unit.partial,
        })
    }

    pub fn preserve_existing_partial_fields(
        &mut self,
        existing: Option<&ExistingUnit>,
    ) {
        if !self.partial {
            return;
        }
        let Some(existing) = existing else {
            return;
        };
        preserve_missing(&mut self.unit_name, &existing.unit_name);
        preserve_missing(
            &mut self.unit_name_original,
            &existing.unit_name_original,
        );
        preserve_missing(&mut self.unit_name_short, &existing.unit_name_short);
        preserve_missing(
            &mut self.operational_unit_name_full,
            &existing.operational_unit_name_full,
        );
        preserve_missing(
            &mut self.generative_unit_name_full,
            &existing.generative_unit_name_full,
        );
        preserve_missing(&mut self.unit_number, &existing.unit_number);
        preserve_missing(
            &mut self.unit_alternate_names,
            &existing.unit_alternate_names,
        );
        preserve_missing(
            &mut self.unit_alternate_numbers,
            &existing.unit_alternate_numbers,
        );
        preserve_missing(&mut self.unit_echelon_id, &existing.unit_echelon_id);
        preserve_missing(
            &mut self.combat_unit_type_id,
            &existing.combat_unit_type_id,
        );
        if self.grouping_of_forces_ids.is_none() {
            self.grouping_of_forces_ids =
                Some(existing.grouping_of_forces_ids.clone());
        }
        preserve_missing(
            &mut self.generative_parent_unit_id,
            &existing.generative_parent_unit_id,
        );
        preserve_missing(
            &mut self.operational_parent_unit_id,
            &existing.operational_parent_unit_id,
        );
    }
}

fn preserve_missing<T: Clone>(value: &mut Option<T>, existing: &Option<T>) {
    if value.is_none() {
        value.clone_from(existing);
    }
}

pub fn classify(
    unit: &ImportUnit,
    existing: Option<&ExistingUnit>,
) -> ImportState {
    let Some(existing) = existing else {
        return ImportState::New;
    };
    if existing.deleted {
        return ImportState::Deleted(existing.clone());
    }
    if same_data(unit, existing) {
        ImportState::Unchanged
    } else {
        ImportState::Changed(existing.clone())
    }
}

pub async fn load_existing(
    db: &DatabaseConnection,
) -> Result<HashMap<Uuid, ExistingUnit>, AppError> {
    Ok(
        attach_groupings(db, orbit_unit::Entity::find().all(db).await.c(h!())?)
            .await?
            .into_iter()
            .map(|unit| (unit.unit_id, unit))
            .collect(),
    )
}

pub async fn load_latest_sync(
    db: &DatabaseConnection,
) -> Result<Option<orbit_sync::Model>, AppError> {
    Ok(orbit_sync::Entity::find()
        .order_by_desc(orbit_sync::Column::SyncedAt)
        .order_by_desc(orbit_sync::Column::Id)
        .one(db)
        .await
        .c(h!())?)
}

pub async fn record_sync(
    db: &DatabaseConnection,
    archive_md5: &str,
    synced_at: NaiveDateTime,
) -> Result<orbit_sync::Model, AppError> {
    Ok(orbit_sync::ActiveModel {
        synced_at: Set(synced_at),
        archive_md5: Set(archive_md5.to_string()),
        ..Default::default()
    }
    .insert(db)
    .await
    .c(h!())?)
}

pub async fn load_latest_synced_source_units(
    db: &DatabaseConnection,
) -> anyhow::Result<Vec<SourceUnit>> {
    let sync = load_latest_sync(db).await.c(h!())?.ok_or_else(|| {
        anyhow::anyhow!("ORBIT data has not been synchronized")
    })?;
    let units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::UpdatedAt.eq(sync.synced_at))
        .all(db)
        .await
        .c(h!())?;
    let dictionaries = DictionaryMaps::load(db).await.c(h!())?;
    source_units_from_models(units, &dictionaries)
}

fn source_units_from_models(
    units: Vec<orbit_unit::Model>,
    dictionaries: &DictionaryMaps,
) -> anyhow::Result<Vec<SourceUnit>> {
    let units = units
        .into_iter()
        .map(|unit| (unit.unit_id, unit))
        .collect::<HashMap<_, _>>();
    let mut roots = units
        .values()
        .filter(|unit| unit.is_snapshot_root)
        .collect::<Vec<_>>();
    roots.sort_by_key(|unit| unit.unit_id);
    roots
        .into_iter()
        .map(|unit| source_unit_from_model(unit, &units, dictionaries))
        .collect()
}

fn source_unit_from_model(
    unit: &orbit_unit::Model,
    units: &HashMap<Uuid, orbit_unit::Model>,
    dictionaries: &DictionaryMaps,
) -> anyhow::Result<SourceUnit> {
    let mut source = source_descriptor(unit, None, dictionaries);
    source.generative_parent_units =
        parent_chain(unit, ParentKind::Generative, units, dictionaries)?;
    source.operational_parent_units =
        parent_chain(unit, ParentKind::Operational, units, dictionaries)?;
    Ok(source)
}

#[derive(Clone, Copy)]
enum ParentKind {
    Generative,
    Operational,
}

impl ParentKind {
    fn parent_id(self, unit: &orbit_unit::Model) -> Option<Uuid> {
        match self {
            Self::Generative => unit.generative_parent_unit_id,
            Self::Operational => unit.operational_parent_unit_id,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Generative => "generative",
            Self::Operational => "operational",
        }
    }
}

fn parent_chain(
    root: &orbit_unit::Model,
    kind: ParentKind,
    units: &HashMap<Uuid, orbit_unit::Model>,
    dictionaries: &DictionaryMaps,
) -> anyhow::Result<Vec<SourceUnit>> {
    let mut parents = Vec::new();
    let mut seen = HashSet::from([root.unit_id]);
    let mut parent_id = kind.parent_id(root);
    while let Some(id) = parent_id {
        anyhow::ensure!(
            seen.insert(id),
            "ORBIT {} parent cycle includes unit {id}",
            kind.label()
        );
        let parent = units.get(&id).ok_or_else(|| {
            anyhow::anyhow!(
                "ORBIT unit {} references {} parent {id} outside the latest sync",
                root.unit_id,
                kind.label()
            )
        })?;
        parent_id = kind.parent_id(parent);
        parents.push(parent);
    }
    let count = parents.len();
    Ok(parents
        .into_iter()
        .enumerate()
        .map(|(index, parent)| {
            source_descriptor(
                parent,
                Some((count - index - 1) as i32),
                dictionaries,
            )
        })
        .collect())
}

fn source_descriptor(
    unit: &orbit_unit::Model,
    path_level: Option<i32>,
    dictionaries: &DictionaryMaps,
) -> SourceUnit {
    SourceUnit {
        unit_id: unit.unit_id,
        unit_name: unit.unit_name.clone(),
        unit_name_original: unit.unit_name_original.clone(),
        unit_name_short: unit.unit_name_short.clone(),
        operational_unit_name_full: unit.operational_unit_name_full.clone(),
        generative_unit_name_full: unit.generative_unit_name_full.clone(),
        unit_number: unit.unit_number.clone(),
        unit_alternate_names: unit.unit_alternate_names.clone(),
        unit_alternate_numbers: unit.unit_alternate_numbers.clone(),
        unit_echelon: dictionaries.unit_echelon_value(unit.unit_echelon_id),
        combat_unit_type: None,
        grouping_of_forces: None,
        operational_parent_units: Vec::new(),
        generative_parent_units: Vec::new(),
        path_level,
    }
}

async fn attach_groupings<C>(
    db: &C,
    units: Vec<orbit_unit::Model>,
) -> Result<Vec<ExistingUnit>, AppError>
where
    C: ConnectionTrait,
{
    let unit_ids = units.iter().map(|unit| unit.unit_id).collect::<Vec<_>>();
    let links = if unit_ids.is_empty() {
        Vec::new()
    } else {
        orbit_unit_grouping_of_forces::Entity::find()
            .filter(
                orbit_unit_grouping_of_forces::Column::UnitId.is_in(unit_ids),
            )
            .all(db)
            .await
            .c(h!())?
    };
    let mut grouping_ids_by_unit = HashMap::<Uuid, BTreeSet<Uuid>>::new();
    for link in links {
        grouping_ids_by_unit
            .entry(link.unit_id)
            .or_default()
            .insert(link.grouping_of_forces_id);
    }
    Ok(units
        .into_iter()
        .map(|unit| ExistingUnit {
            grouping_of_forces_ids: grouping_ids_by_unit
                .remove(&unit.unit_id)
                .unwrap_or_default(),
            unit,
        })
        .collect())
}

pub async fn insert_unit(
    db: &DatabaseConnection,
    unit: &ImportUnit,
    started_at: NaiveDateTime,
) -> Result<ExistingUnit, AppError> {
    let transaction = db.begin().await.c(h!())?;
    let inserted = orbit_unit::ActiveModel {
        unit_id: Set(unit.unit_id),
        unit_name: Set(unit.unit_name.clone()),
        unit_name_original: Set(unit.unit_name_original.clone()),
        unit_name_short: Set(unit.unit_name_short.clone()),
        operational_unit_name_full: Set(unit
            .operational_unit_name_full
            .clone()),
        generative_unit_name_full: Set(unit.generative_unit_name_full.clone()),
        unit_number: Set(unit.unit_number.clone()),
        unit_alternate_names: Set(unit.unit_alternate_names.clone()),
        unit_alternate_numbers: Set(unit.unit_alternate_numbers.clone()),
        unit_echelon_id: Set(unit.unit_echelon_id),
        combat_unit_type_id: Set(unit.combat_unit_type_id),
        generative_parent_unit_id: Set(unit.generative_parent_unit_id),
        operational_parent_unit_id: Set(unit.operational_parent_unit_id),
        is_snapshot_root: Set(!unit.partial),
        deleted: Set(false),
        created_at: Set(started_at),
        updated_at: Set(started_at),
    }
    .insert(&transaction)
    .await
    .c(h!())?;
    let grouping_of_forces_ids =
        unit.grouping_of_forces_ids.clone().unwrap_or_default();
    replace_groupings(&transaction, unit.unit_id, &grouping_of_forces_ids)
        .await?;
    transaction.commit().await.c(h!())?;
    Ok(ExistingUnit {
        unit: inserted,
        grouping_of_forces_ids,
    })
}

pub async fn update_unit(
    db: &DatabaseConnection,
    existing: ExistingUnit,
    unit: &ImportUnit,
    started_at: NaiveDateTime,
) -> Result<ExistingUnit, AppError> {
    let transaction = db.begin().await.c(h!())?;
    let mut existing = existing.unit.into_active_model();
    existing.unit_name = Set(unit.unit_name.clone());
    existing.unit_name_original = Set(unit.unit_name_original.clone());
    existing.unit_name_short = Set(unit.unit_name_short.clone());
    existing.operational_unit_name_full =
        Set(unit.operational_unit_name_full.clone());
    existing.generative_unit_name_full =
        Set(unit.generative_unit_name_full.clone());
    existing.unit_number = Set(unit.unit_number.clone());
    existing.unit_alternate_names = Set(unit.unit_alternate_names.clone());
    existing.unit_alternate_numbers = Set(unit.unit_alternate_numbers.clone());
    existing.unit_echelon_id = Set(unit.unit_echelon_id);
    existing.combat_unit_type_id = Set(unit.combat_unit_type_id);
    existing.generative_parent_unit_id = Set(unit.generative_parent_unit_id);
    existing.operational_parent_unit_id = Set(unit.operational_parent_unit_id);
    existing.is_snapshot_root = Set(!unit.partial);
    existing.deleted = Set(false);
    existing.updated_at = Set(started_at);
    let updated = existing.update(&transaction).await.c(h!())?;
    let grouping_of_forces_ids =
        unit.grouping_of_forces_ids.clone().unwrap_or_default();
    replace_groupings(&transaction, unit.unit_id, &grouping_of_forces_ids)
        .await?;
    transaction.commit().await.c(h!())?;
    Ok(ExistingUnit {
        unit: updated,
        grouping_of_forces_ids,
    })
}

async fn replace_groupings<C>(
    db: &C,
    unit_id: Uuid,
    grouping_of_forces_ids: &BTreeSet<Uuid>,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    orbit_unit_grouping_of_forces::Entity::delete_many()
        .filter(orbit_unit_grouping_of_forces::Column::UnitId.eq(unit_id))
        .exec(db)
        .await
        .c(h!())?;
    if grouping_of_forces_ids.is_empty() {
        return Ok(());
    }
    orbit_unit_grouping_of_forces::Entity::insert_many(
        grouping_of_forces_ids.iter().map(|grouping_of_forces_id| {
            orbit_unit_grouping_of_forces::ActiveModel {
                unit_id: Set(unit_id),
                grouping_of_forces_id: Set(*grouping_of_forces_id),
            }
        }),
    )
    .exec(db)
    .await
    .c(h!())?;
    Ok(())
}

pub async fn touch_unit(
    db: &DatabaseConnection,
    unit_id: Uuid,
    started_at: NaiveDateTime,
) -> Result<(), AppError> {
    orbit_unit::Entity::update_many()
        .col_expr(
            orbit_unit::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(started_at),
        )
        .filter(orbit_unit::Column::UnitId.eq(unit_id))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn load_stale(
    db: &DatabaseConnection,
    started_at: NaiveDateTime,
    snapshot_unit_ids: &HashSet<Uuid>,
) -> Result<Vec<ExistingUnit>, AppError> {
    let stale_before =
        started_at - Duration::seconds(ORBIT_STALE_GRACE_SECONDS);
    let units = orbit_unit::Entity::find()
        .filter(orbit_unit::Column::Deleted.eq(false))
        .filter(orbit_unit::Column::UpdatedAt.lt(stale_before))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .filter(|unit| !snapshot_unit_ids.contains(&unit.unit_id))
        .collect();
    attach_groupings(db, units).await
}

pub async fn soft_delete(
    db: &DatabaseConnection,
    unit: ExistingUnit,
    started_at: NaiveDateTime,
) -> Result<(), AppError> {
    let mut unit = unit.unit.into_active_model();
    unit.deleted = Set(true);
    unit.updated_at = Set(started_at);
    unit.update(db).await.c(h!())?;
    Ok(())
}

pub async fn replace_sigint_unit_links(
    db: &DatabaseConnection,
    sigint_unit_ids_by_orbit_unit: &HashMap<Uuid, BTreeSet<i64>>,
) -> Result<(), AppError> {
    let transaction = db.begin().await.c(h!())?;
    let manually_linked_sigint_unit_ids =
        active_manually_linked_sigint_unit_ids(&transaction).await?;
    let suppressed_links = suppressed_sigint_unit_links(&transaction).await?;
    orbit_unit_sigint_unit::Entity::delete_many()
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(false))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .exec(&transaction)
        .await
        .c(h!())?;

    let orbit_unit_ids = sigint_unit_ids_by_orbit_unit
        .keys()
        .copied()
        .collect::<Vec<_>>();
    let active_orbit_unit_ids =
        active_orbit_unit_ids(&transaction, &orbit_unit_ids).await?;
    let links = automatic_sigint_unit_links(
        sigint_unit_ids_by_orbit_unit,
        &active_orbit_unit_ids,
        &manually_linked_sigint_unit_ids,
        &suppressed_links,
    );
    if !links.is_empty() {
        orbit_unit_sigint_unit::Entity::insert_many(links)
            .exec(&transaction)
            .await
            .c(h!())?;
    }
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction).await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub async fn replace_automatic_sigint_unit_links(
    db: &DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_ids: &BTreeSet<Uuid>,
) -> Result<(), AppError> {
    let transaction = db.begin().await.c(h!())?;
    let manually_linked_sigint_unit_ids =
        active_manually_linked_sigint_unit_ids(&transaction).await?;
    let mut active_orbit_unit_ids = active_orbit_unit_ids(
        &transaction,
        &orbit_unit_ids.iter().copied().collect::<Vec<_>>(),
    )
    .await?;
    let suppressed_links = suppressed_sigint_unit_links(&transaction).await?;
    active_orbit_unit_ids.retain(|orbit_unit_id| {
        !suppressed_links.contains(&(*orbit_unit_id, sigint_unit_id))
    });
    let can_link_automatically =
        !manually_linked_sigint_unit_ids.contains(&sigint_unit_id);
    let mut links_to_delete = Condition::any()
        .add(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id));
    if can_link_automatically && !active_orbit_unit_ids.is_empty() {
        links_to_delete = links_to_delete.add(
            orbit_unit_sigint_unit::Column::OrbitUnitId
                .is_in(active_orbit_unit_ids.iter().copied()),
        );
    }
    orbit_unit_sigint_unit::Entity::delete_many()
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(false))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(links_to_delete)
        .exec(&transaction)
        .await
        .c(h!())?;
    if can_link_automatically && !active_orbit_unit_ids.is_empty() {
        orbit_unit_sigint_unit::Entity::insert_many(
            active_orbit_unit_ids.into_iter().map(|orbit_unit_id| {
                orbit_unit_sigint_unit::ActiveModel {
                    orbit_unit_id: Set(orbit_unit_id),
                    sigint_unit_id: Set(sigint_unit_id),
                    is_manual: Set(false),
                    is_suppressed: Set(false),
                }
            }),
        )
        .exec(&transaction)
        .await
        .c(h!())?;
    }
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction).await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

async fn active_manually_linked_sigint_unit_ids<C>(
    db: &C,
) -> Result<BTreeSet<i64>, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            orbit_unit_sigint_unit::Relation::OrbitUnit.def(),
        )
        .filter(orbit_unit_sigint_unit::Column::IsManual.eq(true))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| link.sigint_unit_id)
        .collect())
}

async fn suppressed_sigint_unit_links<C>(
    db: &C,
) -> Result<BTreeSet<(Uuid, i64)>, AppError>
where
    C: ConnectionTrait,
{
    Ok(orbit_unit_sigint_unit::Entity::find()
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(true))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| (link.orbit_unit_id, link.sigint_unit_id))
        .collect())
}

async fn active_orbit_unit_ids<C>(
    db: &C,
    orbit_unit_ids: &[Uuid],
) -> Result<BTreeSet<Uuid>, AppError>
where
    C: ConnectionTrait,
{
    if orbit_unit_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    Ok(orbit_unit::Entity::find()
        .filter(orbit_unit::Column::UnitId.is_in(orbit_unit_ids.to_vec()))
        .filter(orbit_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|unit| unit.unit_id)
        .collect())
}

fn automatic_sigint_unit_links(
    sigint_unit_ids_by_orbit_unit: &HashMap<Uuid, BTreeSet<i64>>,
    active_orbit_unit_ids: &BTreeSet<Uuid>,
    manually_linked_sigint_unit_ids: &BTreeSet<i64>,
    suppressed_links: &BTreeSet<(Uuid, i64)>,
) -> Vec<orbit_unit_sigint_unit::ActiveModel> {
    sigint_unit_ids_by_orbit_unit
        .iter()
        .filter(|(orbit_unit_id, _)| {
            active_orbit_unit_ids.contains(orbit_unit_id)
        })
        .flat_map(|(orbit_unit_id, sigint_unit_ids)| {
            sigint_unit_ids
                .iter()
                .filter(|sigint_unit_id| {
                    !manually_linked_sigint_unit_ids.contains(sigint_unit_id)
                        && !suppressed_links
                            .contains(&(*orbit_unit_id, **sigint_unit_id))
                })
                .map(|sigint_unit_id| orbit_unit_sigint_unit::ActiveModel {
                    orbit_unit_id: Set(*orbit_unit_id),
                    sigint_unit_id: Set(*sigint_unit_id),
                    is_manual: Set(false),
                    is_suppressed: Set(false),
                })
        })
        .collect()
}

pub async fn replace_sigint_unit_link(
    db: &DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<(), AppError> {
    let transaction = db.begin().await.c(h!())?;
    orbit_unit_sigint_unit::Entity::delete_many()
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(
            Condition::any()
                .add(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
                .add(
                    orbit_unit_sigint_unit::Column::OrbitUnitId
                        .eq(orbit_unit_id),
                ),
        )
        .exec(&transaction)
        .await
        .c(h!())?;
    orbit_unit_sigint_unit::Entity::insert(
        orbit_unit_sigint_unit::ActiveModel {
            orbit_unit_id: Set(orbit_unit_id),
            sigint_unit_id: Set(sigint_unit_id),
            is_manual: Set(true),
            is_suppressed: Set(false),
        },
    )
    .exec(&transaction)
    .await
    .c(h!())?;
    super::reconcile_sigint_unit_deduplicate_candidates(&transaction).await?;
    transaction.commit().await.c(h!())?;
    Ok(())
}

pub async fn delete_sigint_unit_link(
    db: &DatabaseConnection,
    sigint_unit_id: i64,
    orbit_unit_id: Uuid,
) -> Result<bool, AppError> {
    let transaction = db.begin().await.c(h!())?;
    let rows_affected = orbit_unit_sigint_unit::Entity::update_many()
        .col_expr(orbit_unit_sigint_unit::Column::IsManual, Expr::value(false))
        .col_expr(
            orbit_unit_sigint_unit::Column::IsSuppressed,
            Expr::value(true),
        )
        .filter(orbit_unit_sigint_unit::Column::SigintUnitId.eq(sigint_unit_id))
        .filter(orbit_unit_sigint_unit::Column::OrbitUnitId.eq(orbit_unit_id))
        .filter(orbit_unit_sigint_unit::Column::IsSuppressed.eq(false))
        .exec(&transaction)
        .await
        .c(h!())?
        .rows_affected;
    if rows_affected > 0 {
        super::reconcile_sigint_unit_deduplicate_candidates(&transaction)
            .await?;
    }
    transaction.commit().await.c(h!())?;
    Ok(rows_affected > 0)
}

fn same_data(unit: &ImportUnit, existing: &ExistingUnit) -> bool {
    unit.unit_name == existing.unit_name
        && unit.unit_name_original == existing.unit_name_original
        && unit.unit_name_short == existing.unit_name_short
        && unit.operational_unit_name_full
            == existing.operational_unit_name_full
        && unit.generative_unit_name_full == existing.generative_unit_name_full
        && unit.unit_number == existing.unit_number
        && unit.unit_alternate_names == existing.unit_alternate_names
        && unit.unit_alternate_numbers == existing.unit_alternate_numbers
        && unit.unit_echelon_id == existing.unit_echelon_id
        && unit.combat_unit_type_id == existing.combat_unit_type_id
        && unit.grouping_of_forces_ids.clone().unwrap_or_default()
            == existing.grouping_of_forces_ids
        && unit.generative_parent_unit_id == existing.generative_parent_unit_id
        && unit.operational_parent_unit_id
            == existing.operational_parent_unit_id
        && !unit.partial == existing.is_snapshot_root
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{orbit_grouping_of_forces, sigint_unit};
    use crate::orbit::types::DictionaryValue;
    use crate::types::Mode;
    use chrono::{Timelike, Utc};
    use serde_json::json;
    use serial_test::serial;

    #[test]
    fn classifies_equal_changed_and_deleted_rows() {
        let import = import_unit();
        let existing = model(&import, false);
        assert!(matches!(
            classify(&import, Some(&existing)),
            ImportState::Unchanged
        ));
        let mut changed = import.clone();
        changed.unit_name = Some("changed".to_string());
        assert!(matches!(
            classify(&changed, Some(&existing)),
            ImportState::Changed(_)
        ));
        assert!(matches!(
            classify(&import, Some(&model(&import, true))),
            ImportState::Deleted(_)
        ));
        assert!(matches!(classify(&import, None), ImportState::New));
    }

    #[test]
    fn partial_units_preserve_omitted_existing_fields() {
        let complete = import_unit();
        let existing = model(&complete, false);
        let mut partial = ImportUnit {
            unit_id: complete.unit_id,
            unit_name: None,
            unit_name_original: None,
            unit_name_short: Some("updated".to_string()),
            operational_unit_name_full: None,
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon_id: None,
            combat_unit_type_id: None,
            grouping_of_forces_ids: None,
            generative_parent_unit_id: None,
            operational_parent_unit_id: None,
            partial: true,
        };

        partial.preserve_existing_partial_fields(Some(&existing));

        assert_eq!(partial.unit_name, complete.unit_name);
        assert_eq!(partial.unit_name_short.as_deref(), Some("updated"));
        assert_eq!(
            partial.operational_unit_name_full,
            complete.operational_unit_name_full
        );
    }

    #[test]
    fn stale_cutoff_is_five_seconds_before_start() {
        let started_at = Utc::now().naive_utc();
        let started_at = started_at
            .with_nanosecond(started_at.nanosecond() / 1_000 * 1_000)
            .unwrap();
        let cutoff = started_at - Duration::seconds(ORBIT_STALE_GRACE_SECONDS);
        assert_eq!(
            started_at.signed_duration_since(cutoff),
            Duration::seconds(5)
        );
        assert!(cutoff - Duration::milliseconds(1) < cutoff);
    }

    #[tokio::test]
    #[serial]
    async fn persists_hierarchy_touches_reactivation_and_soft_delete() {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let dictionaries = DictionaryMaps::load(&db).await.unwrap();
        let echelon_id = dictionaries
            .resolve(
                DictionaryKind::UnitEchelon,
                Some(&DictionaryValue {
                    key: json!("battalion"),
                    name: json!("Батальйон / дивізіон"),
                }),
            )
            .unwrap()
            .unwrap();
        let grouping_of_forces_ids = orbit_grouping_of_forces::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .into_iter()
            .take(2)
            .map(|grouping| grouping.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(grouping_of_forces_ids.len(), 2);

        let started_at = Utc::now().naive_utc();
        let started_at = started_at
            .with_nanosecond(started_at.nanosecond() / 1_000 * 1_000)
            .unwrap();
        let parent = import_unit();
        let mut child = import_unit();
        child.generative_parent_unit_id = Some(parent.unit_id);
        child.unit_echelon_id = Some(echelon_id);
        child.grouping_of_forces_ids = Some(grouping_of_forces_ids.clone());
        insert_unit(&db, &parent, started_at).await.unwrap();
        let child_row = insert_unit(&db, &child, started_at).await.unwrap();
        assert_eq!(child_row.created_at, started_at);
        assert_eq!(child_row.updated_at, started_at);
        assert!(matches!(
            classify(&child, Some(&child_row)),
            ImportState::Unchanged
        ));
        let persisted_grouping_ids =
            orbit_unit_grouping_of_forces::Entity::find()
                .filter(
                    orbit_unit_grouping_of_forces::Column::UnitId
                        .eq(child.unit_id),
                )
                .all(&db)
                .await
                .unwrap()
                .into_iter()
                .map(|link| link.grouping_of_forces_id)
                .collect::<BTreeSet<_>>();
        assert_eq!(persisted_grouping_ids, grouping_of_forces_ids);
        let retained_grouping_id =
            *grouping_of_forces_ids.iter().next().unwrap();
        child.grouping_of_forces_ids =
            Some(BTreeSet::from([retained_grouping_id]));
        let child_row = update_unit(&db, child_row, &child, started_at)
            .await
            .unwrap();
        assert_eq!(
            child_row.grouping_of_forces_ids,
            BTreeSet::from([retained_grouping_id])
        );

        let touched_at = started_at + Duration::seconds(1);
        touch_unit(&db, child.unit_id, touched_at).await.unwrap();
        let child_row = orbit_unit::Entity::find_by_id(child.unit_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(child_row.updated_at, touched_at);
        let stale =
            load_stale(&db, touched_at + Duration::seconds(5), &HashSet::new())
                .await
                .unwrap();
        assert_eq!(
            stale
                .into_iter()
                .map(|unit| unit.unit_id)
                .collect::<Vec<_>>(),
            vec![parent.unit_id]
        );
        let stale = load_stale(
            &db,
            touched_at + Duration::seconds(5),
            &HashSet::from([parent.unit_id]),
        )
        .await
        .unwrap();
        assert!(stale.is_empty());

        let child_row = load_existing(&db)
            .await
            .unwrap()
            .remove(&child.unit_id)
            .unwrap();
        soft_delete(&db, child_row, touched_at).await.unwrap();
        let child_row = orbit_unit::Entity::find_by_id(child.unit_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(child_row.deleted);
        let child_row = load_existing(&db)
            .await
            .unwrap()
            .remove(&child.unit_id)
            .unwrap();
        let child_row = update_unit(&db, child_row, &child, touched_at)
            .await
            .unwrap();
        assert!(!child_row.deleted);
        assert_eq!(child_row.created_at, started_at);

        soft_delete(&db, child_row, touched_at + Duration::seconds(1))
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(child.unit_id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(parent.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn latest_sync_loads_snapshot_roots_with_database_parent_chains() {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let synced_at = Utc::now().naive_utc();
        let synced_at = synced_at
            .with_nanosecond(synced_at.nanosecond() / 1_000 * 1_000)
            .unwrap();
        let mut parent = import_unit();
        parent.partial = true;
        let mut root = import_unit();
        root.generative_parent_unit_id = Some(parent.unit_id);
        insert_unit(&db, &parent, synced_at).await.unwrap();
        insert_unit(&db, &root, synced_at).await.unwrap();
        let sync =
            record_sync(&db, "0123456789abcdef0123456789abcdef", synced_at)
                .await
                .unwrap();

        let units = load_latest_synced_source_units(&db).await.unwrap();

        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit_id, root.unit_id);
        assert_eq!(units[0].generative_parent_units.len(), 1);
        assert_eq!(units[0].generative_parent_units[0].unit_id, parent.unit_id);
        assert_eq!(units[0].generative_parent_units[0].path_level, Some(0));

        orbit_sync::Entity::delete_by_id(sync.id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(root.unit_id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(parent.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn manual_sigint_links_survive_automatic_rebuild() {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let first_orbit_unit = import_unit();
        let second_orbit_unit = import_unit();
        let inserted_at = Utc::now().naive_utc();
        insert_unit(&db, &first_orbit_unit, inserted_at)
            .await
            .unwrap();
        insert_unit(&db, &second_orbit_unit, inserted_at)
            .await
            .unwrap();
        let login_id = crate::users::login_id_by_name(
            &db,
            crate::config::SYSTEM_LOGIN_NAME,
        )
        .await
        .unwrap();
        let first_sigint_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_sigint_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        replace_sigint_unit_link(
            &db,
            first_sigint_unit.id,
            first_orbit_unit.unit_id,
        )
        .await
        .unwrap();
        replace_sigint_unit_link(
            &db,
            second_sigint_unit.id,
            second_orbit_unit.unit_id,
        )
        .await
        .unwrap();
        replace_sigint_unit_link(
            &db,
            second_sigint_unit.id,
            first_orbit_unit.unit_id,
        )
        .await
        .unwrap();

        replace_sigint_unit_links(
            &db,
            &HashMap::from([(
                second_orbit_unit.unit_id,
                BTreeSet::from([first_sigint_unit.id, second_sigint_unit.id]),
            )]),
        )
        .await
        .unwrap();

        let links = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(first_orbit_unit.unit_id),
            )
            .all(&db)
            .await
            .unwrap();
        let linked_sigint_unit_ids = links
            .iter()
            .map(|link| link.sigint_unit_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            linked_sigint_unit_ids,
            BTreeSet::from([first_sigint_unit.id, second_sigint_unit.id])
        );
        assert!(links.iter().all(|link| link.is_manual));
        assert!(crate::sigint::unit::orbit::unit_has_orbit(
            &db,
            first_sigint_unit.id,
        )
        .await
        .unwrap());
        assert!(orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(second_orbit_unit.unit_id),
            )
            .one(&db)
            .await
            .unwrap()
            .is_none());

        sigint_unit::Entity::delete_by_id(first_sigint_unit.id)
            .exec(&db)
            .await
            .unwrap();
        sigint_unit::Entity::delete_by_id(second_sigint_unit.id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(first_orbit_unit.unit_id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(second_orbit_unit.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn deleted_automatic_link_stays_suppressed_after_rebuild() {
        crate::tests::test::init().await;
        let db = crate::new_pg_pool_from_mode(Mode::Test).await.unwrap();
        let orbit_unit = import_unit();
        insert_unit(&db, &orbit_unit, Utc::now().naive_utc())
            .await
            .unwrap();
        let login_id = crate::users::login_id_by_name(
            &db,
            crate::config::SYSTEM_LOGIN_NAME,
        )
        .await
        .unwrap();
        let first_sigint_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let second_sigint_unit = crate::functest::tests::mk_sigint_unit(
            &db,
            sigint_unit::ActiveModel {
                created_by_login_id: Set(login_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        orbit_unit_sigint_unit::Entity::insert(
            orbit_unit_sigint_unit::ActiveModel {
                orbit_unit_id: Set(orbit_unit.unit_id),
                sigint_unit_id: Set(first_sigint_unit.id),
                is_manual: Set(false),
                is_suppressed: Set(false),
            },
        )
        .exec(&db)
        .await
        .unwrap();

        replace_automatic_sigint_unit_links(
            &db,
            second_sigint_unit.id,
            &BTreeSet::from([orbit_unit.unit_id]),
        )
        .await
        .unwrap();

        let link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(orbit_unit.unit_id),
            )
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(link.sigint_unit_id, second_sigint_unit.id);
        assert!(!link.is_manual);
        assert!(delete_sigint_unit_link(
            &db,
            second_sigint_unit.id,
            orbit_unit.unit_id,
        )
        .await
        .unwrap());
        assert!(!delete_sigint_unit_link(
            &db,
            second_sigint_unit.id,
            orbit_unit.unit_id,
        )
        .await
        .unwrap());
        replace_sigint_unit_links(
            &db,
            &HashMap::from([(
                orbit_unit.unit_id,
                BTreeSet::from([second_sigint_unit.id]),
            )]),
        )
        .await
        .unwrap();

        let suppressed_link = orbit_unit_sigint_unit::Entity::find()
            .filter(
                orbit_unit_sigint_unit::Column::OrbitUnitId
                    .eq(orbit_unit.unit_id),
            )
            .filter(
                orbit_unit_sigint_unit::Column::SigintUnitId
                    .eq(second_sigint_unit.id),
            )
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(suppressed_link.is_suppressed);
        assert!(!crate::sigint::unit::orbit::unit_has_orbit(
            &db,
            second_sigint_unit.id,
        )
        .await
        .unwrap());

        sigint_unit::Entity::delete_by_id(first_sigint_unit.id)
            .exec(&db)
            .await
            .unwrap();
        sigint_unit::Entity::delete_by_id(second_sigint_unit.id)
            .exec(&db)
            .await
            .unwrap();
        orbit_unit::Entity::delete_by_id(orbit_unit.unit_id)
            .exec(&db)
            .await
            .unwrap();
    }

    fn import_unit() -> ImportUnit {
        ImportUnit {
            unit_id: Uuid::new_v4(),
            unit_name: Some("unit".to_string()),
            unit_name_original: None,
            unit_name_short: Some("u".to_string()),
            operational_unit_name_full: Some("u".to_string()),
            generative_unit_name_full: None,
            unit_number: None,
            unit_alternate_names: None,
            unit_alternate_numbers: None,
            unit_echelon_id: None,
            combat_unit_type_id: None,
            grouping_of_forces_ids: None,
            generative_parent_unit_id: None,
            operational_parent_unit_id: None,
            partial: false,
        }
    }

    fn model(unit: &ImportUnit, deleted: bool) -> ExistingUnit {
        ExistingUnit {
            unit: orbit_unit::Model {
                unit_id: unit.unit_id,
                unit_name: unit.unit_name.clone(),
                unit_name_original: unit.unit_name_original.clone(),
                unit_name_short: unit.unit_name_short.clone(),
                operational_unit_name_full: unit
                    .operational_unit_name_full
                    .clone(),
                generative_unit_name_full: unit
                    .generative_unit_name_full
                    .clone(),
                unit_number: unit.unit_number.clone(),
                unit_alternate_names: unit.unit_alternate_names.clone(),
                unit_alternate_numbers: unit.unit_alternate_numbers.clone(),
                unit_echelon_id: unit.unit_echelon_id,
                combat_unit_type_id: unit.combat_unit_type_id,
                generative_parent_unit_id: unit.generative_parent_unit_id,
                operational_parent_unit_id: unit.operational_parent_unit_id,
                is_snapshot_root: !unit.partial,
                deleted,
                created_at: Utc::now().naive_utc(),
                updated_at: Utc::now().naive_utc(),
            },
            grouping_of_forces_ids: unit
                .grouping_of_forces_ids
                .clone()
                .unwrap_or_default(),
        }
    }
}
