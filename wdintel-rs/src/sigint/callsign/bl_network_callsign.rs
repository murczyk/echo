use super::sea_orm_active_enums::*;
use crate::entities::*;
use crate::sigint::callsign::types::*;
use crate::sigint::callsign::{
    bl_callsign_create, bl_callsign_update, find_callsign,
    list_callsign_additional_source_ids,
};
use crate::sigint::etalonka::query::*;
use crate::sigint::etalonka::types::NetworkFreqFilter;
use crate::sigint::network::bl::find_network;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::*;
use sea_orm::*;
use sea_query::{Alias, Expr, JoinType, PgFunc};
use std::collections::HashMap;

#[derive(Debug, FromQueryResult)]
pub struct NetworkCallsignResult {
    pub id: i64,
    pub sigint_network_id: i64,
    pub sigint_callsign: String,
    pub sigint_callsign_id: Option<i64>,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub source_id: Option<i64>,
    pub radio_freq: Option<String>,
    pub developing: bool,
    pub unit_developing: bool,
    pub main_radio_station: bool,
    pub command_control: bool,
    pub created_at: NaiveDateTime,
    pub deleted: bool,
    // fields from known callsign
    pub sc_callsign: Option<String>,
    pub sc_position: Option<String>,
    pub sc_comment: Option<String>,
    pub sc_source_id: Option<i32>,
    pub sc_radio_freq: Option<String>,
    pub sc_developing: Option<bool>,
    pub sc_deleted: Option<bool>,
    /// fields from unit likned to known sigint callsign
    pub sc_unit_id: Option<i64>,
    pub sc_unit_name: Option<String>,
    /// fields from unit linked to network callsign
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
}

/// Create a network callsign, optionally linking to a known callsign if unit_id is provided and unit_developing is false
pub async fn bl_create_network_callsign(
    req: &CreateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    // If callsign status is developing or unit_developing or no unit_id provided for a callsign
    // just create a new network callsign without linking to any known callsign
    if req.unit_developing || req.developing || req.unit_id.is_none() {
        return create_network_callsign_not_linked(req, user_id, txn).await;
    }

    // Otherwise, if unit_id provided - create linked callsign, and add it as a known network callsign
    let unit_id = req.unit_id.ok_or_else(|| AppError::BL {
        msg: "unit_id is missing after validation".into(),
    })?;

    let known_callsign_req = CreateCallsignReq {
        callsign: req.callsign.clone(),
        position: req.position.clone().unwrap_or_default(),
        comment: req.comment.clone().unwrap_or_default(),
        full_name: String::new(),
        unit_id,
        source_id: req.source_id.map(|v| v as i32),
        callsign_additional_sources: vec![],
        radio_freq: req.radio_freq.clone(),
        developing: req.developing,
    };

    let known_callsign = bl_callsign_create(&known_callsign_req, user_id, txn)
        .await
        .context(h!())?;

    let network_callsign_id = create_network_callsign_linked(
        req.network_id,
        &req.callsign,
        known_callsign.id,
        req.main_radio_station,
        req.command_control,
        user_id,
        txn,
    )
    .await
    .context(h!())?;

    Ok(network_callsign_id)
}

/// Create a network callsign without linking to any known callsign in sigint_callsign catalog table
async fn create_network_callsign_not_linked(
    req: &CreateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    let network = find_network(txn, req.network_id).await.context(h!())?;

    let network_callsign = sigint_network_callsign::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(req.network_id),
        deleted: NotSet,
        created_at: NotSet,
        sigint_callsign: Set(req.callsign.clone().trim().to_lowercase()),
        sigint_callsign_id: NotSet,
        position: Set(req.position.clone()),
        comment: Set(req.comment.clone()),
        source_id: Set(req.source_id),
        radio_freq: Set(req.radio_freq.clone()),
        unit_id: Set(req.unit_id),
        unit_developing: Set(req.unit_developing),
        developing: Set(req.developing),
        sigint_origin_id: NotSet,
        main_radio_station: Set(req.main_radio_station),
        command_control: Set(req.command_control),
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    let network_callsign_json_new =
        get_network_callsign_rec_json(network_callsign.id, txn)
            .await
            .context(h!())?;

    create_network_callsign_changelog(
        network_callsign.id,
        user_id,
        ChangelogActionEnum::Create,
        None,
        Some(network_callsign_json_new),
        Some(serde_json::to_value(req).context(h!())?),
        txn,
    )
    .await
    .context(h!())?;

    // Update the network's updated_at timestamp
    let mut network_record = network.into_active_model();
    network_record.updated_at = Set(Utc::now().naive_utc());
    network_record.updated_by = Set(Some(user_id.to_string()));
    network_record.update(txn).await.context(h!())?;

    Ok(network_callsign.id)
}

async fn create_network_callsign_linked(
    network_id: i64,
    sigint_callsign: &str,
    sigint_callsign_id: i64,
    main_radio_station: bool,
    command_control: bool,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    let network_callsign = sigint_network_callsign::ActiveModel {
        id: NotSet,
        sigint_network_id: Set(network_id),
        deleted: NotSet,
        created_at: NotSet,
        sigint_callsign: Set(sigint_callsign.trim().to_lowercase()),
        sigint_callsign_id: Set(Some(sigint_callsign_id)),
        position: NotSet,
        comment: NotSet,
        source_id: NotSet,
        radio_freq: NotSet,
        developing: NotSet,
        sigint_origin_id: NotSet,
        unit_id: NotSet,
        unit_developing: NotSet,
        main_radio_station: Set(main_radio_station),
        command_control: Set(command_control),
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    let network_callsign_json_new =
        get_network_callsign_rec_json(network_callsign.id, txn)
            .await
            .context(h!())?;

    create_network_callsign_changelog(
        network_callsign.id,
        user_id,
        ChangelogActionEnum::Create,
        None,
        Some(network_callsign_json_new),
        None,
        txn,
    )
    .await
    .context(h!())?;

    Ok(network_callsign.id)
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
            find_callsign(txn, known_callsign_id).await.context(h!())?;

        let network_callsign_id = create_network_callsign_linked(
            network_id,
            &known_callsign.callsign,
            known_callsign_id,
            false,
            false,
            user_id,
            txn,
        )
        .await
        .context(h!())?;

        res.push(network_callsign_id);
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
    let network_callsign = sigint_network_callsign::Entity::find_by_id(req.id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    // If developing/unit_developing flipped to true and unit_id provided, create (or reuse) known callsign and link
    let flipped_to_developing = (req.developing
        && !network_callsign.developing)
        || (req.unit_developing && !network_callsign.unit_developing);

    if flipped_to_developing {
        if let Some(unit_id) = req.unit_id {
            let callsign_id =
                ensure_callsign(req, user_id, txn, &network_callsign, unit_id)
                    .await
                    .c(h!())?;
            return Ok(callsign_id);
        }
    }

    // If unit_developing is true, we should not link to any known sigint_callsign, just update a network callsign.
    // However, if developing is being turned off and a linked catalog callsign still has developing=true,
    // we must sync it — otherwise sc_developing keeps the callsign displayed as "в дорозвідці".
    if req.unit_developing {
        if !req.developing {
            if let Some(sigint_callsign_id) =
                network_callsign.sigint_callsign_id
            {
                let known_callsign = find_callsign(txn, sigint_callsign_id)
                    .await
                    .context(h!())?;
                if known_callsign.developing {
                    let additional_sources =
                        list_callsign_additional_source_ids(
                            txn,
                            known_callsign.id,
                        )
                        .await
                        .context(h!())?;
                    let known_callsign_req = UpdateCallsignReq {
                        id: known_callsign.id,
                        callsign: known_callsign.callsign.clone(),
                        position: known_callsign.position.clone(),
                        comment: known_callsign.comment.clone(),
                        full_name: Some(known_callsign.full_name.clone()),
                        full_name_is_missing: false,
                        unit_id: known_callsign.unit_id,
                        active: known_callsign.deleted,
                        source_id: known_callsign.source_id,
                        callsign_additional_sources: additional_sources,
                        created_at: known_callsign
                            .created_at
                            .and_utc()
                            .timestamp_millis(),
                        developing: false,
                        radio_freq: Some(known_callsign.radio_freq.clone()),
                    };
                    bl_callsign_update(&known_callsign_req, user_id, txn)
                        .await
                        .context(h!())?;
                }
            }
        }
        return update_network_callsign_not_linked(req, user_id, txn).await;
    }

    let network_callsign_id =
        if let Some(sigint_callsign_id) = network_callsign.sigint_callsign_id {
            // Network callsign is linked to known callsign, update the known callsign instead
            let known_callsign =
                find_callsign(txn, sigint_callsign_id).await.context(h!())?;

            update_network_callsign_linked(
                req,
                user_id,
                txn,
                network_callsign,
                known_callsign,
                false,
            )
            .await?
        } else
        // If no known callsign assigned, update the network callsign itself
        {
            update_network_callsign_not_linked(req, user_id, txn)
                .await
                .c(h!())?
        };

    Ok(network_callsign_id)
}

pub(crate) async fn ensure_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
    network_callsign: &sigint_network_callsign::Model,
    unit_id: i64,
) -> anyhow::Result<i64> {
    let callsign_value = req.callsign.clone().trim().to_lowercase();

    let existing_known_callsign = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::UnitId.eq(unit_id))
        .filter(sigint_callsign::Column::Callsign.eq(callsign_value.clone()))
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .one(txn)
        .await
        .context(h!())?;

    let known_callsign = if let Some(known) = existing_known_callsign {
        known
    } else {
        let known_callsign_req = CreateCallsignReq {
            callsign: req.callsign.clone(),
            position: req.position.clone().unwrap_or_default(),
            comment: req.comment.clone().unwrap_or_default(),
            full_name: String::new(),
            unit_id,
            source_id: req.source_id.map(|v| v as i32),
            callsign_additional_sources: vec![],
            radio_freq: req.radio_freq.clone(),
            developing: req.developing,
        };

        bl_callsign_create(&known_callsign_req, user_id, txn)
            .await
            .context(h!())?
    };

    update_network_callsign_linked(
        req,
        user_id,
        txn,
        network_callsign.clone(),
        known_callsign,
        true,
    )
    .await
    .c(h!())
}

async fn update_network_callsign_linked(
    req: &UpdateNetworkCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
    network_callsign: sigint_network_callsign::Model,
    known_callsign: sigint_callsign::Model,
    clear_position_comment: bool,
) -> Result<i64, AppError> {
    let known_callsing_req = UpdateCallsignReq {
        id: known_callsign.id,
        callsign: req.callsign.clone(),
        position: req.position.clone().unwrap_or_default(),
        comment: req.comment.clone().unwrap_or_default(),
        full_name: Some(known_callsign.full_name.clone()),
        full_name_is_missing: false,
        unit_id: req.unit_id.unwrap_or(known_callsign.unit_id),
        active: known_callsign.deleted,
        source_id: req.source_id.map(|v| v as i32),
        callsign_additional_sources: vec![],
        created_at: known_callsign.created_at.and_utc().timestamp_millis(),
        developing: req.developing,
        radio_freq: req.radio_freq.clone(),
    };

    let known_callsign = bl_callsign_update(&known_callsing_req, user_id, txn)
        .await
        .context(h!())?;

    let network_callsign_json_old = get_network_callsign_rec_json(req.id, txn)
        .await
        .context(h!())?;

    // Keep network callsign in sync with known callsign
    let mut network_callsign_record = network_callsign.into_active_model();
    network_callsign_record.sigint_callsign =
        Set(known_callsign.callsign.clone());
    network_callsign_record.sigint_callsign_id = Set(Some(known_callsign.id));
    network_callsign_record.main_radio_station = Set(req.main_radio_station);
    network_callsign_record.command_control = Set(req.command_control);
    network_callsign_record.unit_developing = Set(req.unit_developing);
    network_callsign_record.developing = Set(req.developing);
    if clear_position_comment {
        network_callsign_record.position = Set(None);
        network_callsign_record.comment = Set(None);
    }
    let network_callsign =
        network_callsign_record.update(txn).await.context(h!())?;

    let network_callsign_json_new = get_network_callsign_rec_json(req.id, txn)
        .await
        .context(h!())?;
    create_network_callsign_changelog(
        req.id,
        user_id,
        ChangelogActionEnum::Update,
        Some(network_callsign_json_old),
        Some(network_callsign_json_new),
        Some(serde_json::to_value(req).context(h!())?),
        txn,
    )
    .await
    .context(h!())?;

    Ok(network_callsign.id)
}

async fn update_network_callsign_not_linked(
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

    let network_callsign_json_old = get_network_callsign_rec_json(req.id, txn)
        .await
        .context(h!())?;

    let mut network_callsign_record = network_callsign.into_active_model();
    network_callsign_record.sigint_network_id = Set(req.network_id);
    network_callsign_record.sigint_callsign_id = NotSet;
    network_callsign_record.sigint_callsign =
        Set(req.callsign.clone().trim().to_lowercase());
    network_callsign_record.position = Set(req.position.clone());
    network_callsign_record.comment = Set(req.comment.clone());
    network_callsign_record.source_id = Set(req.source_id);
    network_callsign_record.radio_freq = Set(req.radio_freq.clone());
    network_callsign_record.unit_id = Set(req.unit_id);
    network_callsign_record.unit_developing = Set(req.unit_developing);
    network_callsign_record.developing = Set(req.developing);
    network_callsign_record.main_radio_station = Set(req.main_radio_station);
    network_callsign_record.command_control = Set(req.command_control);

    let network_callsign =
        network_callsign_record.update(txn).await.context(h!())?;

    let network_callsign_json_new = get_network_callsign_rec_json(req.id, txn)
        .await
        .context(h!())?;
    create_network_callsign_changelog(
        req.id,
        user_id,
        ChangelogActionEnum::Update,
        Some(network_callsign_json_old),
        Some(network_callsign_json_new),
        Some(serde_json::to_value(req).context(h!())?),
        txn,
    )
    .await
    .context(h!())?;

    // Update the network's updated_at timestamp as well as new active_from and active_to
    let mut network_record = network.clone().into_active_model();
    network_record.updated_at = Set(Utc::now().naive_utc());
    network_record.updated_by = Set(Some(user_id.to_string()));
    network_record.update(txn).await.context(h!())?;

    Ok(network_callsign.id)
}

pub async fn bl_delete_network_callsign(
    id: i64,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<sigint_network_callsign::Model, AppError> {
    let network_callsign = sigint_network_callsign::Entity::find_by_id(id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;
    let network_callsign_json_old =
        get_network_callsign_rec_json(id, txn).await.context(h!())?;
    let mut network_callsign_rec = network_callsign.into_active_model();
    network_callsign_rec.deleted = Set(true);
    let network_callsign =
        network_callsign_rec.update(txn).await.context(h!())?;

    let network_callsign_json_new =
        get_network_callsign_rec_json(id, txn).await.context(h!())?;

    create_network_callsign_changelog(
        id,
        user_id,
        ChangelogActionEnum::Delete,
        Some(network_callsign_json_old),
        Some(network_callsign_json_new),
        None,
        txn,
    )
    .await
    .context(h!())?;

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
        .join_as(
            JoinType::LeftJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sc_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintUnit.def(),
            Alias::new("nc_unit"),
        );
    query = add_network_callsign_query_columns(query);
    query = query
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

    let network_callsigns = query
        .into_model::<NetworkCallsignResult>()
        .all(dbx)
        .await
        .context(h!())?;

    let activity_callsigns =
        network_callsigns_activity_targets(&network_callsigns);

    let groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_id)
            .await
            .context(h!())?;

    let activity_info = get_callsigns_activity_info(
        dbx,
        groups,
        req.network_id,
        &activity_callsigns,
        None,
    )
    .await
    .context(h!())?;

    let mut res = vec![];
    for network_callsign in network_callsigns {
        let callsign_activity =
            activity_info.get(&network_callsign.sigint_callsign);
        let nc = render_network_callsign(&network_callsign, callsign_activity)?;
        res.push(nc);
    }

    Ok(res)
}

pub async fn find_network_callsigns_batch<'a, 'async_trait, C>(
    network_callsign_ids: Vec<i64>,
    txn: &'a C,
) -> Result<Vec<NetworkCallsignResult>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut query = sigint_network_callsign::Entity::find()
        .join(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintCallsign.def(),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_callsign::Relation::SigintUnit.def(),
            Alias::new("sc_unit"),
        )
        .join_as(
            JoinType::LeftJoin,
            sigint_network_callsign::Relation::SigintUnit.def(),
            Alias::new("nc_unit"),
        );
    query = add_network_callsign_query_columns(query);
    query = query
        .filter(
            sigint_network_callsign::Column::Id.eq_any(network_callsign_ids),
        )
        .filter(
            Condition::any()
                .add(sigint_callsign::Column::Deleted.eq(false))
                .add(sigint_callsign::Column::Deleted.is_null()),
        );

    // println!(
    //     "> bl_network_callsign_batch sql: {}",
    //     query.clone().build(DbBackend::Postgres).to_string()
    // );

    let network_callsigns = query
        .into_model::<NetworkCallsignResult>()
        .all(txn)
        .await
        .context(h!())?;

    Ok(network_callsigns)
}

pub fn add_network_callsign_query_columns<E>(select: Select<E>) -> Select<E>
where
    E: EntityTrait,
{
    select
        .select_only()
        .columns(vec![
            sigint_network_callsign::Column::Id,
            sigint_network_callsign::Column::SigintNetworkId,
            sigint_network_callsign::Column::SigintCallsign,
            sigint_network_callsign::Column::SigintCallsignId,
            sigint_network_callsign::Column::Position,
            sigint_network_callsign::Column::Comment,
            sigint_network_callsign::Column::SourceId,
            sigint_network_callsign::Column::RadioFreq,
            sigint_network_callsign::Column::Developing,
            sigint_network_callsign::Column::UnitDeveloping,
            sigint_network_callsign::Column::MainRadioStation,
            sigint_network_callsign::Column::CommandControl,
            sigint_network_callsign::Column::CreatedAt,
            sigint_network_callsign::Column::Deleted,
        ])
        // fields from known callsign
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Callsign,
            )),
            "sc_callsign",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Position,
            )),
            "sc_position",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Comment,
            )),
            "sc_comment",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::SourceId,
            )),
            "sc_source_id",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::RadioFreq,
            )),
            "sc_radio_freq",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Developing,
            )),
            "sc_developing",
        )
        .column_as(
            Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Deleted,
            )),
            "sc_deleted",
        )
        // fields from unit likned to known sigint callsign
        .column_as(
            Expr::col((Alias::new("sc_unit"), sigint_unit::Column::Id)),
            "sc_unit_id",
        )
        .column_as(
            Expr::col((Alias::new("sc_unit"), sigint_unit::Column::Name)),
            "sc_unit_name",
        )
        // fields from unit linked to network callsign
        .column_as(
            Expr::col((Alias::new("nc_unit"), sigint_unit::Column::Id)),
            "unit_id",
        )
        .column_as(
            Expr::col((Alias::new("nc_unit"), sigint_unit::Column::Name)),
            "unit_name",
        )
}

fn network_callsigns_activity_targets(
    network_callsigns: &[NetworkCallsignResult],
) -> Vec<String> {
    network_callsigns
        .iter()
        .map(|network_callsign| network_callsign.sigint_callsign.clone())
        .filter(|callsign| !callsign.trim().is_empty())
        .collect()
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

    let activity_callsigns =
        network_callsigns_activity_targets(&network_callsigns);

    let groups =
        crate::messenger::group::get_identity_sigint_groups(txn, user_id)
            .await
            .context(h!())?;

    let activity_info = get_callsigns_activity_info(
        txn,
        groups,
        network_id,
        &activity_callsigns,
        None,
    )
    .await
    .context(h!())?;

    let mut res = vec![];
    for network_callsign in network_callsigns {
        let callsign_activity =
            activity_info.get(&network_callsign.sigint_callsign);
        let nc = render_network_callsign(&network_callsign, callsign_activity)?;
        res.push(nc);
    }
    Ok(res)
}

pub async fn get_callsigns_activity_info<'a, 'async_trait, C>(
    txn: &'a C,
    groups: Vec<String>,
    network_id: i64,
    callsigns: &[String],
    filter: Option<&NetworkFreqFilter>,
) -> Result<HashMap<String, CallsignActivityInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let Some(network) = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq(network_id))
        .filter(sigint_network::Column::Deleted.eq(false))
        .one(txn)
        .await
        .context(h!())?
    else {
        return Ok(Default::default());
    };

    let datasource_group_ids: Vec<i64> = datasource_group::Entity::find()
        .select_only()
        .column(datasource_group::Column::Id)
        // TODO: do we count the messages if datasource got deleted
        // .filter(datasource_group::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.eq_any(groups))
        .into_tuple()
        .all(txn)
        .await
        .context(h!())?;

    let expr_jsonb_callsigns = Expr::cust_with_expr(
        "jsonb_array_elements_text($1)",
        sigint_inbox_item::Column::Callsigns.into_simple_expr(),
    );

    let expr_callsigns = Expr::value(callsigns.to_owned());

    let subquery = sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Datetime)
        .expr_as(expr_jsonb_callsigns, "callsign")
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
            sigint_inbox_item::Entity::belongs_to(sigint_network_freq::Entity)
                .from(sigint_inbox_item::Column::Freq)
                .to(sigint_network_freq::Column::Freq)
                .into(),
        )
        .filter(
            sigint_inbox_item_network::Column::SigintNetworkId.eq(network_id),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message::Column::DatasourceGroupId
                .eq_any(datasource_group_ids),
        )
        .filter(sigint_inbox_item::Column::Callsigns.is_not_null())
        // TODO: this might confuse postgres to scan many rows using GIN index on JSONB callsigns
        .filter(Expr::cust_with_expr(
            "sigint_inbox_item.callsigns ?| $1",
            expr_callsigns.clone(),
        ))
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(build_datetime_filter(filter)?)
        .into_query();

    let query = sea_query::Query::select()
        .from_subquery(subquery, "messages")
        .column("callsign")
        .expr_as(Expr::cust("COUNT(*)"), "message_count")
        .expr_as(Expr::cust("MAX(datetime)"), "last_datetime")
        .expr_as(Expr::cust("ARRAY_AGG(DISTINCT freq)"), "freqs")
        .and_where(Expr::column("callsign").eq(PgFunc::any(expr_callsigns)))
        .group_by_col("callsign")
        .to_owned();

    let statement = txn.get_database_backend().build(&query);
    let results = txn.query_all(statement).await.context(h!())?;

    let network_names = if network.name.is_empty() {
        vec![]
    } else {
        vec![format!("р/м {}", &network.name)]
    };

    let mut callsigns_activity_info = HashMap::with_capacity(results.len());
    for query_result in results {
        let callsign: String =
            query_result.try_get("", "callsign").context(h!())?;
        let message_count: i64 =
            query_result.try_get("", "message_count").context(h!())?;
        let last_datetime: Option<NaiveDateTime> =
            query_result.try_get("", "last_datetime").context(h!())?;
        let freqs: Vec<String> =
            query_result.try_get("", "freqs").context(h!())?;

        let activity_info = CallsignActivityInfo {
            message_count,
            last_datetime: last_datetime
                .map(|ts| ts.and_utc().timestamp_millis()),
            freqs: Some(freqs),
            network_names: Some(network_names.clone()),
        };
        callsigns_activity_info.insert(callsign, activity_info);
    }
    Ok(callsigns_activity_info)
}

pub fn render_network_callsign(
    network_callsign: &NetworkCallsignResult,
    activity_info: Option<&CallsignActivityInfo>,
) -> Result<NetworkCallsign, AppError> {
    Ok(NetworkCallsign {
        id: network_callsign.id,
        network_id: network_callsign.sigint_network_id,
        callsign: network_callsign.sigint_callsign.clone(),
        known_callsign_id: network_callsign.sigint_callsign_id,
        position: network_callsign
            .position
            .clone()
            .or(network_callsign.sc_position.clone()),
        comment: network_callsign
            .comment
            .clone()
            .or(network_callsign.sc_comment.clone()),
        unit_id: network_callsign.unit_id.or(network_callsign.sc_unit_id),
        unit_name: network_callsign
            .unit_name
            .clone()
            .or(network_callsign.sc_unit_name.clone()),
        unit_developing: network_callsign.unit_developing,
        command_control: network_callsign.command_control,
        source_id: network_callsign
            .source_id
            .or(network_callsign.sc_source_id.map(|v| v as i64)),
        // source_name: None,
        radio_freq: network_callsign
            .radio_freq
            .clone()
            .or(network_callsign.sc_radio_freq.clone()),
        developing: network_callsign.developing
            || network_callsign.sc_developing.unwrap_or(false),
        main_radio_station: network_callsign.main_radio_station,
        created_at: network_callsign.created_at.and_utc().timestamp_millis(),
        active: !network_callsign.deleted,
        message_count: activity_info.map_or(0, |c| c.message_count),
        last_datetime: activity_info.and_then(|c| c.last_datetime),
        freqs: activity_info.and_then(|c| c.freqs.clone()),
    })
}

async fn get_network_callsign_rec_json(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<serde_json::value::Value, AppError> {
    let network_callsign_json = sigint_network_callsign::Entity::find_by_id(id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    Ok(network_callsign_json)
}
async fn create_network_callsign_changelog(
    id: i64,
    user_id: &str,
    action: ChangelogActionEnum,
    old_json: Option<serde_json::Value>,
    new_json: Option<serde_json::Value>,
    req: Option<serde_json::Value>,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let changelog = sigint_network_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_network_callsign_id: Set(id),
        login: Set(user_id.to_string()),
        action: Set(action),
        old_value: Set(old_json),
        new_value: Set(new_json),
        req: Set(req),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    };

    changelog.insert(txn).await.context(h!())?;

    Ok(())
}

/// Get activity for a list of callsigns within a network
pub async fn bl_get_network_callsigns_activity(
    req: &NetworkCallsignsActivityReq,
    groups: Vec<String>,
    dbx: &DatabaseConnection,
) -> Result<Vec<CallsignActivityRecord>, AppError> {
    let res = get_callsigns_activity_info(
        dbx,
        groups,
        req.network_id,
        req.callsigns.as_slice(),
        None,
    )
    .await
    .context(h!())?
    .into_iter()
    .map(|(callsign, info)| CallsignActivityRecord {
        callsign,
        activity: CallsignActivityItem {
            message_count: info.message_count,
            last_datetime: info.last_datetime,
            freqs: info.freqs,
        },
    })
    .collect();

    Ok(res)
}
