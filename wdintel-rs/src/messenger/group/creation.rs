use super::types::GroupCreationInfo;
use crate::entities::{login, signal_group};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};

#[post("/api/messenger/group-creation-info")]
pub async fn get(
    env: Data<Env>,
    user: Identity,
    master_key: Json<String>,
) -> Result<Json<GroupCreationInfo>, AppError> {
    crate::users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(read(&env.dbx, &master_key).await.c(h!())?))
}

pub async fn read<C: ConnectionTrait>(
    dbx: &C,
    master_key: &str,
) -> anyhow::Result<GroupCreationInfo> {
    let group = signal_group::Entity::find_by_id(master_key)
        .filter(signal_group::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    let creator = match group.created_by_login_id {
        Some(id) => login::Entity::find_by_id(id).one(dbx).await.c(h!())?,
        None => None,
    };
    Ok(GroupCreationInfo {
        created_at: group.created_at.and_utc().timestamp_millis(),
        created_by: creator.map(|creator| creator.login),
    })
}
