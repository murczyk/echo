use crate::entities::{datasource, echo_client_lock};
use crate::error::AppError;
use crate::h;
use crate::types::{Deserialize, Env, Serialize, ShortContext};
use actix_web::post;
use actix_web::web::Json;
use anyhow::Context;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use xshell::{cmd, Shell};

#[post("/api/admin/restart-datasource")]
pub async fn restart_datasource(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i32>,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let datasource_id = req.into_inner();
    let client_id = datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            datasource::Relation::EchoClientLock.def(),
        )
        .filter(datasource::Column::Id.eq(datasource_id))
        .select_only()
        .column(echo_client_lock::Column::ClientId)
        .into_tuple::<i32>()
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;
    echo_im::restart_client(&env.dbx, client_id).await.c(h!())?;
    Ok(Json(true))
}

#[post("/api/admin/restart-echo")]
pub async fn restart_echo(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<RestartEchoRequest>,
) -> Result<Json<bool>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;
    let req = req.into_inner();
    let mut args = Vec::new();
    if req.restart_postgres.unwrap_or(false) {
        args.push("--restart-postgres");
    }
    if req.restart_outdated_sources.unwrap_or(false) {
        args.push("--restart-messengers");
    }
    let sh = Shell::new().c(h!())?;
    cmd!(
        sh,
        "sudo wdintel-rs --mode live oneoff-restart-echo {args...}"
    )
    .run()
    .context(h!())?;
    Ok(Json(true))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RestartEchoRequest {
    pub restart_postgres: Option<bool>,
    pub restart_outdated_sources: Option<bool>,
}
