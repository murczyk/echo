use self::types::*;
use super::sea_orm_active_enums::*;
use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::sigint;
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::network::bl::*;
use crate::sigint::network::filter::apply_network_list_filters;
use crate::sigint::network::merge::*;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use crate::utils::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::*;
use sea_orm::sea_query::*;
use sea_orm::*;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect,
};
use sea_query::{extension::postgres::PgExpr, Alias, Expr, Query};
use serde_json;
use sqlx::FromRow;
use std::collections::{BTreeSet, HashMap, HashSet};
use time::{Duration as TimeDuration, PrimitiveDateTime};

pub mod bl;
pub mod etalon_calc;
pub mod filter;
pub mod goi;
pub mod merge;
pub mod oneoff;
pub mod relations;
pub mod sort;
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
/// [`Json<ListNetworksRsp>`], де [`Network`] - це структура, що представляє одну мережу.
///

#[post("/api/sigint/network-list")]
pub async fn network_list(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworksReq>,
) -> Result<Json<ListNetworksRsp>, AppError> {
    #[derive(FromQueryResult)]
    struct Row {
        active: i64,
        inactive: i64,
        archived: i64,
    }

    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await?;

    let networks = build_networks_query(&req, NetworkQueryKind::List)
        .all(&env.dbx)
        .await
        .context(h!())?;

    let res = render_networks(networks, &env.dbx, &user_id)
        .await
        .context(h!())?;

    let row = build_networks_counts_query(&req)
        .into_model::<Row>()
        .one(&env.dbx)
        .await
        .context(h!())?
        .context(h!())?;

    Ok(Json(ListNetworksRsp {
        list: res,
        status_counts: ListNetworksStatusCountsRsp {
            active: row.active,
            inactive: row.inactive,
            archived: row.archived,
        },
    }))
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum NetworkQueryKind {
    List,
    Counts,
}

fn build_networks_query(
    req: &ListNetworksReq,
    kind: NetworkQueryKind,
) -> Select<sigint_network::Entity> {
    let mut query = sigint_network::Entity::find();
    query = apply_network_list_filters(
        query,
        req,
        matches!(kind, NetworkQueryKind::List),
    );

    if matches!(kind, NetworkQueryKind::List) {
        query = sort::apply_network_sorts(query, req.sort_by.as_ref());

        let has_filters = req.filter_freq.is_some()
            || req.filter_text.is_some()
            || req.filter_name.is_some()
            || req.filter_location.is_some()
            || req.status_filter.is_some()
            || req.filter_unit.is_some()
            || req.filter_unit_army.is_some()
            || req.filter_unit_division.is_some()
            || req.filter_unit_regiment.is_some()
            || req.filter_unit_battalion.is_some()
            || req
                .aor_ids
                .as_ref()
                .map(|aor_ids| !aor_ids.is_empty())
                .unwrap_or(false)
            || req.show_only_further_inverstigation.unwrap_or(false)
            || req.ids.as_ref().map(|ids| !ids.is_empty()).unwrap_or(false);

        if !has_filters {
            query = query.order_by_desc(sigint_network::Column::CreatedAt);
            query = query.limit(
                req.limit
                    .unwrap_or(SIGINT_NETWORK_LIST_DEFAULT_LIMIT)
                    .try_into()
                    .unwrap_or(SIGINT_NETWORK_LIST_MAX_LIMIT),
            );
        } else if let Some(limit) = req.limit {
            query = query.limit(
                limit.try_into().unwrap_or(SIGINT_NETWORK_LIST_MAX_LIMIT),
            );
        }

        if let Some(offset) = req.offset {
            query = query.offset(offset.try_into().unwrap_or(0));
        }
    }

    query
}

fn build_networks_counts_query(
    req: &ListNetworksReq,
) -> Select<sigint_network::Entity> {
    build_networks_query(req, NetworkQueryKind::Counts)
        .select_only()
        .column_as(
            Expr::cust(
                "COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NULL)",
            ),
            "active",
        )
        .column_as(
            Expr::cust(
                "COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NOT NULL)",
            ),
            "inactive",
        )
        .column_as(
            Expr::cust("COUNT(*) FILTER (WHERE sigint_network.deleted = true)"),
            "archived",
        )
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
    etalon_calc::invalidate_network_inbox(
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

async fn reactivate_network_freqs_for_do_not_archive<'a, 'async_trait, C>(
    dbx: &'a C,
    network_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let network_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .context(h!())?;
    let mut active_freqs = network_freqs
        .iter()
        .filter(|network_freq| network_freq.active_to.is_none())
        .map(|network_freq| network_freq.freq.clone())
        .collect::<HashSet<_>>();
    let mut inactive_freqs = network_freqs
        .into_iter()
        .filter(|network_freq| network_freq.active_to.is_some())
        .collect::<Vec<_>>();
    inactive_freqs.sort_by(|a, b| {
        b.active_to
            .cmp(&a.active_to)
            .then(b.active_from.cmp(&a.active_from))
            .then(b.id.cmp(&a.id))
    });

    for network_freq in inactive_freqs {
        if !active_freqs.insert(network_freq.freq.clone()) {
            continue;
        }
        let mut network_freq = network_freq.into_active_model();
        network_freq.active_from = Set(Utc::now().naive_utc());
        network_freq.active_to = Set(None);
        network_freq.update(dbx).await.context(h!())?;
    }

    Ok(())
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

#[post("/api/sigint/network/find-live")]
pub async fn find_live_networks(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<FindLiveNetworksReq>,
) -> Result<Json<FindLiveNetworksRsp>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_any_role(
        &env.dbx,
        &user_id,
        vec!["Rer", "Api", "ApiAgent"],
    )
    .await?;

    let req = normalize_find_live_networks_req(req.into_inner());
    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;
    let organism_id = load_user_organism_id(&env.dbx, &user_id).await?;
    let network_ids =
        find_live_network_ids(&env.dbx, &groups, &req, organism_id).await?;
    let networks =
        build_find_live_networks(&env.dbx, &groups, &req.freq, network_ids)
            .await?;

    Ok(Json(FindLiveNetworksRsp {
        networks: networks
            .into_iter()
            .take(SIGINT_NETWORK_FIND_LIVE_RETURN_LIMIT)
            .collect(),
    }))
}

fn normalize_find_live_networks_req(
    mut req: FindLiveNetworksReq,
) -> FindLiveNetworksReq {
    req.freq = crate::rer_importer::frequency::etalon(req.freq.trim());
    req.color_code = req
        .color_code
        .map(|cc| cc.trim().to_string())
        .filter(|cc| !cc.is_empty());
    req
}

pub async fn fanout_network_changed(
    env: &actix_web::web::Data<Env>,
) -> Result<(), AppError> {
    let mut redis = env.redis.clone();
    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut redis, event).await.context(h!())?;
    Ok(())
}

async fn find_live_network_ids(
    dbx: &DatabaseConnection,
    groups: &[String],
    req: &FindLiveNetworksReq,
    organism_id: i64,
) -> Result<Vec<i64>, AppError> {
    #[derive(FromQueryResult)]
    struct NetworkIdRow {
        id: i64,
    }

    if req.color_code.is_some() && groups.is_empty() {
        return Ok(vec![]);
    }

    let query = build_find_live_network_ids_query(
        req,
        groups,
        organism_id,
        Utc::now().naive_utc(),
    );

    Ok(query
        .into_model::<NetworkIdRow>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|row| row.id)
        .collect())
}

fn build_find_live_network_ids_query(
    req: &FindLiveNetworksReq,
    groups: &[String],
    organism_id: i64,
    now: NaiveDateTime,
) -> Select<sigint_network::Entity> {
    let mut query = sigint_network::Entity::find()
        .select_only()
        .column(sigint_network::Column::Id)
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(find_live_network_visible_for_organism(organism_id))
        .filter(find_live_network_active_now(now))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(find_live_network_freq_active_now(now))
        .filter(sigint_network_freq::Column::Freq.eq(req.freq.clone()))
        .group_by(sigint_network::Column::Id)
        .order_by_desc(Expr::cust("MAX(sigint_network_freq.last_seen_dt)"))
        .order_by_asc(sigint_network::Column::Id)
        .limit(SIGINT_NETWORK_FIND_LIVE_QUERY_LIMIT);

    if let Some(aor_id) = req.aor_id {
        query = query.filter(Expr::exists(
            sigint_network_aor::Entity::find()
                .select_only()
                .expr(Expr::value(1))
                .filter(
                    sigint_network_aor::Column::NetworkId
                        .into_simple_expr()
                        .eq(sigint_network::Column::Id.into_simple_expr()),
                )
                .filter(sigint_network_aor::Column::AorId.eq(aor_id))
                .into_query(),
        ));
    }

    if let Some(color_code) = req.color_code.as_ref() {
        query = query.filter(find_live_network_color_code_exists(
            &req.freq, color_code, groups,
        ));
    }

    query
}

fn find_live_network_visible_for_organism(organism_id: i64) -> SimpleExpr {
    Expr::cust_with_values(
        r#"
        EXISTS (
            SELECT 1
            FROM organism_aor
            JOIN area_of_responsibility selected_aor
                ON selected_aor.id = organism_aor.aor_id
            WHERE organism_aor.organism_id = $1
              AND selected_aor.deleted = false
              AND EXISTS (
                  SELECT 1
                  FROM sigint_network_aor
                  JOIN area_of_responsibility linked_aor
                      ON linked_aor.id = sigint_network_aor.aor_id
                  WHERE sigint_network_aor.network_id = sigint_network.id
                    AND linked_aor.deleted = false
                    AND (
                        linked_aor.left_bound BETWEEN selected_aor.left_bound
                            AND selected_aor.right_bound
                        OR (
                            linked_aor.left_bound <= selected_aor.left_bound
                            AND linked_aor.right_bound >= selected_aor.right_bound
                        )
                    )
              )
        )
        "#,
        vec![organism_id],
    )
}

fn find_live_network_active_now(now: NaiveDateTime) -> SimpleExpr {
    sigint_network::Column::ActiveTo.is_null().and(
        sigint_network::Column::ActiveFrom
            .is_null()
            .or(sigint_network::Column::ActiveFrom.lte(now)),
    )
}

fn find_live_network_freq_active_now(now: NaiveDateTime) -> SimpleExpr {
    sigint_network_freq::Column::ActiveTo.is_null().and(
        sigint_network_freq::Column::ActiveFrom
            .is_null()
            .or(sigint_network_freq::Column::ActiveFrom.lte(now)),
    )
}

fn find_live_network_color_code_exists(
    freq: &str,
    color_code: &str,
    groups: &[String],
) -> SimpleExpr {
    Expr::exists(
        sigint_inbox_item_network::Entity::find()
            .select_only()
            .expr(Expr::value(1))
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item_network::Relation::SigintInboxItem.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SignalMessage.def(),
            )
            .join(
                JoinType::InnerJoin,
                sigint_inbox_item::Relation::SigintInboxItemMetadata.def(),
            )
            .filter(
                sigint_inbox_item_network::Column::SigintNetworkId
                    .into_simple_expr()
                    .eq(sigint_network::Column::Id.into_simple_expr()),
            )
            .filter(sigint_inbox_item::Column::Freq.eq(freq.to_string()))
            .filter(signal_message::Column::Deleted.eq(false))
            .filter(
                sigint_inbox_item_metadata::Column::ColorCode
                    .eq(color_code.to_string()),
            )
            .filter(Expr::exists(
                signal_message_group::Entity::find()
                    .select_only()
                    .expr(Expr::value(1))
                    .filter(
                        signal_message_group::Column::SignalMessageId
                            .into_simple_expr()
                            .eq(signal_message::Column::Id.into_simple_expr()),
                    )
                    .filter(
                        signal_message_group::Column::GroupMasterKey
                            .eq_any(groups.to_vec()),
                    )
                    .into_query(),
            ))
            .into_query(),
    )
}

async fn build_find_live_networks(
    dbx: &DatabaseConnection,
    groups: &[String],
    freq: &str,
    network_ids: Vec<i64>,
) -> Result<Vec<FindLiveNetwork>, AppError> {
    if network_ids.is_empty() {
        return Ok(vec![]);
    }

    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq_any(network_ids.clone()))
        .all(dbx)
        .await
        .context(h!())?;
    let live_freqs = load_find_live_network_freqs(dbx, &network_ids).await?;
    let unit_names = load_find_live_network_units(dbx, &network_ids).await?;
    let post_ids = load_find_live_network_posts(dbx, &network_ids).await?;
    let callsigns = load_find_live_network_callsigns(dbx, &network_ids).await?;
    let locations =
        load_find_live_network_locations(dbx, groups, freq, &network_ids)
            .await?;

    let network_by_id = networks
        .into_iter()
        .map(|network| (network.id, network))
        .collect::<HashMap<_, _>>();
    let mut result = vec![];
    for network_id in network_ids {
        let Some(network) = network_by_id.get(&network_id) else {
            continue;
        };
        result.push(FindLiveNetwork {
            id: network.id,
            name: network.name.clone(),
            radio_station: network.radio_station.clone(),
            purpose: network.purpose.clone(),
            operation_mode: network.operation_mode.clone(),
            operation_type: network.operation_type.clone(),
            operation_period: network.operation_period.clone(),
            created_at: network.created_at.and_utc().timestamp_millis(),
            active_from: network
                .active_from
                .map(|dt| dt.and_utc().timestamp_millis()),
            units: unit_names.get(&network_id).cloned().unwrap_or_default(),
            post_ids: post_ids.get(&network_id).cloned().unwrap_or_default(),
            live_freqs: live_freqs
                .get(&network_id)
                .cloned()
                .unwrap_or_default(),
            callsigns: callsigns.get(&network_id).cloned().unwrap_or_default(),
            locations: locations.get(&network_id).cloned().unwrap_or_default(),
        });
    }
    Ok(result)
}

async fn load_find_live_network_freqs(
    dbx: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    let rows = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId.eq_any(network_ids.to_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(find_live_network_freq_active_now(Utc::now().naive_utc()))
        .order_by_asc(sigint_network_freq::Column::Freq)
        .all(dbx)
        .await
        .context(h!())?;
    let mut result = HashMap::new();
    for row in rows {
        result
            .entry(row.network_id)
            .or_insert_with(Vec::new)
            .push(row.freq);
    }
    Ok(result)
}

async fn load_find_live_network_units(
    dbx: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    let rows = sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(
            sigint_network_unit::Column::NetworkId.eq_any(network_ids.to_vec()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network_unit::Column::NetworkId)
        .column(sigint_unit::Column::Name)
        .into_tuple::<(i64, String)>()
        .all(dbx)
        .await
        .context(h!())?;
    let mut names = HashMap::new();
    for (network_id, name) in rows {
        names.entry(network_id).or_insert_with(Vec::new).push(name);
    }
    Ok(names)
}

async fn load_find_live_network_posts(
    dbx: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let rows = sigint_network_post::Entity::find()
        .filter(
            sigint_network_post::Column::NetworkId.eq_any(network_ids.to_vec()),
        )
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .context(h!())?;
    let mut result = HashMap::new();
    for row in rows {
        result
            .entry(row.network_id)
            .or_insert_with(Vec::new)
            .push(row.post_id);
    }
    Ok(result)
}

async fn load_find_live_network_callsigns(
    dbx: &DatabaseConnection,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    let rows = sigint_network_callsign::Entity::find()
        .filter(
            sigint_network_callsign::Column::SigintNetworkId
                .eq_any(network_ids.to_vec()),
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_callsign::Column::SigintCallsign)
        .all(dbx)
        .await
        .context(h!())?;
    let mut result = HashMap::new();
    for row in rows {
        result
            .entry(row.sigint_network_id)
            .or_insert_with(Vec::new)
            .push(row.sigint_callsign);
    }
    Ok(result)
}

#[derive(Debug, FromRow)]
struct FindLiveNetworkLocationRow {
    network_id: i64,
    location: Option<String>,
}

async fn load_find_live_network_locations(
    dbx: &DatabaseConnection,
    groups: &[String],
    freq: &str,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    if groups.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, FindLiveNetworkLocationRow>(
        r#"
        SELECT DISTINCT
            iin.sigint_network_id AS network_id,
            COALESCE(NULLIF(ii.location_v2, ''), NULLIF(ii.location, '')) AS location
        FROM sigint_inbox_item_network iin
        JOIN sigint_inbox_item ii ON ii.id = iin.sigint_inbox_item_id
        JOIN signal_message sm ON sm.id = ii.id
        WHERE iin.sigint_network_id = ANY($1)
          AND ii.freq = $2
          AND sm.deleted = false
          AND EXISTS (
              SELECT 1
              FROM signal_message_group smg
              WHERE smg.signal_message_id = sm.id
                AND smg.group_master_key = ANY($3)
          )
          AND COALESCE(NULLIF(ii.location_v2, ''), NULLIF(ii.location, '')) IS NOT NULL
        ORDER BY network_id, location
        "#,
    )
    .bind(network_ids)
    .bind(freq)
    .bind(groups)
    .fetch_all(dbx.get_postgres_connection_pool())
    .await
    .context(h!())?;

    let mut result = HashMap::new();
    for row in rows {
        if let Some(location) = row.location {
            result
                .entry(row.network_id)
                .or_insert_with(Vec::new)
                .push(location);
        }
    }
    Ok(result)
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
    let unit_mask =
        crate::sigint::unit_tag::normalize_unit_mask(req.unit_mask.clone())
            .c(h!())?;
    let has_unit_mask = !unit_mask.is_empty();

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
        do_not_archive: Set(req.do_not_archive),
        unit_mask: Set(serde_json::to_value(unit_mask).context(h!())?),
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
            let encryption_id = normalize_encryption_id_for_modulation(
                &txn,
                &frequency.modulation,
                frequency.encryption_id,
            )
            .await
            .context(h!())?;
            let freq_id = sigint_network_freq::ActiveModel {
                id: NotSet,
                network_id: Set(network.id),
                freq: Set(frequency.freq.trim().to_string()),
                created_at: NotSet,
                last_seen_dt: NotSet,
                active_from: Set(active_from),
                active_to: Set(active_to),
                modulation: Set(frequency.modulation.clone()),
                modulation_id: NotSet,
                kind: Set(kind_from_modulation(&frequency.modulation)),
                encryption_id: Set(encryption_id),
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

    fanout_network_changed(&env).await?;

    etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("created network {}", network.id),
    )
    .await
    .c(h!())?;
    if has_unit_mask {
        crate::sigint::unit_tag::enqueue_recent_non_rer_unit_tag_recalculation(
            &env.dbx,
        )
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
    let unit_mask = req
        .unit_mask
        .clone()
        .map(crate::sigint::unit_tag::normalize_unit_mask)
        .transpose()
        .c(h!())?;

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

    let should_reactivate_for_do_not_archive =
        !network.do_not_archive && req.do_not_archive;
    let mut network_model = network.into_active_model();
    network_model.name = Set(req.name.clone());
    network_model.location = Set(req.location.clone());
    network_model.radio_station = Set(req.radio_station.clone());
    network_model.purpose = Set(req.purpose.clone());
    network_model.operation_mode = Set(req.operation_mode.clone());
    network_model.operation_type = Set(req.operation_type.clone());
    network_model.operation_period = Set(req.operation_period.clone());
    network_model.do_not_archive = Set(req.do_not_archive);
    if let Some(unit_mask) = &unit_mask {
        network_model.unit_mask =
            Set(serde_json::to_value(unit_mask).context(h!())?);
    }
    network_model.updated_by = Set(Some(user.id().c(h!())?.to_string()));
    network_model.updated_at = Set(Utc::now().naive_utc());
    apply_network_status(&mut network_model, req.status.clone());
    if should_reactivate_for_do_not_archive {
        network_model.active_to = Set(None);
    }

    let mut network = network_model.update(&txn).await.context(h!())?;

    if should_reactivate_for_do_not_archive {
        reactivate_network_freqs_for_do_not_archive(&txn, network.id)
            .await
            .context(h!())?;
        let (network_active_from, network_active_to) =
            get_network_activity_range(&txn, network.id)
                .await
                .context(h!())?;
        let mut network_model = network.into_active_model();
        network_model.active_from = Set(network_active_from);
        network_model.active_to = Set(network_active_to);
        network = network_model.update(&txn).await.context(h!())?;
    }

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

    etalon_calc::invalidate_network_inbox(
        network.clone(),
        vec![],
        &env.dbx,
        format!("updated network {}", network.id),
    )
    .await
    .c(h!())?;
    if is_restore_network || should_reactivate_for_do_not_archive {
        refresh_network_last_seen_after_state_change(&env.dbx, [network.id])
            .await
            .c(h!())?;
    }
    if unit_mask.is_some() {
        crate::sigint::unit_tag::enqueue_recent_non_rer_unit_tag_recalculation(
            &env.dbx,
        )
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

    fanout_network_changed(&env).await?;

    etalon_calc::invalidate_network_inbox(
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
                freq: p.freq,
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
        etalon_calc::invalidate_network_inbox(
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

    fanout_network_changed(&env).await?;

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

struct NetworkFreqMutationResult {
    network: sigint_network::Model,
    network_freq_id: i64,
    network_active_from: Option<NaiveDateTime>,
    network_active_to: Option<NaiveDateTime>,
    invalidation_freq: String,
    invalidation_range: (Option<NaiveDateTime>, Option<NaiveDateTime>),
}

async fn finish_network_freq_mutation(
    txn: &DatabaseTransaction,
    user_id: &str,
    network: sigint_network::Model,
    network_id: i64,
    network_freq_id: i64,
    invalidation_freq: String,
    invalidation_range: (Option<NaiveDateTime>, Option<NaiveDateTime>),
) -> Result<NetworkFreqMutationResult, AppError> {
    let (network_active_from, network_active_to) =
        get_network_activity_range(txn, network_id)
            .await
            .context(h!())?;

    let mut network_model = network.into_active_model();
    network_model.active_from = Set(network_active_from);
    network_model.active_to = Set(network_active_to);
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_id.to_string()));
    let network = network_model.update(txn).await.context(h!())?;

    Ok(NetworkFreqMutationResult {
        network,
        network_freq_id,
        network_active_from,
        network_active_to,
        invalidation_freq,
        invalidation_range,
    })
}

async fn load_user_organism_id<'a, 'async_trait, C>(
    dbx: &'a C,
    user_id: &str,
) -> Result<i64, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    login::Entity::find_by_id(user_id.to_string())
        .select_only()
        .column(login::Column::OrganismId)
        .into_tuple::<Option<i64>>()
        .one(dbx)
        .await
        .c(h!())?
        .flatten()
        .ok_or_else(|| AppError::BL {
            msg: "User has no organism assigned".to_string(),
        })
}

async fn load_network_freq_mutation_response(
    env: &Env,
    user: &actix_identity::Identity,
    network_id: i64,
    network_freq_id: i64,
    network: Vec<Network>,
) -> Result<NetworkFreqMutationV2Rsp, AppError> {
    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        user,
        &env.config,
    )
    .await
    .context(h!())?;

    let user_id = user.id().c(h!())?.to_string();
    let mut freq = load_network_freq_row(
        &env.dbx,
        &groups,
        network_id,
        network_freq_id,
        &user_id,
        true,
    )
    .await
    .context(h!())?;

    if let Some(freq_row) = freq.as_mut() {
        let last_datetime_in_aor = load_network_freq_last_datetime_in_aor(
            &env.dbx, network_id, &groups,
        )
        .await
        .context(h!())?;
        freq_row.last_datetime_in_aor = last_datetime_in_aor
            .get(&freq_row.network_freq_id)
            .copied()
            .flatten();
    }

    if network.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(NetworkFreqMutationV2Rsp {
        network: network[0].clone(),
        freq,
    })
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
        let encryption_id = normalize_encryption_id_for_modulation(
            &txn,
            &req.freq_rec.modulation,
            req.freq_rec.encryption_id,
        )
        .await
        .context(h!())?;
        let network_freq = sigint_network_freq::ActiveModel {
            id: NotSet,
            network_id: Set(req.network_id),
            freq: Set(req.freq_rec.freq.trim().to_string()),
            created_at: NotSet,
            last_seen_dt: NotSet,
            modulation: Set(req.freq_rec.modulation.clone()),
            modulation_id: NotSet,
            kind: Set(kind_from_modulation(&req.freq_rec.modulation)),
            encryption_id: Set(encryption_id),
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

    let organism_id = load_user_organism_id(&txn, &user_id).await?;

    sigint::key::replace_freq_key_links(
        &txn,
        network_freq.network_id,
        network_freq.id,
        &req.freq_rec.encryption_key_ids,
        organism_id,
    )
    .await
    .c(h!())?;

    let result = finish_network_freq_mutation(
        &txn,
        &user_id,
        network,
        req.network_id,
        network_freq.id,
        req.freq_rec.freq.clone(),
        (
            req.freq_rec
                .active_from
                .map(dt_from_millis)
                .transpose()?
                .or(Some(Utc::now().naive_utc())),
            req.freq_rec.active_to.map(dt_from_millis).transpose()?,
        ),
    )
    .await?;

    // Now fetch the updated network with all frequencies to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    etalon_calc::invalidate_network_inbox_for_freq(
        &result.invalidation_freq,
        result.network_active_from,
        result.network_active_to,
        &env.dbx,
        format!("added network frequency from web UI: {}", req.freq_rec.freq),
    )
    .await
    .c(h!())?;

    fanout_network_changed(&env).await?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(network_detail[0].clone()))
}

#[post("/api/sigint/network/v2/add-freq")]
pub async fn add_network_freq_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AddNetworkFreqReq>,
) -> Result<Json<NetworkFreqMutationV2Rsp>, AppError> {
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

    let existing_freq = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(req.network_id))
        .filter(sigint_network_freq::Column::Freq.eq(req.freq_rec.freq.clone()))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .one(&txn)
        .await
        .context(h!())?;
    let kind = if &req.freq_rec.modulation == "DMR" {
        &req.freq_rec.modulation
    } else {
        &"VHF".to_string()
    };
    let network_freq = if existing_freq.is_none() {
        let active_from = req
            .freq_rec
            .active_from
            .map(dt_from_millis)
            .transpose()?
            .unwrap_or(Utc::now().naive_utc());
        let active_to =
            req.freq_rec.active_to.map(dt_from_millis).transpose()?;
        let normalized_encryption_id = normalize_encryption_id_for_modulation(
            &txn,
            &req.freq_rec.modulation,
            req.freq_rec.encryption_id,
        )
        .await
        .context(h!())?;
        sigint_network_freq::ActiveModel {
            id: NotSet,
            network_id: Set(req.network_id),
            freq: Set(req.freq_rec.freq.trim().to_string()),
            created_at: NotSet,
            last_seen_dt: NotSet,
            kind: Set(SigintNetworkKind::try_from_value(kind)?),
            modulation: Set(req.freq_rec.modulation.clone()),
            modulation_id: Set(None),
            active_from: Set(active_from),
            active_to: Set(active_to),
            deleted: Set(false),
            sigint_origin_id: NotSet,
            original_id: NotSet,
            encryption_id: Set(normalized_encryption_id),
        }
        .insert(&txn)
        .await
        .context(h!())?
    } else {
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

    sigint::key::replace_freq_key_links(
        &txn,
        network_freq.network_id,
        network_freq.id,
        &req.freq_rec.encryption_key_ids,
        load_user_organism_id(&txn, &user_id).await?,
    )
    .await
    .c(h!())?;

    let result = finish_network_freq_mutation(
        &txn,
        &user_id,
        network,
        req.network_id,
        network_freq.id,
        req.freq_rec.freq.clone(),
        (
            req.freq_rec
                .active_from
                .map(dt_from_millis)
                .transpose()?
                .or(Some(Utc::now().naive_utc())),
            req.freq_rec.active_to.map(dt_from_millis).transpose()?,
        ),
    )
    .await?;

    let network = bl_network_info_batch(vec![req.network_id], &txn, &user_id)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    etalon_calc::invalidate_network_inbox_for_freq(
        &req.freq_rec.freq,
        result.network_active_from,
        result.network_active_to,
        &env.dbx,
        format!("added network frequency from web UI: {}", req.freq_rec.freq),
    )
    .await
    .c(h!())?;
    fanout_network_changed(&env).await?;

    let response = load_network_freq_mutation_response(
        &env,
        &user,
        req.network_id,
        result.network_freq_id,
        network,
    )
    .await?;

    Ok(Json(response))
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

    etalon_calc::invalidate_network_inbox(
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

        let encryption_id = normalize_encryption_id_for_modulation(
            &txn,
            &req.modulation,
            req.encryption_id,
        )
        .await
        .context(h!())?;
        let mut model = network_freq_model.into_active_model();
        model.modulation = Set(req.modulation.clone());
        model.kind = Set(kind_from_modulation(&req.modulation));
        model.encryption_id = Set(encryption_id);
        model.active_from = Set(updated_freq_active_from);
        model.active_to = Set(updated_freq_active_to);
        model.update(&txn).await.context(h!())?;

        let organism_id = load_user_organism_id(&txn, &user_id).await?;

        sigint::key::replace_freq_key_links(
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

    let result = finish_network_freq_mutation(
        &txn,
        &user_id,
        network,
        req.network_id,
        req.network_freq_id,
        invalidation_freq.clone(),
        invalidation_range,
    )
    .await?;

    // Now fetch the updated network with all descriptions, units and freqs to return
    let network_detail =
        bl_network_info_batch(vec![req.network_id], &txn, &user_id)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    if network_detail.is_empty() {
        return Err(AppError::NotFound);
    }

    etalon_calc::invalidate_network_inbox_for_freq(
        &result.invalidation_freq,
        result.invalidation_range.0,
        result.invalidation_range.1,
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

#[post("/api/sigint/network/v2/update-freq")]
pub async fn update_network_freq_v2(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateNetworkFreqReq>,
) -> Result<Json<NetworkFreqMutationV2Rsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .context(h!())?;
    let user_id = user.id().c(h!())?.to_string();

    let req = req.into_inner();
    let txn = env.dbx.begin().await.context(h!())?;

    let network = find_network(&txn, req.network_id).await.context(h!())?;
    let updated_freq_active_from =
        update_network_freq_active_from(req.active_from);
    let updated_freq_active_to =
        req.active_to.map(dt_from_millis).transpose()?;
    let mut invalidation_range =
        (Some(updated_freq_active_from), updated_freq_active_to);
    let mut invalidation_freq = req.freq.clone();

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

        let normalized_encryption_id = normalize_encryption_id_for_modulation(
            &txn,
            &req.modulation,
            req.encryption_id,
        )
        .await
        .context(h!())?;

        let kind = if &req.modulation == "DMR" {
            &req.modulation
        } else {
            &"VHF".to_string()
        };
        let mut model = network_freq_model.into_active_model();
        model.kind = Set(SigintNetworkKind::try_from_value(kind)?);
        model.modulation_id = Set(None);
        model.active_from = Set(updated_freq_active_from);
        model.active_to = Set(updated_freq_active_to);
        model.encryption_id = Set(normalized_encryption_id);
        model.modulation = Set(req.modulation.clone());
        model.update(&txn).await.context(h!())?;

        let organism_id = load_user_organism_id(&txn, &user_id).await?;

        sigint::key::replace_freq_key_links(
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

    let result = finish_network_freq_mutation(
        &txn,
        &user_id,
        network,
        req.network_id,
        req.network_freq_id,
        invalidation_freq.clone(),
        invalidation_range,
    )
    .await?;

    let network = bl_network_info_batch(vec![req.network_id], &txn, &user_id)
        .await
        .context(h!())?;

    txn.commit().await.context(h!())?;

    etalon_calc::invalidate_network_inbox_for_freq(
        &result.invalidation_freq,
        result.invalidation_range.0,
        result.invalidation_range.1,
        &env.dbx,
        format!(
            "edited network frequency from web UI: {}",
            result.network.name
        ),
    )
    .await
    .c(h!())?;

    let response = load_network_freq_mutation_response(
        &env,
        &user,
        req.network_id,
        result.network_freq_id,
        network,
    )
    .await?;

    Ok(Json(response))
}

fn update_network_freq_active_from(active_from_millis: i64) -> NaiveDateTime {
    dt_from_millis(active_from_millis).unwrap_or(Utc::now().naive_utc())
}

/// Normalise encryption_id based on modulation type:
///   DMR / DMRe → keep client-supplied id; if null, default to "Не визначено"
///   "" (unknown) → always "Не визначено"
///   NFM / AM / other → always "Без шифрування" (ignores what the client sent)
async fn normalize_encryption_id_for_modulation(
    db: &impl ConnectionTrait,
    modulation: &str,
    requested_id: Option<i32>,
) -> Result<Option<i32>, AppError> {
    let is_dmr = modulation.eq_ignore_ascii_case("DMR")
        || modulation.eq_ignore_ascii_case("DMRe");
    let is_unknown = modulation.trim().is_empty();
    if is_dmr {
        if requested_id.is_some() {
            return Ok(requested_id);
        }
        let enc_id = encryption::Entity::find()
            .filter(encryption::Column::Name.eq("Не визначено"))
            .select_only()
            .column(encryption::Column::Id)
            .into_tuple::<i32>()
            .one(db)
            .await
            .context(h!())?;
        return Ok(enc_id);
    }
    if is_unknown {
        let enc_id = encryption::Entity::find()
            .filter(encryption::Column::Name.eq("Не визначено"))
            .select_only()
            .column(encryption::Column::Id)
            .into_tuple::<i32>()
            .one(db)
            .await
            .context(h!())?;
        return Ok(enc_id);
    }
    let enc_id = encryption::Entity::find()
        .filter(encryption::Column::Name.eq("Без шифрування"))
        .select_only()
        .column(encryption::Column::Id)
        .into_tuple::<i32>()
        .one(db)
        .await
        .context(h!())?;
    Ok(enc_id)
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

            if let Err(e) = etalon_calc::invalidate_network_inbox(
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
        .filter(sigint_network::Column::DoNotArchive.eq(false))
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
        let do_not_archive = network.do_not_archive;
        for network_freq in network_freqs {
            let is_deleted = ids.contains(&network_freq.id);
            if is_deleted && !is_recent_network && !do_not_archive {
                let mut network_freq = network_freq.into_active_model();
                network_freq.active_to = Set(Some(Utc::now().naive_utc()));
                let network_freq =
                    network_freq.update(dbx).await.context(h!())?;
                if let Err(e) =
                    etalon_calc::invalidate_network_inbox(
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

        let update_active_to = !is_recent_network && !do_not_archive;
        let existing_active_to = network.active_to;
        let network_active_to = if update_active_to {
            let synthetic_active_to =
                calc_network_synthetic_active_to(dbx, network_id, delta)
                    .await
                    .context(h!())?;
            match existing_active_to {
                Some(_) => existing_active_to,
                None => synthetic_active_to.or(network_active_to),
            }
        } else {
            existing_active_to
        };

        if !network.deleted
            && (network.active_from != network_active_from
                || network.active_to != network_active_to)
        {
            let mut network = network.into_active_model();
            network.active_from = Set(network_active_from);
            network.active_to = Set(network_active_to);
            let network = network.update(dbx).await.context(h!())?;
            if let Err(e) =
                etalon_calc::invalidate_network_inbox(
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
        if network.do_not_archive {
            continue;
        }

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

    etalon_calc::invalidate_network_inbox(
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

    etalon_calc::invalidate_network_inbox(
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
    let req = req.into_inner();
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
        req.section,
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
        JOIN sigint_inbox_item_network iin
            ON iin.sigint_network_id = nf.network_id
        JOIN sigint_inbox_item ii
            ON ii.id = iin.sigint_inbox_item_id
           AND ii.freq = nf.freq
        JOIN signal_message sm
            ON sm.id = ii.id
        JOIN datasource_group dg
            ON dg.id = sm.datasource_group_id
        WHERE nf.network_id = $1
          AND nf.deleted = false
          AND sm.deleted = false
          AND ii.datetime IS NOT NULL
          AND dg.group_master_key = ANY($3)
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at) >= nf.active_from
          AND COALESCE(ii.datetime, sm.timestamp, sm.created_at)
                <= COALESCE(nf.active_to, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
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

#[post("/api/sigint/network-freq-callsigns-batch")]
pub async fn network_freq_callsigns_batch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkFreqCallsignsBatchReq>,
) -> Result<Json<NetworkFreqCallsignsBatchRsp>, AppError> {
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

    let callsigns_by_network_freq_id = get_callsigns_for_network_freq_batch(
        &env.dbx,
        &groups,
        &req.network_freq_ids,
    )
    .await
    .context(h!())?;

    let callsigns_by_network_freq_id = callsigns_by_network_freq_id
        .into_iter()
        .map(|(network_freq_id, callsigns)| {
            (network_freq_id.to_string(), callsigns)
        })
        .collect();

    Ok(Json(NetworkFreqCallsignsBatchRsp {
        callsigns_by_network_freq_id,
    }))
}

#[post("/api/sigint/encryptions-list")]
pub async fn encryptions_list(
    env: actix_web::web::Data<Env>,
    user: actix_identity::Identity,
) -> Result<Json<Vec<EncryptionRec>>, AppError> {
    crate::users::has_any_role(
        &env.dbx,
        &user.id().c(h!())?,
        vec!["Rer", "Api"],
    )
    .await?;
    let encryptions = encryption::Entity::find()
        .filter(encryption::Column::Enabled.eq(true))
        .all(&env.dbx)
        .await
        .context(h!())?;
    let mut res: Vec<EncryptionRec> = vec![];
    for enc in encryptions {
        res.push(EncryptionRec {
            id: enc.id,
            name: enc.name.clone(),
            enabled: enc.enabled,
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

    etalon_calc::invalidate_network_inbox(
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

    etalon_calc::invalidate_network_inbox(
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

#[post("/api/sigint/network/report-networks-goi-task-launch")]
pub async fn report_networks_goi_task_launch(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<i64>, AppError> {
    let user_id = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .c(h!())?;
    let filename = format!(
        "goi_report_{}.xlsx",
        Utc::now().format("%Y-%m-%d-%H-%M-%S-%3f")
    );
    let report_history = crate::report_history::enqueue_report(
        &env.dbx,
        &user_id,
        crate::report_history::KIND_GOI,
        crate::report_history::ReportHistoryRequest::GoiReport {
            payload: serde_json::json!({}),
        },
        Some(filename),
        Some(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                .to_string(),
        ),
    )
    .await
    .c(h!())?;
    Ok(Json(report_history.id))
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
        Some("NFM") => Ok("УКХ".to_string()),
        Some("DMRe") => Ok("DMRe".to_string()),
        Some("DMR") => Ok("DMR".to_string()),
        Some("AM") => Ok("AM".to_string()),
        _ => Err(AppError::BL {
            msg: "Unknown network type!".to_string(),
        }),
    }
}

fn kind_from_modulation(modulation: &str) -> SigintNetworkKind {
    match modulation {
        "NFM" | "AM" | "" => SigintNetworkKind::Vhf,
        _ => SigintNetworkKind::Dmr,
    }
}

#[post("/api/sigint/network-name/search")]
pub async fn network_name_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkSearchReq>,
) -> Result<Json<NetworkSearchRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Rer"])
        .await
        .c(h!())?;

    let search_phrase = req.search.trim();

    let mut query = sigint_network::Entity::find()
        .filter(sigint_network::Column::Deleted.eq(false));

    if !search_phrase.is_empty() {
        query = query.filter(Expr::col(sigint_network::Column::Name).ilike(format!("%{}%", search_phrase)));
    }

    let networks = query
        .order_by(sigint_network::Column::Name, Order::Asc)
        .limit(50)
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|network| NetworkSearchResult {
            id: network.id,
            name: network.name,
        })
        .collect();

    Ok(Json(NetworkSearchRsp { networks }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_sigint_network, mk_sigint_network_freq,
    };
    use crate::sigint::network::filter::tokenize_search_text;
    use chrono::NaiveDate;
    use serial_test::serial;

    fn dt(day: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 1, day)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn empty_list_networks_req() -> ListNetworksReq {
        ListNetworksReq {
            filter_freq: None,
            filter_unit: None,
            filter_unit_army: None,
            filter_unit_division: None,
            filter_unit_regiment: None,
            filter_unit_battalion: None,
            filter_text: None,
            filter_name: None,
            filter_location: None,
            show_only_further_inverstigation: None,
            show_inactive: None,
            show_only_deleted: None,
            status_filter: None,
            aor_ids: None,
            ids: None,
            limit: None,
            offset: None,
            sort_by: None,
        }
    }

    #[test]
    fn update_network_freq_active_from_preserves_input_day() {
        let active_from_millis = dt(5).and_utc().timestamp_millis();

        let active_from = update_network_freq_active_from(active_from_millis);

        assert_eq!(active_from, dt(5));
    }

    #[test]
    fn find_live_network_ids_query_requires_open_ended_active_records() {
        let req = FindLiveNetworksReq {
            freq: "145.026".to_string(),
            aor_id: None,
            color_code: None,
        };

        let sql = build_find_live_network_ids_query(&req, &[], 42, dt(5))
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("FROM organism_aor"));
        assert!(sql.contains("organism_aor.organism_id = 42"));
        assert!(sql.contains("FROM sigint_network_aor"));
        assert!(sql
            .contains("linked_aor.left_bound BETWEEN selected_aor.left_bound"));
        assert!(sql.contains("\"sigint_network\".\"active_to\" IS NULL"));
        assert!(sql.contains("\"sigint_network\".\"active_from\" IS NULL"));
        assert!(sql.contains("\"sigint_network\".\"active_from\" <= "));
        assert!(sql.contains("\"sigint_network_freq\".\"active_to\" IS NULL"));
        assert!(sql.contains("\"sigint_network_freq\".\"active_from\" IS NULL"));
        assert!(sql.contains("\"sigint_network_freq\".\"active_from\" <= "));
    }

    #[test]
    fn find_live_network_color_code_query_requires_visible_live_message() {
        let req = FindLiveNetworksReq {
            freq: "145.026".to_string(),
            aor_id: None,
            color_code: Some("7".to_string()),
        };
        let groups = vec!["group-a".to_string()];

        let sql = build_find_live_network_ids_query(&req, &groups, 42, dt(5))
            .build(DbBackend::Postgres)
            .to_string();
        let sql_lowercase = sql.to_lowercase();

        assert!(sql.contains("JOIN \"signal_message\""));
        assert!(
            sql_lowercase.contains("\"signal_message\".\"deleted\" = false")
        );
        assert!(sql.contains("FROM \"signal_message_group\""));
        assert!(sql.contains("\"signal_message_group\".\"group_master_key\""));
        assert!(sql.contains("'group-a'"));
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

    #[test]
    fn counts_query_ignores_list_status_scope() {
        let mut req = empty_list_networks_req();
        req.status_filter = Some(ListNetworksStatusFilter::ListNetworksActive);
        req.show_only_deleted = Some(true);
        req.show_inactive = Some(false);
        req.limit = Some(5);
        req.offset = Some(10);
        req.sort_by = Some(vec![ListNetworksSortBy::NameDesc]);

        let sql = build_networks_counts_query(&req)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(!sql.contains("LIMIT"));
        assert!(!sql.contains("ORDER BY"));
        assert!(!sql.contains("GROUP BY"));
        assert!(sql.contains("COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NULL)"));
        assert!(sql.contains("COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NOT NULL)"));
        assert!(sql
            .contains("COUNT(*) FILTER (WHERE sigint_network.deleted = true)"));
    }

    #[test]
    fn list_query_with_text_filter_does_not_apply_default_limit() {
        let mut req = empty_list_networks_req();
        req.filter_text = Some("abc".to_string());

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn tokenize_search_text_drops_display_tokens_and_punctuation() {
        assert_eq!(
            tokenize_search_text(" р/м 1 мсб, 423 мсп "),
            vec![
                "1".to_string(),
                "мсб".to_string(),
                "423".to_string(),
                "мсп".to_string(),
            ],
        );
    }

    #[test]
    fn list_query_with_name_filter_uses_normalized_boundaries_for_label_tokens()
    {
        let mut req = empty_list_networks_req();
        req.filter_name = Some("1 мсб 83 мсп".to_string());

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains(
            "concat(' ', regexp_replace(lower(sigint_network.name collate \"ru-x-icu\"), '[[:punct:][:space:]]+', ' ', 'g'), ' ') ilike"
        ));
        assert!(sql.contains(
            "concat(' ', regexp_replace(lower(sigint_unit.name collate \"ru-x-icu\"), '[[:punct:][:space:]]+', ' ', 'g'), ' ') ilike"
        ));
        assert!(!sql
            .contains("lower(sigint_network.name collate \"ru-x-icu\") ilike"));
        assert!(
            !sql.contains("lower(sigint_unit.name collate \"ru-x-icu\") ilike")
        );
        assert!(
            sql.matches(
                "concat(' ', regexp_replace(lower(sigint_network.name collate \"ru-x-icu\"), '[[:punct:][:space:]]+', ' ', 'g'), ' ') ilike"
            )
            .count()
                >= 2
        );
        assert!(
            sql.matches("regexp_replace(lower(sigint_unit.name collate \"ru-x-icu\"), '[[:punct:][:space:]]+', ' ', 'g')")
                .count()
                >= 2
        );
        assert!(!sql.contains("lower(lower("));
        assert!(!sql.contains(
            "lower(sigint_network.location collate \"ru-x-icu\") ilike"
        ));
    }

    #[test]
    fn list_query_with_global_text_filter_searches_visible_row_fields() {
        let mut req = empty_list_networks_req();
        req.filter_text = Some("423 kyiv".to_string());

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql
            .contains("lower(sigint_network.name collate \"ru-x-icu\") ilike"));
        assert!(sql.contains(
            "lower(sigint_network.location collate \"ru-x-icu\") ilike"
        ));
        assert!(sql.contains(
            "lower(sigint_network.radio_station collate \"ru-x-icu\") ilike"
        ));
        assert!(
            sql.contains("lower(sigint_unit.name collate \"ru-x-icu\") ilike")
        );
        assert!(sql.contains(
            "lower(sigint_network_freq.freq collate \"ru-x-icu\") ilike"
        ));
        assert!(
            sql.contains("lower(sigint_aor.name collate \"ru-x-icu\") ilike")
        );
        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn list_query_with_numeric_global_text_filter_uses_valid_aor_alias() {
        let mut req = empty_list_networks_req();
        req.filter_text = Some("336".to_string());

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql
            .contains("lower(sigint_network.name collate \"ru-x-icu\") ilike"));
        assert!(sql.contains(
            "lower(sigint_network.location collate \"ru-x-icu\") ilike"
        ));
        assert!(sql.contains(
            "lower(sigint_network.radio_station collate \"ru-x-icu\") ilike"
        ));
        assert!(
            sql.contains("lower(sigint_unit.name collate \"ru-x-icu\") ilike")
        );
        assert!(sql.contains(
            "lower(sigint_network_freq.freq collate \"ru-x-icu\") ilike"
        ));
        assert!(
            sql.contains("lower(sigint_aor.name collate \"ru-x-icu\") ilike")
        );
        assert!(sql.contains("\"sigint_aor\".\"deleted\" = false"));
        assert!(!sql.contains(
            "lower(area_of_responsibility.name collate \"ru-x-icu\") ilike"
        ));
        assert!(!sql.contains("area_of_responsibility.deleted = false"));
    }

    #[test]
    fn list_query_with_status_filter_does_not_apply_default_limit() {
        let mut req = empty_list_networks_req();
        req.status_filter =
            Some(ListNetworksStatusFilter::ListNetworksInactive);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn list_query_sorts_by_last_activity_with_stable_secondary_keys() {
        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::LastActivityDesc]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("\"sigint_network\".\"updated_at\" DESC"));
        assert!(sql.contains("\"sigint_network\".\"name\" ASC"));
        assert!(sql.contains("\"sigint_network\".\"id\" ASC"));
    }

    #[test]
    fn list_query_sorts_by_location_with_stable_secondary_keys() {
        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::LocationAsc]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("\"sigint_network\".\"location\" ASC"));
        assert!(sql.contains("\"sigint_network\".\"name\" ASC"));
        assert!(sql.contains("\"sigint_network\".\"id\" ASC"));
    }

    #[test]
    fn list_query_sorts_by_freq_with_first_active_frequency_expression() {
        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::NetworkFreqAsc]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("CASE WHEN (SELECT MIN(sigint_network_freq.freq COLLATE \"ru-x-icu\")"));
        assert!(
            sql.contains("sigint_network_freq.network_id = sigint_network.id")
        );
        assert!(sql.contains("sigint_network_freq.deleted = false"));
        assert!(sql.contains("sigint_network_freq.active_to IS NULL"));
        assert!(sql.contains("\"sigint_network\".\"name\" ASC"));
        assert!(sql.contains("\"sigint_network\".\"id\" ASC"));
    }

    #[test]
    fn list_query_sorts_by_aor_with_first_name_expression() {
        let mut req = empty_list_networks_req();
        req.sort_by = Some(vec![ListNetworksSortBy::AorDesc]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("CASE WHEN (SELECT MIN(area_of_responsibility.name COLLATE \"ru-x-icu\")"));
        assert!(
            sql.contains("sigint_network_aor.network_id = sigint_network.id")
        );
        assert!(sql.contains("area_of_responsibility.deleted = false"));
        assert!(sql.contains("DESC"));
        assert!(sql.contains("\"sigint_network\".\"name\" ASC"));
        assert!(sql.contains("\"sigint_network\".\"id\" ASC"));
    }

    #[test]
    fn aor_filter_supports_no_aor_only() {
        let mut req = empty_list_networks_req();
        req.aor_ids = Some(vec![-1]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("NOT EXISTS"));
    }

    #[test]
    fn aor_filter_supports_mixed_no_aor_and_regular() {
        let mut req = empty_list_networks_req();
        req.aor_ids = Some(vec![-1, 42]);

        let sql = build_networks_query(&req, NetworkQueryKind::List)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("NOT EXISTS"));
        assert!(sql.contains("EXISTS"));
    }

    #[test]
    fn counts_query_with_name_and_location_filters_keeps_status_scope_open() {
        let mut req = empty_list_networks_req();
        req.filter_name = Some("alpha".to_string());
        req.filter_location = Some("kyiv".to_string());
        req.status_filter =
            Some(ListNetworksStatusFilter::ListNetworksArchived);

        let sql = build_networks_counts_query(&req)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("regexp_replace"));
        assert!(sql.contains("sigint_network.name"));
        assert!(sql.contains("sigint_network.location"));
        assert!(!sql.contains("lower(lower("));
        assert!(sql.contains("COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NULL)"));
        assert!(sql.contains("COUNT(*) FILTER (WHERE sigint_network.deleted = false AND sigint_network.active_to IS NOT NULL)"));
        assert!(sql
            .contains("COUNT(*) FILTER (WHERE sigint_network.deleted = true)"));
    }

    fn cleanup_old_dt() -> NaiveDateTime {
        Utc::now().naive_utc()
            - Duration::days(CLEANUP_NETWORKS_CUTOFF_TIME_DAYS + 2)
    }

    #[tokio::test]
    #[serial]
    async fn do_not_archive_reactivation_reopens_closed_frequency_rows() {
        let env = cleanup().await.unwrap();
        let old_dt = cleanup_old_dt();
        let closed_dt = old_dt + Duration::days(1);
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Protected reactivation".to_string()),
                created_at: Set(old_dt),
                updated_at: Set(old_dt),
                active_from: Set(Some(old_dt)),
                active_to: Set(Some(closed_dt)),
                do_not_archive: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let closed_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.7000".to_string()),
                active_from: Set(old_dt),
                active_to: Set(Some(closed_dt)),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let active_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.8000".to_string()),
                active_from: Set(old_dt),
                active_to: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let closed_duplicate_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(active_freq.freq.clone()),
                active_from: Set(old_dt),
                active_to: Set(Some(closed_dt)),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let deleted_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.9000".to_string()),
                active_from: Set(old_dt),
                active_to: Set(Some(closed_dt)),
                deleted: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        reactivate_network_freqs_for_do_not_archive(&env.dbx, network.id)
            .await
            .unwrap();
        let (_, network_active_to) =
            get_network_activity_range(&env.dbx, network.id)
                .await
                .unwrap();

        let closed_freq =
            sigint_network_freq::Entity::find_by_id(closed_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let closed_duplicate_freq =
            sigint_network_freq::Entity::find_by_id(closed_duplicate_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let deleted_freq =
            sigint_network_freq::Entity::find_by_id(deleted_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();

        assert_eq!(network_active_to, None);
        assert_eq!(closed_freq.active_to, None);
        assert!(closed_duplicate_freq.active_to.is_some());
        assert!(deleted_freq.active_to.is_some());
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_worker_keeps_protected_active_network_and_frequency_active(
    ) {
        let env = cleanup().await.unwrap();
        let old_dt = cleanup_old_dt();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Protected active".to_string()),
                created_at: Set(old_dt),
                updated_at: Set(old_dt),
                active_from: Set(Some(old_dt)),
                do_not_archive: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.5000".to_string()),
                active_from: Set(old_dt),
                active_to: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        cleanup_networks_worker_1(&env.dbx).await.unwrap();
        cleanup_networks_worker_1(&env.dbx).await.unwrap();

        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let network_freq =
            sigint_network_freq::Entity::find_by_id(network_freq.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(!network.deleted);
        assert_eq!(network.active_to, None);
        assert_eq!(network_freq.active_to, None);

        let invalidation_task_count = network_invalidation_task::Entity::find()
            .filter(
                network_invalidation_task::Column::SigintNetworkId
                    .eq(network.id),
            )
            .count(&env.dbx)
            .await
            .unwrap();
        assert_eq!(invalidation_task_count, 0);
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_worker_keeps_protected_empty_network_unarchived() {
        let env = cleanup().await.unwrap();
        let old_dt = cleanup_old_dt();
        seed_stale_freq_network(&env.dbx, old_dt, "Cleanup scan trigger").await;
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Protected empty".to_string()),
                created_at: Set(old_dt),
                updated_at: Set(old_dt),
                active_from: Set(Some(old_dt)),
                do_not_archive: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        cleanup_networks_worker_1(&env.dbx).await.unwrap();

        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(!network.deleted);
        assert_eq!(network.active_to, None);
    }

    #[tokio::test]
    #[serial]
    async fn cleanup_worker_archives_unprotected_empty_network() {
        let env = cleanup().await.unwrap();
        let old_dt = cleanup_old_dt();
        seed_stale_freq_network(&env.dbx, old_dt, "Cleanup scan trigger").await;
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Unprotected empty".to_string()),
                created_at: Set(old_dt),
                updated_at: Set(old_dt),
                active_from: Set(Some(old_dt)),
                do_not_archive: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        cleanup_networks_worker_1(&env.dbx).await.unwrap();

        let network = sigint_network::Entity::find_by_id(network.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(network.deleted);
    }

    async fn seed_stale_freq_network(
        dbx: &DatabaseConnection,
        old_dt: NaiveDateTime,
        name: &str,
    ) {
        let network = mk_sigint_network(
            dbx,
            sigint_network::ActiveModel {
                name: Set(name.to_string()),
                created_at: Set(old_dt),
                updated_at: Set(old_dt),
                active_from: Set(Some(old_dt)),
                do_not_archive: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_freq(
            dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.6000".to_string()),
                active_from: Set(old_dt),
                active_to: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
}
