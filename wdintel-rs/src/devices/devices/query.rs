use super::bl::custom_fields::custom_fields_from_json;
use crate::devices::access;
use crate::devices::config::DEVICE_LIST_MAX_LIMIT;
use crate::devices::devices::types::{
    AorSummary, DeviceAorReference, DeviceArchivedScope,
    DeviceCreatorFilterOption, DeviceCurrentState, DeviceFilterOptions,
    DeviceListSort, DeviceUnitReference,
    DomainDeviceStatusCounts as DeviceStatusCounts,
    DomainDeviceUnitStat as DeviceUnitStat, ListDevicesResult,
};
use crate::entities::{
    area_of_responsibility, device, device_aor, login, organism, sigint_unit,
};
use crate::error::AppError;
use crate::h;
use crate::types::{NaiveDateTime, ShortContext};
use sea_orm::sea_query::{
    extension::postgres::PgExpr, Alias, CommonTableExpression, Expr, Func,
    JoinType, LikeExpr, NullOrdering, Order, Query, SelectStatement,
    SimpleExpr, UnionType, WithClause,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, ExprTrait,
    FromQueryResult, IntoSimpleExpr, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait, RelationTrait, Select, Set,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(in crate::devices) enum DeviceReadScope {
    ActiveOnly,
    IncludeArchived,
}

pub(in crate::devices) enum FileRegistryDeviceAccess {
    Read,
    FileSync,
}

pub(in crate::devices) fn visible_devices_query(
    login: &login::Model,
    scope: DeviceReadScope,
) -> Result<Select<device::Entity>, AppError> {
    access::require_read(&login.roles).c(h!())?;
    scoped_devices_query(login, scope)
}

pub(in crate::devices) fn scoped_devices_query(
    login: &login::Model,
    scope: DeviceReadScope,
) -> Result<Select<device::Entity>, AppError> {
    let organism_id = access::organism_id(login).c(h!())?;

    let query = device::Entity::find().filter(
        device::Column::OrganismId
            .in_subquery(visible_organism_ids_query(organism_id)),
    );
    match scope {
        DeviceReadScope::ActiveOnly => {
            Ok(query.filter(device::Column::Archived.eq(false)))
        }
        DeviceReadScope::IncludeArchived => Ok(query),
    }
}

pub(in crate::devices) async fn find_visible_device<C>(
    dbx: &C,
    login: &login::Model,
    device_id: Uuid,
    scope: DeviceReadScope,
) -> Result<device::Model, AppError>
where
    C: ConnectionTrait,
{
    visible_devices_query(login, scope)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

#[cfg(test)]
pub(in crate::devices) async fn find_active_visible_device<C>(
    dbx: &C,
    login: &login::Model,
    device_id: Uuid,
) -> Result<device::Model, AppError>
where
    C: ConnectionTrait,
{
    let device = find_visible_device(
        dbx,
        login,
        device_id,
        DeviceReadScope::IncludeArchived,
    )
    .await
    .c(h!())?;
    if device.archived {
        return Err(archived_device_error());
    }
    Ok(device)
}

pub(in crate::devices) async fn lock_active_device_for_update(
    dbx: &DatabaseTransaction,
    login: &login::Model,
    device_id: Uuid,
) -> Result<device::Model, AppError> {
    Ok(lock_active_scoped_device(dbx, login, device_id)
        .await
        .c(h!())?)
}

async fn find_active_scoped_device<C>(
    dbx: &C,
    login: &login::Model,
    device_id: Uuid,
) -> Result<device::Model, AppError>
where
    C: ConnectionTrait,
{
    let device = scoped_devices_query(login, DeviceReadScope::IncludeArchived)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    if device.archived {
        return Err(archived_device_error());
    }
    Ok(device)
}

async fn lock_active_scoped_device(
    dbx: &DatabaseTransaction,
    login: &login::Model,
    device_id: Uuid,
) -> Result<device::Model, AppError> {
    let device = scoped_devices_query(login, DeviceReadScope::IncludeArchived)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .lock_exclusive()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    if device.archived {
        return Err(archived_device_error());
    }
    Ok(device)
}

pub(in crate::devices) async fn authorize_file_registry_access<C>(
    dbx: &C,
    login: &login::Model,
    device_id: Uuid,
    access_kind: FileRegistryDeviceAccess,
) -> Result<Uuid, AppError>
where
    C: ConnectionTrait,
{
    match access_kind {
        FileRegistryDeviceAccess::Read => {
            find_visible_device(
                dbx,
                login,
                device_id,
                DeviceReadScope::IncludeArchived,
            )
            .await
            .c(h!())?;
        }
        FileRegistryDeviceAccess::FileSync => {
            access::require_file_sync(&login.roles).c(h!())?;
            find_active_scoped_device(dbx, login, device_id)
                .await
                .c(h!())?;
        }
    }

    Ok(device_id)
}

fn visible_organism_ids_query(organism_id: i64) -> SelectStatement {
    let visible_organism = Alias::new("visible_organism");
    let visible_organism_id = Alias::new("id");
    let descendants = Query::select()
        .column((organism::Entity, organism::Column::Id))
        .from(organism::Entity)
        .join(
            JoinType::InnerJoin,
            visible_organism.clone(),
            Expr::col((organism::Entity, organism::Column::ParentId)).equals((
                visible_organism.clone(),
                visible_organism_id.clone(),
            )),
        )
        .and_where(
            Expr::col((organism::Entity, organism::Column::DeletedPermanently))
                .eq(false),
        )
        .to_owned();
    let cte = CommonTableExpression::new()
        .table_name(visible_organism.clone())
        .column(visible_organism_id.clone())
        .query(
            Query::select()
                .expr(Expr::value(organism_id))
                .union(UnionType::Distinct, descendants)
                .to_owned(),
        )
        .to_owned();

    Query::select()
        .column((visible_organism.clone(), visible_organism_id))
        .from(visible_organism)
        .with_cte(WithClause::new().recursive(true).cte(cte).to_owned())
        .to_owned()
}

fn archived_device_error() -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        "device_id".to_string(),
        "Архівований пристрій не можна редагувати".to_string(),
    )]))
}

pub(super) struct ListDevicesQuery {
    pub(super) filter_text: Option<String>,
    pub(super) archived_scope: DeviceArchivedScope,
    pub(super) aor_ids: Vec<i64>,
    pub(super) unit_ids: Vec<i64>,
    pub(super) created_by: Vec<String>,
    pub(super) tags: Vec<String>,
    pub(super) limit: u64,
    pub(super) offset: u64,
    pub(super) sort_by: Vec<DeviceListSort>,
}

pub(super) async fn read(
    main_db: &DatabaseConnection,
    login: &login::Model,
    device_id: Uuid,
    scope: DeviceReadScope,
) -> Result<DeviceCurrentState, AppError> {
    let device = find_visible_device(main_db, login, device_id, scope)
        .await
        .c(h!())?;
    let mut devices = hydrate_devices(main_db, vec![device]).await.c(h!())?;
    Ok(devices
        .pop()
        .ok_or_else(|| anyhow::anyhow!("device hydrator lost its input"))
        .c(h!())?)
}

pub(super) async fn tag_options(
    main_db: &DatabaseConnection,
    login: &login::Model,
) -> Result<Vec<String>, AppError> {
    access::require_analytical_write(&login.roles).c(h!())?;
    let query = visible_devices_query(login, DeviceReadScope::IncludeArchived)
        .c(h!())?;
    Ok(read_tag_options(main_db, query).await.c(h!())?)
}

pub(super) async fn filter_options(
    main_db: &DatabaseConnection,
    login: &login::Model,
) -> Result<DeviceFilterOptions, AppError> {
    let query = visible_devices_query(login, DeviceReadScope::IncludeArchived)
        .c(h!())?;
    let creator_display_name = Expr::cust("(select nullif(author.display_name, '') from login author where author.login = device.created_by and not author.deleted_permanently)");
    let creators = query
        .clone()
        .select_only()
        .column(device::Column::CreatedBy)
        .column_as(creator_display_name, "display_name")
        .distinct()
        .order_by_asc(device::Column::CreatedBy)
        .into_tuple::<(String, Option<String>)>()
        .all(main_db)
        .await
        .c(h!())?
        .into_iter()
        .map(|(login, display_name)| DeviceCreatorFilterOption {
            login,
            display_name,
        })
        .collect();
    let device_ids = query
        .clone()
        .select_only()
        .column(device::Column::Id)
        .into_query();
    let aor_ids = device_aor::Entity::find()
        .select_only()
        .column(device_aor::Column::AorId)
        .filter(device_aor::Column::DeviceId.in_subquery(device_ids))
        .into_query();
    let aors = area_of_responsibility::Entity::find()
        .select_only()
        .columns([
            area_of_responsibility::Column::Id,
            area_of_responsibility::Column::Name,
        ])
        .filter(area_of_responsibility::Column::Id.in_subquery(aor_ids))
        .order_by_asc(area_of_responsibility::Column::Name)
        .into_tuple::<(i64, String)>()
        .all(main_db)
        .await
        .c(h!())?
        .into_iter()
        .map(|(id, name)| AorSummary { id, name })
        .collect();
    let tags = read_tag_options(main_db, query.clone()).await.c(h!())?;
    let custom_field_keys =
        read_custom_field_keys(main_db, query).await.c(h!())?;
    Ok(DeviceFilterOptions {
        aors,
        creators,
        tags,
        custom_field_keys,
    })
}

async fn read_custom_field_keys(
    main_db: &DatabaseConnection,
    query: Select<device::Entity>,
) -> Result<Vec<String>, AppError> {
    // Deduplicate in PostgreSQL so only key names leave the database, not
    // whole custom_fields documents (`device_custom_fields_object_check`
    // guarantees a JSON object).
    Ok(query
        .select_only()
        .expr_as(
            Expr::cust("jsonb_object_keys(device.custom_fields)"),
            "custom_field_key",
        )
        .distinct()
        .order_by_asc(Expr::cust("custom_field_key"))
        .into_tuple::<String>()
        .all(main_db)
        .await
        .c(h!())?)
}

async fn read_tag_options(
    main_db: &DatabaseConnection,
    query: Select<device::Entity>,
) -> anyhow::Result<Vec<String>> {
    let rows = query
        .select_only()
        .column(device::Column::Tags)
        .into_tuple::<serde_json::Value>()
        .all(main_db)
        .await
        .c(h!())?;
    let mut tags = BTreeMap::new();
    for row in rows {
        for tag in serde_json::from_value::<Vec<String>>(row).c(h!())? {
            tags.entry(tag.to_lowercase()).or_insert(tag);
        }
    }
    Ok(tags.into_values().collect())
}

pub(super) async fn set_archived(
    main_db: &DatabaseConnection,
    login: &login::Model,
    device_id: Uuid,
    archived: bool,
) -> Result<DeviceCurrentState, AppError> {
    use sea_orm::TransactionTrait;
    access::require_analytical_write(&login.roles).c(h!())?;
    let transaction = main_db.begin().await.c(h!())?;
    let device = visible_devices_query(login, DeviceReadScope::IncludeArchived)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .lock_exclusive()
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let device = if device.archived == archived {
        device
    } else {
        let now = chrono::Utc::now().naive_utc();
        device::ActiveModel {
            id: Set(device.id),
            archived: Set(archived),
            archived_at: Set(archived.then_some(now)),
            updated_at: Set(now),
            ..Default::default()
        }
        .update(&transaction)
        .await
        .c(h!())?
    };
    let device = hydrate_devices(&transaction, vec![device])
        .await
        .c(h!())?
        .pop()
        .ok_or_else(|| anyhow::anyhow!("device hydrator lost device"))
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(device)
}

#[cfg(test)]
pub(super) async fn list(
    main_db: &DatabaseConnection,
    login: &login::Model,
    command: ListDevicesQuery,
) -> Result<ListDevicesResult, AppError> {
    Ok(list_with_stats(main_db, None, login, command)
        .await
        .c(h!())?)
}

pub(super) async fn list_with_stats(
    main_db: &DatabaseConnection,
    file_db: Option<&DatabaseConnection>,
    login: &login::Model,
    command: ListDevicesQuery,
) -> Result<ListDevicesResult, AppError> {
    let query = apply_list_filters(
        visible_devices_query(login, DeviceReadScope::IncludeArchived)
            .c(h!())?,
        &command,
    );
    let status_counts =
        load_status_counts(main_db, query.clone()).await.c(h!())?;
    let activity_split_files_audio =
        crate::devices::settings::activity_split_files_audio(main_db)
            .await
            .c(h!())?;
    let query = apply_archived_scope(query, command.archived_scope);
    let total = query.clone().count(main_db).await.c(h!())?;
    let devices =
        if let (true, Some(file_db), [DeviceListSort::LastContentAtDesc]) = (
            total > DEVICE_LIST_MAX_LIMIT,
            file_db,
            command.sort_by.as_slice(),
        ) {
            super::activity_order::read(
                main_db,
                file_db,
                query,
                command.offset,
                command.limit,
                activity_split_files_audio,
            )
            .await
            .c(h!())?
        } else {
            read_sorted_page(
                main_db,
                file_db,
                query,
                &command,
                activity_split_files_audio,
            )
            .await
            .c(h!())?
        };
    let has_more = command.offset.saturating_add(devices.len() as u64) < total;
    let devices = hydrate_devices(main_db, devices).await.c(h!())?;

    Ok(ListDevicesResult {
        devices,
        total,
        has_more,
        status_counts,
        activity_split_files_audio,
    })
}

async fn read_sorted_page(
    main_db: &DatabaseConnection,
    file_db: Option<&DatabaseConnection>,
    query: Select<device::Entity>,
    command: &ListDevicesQuery,
    activity_split_files_audio: bool,
) -> anyhow::Result<Vec<device::Model>> {
    let sort_values = if command.sort_by.iter().any(|sort| {
        matches!(
            sort,
            DeviceListSort::ContentBytesAsc
                | DeviceListSort::ContentBytesDesc
                | DeviceListSort::LastContentAtAsc
                | DeviceListSort::LastContentAtDesc
        )
    }) {
        match file_db {
            Some(file_db) => {
                let ids = query
                    .clone()
                    .select_only()
                    .column(device::Column::Id)
                    .into_tuple::<Uuid>()
                    .all(main_db)
                    .await
                    .c(h!())?;
                Some(
                    crate::devices::files::stats::read_sort_values(
                        file_db,
                        &ids,
                        activity_split_files_audio,
                    )
                    .await
                    .c(h!())?,
                )
            }
            None => None,
        }
    } else {
        None
    };
    apply_list_sort(query, &command.sort_by, sort_values.as_ref())
        .offset(command.offset)
        .limit(command.limit)
        .all(main_db)
        .await
        .c(h!())
}

pub(super) async fn unit_stats(
    main_db: &DatabaseConnection,
    login: &login::Model,
) -> Result<Vec<DeviceUnitStat>, AppError> {
    let units = visible_devices_query(login, DeviceReadScope::ActiveOnly)
        .c(h!())?
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
        .all(main_db)
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

pub(super) async fn hydrate_devices<C>(
    main_db: &C,
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
    let mut aors_by_device =
        load_device_aors(main_db, device_ids).await.c(h!())?;
    let unit_names = load_unit_names(main_db, unit_ids).await.c(h!())?;

    devices
        .into_iter()
        .map(|device| hydrate_device(device, &mut aors_by_device, &unit_names))
        .collect()
}

async fn load_device_aors<C>(
    main_db: &C,
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
        .all(main_db)
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
    main_db: &C,
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
        .all(main_db)
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
    let custom_fields =
        custom_fields_from_json(&device.custom_fields).c(h!())?;
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
        rating: device.rating.unwrap_or(0),
        tags: serde_json::from_value(device.tags).c(h!())?,
        description: device.description,
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

fn apply_list_filters(
    mut query: Select<device::Entity>,
    command: &ListDevicesQuery,
) -> Select<device::Entity> {
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
    if !command.created_by.is_empty() {
        query = query.filter(
            device::Column::CreatedBy.is_in(command.created_by.clone()),
        );
    }
    if !command.tags.is_empty() {
        query = query.filter(Expr::cust_with_values(
            "exists (select 1 from jsonb_array_elements_text(device.tags) tag(value) where lower(tag.value) = any($1::text[]))",
            [sea_orm::Value::from(command.tags.clone())],
        ));
    }
    if let Some(filter_text) = &command.filter_text {
        let pattern = literal_substring_pattern(filter_text);
        query = query.filter(
            Condition::any()
                .add(
                    Expr::col((device::Entity, device::Column::Name))
                        .ilike(LikeExpr::new(pattern.clone())),
                )
                .add(
                    Expr::col((device::Entity, device::Column::Description))
                        .ilike(LikeExpr::new(pattern.clone())),
                )
                .add(
                    Expr::col((device::Entity, device::Column::Id))
                        .cast_as(Alias::new("text"))
                        .like(LikeExpr::new(pattern.clone()).escape('\\')),
                )
                .add(Expr::cust_with_values(
                    "exists (select 1 from jsonb_each_text(device.custom_fields) field(key, value) where field.value ilike $1)",
                    [sea_orm::Value::from(pattern)],
                )),
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
    sort_values: Option<&(serde_json::Value, serde_json::Value)>,
) -> Select<device::Entity> {
    for sort in sort_by {
        let expression = list_sort_expression(*sort, sort_values);
        let order = list_sort_order(*sort);
        query = if matches!(
            sort,
            DeviceListSort::AorsAsc
                | DeviceListSort::AorsDesc
                | DeviceListSort::UnitAsc
                | DeviceListSort::UnitDesc
                | DeviceListSort::LastContentAtAsc
                | DeviceListSort::LastContentAtDesc
        ) {
            query.order_by_with_nulls(expression, order, NullOrdering::Last)
        } else {
            query.order_by(expression, order)
        };
    }
    query.order_by_asc(device::Column::Id)
}

fn list_sort_order(sort: DeviceListSort) -> Order {
    match sort {
        DeviceListSort::DisplayTitleDesc
        | DeviceListSort::CreatedAtDesc
        | DeviceListSort::UpdatedAtDesc
        | DeviceListSort::AorsDesc
        | DeviceListSort::UnitDesc
        | DeviceListSort::CreatedByDesc
        | DeviceListSort::RatingDesc
        | DeviceListSort::ContentBytesDesc
        | DeviceListSort::LastContentAtDesc => Order::Desc,
        _ => Order::Asc,
    }
}

fn list_sort_expression(
    sort: DeviceListSort,
    sort_values: Option<&(serde_json::Value, serde_json::Value)>,
) -> SimpleExpr {
    match sort {
        DeviceListSort::DisplayTitleAsc | DeviceListSort::DisplayTitleDesc => display_title_sort_expr(),
        DeviceListSort::CreatedAtAsc | DeviceListSort::CreatedAtDesc => Expr::col((device::Entity, device::Column::CreatedAt)),
        DeviceListSort::UpdatedAtAsc | DeviceListSort::UpdatedAtDesc => Expr::col((device::Entity, device::Column::UpdatedAt)),
        DeviceListSort::AorsAsc | DeviceListSort::AorsDesc => Expr::cust("(select string_agg(lower(a.name), ', ' order by a.id) from device_aor da join area_of_responsibility a on a.id = da.aor_id where da.device_id = device.id)"),
        DeviceListSort::UnitAsc | DeviceListSort::UnitDesc => Expr::cust("(select lower(u.name) from sigint_unit u where u.id = device.unit_id)"),
        DeviceListSort::CreatedByAsc | DeviceListSort::CreatedByDesc => Expr::cust("lower(coalesce((select nullif(author.display_name, '') from login author where author.login = device.created_by and not author.deleted_permanently), device.created_by))"),
        DeviceListSort::RatingAsc | DeviceListSort::RatingDesc => Expr::cust("coalesce(device.rating, 0)"),
        DeviceListSort::ContentBytesAsc | DeviceListSort::ContentBytesDesc => Expr::cust_with_values(
            "coalesce((($1::jsonb) ->> device.id::text)::bigint, 0)",
            [sort_values.map(|values| values.0.clone()).unwrap_or_else(|| serde_json::json!({}))]),
        DeviceListSort::LastContentAtAsc | DeviceListSort::LastContentAtDesc => Expr::cust_with_values(
            "(($1::jsonb) ->> device.id::text)::timestamptz",
            [sort_values.map(|values| values.1.clone()).unwrap_or_else(|| serde_json::json!({}))]),
    }
}

fn display_title_sort_expr() -> SimpleExpr {
    Func::lower(Expr::col((device::Entity, device::Column::Name))).into()
}

async fn load_status_counts(
    main_db: &DatabaseConnection,
    query: Select<device::Entity>,
) -> Result<DeviceStatusCounts, AppError> {
    let row = query
        .select_only()
        .column_as(archived_count_expr(false), "active")
        .column_as(archived_count_expr(true), "archived")
        .into_model::<DeviceStatusCountsRow>()
        .one(main_db)
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
    Func::coalesce([count, Expr::val(0_i64)]).into()
}

fn literal_substring_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub(super) struct DeviceChanges {
    pub(super) rating: Option<i32>,
    pub(super) tags: Option<serde_json::Value>,
    pub(super) description: Option<Option<String>>,
    pub(super) external_url: Option<Option<String>>,
    pub(super) custom_fields: Option<serde_json::Value>,
    pub(super) name: Option<String>,
    pub(super) aor_ids: Option<Vec<i64>>,
    pub(super) unit_id: Option<Option<i64>>,
}

impl DeviceChanges {
    pub(super) fn is_empty(&self) -> bool {
        self.external_url.is_none()
            && self.rating.is_none()
            && self.tags.is_none()
            && self.description.is_none()
            && self.custom_fields.is_none()
            && self.name.is_none()
            && self.aor_ids.is_none()
            && self.unit_id.is_none()
    }
}

pub(super) async fn insert_device(
    main_db: &DatabaseTransaction,
    device: device::ActiveModel,
) -> Result<device::Model, AppError> {
    Ok(device.insert(main_db).await.c(h!())?)
}

pub(super) fn active_aor_reference_query(
    aor_ids: &[i64],
) -> Select<area_of_responsibility::Entity> {
    area_of_responsibility::Entity::find()
        .filter(
            area_of_responsibility::Column::Id.is_in(aor_ids.iter().copied()),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(area_of_responsibility::Column::Id)
        .lock_shared()
}

pub(super) fn active_unit_reference_query(
    unit_id: i64,
) -> Select<sigint_unit::Entity> {
    sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.eq(unit_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .lock_shared()
}

pub(super) async fn active_aor_count(
    main_db: &DatabaseTransaction,
    aor_ids: &[i64],
) -> Result<usize, AppError> {
    Ok(active_aor_reference_query(aor_ids)
        .all(main_db)
        .await
        .c(h!())?
        .len())
}

pub(super) async fn active_unit_exists(
    main_db: &DatabaseTransaction,
    unit_id: i64,
) -> Result<bool, AppError> {
    Ok(active_unit_reference_query(unit_id)
        .one(main_db)
        .await
        .c(h!())?
        .is_some())
}

pub(super) async fn load_current_aor_ids(
    main_db: &DatabaseTransaction,
    device_id: Uuid,
) -> Result<Vec<i64>, AppError> {
    Ok(device_aor::Entity::find()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .order_by_asc(device_aor::Column::AorId)
        .all(main_db)
        .await
        .c(h!())?
        .into_iter()
        .map(|device_aor| device_aor.aor_id)
        .collect())
}

pub(super) async fn replace_device_aors(
    main_db: &DatabaseTransaction,
    device_id: Uuid,
    aor_ids: &[i64],
    now: NaiveDateTime,
) -> Result<(), AppError> {
    device_aor::Entity::delete_many()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .exec(main_db)
        .await
        .c(h!())?;
    if aor_ids.is_empty() {
        return Ok(());
    }

    let aors = aor_ids.iter().map(|aor_id| device_aor::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(device_id),
        aor_id: Set(*aor_id),
        created_at: Set(now),
    });
    device_aor::Entity::insert_many(aors)
        .exec(main_db)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn apply_device_changes(
    main_db: &DatabaseTransaction,
    device_id: Uuid,
    changes: DeviceChanges,
    now: NaiveDateTime,
) -> Result<device::Model, AppError> {
    let DeviceChanges {
        rating,
        tags,
        description,
        external_url,
        custom_fields,
        name,
        aor_ids: _,
        unit_id,
    } = changes;
    let mut device = device::ActiveModel {
        id: Set(device_id),
        ..Default::default()
    };
    if let Some(rating) = rating {
        device.rating = Set(Some(rating));
    }
    if let Some(tags) = tags {
        device.tags = Set(tags);
    }
    if let Some(description) = description {
        device.description = Set(description);
    }
    if let Some(external_url) = external_url {
        device.external_url = Set(external_url);
    }
    if let Some(custom_fields) = custom_fields {
        device.custom_fields = Set(custom_fields);
    }
    if let Some(name) = name {
        device.name = Set(Some(name));
    }
    if let Some(unit_id) = unit_id {
        device.unit_id = Set(unit_id);
    }
    device.updated_at = Set(now);
    Ok(device.update(main_db).await.c(h!())?)
}
