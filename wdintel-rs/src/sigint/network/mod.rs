use self::types::*;
use super::sea_orm_active_enums::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::rer_importer::reports::{
    cleanup_old_reports_nofail, save_report_log,
};
use std::str::FromStr;

use crate::sigint;
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::network::bl::*;
use crate::sigint::network::merge::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use actix_web::web::Json;
use actix_web::{post, HttpRequest, HttpResponse};
use chrono::*;
use sea_orm::sea_query::*;
use sea_orm::*;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect,
};
use sea_query::{Alias, Expr, Query};
use sqlx::FromRow;
use std::collections::{BTreeSet, HashMap, HashSet};
use time::{Duration as TimeDuration, PrimitiveDateTime};

pub mod bl;
pub mod etalon_calc;
pub mod goi;
pub mod merge;
pub mod oneoff;
pub mod types;

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
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await?;

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

    if let Some(ids) = &req.ids {
        if !ids.is_empty() {
            networks =
                networks.filter(sigint_network::Column::Id.is_in(ids.clone()));
        }
    }

    if !req.show_inactive.unwrap_or(false) {
        networks = networks.filter(sigint_network::Column::ActiveTo.is_null());
    }

    if let Some(filter_unit) = &req.filter_unit {
        networks = networks.filter(Expr::cust_with_values(
            "lower(sigint_unit.name collate \"ru-x-icu\") ilike $1",
            vec![format!("%{}%", filter_unit.to_lowercase())],
        ))
    };

    if req.show_only_further_inverstigation.unwrap_or(false) {
        networks = networks.filter(sigint_network_unit::Column::Id.is_null());
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
                    sigint_network_aor::Column::AorId.eq_any(aor_ids.clone()),
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
            .filter(sigint_network_freq::Column::Deleted.eq(false))
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

    let has_filters = req.filter_freq.is_some()
        || req.filter_unit.is_some()
        || req
            .aor_ids
            .as_ref()
            .map(|aor_ids| !aor_ids.is_empty())
            .unwrap_or(false)
        || req.show_only_further_inverstigation.unwrap_or(false)
        || req.ids.as_ref().map(|ids| !ids.is_empty()).unwrap_or(false);

    if !has_filters {
        networks = networks.order_by_desc(sigint_network::Column::CreatedAt);

        networks = networks.limit(
            req.limit
                .unwrap_or(SIGINT_NETWORK_LIST_DEFAULT_LIMIT)
                .try_into()
                .unwrap_or(SIGINT_NETWORK_LIST_MAX_LIMIT),
        );
    } else if let Some(limit) = req.limit {
        networks = networks
            .limit(limit.try_into().unwrap_or(SIGINT_NETWORK_LIST_MAX_LIMIT));
    }

    if let Some(offset) = req.offset {
        networks = networks.offset(offset.try_into().unwrap_or(0));
    }

    // debug!(
    //     "> networks list sql: {}",
    //     networks.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(&env.dbx).await.context(h!())?;

    let res = render_networks(networks, &env.dbx, &user_id)
        .await
        .context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/restore-network")]
pub async fn restore_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<RestoreNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "Api"]).await?;
    let txn = env.dbx.begin().await.context(h!())?;
    let network_id = req.into_inner().network_id;
    let mut network = find_network(&txn, network_id).await.context(h!())?;
    if network.deleted && network.active_to.is_some() {
        network = bl_restore_network(&txn, network).await.context(h!())?;
    } else {
        error!("user {user_id} attempted to re-activate already active network, skipping...");
    }

    let res = bl_network_info_batch(vec![network_id], &txn, &user_id)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    let res = res.into_iter().next().context(h!())?;
    sigint::network::etalon_calc::invalidate_network_inbox(
        network,
        vec![],
        &env.dbx,
        format!("restoring network {network_id}"),
    )
    .await
    .c(h!())?;
    refresh_network_last_seen_after_state_change(&env.dbx, [network_id])
        .await
        .c(h!())?;
    Ok(Json(res))
}

async fn bl_restore_network(
    txn: &DatabaseTransaction,
    network: sigint_network::Model,
) -> Result<sigint_network::Model, AppError> {
    let mut network = network.into_active_model();
    network.active_from = Set(Some(Utc::now().naive_utc()));
    network.active_to = Set(None);
    network.deleted = Set(false);
    let result = network.update(txn).await.context(h!())?;
    Ok(result)
}

fn apply_network_status(
    network: &mut sigint_network::ActiveModel,
    status: NetworkStatus,
) {
    match status {
        NetworkStatus::NetworkActive => {
            network.active_to = Set(None);
        }
        NetworkStatus::NetworkInactive => {
            network.active_to = Set(Some(Utc::now().naive_utc()));
        }
    }
}

#[post("/api/sigint/network-info-batch-freq")]
pub async fn network_info_batch_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<Vec<String>>,
) -> Result<Json<Vec<Network>>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_freqs(req.into_inner(), &txn, &user_id)
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
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_batch(req.clone(), &txn, &user_id)
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
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
    let txn = env.dbx.begin().await.context(h!())?;
    let res = bl_network_info_batch(vec![req.0], &txn, &user_id)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(Json(res.into_iter().next().context(h!())?))
}

#[post("/api/sigint/create-network")]
pub async fn create_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?;
    let mut network_descr: Vec<sigint_network_description::ActiveModel> =
        vec![];
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    let txn = env.dbx.begin().await.context(h!())?;

    let areas_of_responsibility_ids: Vec<i64> =
        req.area_of_responsibility_ids.clone().unwrap_or_default();

    // Build freq_ranges only if provided
    let freq_ranges: Option<Vec<(NaiveDateTime, Option<NaiveDateTime>)>> =
        req.freqs.as_ref().map(|freqs| {
            freqs
                .iter()
                .map(|f| {
                    let from_millis = f
                        .active_from
                        .unwrap_or_else(|| Utc::now().timestamp_millis());
                    let from = dt_from_millis(from_millis)
                        .unwrap_or_else(|_| Utc::now().naive_utc());

                    let to = f
                        .active_to
                        .and_then(|millis| dt_from_millis(millis).ok());

                    (from, to)
                })
                .collect()
        });

    let (active_from, active_to) = compute_network_activity_range(&freq_ranges);

    let network = sigint_network::ActiveModel {
        id: NotSet,
        name: Set(req.name.clone()),
        location: Set(req.location.clone()),
        deleted: Set(false),
        created_at: NotSet,
        updated_by: Set(Some(user_id.clone())),
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
        original_id: NotSet,
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
        login: Set(user_id.clone()),
        action: Set(ChangelogActionEnum::Create),
        created_at: NotSet,
        new_value: Set(Some(network_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&txn)
    .await
    .context(h!())?;

    if let Some(freqs) = req.freqs.clone() {
        for frequency in freqs {
            let active_from = frequency
                .active_from
                .map(dt_from_millis)
                .transpose()?
                .unwrap_or(Utc::now().naive_utc());
            let active_to =
                frequency.active_to.map(dt_from_millis).transpose()?;
            let freq_id = sigint_network_freq::ActiveModel {
                id: NotSet,
                network_id: Set(network.id),
                freq: Set(frequency.freq.trim().to_string()),
                created_at: NotSet,
                last_seen_dt: NotSet,
                active_from: Set(active_from),
                active_to: Set(active_to),
                kind: Set(SigintNetworkKind::try_from_value(&frequency.kind)?),
                modulation_id: Set(frequency.modulation_id),
                deleted: Set(false),
                sigint_origin_id: NotSet,
                original_id: NotSet,
            }
            .insert(&txn)
            .await
            .context(h!())?
            .id;
            if let Some(descr) = frequency.description {
                network_descr.push(map_add_network_frequency_description(
                    &user_id, &network, freq_id, descr,
                ));
            }
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
                original_id: NotSet,
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
            original_id: NotSet,
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
            map_add_network_description(user_id.clone(), &network, descr)
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

    sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("created network {}", network.id),
    )
    .await
    .c(h!())?;

    let res = render_networks(vec![network], &env.dbx, &user_id)
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
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
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
    network_model.updated_by = Set(Some(user.id().c(h!())?.to_string()));
    network_model.updated_at = Set(Utc::now().naive_utc());
    apply_network_status(&mut network_model, req.status.clone());

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
                model.topic = Set(p.topic.clone().unwrap_or_default());
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

    sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("updated network {}", network.id),
    )
    .await
    .c(h!())?;
    if is_restore_network {
        refresh_network_last_seen_after_state_change(&env.dbx, [network.id])
            .await
            .c(h!())?;
    }

    let res = render_networks(vec![network], &env.dbx, &user_id)
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
    let user_id = user.id().c(h!())?.to_string();
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, user_id.as_str(), "UnitsEditor")
        .await
        .c(h!())?;
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
        login: Set(user_id.clone()),
        action: Set(ChangelogActionEnum::Delete),
        created_at: NotSet,
        new_value: Set(Some(network_json_new)),
        old_value: Set(Some(network_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("deleted network {}", network.id),
    )
    .await
    .c(h!())?;
    refresh_network_last_seen_after_state_change(&env.dbx, [network.id])
        .await
        .c(h!())?;

    let res = render_networks(vec![network], &env.dbx, &user_id)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/network-callsigns")]
pub async fn network_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkCallsignsReq>,
) -> Result<Json<HashMap<String, Vec<String>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    // Compute active window across selected networks (typed row, no try_get)
    #[derive(Debug, FromRow)]
    struct ActiveWindowRow {
        min_from: Option<PrimitiveDateTime>,
        max_to: Option<PrimitiveDateTime>,
    }

    let ActiveWindowRow { min_from, max_to } = sqlx::query_as::<_, ActiveWindowRow>(
        r#"
        SELECT
            min(active_from) AS min_from,
            max(COALESCE(active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) AS max_to
        FROM sigint_network_freq
        WHERE network_id = ANY($1)
        "#,
    )
    .bind(req.network_ids.clone())
    .fetch_one(env.dbx.get_postgres_connection_pool())
    .await
    .context(h!())?;

    let mut cutoff_since: Option<PrimitiveDateTime> = None;
    let mut stats_since: Option<NaiveDateTime> = None;
    let mut stats_till: Option<NaiveDateTime> = None;
    if let (Some(min_from), Some(max_to)) = (min_from, max_to) {
        let span_days = (max_to - min_from).whole_days();
        if span_days > NETWORK_CALLSIGNS_MAX_WINDOW_DAYS {
            let cut =
                max_to - TimeDuration::days(NETWORK_CALLSIGNS_MAX_WINDOW_DAYS);
            cutoff_since = Some(cut);
            warn!(
                "network-callsigns: active window {span_days} days > {NETWORK_CALLSIGNS_MAX_WINDOW_DAYS}, cutting since {cut}"
            );
        }
        let since = cutoff_since.unwrap_or(min_from);
        stats_since = Some(primitive_to_naive_datetime(since)?);
        stats_till = Some(primitive_to_naive_datetime(max_to)?);
    }

    if let (Some(stats_since), Some(stats_till)) = (stats_since, stats_till) {
        if crate::stats::can_read_stats_aggregated(
            &env.config,
            stats_since,
            stats_till,
        ) {
            let callsigns = load_network_callsigns_from_stats(
                &env.dbx,
                &groups,
                &req.network_ids,
                stats_since,
                stats_till,
            )
            .await
            .context(h!())?;
            return Ok(Json(callsigns));
        }
    }

    let mut network_messages = Query::select()
        .expr_as(
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintNetworkId,
            )),
            Alias::new("network_id"),
        )
        .expr_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            Alias::new("callsign"),
        )
        .from(SignalMessage::Table)
        .join(
            JoinType::InnerJoin,
            SigintInboxItem::Table,
            Expr::col((SignalMessage::Table, SignalMessage::Id))
                .equals((SigintInboxItem::Table, SigintInboxItem::Id)),
        )
        .join(
            JoinType::InnerJoin,
            DatasourceGroup::Table,
            Expr::col((SignalMessage::Table, SignalMessage::DatasourceGroupId))
                .equals((DatasourceGroup::Table, DatasourceGroup::Id)),
        )
        .join(
            JoinType::InnerJoin,
            SigintInboxItemNetwork::Table,
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintInboxItemId,
            )),
        )
        .join(
            JoinType::InnerJoin,
            SigintNetwork::Table,
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintNetworkId,
            ))
            .equals((SigintNetwork::Table, SigintNetwork::Id)),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(datasource_group::Column::GroupMasterKey.eq_any(groups))
        .and_where(
            Expr::col((
                SigintInboxItemNetwork::Table,
                SigintInboxItemNetwork::SigintNetworkId,
            ))
            .is_in(req.network_ids.clone()),
        )
        .and_where(
            Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false),
        )
        .to_owned();
    if let Some(cut) = cutoff_since {
        network_messages.and_where(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime))
                .gte(cut),
        );
    }
    let network_messages_cte = CommonTableExpression::new()
        .query(network_messages)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    let nm = Alias::new("network_messages");
    let main_query = Query::select()
        .expr_as(Expr::col((nm.clone(), "network_id")), Alias::new("id"))
        .expr_as(
            Expr::cust(
                "array_to_json(array_agg(DISTINCT network_messages.callsign))",
            ),
            Alias::new("callsigns"),
        )
        .from_as(nm.clone(), nm.clone())
        .group_by_col((nm.clone(), "network_id"))
        .to_owned();

    let combined_query = Query::with()
        .cte(network_messages_cte)
        .clone()
        .query(main_query)
        .to_string(PostgresQueryBuilder);

    let rows = env
        .dbx
        .query_all(Statement::from_string(
            DatabaseBackend::Postgres,
            combined_query,
        ))
        .await
        .context(h!())?;
    let mut callsigns = HashMap::new();
    for row in rows {
        let id: i64 = row.try_get("", "id").context(h!())?;
        let row_callsigns: serde_json::Value =
            row.try_get("", "callsigns").context(h!())?;
        let all_callsigns =
            serde_json::from_value::<Vec<String>>(row_callsigns)
                .unwrap_or_default();
        callsigns.insert(id.to_string(), all_callsigns);
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    if env
        .config
        .feature_group_stats_aggregated
        .unwrap_or(FEATURE_GROUP_STATS_AGGREGATED_DEFAULT)
    {
        let res = load_network_freqs_activity_from_stats(
            &env.dbx,
            &groups,
            req.network_id,
        )
        .await
        .context(h!())?;
        return Ok(Json(res));
    }

    let main_query = Query::select()
    .expr_as(
        Expr::cust("(EXTRACT(EPOCH FROM DATE_TRUNC('day', sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT"),
        Alias::new("day"),
    )
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
        DatasourceGroup::Table,
        Expr::col((SignalMessage::Table, SignalMessage::DatasourceGroupId))
            .equals((DatasourceGroup::Table, DatasourceGroup::Id)),
    )
    .join(
        JoinType::InnerJoin,
        SigintInboxItemNetwork::Table,
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Id)).equals((
            SigintInboxItemNetwork::Table,
            SigintInboxItemNetwork::SigintInboxItemId,
        )),
    )
    .join(
        JoinType::InnerJoin,
        SigintNetwork::Table,
        Expr::col((
            SigintInboxItemNetwork::Table,
            SigintInboxItemNetwork::SigintNetworkId,
        ))
        .equals((SigintNetwork::Table, SigintNetwork::Id)),
    )
    .and_where(Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false))
    .and_where(datasource_group::Column::GroupMasterKey.eq_any(groups))
    .and_where(
        Expr::col((
            SigintInboxItemNetwork::Table,
            SigintInboxItemNetwork::SigintNetworkId,
        ))
        .eq(req.network_id),
    )
    .and_where(Expr::col((SigintNetwork::Table, SigintNetwork::Deleted)).eq(false))
    .add_group_by([
        Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into(),
        Expr::cust("day"),
    ])
    .order_by_expr(Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)).into(), Order::Asc)
    .order_by_expr(Expr::cust("day"), Order::Asc)
    .to_owned();

    let combined_query: String = main_query.to_string(PostgresQueryBuilder);

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

fn primitive_to_naive_datetime(
    dt: PrimitiveDateTime,
) -> Result<NaiveDateTime, AppError> {
    let utc = dt.assume_utc();
    let secs = utc.unix_timestamp();
    let nanos = utc.nanosecond();
    let res = DateTime::from_timestamp(secs, nanos).context(h!())?;
    Ok(res.naive_utc())
}

async fn load_network_callsigns_from_stats(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_ids: &Vec<i64>,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<HashMap<String, Vec<String>>, AppError> {
    #[derive(FromQueryResult)]
    struct CallsignStatRow {
        network_id: i64,
        callsign: String,
    }

    let batches =
        crate::stats::collect_signal_group_batches(groups.clone(), dbx)
            .await
            .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    if batch_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let since_date = crate::stats::get_local_date(since_ts);
    let till_date = crate::stats::get_local_date(till_ts);
    let active_network_ids = sigint_network::Entity::find()
        .select_only()
        .column(sigint_network::Column::Id)
        .filter(sigint_network::Column::Id.eq_any(network_ids.clone()))
        .filter(sigint_network::Column::Deleted.eq(false))
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    if active_network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = stats_group_network_callsign_day::Entity::find()
        .select_only()
        .column(stats_group_network_callsign_day::Column::NetworkId)
        .column(stats_group_network_callsign_day::Column::Callsign)
        .filter(
            stats_group_network_callsign_day::Column::SignalGroupBatchId
                .eq_any(batch_ids),
        )
        .filter(
            stats_group_network_callsign_day::Column::NetworkId
                .eq_any(active_network_ids),
        )
        .filter(stats_group_network_callsign_day::Column::Dt.gte(since_date))
        .filter(stats_group_network_callsign_day::Column::Dt.lte(till_date))
        .group_by(stats_group_network_callsign_day::Column::NetworkId)
        .group_by(stats_group_network_callsign_day::Column::Callsign)
        .into_model::<CallsignStatRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut callsigns: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        callsigns
            .entry(row.network_id.to_string())
            .or_default()
            .push(row.callsign);
    }
    for list in callsigns.values_mut() {
        list.sort();
        list.dedup();
    }
    Ok(callsigns)
}

async fn load_network_freqs_activity_from_stats(
    dbx: &DatabaseConnection,
    groups: &Vec<String>,
    network_id: i64,
) -> Result<HashMap<String, HashMap<String, i64>>, AppError> {
    #[derive(FromQueryResult)]
    struct FreqStatRow {
        dt: NaiveDate,
        frequency: String,
        quantity: i64,
    }

    let batches =
        crate::stats::collect_signal_group_batches(groups.clone(), dbx)
            .await
            .c(h!())?;
    let batch_ids = batches.iter().map(|b| b.id).collect::<Vec<i64>>();
    if batch_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = stats_group_network_freq_day::Entity::find()
        .select_only()
        .column(stats_group_network_freq_day::Column::Dt)
        .column(stats_group_network_freq_day::Column::Frequency)
        .expr_as(Expr::cust("SUM(quantity)"), "quantity")
        .filter(
            stats_group_network_freq_day::Column::SignalGroupBatchId
                .eq_any(batch_ids),
        )
        .filter(stats_group_network_freq_day::Column::NetworkId.eq(network_id))
        .group_by(stats_group_network_freq_day::Column::Dt)
        .group_by(stats_group_network_freq_day::Column::Frequency)
        .into_model::<FreqStatRow>()
        .all(dbx)
        .await
        .c(h!())?;

    let mut res: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for row in rows {
        let day_ms = crate::stats::start_of_day(row.dt)
            .c(h!())?
            .and_utc()
            .timestamp_millis()
            .to_string();
        res.entry(row.frequency)
            .or_default()
            .insert(day_ms, row.quantity);
    }

    Ok(res)
}

#[post("/api/sigint/network-points")]
pub async fn list_network_points(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworkPointsReq>,
) -> Result<Json<ListNetworkPointsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;

    let filter = NetworkFreqFilter {
        active_freqs_only: false,
        since_date_inclusive_ms: Some(req.since_date_inclusive_ms),
        till_date_inclusive_ms: req.till_date_noninclusive_ms,
    };

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let map_points =
        bl_get_network_points(&env.dbx, &groups, req.network_id, Some(&filter))
            .await
            .c(h!())?
            .into_iter()
            .map(|p| NetworkPoint {
                id: p.id,
                body: p.body,
                lat: p.lat,
                lng: p.lng,
            })
            .collect::<Vec<NetworkPoint>>();

    Ok(Json(ListNetworkPointsRsp { points: map_points }))
}

#[post("/api/sigint/update-freq-networks")]
pub async fn update_freq_networks(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateFreqNetworksReq>,
) -> Result<Json<Vec<Network>>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "update freq networks; login = {}; req = {:?}",
        user.id().c(h!())?,
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
            network.updated_by = Set(Some(user.id().c(h!())?.to_string()));
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
                network.updated_by = Set(Some(user.id().c(h!())?.to_string()));
                network.updated_at = NotSet;
                network.save(&txn).await.context(h!())?;

                for unit_id in &req_network.unit_ids {
                    let network_unit = sigint_network_unit::ActiveModel {
                        id: NotSet,
                        network_id: Set(id),
                        unit_id: Set(*unit_id),
                        created_at: NotSet,
                        sigint_origin_id: NotSet,
                        original_id: NotSet,
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
                updated_by: Set(Some(user.id().c(h!())?.to_string())),
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
                    original_id: NotSet,
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
                model.topic = Set(req.topic.clone().unwrap_or_default());
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
        bl_network_info_batch(
            networks.iter().map(|x| x.id).collect(),
            &txn,
            &user_id,
        )
        .await
        .context(h!())?,
    );

    txn.commit().await.context(h!())?;

    let mut last_seen_refresh_network_ids: HashSet<i64> =
        req_network_ids.into_iter().collect();
    last_seen_refresh_network_ids
        .extend(networks.iter().map(|network| network.id));

    for network in networks {
        let network_id = network.id;
        sigint::network::etalon_calc::invalidate_network_inbox(
            network,
            vec![req.freq.clone()],
            &env.dbx,
            format!("updated frequencies for network {}", network_id),
        )
        .await
        .c(h!())?;
    }
    refresh_network_last_seen_after_state_change(
        &env.dbx,
        last_seen_refresh_network_ids,
    )
    .await
    .c(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(result_json)
}

async fn refresh_network_last_seen_after_state_change<I>(
    dbx: &DatabaseConnection,
    network_ids: I,
) -> Result<(), AppError>
where
    I: IntoIterator<Item = i64>,
{
    let network_ids = network_ids.into_iter().collect::<HashSet<_>>();
    crate::stats::recalculate_last_seen_for_networks_exact(
        dbx,
        &network_ids,
        false,
    )
    .await
    .c(h!())?;
    Ok(())
}

#[post("/api/sigint/network/add-freq")]
pub async fn add_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "Adding frequency {} to network {}; user={}",
        req.freq_rec.freq,
        req.network_id,
        user.id().c(h!())?
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
            freq: Set(req.freq_rec.freq.trim().to_string()),
            created_at: NotSet,
            last_seen_dt: NotSet,
            kind: Set(SigintNetworkKind::try_from_value(&req.freq_rec.kind)?),
            modulation_id: Set(req.freq_rec.modulation_id),
            active_from: Set(active_from),
            active_to: Set(active_to),
            deleted: Set(false),
            sigint_origin_id: NotSet,
            original_id: NotSet,
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
            &user_id,
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
    network_model.updated_by = Set(Some(user_id.to_string()));
    network_model.update(&txn).await.context(h!())?;

    let organism_id = login::Entity::find_by_id(user_id.to_string())
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple::<i64>()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "User has no organism assigned".to_string(),
        })?;

    crate::sigint::key::replace_freq_key_links(
        &txn,
        network_freq.network_id,
        network_freq.id,
        &req.freq_rec.encryption_key_ids,
        organism_id,
    )
    .await
    .c(h!())?;

    // Now fetch the updated network with all frequencies to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    crate::sigint::network::etalon_calc::invalidate_network_inbox_for_freq(
        &req.freq_rec.freq,
        network_active_from,
        network_active_to,
        &env.dbx,
        format!("added network frequency from web UI: {}", req.freq_rec.freq),
    )
    .await
    .c(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/reactivate-freq")]
pub async fn reactivate_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ReactivateNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user_id.to_string();

    let req = req.into_inner();
    let txn = env.dbx.begin().await.context(h!())?;

    let network = find_network(&txn, req.network_id).await.context(h!())?;
    let network_freq =
        sigint_network_freq::Entity::find_by_id(req.network_freq_id)
            .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .one(&txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;

    if network_freq.active_to.is_none() {
        return Err(AppError::BL {
            msg: format!(
                "Cannot reactivate frequency row {}: it is already active",
                req.network_freq_id
            ),
        });
    }

    let freq = network_freq.freq.clone();
    let existing_active_freq = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
        .filter(sigint_network_freq::Column::Freq.eq(freq.clone()))
        .filter(sigint_network_freq::Column::Id.ne(req.network_freq_id))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .context(h!())?;
    if existing_active_freq.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "Cannot reactivate frequency {freq}: another active row already exists for this network"
            ),
        });
    }

    let mut network_freq = network_freq.into_active_model();
    network_freq.active_from = Set(Utc::now().naive_utc());
    network_freq.active_to = Set(None);
    network_freq.update(&txn).await.context(h!())?;

    let (network_active_from, network_active_to) =
        get_network_activity_range(&txn, req.network_id)
            .await
            .context(h!())?;

    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.active_from = Set(network_active_from);
    network_model.active_to = Set(network_active_to);
    let network = network_model.update(&txn).await.context(h!())?;

    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![freq.clone()],
        &env.dbx,
        format!("reactivated network frequency from web UI: {freq}"),
    )
    .await
    .c(h!())?;
    refresh_network_last_seen_after_state_change(&env.dbx, [network.id])
        .await
        .c(h!())?;

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/unit-stats")]
pub async fn network_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<NetworkUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

    info!(
        "Updating frequency id={} freq={} for network {}; user={}",
        req.network_freq_id, req.freq, req.network_id, &user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // Check if network exists
    let network = find_network(&txn, req.network_id).await.context(h!())?;
    let updated_freq_active_from =
        update_network_freq_active_from(req.active_from);
    let updated_freq_active_to =
        req.active_to.map(dt_from_millis).transpose()?;
    let mut invalidation_range =
        (Some(updated_freq_active_from), updated_freq_active_to);
    let mut invalidation_freq = req.freq.clone();

    // Find the frequency for this network
    let network_freq_model =
        sigint_network_freq::Entity::find_by_id(req.network_freq_id)
            .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
            .one(&txn)
            .await
            .context(h!())?;

    if let Some(network_freq_model) = network_freq_model {
        let freq = network_freq_model.freq.clone();
        if req.freq != freq {
            return Err(AppError::BL {
                msg: format!(
                    "Frequency id {} belongs to frequency {}, not {}",
                    req.network_freq_id, freq, req.freq
                ),
            });
        }

        let network_freq_id = network_freq_model.id;
        invalidation_range = merge_invalidation_range(
            Some(network_freq_model.active_from),
            network_freq_model.active_to,
            Some(updated_freq_active_from),
            updated_freq_active_to,
        );
        invalidation_freq = freq;

        let mut model = network_freq_model.into_active_model();
        model.kind = Set(SigintNetworkKind::try_from_value(&req.kind)?);
        model.modulation_id = Set(req.modulation_id);
        model.active_from = Set(updated_freq_active_from);
        model.active_to = Set(updated_freq_active_to);
        model.update(&txn).await.context(h!())?;

        let organism_id = login::Entity::find_by_id(user_id.clone())
            .select_only()
            .column(login::Column::OrganismId)
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .c(h!())?
            .ok_or_else(|| AppError::BL {
                msg: "User has no organism assigned".to_string(),
            })?;

        crate::sigint::key::replace_freq_key_links(
            &txn,
            req.network_id,
            network_freq_id,
            &req.encryption_key_ids,
            organism_id,
        )
        .await
        .c(h!())?;
    } else {
        debug!(
            "Frequency id={} freq={} not found for network {}, no action needed",
            req.network_freq_id, req.freq, req.network_id
        );
    }

    let (network_active_from, network_active_to) =
        get_network_activity_range(&txn, req.network_id)
            .await
            .context(h!())?;

    // Update the network's updated_at timestamp as well as new active_from and active_to
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.active_from = Set(network_active_from);
    network_model.active_to = Set(network_active_to);
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    crate::sigint::network::etalon_calc::invalidate_network_inbox_for_freq(
        &invalidation_freq,
        invalidation_range.0,
        invalidation_range.1,
        &env.dbx,
        format!(
            "edited network frequency from web UI: {}",
            network_detail[0].name
        ),
    )
    .await
    .c(h!())?;

    Ok(Json(network_detail[0].clone()))
}

fn update_network_freq_active_from(active_from_millis: i64) -> NaiveDateTime {
    dt_from_millis(active_from_millis).unwrap_or(Utc::now().naive_utc())
}

#[post("/api/sigint/network/delete-freq")]
pub async fn delete_network_freq(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<DeleteNetworkFreqReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let req = req.into_inner();

    info!(
        "Removing frequency id={:?} freq={:?} network={:?}; user={}",
        req.id,
        req.freq,
        req.network_id,
        user.id().c(h!())?
    );

    let txn = env.dbx.begin().await.context(h!())?;

    let freq_records = match req.id {
        Some(id) => {
            let freq_record = sigint_network_freq::Entity::find_by_id(id)
                .one(&txn)
                .await
                .context(h!())?;
            match freq_record {
                Some(freq_record) => {
                    if let Some(network_id) = req.network_id {
                        if network_id != freq_record.network_id {
                            return Err(AppError::BL {
                                msg: format!(
                                    "Frequency id {} belongs to network {}, not {}",
                                    id, freq_record.network_id, network_id
                                ),
                            });
                        }
                    }
                    if let Some(freq) = req.freq.as_ref() {
                        if freq != &freq_record.freq {
                            return Err(AppError::BL {
                                msg: format!(
                                    "Frequency id {} belongs to frequency {}, not {}",
                                    id, freq_record.freq, freq
                                ),
                            });
                        }
                    }
                    vec![freq_record]
                }
                None => vec![],
            }
        }
        None => {
            let network_id = req.network_id.ok_or_else(|| AppError::BL {
                msg: "network_id is required when deleting by frequency"
                    .to_string(),
            })?;
            let freq = req.freq.clone().ok_or_else(|| AppError::BL {
                msg: "freq is required when deleting by frequency".to_string(),
            })?;
            sigint_network_freq::Entity::find()
                .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
                .filter(sigint_network_freq::Column::Freq.eq(freq))
                .filter(sigint_network_freq::Column::Deleted.eq(false))
                .all(&txn)
                .await
                .context(h!())?
        }
    };
    let mut network_detail = None;
    if freq_records.is_empty() {
        let debug_network_id = req.network_id.unwrap_or_default();
        debug!(
            "Frequency {:?} not found for network {:?}, no action needed",
            req.freq, debug_network_id
        );
    } else {
        // Mark all matching frequency connections as deleted
        let network_id = freq_records[0].network_id;
        let freq = freq_records[0].freq.clone();
        for freq_record in freq_records.iter() {
            info!(
                "Removing frequency {:?} (id: {:?}) from network {:?}",
                freq, freq_record.id, network_id
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
            network_model.updated_by =
                Set(Some(user.id().c(h!())?.to_string()));
            network_model.active_from = Set(network_active_from);
            network_model.active_to = Set(network_active_to);
            let network = network_model.update(&txn).await.context(h!())?;

            network_detail = Some(
                bl_network_info_batch(vec![network_id], &txn, &user_id)
                    .await
                    .context(h!())?,
            );

            if let Err(e) =
                sigint::network::etalon_calc::invalidate_network_inbox(
                    network,
                    vec![freq_records[0].freq.clone()],
                    &env.dbx,
                    format!("deleted network {}", network_id),
                )
                .await
            {
                error!("invalidate_network_inbox failed: {:#?}", e);
            }
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
        let _loop_guard = worker_watch::loop_guard("cleanup_networks_worker");
        if let Err(e) = cleanup_networks_worker_1(dbx).await {
            error!("error in cleanup_networks_worker_1: {:?}", e);
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
    let recent_network_cutoff = cleanup_time.naive_utc();

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
            Expr::exists(
                Query::select()
                    .expr(Expr::value(1))
                    .from(sigint_inbox_item_network::Entity)
                    .join(
                        JoinType::InnerJoin,
                        sigint_inbox_item::Entity,
                        Expr::col((
                            sigint_inbox_item_network::Entity,
                            sigint_inbox_item_network::Column::SigintInboxItemId,
                        ))
                        .equals((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Id,
                        )),
                    )
                    .and_where(
                        Expr::col((
                            sigint_inbox_item_network::Entity,
                            sigint_inbox_item_network::Column::SigintNetworkId,
                        ))
                        .equals(sigint_network_freq::Column::NetworkId),
                    )
                    .and_where(
                        Expr::col((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Freq,
                        ))
                        .equals(sigint_network_freq::Column::Freq),
                    )
                    .and_where(
                        Expr::col((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Datetime,
                        ))
                        .gte(cleanup_time),
                    )
                    .and_where(
                        Expr::col((
                            sigint_inbox_item::Entity,
                            sigint_inbox_item::Column::Freq,
                        ))
                        .is_not_null(),
                    )
                    .to_owned(),
            )
            .not(),
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
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let networks_desc =
        load_networks_units_desc(network_ids.clone(), dbx, h!())
            .await
            .context(h!())?;

    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq_any(network_ids.clone()))
        .find_with_related(sigint_network_freq::Entity)
        .all(dbx)
        .await
        .context(h!())?;

    let recent_network_ids: HashSet<i64> = networks
        .iter()
        .filter(|(network, _)| network.created_at > recent_network_cutoff)
        .map(|(network, _)| network.id)
        .collect();

    for (network, network_freqs) in networks {
        let is_recent_network = recent_network_ids.contains(&network.id);
        for network_freq in network_freqs {
            let is_deleted = ids.contains(&network_freq.id);
            if is_deleted && !is_recent_network {
                let mut model = network_freq.into_active_model();
                model.active_to = Set(Some(Utc::now().naive_utc()));
                let network_freq = model.update(dbx).await.context(h!())?;
                if let Err(e) =
                    sigint::network::etalon_calc::invalidate_network_inbox(
                        network.clone(),
                        vec![network_freq.freq],
                        dbx,
                        format!("cleanup worker updates active_to for deleted network {}", network.id),
                    )
                    .await
                {
                    error!("invalidate_network_inbox failed: {:#?}", e);
                }
            }
        }

        let network_id = network.id;
        let (network_active_from, network_active_to) =
            get_network_activity_range(dbx, network_id)
                .await
                .context(h!())?;

        let synthetic_active_to =
            calc_network_synthetic_active_to(dbx, network_id, delta)
                .await
                .context(h!())?;
        let existing_active_to = network.active_to;
        let network_active_to = match existing_active_to {
            Some(_) => existing_active_to,
            None => synthetic_active_to.or(network_active_to),
        };

        if !network.deleted {
            let mut network = network.into_active_model();
            network.active_from = Set(network_active_from);
            if !is_recent_network {
                network.active_to = Set(network_active_to);
            }
            let network = network.update(dbx).await.context(h!())?;
            if let Err(e) =
                sigint::network::etalon_calc::invalidate_network_inbox(
                    network.clone(),
                    vec![],
                    dbx,
                    format!("cleanup worker calculated active_to for inactive network {}", network.id),
                )
                .await
            {
                error!("invalidate_network_inbox failed: {:#?}", e);
            }
        }
    }

    for sigint_network_freq in networks_freqs_to_remove {
        if recent_network_ids.contains(&sigint_network_freq.network_id) {
            continue;
        }

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
            .filter(freq_location::Column::Deleted.eq(false))
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
        .filter(sigint_network::Column::Id.ne_any(network_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(
            sigint_network::Column::CreatedAt
                .lte(start_time - Duration::hours(6)),
        )
        .all(dbx)
        .await
        .context(h!())?;
    for (network, network_freqs) in other_networks {
        let should_delete = network_freqs.is_empty();
        let should_deactivate = network_freqs
            .iter()
            .filter(|x| x.active_to.is_none())
            .count()
            == 0;

        let is_recent_network = network.created_at > recent_network_cutoff;
        let should_apply_deactivation = should_deactivate && !is_recent_network;
        let should_apply_delete = should_delete && !is_recent_network;
        if should_apply_delete || should_apply_deactivation {
            let deleted = network.deleted;
            let no_active_to = network.active_to.is_none();
            let network_id = network.id;
            let mut network = network.into_active_model();
            network.deleted = Set(should_apply_delete);
            if should_apply_deactivation && !deleted && no_active_to {
                let synthetic_active_to =
                    calc_network_synthetic_active_to(dbx, network_id, delta)
                        .await
                        .context(h!())?;
                network.active_to = Set(synthetic_active_to);
            }
            network.update(dbx).await.context(h!())?;
        }
    }
    debug!("cleanup_networks_worker completed");
    Ok(())
}

async fn calc_network_synthetic_active_to(
    dbx: &DatabaseConnection,
    network_id: i64,
    delta: Duration,
) -> Result<Option<NaiveDateTime>, AppError> {
    let last_dt: Option<NaiveDateTime> =
        sigint_inbox_item_network::Entity::find()
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_network::Relation::SigintInboxItem.def(),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintNetworkId
                    .eq(network_id),
            )
            .filter(sigint_inbox_item::Column::Datetime.is_not_null())
            .select_only()
            .column(sigint_inbox_item::Column::Datetime)
            .order_by_desc(sigint_inbox_item::Column::Datetime)
            .into_tuple::<Option<NaiveDateTime>>()
            .one(dbx)
            .await
            .context(h!())?
            .flatten();

    Ok(last_dt.map(|dt| dt + delta))
}

#[post("/api/sigint/merge-network")]
pub async fn merge_network(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<MergeNetworkReq>,
) -> Result<Json<Network>, AppError> {
    let user_id = user.id().c(h!())?.to_string();
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;

    info!(
        "> Merge network {} into {} begin",
        req.network_id_from, req.network_id_to
    );
    let txn = env.dbx.begin().await.context(h!())?;

    merge_two_networks(
        &txn,
        &user_id,
        false,
        false,
        req.network_id_from,
        req.network_id_to,
    )
    .await
    .context(h!())?;

    txn.commit().await.context(h!())?;

    info!(
        "> Merge successful! Merged network {} into {}",
        req.network_id_from, req.network_id_to
    );

    let network = find_network(&env.dbx, req.network_id_to)
        .await
        .context(h!())?;
    let res = render_networks(vec![network.clone()], &env.dbx, &user_id)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;

    sigint::network::etalon_calc::invalidate_network_inbox(
        sigint_network::Entity::find_by_id(req.network_id_from)
            .one(&env.dbx)
            .await
            .c(h!())?
            .c(h!())?,
        vec![],
        &env.dbx,
        format!(
            "merged this network {} to network {}",
            req.network_id_from, req.network_id_to
        ),
    )
    .await
    .context(h!())?;

    sigint::network::etalon_calc::invalidate_network_inbox(
        sigint_network::Entity::find_by_id(req.network_id_to)
            .one(&env.dbx)
            .await
            .c(h!())?
            .c(h!())?,
        vec![],
        &env.dbx,
        format!(
            "merged network {} to this network {}",
            req.network_id_from, req.network_id_to
        ),
    )
    .await
    .context(h!())?;

    Ok(Json(res))
}

#[post("/api/sigint/network-callsigns-list")]
pub async fn network_callsigns_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<SingleNetworkCallsignsReq>,
) -> Result<Json<SingleNetworkCallsignsListRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;

    let _network =
        find_network(&env.dbx, req.network_id).await.context(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let include_activity_info = req.include_activity_info.unwrap_or(true);
    let callsigns_raw = load_callsigns(
        &env.dbx,
        &groups,
        req.network_id,
        None,
        include_activity_info,
        None,
    )
    .await
    .context(h!())?;

    let callsigns = callsigns_raw
        .into_iter()
        .map(|callsign| NetworkCallsignRes {
            is_in_dictionary: env
                .callsigns_whitelist
                .contains(&callsign.callsign),
            callsign: callsign.callsign,
            known_callsigns: callsign.known_callsigns,
            message_count: callsign.message_count,
            last_datetime: callsign.last_datetime,
            freqs: callsign.freqs,
            network_names: callsign.network_names,
            is_old: callsign.is_old,
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
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &user_id, vec!["Rer", "Api"]).await?;

    let _network =
        find_network(&env.dbx, req.network_id).await.context(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let include_callsigns = req.include_callsigns.unwrap_or(true);
    let mut freqs = if env
        .config
        .feature_group_stats_aggregated
        .unwrap_or(FEATURE_GROUP_STATS_AGGREGATED_DEFAULT)
    {
        let counts = load_network_freqs_counts_from_stats(
            &env.dbx,
            &groups,
            req.network_id,
        )
        .await
        .context(h!())?;
        load_freqs_with_stats(
            &env.dbx,
            &groups,
            req.network_id,
            None,
            &user_id,
            counts,
            include_callsigns,
        )
        .await
        .context(h!())?
    } else {
        load_freqs(
            &env.dbx,
            &groups,
            req.network_id,
            None,
            &user_id,
            include_callsigns,
        )
        .await
        .context(h!())?
    };

    let last_datetime_in_aor = load_network_freq_last_datetime_in_aor(
        &env.dbx,
        req.network_id,
        &groups,
    )
    .await
    .context(h!())?;
    for freq in &mut freqs {
        freq.last_datetime_in_aor = last_datetime_in_aor
            .get(&freq.network_freq_id)
            .copied()
            .flatten();
    }

    let res = SingleNetworkFreqsListRsp { freqs };

    Ok(Json(res))
}

#[derive(Debug, FromRow)]
struct NetworkFreqLastDatetimeInAorRow {
    network_freq_id: i64,
    last_datetime_in_aor: Option<PrimitiveDateTime>,
}

async fn load_network_freq_last_datetime_in_aor(
    dbx: &DatabaseConnection,
    network_id: i64,
    groups: &[String],
) -> Result<HashMap<i64, Option<i64>>, AppError> {
    if groups.is_empty() {
        return Ok(HashMap::new());
    }

    let aor_ids = sigint_network_aor::Entity::find()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id))
        .select_only()
        .column(sigint_network_aor::Column::AorId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .context(h!())?;
    if aor_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = sqlx::query_as::<_, NetworkFreqLastDatetimeInAorRow>(
        r#"
        SELECT
            nf.id AS network_freq_id,
            max(ii.datetime) AS last_datetime_in_aor
        FROM sigint_network_freq nf
        JOIN sigint_inbox_item ii
            ON ii.freq = nf.freq
        JOIN signal_message sm
            ON sm.id = ii.id
        JOIN datasource_group dg
            ON dg.id = sm.datasource_group_id
        WHERE nf.network_id = $1
          AND nf.deleted = false
          AND sm.deleted = false
          AND ii.datetime IS NOT NULL
          AND dg.group_master_key = ANY($3)
          AND EXISTS (
              SELECT 1
              FROM signal_message_group smg
              JOIN signal_group_aor sga
                  ON sga.master_key = smg.group_master_key
              JOIN area_of_responsibility linked_aor
                  ON linked_aor.id = sga.aor_id
              JOIN area_of_responsibility selected_aor
                  ON selected_aor.id = ANY($2)
              WHERE smg.signal_message_id = sm.id
                AND linked_aor.deleted = false
                AND selected_aor.deleted = false
                AND (
                    linked_aor.left_bound BETWEEN selected_aor.left_bound AND selected_aor.right_bound
                    OR (
                        linked_aor.left_bound <= selected_aor.left_bound
                        AND linked_aor.right_bound >= selected_aor.right_bound
                    )
                )
          )
        GROUP BY nf.id
        "#,
    )
    .bind(network_id)
    .bind(aor_ids)
    .bind(groups)
    .fetch_all(dbx.get_postgres_connection_pool())
    .await
    .context(h!())?;

    rows.into_iter()
        .map(|row| {
            (
                row.network_freq_id,
                row.last_datetime_in_aor
                    .map(primitive_to_naive_datetime)
                    .transpose(),
            )
        })
        .map(|(network_freq_id, last_datetime_in_aor)| {
            Ok((
                network_freq_id,
                last_datetime_in_aor?.map(|dt| dt.and_utc().timestamp_millis()),
            ))
        })
        .collect::<Result<HashMap<_, _>, AppError>>()
}

#[post("/api/sigint/network-freq-callsigns")]
pub async fn network_freq_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkFreqCallsignsReq>,
) -> Result<Json<NetworkFreqCallsignsRsp>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let callsigns =
        get_callsigns_for_network_freq(&env.dbx, &groups, req.network_freq_id)
            .await
            .context(h!())?;

    Ok(Json(NetworkFreqCallsignsRsp {
        network_freq_id: req.network_freq_id,
        callsigns,
    }))
}

#[post("/api/sigint/modulations-list")]
pub async fn modulations_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<ModulationRec>>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
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
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;

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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

    debug!(
        "Update {} posts for network {}; user={}",
        req.post_ids.len(),
        req.network_id,
        user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // 1. Check if network exists
    let mut network = find_network(&txn, req.network_id).await.context(h!())?;

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
            .filter(sigint_network_post::Column::PostId.eq_any(to_delete))
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
            original_id: NotSet,
        };
        network_post.insert(&txn).await.context(h!())?;
    }

    // 6. Update the network's updated_at timestamp()
    if is_network_updated {
        let mut network_model = network.into_active_model();
        network_model.updated_at = Set(Utc::now().naive_utc());
        network_model.updated_by = Set(Some(user.id().c(h!())?.to_string()));
        network = network_model.update(&txn).await.context(h!())?;
    }

    // Now fetch the updated network with all posts to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    sigint::network::etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("updated posts for network {}", req.network_id),
    )
    .await
    .context(h!())?;

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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

    debug!(
        "Update {} units for network {}; user={}",
        req.unit_ids.len(),
        req.network_id,
        user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;

    // 1. Check if network exists
    let mut network = find_network(&txn, req.network_id).await.context(h!())?;

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
            .filter(sigint_network_unit::Column::UnitId.eq_any(to_delete))
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
            original_id: NotSet,
        };
        network_unit.insert(&txn).await.context(h!())?;
    }

    // 6. Update the network's updated_at timestamp()
    if is_network_updated {
        let mut network_model = network.into_active_model();
        network_model.updated_at = Set(Utc::now().naive_utc());
        network_model.updated_by = Set(Some(user.id().c(h!())?.to_string()));
        network = network_model.update(&txn).await.context(h!())?;
    }

    // Now fetch the updated network with all units to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    sigint::network::etalon_calc::invalidate_network_inbox(
        network,
        vec![],
        &env.dbx,
        format!("updated units for network {}", req.network_id),
    )
    .await
    .context(h!())?;

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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

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
            map_add_network_description(user_id.clone(), &network, descr)
        })
        .for_each(|d| network_descr.push(d));

    req.frequency_descriptions
        .clone()
        .into_iter()
        .filter_map(|descr| {
            freq_map.get(&descr.freq).map(|id| {
                map_add_network_frequency_description(
                    &user_id, &network, *id, descr,
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
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

    info!(
        "Updating description {} for network {}; user={}",
        req.description_id, req.network_id, &user_id
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
        model.topic = Set(req.topic.clone().unwrap_or_default());
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
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
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
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user_id.to_string();

    info!(
        "Removing description {} from network {}; user={}",
        req.description_id, req.network_id, &user_id
    );

    let txn = env.dbx.begin().await.c(h!())?;

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
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.update(&txn).await.context(h!())?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

/// Generate GOI report for network freqs active in the last month
#[post("/api/sigint/network/report-networks-goi")]
pub async fn report_networks_goi(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    info!("> Start GOI report generation...");

    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    cleanup_old_reports_nofail(&env.dbx, &env.config).await;

    let storage_dir =
        std::path::PathBuf::from_str(&env.config.storage_dir).c(h!())?;
    let outfolder = storage_dir.join("reports_log");
    let _ = std::fs::create_dir_all(&outfolder);
    let filename = format!(
        "goi_report_{}.xlsx",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f")
    );
    let outpath = outfolder.join(&filename);

    self::goi::report_xlsx_networks_goi(user, &env, &outpath)
        .await
        .c(h!())?;

    let file = actix_files::NamedFile::open(&outpath)?;
    save_report_log(&env.dbx, format!("reports_log/{filename}"), "", &user_id)
        .await
        .c(h!())?;

    info!("> GOI report generation done");
    Ok(file.into_response(&http_req))
}

fn map_add_network_description(
    user_id: String,
    network: &sigint_network::Model,
    descr: AddNetworkDescription,
) -> sigint_network_description::ActiveModel {
    sigint_network_description::ActiveModel {
        id: NotSet,
        network_id: Set(network.id),
        login: Set(user_id.clone()),
        r#type: Set(NetworkDescriptionType::from(descr.descr_type)),
        topic: Set(descr.topic.unwrap_or_default()),
        description: Set(descr.description),
        sigint_network_freq_id: Set(None),
        comment: NotSet, // Set(descr.comment),
        deleted: Set(false),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
}

fn map_add_network_frequency_description(
    user_id: &str,
    network: &sigint_network::Model,
    freq_id: i64,
    descr: AddNetworkFrequencyDescription,
) -> sigint_network_description::ActiveModel {
    sigint_network_description::ActiveModel {
        id: NotSet,
        network_id: Set(network.id),
        login: Set(user_id.to_owned()),
        r#type: Set(NetworkDescriptionType::from(descr.descr_type)),
        topic: Set(descr.topic.unwrap_or_default()),
        description: Set(descr.description.clone()),
        sigint_network_freq_id: Set(Some(freq_id)),
        comment: NotSet, // Set(descr.comment),
        deleted: Set(false),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
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
            error!(
                "failed to insert network's area of responsibility: {:?}",
                e
            );
        } else {
            info!("added default aor to network {}", n.id);

            let network_id = n.id;
            sigint::network::etalon_calc::invalidate_network_inbox(
                n,
                vec![],
                db,
                format!("fixed AORs for network {}", network_id),
            )
            .await
            .c(h!())?;
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
        sigint_origin_id: NotSet,
        original_id: NotSet,
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
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }
    Ok(())
}

fn merge_invalidation_range(
    old_active_from: Option<NaiveDateTime>,
    old_active_to: Option<NaiveDateTime>,
    new_active_from: Option<NaiveDateTime>,
    new_active_to: Option<NaiveDateTime>,
) -> (Option<NaiveDateTime>, Option<NaiveDateTime>) {
    let since_ts = [old_active_from, new_active_from]
        .into_iter()
        .flatten()
        .min();
    let till_ts = match (old_active_to, new_active_to) {
        (Some(old_ts), Some(new_ts)) => Some(old_ts.max(new_ts)),
        _ => None,
    };
    (since_ts, till_ts)
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn dt(day: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 1, day)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    #[test]
    fn update_network_freq_active_from_preserves_input_day() {
        let active_from_millis = dt(5).and_utc().timestamp_millis();

        let active_from = update_network_freq_active_from(active_from_millis);

        assert_eq!(active_from, dt(5));
    }

    #[test]
    fn merge_invalidation_range_keeps_old_upper_bound_when_window_shrinks() {
        let old_from = Some(dt(1));
        let old_to = None;
        let new_from = Some(dt(1));
        let new_to = Some(dt(10));

        let merged =
            merge_invalidation_range(old_from, old_to, new_from, new_to);

        assert_eq!(merged, (Some(dt(1)), None));
    }

    #[test]
    fn merge_invalidation_range_keeps_old_lower_bound_when_start_moves_later() {
        let old_from = Some(dt(1));
        let old_to = Some(dt(20));
        let new_from = Some(dt(5));
        let new_to = Some(dt(20));

        let merged =
            merge_invalidation_range(old_from, old_to, new_from, new_to);

        assert_eq!(merged, (Some(dt(1)), Some(dt(20))));
    }
}
