use self::types::*;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::users::{ensure_basic_role, has_role, login_id_from_identity};
use crate::{config, h};
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
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
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
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    let is_admin = has_role(&env.dbx, &login_id_from_identity(&user)?, "Admin")
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
                datasource_group::Column::GroupMasterKey.eq_any(
                    crate::messenger::group::get_identity_sigint_groups(
                        &env.dbx,
                        &login_id_from_identity(&user)?,
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
            Ok(_) => info!("set default_aor_id for datasource {id}"),
            Err(e) => error!(
                "failed to set default_aor_id for datasource {id}: {:?}",
                e
            ),
        }
    }
    Ok(())
}

pub async fn oneoff_disable_im(mode: Mode) -> Result<(), AppError> {
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    disable_im_datasources(&dbx, "oneoff-disable-im").await?;
    Ok(())
}

pub async fn oneoff_disable_im_and_goi(mode: Mode) -> Result<(), AppError> {
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    disable_im_datasources(&dbx, "oneoff-disable-im-and-goi").await?;
    disable_goi_integrations(&dbx).await?;
    Ok(())
}

async fn disable_im_datasources(
    db: &DatabaseConnection,
    command: &str,
) -> Result<(), AppError> {
    info!("{command} disable_im_datasources started");
    datasource::Entity::update_many()
        .set(datasource::ActiveModel {
            status: Set(AccountStatus::Paused),
            echo_client_lock_id: Set(None),
            ..Default::default()
        })
        .col_expr(
            datasource::Column::Description,
            Expr::cust(format!(
                "coalesce(description,'') \
                 || ' | disabled by {command}' \
                 || ' | lock id = ' \
                 || coalesce(echo_client_lock_id::text,'')"
            )),
        )
        .filter(datasource::Column::Status.eq(AccountStatus::Active))
        .exec(db)
        .await
        .context(h!())?;

    echo_client_lock::Entity::delete_many()
        .exec(db)
        .await
        .context(h!())?;

    echo_account::Entity::update_many()
        .set(echo_account::ActiveModel {
            is_linked: Set(false),
            ..Default::default()
        })
        .filter(echo_account::Column::IsLinked.eq(true))
        .exec(db)
        .await
        .context(h!())?;

    info!("{command} disable_im_datasources completed");

    Ok(())
}

async fn disable_goi_integrations(
    db: &DatabaseConnection,
) -> Result<(), AppError> {
    info!("oneoff-disable-im-and-goi disable_goi_integrations started");
    goi_integration::Entity::update_many()
        .set(goi_integration::ActiveModel {
            ssh_user: Set(None),
            api_login: Set(None),
            api_password: Set(None),
            ..Default::default()
        })
        .exec(db)
        .await
        .context(h!())?;
    info!("oneoff-disable-im-and-goi disable_goi_integrations completed");

    Ok(())
}
