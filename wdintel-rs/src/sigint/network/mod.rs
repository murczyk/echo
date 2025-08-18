use super::sea_orm_active_enums::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::rer_importer::types::{InboxMapItem, MapPointsFilter};
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::types::*;
use crate::utils::*;
use chrono::*;
use itertools::Itertools;
use sea_orm::sea_query::*;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap, HashSet};

use self::types::*;
use crate::sigint;
use actix_web::post;
use actix_web::web::Json;
use log::*;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter,
    QuerySelect,
};
use sea_query::{Alias, Expr, Query};

pub mod types;

const MERGE_NETWORKS_API_LOGIN: &str = "merge_networks_api";

/// Отримання списку мереж
///
/// # API URL
/// - POST: /api/sigint/network-list
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<ListNetworksReq>`] - де [`ListNetworksReq`] Тіло запиту, що містить параметри для фільтрації та сортування списку мереж.
///
/// # Повертає
///
/// [`Json<Vec<Network>>`], де [`Network`] - це структура, що представляє одну мережу.
///

#[post("/api/sigint/network-list")]
pub async fn network_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworksReq>,
) -> Result<Json<Vec<Network>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;

    let mut networks = sigint_network::Entity::find()
        .join_as(
            JoinType::LeftJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        );

    networks = networks.filter(
        sigint_network::Column::Deleted
            .eq(req.show_only_deleted.unwrap_or(false)),
    );

    if !req.show_inactive.unwrap_or(false) {
        networks = networks.filter(sigint_network::Column::ActiveTo.is_null());
    }

    if let Some(filter_unit) = &req.filter_unit {
        networks = networks.filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![format!("%{}%", filter_unit.to_lowercase())],
        ))
    };

    if req.filter_further_investigation.unwrap_or(false) {
        networks = networks.filter(sigint_network_unit::Column::Id.is_null());
    } else {
        networks =
            networks.filter(sigint_network_unit::Column::Id.is_not_null());
    }

    // Optional filter by Areas of Responsibility (AOR) IDs
    if let Some(aor_ids) = &req.aor_ids {
        if !aor_ids.is_empty() {
            networks = networks
                .join_as(
                    JoinType::InnerJoin,
                    sigint_network::Relation::SigintNetworkAor.def(),
                    Alias::new("sigint_network_aor"),
                )
                .filter(
                    sigint_network_aor::Column::AorId.is_in(aor_ids.clone()),
                );
        }
    }

    if let Some(filter_freq) = &req.filter_freq {
        let subquery = sigint_network_freq::Entity::find()
            .select_only()
            .column(sigint_network_freq::Column::Freq)
            .filter(
                sigint_network_freq::Column::NetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            )
            .filter(Expr::cust_with_values(
                "sigint_network_freq.freq ilike $1",
                vec![format!("{filter_freq}%").as_str()],
            ));
        networks = networks.filter(Expr::exists(subquery.into_query()));
    }

    networks = if let Some(sort_by) = &req.sort_by {
        sort_by
            .iter()
            .fold(networks, |networks, sort_by| match sort_by {
                ListNetworksSortBy::NameAsc => {
                    networks.order_by_asc(sigint_network::Column::Name)
                }
                ListNetworksSortBy::NameDesc => {
                    networks.order_by_desc(sigint_network::Column::Name)
                }
            })
    } else {
        networks.order_by_asc(sigint_network::Column::Name)
    };

    // println!(
    //     "> networks list sql: {}",
    //     networks.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(&env.dbx).await.context(h!())?;

    let res = render_networks(networks, &env.dbx).await.context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/restore-network")]
pub async fn restore_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RestoreNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id()?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "Api"])
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let network_id = req.into_inner().network_id;
    let network = find_network(&txn, network_id).await.context(h!())?;
    if network.deleted && network.active_to.is_some() {
        bl_restore_network(&txn, network).await.context(h!())?;
    } else {
        error!("user {user_id} attempted to re-activate already active network, skipping...");
    }

    let res = bl_network_info_batch(vec![network_id], &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    let res = res.into_iter().next().context(h!())?;
    Ok(Json(res))
}

async fn bl_restore_network(
    txn: &DatabaseTransaction,
    network: sigint_network::Model,
) -> Result<sigint_network::Model, AppError> {
    if let Some(active_to) = network.active_to {
        sigint_network_activity_history::ActiveModel {
            id: NotSet,
            sigint_network_id: Set(network.id),
            active_from: Set(network.active_from),
            active_to: Set(active_to),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }

    let mut network = network.into_active_model();
    network.active_from = Set(Utc::now().naive_utc());
    network.active_to = Set(None);
    let result = network.update(txn).await.context(h!())?;
    Ok(result)
}

#[post("/api/sigint/network-info-batch-freq")]
pub async fn network_info_batch_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<String>>,
) -> Result<Json<Vec<Network>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_freqs(req.into_inner(), &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(res))
}

#[post("/api/sigint/network-info-batch-id")]
pub async fn network_info_batch_id(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<i64>>,
) -> Result<Json<Vec<Network>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_batch(req.clone(), &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(res))
}

#[post("/api/sigint/network-info-one")]
pub async fn network_info_one(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_batch(vec![req.0], &txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(res.into_iter().next().context(h!())?))
}

async fn render_networks<'a, 'async_trait, C>(
    networks: Vec<sigint_network::Model>,
    txn: &'a C,
) -> Result<Vec<Network>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut networks_res = vec![];
    for network in networks {
        let freqs = get_network_freqs(txn, network.id).await.context(h!())?;
        let unit_ids =
            get_network_units(txn, network.id).await.context(h!())?;

        let post_ids =
            get_network_posts(txn, network.id).await.context(h!())?;

        let descriptions = get_network_descriptions(txn, network.id)
            .await
            .context(h!())?;

        let aor_ids =
            get_network_aor_ids(txn, network.id).await.context(h!())?;

        networks_res.push(Network {
            id: network.id,
            freqs,
            unit_ids,
            aor_ids,
            name: network.name,
            location: network.location,
            radio_station: network.radio_station,
            created_at: network.created_at.and_utc().timestamp_millis(),
            purpose: network.purpose,
            operation_mode: network.operation_mode,
            operation_type: network.operation_type,
            operation_period: network.operation_period,
            last_updated_at: network.updated_at.and_utc().timestamp_millis(),
            last_updated_by: network.updated_by,
            active_from: network.active_from.and_utc().timestamp_millis(),
            active_to: network
                .active_to
                .map(|d| d.and_utc().timestamp_millis()),
            post_ids,
            descriptions,
            deleted: network.deleted,
        });
    }
    Ok(networks_res)
}

pub async fn bl_network_info_freqs(
    freqs: Vec<String>,
    txn: &DatabaseTransaction,
) -> Result<Vec<Network>, AppError> {
    let sel = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_freq::Column::Freq.is_in(&freqs));

    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(Expr::exists(
            sel.select_only()
                .column(sigint_network_freq::Column::Id)
                .into_query(),
        ));
    // .order_by_asc(sigint_network::Column::Freq);

    // println!(
    //     "> bl_network_info_batch sql: {}",
    //     networks_with_modulation.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(txn).await.context(h!())?;
    Ok(render_networks(networks, txn).await.context(h!())?)
}

pub async fn bl_network_info_batch(
    network_ids: Vec<i64>,
    txn: &DatabaseTransaction,
) -> Result<Vec<Network>, AppError> {
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids));
    // .order_by_asc(sigint_network::Column::Freq);

    // println!(
    //     "> bl_network_info_batch sql: {}",
    //     networks_with_modulation.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(txn).await.context(h!())?;
    Ok(render_networks(networks, txn).await.context(h!())?)
}

#[post("/api/sigint/create-network")]
pub async fn create_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let mut network_descr: Vec<sigint_network_description::ActiveModel> =
        vec![];
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    let txn = env.dbx.begin().await.context(h!())?;

    let areas_of_responsibility_ids: Vec<i64> =
        req.area_of_responsibility_ids.clone().unwrap_or_default();
    if req.freqs.is_empty() {
        return Err(AppError::Form(BTreeMap::from_iter([(
            "freqs".to_string(),
            "Мережа має містити як мінімум одну частоту".to_string(),
        )])));
    }

    let freq_ranges: Vec<(NaiveDateTime, Option<NaiveDateTime>)> = req
        .freqs
        .iter()
        .map(|f| {
            let from_millis = f
                .active_from
                .unwrap_or_else(|| Utc::now().timestamp_millis());
            let from = dt_from_millis(from_millis)
                .unwrap_or_else(|_| Utc::now().naive_utc());

            let to = f.active_to.and_then(|millis| dt_from_millis(millis).ok());

            (from, to)
        })
        .collect();

    let (active_from, active_to) = compute_network_activity_range(&freq_ranges);

    let network = sigint_network::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        location: Set(req.location.clone()),
        deleted: Set(false),
        created_at: NotSet,
        updated_by: Set(Some(user_login.clone())),
        updated_at: NotSet,
        radio_station: Set(req.radio_station.clone()),
        purpose: Set(req.purpose.clone()),
        operation_mode: Set(req.operation_mode.clone()),
        operation_type: Set(req.operation_type.clone()),
        operation_period: Set(req.operation_period.clone()),
        merged_to: NotSet,
        active_from: Set(active_from),
        active_to: Set(active_to),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&txn)
    .await
    .context(h!())?;

    save_network_aors(&txn, areas_of_responsibility_ids, network.id)
        .await
        .context(h!())?;

    let network_json = sigint_network::Entity::find_by_id(network.id)
        .into_json()
        .one(&txn)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_network_changelog::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(network.id),
        login: Set(user_login.clone()),
        action: Set(ChangelogActionEnum::Create),
        created_at: NotSet,
        new_value: Set(Some(network_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&txn)
    .await
    .context(h!())?;

    for frequency in req.freqs.clone() {
        let active_from = frequency
            .active_from
            .map(dt_from_millis)
            .transpose()?
            .unwrap_or(Utc::now().naive_utc());
        let active_to = frequency.active_to.map(dt_from_millis).transpose()?;

        let freq_id = sigint_network_freq::ActiveModel {
            id: NotSet,
            network_id: Set(network.id),
            freq: Set(frequency.freq),
            created_at: NotSet,
            active_from: Set(active_from),
            active_to: Set(active_to),
            kind: Set(SigintNetworkKind::try_from_value(&frequency.kind)?),
            modulation_id: Set(frequency.modulation_id),
            deleted: Set(false),
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        }
        .insert(&txn)
        .await
        .context(h!())?
        .id;
        if let Some(descr) = frequency.description {
            network_descr.push(map_add_network_frequency_description(
                &user_login,
                &network,
                freq_id,
                descr,
            ));
        }
    }

    if let Some(unit_ids) = req.unit_ids.clone() {
        let network_units: Vec<sigint_network_unit::ActiveModel> = unit_ids
            .into_iter()
            .map(|unit_id| sigint_network_unit::ActiveModel {
                id: NotSet,
                network_id: Set(network.id),
                unit_id: Set(unit_id),
                created_at: NotSet,
                sigint_origin_id: NotSet,
                mothership_id: NotSet,
            })
            .collect();
        if !network_units.is_empty() {
            sigint_network_unit::Entity::insert_many(network_units)
                .exec(&txn)
                .await
                .context(h!())?;
        }
    }

    let network_posts: Vec<sigint_network_post::ActiveModel> = req
        .post_ids
        .clone()
        .into_iter()
        .map(|post_id| sigint_network_post::ActiveModel {
            id: NotSet,
            network_id: Set(network.id),
            post_id: Set(post_id),
            deleted: NotSet,
            created_at: NotSet,
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        })
        .collect();
    if !network_posts.is_empty() {
        sigint_network_post::Entity::insert_many(network_posts)
            .exec(&txn)
            .await
            .context(h!())?;
    }

    req.descriptions
        .clone()
        .into_iter()
        .map(|descr| {
            map_add_network_description(user_login.clone(), &network, descr)
        })
        .for_each(|d| network_descr.push(d));
    if !network_descr.is_empty() {
        sigint_network_description::Entity::insert_many(network_descr)
            .exec(&txn)
            .await
            .context(h!())?;
    }

    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let res = render_networks(vec![network], &env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/update-network")]
pub async fn update_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;

    let txn = env.dbx.begin().await.context(h!())?;

    let req: UpdateNetworkReq = req.into_inner();
    let is_restore_network = req.restore_network.unwrap_or(false);

    let network = sigint_network::Entity::find_by_id(req.id)
        .filter(sigint_network::Column::Deleted.eq(is_restore_network))
        .one(&txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let network = if is_restore_network {
        bl_restore_network(&txn, network).await.context(h!())?
    } else {
        network
    };

    let mut network_model = network.into_active_model();
    network_model.name = Set(req.name.clone());
    network_model.location = Set(req.location.clone());
    network_model.radio_station = Set(req.radio_station.clone());
    network_model.purpose = Set(req.purpose.clone());
    network_model.operation_mode = Set(req.operation_mode.clone());
    network_model.operation_type = Set(req.operation_type.clone());
    network_model.operation_period = Set(req.operation_period.clone());
    network_model.updated_by = Set(Some(user.id()?.to_string()));
    network_model.updated_at = Set(Utc::now().naive_utc());

    let network = network_model.update(&txn).await.context(h!())?;

    if let Some(aor_ids) = req.area_of_responsibility_ids.clone() {
        // Replace existing AOR links with the provided set
        sigint_network_aor::Entity::delete_many()
            .filter(sigint_network_aor::Column::NetworkId.eq(network.id))
            .exec(&txn)
            .await
            .context(h!())?;
        save_network_aors(&txn, aor_ids, network.id)
            .await
            .context(h!())?;
    }

    if let Some(description_patches) = &req.descriptions {
        for p in description_patches {
            let descr_model = sigint_network_description::Entity::find_by_id(
                p.description_id,
            )
            .filter(
                sigint_network_description::Column::NetworkId.eq(p.network_id),
            )
            .filter(sigint_network_description::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .context(h!())?;

            if let Some(descr_model) = descr_model {
                let mut model = descr_model.into_active_model();
                model.r#type =
                    Set(NetworkDescriptionType::from(p.descr_type.clone()));
                model.description = Set(p.description.clone());
                model.sigint_network_freq_id = Set(p.network_freq_id);
                model.comment = NotSet; // Set(p.comment.clone());
                model.update(&txn).await.context(h!())?;
            } else {
                debug!(
                    "Description {} not found for network {}, no action needed",
                    p.description_id, p.network_id
                );
            }
        }
    }

    txn.commit().await.context(h!())?;

    let res = render_networks(vec![network], &env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    Ok(Json(res))
}

///  Видалення мережі
///
/// # API URL
/// - POST: /api/sigint/delete-network
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<DeleteNetworkReq>`] - де [`DeleteNetworkReq`] Тіло запиту, що містить id мережі для видалення.
///
/// # Повертає
///
/// [`Json<Network>`], де [`Network`] - це структура, що представляє одну мережу.
///
#[post("/api/sigint/delete-network")]
pub async fn delete_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let user_login = user.id()?.to_string();
    crate::users::has_role(&env.dbx, &user_login, "Rer").await?;
    crate::users::has_role(&env.dbx, user_login.as_str(), "UnitsEditor")
        .await?;
    let req: DeleteNetworkReq = req.into_inner();
    let network = find_network(&env.dbx, req.network_id).await.context(h!())?;
    let network_json_old = sigint_network::Entity::find_by_id(network.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let mut network = network.into_active_model();
    network.deleted = Set(true);
    let network = network.update(&env.dbx).await.context(h!())?;
    let network_json_new = sigint_network::Entity::find_by_id(network.id)
        .into_json()
        .one(&env.dbx)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let _changelog = sigint_network_changelog::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(network.id),
        login: Set(user_login),
        action: Set(ChangelogActionEnum::Delete),
        created_at: NotSet,
        new_value: Set(Some(network_json_new)),
        old_value: Set(Some(network_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    let res = render_networks(vec![network], &env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    Ok(Json(res))
}

pub async fn get_modulation_name_by_id(
    modulation_id: Option<i32>,
    txn: &DatabaseTransaction,
) -> Result<Option<String>, AppError> {
    match modulation_id {
        Some(id) => {
            let modulation = modulation::Entity::find_by_id(id)
                .one(txn)
                .await
                .context(h!())?;
            Ok(modulation.map(|m| m.name))
        }
        None => Ok(None),
    }
}

#[post("/api/sigint/network-callsigns")]
pub async fn network_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignsReq>,
) -> Result<Json<HashMap<String, Vec<String>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;

    let mut query = Query::select();
    query
        .expr_as(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id)),
            Alias::new("id"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Callsigns)),
            Alias::new("callsigns"),
        )
        .from(SigintNetwork::Table)
        .join(
            JoinType::InnerJoin,
            SigintNetworkFreq::Table,
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId))
                .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
                .equals((SigintNetworkFreq::Table, SigintNetworkFreq::Freq)),
        )
        .join(
            JoinType::InnerJoin,
            SignalMessage::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Id))
                .is_in(req.network_ids.clone()),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey))
                .is_in(
                    crate::users::get_identity_sigint_groups_noimport(
                        &env.dbx,
                        &user,
                        &env.config,
                    )
                    .await
                    .context(h!())?,
                ),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)).gte(
                Expr::col((
                    SigintNetworkFreq::Table,
                    SigintNetworkFreq::ActiveFrom,
                )),
            ),
        )
        .and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)).lt(
               Expr::cust("COALESCE(sigint_network_freq.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
            ),
        );

    let rows = env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            query.to_string(PostgresQueryBuilder),
        ))
        .await
        .context(h!())?;
    let mut callsigns = HashMap::new();
    for row in rows {
        let id: i64 = row.try_get("", "id").context(h!())?;
        let row_callsigns = row.try_get("", "callsigns").context(h!())?;
        let hashmap_value =
            callsigns.entry(id.to_string()).or_insert_with(Vec::new);
        let all_callsigns =
            serde_json::from_value::<Vec<String>>(row_callsigns)
                .context(h!())?;
        for callsign in all_callsigns {
            if !hashmap_value.contains(&callsign) {
                hashmap_value.push(callsign);
            }
        }
    }

    Ok(Json(callsigns))
}

#[post("/api/sigint/network-group-activity-one")]
pub async fn network_group_activity_one(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkGroupsActivityOneReq>,
) -> Result<Json<HashMap<String, HashMap<String, i64>>>, AppError> {
    let new_req = Json(NetworkGroupsActivityReq {
        network_ids: vec![req.network_id],
        till_date_noninclusive_ms: req.till_date_noninclusive_ms,
    });

    let networks_group_stat = network_group_activity_bl(user, env, new_req)
        .await
        .context(h!())?;
    let res = networks_group_stat
        .get(&req.network_id.to_string())
        .cloned()
        .unwrap_or_default();
    Ok(Json(res))
}

#[post("/api/sigint/network-group-activity")]
pub async fn network_group_activity(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkGroupsActivityReq>,
) -> Result<
    Json<HashMap<String, HashMap<String, HashMap<String, i64>>>>,
    AppError,
> {
    Ok(Json(
        network_group_activity_bl(user, env, req)
            .await
            .context(h!())?,
    ))
}

async fn network_group_activity_bl(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkGroupsActivityReq>,
) -> Result<HashMap<String, HashMap<String, HashMap<String, i64>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    let dt_till = if let Some(till) = req.till_date_noninclusive_ms {
        dt_from_millis(till)?
    } else {
        Utc::now().naive_utc()
    };

    let networks_group_stat = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
            Alias::new("sigint_network_freq"),
        )
        .join_as(
            JoinType::LeftJoin,
            signal_message::Relation::SignalGroup.def(),
            Alias::new("signal_group"),
        )
        .select_only()
        .column_as(
            Expr::cust(
                "(EXTRACT(EPOCH FROM DATE_TRUNC('day', sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT",
            ),
            "day",
        )
        .column_as(sigint_network_freq::Column::NetworkId, "network_id")
        .column_as(signal_group::Column::Name, "group")
        .column_as(Expr::cust("count(*)"), "count")
        .group_by(Expr::cust(
            "network_id, day, signal_group.name",
        ))
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                    .await.context(h!())?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(dt_till))
        .filter(Expr::cust_with_values("sigint_inbox_item.datetime >= $1 - INTERVAL '10 days'", vec![dt_till]))
        .filter(sigint_network_freq::Column::NetworkId.is_in(req.network_ids.clone()));

    let networks_group_stat = networks_group_stat
        .clone()
        .order_by_desc(Expr::cust("network_id, day, \"group\""));

    // println!(
    //     "> sql: {}",
    //     networks_group_stat.clone().build(DbBackend::Postgres).to_string()
    // );
    #[derive(FromQueryResult)]
    pub struct NetworkGroupsMessageCountByDay {
        pub network_id: i64,
        pub count: i64,
        pub group: String,
        pub day: i64,
    }

    let mut res = HashMap::new();
    for row in networks_group_stat
        .into_model::<NetworkGroupsMessageCountByDay>()
        .all(&env.dbx)
        .await
        .context(h!())?
    {
        let network_id = row.network_id.to_string();
        let day = row.day.to_string();
        let group = row.group.clone();
        let count = row.count;
        if !res.contains_key(&network_id) {
            res.insert(network_id.clone(), HashMap::new());
        }
        let freq_map = res.get_mut(&network_id).unwrap();
        if !freq_map.contains_key(&day) {
            freq_map.insert(day.clone(), HashMap::new());
        }
        let day_map = freq_map.get_mut(&day).unwrap();
        day_map.insert(group.clone(), count);
    }

    Ok(res)
}

/// Статистика активності мережі за частотами по днях
///
/// # API URL
/// - POST: /api/sigint/network-freqs-activity-one
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - Ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<NetworkFreqsActivityReq>`] - де [`NetworkFreqsActivityReq`] Тіло запиту, що містить параметри для фільтрації мереж.
///
/// # Повертає
///
/// [`Json<HashMap<String, HashMap<String, i64>>>`], це структура, що представляє статистичну інформацію по днях та частотах мережі.
///
#[post("/api/sigint/network-freqs-activity-one")]
pub async fn network_freqs_activity_one(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkFreqsActivityReq>,
) -> Result<Json<HashMap<String, HashMap<String, i64>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let network_freqs_cte = Query::select()
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Id)),
            Alias::new("id"),
        )
        // .expr_as(
        //     Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId)),
        //     Alias::new("network_id"),
        // )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((
                SigintNetworkFreq::Table,
                SigintNetworkFreq::ActiveFrom,
            )),
            Alias::new("active_from"),
        )
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::ActiveTo)),
            Alias::new("active_to"),
        )
        .from(SigintNetworkFreq::Table)
        .and_where(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId))
                .eq(req.network_id),
        )
        .to_owned();

    let network_freqs_cte = sea_orm::sea_query::CommonTableExpression::new()
        .query(network_freqs_cte)
        .table_name(Alias::new("network_freqs"))
        .to_owned();

    let main_query = Query::select()
    .expr_as(
        Expr::cust("(EXTRACT(EPOCH FROM DATE_TRUNC('day', sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT"),
        Alias::new("day"),
    )
    // .expr_as(Expr::col((Alias::new("network_freqs"), Alias::new("network_id"))), Alias::new("network_id"))
    .expr_as(Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)), Alias::new("freq"))
    .expr_as(Expr::cust("COUNT(*)"), Alias::new("message_count"))
    .from(SignalMessage::Table)
    .join(
        JoinType::InnerJoin,
        SigintInboxItem::Table,
        Expr::col((SignalMessage::Table, SignalMessage::Id))
            .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
    )
    .join(
        JoinType::InnerJoin,
        Alias::new("network_freqs"),
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq))
            .equals((Alias::new("network_freqs"), Alias::new("freq")))
            .and(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                    .gte(Expr::col((Alias::new("network_freqs"), Alias::new("active_from"))))
            )
            .and(
                Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                    .lte(Expr::cust("COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')"))
            ),
    )
    .and_where(Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false))
    .and_where(Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey)).is_in(groups))
    .add_group_by([
        // Expr::col((Alias::new("network_freqs"), Alias::new("network_id"))).into(),
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into(),
        Expr::cust("day"),
    ])
    .order_by_expr(Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into(), Order::Asc)
    .order_by_expr(Expr::cust("day"), Order::Asc)
    .to_owned();

    let combined_query = Query::with()
        .cte(network_freqs_cte)
        .clone()
        .query(main_query);

    let combined_query: String = combined_query.to_string(PostgresQueryBuilder);

    // debug!(">  network_freqs_activity query: {}", combined_query);

    let rows = env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query,
        ))
        .await
        .context(h!())?;

    let mut res: HashMap<String, HashMap<String, i64>> = HashMap::new();

    for row in rows {
        let freq = row.try_get::<String>("", "freq").unwrap_or_default();
        let day = row
            .try_get::<i64>("", "day")
            .unwrap_or_default()
            .to_string();
        let count = row.try_get::<i64>("", "message_count").unwrap_or(0);

        res.entry(freq).or_default().insert(day, count);
    }

    Ok(Json(res))
}

#[post("/api/sigint/network-points")]
pub async fn list_network_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworkPointsReq>,
) -> Result<Json<ListNetworkPointsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let mut query = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
            Alias::new("sigint_network_freq"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintPeleng.def(),
            Alias::new("sigint_peleng"),
        )
        .select_only()
        .column_as(signal_message::Column::Id, "id")
        .column_as(signal_message::Column::Body, "body")
        .column_as(sigint_peleng::Column::Lat, "lat")
        .column_as(sigint_peleng::Column::Lng, "lng")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                .await
                .context(h!())?,
            ),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id));

    if let Some(dt_till) = req.till_date_noninclusive_ms {
        query = query.filter(
            sigint_inbox_item::Column::Datetime.lte(dt_from_millis(dt_till)?),
        );
    }

    Ok(Json(ListNetworkPointsRsp {
        points: query
            .into_model::<NetworkPoint>()
            .all(&env.dbx)
            .await
            .context(h!())?,
    }))
}

#[post("/api/sigint/update-freq-networks")]
pub async fn update_freq_networks(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateFreqNetworksReq>,
) -> Result<Json<Vec<Network>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "update freq networks; login = {}; req = {:?}",
        user.id()?,
        req
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network_freq::Column::Freq.eq(&req.freq))
        .filter(sigint_network::Column::Deleted.eq(false))
        .all(&txn)
        .await
        .context(h!())?;
    let req_network_ids: BTreeSet<i64> =
        req.networks.iter().filter_map(|x| x.id).collect();
    for network in networks {
        let id = network.id;
        if !req_network_ids.contains(&id) {
            let mut network = network.into_active_model();
            network.updated_by = Set(Some(user.id()?.to_string()));
            network.updated_at = NotSet;
            network.deleted = Set(true);
            network.save(&txn).await.context(h!())?;
        }
    }

    for req_network in &req.networks {
        let network_id = if let Some(id) = req_network.id {
            let network_id = id;
            let network = sigint_network::Entity::find_by_id(id)
                .one(&txn)
                .await
                .context(h!())?;
            if let Some(network) = network {
                sigint_network_unit::Entity::delete_many()
                    .filter(sigint_network_unit::Column::NetworkId.eq(id))
                    .exec(&txn)
                    .await
                    .context(h!())?;

                let mut network = network.into_active_model();
                network.name = Set(req_network.name.clone());
                network.location = Set(req_network.location.clone());
                network.radio_station = Set(req_network.radio_station.clone());
                network.deleted = Set(false);
                network.updated_by = Set(Some(user.id()?.to_string()));
                network.updated_at = NotSet;
                network.save(&txn).await.context(h!())?;

                for unit_id in &req_network.unit_ids {
                    let network_unit = sigint_network_unit::ActiveModel {
                        id: NotSet,
                        network_id: Set(id),
                        unit_id: Set(*unit_id),
                        created_at: NotSet,
                        sigint_origin_id: NotSet,
                        mothership_id: NotSet,
                    };
                    network_unit.save(&txn).await.context(h!())?;
                }
            }
            network_id
        } else {
            let new_network_id = sigint_network::ActiveModel {
                name: Set(req_network.name.clone()),
                location: Set(req_network.location.clone()),
                radio_station: Set(req_network.radio_station.clone()),
                updated_by: Set(Some(user.id()?.to_string())),
                updated_at: NotSet,
                deleted: Set(false),
                created_at: NotSet,
                ..Default::default()
            }
            .insert(&txn)
            .await
            .context(h!())?
            .id;

            let areas_of_responsibility_ids = req_network
                .area_of_responsibility_ids
                .clone()
                .unwrap_or_default();

            save_network_aors(
                &txn,
                areas_of_responsibility_ids,
                new_network_id,
            )
            .await
            .context(h!())?;

            info!("inserted new network with id {new_network_id}");

            for unit_id in &req_network.unit_ids {
                let network_unit = sigint_network_unit::ActiveModel {
                    id: NotSet,
                    network_id: Set(new_network_id),
                    unit_id: Set(*unit_id),
                    created_at: NotSet,
                    sigint_origin_id: NotSet,
                    mothership_id: NotSet,
                };
                let _updated_entry =
                    network_unit.save(&txn).await.context(h!())?;
            }
            new_network_id
        };

        if let Some(req) = req_network.description.clone() {
            let descr_model = sigint_network_description::Entity::find_by_id(
                req.description_id,
            )
            .filter(
                sigint_network_description::Column::NetworkId.eq(network_id),
            )
            .filter(sigint_network_description::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .context(h!())?;

            if let Some(descr_model) = descr_model {
                let mut model = descr_model.into_active_model();
                model.r#type =
                    Set(NetworkDescriptionType::from(req.descr_type.clone()));
                model.description = Set(req.description.clone());
                model.sigint_network_freq_id = Set(req.network_freq_id);
                model.comment = NotSet; // Set(req.comment.clone());
                model.update(&txn).await.context(h!())?;
            } else {
                debug!(
                    "Description {} not found for network {}, no action needed",
                    req.description_id, req.network_id
                );
            }
        }
    }

    let networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network_freq::Column::Freq.eq(&req.freq))
        .filter(sigint_network::Column::Deleted.eq(false))
        .order_by_asc(sigint_network::Column::CreatedAt)
        .all(&txn)
        .await
        .context(h!())?;

    let result_json = Json(
        bl_network_info_batch(networks.iter().map(|x| x.id).collect(), &txn)
            .await
            .context(h!())?,
    );

    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(result_json)
}

#[post("/api/sigint/network/add-freq")]
pub async fn add_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    let user_login = user.id()?;
    crate::users::has_role(&env.dbx, &user_login, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_login, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "Adding frequency {} to network {}; user={}",
        req.freq_rec.freq,
        req.network_id,
        user.id()?
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // Check if frequency link already exists
    let existing_freq = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
        .filter(sigint_network_freq::Column::Freq.eq(req.freq_rec.freq.clone()))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .context(h!())?;

    let network_freq = if existing_freq.is_none() {
        // The frequency link doesn't exist, create it
        info!(
            "Adding frequency {} to network {}",
            req.freq_rec.freq, req.network_id
        );

        let active_from = req
            .freq_rec
            .active_from
            .map(dt_from_millis)
            .transpose()?
            .unwrap_or(Utc::now().naive_utc());
        let active_to =
            req.freq_rec.active_to.map(dt_from_millis).transpose()?;

        let network_freq = sigint_network_freq::ActiveModel {
            id: NotSet,
            network_id: Set(req.network_id),
            freq: Set(req.freq_rec.freq.clone()),
            created_at: NotSet,
            kind: Set(SigintNetworkKind::try_from_value(&req.freq_rec.kind)?),
            modulation_id: Set(req.freq_rec.modulation_id),
            active_from: Set(active_from),
            active_to: Set(active_to),
            deleted: Set(false),
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        };

        network_freq.insert(&txn).await.context(h!())?
    } else {
        debug!(
            "Frequency {} already exists for network {}, no action needed",
            req.freq_rec.freq, req.network_id
        );
        existing_freq.context(h!())?
    };

    if let Some(description) = req.freq_rec.clone().description {
        map_add_network_frequency_description(
            &user_login,
            &network,
            network_freq.id,
            description,
        )
        .insert(&txn)
        .await
        .context(h!())?;
    }

    let (network_active_from, network_active_to) =
        get_network_activity_range(&txn, req.network_id)
            .await
            .context(h!())?;

    let mut network_model = network.into_active_model();
    network_model.active_from = Set(network_active_from);
    network_model.active_to = Set(network_active_to);
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_login.to_string()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all frequencies to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/unit-stats")]
pub async fn network_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<NetworkUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;

    #[derive(FromQueryResult)]
    struct Row {
        unit_id: i64,
        count: i64,
    }
    let units = sigint_network::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
            Alias::new("sigint_network_unit"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column_as(sigint_network::Column::Id.count(), "count")
        .column_as(sigint_unit::Column::Id, "unit_id")
        // .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        // .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .group_by(sigint_unit::Column::Id)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company);
    // println!("> sql: {}", units.build(DbBackend::Postgres).to_string());
    let units = units
        .into_model::<Row>()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut res = vec![];
    for unit in units {
        res.push(NetworkUnitStatRow {
            unit_id: unit.unit_id,
            count: unit.count,
        });
    }
    Ok(Json(NetworkUnitStatsRsp { units: res }))
}

#[post("/api/sigint/network/update-freq")]
pub async fn update_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    info!(
        "Updating frequency {} for network {}; user={}",
        req.freq, req.network_id, user_login
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // Find the frequency for this network
    let network_freq_model = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
        .filter(sigint_network_freq::Column::Freq.eq(req.freq.clone()))
        // .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .one(&txn)
        .await
        .context(h!())?;

    if let Some(network_freq_model) = network_freq_model {
        let active_from =
            dt_from_millis(req.active_from).unwrap_or(Utc::now().naive_utc());
        let active_to = req.active_to.map(dt_from_millis).transpose()?;

        let mut model = network_freq_model.into_active_model();
        model.kind = Set(SigintNetworkKind::try_from_value(&req.kind)?);
        model.modulation_id = Set(req.modulation_id);
        model.active_from = Set(active_from);
        model.active_to = Set(active_to);
        model.update(&txn).await.context(h!())?;
    } else {
        debug!(
            "Frequency {} not found for network {}, no action needed",
            req.freq, req.network_id
        );
    }

    let (network_active_from, network_active_to) =
        get_network_activity_range(&txn, req.network_id)
            .await
            .context(h!())?;

    // Update the network's updated_at timestamp as well as new active_from and active_to
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_login.clone()));
    network_model.active_from = Set(network_active_from);
    network_model.active_to = Set(network_active_to);
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/delete-freq")]
pub async fn delete_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let req = req.into_inner();

    info!(
        "Removing frequency id={:?} freq={:?} network={:?}; user={}",
        req.id,
        req.freq,
        req.network_id,
        user.id()?
    );

    let txn = env.dbx.begin().await.context(h!())?;

    let mut freq_records = sigint_network_freq::Entity::find();
    // You can either delete by setting explicit `id`, or set `network_id` and `freq` pair
    match req.id {
        Some(id) => {
            freq_records =
                freq_records.filter(sigint_network_freq::Column::Id.eq(id));
        }
        None => {
            freq_records = freq_records
                .filter(
                    sigint_network_freq::Column::NetworkId.eq(req.network_id),
                )
                .filter(sigint_network_freq::Column::Freq.eq(req.freq.clone()))
                .filter(sigint_network_freq::Column::Deleted.eq(false));
        }
    }
    let freq_records = freq_records.all(&txn).await.context(h!())?;
    let mut network_detail = None;
    if freq_records.is_empty() {
        debug!(
            "Frequency {:?} not found for network {:?}, no action needed",
            req.freq, req.network_id
        );
    } else {
        // Mark all matching frequency connections as deleted
        for freq_record in freq_records.iter() {
            info!(
                "Removing frequency {:?} (id: {:?}) from network {:?}",
                req.freq, freq_record.id, req.network_id
            );

            let mut freq_record = freq_record.clone().into_active_model();
            freq_record.deleted = Set(true);
            freq_record.active_to = Set(Some(Utc::now().naive_utc()));
            freq_record.update(&txn).await.context(h!())?;
        }

        if let Some(network_id) = freq_records.first().map(|x| x.network_id) {
            let network = find_network(&txn, network_id).await.context(h!())?;
            let (network_active_from, network_active_to) =
                get_network_activity_range(&txn, network_id)
                    .await
                    .context(h!())?;

            // Update the network's updated_at timestamp as well as new active_from and active_to
            let mut network_model = network.into_active_model();
            network_model.updated_at = Set(Utc::now().naive_utc());
            network_model.updated_by = Set(Some(user.id()?.to_string()));
            network_model.active_from = Set(network_active_from);
            network_model.active_to = Set(network_active_to);
            network_model.update(&txn).await.context(h!())?;

            network_detail = Some(
                bl_network_info_batch(vec![network_id], &txn)
                    .await
                    .context(h!())?,
            );
        }
    }

    txn.commit().await.context(h!())?;
    let network_details = network_detail.clone().context(h!())?;
    let first_network_detail = network_details.first().context(h!())?;
    Ok(Json(first_network_detail.clone()))
}

pub async fn cleanup_networks_worker(dbx: &DatabaseConnection) {
    debug!("Starting cleanup_networks_worker");

    loop {
        if let Err(e) = cleanup_networks_worker_1(dbx).await {
            error!("error in cleanup_networks_worker_1: {e:?}");
        }
        tokio::time::sleep(std::time::Duration::from_secs(
            CLEANUP_NETWORKS_WORKER_SLEEP_DURATION,
        ))
        .await;
    }
}

async fn cleanup_networks_worker_1(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let delta = Duration::try_days(CLEANUP_NETWORKS_CUTOFF_TIME_DAYS)
        .context(h!())
        .map_err(Into::<AppError>::into)?;
    let start_time = Utc::now();
    let cleanup_time = start_time - delta;

    #[derive(Debug, Clone, FromQueryResult)]
    struct NetworkFreqDesc {
        pub id: i64,
        pub network_id: i64,
        pub freq: String,
        pub location: String,
        pub name: String,
    }

    let networks_freqs_to_remove = sigint_network_freq::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(sigint_network_freq::Column::Id)
        .column(sigint_network_freq::Column::NetworkId)
        .column(sigint_network_freq::Column::Freq)
        .column(sigint_network::Column::Location)
        .column(sigint_network::Column::Name)
        .filter(
            Condition::any().add(
                sigint_network_freq::Column::Freq.not_in_subquery(
                    Query::select()
                        .column(sigint_inbox_item::Column::Freq)
                        .from(sigint_inbox_item::Entity)
                        .and_where(
                            Expr::expr(Expr::col(
                                sigint_inbox_item::Column::Datetime,
                            ))
                            .gte(cleanup_time),
                        )
                        .and_where(
                            Expr::expr(Expr::col(
                                sigint_inbox_item::Column::Freq,
                            ))
                            .is_not_null(),
                        )
                        .group_by_col(sigint_inbox_item::Column::Freq)
                        .to_owned(),
                ),
            ),
        )
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .into_model::<NetworkFreqDesc>()
        .all(dbx)
        .await
        .context(h!())?;

    if !networks_freqs_to_remove.is_empty() {
        info!(
            "networks freqs up to removal: {}",
            networks_freqs_to_remove.len()
        );
    }

    let ids: Vec<i64> = networks_freqs_to_remove.iter().map(|n| n.id).collect();
    let network_ids: Vec<i64> = networks_freqs_to_remove
        .iter()
        .map(|n| n.network_id)
        .collect();
    let networks_desc = load_networks_units_desc(ids.clone(), dbx, h!())
        .await
        .context(h!())?;

    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids.clone()))
        .find_with_related(sigint_network_freq::Entity)
        .all(dbx)
        .await
        .context(h!())?;

    for (network, network_freqs) in networks {
        for network_freq in network_freqs {
            let is_deleted = ids.contains(&network_freq.id);
            if is_deleted {
                let mut model = network_freq.into_active_model();
                model.active_to = Set(Some(Utc::now().naive_utc()));
                model.update(dbx).await.context(h!())?;
            }
        }

        let network_id = network.id;
        let (network_active_from, network_active_to) =
            get_network_activity_range(dbx, network_id)
                .await
                .context(h!())?;

        let mut network = network.into_active_model();
        network.active_from = Set(network_active_from);
        network.active_to = Set(network_active_to);
        network.update(dbx).await.context(h!())?;
    }

    for sigint_network_freq in networks_freqs_to_remove {
        let unit_desc = networks_desc
            .get(&sigint_network_freq.network_id)
            .map(|x| x.join(", "))
            .unwrap_or(String::from(""));
        let location = Some(sigint_network_freq.location.trim())
            .filter(|x| !x.is_empty())
            .map(|x| format!("({x})"))
            .unwrap_or(String::from(""));
        let desc = vec![sigint_network_freq.name.clone(), unit_desc, location]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect::<Vec<String>>()
            .join(" ");

        info!(
            "removing network freq: freq {}, description: {}",
            sigint_network_freq.freq.clone(),
            desc
        );

        let freq = sigint_network_freq.freq.clone();

        let freq_locations_to_remove = freq_location::Entity::find()
            .filter(freq_location::Column::Freq.eq(freq))
            .all(dbx)
            .await
            .context(h!())?;
        for fl in freq_locations_to_remove {
            let mut model = fl.into_active_model();
            model.deleted = Set(true);
            model.update(dbx).await.context(h!())?;
        }
    }

    let other_networks = sigint_network::Entity::find()
        .find_with_related(sigint_network_freq::Entity)
        .filter(sigint_network::Column::Id.is_not_in(network_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            sigint_network::Column::CreatedAt
                .lte(start_time - Duration::hours(6)),
        )
        .all(dbx)
        .await
        .context(h!())?;
    for (network, network_freqs) in other_networks {
        let should_delete = if network_freqs.is_empty() {
            true
        } else {
            network_freqs
                .iter()
                .filter(|x| x.active_to.is_none())
                .count()
                == 0
        };
        if should_delete {
            let mut network = network.into_active_model();
            network.active_to = Set(Some(start_time.naive_utc()));
            network.update(dbx).await.context(h!())?;
        }
    }
    debug!("cleanup_networks_worker completed");
    Ok(())
}

pub async fn collect_network_units(
    inbox_items: &Vec<InboxMapItem>,
    dbx: &DatabaseConnection,
    map_filter: Option<MapPointsFilter>,
) -> anyhow::Result<BTreeMap<String, Vec<sigint_unit::Model>>> {
    let freqs = inbox_items
        .iter()
        .filter_map(|x| x.freq.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let freq_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network_freq::Column::Freq.is_in(freqs))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network::Column::Id) //
        .column(sigint_network_freq::Column::Freq) // Select sn::Column
        .into_tuple::<(i64, String)>()
        .all(dbx)
        .await
        .context(h!())?;
    let network_ids = freq_networks.iter().map(|x| x.0).unique().collect_vec();
    let units = sigint_network_unit::Entity::find()
        .find_with_related(sigint_unit::Entity)
        .filter(sigint_network_unit::Column::NetworkId.is_in(network_ids))
        .all(dbx)
        .await
        .context(h!())?;
    let mut network_units_map = BTreeMap::new();
    for (network_unit, units) in units {
        let recs = network_units_map
            .entry(network_unit.network_id)
            .or_insert(vec![]);
        for u in units {
            recs.push(u);
        }
    }

    let data: Option<BTreeSet<String>> = if let Some(map_filter) = map_filter {
        let data = map_filter
            .network_units
            .into_iter()
            .map(|r| r.name)
            .collect::<BTreeSet<_>>();
        Some(data)
    } else {
        None
    };

    fn unit_filter(
        u: &sigint_unit::Model,
        data: &Option<BTreeSet<String>>,
    ) -> bool {
        match data {
            Some(data) => data.contains(&u.name),
            None => true,
        }
    }
    let mut result: BTreeMap<String, Vec<sigint_unit::Model>> = BTreeMap::new();
    for (network_id, freq) in freq_networks {
        let s_units = result.entry(freq).or_default();
        if let Some(units) = network_units_map.get(&network_id) {
            for u in units {
                if unit_filter(u, &data) {
                    s_units.push(u.clone());
                }
            }
        }
    }
    Ok(result)
}

async fn load_networks_units_desc(
    network_ids: Vec<i64>,
    dbx: &DatabaseConnection,
    h: &'static str,
) -> anyhow::Result<BTreeMap<i64, Vec<String>>> {
    #[derive(Debug, Clone, FromQueryResult)]
    struct NetworkDesc {
        pub network_id: i64,
        pub unit_name: Option<String>,
    }

    let data: Vec<NetworkDesc> = sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintNetwork.def(),
        )
        .filter(sigint_network::Column::Id.is_in(network_ids))
        .select_only()
        .column_as(sigint_network_unit::Column::NetworkId, "network_id")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkDesc>()
        .all(dbx)
        .await
        .context(h)?;

    let mut result: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for rec in data.into_iter() {
        if let Some(name) = rec.unit_name {
            result
                .entry(rec.network_id)
                .or_insert_with(|| Vec::with_capacity(1))
                .push(name)
        };
    }
    Ok(result)
}

#[post("/api/sigint/merge-network")]
pub async fn merge_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MergeNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let login = user.id()?.to_string();
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;

    // debug!("> merge networks");
    let txn = env.dbx.begin().await.context(h!())?;

    merge_two_networks(
        &txn,
        login.clone(),
        false,
        req.network_id_from,
        req.network_id_to,
    )
    .await
    .context(h!())?;

    txn.commit().await.context(h!())?;

    debug!(
        "> Merge successful! Merged network {} into {}",
        req.network_id_from, req.network_id_to
    );

    let network = find_network(&env.dbx, req.network_id_to)
        .await
        .context(h!())?;
    let res = render_networks(vec![network], &env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/network-callsigns-list")]
pub async fn network_callsigns_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SingleNetworkCallsignsReq>,
) -> Result<Json<SingleNetworkCallsignsListRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;

    let network = find_network(&env.dbx, req.network_id).await.context(h!())?;

    let filter = EtalonkaFilter {
        since_date_inclusive_ms: Some(
            network.active_from.and_utc().timestamp_millis(),
        ),
        till_date_noninclusive_ms: Some(
            network
                .active_to
                .map(|dt| dt.and_utc().timestamp_millis())
                .unwrap_or_else(|| {
                    Utc::now().naive_utc().and_utc().timestamp_millis()
                }),
        ),
        network_id: req.network_id,
        filter_further_investigation: None,
    };

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let all_known_callsigns =
        find_all_known_callsigns(&env.dbx).await.context(h!())?;

    let callsigns_raw =
        load_callsigns(&env.dbx, &groups, &filter, &all_known_callsigns)
            .await
            .context(h!())?;

    let callsigns_txt = callsigns_raw
        .iter()
        .map(|c| c.callsign.clone())
        .collect::<Vec<_>>();

    let callsigns_reporting =
        get_network_callsings_reporting(&env.dbx, network.id, callsigns_txt)
            .await
            .context(h!())?;

    let callsigns = callsigns_raw
        .into_iter()
        .map(|callsign| {
            let is_reported = callsigns_reporting
                .get(&callsign.callsign)
                .cloned()
                .unwrap_or(false);
            NetworkCallsignRes {
                is_reported,
                callsign: callsign.callsign,
                known_callsigns: callsign.known_callsigns,
                message_count: callsign.message_count,
                last_datetime: callsign.last_datetime,
                freqs: callsign.freqs,
                network_names: callsign.network_names,
                is_old: callsign.is_old,
            }
        })
        .collect();

    Ok(Json(SingleNetworkCallsignsListRsp { callsigns }))
}

#[post("/api/sigint/network-freqs-list")]
pub async fn network_freqs_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SingleNetworkFreqsReq>,
) -> Result<Json<SingleNetworkFreqsListRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;

    let network = find_network(&env.dbx, req.network_id).await.context(h!())?;

    let filter = EtalonkaFilter {
        since_date_inclusive_ms: Some(
            network.active_from.and_utc().timestamp_millis(),
        ),
        till_date_noninclusive_ms: Some(
            network
                .active_to
                .map(|dt| dt.and_utc().timestamp_millis())
                .unwrap_or_else(|| {
                    Utc::now().naive_utc().and_utc().timestamp_millis()
                }),
        ),
        network_id: req.network_id,
        filter_further_investigation: None,
    };

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let freqs = load_freqs(&env.dbx, &groups, &filter, false)
        .await
        .context(h!())?;

    let res = SingleNetworkFreqsListRsp { freqs };

    Ok(Json(res))
}

#[post("/api/sigint/modulations-list")]
pub async fn modulations_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<ModulationRec>>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;
    let modulations = modulation::Entity::find()
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut res: Vec<ModulationRec> = vec![];
    for modulation in modulations {
        res.push(ModulationRec {
            id: modulation.id,
            name: modulation.name.clone(),
            left: modulation.lft,
            right: modulation.rgt,
            enabled: modulation.enabled,
        });
    }
    Ok(Json(res))
}

#[post("/api/sigint/network-signals-list")]
pub async fn network_signals_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkSignalsListReq>,
) -> Result<Json<NetworkSignalsListRes>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;

    let signals = load_signals_per_network(&env.dbx, req.network_id)
        .await
        .context(h!())?;

    let res = NetworkSignalsListRes {
        signals: signals.clone(),
    };

    Ok(Json(res))
}

#[post("/api/sigint/network/update-posts")]
pub async fn update_network_posts(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkPostsReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    debug!(
        "Update {} posts for network {}; user={}",
        req.post_ids.len(),
        req.network_id,
        user_login
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // 1. Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // 2. Fetch current non-deleted post_ids for the network
    let existing_posts = sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::NetworkId.eq(req.network_id))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .all(&txn)
        .await
        .context(h!())?;
    let existing_post_ids: Vec<i64> =
        existing_posts.iter().map(|np| np.post_id).collect();

    // 3. Determine posts to delete and insert
    let to_delete: Vec<i64> = existing_post_ids
        .iter()
        .filter(|id| !req.post_ids.contains(id))
        .copied()
        .collect();

    let to_insert: Vec<i64> = req
        .post_ids
        .iter()
        .filter(|id| !existing_post_ids.contains(id))
        .copied()
        .collect();

    let is_network_updated = !to_delete.is_empty() || !to_insert.is_empty();

    // 4. Mark deleted ones
    if !to_delete.is_empty() {
        sigint_network_post::Entity::update_many()
            .col_expr(sigint_network_post::Column::Deleted, Expr::value(true))
            .filter(sigint_network_post::Column::NetworkId.eq(req.network_id))
            .filter(sigint_network_post::Column::PostId.is_in(to_delete))
            .exec(&txn)
            .await
            .context(h!())?;
    }

    // 5. Insert missing ones
    for post_id in to_insert {
        let network_post = sigint_network_post::ActiveModel {
            id: NotSet,
            network_id: Set(req.network_id),
            post_id: Set(post_id),
            deleted: NotSet,
            created_at: NotSet,
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        };
        network_post.insert(&txn).await.context(h!())?;
    }

    // 6. Update the network's updated_at timestamp()
    if is_network_updated {
        let mut network_model = network.into_active_model();
        network_model.updated_at = Set(Utc::now().naive_utc());
        network_model.updated_by = Set(Some(user.id()?.to_string()));
        network_model.update(&txn).await.context(h!())?;
    }

    // Now fetch the updated network with all posts to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

/// Редагування списку підрозділів, які належать до мережі
///
/// # API URL
/// - POST: /api/sigint/network/update-units
///
/// # Параметри
///
/// * `user`: [`actix_identity::Identity`] - ідентифікатор користувача, що виконує запит. Використовується для перевірки дозволів.
/// * `env`: [`actix_web::web::Data<Env>`] - де [`Env`] Середовище програми, що містить конфігурацію та підключення до бази даних.
/// * `req`: [`Json<UpdateNetworkUnitsReq>`] - тіло запиту,  де [`UpdateNetworkUnitsReq`] параметри для оновлення списку підрозділів мережі.
///
/// # Повертає
///
/// Функція повертає [`Json<Vec<Network>>`] , де [`Network`] - це структура, що представляє одну мережу.
///
#[post("/api/sigint/network/update-units")]
pub async fn update_network_units(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkUnitsReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    debug!(
        "Update {} units for network {}; user={}",
        req.unit_ids.len(),
        req.network_id,
        user_login
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // 1. Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // 2. Fetch current non-deleted unit_ids for the network
    let existing_units = sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(sigint_network_unit::Column::NetworkId.eq(req.network_id))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(&txn)
        .await
        .context(h!())?;
    let existing_unit_ids: Vec<i64> =
        existing_units.iter().map(|nu| nu.unit_id).collect();

    // 3. Determine units to delete and insert
    let to_delete: Vec<i64> = existing_unit_ids
        .iter()
        .filter(|id| !req.unit_ids.contains(id))
        .copied()
        .collect();

    let to_insert: Vec<i64> = req
        .unit_ids
        .iter()
        .filter(|id| !existing_unit_ids.contains(id))
        .copied()
        .collect();

    let is_network_updated = !to_delete.is_empty() || !to_insert.is_empty();

    // 4. Delete units
    if !to_delete.is_empty() {
        sigint_network_unit::Entity::delete_many()
            .filter(sigint_network_unit::Column::NetworkId.eq(req.network_id))
            .filter(sigint_network_unit::Column::UnitId.is_in(to_delete))
            .exec(&txn)
            .await
            .context(h!())?;
    }

    // 5. Insert missing ones
    for unit_id in to_insert {
        let network_unit = sigint_network_unit::ActiveModel {
            id: NotSet,
            network_id: Set(req.network_id),
            unit_id: Set(unit_id),
            created_at: NotSet,
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        };
        network_unit.insert(&txn).await.context(h!())?;
    }

    // 6. Update the network's updated_at timestamp()
    if is_network_updated {
        let mut network_model = network.into_active_model();
        network_model.updated_at = Set(Utc::now().naive_utc());
        network_model.updated_by = Set(Some(user.id()?.to_string()));
        network_model.update(&txn).await.context(h!())?;
    }

    // Now fetch the updated network with all units to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/add-descriptions")]
pub async fn add_network_descriptions(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddNetworkDescriptionsReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    let txn = env.dbx.begin().await.context(h!())?;

    // Check if network exists
    let (network, network_freqs) =
        sigint_network::Entity::find_by_id(req.network_id)
            .find_with_related(sigint_network_freq::Entity)
            .all(&txn)
            .await
            .context(h!())?
            .into_iter()
            .next()
            .ok_or(AppError::NotFound)?;

    let freq_map = network_freqs
        .into_iter()
        .map(|x| (x.freq, x.id))
        .collect::<BTreeMap<_, _>>();

    let mut network_descr = vec![];

    req.network_descriptions
        .clone()
        .into_iter()
        .map(|descr| {
            map_add_network_description(user_login.clone(), &network, descr)
        })
        .for_each(|d| network_descr.push(d));

    req.frequency_descriptions
        .clone()
        .into_iter()
        .filter_map(|descr| {
            freq_map.get(&descr.freq).map(|id| {
                map_add_network_frequency_description(
                    &user_login,
                    &network,
                    *id,
                    descr,
                )
            })
        })
        .for_each(|d| network_descr.push(d));

    if !network_descr.is_empty() {
        sigint_network_description::Entity::insert_many(network_descr)
            .exec(&txn)
            .await
            .context(h!())?;
    }

    // Update the network's updated_at timestamp
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_login.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/update-description")]
pub async fn update_network_description(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkDescriptionReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    info!(
        "Updating description {} for network {}; user={}",
        req.description_id, req.network_id, user_login
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // Find the description for this network
    let descr_model =
        sigint_network_description::Entity::find_by_id(req.description_id)
            .filter(
                sigint_network_description::Column::NetworkId
                    .eq(req.network_id),
            )
            .filter(sigint_network_description::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .context(h!())?;

    if let Some(descr_model) = descr_model {
        let mut model = descr_model.into_active_model();
        model.r#type =
            Set(NetworkDescriptionType::from(req.descr_type.clone()));
        model.description = Set(req.description.clone());
        model.sigint_network_freq_id = Set(req.network_freq_id);
        model.comment = NotSet; // Set(req.comment.clone());
        model.update(&txn).await.context(h!())?;
    } else {
        debug!(
            "Description {} not found for network {}, no action needed",
            req.description_id, req.network_id
        );
    }

    // Update the network's updated_at timestamp
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_login.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/delete-description")]
pub async fn delete_network_description(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteNetworkDescriptionReq>,
) -> Result<Json<Network>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_login = user.id()?.to_string();

    info!(
        "Removing description {} from network {}; user={}",
        req.description_id, req.network_id, user_login
    );

    let txn = env.dbx.begin().await?;

    // Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;

    // Find the description for this network
    let descr_model =
        sigint_network_description::Entity::find_by_id(req.description_id)
            .filter(
                sigint_network_description::Column::NetworkId
                    .eq(req.network_id),
            )
            .filter(sigint_network_description::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .context(h!())?;

    if let Some(descr_model) = descr_model {
        let mut model = descr_model.into_active_model();
        model.deleted = Set(true);
        model.update(&txn).await.context(h!())?;
    } else {
        debug!(
            "Description {} not found for network {}, no action needed",
            req.description_id, req.network_id
        );
    }

    // Update the network's updated_at timestamp
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_login.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail = bl_network_info_batch(vec![req.network_id], &txn)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

pub async fn oneoff_merge_all_possible_networks(
    mode: crate::types::Mode,
) -> anyhow::Result<(), AppError> {
    info!("> merge_all_possible_networks start");
    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;

    // Fetch all active networks (deleted = false) with their unit_id
    let networks_list = sigint_network::Entity::find()
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkUnit.def(),
        )
        .join(
            sea_orm::JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .select_only()
        .columns([sigint_network::Column::Id, sigint_network::Column::Name])
        .column(sigint_network_unit::Column::UnitId)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Deleted.eq(false))
        .order_by_asc(sigint_network::Column::Id)
        .into_tuple::<(i64, String, i64)>()
        .all(&txn)
        .await
        .context(h!())?;

    // Group networks by (name, unit_id)
    let mut grouped_networks: HashMap<(String, i64), Vec<i64>> =
        std::collections::HashMap::new();
    for (id, name, unit_id) in networks_list {
        grouped_networks
            .entry((name, unit_id))
            .or_default()
            .push(id);
    }

    // Keep track of merged networks to avoid duplicate merges
    let mut merged = HashSet::new();

    println!("Starting network merging process...");
    for ((name, unit_id), network_ids) in grouped_networks {
        let mut iter = network_ids.into_iter();
        if let Some(primary_id) = iter.next() {
            for secondary_id in iter {
                if !merged.contains(&secondary_id) {
                    println!(
                        "Merging network {secondary_id} into network {primary_id} (Name: '{name}', Unit ID: {unit_id})"
                    );

                    // Merge networks
                    if let Err(e) = merge_two_networks(
                        &txn,
                        MERGE_NETWORKS_API_LOGIN.to_string(),
                        true,
                        secondary_id,
                        primary_id,
                    )
                    .await
                    {
                        eprintln!(
                            "❌ Failed to merge network {secondary_id} into {primary_id}: {e}"
                        );
                    }

                    println!(
                        "✅ Successfully merged network {secondary_id} into {primary_id}"
                    );

                    // Mark secondary_id as merged
                    merged.insert(secondary_id);
                }
            }
        }
    }

    println!("Network merging process completed.");
    txn.commit().await.context(h!())?;
    Ok(())
}

pub async fn oneoff_merge_two_networks(
    mode: crate::types::Mode,
    ps: &crate::OneoffMergeNetworksPs,
) -> anyhow::Result<(), AppError> {
    debug!("oneoff_merge_networks");

    let dbx = crate::new_pg_pool_from_mode(mode).await.context(h!())?;
    let txn = dbx.begin().await.context(h!())?;
    let config = crate::config::read_config(mode).context(h!())?;
    let mut redis = crate::new_redis(&config).await.context(h!())?;

    match merge_two_networks(
        &txn,
        MERGE_NETWORKS_API_LOGIN.to_string(),
        true,
        ps.network_id_from,
        ps.network_id_to,
    )
    .await
    {
        Ok(_) => {
            txn.commit().await.context(h!())?;

            let event = EventMsg::new(EventType::ETNetworkChanged);
            fanout(&mut redis, event).await.context(h!())?;

            info!(
                "✅ Merge successful! Merged network {} into {}",
                ps.network_id_from, ps.network_id_to
            );
        }
        Err(e) => {
            txn.rollback().await.context(h!())?;
            error!("❌ Merge failed: {e:?}");
        }
    }

    debug!("oneoff_merge_networks completed");
    Ok(())
}

pub async fn merge_two_networks(
    txn: &DatabaseTransaction,
    login: String,
    perform_merge_check: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<(), AppError> {
    // Fetch both networks
    let network_from =
        find_network(txn, network_id_from).await.context(h!())?;

    let network_to = find_network(txn, network_id_to).await.context(h!())?;

    // Fetch units for both networks
    let unit_from = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_from))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    let unit_to = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_to))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    if perform_merge_check {
        // Validate if merge is allowed (Names should match)
        if network_from.name != network_to.name {
            return Err(AppError::BL {
                msg: "Networks names or kinds mismatch".to_string(),
            });
        }

        // Ensure they belong to the same unit
        if unit_from != unit_to {
            return Err(AppError::BL {
                msg: "Networks belong to different units".to_string(),
            });
        }
    }

    // Reassign frequencies to the new network
    let freqs_to = sigint_network_freq::Entity::find()
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .into_query();

    let freqs_from = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::Freq.not_in_subquery(freqs_to))
        .all(txn)
        .await
        .context(h!())?;

    for freq in freqs_from {
        let id = freq.id;
        let json_old = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;

        let mut freq_model = freq.into_active_model();
        freq_model.network_id = Set(network_id_to);
        freq_model.update(txn).await.context(h!())?;

        // Log the change of an old dentork in the changelog
        let json_new = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_network_freq_changelog::ActiveModel {
            id: NotSet,
            sigint_network_freq_id: Set(id),
            login: Set(login.clone()),
            action: Set(ChangelogActionEnum::Merge),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }

    // Reassign posts to the new network
    let posts_to = sigint_network_post::Entity::find()
        .select_only()
        .column(sigint_network_post::Column::Id)
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .into_query();

    let posts_from = sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .filter(sigint_network_post::Column::Id.not_in_subquery(posts_to))
        .all(txn)
        .await
        .context(h!())?;

    for post in posts_from {
        let mut post_model = post.into_active_model();
        post_model.network_id = Set(network_id_to);
        post_model.update(txn).await.context(h!())?;
    }

    // Reassign descriptions to the new network
    let descriptions_from = sigint_network_description::Entity::find()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    for description in descriptions_from {
        let mut descr_model = description.into_active_model();
        descr_model.network_id = Set(network_id_to);
        descr_model.update(txn).await.context(h!())?;
    }

    // Delete all remaining descriptions in the source network (those not reassigned)
    sigint_network_description::Entity::delete_many()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .exec(txn)
        .await
        .context(h!())?;

    // Delete all remaining posts in the source network (those not reassigned)
    sigint_network_post::Entity::delete_many()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Delete all remaining freqs in the source network (those not reassigned)
    sigint_network_freq::Entity::delete_many()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Update network_to attributes by concatenating only unique values
    let new_location = concat_unique(
        Some(network_to.location.clone()),
        Some(network_from.location.clone()),
    );
    let new_radio_station = concat_unique(
        network_to.radio_station.clone(),
        network_from.radio_station.clone(),
    );

    // Get updated network activity range for the new network
    let (network_active_from, network_active_to) =
        get_network_activity_range(txn, network_id_to)
            .await
            .context(h!())?;

    let mut network_to_model: sigint_network::ActiveModel = network_to.into();
    network_to_model.location = Set(new_location.unwrap_or_default());
    network_to_model.radio_station = Set(new_radio_station);
    network_to_model.updated_at = Set(Utc::now().naive_utc());
    network_to_model.updated_by = Set(Some(login.clone()));
    network_to_model.active_from = Set(network_active_from);
    network_to_model.active_to = Set(network_active_to);
    network_to_model.update(txn).await.context(h!())?;

    // delete old freqs and freqs descriptions
    sigint_network_freq::Entity::delete_many()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Mark network_from as deleted, set merget_to field
    let mut network_from_model: sigint_network::ActiveModel =
        network_from.into();
    network_from_model.deleted = Set(true);
    network_from_model.merged_to = Set(Some(network_id_to));
    network_from_model.updated_at = Set(Utc::now().naive_utc());
    network_from_model.updated_by = Set(Some(login));
    network_from_model.update(txn).await.context(h!())?;

    println!("✅ Merged network {network_id_from} into {network_id_to}");

    Ok(())
}

/// Concatenates unique values from `from` to `to`
/// Only appends `from` if it is not already present in `to` as a separate part
fn concat_unique(to: Option<String>, from: Option<String>) -> Option<String> {
    match (to.as_deref(), from.as_deref()) {
        (Some(to_val), Some(from_val)) => {
            let parts: Vec<&str> = to_val.split('|').collect();
            if parts.contains(&from_val) {
                Some(to_val.to_string()) // Already present, return as is
            } else {
                Some(format!("{to_val}|{from_val}")) // Append uniquely
            }
        }
        (Some(to_val), None) => Some(to_val.to_string()),
        (None, Some(from_val)) => Some(from_val.to_string()),
        _ => None,
    }
}

pub fn display_network_type(input: Option<&str>) -> Result<String, AppError> {
    match input {
        Some("VHF") => Ok("УКХ".to_string()),
        Some("DMRe") => Ok("DMRe".to_string()),
        Some("DMR") => Ok("DMR".to_string()),
        _ => Err(AppError::BL {
            msg: "Unknown network type!".to_string(),
        }),
    }
}

async fn get_network_freqs<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<Vec<NetworkFreq>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .all(txn)
        .await
        .context(h!())?
        .iter()
        .map(|x| NetworkFreq {
            id: x.id,
            network_id: x.network_id,
            freq: x.freq.clone(),
            deleted: x.active_to.is_some(),
            active_to: x.active_to.map(|d| d.and_utc().timestamp_millis()),
            active_from: x.active_from.and_utc().timestamp_millis(),
            created_at: x.created_at.and_utc().timestamp_millis(),
            kind: x.kind.to_value(),
            modulation_id: x.modulation_id,
        })
        .collect())
}

async fn get_network_units<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<Option<Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let units = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| x.unit_id)
        .collect::<Vec<_>>();

    if units.is_empty() {
        Ok(None)
    } else {
        Ok(Some(units))
    }
}

async fn get_network_posts<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?
        .iter()
        .map(|x| x.post_id)
        .collect())
}

async fn get_network_aor_ids<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_network_aor::Entity::find()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| x.aor_id)
        .collect())
}

pub async fn get_network_descriptions<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<Vec<NetworkDescription>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    Ok(sigint_network_description::Entity::find()
        .filter(sigint_network_description::Column::NetworkId.eq(network_id))
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_description::Column::Type)
        .order_by_asc(sigint_network_description::Column::CreatedAt)
        .all(txn)
        .await
        .context(h!())
        .context(h!())?
        .iter()
        .map(|x| NetworkDescription {
            id: x.id,
            network_id: x.network_id,
            network_frequency_id: x.sigint_network_freq_id,
            descr_type: NetworkDescrType::from(x.r#type.clone()),
            description: x.description.clone(),
            // comment: x.comment.clone(),
            login: x.login.clone(),
            created_at: x.created_at.and_utc().timestamp_millis(),
        })
        .collect())
}

fn map_add_network_description(
    user_login: String,
    network: &sigint_network::Model,
    descr: AddNetworkDescription,
) -> sigint_network_description::ActiveModel {
    sigint_network_description::ActiveModel {
        id: NotSet,
        network_id: Set(network.id),
        login: Set(user_login.clone()),
        r#type: Set(NetworkDescriptionType::from(descr.descr_type)),
        description: Set(descr.description),
        sigint_network_freq_id: Set(None),
        comment: NotSet, // Set(descr.comment),
        deleted: Set(false),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
}

fn map_add_network_frequency_description(
    user_login: &str,
    network: &sigint_network::Model,
    freq_id: i64,
    descr: AddNetworkFrequencyDescription,
) -> sigint_network_description::ActiveModel {
    sigint_network_description::ActiveModel {
        id: NotSet,
        network_id: Set(network.id),
        login: Set(user_login.to_owned()),
        r#type: Set(NetworkDescriptionType::from(descr.descr_type)),
        description: Set(descr.description.clone()),
        sigint_network_freq_id: Set(Some(freq_id)),
        comment: NotSet, // Set(descr.comment),
        deleted: Set(false),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
}

/// Знаходить в базі даних діапазон активності мережі на основі активності частот
async fn get_network_activity_range<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<(NaiveDateTime, Option<NaiveDateTime>), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .all(txn)
        .await
        .context(h!())?;

    if freqs.is_empty() {
        return Err(AppError::NotFound);
    }

    let ranges: Vec<(NaiveDateTime, Option<NaiveDateTime>)> = freqs
        .into_iter()
        .map(|f| (f.active_from, f.active_to))
        .collect();

    Ok(compute_network_activity_range(&ranges))
}

/// Обраховує діапазон активності мережі на основі активності частот
fn compute_network_activity_range(
    freq_ranges: &[(NaiveDateTime, Option<NaiveDateTime>)],
) -> (NaiveDateTime, Option<NaiveDateTime>) {
    // Find earliest active_from date
    let network_active_from = freq_ranges
        .iter()
        .map(|(from, _)| *from) // Dereference the borrowed NaiveDateTime
        .min() // Find minimum date
        .unwrap_or_else(|| Utc::now().naive_utc());

    // Find latest active_to date, but only if all frequencies have end dates
    let network_active_to = if !freq_ranges.iter().any(|(_, to)| to.is_none()) {
        // Only proceed if no frequency has None as active_to
        freq_ranges
            .iter()
            .filter_map(|(_, to)| *to) // Extract and dereference Option<NaiveDateTime>
            .max() // Find maximum date
    } else {
        None
    };

    (network_active_from, network_active_to)
}

pub async fn fix_network_areas_of_responsibility(
    db: &DatabaseConnection,
    force_all: bool,
) -> Result<(), AppError> {
    let mut networks = sigint_network::Entity::find().join(
        JoinType::LeftJoin,
        sigint_network::Relation::SigintNetworkAor.def(),
    );
    if !force_all {
        networks = networks.filter(sigint_network_aor::Column::Id.is_null());
    }
    let networks = networks.all(db).await.context(h!())?;
    for n in networks {
        if let Err(e) = insert_network_aor(db, &n, None).await {
            error!("failed to insert group's area of responsibility: {e:?}")
        } else {
            info!("added default aor to network {}", n.id)
        }
    }
    Ok(())
}

async fn insert_network_aor<'a, 'async_trait, C>(
    dbx: &'a C,
    network: &sigint_network::Model,
    aor_id: Option<i64>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let aor = match aor_id {
        Some(id) => area_of_responsibility::Entity::find_by_id(id)
            .one(dbx)
            .await
            .context(h!())?
            .context(h!())?,
        None => sigint::aor::load_default_aor(dbx).await.context(h!())?,
    };
    sigint_network_aor::Entity::delete_many()
        .filter(sigint_network_aor::Column::NetworkId.eq(network.id))
        .exec(dbx)
        .await
        .context(h!())?;
    let network_aor = sigint_network_aor::ActiveModel {
        aor_id: Set(aor.id),
        created_at: NotSet,
        id: NotSet,
        network_id: Set(network.id),
    };
    network_aor.insert(dbx).await.context(h!())?;
    Ok(())
}

async fn save_network_aors(
    txn: &DatabaseTransaction,
    areas_of_responsibility_ids: Vec<i64>,
    network_id: i64,
) -> Result<(), AppError> {
    let mut aor_ids = areas_of_responsibility_ids;
    if aor_ids.is_empty() {
        let default_area =
            sigint::aor::load_default_aor(txn).await.context(h!())?;
        aor_ids.push(default_area.id);
    }

    for aor_id in aor_ids {
        sigint_network_aor::ActiveModel {
            id: NotSet,
            network_id: Set(network_id),
            aor_id: Set(aor_id),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }
    Ok(())
}

pub async fn find_network<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<sigint_network::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let network = sigint_network::Entity::find_by_id(network_id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(network)
}
