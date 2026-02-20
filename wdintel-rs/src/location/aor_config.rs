use crate::entities::{aor_location_config, area_of_responsibility};
use crate::location::types::{
    AorLocationConfigItem, ListAorLocationConfigRsp, SaveAorLocationConfigReq,
};
use crate::location::SettlementsData;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::{ActiveValue::Set, *};

fn parse_selected_configs(row: &aor_location_config::Model) -> Vec<String> {
    row.settlements_configs
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect_vec()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or(vec![])
}

fn normalize_selected_configs(
    selected_configs: Vec<String>,
    available_configs: &[String],
) -> Vec<String> {
    let available = available_configs.iter().collect::<HashSet<_>>();
    let mut out = Vec::new();
    for config in selected_configs {
        if !available.contains(&config) {
            continue;
        }
        if out.contains(&config) {
            continue;
        }
        out.push(config);
    }
    out
}

fn pick_settlements_data_for_configs(
    selected_configs: &[String],
    settlements_data_by_config: &HashMap<String, Arc<SettlementsData>>,
    default_settlements_data: Arc<SettlementsData>,
    mode: Mode,
) -> anyhow::Result<Arc<SettlementsData>> {
    if selected_configs.is_empty() {
        return Ok(default_settlements_data);
    }

    if selected_configs.len() == 1 {
        if let Some(data) = settlements_data_by_config.get(&selected_configs[0])
        {
            return Ok(data.clone());
        }
    }

    let settlements_data =
        crate::location::load_from_file(selected_configs.to_vec(), mode)
            .c(h!())?;
    Ok(Arc::new(settlements_data))
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
    if available_configs.is_empty() {
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
                // Empty explicit selection -> fallback to default
                // settlements list from config.toml.
                settlements_configs: Set(serde_json::json!([])),
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
    settlements_lock.aor_id_to_config_names.clear();
    let available_configs =
        settlements_lock.available_settlements_configs.clone();
    let mode = settlements_lock.mode;

    for row in rows {
        let selected_configs = normalize_selected_configs(
            parse_selected_configs(&row),
            &available_configs,
        );
        let settlements_data = pick_settlements_data_for_configs(
            &selected_configs,
            &settlements_lock.settlements_data_by_config,
            settlements_lock.default_settlements_data.clone(),
            mode,
        )
        .c(h!())?;
        settlements_lock
            .aor_id_to_settlements_data
            .insert(row.aor_id, settlements_data);
        settlements_lock
            .aor_id_to_config_names
            .insert(row.aor_id, selected_configs);
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
    let default_configs = settlements_lock.default_settlements_files.clone();

    let items = aors
        .into_iter()
        .map(|aor| {
            let selected_configs = row_by_aor_id
                .get(&aor.id)
                .map(parse_selected_configs)
                .map(|selected| {
                    normalize_selected_configs(
                        selected,
                        &settlements_lock.available_settlements_configs,
                    )
                })
                .unwrap_or_else(|| default_configs.clone());
            AorLocationConfigItem {
                aor_id: aor.id,
                aor_name: aor.name,
                selected_configs,
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
        for config in &req.settlements_configs {
            if !settlements_lock
                .available_settlements_configs
                .contains(config)
            {
                return Err(AppError::BL {
                    msg: format!("unknown settlements config: {config}"),
                });
            }
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

    let selected_configs = req.settlements_configs.clone();

    match existing {
        Some(rec) => {
            let mut rec = rec.into_active_model();
            rec.settlements_configs =
                Set(serde_json::json!(selected_configs.clone()));
            rec.updated_at = NotSet;
            rec.update(&env.dbx).await.c(h!())?;
        }
        None => {
            aor_location_config::ActiveModel {
                id: NotSet,
                aor_id: Set(req.aor_id),
                settlements_configs: Set(serde_json::json!(
                    selected_configs.clone()
                )),
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
        selected_configs,
    }))
}
