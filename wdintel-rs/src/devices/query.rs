#![allow(dead_code)]

use crate::devices::types::{
    DeviceDeletedFilter, DeviceDetailReq, DeviceDetails, DeviceFileEntry,
    DeviceListItem, DeviceListSortBy, DeviceStatusCountsRsp, DeviceUnitStatRow,
    DeviceUnitStatsRsp, ListDeviceFilesReq, ListDeviceFilesRsp, ListDevicesReq,
    ListDevicesRsp,
};
use crate::devices::validation::{
    normalize_device_list_pagination, normalize_file_list_pagination,
    parse_device_id,
};
use crate::entities::{
    area_of_responsibility, device, device_aor, device_file, sigint_unit,
};
use crate::h;
use crate::types::{AppError, BTreeMap, BTreeSet, ShortContext, Uuid};
use chrono::NaiveDateTime;
use sea_orm::sea_query::{Alias, Expr, Order};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, IntoSimpleExpr,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait,
    RelationTrait, Select,
};

#[derive(Clone)]
struct DeviceAorLabel {
    id: i64,
    name: Option<String>,
}

fn render_device_list_item(
    device: device::Model,
    device_aors: &BTreeMap<Uuid, Vec<DeviceAorLabel>>,
    unit_names: &BTreeMap<i64, String>,
) -> DeviceListItem {
    let aors = device_aors.get(&device.id).cloned().unwrap_or_default();
    DeviceListItem {
        id: device.id.to_string(),
        name: device.name,
        created_by: device.created_by,
        aor_ids: aors.iter().map(|aor| aor.id).collect(),
        aor_names: aors
            .into_iter()
            .map(|aor| aor.name.unwrap_or_default())
            .collect(),
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

fn render_device_details(
    device: device::Model,
    device_aors: &BTreeMap<Uuid, Vec<DeviceAorLabel>>,
    unit_names: &BTreeMap<i64, String>,
) -> Result<DeviceDetails, AppError> {
    let aors = device_aors.get(&device.id).cloned().unwrap_or_default();
    let custom_fields = serde_json::from_value(device.custom_fields).c(h!())?;
    Ok(DeviceDetails {
        id: device.id.to_string(),
        name: device.name,
        created_by: device.created_by,
        aor_ids: aors.iter().map(|aor| aor.id).collect(),
        aor_names: aors
            .into_iter()
            .map(|aor| aor.name.unwrap_or_default())
            .collect(),
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
            status_counts: empty_device_status_counts(),
        });
    }

    let pagination = normalize_device_list_pagination(req.limit, req.offset)?;
    let query = apply_device_filters(device::Entity::find(), req, true)?;
    let total = query.clone().count(db).await.c(h!())?;
    let status_counts = load_device_status_counts(db, req).await?;
    let devices = apply_device_sorting(query, &req.sort_by)
        .offset(pagination.offset)
        .limit(pagination.limit)
        .all(db)
        .await
        .c(h!())?;
    let next_offset = pagination.offset + devices.len() as u64;
    let (device_aors, unit_names) =
        load_device_label_maps(db, &devices).await?;
    let list = devices
        .into_iter()
        .map(|device| {
            render_device_list_item(device, &device_aors, &unit_names)
        })
        .collect();

    Ok(ListDevicesRsp {
        list,
        total,
        has_more: next_offset < total,
        status_counts,
    })
}

pub async fn list_device_unit_stats<C>(
    db: &C,
) -> Result<DeviceUnitStatsRsp, AppError>
where
    C: ConnectionTrait,
{
    let units = build_device_unit_stats_query()
        .into_model::<DeviceUnitStatSqlRow>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|row| DeviceUnitStatRow {
            unit_id: row.unit_id,
            count: row.count,
        })
        .collect();

    Ok(DeviceUnitStatsRsp { units })
}

#[derive(FromQueryResult)]
struct DeviceStatusCountsSqlRow {
    active: i64,
    deleted: i64,
}

#[derive(FromQueryResult)]
struct DeviceUnitStatSqlRow {
    unit_id: i64,
    count: i64,
}

fn empty_device_status_counts() -> DeviceStatusCountsRsp {
    DeviceStatusCountsRsp {
        active: 0,
        deleted: 0,
    }
}

async fn load_device_status_counts<C>(
    db: &C,
    req: &ListDevicesReq,
) -> Result<DeviceStatusCountsRsp, AppError>
where
    C: ConnectionTrait,
{
    let row = build_device_status_counts_query(req)?
        .into_model::<DeviceStatusCountsSqlRow>()
        .one(db)
        .await
        .c(h!())?
        .unwrap_or(DeviceStatusCountsSqlRow {
            active: 0,
            deleted: 0,
        });

    Ok(DeviceStatusCountsRsp {
        active: row.active,
        deleted: row.deleted,
    })
}

fn build_device_status_counts_query(
    req: &ListDevicesReq,
) -> Result<Select<device::Entity>, AppError> {
    Ok(apply_device_filters(device::Entity::find(), req, false)?
        .select_only()
        .column_as(
            Expr::cust(r#"COUNT(*) FILTER (WHERE "device"."deleted" = false)"#),
            "active",
        )
        .column_as(
            Expr::cust(r#"COUNT(*) FILTER (WHERE "device"."deleted" = true)"#),
            "deleted",
        ))
}

fn build_device_unit_stats_query() -> Select<device::Entity> {
    device::Entity::find()
        .filter(device::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .join_as(
            JoinType::InnerJoin,
            device::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column_as(device::Column::Id.count(), "count")
        .column_as(sigint_unit::Column::Id, "unit_id")
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .group_by(sigint_unit::Column::Id)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company)
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
    let (device_aors, unit_names) =
        load_device_label_maps(db, std::slice::from_ref(&device)).await?;
    render_device_details(device, &device_aors, &unit_names)
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
    include_deleted_filter: bool,
) -> Result<Select<device::Entity>, AppError> {
    if include_deleted_filter {
        query = apply_deleted_filter(
            query,
            req.deleted_filter,
            device::Column::Deleted,
        );
    }

    if let Some(ids) = &req.ids {
        query =
            query.filter(device::Column::Id.is_in(parse_uuid_ids("ids", ids)?));
    }
    if let Some(aor_ids) = &req.aor_ids {
        if !aor_ids.is_empty() {
            let device_aor_exists = device_aor::Entity::find()
                .select_only()
                .expr(Expr::value(1))
                .filter(
                    device_aor::Column::DeviceId
                        .into_simple_expr()
                        .eq(device::Column::Id.into_simple_expr()),
                )
                .filter(device_aor::Column::AorId.is_in(aor_ids.clone()))
                .into_query();
            query = query.filter(Expr::exists(device_aor_exists));
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
) -> Result<
    (BTreeMap<Uuid, Vec<DeviceAorLabel>>, BTreeMap<i64, String>),
    AppError,
>
where
    C: ConnectionTrait,
{
    let device_ids = devices.iter().map(|device| device.id).collect();
    let unit_ids = devices.iter().filter_map(|device| device.unit_id).collect();
    Ok((
        load_device_aor_labels(db, device_ids).await?,
        load_unit_names(db, unit_ids).await?,
    ))
}

async fn load_device_aor_labels<C>(
    db: &C,
    device_ids: Vec<Uuid>,
) -> Result<BTreeMap<Uuid, Vec<DeviceAorLabel>>, AppError>
where
    C: ConnectionTrait,
{
    if device_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let rows = device_aor::Entity::find()
        .find_also_related(area_of_responsibility::Entity)
        .filter(device_aor::Column::DeviceId.is_in(device_ids))
        .order_by_asc(device_aor::Column::Id)
        .all(db)
        .await
        .c(h!())?;
    let mut result = BTreeMap::new();
    for (device_aor, aor) in rows {
        let name = aor.and_then(|aor| (!aor.deleted).then_some(aor.name));
        result
            .entry(device_aor.device_id)
            .or_insert_with(Vec::new)
            .push(DeviceAorLabel {
                id: device_aor.aor_id,
                name,
            });
    }
    Ok(result)
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use sea_orm::{DbBackend, QueryTrait};
    use serde_json::json;

    fn empty_list_devices_req() -> ListDevicesReq {
        ListDevicesReq {
            filter_text: None,
            deleted_filter: None,
            aor_ids: None,
            unit_ids: None,
            created_by: None,
            ids: None,
            limit: None,
            offset: None,
            sort_by: Vec::new(),
        }
    }

    fn fixture_device() -> device::Model {
        let now = NaiveDate::from_ymd_opt(2026, 7, 7)
            .unwrap()
            .and_hms_opt(10, 30, 0)
            .unwrap();
        device::Model {
            id: Uuid::from_u128(0x018f0000000070008000000000000000),
            name: "Device Alpha".to_string(),
            created_by: "operator".to_string(),
            unit_id: Some(7),
            custom_fields: json!([{ "label": "Serial", "value": "123" }]),
            external_url: None,
            deleted: false,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn device_status_counts_query_ignores_selected_deleted_filter() {
        let mut req = empty_list_devices_req();
        req.deleted_filter = Some(DeviceDeletedFilter::DeviceDeletedOnly);

        let sql = build_device_status_counts_query(&req)
            .unwrap()
            .build(DbBackend::Postgres)
            .to_string();

        assert_eq!(sql.matches("WHERE").count(), 2);
        assert!(sql
            .contains(r#"COUNT(*) FILTER (WHERE "device"."deleted" = false)"#));
        assert!(sql
            .contains(r#"COUNT(*) FILTER (WHERE "device"."deleted" = true)"#));
    }

    #[test]
    fn device_unit_stats_query_counts_active_devices_with_active_units() {
        let sql = build_device_unit_stats_query()
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains(r#"INNER JOIN "sigint_unit" AS "sigint_unit""#));
        assert!(sql.contains(r#""device"."deleted" = FALSE"#));
        assert!(sql.contains(r#""sigint_unit"."deleted" = FALSE"#));
        assert!(sql.contains(r#"GROUP BY "sigint_unit"."id""#));
    }

    #[test]
    fn render_device_list_item_supports_zero_and_multiple_smugi() {
        let device = fixture_device();
        let unit_names = BTreeMap::from([(7, "Unit".to_string())]);

        let row = render_device_list_item(
            device.clone(),
            &BTreeMap::new(),
            &unit_names,
        );
        assert!(row.aor_ids.is_empty());
        assert!(row.aor_names.is_empty());

        let device_aors = BTreeMap::from([(
            device.id,
            vec![
                DeviceAorLabel {
                    id: 10,
                    name: Some("Alpha".to_string()),
                },
                DeviceAorLabel { id: 20, name: None },
            ],
        )]);
        let row = render_device_list_item(device, &device_aors, &unit_names);

        assert_eq!(row.aor_ids, vec![10, 20]);
        assert_eq!(row.aor_names, vec!["Alpha", ""]);
    }

    #[test]
    fn render_device_details_supports_multiple_smugi() {
        let device = fixture_device();
        let device_aors = BTreeMap::from([(
            device.id,
            vec![
                DeviceAorLabel {
                    id: 10,
                    name: Some("Alpha".to_string()),
                },
                DeviceAorLabel {
                    id: 20,
                    name: Some("Bravo".to_string()),
                },
            ],
        )]);
        let details =
            render_device_details(device, &device_aors, &BTreeMap::new())
                .unwrap();

        assert_eq!(details.aor_ids, vec![10, 20]);
        assert_eq!(details.aor_names, vec!["Alpha", "Bravo"]);
    }
}
