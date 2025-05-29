use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::location::SettlementDetails;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::Utc;
use sea_orm::*;
use serde_json::json;

pub mod types;

pub async fn processed_parsed_settlement_list<'a, 'async_trait, C>(
    settlement_token_txt: String,
    post_id: Option<i64>,
    settlement_vec: Vec<SettlementDetails>,
    txn: &C,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = vec![];
    let mut select = sigint_settlement_token::Entity::find()
        .find_with_related(sigint_settlement::Entity)
        .filter(
            sigint_settlement_token::Column::Content
                .eq(settlement_token_txt.clone()),
        );
    if let Some(post_id) = post_id {
        select =
            select.filter(sigint_settlement_token::Column::PostId.eq(post_id));
    }
    let recs = select
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|(t, s)| (t, s.into_iter().next()))
        .collect::<Vec<_>>();
    if !recs.is_empty() {
        for (settlement_token, settlement) in recs {
            let settlement_nm = match settlement {
                None => settlement_token.parsed_name,
                Some(s) => Some(s.name),
            };
            if let Some(nm) = settlement_nm {
                result.push(nm);
            }
        }
    } else {
        if settlement_vec.is_empty() {
            sigint_settlement_token::ActiveModel {
                id: NotSet,
                updated_by: NotSet,
                updated_at: NotSet,
                created_at: NotSet,
                settlement_id: NotSet,
                post_id: Set(post_id),
                content: Set(settlement_token_txt),
                parsed_name: Set(None),
                lat: Set(None),
                lon: Set(None),
            }
            .insert(txn)
            .await
            .context(h!())?;
        } else {
            for (settlement, m_coords) in settlement_vec {
                result.push(settlement.clone());
                let (lat, lon) = match m_coords {
                    None => (None, None),
                    Some(coords) => (Some(coords.lat), Some(coords.lng)),
                };
                sigint_settlement_token::ActiveModel {
                    id: NotSet,
                    updated_by: NotSet,
                    updated_at: NotSet,
                    created_at: NotSet,
                    settlement_id: NotSet,
                    post_id: Set(post_id),
                    content: Set(settlement_token_txt.clone()),
                    parsed_name: Set(Some(settlement)),
                    lat: Set(lat),
                    lon: Set(lon),
                }
                .insert(txn)
                .await
                .context(h!())?;
            }
        }
    }
    Ok(result)
}

#[post("/api/sigint/settlements")]
pub async fn list_settlements(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListSettlementsReq>,
) -> Result<Json<ListSettlementsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    const LIMIT: u64 = 100000;
    let mut select = sigint_settlement::Entity::find()
        .find_with_related(sigint_settlement_at_post::Entity)
        .filter(sigint_settlement::Column::Deleted.eq(false))
        .limit(LIMIT);
    if let Some(offset) = req.offset {
        select = select.offset(offset);
    }
    select = match req.sorting {
        SettlementSorting::ByCreatedAt => {
            select.order_by_asc(sigint_settlement::Column::Name)
        }
        SettlementSorting::ByName => {
            select.order_by_desc(sigint_settlement::Column::CreatedAt)
        }
    };

    let settlements = select
        .all(&env.dbx)
        .await?
        .into_iter()
        .flat_map(move |(settlement, posts)| {
            render_settlement(&settlement, posts).ok()
        })
        .collect::<Vec<_>>();

    Ok(Json(ListSettlementsRsp {
        show_load_more: settlements.len() as u64 == LIMIT,
        settlements,
    }))
}

pub async fn find_settlement(
    dbx: &DbConn,
    id: i64,
) -> Result<sigint_settlement::Model, AppError> {
    sigint_settlement::Entity::find_by_id(id)
        .filter(sigint_settlement::Column::Deleted.eq(false))
        .one(dbx)
        .await?
        .ok_or(AppError::NotFound)
}

#[post("/api/sigint/settlement/create")]
pub async fn create_settlement(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateSettlementReq>,
) -> Result<Json<i64>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let res = sigint_settlement::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        lat: Set(req.lat),
        lon: Set(req.lng),
        alt_names: Set(json!(req.alternative_names)),
        updated_by: Set(Some(user_id.clone())),
        deleted: NotSet,
        updated_at: NotSet,
        created_at: NotSet,
    }
    .insert(&env.dbx)
    .await?;

    Ok(Json(res.id))
}

#[post("/api/sigint/settlement/update")]
pub async fn update_settlement(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateSettlementReq>,
) -> Result<Json<i64>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let mut settlement: sigint_settlement::ActiveModel =
        find_settlement(&env.dbx, req.id).await?.into();

    settlement.name = Set(req.name.clone());
    settlement.lat = Set(req.lat);
    settlement.lon = Set(req.lng);
    settlement.alt_names = Set(json!(req.alternative_names));
    settlement.id = Set(req.id);
    settlement.updated_by = Set(Some(user_id.clone()));
    settlement.updated_at = Set(Utc::now().naive_utc());

    let res = settlement.update(&env.dbx).await?;

    Ok(Json(res.id))
}

#[post("/api/sigint/settlement/delete")]
pub async fn delete_settlement(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<i64>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;
    let mut settlement: sigint_settlement::ActiveModel =
        find_settlement(&env.dbx, req.0).await?.into();
    settlement.updated_by = Set(Some(user_id.clone()));
    settlement.deleted = Set(true);
    let res_id = settlement.update(&env.dbx).await?.id;
    Ok(Json(res_id))
}

fn render_settlement(
    settlement: &sigint_settlement::Model,
    posts: Vec<sigint_settlement_at_post::Model>,
) -> anyhow::Result<Settlement> {
    let post_ids = posts
        .into_iter()
        .flat_map(|p| p.post_id)
        .collect::<Vec<_>>();
    let alternative_names =
        serde_json::from_value(settlement.alt_names.clone()).context(h!())?;
    let result = Settlement {
        alternative_names,
        post_ids,
        id: settlement.id,
        name: settlement.name.clone(),
        lat: settlement.lat,
        lng: settlement.lon,
        created_at: settlement.created_at.and_utc().timestamp_millis(),
    };
    Ok(result)
}
