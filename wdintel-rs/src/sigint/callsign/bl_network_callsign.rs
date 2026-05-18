use super::sea_orm_active_enums::*;
use crate::entities::*;
use crate::sigint::callsign::types::*;
use crate::sigint::callsign::{
    bl_callsign_create, bl_callsign_update, find_callsign,
};
use crate::sigint::etalonka::query::*;
use crate::sigint::network::bl::find_network;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use chrono::*;
use sea_orm::*;
use sea_query::{Alias, Expr, JoinType};
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

    // If unit_developing is true, we should not link to any known sigint_callsign, just update a network callsign
    if req.unit_developing {
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

    let activity_info = get_callsigns_activity_info(
        dbx,
        user_id,
        req.network_id,
        &activity_callsigns,
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

    let activity_info = get_callsigns_activity_info(
        txn,
        user_id,
        network_id,
        &activity_callsigns,
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
    login: &str,
    network_id: i64,
    callsigns: &[String],
) -> Result<HashMap<String, CallsignActivityInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let groups =
        crate::messenger::group::get_identity_sigint_groups(txn, login)
            .await
            .context(h!())?;

    let (base_with, callsigns_select) = build_callsigns_queries(
        &groups,
        network_id,
        Some(&callsigns.to_vec()),
        None,
    )
    .context(h!())?;

    let callsigns_activity_info = get_activity_info_for_callsigns(
        txn,
        base_with.clone(),
        callsigns_select.clone(),
        callsigns,
    )
    .await
    .context(h!())?;

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
    user_id: &str,
    dbx: &DatabaseConnection,
) -> Result<Vec<CallsignActivityRecord>, AppError> {
    let res = get_callsigns_activity_info(
        dbx,
        user_id,
        req.network_id,
        req.callsigns.as_slice(),
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
