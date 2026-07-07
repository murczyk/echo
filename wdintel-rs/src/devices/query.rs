#![allow(dead_code)]

use crate::devices::types::{
    DeviceDeletedFilter, DeviceDetailReq, DeviceDetails, DeviceFileEntry,
    DeviceListItem, DeviceListSortBy, ListDeviceFilesReq, ListDeviceFilesRsp,
    ListDevicesReq, ListDevicesRsp,
};
use crate::devices::validation::{
    normalize_device_list_pagination, normalize_file_list_pagination,
    parse_device_id,
};
use crate::entities::{
    area_of_responsibility, device, device_file, sigint_unit,
};
use crate::h;
use crate::types::{AppError, BTreeMap, BTreeSet, ShortContext, Uuid};
use chrono::NaiveDateTime;
use sea_orm::sea_query::{Expr, Order};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};

pub fn render_device_list_item(
    device: device::Model,
    aor_names: &BTreeMap<i64, String>,
    unit_names: &BTreeMap<i64, String>,
) -> DeviceListItem {
    DeviceListItem {
        id: device.id.to_string(),
        name: device.name,
        created_by: device.created_by,
        aor_name: device
            .aor_id
            .and_then(|aor_id| aor_names.get(&aor_id).cloned()),
        aor_id: device.aor_id,
        unit_name: device
            .unit_id
            .and_then(|unit_id| unit_names.get(&unit_id).cloned()),
        unit_id: device.unit_id,
        external_url: device.external_url,
        deleted: device.deleted,
        created_at_ms: datetime_ms(device.created_at),
        updated_at_ms: datetime_ms(device.updated_at),
        deleted_at_ms: device.deleted_at.map(datetime_ms),
    }
}

pub fn render_device_details(
    device: device::Model,
    aor_names: &BTreeMap<i64, String>,
    unit_names: &BTreeMap<i64, String>,
) -> Result<DeviceDetails, AppError> {
    let custom_fields = serde_json::from_value(device.custom_fields).c(h!())?;
    Ok(DeviceDetails {
        id: device.id.to_string(),
        name: device.name,
        created_by: device.created_by,
        aor_name: device
            .aor_id
            .and_then(|aor_id| aor_names.get(&aor_id).cloned()),
        aor_id: device.aor_id,
        unit_name: device
            .unit_id
            .and_then(|unit_id| unit_names.get(&unit_id).cloned()),
        unit_id: device.unit_id,
        custom_fields,
        external_url: device.external_url,
        deleted: device.deleted,
        created_at_ms: datetime_ms(device.created_at),
        updated_at_ms: datetime_ms(device.updated_at),
        deleted_at_ms: device.deleted_at.map(datetime_ms),
    })
}

pub fn render_device_file_entry(file: device_file::Model) -> DeviceFileEntry {
    DeviceFileEntry {
        file_id: file.id.to_string(),
        device_id: file.device_id.to_string(),
        original_name: file.original_name,
        original_absolute_path: file.original_absolute_path,
        original_created_at_ms: file.original_created_at.map(datetime_ms),
        original_modified_at_ms: file.original_modified_at.map(datetime_ms),
        deleted: file.deleted,
        created_at_ms: datetime_ms(file.created_at),
        updated_at_ms: datetime_ms(file.updated_at),
        deleted_at_ms: file.deleted_at.map(datetime_ms),
    }
}

pub async fn list_devices<C>(
    db: &C,
    req: &ListDevicesReq,
) -> Result<ListDevicesRsp, AppError>
where
    C: ConnectionTrait,
{
    if req.ids.as_ref().map(|ids| ids.is_empty()).unwrap_or(false) {
        return Ok(ListDevicesRsp {
            list: Vec::new(),
            total: 0,
            has_more: false,
        });
    }

    let pagination = normalize_device_list_pagination(req.limit, req.offset)?;
    let query = apply_device_filters(device::Entity::find(), req)?;
    let total = query.clone().count(db).await.c(h!())?;
    let devices = apply_device_sorting(query, &req.sort_by)
        .offset(pagination.offset)
        .limit(pagination.limit)
        .all(db)
        .await
        .c(h!())?;
    let next_offset = pagination.offset + devices.len() as u64;
    let (aor_names, unit_names) = load_device_label_maps(db, &devices).await?;
    let list = devices
        .into_iter()
        .map(|device| render_device_list_item(device, &aor_names, &unit_names))
        .collect();

    Ok(ListDevicesRsp {
        list,
        total,
        has_more: next_offset < total,
    })
}

pub async fn get_device_details<C>(
    db: &C,
    req: &DeviceDetailReq,
) -> Result<DeviceDetails, AppError>
where
    C: ConnectionTrait,
{
    let device_id = parse_device_id(&req.device_id)?;
    let mut query = device::Entity::find_by_id(device_id);
    if !req.include_deleted.unwrap_or(false) {
        query = query.filter(device::Column::Deleted.eq(false));
    }
    let device = query.one(db).await.c(h!())?.ok_or(AppError::NotFound)?;
    let (aor_names, unit_names) =
        load_device_label_maps(db, std::slice::from_ref(&device)).await?;
    render_device_details(device, &aor_names, &unit_names)
}

pub async fn list_device_files<C>(
    db: &C,
    req: &ListDeviceFilesReq,
) -> Result<ListDeviceFilesRsp, AppError>
where
    C: ConnectionTrait,
{
    let device_id = parse_device_id(&req.device_id)?;
    ensure_device_exists(db, device_id).await?;

    let pagination = normalize_file_list_pagination(req.limit, req.offset)?;
    let query = apply_deleted_filter(
        device_file::Entity::find()
            .filter(device_file::Column::DeviceId.eq(device_id)),
        req.deleted_filter,
        device_file::Column::Deleted,
    );
    let total = query.clone().count(db).await.c(h!())?;
    let files = query
        .order_by_desc(device_file::Column::UpdatedAt)
        .order_by_desc(device_file::Column::Id)
        .offset(pagination.offset)
        .limit(pagination.limit)
        .all(db)
        .await
        .c(h!())?;
    let next_offset = pagination.offset + files.len() as u64;
    let list = files.into_iter().map(render_device_file_entry).collect();

    Ok(ListDeviceFilesRsp {
        list,
        total,
        has_more: next_offset < total,
    })
}

fn apply_device_filters(
    mut query: Select<device::Entity>,
    req: &ListDevicesReq,
) -> Result<Select<device::Entity>, AppError> {
    query = apply_deleted_filter(
        query,
        req.deleted_filter,
        device::Column::Deleted,
    );

    if let Some(ids) = &req.ids {
        query =
            query.filter(device::Column::Id.is_in(parse_uuid_ids("ids", ids)?));
    }
    if let Some(aor_ids) = &req.aor_ids {
        if !aor_ids.is_empty() {
            query = query.filter(device::Column::AorId.is_in(aor_ids.clone()));
        }
    }
    if let Some(unit_ids) = &req.unit_ids {
        if !unit_ids.is_empty() {
            query =
                query.filter(device::Column::UnitId.is_in(unit_ids.clone()));
        }
    }
    if let Some(created_by) = normalize_filter_text(req.created_by.as_deref()) {
        query = query.filter(device::Column::CreatedBy.eq(created_by));
    }
    if let Some(filter_text) = normalize_filter_text(req.filter_text.as_deref())
    {
        query = query.filter(device_name_search_expr(&filter_text));
    }

    Ok(query)
}

fn apply_deleted_filter<E, C>(
    query: Select<E>,
    deleted_filter: Option<DeviceDeletedFilter>,
    deleted_column: C,
) -> Select<E>
where
    E: EntityTrait,
    C: ColumnTrait,
{
    match deleted_filter.unwrap_or(DeviceDeletedFilter::DeviceActiveOnly) {
        DeviceDeletedFilter::DeviceActiveOnly => {
            query.filter(deleted_column.eq(false))
        }
        DeviceDeletedFilter::DeviceDeletedOnly => {
            query.filter(deleted_column.eq(true))
        }
        DeviceDeletedFilter::DeviceAll => query,
    }
}

fn parse_uuid_ids(field: &str, ids: &[String]) -> Result<Vec<Uuid>, AppError> {
    ids.iter()
        .map(|id| {
            Uuid::parse_str(id.trim())
                .map_err(|_| form_error(field, "Некоректний UUID"))
        })
        .collect()
}

fn form_error(field: &str, message: &str) -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        field.to_string(),
        message.to_string(),
    )]))
}

fn normalize_filter_text(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn device_name_search_expr(
    filter_text: &str,
) -> sea_orm::sea_query::SimpleExpr {
    Expr::cust_with_values(
        r#""device"."name" ilike $1"#,
        vec![format!("%{filter_text}%")],
    )
}

fn apply_device_sorting(
    mut query: Select<device::Entity>,
    sort_by: &[DeviceListSortBy],
) -> Select<device::Entity> {
    let sort_by = if sort_by.is_empty() {
        vec![DeviceListSortBy::DeviceUpdatedAtDesc]
    } else {
        sort_by.to_vec()
    };

    for sort_by in sort_by {
        query = match sort_by {
            DeviceListSortBy::DeviceNameAsc => query.order_by(
                Expr::cust(r#"lower(btrim("device"."name"))"#),
                Order::Asc,
            ),
            DeviceListSortBy::DeviceNameDesc => query.order_by(
                Expr::cust(r#"lower(btrim("device"."name"))"#),
                Order::Desc,
            ),
            DeviceListSortBy::DeviceUpdatedAtAsc => {
                query.order_by_asc(device::Column::UpdatedAt)
            }
            DeviceListSortBy::DeviceUpdatedAtDesc => {
                query.order_by_desc(device::Column::UpdatedAt)
            }
        };
    }

    query.order_by_asc(device::Column::Id)
}

async fn ensure_device_exists<C>(
    db: &C,
    device_id: Uuid,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let exists = device::Entity::find_by_id(device_id)
        .one(db)
        .await
        .c(h!())?
        .is_some();
    if !exists {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn load_device_label_maps<C>(
    db: &C,
    devices: &[device::Model],
) -> Result<(BTreeMap<i64, String>, BTreeMap<i64, String>), AppError>
where
    C: ConnectionTrait,
{
    let aor_ids = devices.iter().filter_map(|device| device.aor_id).collect();
    let unit_ids = devices.iter().filter_map(|device| device.unit_id).collect();
    Ok((
        load_aor_names(db, aor_ids).await?,
        load_unit_names(db, unit_ids).await?,
    ))
}

async fn load_aor_names<C>(
    db: &C,
    aor_ids: BTreeSet<i64>,
) -> Result<BTreeMap<i64, String>, AppError>
where
    C: ConnectionTrait,
{
    if aor_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.is_in(aor_ids))
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    Ok(aors.into_iter().map(|aor| (aor.id, aor.name)).collect())
}

async fn load_unit_names<C>(
    db: &C,
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
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(db)
        .await
        .c(h!())?;
    Ok(units.into_iter().map(|unit| (unit.id, unit.name)).collect())
}

fn datetime_ms(datetime: NaiveDateTime) -> i64 {
    datetime.and_utc().timestamp_millis()
}
