use super::mapping::{
    map_device_details, map_device_list, map_device_unit_stats,
};
use super::types::{
    parse_uuid, CreateDeviceReq, DeviceArchivedFilter, DeviceDetailReq,
    DeviceDetails, DeviceListSortBy, DeviceUnitStatsRsp, ListDevicesReq,
    ListDevicesRsp, NullablePatch, RequiredPatch, UpdateDeviceReq,
};
use crate::devices::access;
use crate::devices::main_db::MainDb;
use crate::devices::service::{
    CreateDeviceCommand, DeviceArchivedScope, DeviceListSort, DevicePatchField,
    DeviceService, ListDevicesCommand, UpdateDeviceCommand,
};
use crate::devices::visibility::DeviceReadScope;
use crate::error::AppError;
use crate::h;
use crate::sigint::aor::types::{
    AreaOfResponsibility, ListAreasOfResponsibilityReq,
};
use crate::sigint::unit::types::{ListUnitsReq, ListUnitsRsp};
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};

#[post("/api/device/list")]
pub(in crate::devices) async fn list(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<ListDevicesReq>,
) -> Result<Json<ListDevicesRsp>, AppError> {
    let command = ListDevicesCommand {
        filter_text: body.filter_text,
        archived_scope: match body
            .archived_filter
            .unwrap_or(DeviceArchivedFilter::ActiveOnly)
        {
            DeviceArchivedFilter::ActiveOnly => DeviceArchivedScope::ActiveOnly,
            DeviceArchivedFilter::ArchivedOnly => {
                DeviceArchivedScope::ArchivedOnly
            }
            DeviceArchivedFilter::AllDevices => DeviceArchivedScope::All,
        },
        needs_analytical_name: body.needs_analytical_name,
        aor_ids: body.aor_ids.unwrap_or_default(),
        unit_ids: body.unit_ids.unwrap_or_default(),
        limit: body.limit,
        offset: body.offset,
        sort_by: body.sort_by.into_iter().map(map_list_sort).collect(),
    };
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    let result = DeviceService::list(&main_db, &login, command)
        .await
        .c(h!())?;
    Ok(Json(map_device_list(result)))
}

#[post("/api/device/unit-stats")]
pub(in crate::devices) async fn unit_stats(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<DeviceUnitStatsRsp>, AppError> {
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    let result = DeviceService::unit_stats(&main_db, &login).await.c(h!())?;
    Ok(Json(map_device_unit_stats(result)))
}

#[post("/api/device/aors")]
pub(in crate::devices) async fn aors(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<Vec<AreaOfResponsibility>>, AppError> {
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    access::require_analytical_write(&login.roles).c(h!())?;
    let req = ListAreasOfResponsibilityReq { sort_by: None };
    Ok(Json(
        crate::sigint::aor::read_aors(&env.dbx, &req)
            .await
            .c(h!())?,
    ))
}

#[post("/api/device/units")]
pub(in crate::devices) async fn units(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<ListUnitsRsp>, AppError> {
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    access::require_analytical_write(&login.roles).c(h!())?;
    let req = ListUnitsReq {
        sort_by: None,
        after_unit_id: None,
        before_unit_id: None,
    };
    Ok(Json(
        crate::sigint::unit::read_units(&env.dbx, &req)
            .await
            .c(h!())?,
    ))
}

#[post("/api/device/detail")]
pub(in crate::devices) async fn detail(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceDetailReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let scope = if body.include_archived.unwrap_or(false) {
        DeviceReadScope::IncludeArchived
    } else {
        DeviceReadScope::ActiveOnly
    };
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    let device = DeviceService::read(
        &main_db,
        &login,
        parse_uuid(&body.device_id),
        scope,
    )
    .await
    .c(h!())?;
    Ok(Json(map_device_details(device)))
}

#[post("/api/device/create")]
pub(in crate::devices) async fn create(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<CreateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let command = CreateDeviceCommand {
        source_label: body.source_label,
        external_url: body.external_url,
        custom_fields: body.custom_fields.into_option(),
    };
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    let device = DeviceService::create(&main_db, &login, command)
        .await
        .c(h!())?;
    Ok(Json(map_device_details(device)))
}

#[post("/api/device/update")]
pub(in crate::devices) async fn update(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<UpdateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let command = UpdateDeviceCommand {
        device_id: parse_uuid(&body.device_id),
        source_label: map_required_patch(body.source_label),
        external_url: map_nullable_patch(body.external_url),
        custom_fields: map_required_patch(body.custom_fields),
        name: map_nullable_patch(body.name),
        aor_ids: map_required_patch(body.aor_ids),
        unit_id: map_nullable_patch(body.unit_id),
    };
    let main_db = MainDb::new(&env.dbx);
    let login = access::resolve_current_login(&main_db, &user)
        .await
        .c(h!())?;
    let device = DeviceService::update(&main_db, &login, command)
        .await
        .c(h!())?;
    Ok(Json(map_device_details(device)))
}

fn map_list_sort(sort: DeviceListSortBy) -> DeviceListSort {
    match sort {
        DeviceListSortBy::DisplayTitleAsc => DeviceListSort::DisplayTitleAsc,
        DeviceListSortBy::DisplayTitleDesc => DeviceListSort::DisplayTitleDesc,
        DeviceListSortBy::DeviceCreatedAtAsc => DeviceListSort::CreatedAtAsc,
        DeviceListSortBy::DeviceCreatedAtDesc => DeviceListSort::CreatedAtDesc,
        DeviceListSortBy::UpdatedAtAsc => DeviceListSort::UpdatedAtAsc,
        DeviceListSortBy::UpdatedAtDesc => DeviceListSort::UpdatedAtDesc,
    }
}

fn map_required_patch<T>(patch: RequiredPatch<T>) -> DevicePatchField<T> {
    match patch {
        RequiredPatch::Missing => DevicePatchField::Missing,
        RequiredPatch::Value(value) => DevicePatchField::Value(value),
    }
}

fn map_nullable_patch<T>(
    patch: NullablePatch<T>,
) -> DevicePatchField<Option<T>> {
    match patch {
        NullablePatch::Missing => DevicePatchField::Missing,
        NullablePatch::Null => DevicePatchField::Value(None),
        NullablePatch::Value(value) => DevicePatchField::Value(Some(value)),
    }
}
