use super::{access, types::*};
use crate::{
    devices::devices::query::{visible_devices_query, DeviceReadScope},
    entities::{device, device_aor},
    error::AppError,
    h,
    types::{Env, ShortContext},
};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use uuid::Uuid;

#[post("/api/device/ai/search")]
pub(crate) async fn search(
    env: Data<Env>,
    user: Identity,
    req: Json<AgentDeviceSearchReq>,
) -> Result<Json<AgentDeviceSearchRsp>, AppError> {
    if req.aor_ids.as_ref().is_some_and(|ids| ids.len() > 128)
        || req.unit_ids.as_ref().is_some_and(|ids| ids.len() > 128)
    {
        return Err(AppError::BL {
            msg: "Забагато фільтрів".into(),
        });
    }
    let login = access::reader(
        &env,
        crate::users::login_id_from_identity(&user).c(h!())?,
    )
    .await
    .c(h!())?;
    let mut query = visible_devices_query(
        &login,
        if req.include_archived.unwrap_or(false) {
            DeviceReadScope::IncludeArchived
        } else {
            DeviceReadScope::ActiveOnly
        },
    )
    .c(h!())?;
    if let Some(text) = &req.query {
        super::search::check_text(text).c(h!())?;
        use sea_orm::sea_query::Expr;
        query=query.filter(Condition::any().add(Expr::cust_with_values("name ilike $1 escape '\\' or tags::text ilike $1 escape '\\' or custom_fields::text ilike $1 escape '\\'",[format!("%{}%",super::search::literal(text))])));
    }
    if let Some(ids) = &req.aor_ids {
        query = query.filter(
            device::Column::Id.in_subquery(
                device_aor::Entity::find()
                    .select_only()
                    .column(device_aor::Column::DeviceId)
                    .filter(device_aor::Column::AorId.is_in(ids.clone()))
                    .into_query(),
            ),
        );
    }
    if let Some(ids) = &req.unit_ids {
        query = query.filter(device::Column::UnitId.is_in(ids.clone()));
    }
    if let Some(cursor) = &req.cursor {
        query = query
            .filter(device::Column::Id.gt(Uuid::parse_str(cursor).c(h!())?));
    }
    let limit = req.limit.unwrap_or(20).clamp(1, 50);
    let mut devices = query
        .order_by_asc(device::Column::Id)
        .limit(limit + 1)
        .all(&env.dbx)
        .await
        .c(h!())?;
    let more = devices.len() > limit as usize;
    devices.truncate(limit as usize);
    let ids = devices.iter().map(|d| d.id).collect::<Vec<_>>();
    let aors = device_aor::Entity::find()
        .filter(device_aor::Column::DeviceId.is_in(ids))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let next_cursor = more.then(|| devices.last().unwrap().id.to_string());
    Ok(Json(AgentDeviceSearchRsp {
        devices: devices
            .into_iter()
            .map(|d| AgentDeviceItem {
                id: d.id.to_string(),
                name: d.name,
                archived: d.archived,
                unit_id: d.unit_id,
                aor_ids: aors
                    .iter()
                    .filter(|a| a.device_id == d.id)
                    .map(|a| a.aor_id)
                    .collect(),
            })
            .collect(),
        next_cursor,
    }))
}

use sea_orm::QueryTrait;
