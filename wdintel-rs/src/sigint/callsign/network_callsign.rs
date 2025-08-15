use crate::entities::*;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use chrono::*;
use sea_orm::QuerySelect;
use sea_orm::*;
use sea_query::JoinType;

use crate::sigint::callsign::types::*;

#[post("/api/sigint/network-callsigns")]
pub async fn list_network_callsigns(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListNetworkCallsignsReq>,
) -> Result<Json<ListNetworkCallsignsRes>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer").await?;

    trace!("network_callsigns; login: {}; req: {:?}", user.id()?, req);

    let mut query = sigint_network_callsign::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintCallsign.def(),
        )
        .join_rev(
            JoinType::LeftJoin,
            sigint_unit::Relation::SigintCallsign.def(),
        )
        .select_also(sigint_callsign::Entity)
        .select_also(sigint_unit::Entity)
        .filter(
            sigint_network_callsign::Column::SigintNetworkId.eq(req.network_id),
        )
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_callsign::Column::Deleted.eq(false))
                .add(sigint_callsign::Column::Deleted.is_null()),
        );

    // Apply sorting based on request
    query = if let Some(sort_by) = &req.sort_by {
        sort_by.iter().fold(
            query,
            |query, sort_by: &ListNetworkCallsignsSortBy| match sort_by {
                ListNetworkCallsignsSortBy::NetworkCallsignAsc => query
                    .order_by_asc(
                        sigint_network_callsign::Column::SigintCallsign,
                    ),
                ListNetworkCallsignsSortBy::NetworkCallsignDesc => query
                    .order_by_desc(
                        sigint_network_callsign::Column::SigintCallsign,
                    ),
                ListNetworkCallsignsSortBy::NetworkCallsignCreatedAtAsc => {
                    query.order_by_asc(
                        sigint_network_callsign::Column::CreatedAt,
                    )
                }
                ListNetworkCallsignsSortBy::NetworkCallsignCreatedAtDesc => {
                    query.order_by_desc(
                        sigint_network_callsign::Column::CreatedAt,
                    )
                }
            },
        )
    } else {
        // Default sorting (original behavior)
        query.order_by_asc(sigint_network_callsign::Column::SigintCallsign)
    };

    // debug!(
    //     "network_callsigns query sql: {}",
    //     query.build(DbBackend::Postgres).to_string()
    // );

    let network_callsigns: Vec<(
        sigint_network_callsign::Model,
        Option<sigint_callsign::Model>,
        Option<sigint_unit::Model>,
    )> = query.all(&env.dbx).await.context(h!())?;

    let mut res = vec![];
    for (network_callsign, known_callsign, unit) in network_callsigns {
        let nc =
            render_network_callsign(&network_callsign, known_callsign, unit)?;

        res.push(nc);
    }
    Ok(Json(ListNetworkCallsignsRes {
        network_callsigns: res,
    }))
}

pub async fn bl_network_callsigns_batch(
    callsign_ids: Vec<i64>,
    txn: &DatabaseTransaction,
) -> Result<Vec<NetworkCallsign>, AppError> {
    let query = sigint_network_callsign::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintCallsign.def(),
        )
        .join_rev(
            JoinType::LeftJoin,
            sigint_unit::Relation::SigintCallsign.def(),
        )
        .select_also(sigint_callsign::Entity)
        .select_also(sigint_unit::Entity)
        .filter(sigint_network_callsign::Column::Id.is_in(callsign_ids))
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(sigint_callsign::Column::Deleted.eq(false))
                .add(sigint_callsign::Column::Deleted.is_null()),
        );

    // println!(
    //     "> bl_network_callsign_batch sql: {}",
    //     query.clone().build(DbBackend::Postgres).to_string()
    // );

    let network_callsigns: Vec<(
        sigint_network_callsign::Model,
        Option<sigint_callsign::Model>,
        Option<sigint_unit::Model>,
    )> = query.all(txn).await.context(h!())?;

    let mut res = vec![];
    for (network_callsign, known_callsign, unit) in network_callsigns {
        let nc =
            render_network_callsign(&network_callsign, known_callsign, unit)?;

        res.push(nc);
    }
    Ok(res)
}

pub fn render_network_callsign(
    network_callsign: &sigint_network_callsign::Model,
    known_callsign: Option<sigint_callsign::Model>,
    unit: Option<sigint_unit::Model>,
) -> Result<NetworkCallsign, AppError> {
    let known_callsign = if let Some(known_callsign) = known_callsign {
        crate::sigint::callsign::render_callsign(&known_callsign, unit).ok()
    } else {
        None
    };

    Ok(NetworkCallsign {
        id: network_callsign.id,
        network_id: network_callsign.sigint_network_id,
        callsign: network_callsign.sigint_callsign.clone(),
        known_callsign_id: network_callsign.sigint_callsign_id,
        known_callsign: known_callsign,
        position: network_callsign.position.clone(),
        comment: network_callsign.comment.clone(),
        source_id: network_callsign.source_id,
        created_at: network_callsign.created_at.and_utc().timestamp_millis(),
    })
}

#[post("/api/sigint/network-callsign/create")]
pub async fn create_network_callsign(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateNetworkCallsignReq>,
) -> Result<Json<NetworkCallsign>, AppError> {
    let user_id = user.id()?;
    crate::users::has_role(&env.dbx, &user_id, "Rer")
        .await
        .context(h!())?;
    crate::users::has_role(&env.dbx, &user_id, "UnitsEditor")
        .await
        .context(h!())?;

    trace!(
        "Adding callsign {} to network {}; user={}",
        req.callsign, req.network_id, user_id
    );

    let txn = env.dbx.begin().await.context(h!())?;
    let network = crate::sigint::network::find_network(&txn, req.network_id)
        .await
        .context(h!())?;

    let network_callsign = sigint_network_callsign::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(req.network_id),
        deleted: NotSet,
        created_at: NotSet,
        sigint_callsign: Set(req.callsign.clone()),
        sigint_callsign_id: NotSet,
        position: Set(req.position.clone()),
        comment: Set(req.comment.clone()),
        source_id: Set(req.source_id),
        sigint_origin_id: NotSet,
        mothership_id: NotSet,
    }
    .insert(&txn)
    .await
    .context(h!())?;

    // Update the network's updated_at timestamp
    let mut network_model = network.into_active_model();
    network_model.updated_at = Set(Utc::now().naive_utc());
    network_model.updated_by = Set(Some(user_id.clone()));
    network_model.update(&txn).await.context(h!())?;

    let res =
        bl_network_callsigns_batch(vec![network_callsign.id], &txn)
            .await
            .context(h!())?;

    txn.commit().await.context(h!())?;

    let event = EventMsg::new(EventType::ETNetworkChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    if res.is_empty() {
        return Err(AppError::NotFound);
    }

    Ok(Json(res[0].clone()))
}
