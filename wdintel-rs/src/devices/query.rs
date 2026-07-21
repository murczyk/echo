#![allow(dead_code)]

use crate::devices::custom_fields::custom_fields_from_json;
use crate::devices::filesystem::{
    FileEntry, FilesystemError, FilesystemRepository, OffsetPageRequest,
};
use crate::devices::types::{
    DeviceArchivedFilter, DeviceDetailReq, DeviceDetails, DeviceFileEntry,
    DeviceListItem, DeviceListSortBy, DeviceStatusCountsRsp, DeviceUnitStatRow,
    DeviceUnitStatsRsp, ListDeviceFilesReq, ListDeviceFilesRsp, ListDevicesReq,
    ListDevicesRsp,
};
use crate::devices::validation::{
    normalize_device_list_pagination, parse_device_id,
};
use crate::entities::{
    area_of_responsibility, device, device_aor, sigint_unit,
};
use crate::file_registry::FileRegistryDb;
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
) -> Result<DeviceListItem, AppError> {
    let custom_fields = custom_fields_from_json(&device.custom_fields)?;
    let aors = device_aors.get(&device.id).cloned().unwrap_or_default();
    Ok(DeviceListItem {
        id: device.id.to_string(),
        source_label: device.source_label,
        name: device.name.unwrap_or_default(),
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
        custom_fields,
        archived: device.archived,
        created_at_ms: datetime_ms(device.created_at),
        updated_at_ms: datetime_ms(device.updated_at),
        archived_at_ms: device.archived_at.map(datetime_ms),
    })
}

fn render_device_details(
    device: device::Model,
    device_aors: &BTreeMap<Uuid, Vec<DeviceAorLabel>>,
    unit_names: &BTreeMap<i64, String>,
) -> Result<DeviceDetails, AppError> {
    let custom_fields = custom_fields_from_json(&device.custom_fields)?;
    let aors = device_aors.get(&device.id).cloned().unwrap_or_default();
    let tags = serde_json::from_value(device.tags).c(h!())?;
    Ok(DeviceDetails {
        id: device.id.to_string(),
        source_label: device.source_label,
        name: device.name.unwrap_or_default(),
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
        tags,
        external_url: device.external_url,
        custom_fields,
        archived: device.archived,
        created_at_ms: datetime_ms(device.created_at),
        updated_at_ms: datetime_ms(device.updated_at),
        archived_at_ms: device.archived_at.map(datetime_ms),
    })
}

fn render_device_file_entry(file: FileEntry) -> DeviceFileEntry {
    DeviceFileEntry {
        file_id: file.file_id.to_string(),
        device_id: file.device_id.to_string(),
        parent_id: Some(file.parent_entry_id.to_string()),
        name: file.name,
        path_syntax: Some(file.path_syntax.as_db_str().to_owned()),
        absolute_path: Some(file.absolute_path),
        mime_type: file.mime_type,
        extension: file.extension,
        file_metadata_created_at_ms: file
            .file_metadata_created_at
            .map(datetime_ms),
        file_metadata_modified_at_ms: file
            .file_metadata_modified_at
            .map(datetime_ms),
        created_at_ms: datetime_ms(file.created_at),
        updated_at_ms: datetime_ms(file.updated_at),
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
        .collect::<Result<Vec<_>, _>>()?;

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
    archived: i64,
}

#[derive(FromQueryResult)]
struct DeviceUnitStatSqlRow {
    unit_id: i64,
    count: i64,
}

fn empty_device_status_counts() -> DeviceStatusCountsRsp {
    DeviceStatusCountsRsp {
        active: 0,
        archived: 0,
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
            archived: 0,
        });

    Ok(DeviceStatusCountsRsp {
        active: row.active,
        archived: row.archived,
    })
}

fn build_device_status_counts_query(
    req: &ListDevicesReq,
) -> Result<Select<device::Entity>, AppError> {
    Ok(apply_device_filters(device::Entity::find(), req, false)?
        .select_only()
        .column_as(
            Expr::cust(
                r#"COUNT(*) FILTER (WHERE "device"."archived" = false)"#,
            ),
            "active",
        )
        .column_as(
            Expr::cust(r#"COUNT(*) FILTER (WHERE "device"."archived" = true)"#),
            "archived",
        ))
}

fn build_device_unit_stats_query() -> Select<device::Entity> {
    device::Entity::find()
        .filter(device::Column::Archived.eq(false))
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
    if !req.include_archived.unwrap_or(false) {
        query = query.filter(device::Column::Archived.eq(false));
    }
    let device = query.one(db).await.c(h!())?.ok_or(AppError::NotFound)?;
    let (device_aors, unit_names) =
        load_device_label_maps(db, std::slice::from_ref(&device)).await?;
    render_device_details(device, &device_aors, &unit_names)
}

pub async fn list_device_files<C>(
    main_db: &C,
    file_registry_db: &FileRegistryDb,
    req: &ListDeviceFilesReq,
) -> Result<ListDeviceFilesRsp, AppError>
where
    C: ConnectionTrait,
{
    let device_id = parse_device_id(&req.device_id)?;
    ensure_device_exists(main_db, device_id).await?;

    let pagination = normalize_device_list_pagination(req.limit, req.offset)?;
    let repository = FilesystemRepository::new(file_registry_db);
    let page = repository
        .list_files_offset(
            device_id,
            OffsetPageRequest {
                limit: pagination.limit,
                offset: pagination.offset,
            },
        )
        .await
        .map_err(map_filesystem_error)?;

    Ok(ListDeviceFilesRsp {
        list: page
            .entries
            .into_iter()
            .map(render_device_file_entry)
            .collect(),
        total: page.total,
        has_more: page.has_more,
    })
}

fn map_filesystem_error(error: FilesystemError) -> AppError {
    AppError::AnyhowError {
        source: anyhow::Error::new(error)
            .context("failed to list device files"),
    }
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

fn apply_device_filters(
    mut query: Select<device::Entity>,
    req: &ListDevicesReq,
    include_archived_filter: bool,
) -> Result<Select<device::Entity>, AppError> {
    if include_archived_filter {
        query = apply_archived_filter(
            query,
            req.archived_filter,
            device::Column::Archived,
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

fn apply_archived_filter<E, C>(
    query: Select<E>,
    archived_filter: Option<DeviceArchivedFilter>,
    archived_column: C,
) -> Select<E>
where
    E: EntityTrait,
    C: ColumnTrait,
{
    match archived_filter.unwrap_or(DeviceArchivedFilter::DeviceActiveOnly) {
        DeviceArchivedFilter::DeviceActiveOnly => {
            query.filter(archived_column.eq(false))
        }
        DeviceArchivedFilter::DeviceArchivedOnly => {
            query.filter(archived_column.eq(true))
        }
        DeviceArchivedFilter::DeviceAll => query,
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
    use crate::devices::filesystem::PathSyntax;
    use actix_web::{body::to_bytes, http::StatusCode, ResponseError};
    use chrono::NaiveDate;
    use sea_orm::{DbBackend, QueryTrait};
    use serde_json::json;

    fn empty_list_devices_req() -> ListDevicesReq {
        ListDevicesReq {
            filter_text: None,
            archived_filter: None,
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
            name: Some("Device Alpha".to_string()),
            created_by: "operator".to_string(),
            unit_id: Some(7),
            tags: json!([{ "label": "Serial", "value": "123" }]),
            external_url: None,
            archived: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
            source_label: "Source device".to_string(),
            custom_fields: json!({
                "inventory_id": "device.example",
                "source_port": "22",
                "transport": "ssh",
            }),
        }
    }

    #[test]
    fn device_status_counts_query_ignores_selected_archived_filter() {
        let mut req = empty_list_devices_req();
        req.archived_filter = Some(DeviceArchivedFilter::DeviceArchivedOnly);

        let sql = build_device_status_counts_query(&req)
            .unwrap()
            .build(DbBackend::Postgres)
            .to_string();

        assert_eq!(sql.matches("WHERE").count(), 2);
        assert!(sql.contains(
            r#"COUNT(*) FILTER (WHERE "device"."archived" = false)"#
        ));
        assert!(sql
            .contains(r#"COUNT(*) FILTER (WHERE "device"."archived" = true)"#));
    }

    #[test]
    fn device_unit_stats_query_counts_active_devices_with_active_units() {
        let sql = build_device_unit_stats_query()
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains(r#"INNER JOIN "sigint_unit" AS "sigint_unit""#));
        assert!(sql.contains(r#""device"."archived" = FALSE"#));
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
        )
        .unwrap();
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
        let row =
            render_device_list_item(device, &device_aors, &unit_names).unwrap();

        assert_eq!(row.aor_ids, vec![10, 20]);
        assert_eq!(row.aor_names, vec!["Alpha", ""]);
        assert_eq!(row.source_label, "Source device");
        assert_eq!(
            row.custom_fields.get("inventory_id"),
            Some(&"device.example".to_string())
        );
        assert_eq!(
            row.custom_fields.get("source_port"),
            Some(&"22".to_string())
        );
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
        assert_eq!(details.source_label, "Source device");
        assert_eq!(
            details.custom_fields.get("transport"),
            Some(&"ssh".to_string())
        );
    }

    #[test]
    fn render_keeps_source_label_separate_when_name_is_missing() {
        let mut device = fixture_device();
        device.name = None;
        device.source_label = "Source device".to_string();

        let list_item = render_device_list_item(
            device.clone(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .unwrap();
        let details =
            render_device_details(device, &BTreeMap::new(), &BTreeMap::new())
                .unwrap();

        assert_eq!(list_item.source_label, "Source device");
        assert_eq!(details.source_label, "Source device");
        assert!(list_item.name.is_empty());
        assert!(details.name.is_empty());
    }

    #[test]
    fn render_device_file_entry_uses_file_entry_fields() {
        let created_at = NaiveDate::from_ymd_opt(2026, 7, 7)
            .unwrap()
            .and_hms_milli_opt(10, 30, 0, 123)
            .unwrap();
        let updated_at = created_at
            .checked_add_signed(chrono::Duration::milliseconds(456))
            .unwrap();
        let parent_entry_id =
            Uuid::from_u128(0x018f0000000070008000000000000002);
        let entry = FileEntry {
            file_id: Uuid::from_u128(
                0x018f0000000070008000000000000001,
            ),
            device_id: Uuid::from_u128(
                0x018f0000000070008000000000000000,
            ),
            parent_entry_id,
            name: "report.pdf".to_string(),
            name_key: b"report.pdf".to_vec(),
            path_syntax: PathSyntax::Posix,
            absolute_path: "/reports/report.pdf".to_string(),
            hierarchy_path: "n018f0000000070008000000000000002.n018f0000000070008000000000000001".to_string(),
            mime_type: Some("application/pdf".to_string()),
            extension: Some("pdf".to_string()),
            file_metadata_created_at: Some(created_at),
            file_metadata_modified_at: Some(updated_at),
            created_at,
            updated_at,
        };

        let row = render_device_file_entry(entry);

        assert_eq!(row.file_id, "018f0000-0000-7000-8000-000000000001");
        assert_eq!(row.device_id, "018f0000-0000-7000-8000-000000000000");
        assert_eq!(
            row.parent_id.as_deref(),
            Some("018f0000-0000-7000-8000-000000000002")
        );
        assert_eq!(row.name, "report.pdf");
        assert_eq!(row.path_syntax.as_deref(), Some("posix"));
        assert_eq!(row.absolute_path.as_deref(), Some("/reports/report.pdf"));
        assert_eq!(row.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(row.extension.as_deref(), Some("pdf"));
        assert_eq!(
            row.file_metadata_created_at_ms,
            Some(datetime_ms(created_at))
        );
        assert_eq!(
            row.file_metadata_modified_at_ms,
            Some(datetime_ms(updated_at))
        );
        assert_eq!(row.created_at_ms, datetime_ms(created_at));
        assert_eq!(row.updated_at_ms, datetime_ms(updated_at));
    }
    #[actix_web::test]
    async fn filesystem_errors_remain_internal_at_transport_boundary() {
        for filesystem_error in [
            FilesystemError::Invariant("safe_invariant_code"),
            FilesystemError::Internal(anyhow::anyhow!(
                "filesystem-adapter-source-sentinel"
            )),
        ] {
            let error = map_filesystem_error(filesystem_error);
            assert!(matches!(error, AppError::AnyhowError { .. }));
            let response = error.error_response();

            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(
                to_bytes(response.into_body()).await.unwrap().as_ref(),
                b"Internal server error"
            );
        }
    }
}
