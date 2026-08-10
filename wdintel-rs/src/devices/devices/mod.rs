mod bl;
pub(in crate::devices) mod query;
#[cfg(test)]
mod tests;
pub mod types;

use self::bl::{map_device_details, map_device_list, map_device_unit_stats};
use self::query::DeviceReadScope;
use self::types::{
    CreateDeviceCommand, CreateDeviceReq, DeviceArchivedFilter,
    DeviceArchivedScope, DeviceDetailReq, DeviceDetails, DeviceListSort,
    DeviceListSortBy, DevicePatchField, DeviceUnitStatsRsp, ListDevicesCommand,
    ListDevicesReq, ListDevicesRsp, UpdateDeviceCommand, UpdateDeviceReq,
};
use crate::devices::access;
use crate::devices::types::{parse_uuid, NullablePatch, RequiredPatch};
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
pub(crate) async fn list(
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
        aor_ids: body.aor_ids.unwrap_or_default(),
        unit_ids: body.unit_ids.unwrap_or_default(),
        limit: body.limit,
        offset: body.offset,
        sort_by: body.sort_by.into_iter().map(map_list_sort).collect(),
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::list(&env.dbx, &login, command).await.c(h!())?;
    Ok(Json(map_device_list(result)))
}

#[post("/api/device/unit-stats")]
pub(crate) async fn unit_stats(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<DeviceUnitStatsRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::unit_stats(&env.dbx, &login).await.c(h!())?;
    Ok(Json(map_device_unit_stats(result)))
}

#[post("/api/device/aors")]
pub(crate) async fn aors(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<Vec<AreaOfResponsibility>>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
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
pub(crate) async fn units(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<ListUnitsRsp>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    access::require_analytical_write(&login.roles).c(h!())?;
    let req = ListUnitsReq {
        sort_by: None,
        after_unit_id: None,
        before_unit_id: None,
        include_inactive: false,
        filter_active: None,
        filter_text: None,
        filter_name: None,
        filter_company: None,
        filter_battalion: None,
        filter_regiment: None,
        filter_division: None,
        filter_army: None,
        filter_military_district: None,
        filter_army_region: None,
        filter_comment: None,
        filter_orbit_note: None,
        filter_is_deduplicate_candidate: None,
        filter_has_orbit: None,
        filter_has_orbit_note: None,
        search_mode: None,
        limit: None,
        offset: None,
    };
    let mut response = crate::sigint::unit::read_units(&env.dbx, &req)
        .await
        .c(h!())?;
    if !crate::sigint::unit::orbit::can_view_orbit_data(&env.dbx, &login.id)
        .await?
    {
        for unit in &mut response.units {
            crate::sigint::unit::redact_unit_orbit_data(unit);
        }
    }
    Ok(Json(response))
}

#[post("/api/device/detail")]
pub(crate) async fn detail(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceDetailReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let scope = if body.include_archived.unwrap_or(false) {
        DeviceReadScope::IncludeArchived
    } else {
        DeviceReadScope::ActiveOnly
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = bl::read(&env.dbx, &login, parse_uuid(&body.device_id), scope)
        .await
        .c(h!())?;
    Ok(Json(map_device_details(device)))
}

#[post("/api/device/create")]
pub(crate) async fn create(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<CreateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let command = CreateDeviceCommand {
        name: body.name,
        external_url: body.external_url,
        custom_fields: body.custom_fields.into_option(),
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = bl::create(&env.dbx, &login, command).await.c(h!())?;
    Ok(Json(map_device_details(device)))
}

#[post("/api/device/update")]
pub(crate) async fn update(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<UpdateDeviceReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    let command = UpdateDeviceCommand {
        device_id: parse_uuid(&body.device_id),
        external_url: map_nullable_patch(body.external_url),
        custom_fields: map_required_patch(body.custom_fields),
        name: map_required_patch(body.name),
        aor_ids: map_required_patch(body.aor_ids),
        unit_id: map_nullable_patch(body.unit_id),
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = bl::update(&env.dbx, &login, command).await.c(h!())?;
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
