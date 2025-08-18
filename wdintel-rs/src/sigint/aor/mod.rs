use self::types::*;
use crate::entities::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::{Data, Json};
use milgeo_rs::coord_util::LatLng;
use milgeo_rs::MilGeo;
use sea_orm::*;

pub mod bl;
pub mod types;
pub mod worker;

#[post("/api/sigint/aor")]
pub async fn aor_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<ListAreasOfResponsibilityReq>,
) -> Result<Json<Vec<AreaOfResponsibility>>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id()?,
        vec!["Admin", "UnitsEditor"],
    )
    .await
    .context(h!())?;

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
        )
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(render_aor)
        .collect::<Vec<AreaOfResponsibility>>();
    Ok(Json(aors))
}

#[post("/api/sigint/aor/create")]
pub async fn create_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<AreaOfResponsibilityInsert>,
) -> Result<Json<AreaOfResponsibility>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin")
        .await
        .context(h!())?;
    let model = map_insert(&env, &req, NotSet).await?;
    let aor = model.insert(&env.dbx).await.context(h!())?;
    Ok(Json(render_aor(aor)))
}

#[post("/api/sigint/aor/update")]
pub async fn update_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UpdateAreaOfResponsibilityReq>,
) -> Result<Json<AreaOfResponsibility>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin")
        .await
        .context(h!())?;

    let model = map_insert(&env, &req.insert, Set(req.id)).await?;
    let aor = model.update(&env.dbx).await.context(h!())?;
    Ok(Json(render_aor(aor)))
}

#[post("/api/sigint/aor/delete")]
pub async fn delete_aor(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteAreaOfResponsibilityReq>,
) -> Result<Json<()>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Admin")
        .await
        .context(h!())?;

    let aor_obj = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Id.eq(req.id))
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let mut aor_model = aor_obj.into_active_model();
    aor_model.deleted = Set(true);
    aor_model.update(&env.dbx).await.context(h!())?;
    Ok(Json(()))
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
        .context(h!())?;

    default_aor.context("No default AOR found").context(h!())
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
            .context(h!())?
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
                    .context(h!())?;
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
            .context(h!())?
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
            .context(h!())?;

    let (right_lat, right_lon, right_settlement) =
        from_coordinates(req.right_coordinates.clone(), &env.mil_geo)
            .await
            .context(h!())?;

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
        updated_by: NotSet,
        updated_at: NotSet,
        created_at: NotSet,
        deleted: Set(false),
        is_top_level: Set(req.is_top_level),
        is_default: NotSet,
    };
    Ok(model)
}
