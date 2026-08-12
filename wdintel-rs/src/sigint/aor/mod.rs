use self::types::*;
use crate::entities::*;
use crate::types::*;
use crate::users::{ensure_admin, has_any_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::{Data, Json};
use milgeo_rs::coord_util::LatLng;
use milgeo_rs::MilGeo;
use sea_orm::*;
use std::collections::BTreeMap;

pub mod bl;
pub mod report_order;
pub mod types;
pub mod worker;

#[post("/api/sigint/aor")]
pub async fn aor_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ListAreasOfResponsibilityReq>,
) -> Result<Json<Vec<AreaOfResponsibility>>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Admin", "UnitsEditor", "Rer", "Api"],
    )
    .await?;

    Ok(Json(read_aors(&env.dbx, &req).await?))
}

pub(crate) async fn read_aors(
    dbx: &DatabaseConnection,
    req: &ListAreasOfResponsibilityReq,
) -> Result<Vec<AreaOfResponsibility>, AppError> {
    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by(
            area_of_responsibility::Column::Name,
            if let Some(sort_by) = &req.sort_by {
                match sort_by {
                    ListAreasOfResponsibilitySortBy::AreaOfResponsibilityNameDesc => Order::Desc,
                    ListAreasOfResponsibilitySortBy::AreaOfResponsibilityNameAsc => Order::Asc,
                }
            } else {
                Order::Desc
            },
        );
    Ok(aors
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_aor)
        .collect())
}

#[post("/api/sigint/aor/create")]
pub async fn create_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<AreaOfResponsibilityInsert>,
) -> Result<Json<AreaOfResponsibility>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let model = map_insert(&env, &req, NotSet).await.c(h!())?;
    let aor = model.insert(&env.dbx).await.c(h!())?;
    Ok(Json(render_aor(aor)))
}

#[post("/api/sigint/aor/update")]
pub async fn update_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateAreaOfResponsibilityReq>,
) -> Result<Json<AreaOfResponsibility>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    let model = map_insert(&env, &req.insert, Set(req.id)).await.c(h!())?;
    let aor = model.update(&env.dbx).await.c(h!())?;
    crate::sigint::network::etalon_calc::invalidate_network_inbox_for_aor(
        &env.dbx,
        &aor,
        format!("edit AOR from web UI: {}", aor.name),
    )
    .await
    .c(h!())?;
    Ok(Json(render_aor(aor)))
}

#[post("/api/sigint/aor/delete")]
pub async fn delete_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteAreaOfResponsibilityReq>,
) -> Result<Json<()>, AppError> {
    ensure_admin(&env.dbx, &user).await.c(h!())?;

    let aor_obj = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.eq(req.id))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut aor_model = aor_obj.into_active_model();
    aor_model.deleted = Set(true);
    let aor = aor_model.update(&env.dbx).await.c(h!())?;
    crate::sigint::network::etalon_calc::invalidate_network_inbox_for_aor(
        &env.dbx,
        &aor,
        format!("delete AOR from web UI: {}", aor.name),
    )
    .await
    .c(h!())?;
    Ok(Json(()))
}

#[post("/api/sigint/aor/update-report-order")]
pub async fn update_aor_report_order(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateAreaOfResponsibilityReportOrderReq>,
) -> Result<Json<Vec<AreaOfResponsibility>>, AppError> {
    has_any_role(
        &env.dbx,
        &login_id_from_identity(&user)?,
        vec!["Admin", "Rer"],
    )
    .await
    .c(h!())?;
    ensure_admin(&env.dbx, &user).await.c(h!())?;
    let user_id = login_id_from_identity(&user)?;

    let items = req
        .items
        .iter()
        .map(|item| report_order::AorReportOrderUpdate {
            aor_id: item.id,
            order_for_report: item.order_for_report,
        })
        .collect::<Vec<_>>();
    let rows =
        report_order::update_report_order(&env.dbx, &user_id, None, &items)
            .await
            .c(h!())?;

    let order_by_id = rows
        .into_iter()
        .map(|row| (row.aor_id, row.order_for_report))
        .collect::<BTreeMap<_, _>>();
    let mut updated_aors = area_of_responsibility::Entity::find()
        .filter(
            area_of_responsibility::Column::Id
                .is_in(order_by_id.keys().copied().collect::<Vec<_>>()),
        )
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_aor)
        .map(|mut aor| {
            if let Some(order_for_report) = order_by_id.get(&aor.id) {
                aor.order_for_report = *order_for_report;
            }
            aor
        })
        .collect::<Vec<_>>();
    updated_aors.sort_by(|left, right| {
        left.order_for_report
            .total_cmp(&right.order_for_report)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(Json(updated_aors))
}

pub async fn load_default_aor<'a, 'async_trait, C>(
    txn: &'a C,
) -> anyhow::Result<area_of_responsibility::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    let default_aor = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .filter(area_of_responsibility::Column::IsDefault.eq(true))
        .one(txn)
        .await
        .c(h!())?;

    default_aor.c("No default AOR found").c(h!())
}

/// Get aor id from db by aor name
pub async fn get_aor_id<'a, 'async_trait, C>(
    txn: &'a C,
    aor_name: &Option<String>,
) -> Result<Option<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if let Some(aor_name) = aor_name {
        let aor_name = aor_name.trim().to_uppercase();
        if aor_name.is_empty() {
            return Ok(None);
        }

        let aor_id = area_of_responsibility::Entity::find()
            .filter(area_of_responsibility::Column::Name.eq(aor_name))
            .one(txn)
            .await
            .c(h!())?
            .map(|aor| aor.id);

        return Ok(aor_id);
    }
    Ok(None)
}

pub fn render_aor(aor: area_of_responsibility::Model) -> AreaOfResponsibility {
    let left_coordinates =
        match (aor.left_lat, aor.left_lon, aor.left_settlement) {
            (Some(latitude), Some(longitude), settlement) => {
                Some(AorCoordinates {
                    latitude,
                    longitude,
                    settlement,
                })
            }
            _ => None,
        };
    let right_coordinates =
        match (aor.right_lat, aor.right_lon, aor.right_settlement) {
            (Some(latitude), Some(longitude), settlement) => {
                Some(AorCoordinates {
                    latitude,
                    longitude,
                    settlement,
                })
            }
            _ => None,
        };

    AreaOfResponsibility {
        id: aor.id,
        name: aor.name,
        description: aor.description,
        left_bound: aor.left_bound,
        right_bound: aor.right_bound,
        created_at: aor.created_at.and_utc().timestamp_millis(),
        is_top_level: aor.is_top_level,
        order_for_report: aor.order_for_report_legacy,
        left_coordinates,
        right_coordinates,
    }
}

async fn from_coordinates(
    coordinates: Option<AorCoordinates>,
    mil_geo: &MilGeo,
) -> Result<(Option<f64>, Option<f64>, Option<String>), AppError> {
    Ok(match coordinates.clone() {
        Some(coords) => {
            let m_settlement =
                find_settlement(mil_geo, coords.latitude, coords.longitude)
                    .await
                    .c(h!())?;
            (Some(coords.latitude), Some(coords.longitude), m_settlement)
        }
        None => (None, None, None),
    })
}

async fn find_settlement(
    mil_geo: &MilGeo,
    lat: f64,
    lng: f64,
) -> anyhow::Result<Option<String>> {
    let mut coords = BTreeMap::new();
    coords.insert(1, LatLng { lat, lng });
    let settlement_name =
        milgeo_rs::coord_util::map_coords(coords.clone(), mil_geo.clone(), 3)
            .await
            .c(h!())?
            .get(&1)
            .and_then(|l| l.iter().next())
            .cloned()
            .map(|x| x.settlement_name);
    Ok(settlement_name)
}

async fn map_insert(
    env: &Data<Env>,
    req: &AreaOfResponsibilityInsert,
    id: ActiveValue<i64>,
) -> Result<area_of_responsibility::ActiveModel, AppError> {
    let (left_lat, left_lon, left_settlement) =
        from_coordinates(req.left_coordinates.clone(), &env.mil_geo)
            .await
            .c(h!())?;

    let (right_lat, right_lon, right_settlement) =
        from_coordinates(req.right_coordinates.clone(), &env.mil_geo)
            .await
            .c(h!())?;

    let model = area_of_responsibility::ActiveModel {
        id,
        name: Set(req.name.clone()),
        description: Set(req.description.clone()),
        left_bound: Set(req.left_bound),
        right_bound: Set(req.right_bound),
        left_lat: Set(left_lat),
        left_lon: Set(left_lon),
        right_lat: Set(right_lat),
        right_lon: Set(right_lon),
        left_settlement: Set(left_settlement),
        right_settlement: Set(right_settlement),
        updated_by_login_id: NotSet,
        updated_at: NotSet,
        created_at: NotSet,
        deleted: Set(false),
        is_top_level: Set(req.is_top_level),
        order_for_report_legacy: NotSet,
        is_default: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    };
    Ok(model)
}
