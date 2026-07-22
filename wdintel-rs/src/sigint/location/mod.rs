use self::types::{LocationSearchReq, LocationSearchRsp};
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;

pub mod query;
pub mod types;

#[post("/api/sigint/location/search")]
pub async fn location_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<LocationSearchReq>,
) -> Result<Json<LocationSearchRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Rer"])
        .await
        .c(h!())?;

    let locations = query::search(&env.dbx, req.search.trim()).await.c(h!())?;

    Ok(Json(LocationSearchRsp { locations }))
}
