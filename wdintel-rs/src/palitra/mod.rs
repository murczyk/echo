use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::palitra::types::*;
use crate::types::*;
use crate::utils::multipart;
use actix_multipart::Multipart;
use actix_web::post;
use actix_web::web::{Data, Json};
use anyhow::Context;
use log::info;
use sea_orm::*;

mod bl;
mod kmz;
mod types;

#[post("/api/palitra/upload-points/{palitra_id}")]
pub async fn upload_palitra_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
    mut payload: Multipart,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let palitra_id = path.into_inner();
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let palitra_access_organisms =
        bl::collect_palitra_access_organisms(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    let palitra_access_logins =
        bl::collect_palitra_access_logins(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    check_palitra_permissions(
        &env,
        &login,
        &palitra_access_logins,
        &palitra_access_organisms,
    )
    .await
    .c(h!())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;
    let filename = field.name().c(h!())?.to_string();
    let points = kmz::load_coordinates_from_file(filename.clone(), val)
        .await
        .c(h!())?;
    let txn = (env.dbx).begin().await.c(h!())?;

    let palitra_id = palitra.id;
    let mut model = palitra.into_active_model();
    model.source_file_name = Set(Some(filename));
    model.update(&env.dbx).await.c(h!())?;

    bl::rewrite_palitra_points(palitra_id, points, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

#[post("/api/palitra/list")]
pub async fn list_all_palitras(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<Palitra>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras(login, &env.dbx).await.context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/list-detailed")] // TODO implement filter
pub async fn list_all_palitras_detailed(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<Vec<PalitraDetails>>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .context(h!())?;
    let palitra = bl::list_all_palitras_detailed(login, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/create")]
pub async fn create_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
) -> Result<Json<Palitra>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    check_palitra_permissions(
        &env,
        &login,
        &req.access_logins,
        &req.access_organism_ids,
    )
    .await
    .c(h!())?;
    let palitra = bl::create_palitra(login, req, &env.dbx)
        .await
        .context(h!())?;
    Ok(Json(palitra))
}

#[post("/api/palitra/update/{palitra_id}")]
pub async fn update_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreatePalitraReq>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<PalitraDetails>, AppError> {
    let login = user.id().c(h!())?;
    let req = req.into_inner();
    check_palitra_permissions(
        &env,
        &login,
        &req.access_logins,
        &req.access_organism_ids,
    )
    .await
    .c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;

    let palitra_access_organisms =
        bl::collect_palitra_access_organisms(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    let palitra_access_logins =
        bl::collect_palitra_access_logins(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    check_palitra_permissions(
        &env,
        &login,
        &palitra_access_logins,
        &palitra_access_organisms,
    )
    .await
    .c(h!())?;
    let result = bl::update_palitra(palitra.id, req, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(result))
}

#[post("/api/palitra/delete/{palitra_id}")]
pub async fn delete_palitra(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    path: actix_web::web::Path<i64>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let palitra_id = path.into_inner();
    let txn = (env.dbx).begin().await.c(h!())?;
    let palitra = palitra::Entity::find_by_id(palitra_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let palitra_access_organisms =
        bl::collect_palitra_access_organisms(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    let palitra_access_logins =
        bl::collect_palitra_access_logins(&env.dbx, palitra_id)
            .await
            .c(h!())?;
    check_palitra_permissions(
        &env,
        &login,
        &palitra_access_logins,
        &palitra_access_organisms,
    )
    .await
    .c(h!())?;
    bl::delete_palitra(palitra.id, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

async fn check_palitra_permissions(
    env: &Data<Env>,
    login: &str,
    owner_logins: &Vec<String>,
    owner_organism_ids: &Vec<i64>,
) -> anyhow::Result<()> {
    let roles = if !owner_logins.is_empty() {
        info!("User {login} requested to create private palitra");
        vec!["Rer"]
    } else if !owner_organism_ids.is_empty() {
        info!(
            "User {login} requested to create private palitra for his organism"
        );
        if !owner_logins.contains(&login.to_string()) {
            bail!("Requested by '{login}', but this login is mising in provided list of permitted logins: {owner_logins:?}");
        }
        vec!["Rer"]
    } else {
        info!("User {login} requested to create global palitra");
        vec!["UnitsEditor", "CallsignsEditor", "Admin"]
    };
    crate::users::has_any_role(&env.dbx, login, roles)
        .await
        .context(h!())?;
    Ok(())
}
