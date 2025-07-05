use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::prelude::*;
use sea_orm::*;
use sea_query::Expr;

pub mod types;

#[post("/api/datasources/list")]
pub async fn list_datasources(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<(i64, Datasource)>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Basic").await?;
    let datasources = datasource::Entity::find()
        // .filter(datasource::Column::Enabled.eq(true))
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for datasource in datasources {
        res.push((
            datasource.id,
            Datasource {
                kind: datasource.kind.clone(),
                display_name: datasource.display_name.clone(),
                signal_phone: datasource.signal_phone.clone(),
                enabled: datasource.enabled.clone(),
            },
        ));
    }
    Ok(Json(res))
}

#[post("/api/datasources/group-list")]
pub async fn datasource_group_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
    req: Json<i64>,
) -> Result<Json<Vec<String>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Basic").await?;
    let datasource_id: i64 = req.into_inner().clone();
    let datasource = datasource::Entity::find_by_id(datasource_id)
        .one(&env.dbx)
        .await?
        .ok_or(AppError::NotFound)?;

    if datasource.kind == "signal" || datasource.kind == "whatsapp" {
        let now = Utc::now();
        let res = signal_message::Entity::find()
            .select_only()
            .column(signal_message::Column::GroupMasterKey)
            .filter(
                signal_message::Column::CreatedAt
                    .gte(now - chrono::Duration::days(7)),
            )
            .filter(
                signal_message::Column::GroupMasterKey.is_in(
                    crate::users::get_identity_sigint_groups(
                        &env.dbx,
                        &user.id()?,
                    )
                    .await
                    .context(h!())?,
                ),
            )
            .filter(signal_message::Column::DatasourceId.eq(datasource_id))
            .filter(signal_message::Column::Deleted.eq(false))
            .into_tuple::<String>()
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .unique()
            .collect_vec();
        return Ok(Json(res));
    } else if datasource.kind == "api" {
        let datasource = datasource::Entity::find_by_id(datasource_id)
            .one(&env.dbx)
            .await?
            .ok_or(AppError::NotFound)?;
        let group_master_key =
            datasource.group_master_key.ok_or(AppError::BL {
                msg: format!(
                "The group_master_key field mut be set for datasource id={}",
                datasource.id
            ),
            })?;
        return Ok(Json(vec![group_master_key]));
    }
    Err("impossible 7263582".into())
}
