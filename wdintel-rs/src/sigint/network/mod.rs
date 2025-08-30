use super::sea_orm_active_enums::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::network::bl::*;
use crate::types::*;
use crate::utils::*;
use chrono::*;
use sea_orm::sea_query::*;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap};

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
use sqlx::FromRow;
use time::{Duration as TimeDuration, PrimitiveDateTime};

pub mod bl;
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

    // debug!(
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
        login: Set(user_login.clone()),
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
            original_id: NotSet,
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
        original_id: NotSet,
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

    let groups = crate::users::get_identity_sigint_groups_noimport(
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
    if let (Some(min_from), Some(max_to)) = (min_from, max_to) {
        let span_days = (max_to - min_from).whole_days();
        if span_days > NETWORK_CALLSIGNS_MAX_WINDOW_DAYS as i64 {
            let cut =
                max_to - TimeDuration::days(NETWORK_CALLSIGNS_MAX_WINDOW_DAYS);
            cutoff_since = Some(cut);
            warn!(
                "network-callsigns: active window {} days > {}, cutting since {}",
                span_days,
                NETWORK_CALLSIGNS_MAX_WINDOW_DAYS,
                cut
            );
        }
    }

    // SeaQuery CTE approach (no raw SQL string construction)
    let network_freqs = Query::select()
        .expr_as(
            Expr::col((SigintNetworkFreq::Table, SigintNetworkFreq::NetworkId)),
            Alias::new("network_id"),
        )
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
                .is_in(req.network_ids.clone()),
        )
        .to_owned();

    let network_freqs_cte = CommonTableExpression::new()
        .query(network_freqs)
        .table_name(Alias::new("network_freqs"))
        .to_owned();

    let mut network_messages = Query::select()
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Freq)),
            Alias::new("freq"),
        )
        .expr_as(
            Expr::col((SigintInboxItem::Table, SigintInboxItem::Datetime)),
            Alias::new("datetime"),
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
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::Deleted)).eq(false),
        )
        .and_where(
            Expr::col((SignalMessage::Table, SignalMessage::GroupMasterKey))
                .is_in(groups),
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

    let nf = Alias::new("network_freqs");
    let nm = Alias::new("network_messages");
    let main_query = Query::select()
        .expr_as(Expr::col((nf.clone(), "network_id")), Alias::new("id"))
        .expr_as(
            Expr::cust(
                "array_to_json(array_agg(DISTINCT network_messages.callsign))",
            ),
            Alias::new("callsigns"),
        )
        .from_as(nf.clone(), nf.clone())
        .join(
            JoinType::InnerJoin,
            nm.clone(),
            Expr::col((nf.clone(), "freq"))
                .equals((nm.clone(), "freq"))
                .and(
                    Expr::col((nm.clone(), "datetime"))
                        .gte(Expr::col((nf.clone(), "active_from"))),
                )
                .and(
                    Expr::col((nm.clone(), "datetime")).lt(Expr::cust(
                        "COALESCE(network_freqs.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
                    )),
                ),
        )
        .group_by_col((nf.clone(), "network_id"))
        .to_owned();

    let combined_query = Query::with()
        .cte(network_freqs_cte)
        .clone()
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

    let _network =
        find_network(&env.dbx, req.network_id).await.context(h!())?;

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
        load_callsigns(&env.dbx, &groups, req.network_id, &all_known_callsigns)
            .await
            .context(h!())?;

    let callsigns = callsigns_raw
        .into_iter()
        .map(|callsign| NetworkCallsignRes {
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
    crate::users::has_any_role(&env.dbx, &user.id()?, vec!["Rer", "Api"])
        .await
        .context(h!())?;

    let _network =
        find_network(&env.dbx, req.network_id).await.context(h!())?;

    let groups = crate::users::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;

    let freqs = load_freqs(&env.dbx, &groups, req.network_id, false)
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
            original_id: NotSet,
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
            original_id: NotSet,
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
        original_id: NotSet,
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
