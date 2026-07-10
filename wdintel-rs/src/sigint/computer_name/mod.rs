use self::types::{
    ComputerNameSearchReq, ComputerNameSearchRsp, CreateComputerNameReq,
    CreateComputerNameRsp,
};
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;

pub mod bl;
pub mod query;
pub mod types;

#[post("/api/sigint/computer-name/create")]
pub async fn computer_name_create(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateComputerNameReq>,
) -> Result<Json<CreateComputerNameRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Rer"])
        .await
        .c(h!())?;

    let rsp = bl::create_computer_name(&env.dbx, login, req.into_inner())
        .await
        .c(h!())?;

    Ok(Json(rsp))
}

#[post("/api/sigint/computer-name/search")]
pub async fn computer_name_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ComputerNameSearchReq>,
) -> Result<Json<ComputerNameSearchRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Rer"])
        .await
        .c(h!())?;

    let rsp = bl::search_computer_names(&env.dbx, req.into_inner())
        .await
        .c(h!())?;

    Ok(Json(rsp))
}
