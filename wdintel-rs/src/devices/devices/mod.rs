mod activity_order;
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
use crate::devices::config::DEVICE_STATS_LIST_ACTIVITY_DAYS;
use crate::devices::files::stats;
use crate::devices::types::{parse_uuid, NullablePatch, RequiredPatch};
use crate::error::AppError;
use crate::h;
use crate::sigint::aor::types::{
    AreaOfResponsibility, ListAreasOfResponsibilityReq,
};
use crate::sigint::unit::types::{ListUnitsReq, ListUnitsRsp};
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{post, HttpResponse};

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
        created_by: body.created_by.unwrap_or_default(),
        tags: body.tags.unwrap_or_default(),
        limit: body.limit,
        offset: body.offset,
        sort_by: body.sort_by.into_iter().map(map_list_sort).collect(),
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let result = bl::list_with_stats(
        &env.dbx,
        env.file_registry_db.as_ref().map(|db| db.connection()),
        &login,
        command,
    )
    .await
    .c(h!())?;
    let device_ids: Vec<_> =
        result.devices.iter().map(|device| device.id).collect();
    let stats = match &env.file_registry_db {
        Some(file_registry_db) => {
            stats::read_many_or_none(
                file_registry_db.connection(),
                &device_ids,
                stats::DayHistory::Recent {
                    days: DEVICE_STATS_LIST_ACTIVITY_DAYS,
                },
            )
            .await
        }
        None => None,
    };
    let audio_days = if result.activity_split_files_audio {
        match &env.file_registry_db {
            Some(db) => {
                crate::devices::audio::activity::read_recent_or_none(
                    db.connection(),
                    &device_ids,
                )
                .await
            }
            None => None,
        }
    } else {
        None
    };
    Ok(Json(map_device_list(result, stats, audio_days)))
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

#[post("/api/device/tags")]
pub(crate) async fn tags(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<Vec<String>>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(query::tag_options(&env.dbx, &login).await.c(h!())?))
}

#[post("/api/device/filter-options")]
pub(crate) async fn filter_options(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<types::DeviceFilterOptions>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    Ok(Json(query::filter_options(&env.dbx, &login).await.c(h!())?))
}

#[post("/api/device/archive")]
pub(crate) async fn archive(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceDetailReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    change_archived(env, user, body, true).await
}

#[post("/api/device/unarchive")]
pub(crate) async fn unarchive(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<DeviceDetailReq>,
) -> Result<Json<DeviceDetails>, AppError> {
    change_archived(env, user, body, false).await
}

async fn change_archived(
    env: Data<Env>,
    user: Identity,
    body: DeviceDetailReq,
    archived: bool,
) -> Result<Json<DeviceDetails>, AppError> {
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = query::set_archived(
        &env.dbx,
        &login,
        parse_uuid(&body.device_id),
        archived,
    )
    .await
    .c(h!())?;
    let configured =
        crate::devices::audio::forwarding::configured(&env.dbx, device.id)
            .await
            .c(h!())?;
    Ok(Json(map_device_details(device, configured)))
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
    let req = ListUnitsReq::default();
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
    let login = crate::devices::documents::access::reader(
        &env,
        crate::users::login_id_from_identity(&user).c(h!())?,
    )
    .await
    .c(h!())?;
    let device = bl::read(&env.dbx, &login, parse_uuid(&body.device_id), scope)
        .await
        .c(h!())?;
    let configured =
        crate::devices::audio::forwarding::configured(&env.dbx, device.id)
            .await
            .c(h!())?;
    Ok(Json(map_device_details(device, configured)))
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
    crate::devices::mattermost::spawn_device_created_notification(
        env.into_inner(),
        &device,
    );
    Ok(Json(map_device_details(device, false)))
}

#[post("/api/device/update")]
pub(crate) async fn update(
    env: Data<Env>,
    user: Identity,
    Json(body): Json<UpdateDeviceReq>,
) -> Result<HttpResponse, AppError> {
    let command = UpdateDeviceCommand {
        device_id: parse_uuid(&body.device_id),
        rating: map_required_patch(body.rating),
        tags: map_required_patch(body.tags),
        description: map_nullable_patch(body.description),
        external_url: map_nullable_patch(body.external_url),
        custom_fields: map_required_patch(body.custom_fields),
        name: map_required_patch(body.name),
        aor_ids: map_required_patch(body.aor_ids),
        unit_id: map_nullable_patch(body.unit_id),
        audio_forwarding: body.audio_forwarding,
    };
    let login = access::resolve_current_login(&env.dbx, &user)
        .await
        .c(h!())?;
    let device = bl::update(&env.dbx, &login, command).await.c(h!())?;
    if access::require_read(&login.roles).is_ok() {
        let configured =
            crate::devices::audio::forwarding::configured(&env.dbx, device.id)
                .await
                .c(h!())?;
        Ok(HttpResponse::Ok().json(map_device_details(device, configured)))
    } else {
        Ok(HttpResponse::NoContent().finish())
    }
}

fn map_list_sort(sort: DeviceListSortBy) -> DeviceListSort {
    match sort {
        DeviceListSortBy::AorsAsc => DeviceListSort::AorsAsc,
        DeviceListSortBy::AorsDesc => DeviceListSort::AorsDesc,
        DeviceListSortBy::UnitAsc => DeviceListSort::UnitAsc,
        DeviceListSortBy::UnitDesc => DeviceListSort::UnitDesc,
        DeviceListSortBy::CreatedByAsc => DeviceListSort::CreatedByAsc,
        DeviceListSortBy::CreatedByDesc => DeviceListSort::CreatedByDesc,
        DeviceListSortBy::LastContentAtAsc => DeviceListSort::LastContentAtAsc,
        DeviceListSortBy::LastContentAtDesc => {
            DeviceListSort::LastContentAtDesc
        }
        DeviceListSortBy::ContentBytesAsc => DeviceListSort::ContentBytesAsc,
        DeviceListSortBy::ContentBytesDesc => DeviceListSort::ContentBytesDesc,
        DeviceListSortBy::RatingAsc => DeviceListSort::RatingAsc,
        DeviceListSortBy::RatingDesc => DeviceListSort::RatingDesc,
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
