use super::{
    DeviceAorReference, DeviceArchivedScope, DeviceCurrentState,
    DeviceListSort, DeviceService, DeviceStatusCounts, DeviceUnitReference,
    DeviceUnitStat, ListDevicesCommand, ListDevicesResult,
};
use crate::config::DEVICE_SOURCE_LABEL_MAX_CHARS;
use crate::devices::custom_fields::custom_fields_from_json;
use crate::devices::main_db::MainDb;
use crate::devices::validation::normalize_device_list_pagination;
use crate::devices::visibility::{self, DeviceReadScope};
use crate::entities::{
    area_of_responsibility, device, device_aor, login, sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::types::{BTreeMap, BTreeSet, ShortContext, Uuid};
use sea_orm::sea_query::{
    extension::postgres::PgExpr, Alias, Expr, Func, LikeExpr, Order, SimpleExpr,
};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, EntityTrait,
    FromQueryResult, IntoSimpleExpr, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait, RelationTrait, Select,
};

impl DeviceService {
    pub(in crate::devices) async fn read(
        main_db: &MainDb<'_, DatabaseConnection>,
        login: &login::Model,
        device_id: Uuid,
        scope: DeviceReadScope,
    ) -> Result<DeviceCurrentState, AppError> {
        let device =
            visibility::find_visible_device(main_db, login, device_id, scope)
                .await?;
        let mut devices = hydrate_devices(main_db, vec![device]).await?;
        Ok(devices
            .pop()
            .ok_or_else(|| anyhow::anyhow!("device hydrator lost its input"))
            .c(h!())?)
    }

    pub(in crate::devices) async fn list(
        main_db: &MainDb<'_, DatabaseConnection>,
        login: &login::Model,
        command: ListDevicesCommand,
    ) -> Result<ListDevicesResult, AppError> {
        let command = normalize_list_command(command)?;
        let query = apply_list_filters(
            visibility::visible_devices_query(
                login,
                DeviceReadScope::IncludeArchived,
            )?,
            &command,
        );
        let status_counts = load_status_counts(main_db, query.clone()).await?;
        let query = apply_archived_scope(query, command.archived_scope);
        let total = query.clone().count(main_db.connection()).await.c(h!())?;
        let devices = apply_list_sort(query, &command.sort_by)
            .offset(command.offset)
            .limit(command.limit)
            .all(main_db.connection())
            .await
            .c(h!())?;
        let has_more =
            command.offset.saturating_add(devices.len() as u64) < total;
        let devices = hydrate_devices(main_db, devices).await?;

        Ok(ListDevicesResult {
            devices,
            total,
            has_more,
            status_counts,
        })
    }

    pub(in crate::devices) async fn unit_stats(
        main_db: &MainDb<'_, DatabaseConnection>,
        login: &login::Model,
    ) -> Result<Vec<DeviceUnitStat>, AppError> {
        let units = visibility::visible_devices_query(
            login,
            DeviceReadScope::ActiveOnly,
        )?
        .join(JoinType::InnerJoin, device::Relation::SigintUnit.def())
        .filter(sigint_unit::Column::Active.eq(true))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column_as(sigint_unit::Column::Id, "unit_id")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .column_as(device::Column::Id.count(), "count")
        .group_by(sigint_unit::Column::Id)
        .group_by(sigint_unit::Column::Name)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company)
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .order_by_asc(sigint_unit::Column::Id)
        .into_model::<DeviceUnitStatRow>()
        .all(main_db.connection())
        .await
        .c(h!())?
        .into_iter()
        .map(|row| DeviceUnitStat {
            unit: DeviceUnitReference {
                id: row.unit_id,
                name: row.unit_name,
            },
            count: row.count,
        })
        .collect();
        Ok(units)
    }
}

pub(super) async fn hydrate_devices<C>(
    main_db: &MainDb<'_, C>,
    devices: Vec<device::Model>,
) -> Result<Vec<DeviceCurrentState>, AppError>
where
    C: ConnectionTrait,
{
    if devices.is_empty() {
        return Ok(Vec::new());
    }

    let device_ids = devices.iter().map(|device| device.id).collect();
    let unit_ids = devices.iter().filter_map(|device| device.unit_id).collect();
    let mut aors_by_device = load_device_aors(main_db, device_ids).await?;
    let unit_names = load_unit_names(main_db, unit_ids).await?;

    devices
        .into_iter()
        .map(|device| hydrate_device(device, &mut aors_by_device, &unit_names))
        .collect()
}

async fn load_device_aors<C>(
    main_db: &MainDb<'_, C>,
    device_ids: BTreeSet<Uuid>,
) -> Result<BTreeMap<Uuid, Vec<DeviceAorReference>>, AppError>
where
    C: ConnectionTrait,
{
    let rows = device_aor::Entity::find()
        .find_also_related(area_of_responsibility::Entity)
        .filter(device_aor::Column::DeviceId.is_in(device_ids))
        .order_by_asc(device_aor::Column::DeviceId)
        .order_by_asc(device_aor::Column::AorId)
        .all(main_db.connection())
        .await
        .c(h!())?;

    let mut aors_by_device = BTreeMap::new();
    for (device_aor, aor) in rows {
        let aor = aor
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "missing AOR reference for device {:?}, AOR {}",
                    device_aor.device_id,
                    device_aor.aor_id,
                )
            })
            .c(h!())?;
        aors_by_device
            .entry(device_aor.device_id)
            .or_insert_with(Vec::new)
            .push(DeviceAorReference {
                id: device_aor.aor_id,
                name: aor.name,
            });
    }
    for aors in aors_by_device.values_mut() {
        aors.sort_by_key(|aor| aor.id);
    }
    Ok(aors_by_device)
}

async fn load_unit_names<C>(
    main_db: &MainDb<'_, C>,
    unit_ids: BTreeSet<i64>,
) -> Result<BTreeMap<i64, String>, AppError>
where
    C: ConnectionTrait,
{
    if unit_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let units = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(unit_ids))
        .all(main_db.connection())
        .await
        .c(h!())?;
    Ok(units.into_iter().map(|unit| (unit.id, unit.name)).collect())
}

fn hydrate_device(
    device: device::Model,
    aors_by_device: &mut BTreeMap<Uuid, Vec<DeviceAorReference>>,
    unit_names: &BTreeMap<i64, String>,
) -> Result<DeviceCurrentState, AppError> {
    let device_id = device.id;
    let custom_fields = custom_fields_from_json(&device.custom_fields)?;
    let unit = match device.unit_id {
        Some(unit_id) => Some(DeviceUnitReference {
            id: unit_id,
            name: unit_names
                .get(&unit_id)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "missing unit reference for device {device_id:?}, unit {unit_id}"
                    )
                })
                .c(h!())?
                .clone(),
        }),
        None => None,
    };

    Ok(DeviceCurrentState {
        id: device_id,
        source_label: device.source_label,
        name: device.name,
        aors: aors_by_device.remove(&device_id).unwrap_or_default(),
        unit,
        external_url: device.external_url,
        custom_fields,
        created_by: device.created_by,
        archived: device.archived,
        archived_at: device.archived_at,
        created_at: device.created_at,
        updated_at: device.updated_at,
    })
}

struct NormalizedListDevicesCommand {
    filter_text: Option<String>,
    archived_scope: DeviceArchivedScope,
    needs_analytical_name: Option<bool>,
    aor_ids: Vec<i64>,
    unit_ids: Vec<i64>,
    limit: u64,
    offset: u64,
    sort_by: Vec<DeviceListSort>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum DeviceSortField {
    DisplayTitle,
    CreatedAt,
    UpdatedAt,
}

#[derive(FromQueryResult)]
struct DeviceStatusCountsRow {
    active: i64,
    archived: i64,
}

#[derive(FromQueryResult)]
struct DeviceUnitStatRow {
    unit_id: i64,
    unit_name: String,
    count: i64,
}

fn normalize_list_command(
    command: ListDevicesCommand,
) -> Result<NormalizedListDevicesCommand, AppError> {
    let pagination =
        normalize_device_list_pagination(command.limit, command.offset)?;
    let filter_text = command
        .filter_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if filter_text.as_ref().is_some_and(|value| {
        value.chars().count() > DEVICE_SOURCE_LABEL_MAX_CHARS
    }) {
        return Err(form_error("filter_text", "Значення пошуку задовге"));
    }

    Ok(NormalizedListDevicesCommand {
        filter_text,
        archived_scope: command.archived_scope,
        needs_analytical_name: command.needs_analytical_name,
        aor_ids: command
            .aor_ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        unit_ids: command
            .unit_ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        limit: pagination.limit,
        offset: pagination.offset,
        sort_by: normalize_list_sort(command.sort_by)?,
    })
}

fn normalize_list_sort(
    sort_by: Vec<DeviceListSort>,
) -> Result<Vec<DeviceListSort>, AppError> {
    let sort_by = if sort_by.is_empty() {
        vec![DeviceListSort::UpdatedAtDesc]
    } else {
        sort_by
    };
    let mut directions = BTreeMap::new();
    let mut normalized = Vec::with_capacity(sort_by.len());
    for sort in sort_by {
        let (field, descending) = match sort {
            DeviceListSort::DisplayTitleAsc => {
                (DeviceSortField::DisplayTitle, false)
            }
            DeviceListSort::DisplayTitleDesc => {
                (DeviceSortField::DisplayTitle, true)
            }
            DeviceListSort::CreatedAtAsc => (DeviceSortField::CreatedAt, false),
            DeviceListSort::CreatedAtDesc => (DeviceSortField::CreatedAt, true),
            DeviceListSort::UpdatedAtAsc => (DeviceSortField::UpdatedAt, false),
            DeviceListSort::UpdatedAtDesc => (DeviceSortField::UpdatedAt, true),
        };
        match directions.get(&field) {
            Some(previous) if *previous != descending => {
                return Err(form_error(
                    "sort_by",
                    "Один критерій сортування не може мати різні напрямки",
                ));
            }
            Some(_) => continue,
            None => {
                directions.insert(field, descending);
                normalized.push(sort);
            }
        }
    }
    Ok(normalized)
}

fn apply_list_filters(
    mut query: Select<device::Entity>,
    command: &NormalizedListDevicesCommand,
) -> Select<device::Entity> {
    if let Some(needs_analytical_name) = command.needs_analytical_name {
        query = if needs_analytical_name {
            query.filter(device::Column::Name.is_null())
        } else {
            query.filter(device::Column::Name.is_not_null())
        };
    }
    if !command.aor_ids.is_empty() {
        let matching_aor = device_aor::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .filter(
                device_aor::Column::DeviceId
                    .into_simple_expr()
                    .eq(device::Column::Id.into_simple_expr()),
            )
            .filter(device_aor::Column::AorId.is_in(command.aor_ids.clone()))
            .into_query();
        query = query.filter(Expr::exists(matching_aor));
    }
    if !command.unit_ids.is_empty() {
        query = query
            .filter(device::Column::UnitId.is_in(command.unit_ids.clone()));
    }
    if let Some(filter_text) = &command.filter_text {
        let pattern = literal_substring_pattern(filter_text);
        query = query.filter(
            Condition::any()
                .add(
                    Expr::col((device::Entity, device::Column::SourceLabel))
                        .ilike(LikeExpr::new(pattern.clone())),
                )
                .add(
                    Expr::col((device::Entity, device::Column::Name))
                        .ilike(LikeExpr::new(pattern.clone())),
                )
                .add(
                    Expr::col((device::Entity, device::Column::Id))
                        .cast_as(Alias::new("text"))
                        .like(LikeExpr::new(pattern).escape('\\')),
                ),
        );
    }
    query
}

fn apply_archived_scope(
    query: Select<device::Entity>,
    archived_scope: DeviceArchivedScope,
) -> Select<device::Entity> {
    match archived_scope {
        DeviceArchivedScope::ActiveOnly => {
            query.filter(device::Column::Archived.eq(false))
        }
        DeviceArchivedScope::ArchivedOnly => {
            query.filter(device::Column::Archived.eq(true))
        }
        DeviceArchivedScope::All => query,
    }
}

fn apply_list_sort(
    mut query: Select<device::Entity>,
    sort_by: &[DeviceListSort],
) -> Select<device::Entity> {
    for sort in sort_by {
        query = match sort {
            DeviceListSort::DisplayTitleAsc => {
                query.order_by(display_title_sort_expr(), Order::Asc)
            }
            DeviceListSort::DisplayTitleDesc => {
                query.order_by(display_title_sort_expr(), Order::Desc)
            }
            DeviceListSort::CreatedAtAsc => {
                query.order_by_asc(device::Column::CreatedAt)
            }
            DeviceListSort::CreatedAtDesc => {
                query.order_by_desc(device::Column::CreatedAt)
            }
            DeviceListSort::UpdatedAtAsc => {
                query.order_by_asc(device::Column::UpdatedAt)
            }
            DeviceListSort::UpdatedAtDesc => {
                query.order_by_desc(device::Column::UpdatedAt)
            }
        };
    }
    query.order_by_asc(device::Column::Id)
}

fn display_title_sort_expr() -> SimpleExpr {
    Func::lower(Func::coalesce([
        Expr::col((device::Entity, device::Column::Name)).into(),
        Expr::col((device::Entity, device::Column::SourceLabel)).into(),
    ]))
    .into()
}

async fn load_status_counts(
    main_db: &MainDb<'_, DatabaseConnection>,
    query: Select<device::Entity>,
) -> Result<DeviceStatusCounts, AppError> {
    let row = query
        .select_only()
        .column_as(archived_count_expr(false), "active")
        .column_as(archived_count_expr(true), "archived")
        .into_model::<DeviceStatusCountsRow>()
        .one(main_db.connection())
        .await
        .c(h!())?
        .unwrap_or(DeviceStatusCountsRow {
            active: 0,
            archived: 0,
        });
    Ok(DeviceStatusCounts {
        active: row.active,
        archived: row.archived,
    })
}

fn archived_count_expr(archived: bool) -> SimpleExpr {
    let count: SimpleExpr = Func::sum(
        Expr::case(
            Expr::col((device::Entity, device::Column::Archived)).eq(archived),
            1_i32,
        )
        .finally(0_i32),
    )
    .into();
    Func::coalesce([count, Expr::val(0_i64).into()]).into()
}

fn literal_substring_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn form_error(path: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from([(path.to_string(), message.to_string())]))
}
