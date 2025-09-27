use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::prelude::*;
use sea_orm::*;
use sea_query::Expr;

pub(crate) mod importer;
pub mod types;

#[post("/api/datasources/list")]
pub async fn list_datasources(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<(i64, Datasource)>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let datasources = datasource::Entity::find()
        // .filter(datasource::Column::Enabled.eq(true))
        .all(&env.dbx)
        .await
        .c(h!())?;
    let mut res = vec![];
    for datasource in datasources {
        res.push((
            datasource.id,
            Datasource {
                kind: datasource.kind.clone(),
                display_name: datasource.display_name.clone(),
                signal_phone: datasource.signal_phone.clone(),
                enabled: datasource.enabled,
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Basic")
        .await
        .c(h!())?;
    let is_admin =
        crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
            .await
            .is_ok();
    let datasource_id: i64 = req.into_inner();
    let datasource = datasource::Entity::find_by_id(datasource_id)
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    if datasource.kind == "signal"
        || datasource.kind == "whatsapp"
        || datasource.kind == "echo_operator"
    {
        let now = Utc::now();
        let mut select = signal_message::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .select_only()
            .column(datasource_group::Column::GroupMasterKey)
            .filter(
                signal_message::Column::CreatedAt
                    .gte(now - chrono::Duration::days(7)),
            )
            .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
            .filter(signal_message::Column::Deleted.eq(false));
        if !is_admin {
            select = select.filter(
                datasource_group::Column::GroupMasterKey.is_in(
                    crate::messenger::group::get_identity_sigint_groups(
                        &env.dbx,
                        &user.id().c(h!())?,
                    )
                    .await
                    .c(h!())?,
                ),
            );
        }
        let res = select
            .group_by(Expr::cust("1"))
            .into_tuple::<Option<String>>()
            .all(&env.dbx)
            .await
            .c(h!())?;
        if res.iter().any(|x| x.is_none()) {
            warn!(
                "Found null group_master_key list for datasource id={datasource_id}"
            );
        }
        return Ok(Json(res.into_iter().flatten().collect()));
    } else if datasource.kind == "api" {
        let datasource = datasource::Entity::find_by_id(datasource_id)
            .one(&env.dbx)
            .await
            .c(h!())?
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

/// Ensure each datasource has `default_aor_id` set. If missing, use the global default AOR.
pub async fn fix_datasource_default_aor(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    let default_aor = crate::sigint::aor::load_default_aor(db).await.c(h!())?;

    let datasources = datasource::Entity::find()
        .filter(datasource::Column::DefaultAorId.is_null())
        .all(db)
        .await
        .c(h!())?;

    for datasource in datasources {
        let id = datasource.id;
        let mut datasource = datasource.into_active_model();
        datasource.default_aor_id = Set(Some(default_aor.id));
        match datasource.update(db).await.c(h!()) {
            Ok(_) => log::info!("set default_aor_id for datasource {id}"),
            Err(e) => log::error!(
                "failed to set default_aor_id for datasource {id}: {e:?}"
            ),
        }
    }
    Ok(())
}
