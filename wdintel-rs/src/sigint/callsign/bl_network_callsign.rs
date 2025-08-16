use crate::entities::*;
use crate::sigint::callsign::types::*;
use crate::sigint::etalonka::query::*;
use crate::types::*;
use sea_orm::*;
use std::collections::HashMap;

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
            &network_callsign,
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
        &callsigns,
    )
    .await
    .context(h!())?;

    Ok(callsigns_comm_info)
}

pub fn render_network_callsign(
    network_callsign: &sigint_network_callsign::Model,
    known_callsign: Option<sigint_callsign::Model>,
    unit: Option<sigint_unit::Model>,
    comm_info: Option<&CallsignCommunicationInfo>,
) -> Result<NetworkCallsign, AppError> {
    let known_callsign = known_callsign.and_then(|cs| {
        crate::sigint::callsign::render_callsign(&cs, unit).ok()
    });

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
        active: !network_callsign.deleted,
        message_count: comm_info.map_or(0, |c| c.message_count),
        last_datetime: comm_info.and_then(|c| c.last_datetime),
    })
}
