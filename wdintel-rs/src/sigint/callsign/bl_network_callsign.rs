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
use sea_query::{Alias, Expr, ExprTrait, Func, JoinType, PgFunc, SimpleExpr};
use std::collections::HashMap;

#[derive(Clone, Debug, FromQueryResult)]
pub struct NetworkCallsignResult {
    pub id: i64,
    pub sigint_network_id: i64,
    pub sigint_callsign: String,
    pub sigint_callsign_id: Option<i64>,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub full_name: Option<String>,
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
    pub sc_full_name: Option<String>,
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
    user_id: &uuid::Uuid,
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
        full_name: req.full_name.clone().unwrap_or_default(),
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
    user_id: &uuid::Uuid,
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
        full_name: Set(req.full_name.clone()),
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
    network_record.updated_by_login_id = Set(Some(*user_id));
    network_record.update(txn).await.context(h!())?;

    Ok(network_callsign.id)
}

async fn create_network_callsign_linked(
    network_id: i64,
    sigint_callsign: &str,
    sigint_callsign_id: i64,
    main_radio_station: bool,
    command_control: bool,
    user_id: &uuid::Uuid,
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
        full_name: NotSet,
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
    user_id: &uuid::Uuid,
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
    network_record.updated_by_login_id = Set(Some(*user_id));
    network_record.update(txn).await.context(h!())?;

    Ok(res)
}

pub async fn bl_update_network_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
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

    if let Some(unit_id) =
        confirmed_unlinked_network_callsign_unit_id(req, &network_callsign)
    {
        let callsign_id = ensure_callsign_preserving_catalog(
            req,
            user_id,
            txn,
            &network_callsign,
            unit_id,
        )
        .await
        .c(h!())?;

        let network = find_network(txn, req.network_id).await.c(h!())?;
        let mut network = network.into_active_model();
        network.updated_at = Set(Utc::now().naive_utc());
        network.updated_by_login_id = Set(Some(*user_id));
        network.update(txn).await.c(h!())?;

        return Ok(callsign_id);
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
                update_callsign_developing(known_callsign, false, user_id, txn)
                    .await
                    .context(h!())?;
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
                CatalogOverridesUpdate::Keep,
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

fn confirmed_unlinked_network_callsign_unit_id(
    req: &UpdateNetworkCallsignReq,
    network_callsign: &sigint_network_callsign::Model,
) -> Option<i64> {
    if network_callsign.sigint_callsign_id.is_some()
        || req.developing
        || req.unit_developing
    {
        return None;
    }

    req.unit_id
}

pub(crate) async fn ensure_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
    network_callsign: &sigint_network_callsign::Model,
    unit_id: i64,
) -> anyhow::Result<i64> {
    let known_callsign =
        find_or_create_callsign(req, user_id, txn, network_callsign, unit_id)
            .await
            .c(h!())?
            .callsign;

    update_network_callsign_linked(
        req,
        user_id,
        txn,
        network_callsign.clone(),
        known_callsign,
        CatalogOverridesUpdate::Clear,
    )
    .await
    .c(h!())
}

async fn ensure_callsign_preserving_catalog(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
    network_callsign: &sigint_network_callsign::Model,
    unit_id: i64,
) -> anyhow::Result<i64> {
    let ensured_callsign =
        find_or_create_callsign(req, user_id, txn, network_callsign, unit_id)
            .await
            .c(h!())?;
    let catalog_overrides_update = if ensured_callsign.reused_catalog {
        CatalogOverridesUpdate::SetFromRequest
    } else {
        CatalogOverridesUpdate::Clear
    };
    let known_callsign = update_callsign_developing(
        ensured_callsign.callsign,
        req.developing,
        user_id,
        txn,
    )
    .await
    .c(h!())?;

    link_network_callsign(
        req,
        user_id,
        txn,
        network_callsign.clone(),
        known_callsign,
        catalog_overrides_update,
    )
    .await
    .c(h!())
}

struct EnsuredCallsign {
    callsign: sigint_callsign::Model,
    reused_catalog: bool,
}

async fn find_or_create_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
    network_callsign: &sigint_network_callsign::Model,
    unit_id: i64,
) -> anyhow::Result<EnsuredCallsign> {
    let callsign_value = req.callsign.clone().trim().to_lowercase();

    let existing_known_callsign = sigint_callsign::Entity::find()
        .filter(sigint_callsign::Column::UnitId.eq(unit_id))
        .filter(
            Expr::expr(Func::lower(Expr::col((
                sigint_callsign::Entity,
                sigint_callsign::Column::Callsign,
            ))))
            .eq(callsign_value),
        )
        .filter(sigint_callsign::Column::Deleted.eq(false))
        .one(txn)
        .await
        .context(h!())?;

    let (known_callsign, reused_catalog) =
        if let Some(known_callsign) = existing_known_callsign {
            (known_callsign, true)
        } else {
            let known_callsign_req = CreateCallsignReq {
                callsign: req.callsign.clone(),
                position: req.position.clone().unwrap_or_default(),
                comment: req.comment.clone().unwrap_or_default(),
                full_name: if req.full_name_is_missing {
                    network_callsign.full_name.clone().unwrap_or_default()
                } else {
                    req.full_name.clone().unwrap_or_default()
                },
                unit_id,
                source_id: req.source_id.map(|v| v as i32),
                callsign_additional_sources: vec![],
                radio_freq: req.radio_freq.clone(),
                developing: req.developing,
            };

            (
                bl_callsign_create(&known_callsign_req, user_id, txn)
                    .await
                    .context(h!())?,
                false,
            )
        };

    Ok(EnsuredCallsign {
        callsign: known_callsign,
        reused_catalog,
    })
}

async fn update_callsign_developing(
    known_callsign: sigint_callsign::Model,
    developing: bool,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
) -> Result<sigint_callsign::Model, AppError> {
    if known_callsign.developing == developing {
        return Ok(known_callsign);
    }

    let callsign_additional_sources =
        list_callsign_additional_source_ids(txn, known_callsign.id)
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
        callsign_additional_sources,
        created_at: known_callsign.created_at.and_utc().timestamp_millis(),
        developing,
        radio_freq: Some(known_callsign.radio_freq.clone()),
    };

    Ok(bl_callsign_update(&known_callsign_req, user_id, txn)
        .await
        .context(h!())?)
}

async fn update_network_callsign_linked(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
    network_callsign: sigint_network_callsign::Model,
    known_callsign: sigint_callsign::Model,
    catalog_overrides_update: CatalogOverridesUpdate,
) -> Result<i64, AppError> {
    let callsign_additional_sources =
        list_callsign_additional_source_ids(txn, known_callsign.id)
            .await
            .context(h!())?;
    let full_name = if req.full_name_is_missing {
        network_callsign
            .full_name
            .clone()
            .unwrap_or_else(|| known_callsign.full_name.clone())
    } else {
        req.full_name.clone().unwrap_or_default()
    };
    let known_callsing_req = UpdateCallsignReq {
        id: known_callsign.id,
        callsign: req.callsign.clone(),
        position: req.position.clone().unwrap_or_default(),
        comment: req.comment.clone().unwrap_or_default(),
        full_name: Some(full_name),
        full_name_is_missing: false,
        unit_id: req.unit_id.unwrap_or(known_callsign.unit_id),
        active: known_callsign.deleted,
        source_id: req.source_id.map(|v| v as i32),
        callsign_additional_sources,
        created_at: known_callsign.created_at.and_utc().timestamp_millis(),
        developing: req.developing,
        radio_freq: req.radio_freq.clone(),
    };

    let known_callsign = bl_callsign_update(&known_callsing_req, user_id, txn)
        .await
        .context(h!())?;

    link_network_callsign(
        req,
        user_id,
        txn,
        network_callsign,
        known_callsign,
        catalog_overrides_update,
    )
    .await
}

enum CatalogOverridesUpdate {
    Keep,
    Clear,
    SetFromRequest,
}

async fn link_network_callsign(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
    network_callsign: sigint_network_callsign::Model,
    known_callsign: sigint_callsign::Model,
    catalog_overrides_update: CatalogOverridesUpdate,
) -> Result<i64, AppError> {
    let network_callsign_json_old = get_network_callsign_rec_json(req.id, txn)
        .await
        .context(h!())?;

    // Keep network callsign in sync with known callsign
    let mut network_callsign_record = network_callsign.into_active_model();
    network_callsign_record.sigint_network_id = Set(req.network_id);
    network_callsign_record.sigint_callsign =
        Set(known_callsign.callsign.trim().to_lowercase());
    network_callsign_record.sigint_callsign_id = Set(Some(known_callsign.id));
    network_callsign_record.main_radio_station = Set(req.main_radio_station);
    network_callsign_record.command_control = Set(req.command_control);
    network_callsign_record.unit_developing = Set(req.unit_developing);
    network_callsign_record.developing = Set(req.developing);
    match catalog_overrides_update {
        CatalogOverridesUpdate::Keep => {}
        CatalogOverridesUpdate::Clear => {
            clear_network_callsign_catalog_overrides(
                &mut network_callsign_record,
            );
        }
        CatalogOverridesUpdate::SetFromRequest => {
            set_network_callsign_catalog_overrides(
                &mut network_callsign_record,
                req,
            );
        }
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

fn set_network_callsign_catalog_overrides(
    network_callsign: &mut sigint_network_callsign::ActiveModel,
    req: &UpdateNetworkCallsignReq,
) {
    network_callsign.position = Set(req.position.clone());
    network_callsign.comment = Set(req.comment.clone());
    if !req.full_name_is_missing {
        network_callsign.full_name = Set(req.full_name.clone());
    }
    network_callsign.source_id = Set(req.source_id);
    network_callsign.radio_freq = Set(req.radio_freq.clone());
    network_callsign.unit_id = Set(None);
}

fn clear_network_callsign_catalog_overrides(
    network_callsign: &mut sigint_network_callsign::ActiveModel,
) {
    network_callsign.position = Set(None);
    network_callsign.comment = Set(None);
    network_callsign.full_name = Set(None);
    network_callsign.source_id = Set(None);
    network_callsign.radio_freq = Set(None);
    network_callsign.unit_id = Set(None);
}

async fn update_network_callsign_not_linked(
    req: &UpdateNetworkCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
) -> Result<i64, AppError> {
    let network = find_network(txn, req.network_id).await.context(h!())?;

    let network_callsign = sigint_network_callsign::Entity::find_by_id(req.id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)?;

    let linked_full_name = if req.full_name_is_missing {
        if let Some(callsign_id) = network_callsign.sigint_callsign_id {
            Some(
                find_callsign(txn, callsign_id)
                    .await
                    .context(h!())?
                    .full_name,
            )
        } else {
            None
        }
    } else {
        None
    };

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
    if !req.full_name_is_missing {
        network_callsign_record.full_name = Set(req.full_name.clone());
    } else if let Some(full_name) = linked_full_name {
        network_callsign_record.full_name = Set(Some(full_name));
    }
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
    network_record.updated_by_login_id = Set(Some(*user_id));
    network_record.update(txn).await.context(h!())?;

    Ok(network_callsign.id)
}

pub async fn bl_delete_network_callsign(
    id: i64,
    user_id: &uuid::Uuid,
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
    user_id: &uuid::Uuid,
    dbx: &DatabaseConnection,
) -> Result<Vec<NetworkCallsign>, AppError> {
    bl_get_network_callsigns_list_impl(req, user_id, dbx, None).await
}

pub async fn bl_get_network_callsigns_list_for_period(
    req: &ListNetworkCallsignsReq,
    user_id: &uuid::Uuid,
    dbx: &DatabaseConnection,
    filter: &NetworkFreqFilter,
) -> Result<Vec<NetworkCallsign>, AppError> {
    bl_get_network_callsigns_list_impl(req, user_id, dbx, Some(filter)).await
}

async fn bl_get_network_callsigns_list_impl(
    req: &ListNetworkCallsignsReq,
    user_id: &uuid::Uuid,
    dbx: &DatabaseConnection,
    filter: Option<&NetworkFreqFilter>,
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
    query = query.filter(
        sigint_network_callsign::Column::SigintNetworkId.eq(req.network_id),
    );
    if filter.is_none() {
        query = query
            .filter(sigint_network_callsign::Column::Deleted.eq(false))
            .filter(
                Condition::any()
                    .add(sigint_callsign::Column::Deleted.eq(false))
                    .add(sigint_callsign::Column::Deleted.is_null()),
            );
    }

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

    let groups =
        crate::messenger::group::get_identity_sigint_groups(dbx, user_id)
            .await
            .context(h!())?;

    let (activity_info, preferred_ids) = if let Some(filter) = filter {
        let activity_targets = network_callsigns_activity_targets_for_period(
            dbx,
            &network_callsigns,
        )
        .await
        .context(h!())?;
        let activity_info = get_callsigns_activity_info_for_targets(
            dbx,
            groups,
            req.network_id,
            &activity_targets,
            filter,
        )
        .await
        .context(h!())?;
        let preferred_ids = preferred_network_callsign_ids(
            &network_callsigns,
            &activity_targets,
            &activity_info,
        );
        (activity_info, preferred_ids)
    } else {
        let activity_callsigns =
            network_callsigns_activity_targets(&network_callsigns);
        (
            get_callsigns_activity_info(
                dbx,
                groups,
                req.network_id,
                &activity_callsigns,
                None,
            )
            .await
            .context(h!())?,
            Default::default(),
        )
    };

    let mut res = vec![];
    for network_callsign in network_callsigns {
        let callsign_activity =
            activity_info.get(&network_callsign.sigint_callsign);
        if filter.is_some()
            && (!preferred_ids.contains(&network_callsign.id)
                || callsign_activity.is_none())
        {
            continue;
        }
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
            sigint_network_callsign::Column::FullName,
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
                sigint_callsign::Column::FullName,
            )),
            "sc_full_name",
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

#[derive(Debug)]
struct NetworkCallsignActivityTarget {
    id: i64,
    callsign: String,
    active_from: NaiveDateTime,
    active_to: Option<NaiveDateTime>,
}

async fn network_callsigns_activity_targets_for_period<'a, 'async_trait, C>(
    txn: &'a C,
    network_callsigns: &[NetworkCallsignResult],
) -> Result<Vec<NetworkCallsignActivityTarget>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let deleted_ids = network_callsigns
        .iter()
        .filter(|network_callsign| network_callsign.deleted)
        .map(|network_callsign| network_callsign.id)
        .collect::<Vec<_>>();
    let deletion_records = sigint_network_callsign_changelog::Entity::find()
        .filter(
            sigint_network_callsign_changelog::Column::SigintNetworkCallsignId
                .is_in(deleted_ids),
        )
        .filter(
            sigint_network_callsign_changelog::Column::Action
                .eq(ChangelogActionEnum::Delete),
        )
        .order_by_asc(sigint_network_callsign_changelog::Column::CreatedAt)
        .all(txn)
        .await
        .context(h!())?;
    let deletion_times = deletion_records.into_iter().fold(
        HashMap::new(),
        |mut deletion_times, deletion_record| {
            deletion_times
                .entry(deletion_record.sigint_network_callsign_id)
                .or_insert(deletion_record.created_at);
            deletion_times
        },
    );

    Ok(build_network_callsign_activity_targets(
        network_callsigns,
        &deletion_times,
    ))
}

fn build_network_callsign_activity_targets(
    network_callsigns: &[NetworkCallsignResult],
    deletion_times: &HashMap<i64, NaiveDateTime>,
) -> Vec<NetworkCallsignActivityTarget> {
    network_callsigns
        .iter()
        .filter_map(|network_callsign| {
            let active_to = if network_callsign.deleted {
                deletion_times.get(&network_callsign.id).copied()
            } else {
                None
            };
            if network_callsign.deleted && active_to.is_none() {
                return None;
            }
            if active_to.is_some_and(|active_to| {
                active_to < network_callsign.created_at
            }) {
                return None;
            }
            Some(NetworkCallsignActivityTarget {
                id: network_callsign.id,
                callsign: network_callsign.sigint_callsign.clone(),
                active_from: network_callsign.created_at,
                active_to,
            })
        })
        .filter(|target| !target.callsign.trim().is_empty())
        .collect()
}

fn preferred_network_callsign_ids(
    network_callsigns: &[NetworkCallsignResult],
    activity_targets: &[NetworkCallsignActivityTarget],
    activity_info: &HashMap<String, CallsignActivityInfo>,
) -> std::collections::HashSet<i64> {
    let matching_ids = activity_targets
        .iter()
        .filter(|target| {
            activity_info
                .get(&target.callsign)
                .is_some_and(|activity_info| {
                    activity_info.activity_datetime >= target.active_from
                        && target.active_to.is_none_or(|active_to| {
                            activity_info.activity_datetime < active_to
                        })
                })
        })
        .map(|target| target.id)
        .collect::<std::collections::HashSet<_>>();
    let preferred = network_callsigns
        .iter()
        .filter(|network_callsign| matching_ids.contains(&network_callsign.id))
        .fold(HashMap::new(), |mut preferred, network_callsign| {
            let should_replace = preferred
                .get(&network_callsign.sigint_callsign)
                .is_none_or(|current: &&NetworkCallsignResult| {
                    (!network_callsign.deleted && current.deleted)
                        || (network_callsign.deleted == current.deleted
                            && network_callsign.created_at > current.created_at)
                });
            if should_replace {
                preferred.insert(
                    network_callsign.sigint_callsign.clone(),
                    network_callsign,
                );
            }
            preferred
        });
    preferred
        .into_values()
        .map(|network_callsign| network_callsign.id)
        .collect()
}

pub async fn bl_get_network_callsigns_info_batch<'a, 'async_trait, C>(
    txn: &'a C,
    user_id: &uuid::Uuid,
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
    get_callsigns_activity_info_impl(
        txn, groups, network_id, callsigns, filter, None,
    )
    .await
}

async fn get_callsigns_activity_info_for_targets<'a, 'async_trait, C>(
    txn: &'a C,
    groups: Vec<String>,
    network_id: i64,
    targets: &[NetworkCallsignActivityTarget],
    filter: &NetworkFreqFilter,
) -> Result<HashMap<String, CallsignActivityInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let callsigns = targets
        .iter()
        .map(|target| target.callsign.clone())
        .collect::<Vec<_>>();
    get_callsigns_activity_info_impl(
        txn,
        groups,
        network_id,
        &callsigns,
        Some(filter),
        Some(targets),
    )
    .await
}

async fn get_callsigns_activity_info_impl<'a, 'async_trait, C>(
    txn: &'a C,
    groups: Vec<String>,
    network_id: i64,
    callsigns: &[String],
    filter: Option<&NetworkFreqFilter>,
    targets: Option<&[NetworkCallsignActivityTarget]>,
) -> Result<HashMap<String, CallsignActivityInfo>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if callsigns.is_empty() {
        return Ok(Default::default());
    }

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
    let activity_datetime: SimpleExpr = Func::coalesce([
        sigint_inbox_item::Column::Datetime.into_simple_expr(),
        signal_message::Column::Timestamp.into_simple_expr(),
        signal_message::Column::CreatedAt.into_simple_expr(),
    ])
    .into();

    let subquery = sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .column(sigint_inbox_item::Column::Freq)
        .column(sigint_inbox_item::Column::Datetime)
        .expr_as(activity_datetime, "activity_datetime")
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
        .filter(
            Condition::any()
                .add(sigint_network_freq::Column::Deleted.eq(false))
                .add(sigint_network_freq::Column::ActiveTo.is_not_null()),
        )
        .filter(build_datetime_filter(filter)?)
        .into_query();

    let mut query = sea_query::Query::select()
        .from_subquery(subquery, "messages")
        .column("callsign")
        .expr_as(Expr::cust("COUNT(DISTINCT id)"), "message_count")
        .expr_as(Expr::cust("MAX(datetime)"), "last_datetime")
        .expr_as(Expr::cust("MAX(activity_datetime)"), "activity_datetime")
        .expr_as(Expr::cust("ARRAY_AGG(DISTINCT freq)"), "freqs")
        .and_where(Expr::column("callsign").eq(PgFunc::any(expr_callsigns)))
        .group_by_col("callsign")
        .to_owned();
    if let Some(targets) = targets {
        query.cond_where(build_activity_targets_condition(targets));
    }

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
        let activity_datetime: NaiveDateTime = query_result
            .try_get("", "activity_datetime")
            .context(h!())?;
        let freqs: Vec<String> =
            query_result.try_get("", "freqs").context(h!())?;

        let activity_info = CallsignActivityInfo {
            message_count,
            last_datetime: last_datetime
                .map(|ts| ts.and_utc().timestamp_millis()),
            freqs: Some(freqs),
            network_names: Some(network_names.clone()),
            activity_datetime,
        };
        callsigns_activity_info.insert(callsign, activity_info);
    }
    Ok(callsigns_activity_info)
}

fn build_activity_targets_condition(
    targets: &[NetworkCallsignActivityTarget],
) -> Condition {
    targets.iter().fold(Condition::any(), |condition, target| {
        let mut target_condition = Condition::all()
            .add(Expr::column("callsign").eq(target.callsign.clone()))
            .add(Expr::column("activity_datetime").gte(target.active_from));
        if let Some(active_to) = target.active_to {
            target_condition = target_condition
                .add(Expr::column("activity_datetime").lt(active_to));
        }
        condition.add(target_condition)
    })
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
        full_name: network_callsign
            .full_name
            .clone()
            .or(network_callsign.sc_full_name.clone()),
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
    user_id: &uuid::Uuid,
    action: ChangelogActionEnum,
    old_json: Option<serde_json::Value>,
    new_json: Option<serde_json::Value>,
    req: Option<serde_json::Value>,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let changelog = sigint_network_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_network_callsign_id: Set(id),
        login_id: Set(*user_id),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::*;
    use serial_test::serial;

    fn network_callsign_for_link_check(
        sigint_callsign_id: Option<i64>,
    ) -> sigint_network_callsign::Model {
        sigint_network_callsign::Model {
            id: 1,
            sigint_network_id: 2,
            deleted: false,
            created_at: Default::default(),
            sigint_callsign: "сокіл-1".to_string(),
            sigint_origin_id: None,
            position: None,
            comment: None,
            sigint_callsign_id,
            source_id: None,
            radio_freq: None,
            developing: true,
            unit_developing: false,
            unit_id: None,
            main_radio_station: false,
            original_id: None,
            command_control: false,
            full_name: None,
        }
    }

    fn network_callsign_result(
        id: i64,
        callsign: &str,
        created_at: NaiveDateTime,
        deleted: bool,
    ) -> NetworkCallsignResult {
        NetworkCallsignResult {
            id,
            sigint_network_id: 2,
            sigint_callsign: callsign.to_string(),
            sigint_callsign_id: Some(3),
            position: None,
            comment: None,
            full_name: None,
            source_id: None,
            radio_freq: None,
            developing: false,
            unit_developing: false,
            main_radio_station: false,
            command_control: false,
            created_at,
            deleted,
            sc_callsign: Some(callsign.to_string()),
            sc_position: None,
            sc_comment: None,
            sc_full_name: None,
            sc_source_id: None,
            sc_radio_freq: None,
            sc_developing: Some(false),
            sc_deleted: Some(false),
            sc_unit_id: None,
            sc_unit_name: None,
            unit_id: None,
            unit_name: None,
        }
    }

    fn update_req_for_link_check(
        unit_id: Option<i64>,
        developing: bool,
        unit_developing: bool,
    ) -> UpdateNetworkCallsignReq {
        UpdateNetworkCallsignReq {
            id: 1,
            network_id: 2,
            callsign: "сокіл-1".to_string(),
            position: None,
            comment: None,
            full_name: None,
            full_name_is_missing: false,
            source_id: None,
            radio_freq: None,
            unit_id,
            unit_developing,
            developing,
            main_radio_station: false,
            command_control: false,
        }
    }

    #[test]
    fn confirmed_unlinked_network_callsign_with_unit_is_linked() {
        let req = update_req_for_link_check(Some(7), false, false);
        let network_callsign = network_callsign_for_link_check(None);

        assert_eq!(
            confirmed_unlinked_network_callsign_unit_id(
                &req,
                &network_callsign
            ),
            Some(7)
        );
    }

    #[test]
    fn confirmed_unlinked_network_callsign_without_unit_is_not_linked() {
        let req = update_req_for_link_check(None, false, false);
        let network_callsign = network_callsign_for_link_check(None);

        assert_eq!(
            confirmed_unlinked_network_callsign_unit_id(
                &req,
                &network_callsign
            ),
            None
        );
    }

    #[test]
    fn developing_or_linked_network_callsign_is_not_relinked() {
        let developing_req = update_req_for_link_check(Some(7), true, false);
        let unit_developing_req =
            update_req_for_link_check(Some(7), false, true);
        let linked_req = update_req_for_link_check(Some(7), false, false);
        let unlinked_callsign = network_callsign_for_link_check(None);
        let linked_callsign = network_callsign_for_link_check(Some(9));

        assert_eq!(
            confirmed_unlinked_network_callsign_unit_id(
                &developing_req,
                &unlinked_callsign
            ),
            None
        );
        assert_eq!(
            confirmed_unlinked_network_callsign_unit_id(
                &unit_developing_req,
                &unlinked_callsign
            ),
            None
        );
        assert_eq!(
            confirmed_unlinked_network_callsign_unit_id(
                &linked_req,
                &linked_callsign
            ),
            None
        );
    }

    async fn assert_auto_link_preserves_catalog(catalog_developing: bool) {
        let env = cleanup().await.unwrap();
        let login = find_test_login(&env.dbx).await.unwrap();
        let unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("Catalog metadata unit".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Catalog metadata network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let requested_network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("Requested catalog metadata network".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source = source::ActiveModel {
            name: Set("Network callsign override source".to_string()),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let known_callsign = sigint_callsign::ActiveModel {
            callsign: Set("Сокіл-1".to_string()),
            position: Set("catalog position".to_string()),
            comment: Set("catalog comment".to_string()),
            full_name: Set("catalog full name".to_string()),
            unit_id: Set(unit.id),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            source_id: Set(None),
            developing: Set(catalog_developing),
            radio_freq: Set("123.45".to_string()),
            sigint_origin_id: Set(None),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let network_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            deleted: Set(false),
            created_at: Set(Utc::now().naive_utc()),
            sigint_callsign: Set("сокіл-1".to_string()),
            sigint_callsign_id: Set(None),
            position: Set(None),
            comment: Set(None),
            full_name: Set(None),
            source_id: Set(None),
            radio_freq: Set(None),
            developing: Set(false),
            unit_developing: Set(false),
            unit_id: Set(Some(unit.id)),
            sigint_origin_id: Set(None),
            main_radio_station: Set(false),
            command_control: Set(false),
            original_id: Set(None),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let req = UpdateNetworkCallsignReq {
            id: network_callsign.id,
            network_id: requested_network.id,
            callsign: network_callsign.sigint_callsign.clone(),
            position: Some("network position".to_string()),
            comment: Some("network comment".to_string()),
            full_name: Some("network full name".to_string()),
            full_name_is_missing: false,
            source_id: Some(source.id),
            radio_freq: Some("543.21".to_string()),
            unit_id: Some(unit.id),
            unit_developing: false,
            developing: false,
            main_radio_station: true,
            command_control: false,
        };
        let txn = env.dbx.begin().await.unwrap();

        bl_update_network_callsign(&req, &login.id, &txn)
            .await
            .unwrap();

        let known_callsign_after =
            sigint_callsign::Entity::find_by_id(known_callsign.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        let network_callsign_after =
            sigint_network_callsign::Entity::find_by_id(network_callsign.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        let network_after = sigint_network::Entity::find_by_id(network.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let requested_network_after =
            sigint_network::Entity::find_by_id(requested_network.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();

        assert_eq!(known_callsign_after.position, "catalog position");
        assert_eq!(known_callsign_after.comment, "catalog comment");
        assert_eq!(known_callsign_after.full_name, "catalog full name");
        assert_eq!(known_callsign_after.radio_freq, "123.45");
        assert!(!known_callsign_after.developing);
        assert_eq!(network_callsign_after.sigint_callsign, "сокіл-1");
        assert_eq!(
            network_callsign_after.sigint_callsign_id,
            Some(known_callsign.id)
        );
        assert_eq!(
            network_callsign_after.sigint_network_id,
            requested_network.id
        );
        assert_eq!(
            network_callsign_after.position.as_deref(),
            Some("network position")
        );
        assert_eq!(
            network_callsign_after.comment.as_deref(),
            Some("network comment")
        );
        assert_eq!(
            network_callsign_after.full_name.as_deref(),
            Some("network full name")
        );
        assert_eq!(network_callsign_after.source_id, Some(source.id));
        assert_eq!(
            network_callsign_after.radio_freq.as_deref(),
            Some("543.21")
        );
        assert!(network_callsign_after.main_radio_station);
        assert_eq!(network_after.updated_by_login_id, None);
        assert_eq!(requested_network_after.updated_by_login_id, Some(login.id));

        txn.rollback().await.unwrap();
    }

    #[serial]
    #[tokio::test]
    async fn auto_link_preserves_catalog_metadata_and_clears_developing() {
        assert_auto_link_preserves_catalog(true).await;
    }

    #[serial]
    #[tokio::test]
    async fn auto_link_normalizes_confirmed_mixed_case_catalog_callsign() {
        assert_auto_link_preserves_catalog(false).await;
    }

    #[test]
    fn linking_clears_network_callsign_catalog_overrides() {
        let mut network_callsign =
            network_callsign_for_link_check(None).into_active_model();
        network_callsign.position = Set(Some("position".to_string()));
        network_callsign.comment = Set(Some("comment".to_string()));
        network_callsign.full_name = Set(Some("full name".to_string()));
        network_callsign.source_id = Set(Some(3));
        network_callsign.radio_freq = Set(Some("123.45".to_string()));
        network_callsign.unit_id = Set(Some(5));

        clear_network_callsign_catalog_overrides(&mut network_callsign);

        assert_eq!(network_callsign.position, Set(None));
        assert_eq!(network_callsign.comment, Set(None));
        assert_eq!(network_callsign.full_name, Set(None));
        assert_eq!(network_callsign.source_id, Set(None));
        assert_eq!(network_callsign.radio_freq, Set(None));
        assert_eq!(network_callsign.unit_id, Set(None));
    }

    #[test]
    fn deleted_network_callsign_keeps_its_historical_activity_interval() {
        let active_from =
            NaiveDateTime::parse_from_str("2026-06-01 00:00:00", "%F %T")
                .unwrap();
        let active_to =
            NaiveDateTime::parse_from_str("2026-06-15 00:00:00", "%F %T")
                .unwrap();
        let callsigns = vec![
            network_callsign_result(1, "historical", active_from, true),
            network_callsign_result(2, "unknown", active_from, true),
        ];
        let deletion_times = HashMap::from([(1, active_to)]);

        let targets = build_network_callsign_activity_targets(
            &callsigns,
            &deletion_times,
        );

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, 1);
        assert_eq!(targets[0].callsign, "historical");
        assert_eq!(targets[0].active_from, active_from);
        assert_eq!(targets[0].active_to, Some(active_to));
    }

    #[test]
    fn historical_activity_uses_the_matching_link_interval() {
        let historical_from =
            NaiveDateTime::parse_from_str("2026-06-01 00:00:00", "%F %T")
                .unwrap();
        let historical_to =
            NaiveDateTime::parse_from_str("2026-06-15 00:00:00", "%F %T")
                .unwrap();
        let current_from =
            NaiveDateTime::parse_from_str("2026-06-20 00:00:00", "%F %T")
                .unwrap();
        let activity_datetime =
            NaiveDateTime::parse_from_str("2026-06-10 00:00:00", "%F %T")
                .unwrap();
        let callsigns = vec![
            network_callsign_result(1, "relinked", historical_from, true),
            network_callsign_result(2, "relinked", current_from, false),
        ];
        let targets = build_network_callsign_activity_targets(
            &callsigns,
            &HashMap::from([(1, historical_to)]),
        );
        let activity_info = HashMap::from([(
            "relinked".to_string(),
            CallsignActivityInfo {
                message_count: 1,
                last_datetime: None,
                freqs: None,
                network_names: None,
                activity_datetime,
            },
        )]);

        let preferred_ids = preferred_network_callsign_ids(
            &callsigns,
            &targets,
            &activity_info,
        );

        assert_eq!(preferred_ids, std::collections::HashSet::from([1]));
    }

    #[test]
    fn linked_network_callsign_reload_uses_updated_catalog_full_name() {
        let mut network_callsign = network_callsign_result(
            1,
            "сокіл-1",
            NaiveDateTime::default(),
            false,
        );
        network_callsign.sc_full_name = Some("Петренко Петро".to_string());

        let rendered =
            render_network_callsign(&network_callsign, None).unwrap();

        assert_eq!(rendered.full_name, Some("Петренко Петро".to_string()));
    }
}
