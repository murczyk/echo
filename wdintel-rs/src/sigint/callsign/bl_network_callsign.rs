use crate::entities::*;
use crate::sigint::callsign::types::*;
use crate::sigint::etalonka::query::*;
use crate::sigint::network::{find_network, get_network_units};
use crate::types::*;
use chrono::*;
use sea_orm::QuerySelect;
use sea_orm::*;
use sea_query::JoinType;
use std::collections::HashMap;

pub async fn bl_create_network_callsign(
    req: &CreateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    let network = find_network(txn, req.network_id).await.context(h!())?;
    let network_units =
        get_network_units(txn, req.network_id).await.context(h!())?;

    // If network has units then create sigint_callsign for the first unit and add link to this callsign as a network callsign
    // othervise, create a network callsing just in place
    let network_callsign_id = if let Some(network_units) = &network_units {
        let unit_id = network_units[0];

        let known_callsing_req = CreateCallsignReq {
            callsign: req.callsign.clone(),
            position: req.position.clone().unwrap_or_default(),
            comment: req.comment.clone().unwrap_or_default(),
            unit_id,
            source_id: req.source_id as i32,
            radio_freq: req.radio_freq.clone(),
            developing: false,
        };

        let known_callsing = crate::sigint::callsign::bl_callsign_create(
            &known_callsing_req,
            user_id,
            txn,
        )
        .await
        .context(h!())?;

        bl_add_as_known_network_callsigns(
            req.network_id,
            vec![known_callsing.id],
            user_id,
            txn,
        )
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?
    } else {
        let network_callsign = sigint_network_callsign::ActiveModel {
            id: NotSet,
            sigint_network_id: Set(req.network_id),
            deleted: NotSet,
            created_at: NotSet,
            sigint_callsign: Set(req.callsign.clone()),
            sigint_callsign_id: NotSet,
            position: Set(req.position.clone()),
            comment: Set(req.comment.clone()),
            source_id: Set(Some(req.source_id)),
            radio_freq: Set(req.radio_freq.clone()),
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;

        // Update the network's updated_at timestamp
        let mut network_record = network.into_active_model();
        network_record.updated_at = Set(Utc::now().naive_utc());
        network_record.updated_by = Set(Some(user_id.to_string()));
        network_record.update(txn).await.context(h!())?;

        network_callsign.id
    };

    Ok(network_callsign_id)
}

pub async fn bl_add_as_known_network_callsigns(
    network_id: i64,
    known_callsign_ids: Vec<i64>,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<Vec<i64>, AppError> {
    let network = find_network(txn, network_id).await.context(h!())?;

    let mut res = vec![];
    for known_callsign_id in known_callsign_ids {
        let known_callsign =
            crate::sigint::callsign::find_callsign(txn, known_callsign_id)
                .await
                .context(h!())?;

        let network_callsign = sigint_network_callsign::ActiveModel {
            id: NotSet,
            sigint_network_id: Set(network_id),
            deleted: NotSet,
            created_at: NotSet,
            sigint_callsign: Set(known_callsign.callsign.clone()),
            sigint_callsign_id: Set(Some(known_callsign_id)),
            position: NotSet,
            comment: NotSet,
            source_id: NotSet,
            radio_freq: NotSet,
            sigint_origin_id: NotSet,
            mothership_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;

        res.push(network_callsign.id);
    }

    // Update the network's updated_at timestamp
    let mut network_record = network.into_active_model();
    network_record.updated_at = Set(Utc::now().naive_utc());
    network_record.updated_by = Set(Some(user_id.to_string()));
    network_record.update(txn).await.context(h!())?;

    Ok(res)
}

pub async fn bl_update_network_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    let network = find_network(txn, req.network_id).await.context(h!())?;
    let network_callsign = sigint_network_callsign::Entity::find_by_id(req.id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let mut network_callsign_record = network_callsign.into_active_model();
    network_callsign_record.sigint_network_id = Set(req.network_id);
    network_callsign_record.sigint_callsign = Set(req.callsign.clone());
    network_callsign_record.position = Set(req.position.clone());
    network_callsign_record.comment = Set(req.comment.clone());
    network_callsign_record.source_id = Set(Some(req.source_id));

    let network_callsign =
        network_callsign_record.update(txn).await.context(h!())?;

    // Update the network's updated_at timestamp as well as new active_from and active_to
    let mut network_record = network.into_active_model();
    network_record.updated_at = Set(Utc::now().naive_utc());
    network_record.updated_by = Set(Some(user_id.to_string()));
    network_record.update(txn).await.context(h!())?;

    Ok(network_callsign.id)
}

pub async fn bl_delete_network_callsign(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<sigint_network_callsign::Model, AppError> {
    let (network_callsign, _known_callsign, _unit) =
        find_network_callsign_one(id, txn).await?;
    let mut network_callsign_rec = network_callsign.into_active_model();
    network_callsign_rec.deleted = Set(true);
    let network_callsign =
        network_callsign_rec.update(txn).await.context(h!())?;

    Ok(network_callsign)
}

pub async fn bl_get_network_callsigns_list(
    req: &ListNetworkCallsignsReq,
    user_id: &str,
    dbx: &DatabaseConnection,
) -> Result<Vec<NetworkCallsign>, AppError> {
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
    )> = query.all(dbx).await.context(h!())?;

    let comm_info = get_callsigns_communication_info(
        dbx,
        user_id,
        req.network_id,
        &network_callsigns
            .iter()
            .map(|(nc, _, _)| nc.sigint_callsign.clone())
            .collect::<Vec<_>>(),
    )
    .await
    .context(h!())?;

    let mut res = vec![];
    for (network_callsign, known_callsign, unit) in network_callsigns {
        let callsing_comm_info =
            comm_info.get(&network_callsign.sigint_callsign);
        let nc = render_network_callsign(
            network_callsign,
            known_callsign,
            unit,
            callsing_comm_info,
        )?;

        res.push(nc);
    }

    Ok(res)
}

pub async fn find_network_callsign_one<'a, 'async_trait, C>(
    network_callsign_id: i64,
    txn: &'a C,
) -> Result<
    (
        sigint_network_callsign::Model,
        Option<sigint_callsign::Model>,
        Option<sigint_unit::Model>,
    ),
    AppError,
>
where
    C: ConnectionTrait + 'async_trait,
{
    find_network_callsigns_batch(vec![network_callsign_id], txn)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .ok_or(AppError::NotFound)
}

pub async fn find_network_callsigns_batch<'a, 'async_trait, C>(
    network_callsign_ids: Vec<i64>,
    txn: &'a C,
) -> Result<
    Vec<(
        sigint_network_callsign::Model,
        Option<sigint_callsign::Model>,
        Option<sigint_unit::Model>,
    )>,
    AppError,
>
where
    C: ConnectionTrait + 'async_trait,
{
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
        .filter(sigint_network_callsign::Column::Id.is_in(network_callsign_ids))
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

    Ok(network_callsigns)
}

pub async fn bl_get_network_callsigns_info_batch<'a, 'async_trait, C>(
    txn: &'a C,
    user_id: &str,
    network_id: i64,
    network_callsign_ids: Vec<i64>,
) -> Result<Vec<NetworkCallsign>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let network_callsigns =
        find_network_callsigns_batch(network_callsign_ids, txn)
            .await
            .context(h!())?;

    let comm_info = get_callsigns_communication_info(
        txn,
        user_id,
        network_id,
        &network_callsigns
            .iter()
            .map(|(nc, _, _)| nc.sigint_callsign.clone())
            .collect::<Vec<_>>(),
    )
    .await
    .context(h!())?;

    let mut res = vec![];
    for (network_callsign, known_callsign, unit) in network_callsigns {
        let callsing_comm_info =
            comm_info.get(&network_callsign.sigint_callsign);
        let nc = render_network_callsign(
            network_callsign,
            known_callsign,
            unit,
            callsing_comm_info,
        )?;

        res.push(nc);
    }
    Ok(res)
}

pub async fn get_callsigns_communication_info<'a, 'async_trait, C>(
    txn: &'a C,
    login: &str,
    network_id: i64,
    callsigns: &[String],
) -> Result<HashMap<String, CallsignCommunicationInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let groups = crate::users::get_identity_sigint_groups(txn, login)
        .await
        .context(h!())?;

    let (base_with, callsigns_select) =
        build_callsigns_queries(&groups, network_id).context(h!())?;

    let callsigns_comm_info = get_communication_info_for_callsigns(
        txn,
        base_with.clone(),
        callsigns_select.clone(),
        callsigns,
    )
    .await
    .context(h!())?;

    Ok(callsigns_comm_info)
}

pub fn render_network_callsign(
    network_callsign: sigint_network_callsign::Model,
    known_callsign: Option<sigint_callsign::Model>,
    unit: Option<sigint_unit::Model>,
    comm_info: Option<&CallsignCommunicationInfo>,
) -> Result<NetworkCallsign, AppError> {
    Ok(NetworkCallsign {
        id: network_callsign.id,
        network_id: network_callsign.sigint_network_id,
        callsign: network_callsign.sigint_callsign.clone(),
        known_callsign_id: network_callsign.sigint_callsign_id,
        position: network_callsign
            .position
            .or_else(|| known_callsign.as_ref().map(|kc| kc.position.clone())),
        comment: network_callsign
            .comment
            .or_else(|| known_callsign.as_ref().map(|kc| kc.comment.clone())),
        unit_id: unit.as_ref().map(|u| u.id),
        unit_name: unit.as_ref().map(|u| u.name.clone()),
        source_id: network_callsign
            .source_id
            .or_else(|| known_callsign.as_ref().map(|kc| kc.source_id as i64)),
        // source_name: None,
        radio_freq: network_callsign.radio_freq.or_else(|| {
            known_callsign.as_ref().map(|kc| kc.radio_freq.clone())
        }),
        created_at: network_callsign.created_at.and_utc().timestamp_millis(),
        active: !network_callsign.deleted,
        message_count: comm_info.map_or(0, |c| c.message_count),
        last_datetime: comm_info.and_then(|c| c.last_datetime),
        freqs: comm_info.and_then(|c| c.freqs.clone()),
    })
}
