use super::access::management_scope;
use crate::entities::login;
use crate::h;
use crate::types::{AppError, Context, Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct SetOrganismMessageStatsExclusionReq {
    pub organism_id: i64,
    pub login_id: String,
    pub excluded: bool,
}

#[post("/api/organism/message-stats-exclusion")]
pub async fn set_exclusion(
    user: Identity,
    env: Data<Env>,
    req: Json<SetOrganismMessageStatsExclusionReq>,
) -> Result<Json<()>, AppError> {
    management_scope(&env.dbx, &user)
        .await
        .c(h!())?
        .ensure_organism(req.organism_id)
        .c(h!())?;
    let id = uuid::Uuid::parse_str(&req.login_id).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let login = login::Entity::find_by_id(id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    if login.organism_id != Some(req.organism_id) {
        return Err(AppError::Forbidden(
            "Доступ лише до користувачів вказаного організму".into(),
        ));
    }
    if req.excluded {
        txn.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"insert into organism_message_stats_exclusion(login_id,organism_id) values ($1,$2)
            on conflict(login_id) do update set organism_id=excluded.organism_id"#,
            [id.into(), req.organism_id.into()])).await.c(h!())?;
    } else {
        txn.execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "delete from organism_message_stats_exclusion where login_id=$1",
            [id.into()],
        ))
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}
