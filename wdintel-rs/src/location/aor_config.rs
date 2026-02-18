use crate::entities::{aor_location_config, area_of_responsibility};
use crate::location::types::{
    AorLocationConfigItem, ListAorLocationConfigRsp, SaveAorLocationConfigReq,
};
use crate::location::SettlementsData;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::{ActiveValue::Set, *};

fn pick_settlements_data(
    settlements_data_by_config: &HashMap<String, Arc<SettlementsData>>,
    default_settlements_data: Arc<SettlementsData>,
    config_name: &str,
) -> Arc<SettlementsData> {
    settlements_data_by_config
        .get(config_name)
        .cloned()
        .unwrap_or(default_settlements_data)
}

pub async fn init_aor_location_config(
    dbx: &DatabaseConnection,
    settlements: Arc<RwLock<crate::location::types::SettlementsDataConfig>>,
) -> anyhow::Result<()> {
    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;

    let available_configs = {
        let settlements_lock =
            settlements.read().map_err(|e| anyhow!("{e:?}")).c(h!())?;
        settlements_lock.available_settlements_configs.clone()
    };
    let default_config = available_configs
        .first()
        .cloned()
        .unwrap_or_else(String::new);

    if default_config.is_empty() {
        return Ok(());
    }

    for aor in aors {
        let exists = aor_location_config::Entity::find()
            .filter(aor_location_config::Column::AorId.eq(aor.id))
            .one(dbx)
            .await
            .c(h!())?
            .is_some();
        if !exists {
            aor_location_config::ActiveModel {
                id: NotSet,
                aor_id: Set(aor.id),
                settlements_config: Set(default_config.clone()),
                created_at: NotSet,
                updated_at: NotSet,
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
    }

    refresh_settlements_aor_map(dbx, settlements)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn refresh_settlements_aor_map(
    dbx: &DatabaseConnection,
    settlements: Arc<RwLock<crate::location::types::SettlementsDataConfig>>,
) -> anyhow::Result<()> {
    let rows = aor_location_config::Entity::find().all(dbx).await.c(h!())?;

    let mut settlements_lock =
        settlements.write().map_err(|e| anyhow!("{e:?}")).c(h!())?;
    settlements_lock.aor_id_to_settlements_data.clear();
    settlements_lock.aor_id_to_config_name.clear();

    for row in rows {
        let settlements_data = pick_settlements_data(
            &settlements_lock.settlements_data_by_config,
            settlements_lock.default_settlements_data.clone(),
            &row.settlements_config,
        );
        settlements_lock
            .aor_id_to_settlements_data
            .insert(row.aor_id, settlements_data);
        settlements_lock
            .aor_id_to_config_name
            .insert(row.aor_id, row.settlements_config);
    }
    Ok(())
}

#[post("/api/admin/location-config/list")]
pub async fn list_aor_location_configs(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<ListAorLocationConfigRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let rows = aor_location_config::Entity::find()
        .all(&env.dbx)
        .await
        .c(h!())?;
    let row_by_aor_id = rows
        .into_iter()
        .map(|r| (r.aor_id, r))
        .collect::<HashMap<_, _>>();

    let aors = area_of_responsibility::Entity::find()
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .order_by_asc(area_of_responsibility::Column::Name)
        .all(&env.dbx)
        .await
        .c(h!())?;

    let settlements_lock = env
        .settlements
        .read()
        .map_err(|e| AppError::from(format!("{e:?}")))
        .c(h!())?;
    let default_config = settlements_lock
        .available_settlements_configs
        .first()
        .cloned();

    let items = aors
        .into_iter()
        .map(|aor| {
            let selected_config = row_by_aor_id
                .get(&aor.id)
                .map(|row| row.settlements_config.clone())
                .or_else(|| default_config.clone());
            AorLocationConfigItem {
                aor_id: aor.id,
                aor_name: aor.name,
                selected_config,
            }
        })
        .collect_vec();

    Ok(Json(ListAorLocationConfigRsp {
        available_configs: settlements_lock
            .available_settlements_configs
            .clone(),
        items,
    }))
}

#[post("/api/admin/location-config/save")]
pub async fn save_aor_location_config(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SaveAorLocationConfigReq>,
) -> Result<Json<AorLocationConfigItem>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let req = req.into_inner();

    {
        let settlements_lock = env
            .settlements
            .read()
            .map_err(|e| AppError::from(format!("{e:?}")))
            .c(h!())?;
        if !settlements_lock
            .available_settlements_configs
            .contains(&req.settlements_config)
        {
            return Err(AppError::BL {
                msg: format!(
                    "unknown settlements config: {}",
                    req.settlements_config
                ),
            });
        }
    }

    let aor = area_of_responsibility::Entity::find_by_id(req.aor_id)
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .c(h!())?;

    let existing = aor_location_config::Entity::find()
        .filter(aor_location_config::Column::AorId.eq(req.aor_id))
        .one(&env.dbx)
        .await
        .c(h!())?;

    match existing {
        Some(rec) => {
            let mut rec = rec.into_active_model();
            rec.settlements_config = Set(req.settlements_config.clone());
            rec.updated_at = NotSet;
            rec.update(&env.dbx).await.c(h!())?;
        }
        None => {
            aor_location_config::ActiveModel {
                id: NotSet,
                aor_id: Set(req.aor_id),
                settlements_config: Set(req.settlements_config.clone()),
                created_at: NotSet,
                updated_at: NotSet,
            }
            .insert(&env.dbx)
            .await
            .c(h!())?;
        }
    }

    refresh_settlements_aor_map(&env.dbx, env.settlements.clone())
        .await
        .c(h!())?;

    Ok(Json(AorLocationConfigItem {
        aor_id: aor.id,
        aor_name: aor.name,
        selected_config: Some(req.settlements_config),
    }))
}
