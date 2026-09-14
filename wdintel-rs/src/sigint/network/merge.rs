use super::sea_orm_active_enums::*;
use crate::config::{
    SIGINT_NETWORK_ACTIVITY_REASON_MERGE_FREQUENCY_CLOSED,
    SIGINT_NETWORK_ACTIVITY_REASON_MERGE_NETWORK_UPDATED,
};
use crate::entities::prelude::{AreaOfResponsibility, SigintPost};
use crate::entities::*;
use crate::error::AppError;
use crate::sigint::network::activity_decision::*;
use crate::sigint::network::bl::*;
use crate::sigint::network::etalon_calc;
use crate::types::*;
use chrono::*;
use sea_orm::sea_query::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};

pub async fn merge_two_networks(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    perform_merge_check: bool,
    merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<(), AppError> {
    if network_id_from == network_id_to {
        return Err(AppError::BL {
            msg: "Network cannot be merged into itself".to_string(),
        });
    }
    let networks = sigint_network::Entity::find()
        .filter(
            sigint_network::Column::Id.is_in([network_id_from, network_id_to]),
        )
        .order_by_asc(sigint_network::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;
    let network_from = networks
        .iter()
        .find(|network| network.id == network_id_from)
        .cloned()
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let network_to = networks
        .into_iter()
        .find(|network| network.id == network_id_to)
        .ok_or(AppError::NotFound)
        .context(h!())?;

    if !merge_inactive
        && (is_inactive_network(&network_from)
            || is_inactive_network(&network_to))
    {
        return Err(AppError::BL {
            msg: "Inactive networks merge is disabled".to_string(),
        });
    }

    // Fetch units for both networks
    let units_from = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_from))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();

    let units_to = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_to))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();

    if perform_merge_check {
        // Validate if merge is allowed (Names should match)
        if network_from.name != network_to.name {
            return Err(AppError::BL {
                msg: "Networks names or kinds mismatch".to_string(),
            });
        }

        // Ensure they belong to the same unit
        if units_from != units_to {
            return Err(AppError::BL {
                msg: "Networks belong to different units".to_string(),
            });
        }
    }

    reassign_freqs(txn, login, merge_inactive, network_id_from, network_id_to)
        .await
        .c(h!())?;

    reassign_posts(txn, merge_inactive, network_id_from, network_id_to)
        .await
        .c(h!())?;

    reassign_descriptions(txn, merge_inactive, network_id_from, network_id_to)
        .await
        .c(h!())?;

    reassign_callsigns(
        txn,
        login,
        merge_inactive,
        network_id_from,
        network_id_to,
    )
    .await
    .c(h!())?;

    reassign_aors(txn, merge_inactive, network_id_from, network_id_to)
        .await
        .c(h!())?;

    reassign_units(txn, login, network_id_from, network_id_to)
        .await
        .c(h!())?;
    reassign_encryption_keys(txn, network_id_from, network_id_to)
        .await
        .c(h!())?;
    reassign_saved_filters(txn, network_id_from, network_id_to)
        .await
        .c(h!())?;

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
    info!(
        "Network {network_id_to} \"active from\" date updated to: {:?}",
        network_active_from
    );

    let old_network_to = network_to.clone();
    let mut network_to_model: sigint_network::ActiveModel = network_to.into();
    network_to_model.location = Set(new_location.unwrap_or_default());
    network_to_model.radio_station = Set(new_radio_station);
    network_to_model.updated_at = Set(Utc::now().naive_utc());
    network_to_model.updated_by_login_id = Set(Some(*login));
    network_to_model.active_from = Set(network_active_from);
    network_to_model.active_to = Set(network_active_to);
    let network_to = network_to_model.update(txn).await.context(h!())?;
    record_activity_decision_if_changed(
        txn,
        ActivityDecisionTarget::Network {
            network_id: network_id_to,
        },
        ActivityDecisionActor::merge(Some(*login)),
        SIGINT_NETWORK_ACTIVITY_REASON_MERGE_NETWORK_UPDATED,
        ActivityState::network(&old_network_to),
        ActivityState::network(&network_to),
        ActivityDecisionEvidence::default(),
    )
    .await
    .context(h!())?;

    // Mark network_from as deleted, set merget_to field
    let mut network_from_model: sigint_network::ActiveModel =
        network_from.into();
    network_from_model.deleted = Set(true);
    network_from_model.merged_to = Set(Some(network_id_to));
    network_from_model.updated_at = Set(Utc::now().naive_utc());
    network_from_model.updated_by_login_id = Set(Some(*login));
    let network_from = network_from_model.update(txn).await.context(h!())?;

    etalon_calc::invalidate_network_inbox(
        network_from,
        vec![],
        txn,
        format!("merged network {network_id_from} into {network_id_to}"),
    )
    .await
    .c(h!())?;
    etalon_calc::invalidate_network_inbox(
        network_to,
        vec![],
        txn,
        format!("merged network {network_id_from} into {network_id_to}"),
    )
    .await
    .c(h!())?;

    info!("✅ Merged network {network_id_from} into {network_id_to}");

    Ok(())
}

fn is_inactive_network(network: &sigint_network::Model) -> bool {
    network.deleted || network.active_to.is_some()
}

async fn reassign_units(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<()> {
    let mut unit_ids_to = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_to))
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|link| link.unit_id)
        .collect::<HashSet<_>>();
    let units_from = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_from))
        .all(txn)
        .await
        .c(h!())?;
    for unit in units_from {
        if unit_ids_to.insert(unit.unit_id) {
            let old_value = serde_json::to_value(&unit).c(h!())?;
            let id = unit.id;
            let mut unit = unit.into_active_model();
            unit.network_id = Set(network_id_to);
            let unit = unit.update(txn).await.c(h!())?;
            sigint_network_unit_changelog::ActiveModel {
                sigint_network_unit_id: Set(id),
                login_id: Set(*login),
                action: Set("update".to_string()),
                old_value: Set(Some(old_value)),
                new_value: Set(Some(serde_json::to_value(unit).c(h!())?)),
                req: Set(None),
                ..Default::default()
            }
            .insert(txn)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn reassign_encryption_keys(
    txn: &DatabaseTransaction,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<()> {
    sigint_network_encryption_key::Entity::update_many()
        .col_expr(
            sigint_network_encryption_key::Column::SigintNetworkId,
            Expr::value(network_id_to),
        )
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkId
                .eq(network_id_from),
        )
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

async fn reassign_saved_filters(
    txn: &DatabaseTransaction,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<()> {
    let saved_filters = sigint_saved_filter::Entity::find()
        .filter(Expr::cust_with_values(
            "req @> jsonb_build_object('selected_networks', jsonb_build_array($1))",
            [Value::BigInt(Some(network_id_from))],
        ))
        .lock_exclusive()
        .all(txn)
        .await
        .c(h!())?;
    for saved_filter in saved_filters {
        let mut req = saved_filter.req.clone();
        let selected_networks = req
            .get_mut("selected_networks")
            .and_then(serde_json::Value::as_array_mut)
            .c(h!())?;
        let mut seen = HashSet::new();
        selected_networks.retain_mut(|network_id| {
            if network_id.as_i64() == Some(network_id_from) {
                *network_id = serde_json::json!(network_id_to);
            }
            network_id.as_i64().is_none_or(|id| seen.insert(id))
        });
        let mut saved_filter = saved_filter.into_active_model();
        saved_filter.req = Set(req);
        saved_filter.update(txn).await.c(h!())?;
    }
    Ok(())
}

pub async fn merge_two_network_freqs(
    txn: &DatabaseTransaction,
    _login: &str,
    freq_id_from: i64,
    freq_id_to: i64,
) -> anyhow::Result<(), AppError> {
    if freq_id_from == freq_id_to {
        return Ok(());
    }

    let freq_from = sigint_network_freq::Entity::find_by_id(freq_id_from)
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let _network = lock_network_activity_target(txn, freq_from.network_id)
        .await
        .context(h!())?;
    let frequencies = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::Id.is_in([freq_id_from, freq_id_to]),
        )
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;
    let freq_from = frequencies
        .iter()
        .find(|network_freq| network_freq.id == freq_id_from)
        .cloned()
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let freq_to = frequencies
        .into_iter()
        .find(|network_freq| network_freq.id == freq_id_to)
        .ok_or(AppError::NotFound)
        .context(h!())?;

    if freq_from.network_id != freq_to.network_id
        || freq_from.freq.trim() != freq_to.freq.trim()
    {
        return Err(AppError::BL {
            msg: "Network frequency mismatch".to_string(),
        });
    }

    sigint_network_description::Entity::update_many()
        .filter(
            sigint_network_description::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_description::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;

    sigint_network_encryption_key::Entity::update_many()
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_encryption_key::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;

    sigint_network_freq_changelog::Entity::update_many()
        .filter(
            sigint_network_freq_changelog::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_freq_changelog::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;

    reassign_encryption_key_freqs(txn, freq_id_from, freq_id_to, None)
        .await
        .c(h!())?;

    if !freq_from.deleted {
        let cutoff = std::cmp::max(freq_to.active_from, freq_from.active_from);
        let final_active_to = freq_from.active_to.unwrap_or(cutoff);
        let old_freq_from = freq_from.clone();
        let mut freq_from_record: sigint_network_freq::ActiveModel =
            freq_from.into();
        freq_from_record.deleted = Set(true);
        freq_from_record.active_to = Set(Some(final_active_to));
        let freq_from = freq_from_record.update(txn).await.context(h!())?;
        record_activity_decision_if_changed(
            txn,
            ActivityDecisionTarget::Frequency {
                network_id: freq_from.network_id,
                network_freq_id: freq_from.id,
                freq: &freq_from.freq,
            },
            ActivityDecisionActor::merge(None),
            SIGINT_NETWORK_ACTIVITY_REASON_MERGE_FREQUENCY_CLOSED,
            ActivityState::frequency(&old_freq_from),
            ActivityState::frequency(&freq_from),
            ActivityDecisionEvidence::default(),
        )
        .await
        .context(h!())?;
    }

    info!("✅ Merged network freq {freq_id_from} into {freq_id_to}");

    Ok(())
}

async fn reassign_encryption_key_freqs(
    txn: &DatabaseTransaction,
    freq_id_from: i64,
    freq_id_to: i64,
    active_source_network_id: Option<i64>,
) -> Result<(), AppError> {
    let mut key_freqs_from = sigint_network_encryption_key_freq::Entity::find()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        );
    if let Some(network_id_from) = active_source_network_id {
        let active_keys = sigint_network_encryption_key::Entity::find()
            .select_only()
            .column(sigint_network_encryption_key::Column::Id)
            .filter(
                sigint_network_encryption_key::Column::SigintNetworkId
                    .eq(network_id_from),
            )
            .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
            .into_query();
        key_freqs_from = key_freqs_from.filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                .in_subquery(active_keys),
        );
    }
    let key_freqs_from = key_freqs_from.all(txn).await.context(h!())?;

    if key_freqs_from.is_empty() {
        return Ok(());
    }

    let key_ids = key_freqs_from
        .iter()
        .map(|rec| rec.sigint_network_encryption_key_id)
        .collect::<Vec<_>>();

    let existing_key_ids = sigint_network_encryption_key_freq::Entity::find()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                .eq(freq_id_to),
        )
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                .is_in(key_ids.clone()),
        )
        .select_only()
        .column(
            sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId,
        )
        .into_tuple::<i64>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();

    for key_freq in key_freqs_from {
        if existing_key_ids.contains(&key_freq.sigint_network_encryption_key_id)
        {
            sigint_network_encryption_key_freq::Entity::delete_by_id(
                key_freq.id,
            )
            .exec(txn)
            .await
            .context(h!())?;
        } else {
            let mut key_freq_record = key_freq.into_active_model();
            key_freq_record.sigint_network_freq_id = Set(freq_id_to);
            key_freq_record.update(txn).await.context(h!())?;
        }
    }

    Ok(())
}

async fn reassign_duplicate_frequency_references(
    txn: &DatabaseTransaction,
    freq_id_from: i64,
    freq_id_to: i64,
) -> Result<(), AppError> {
    sigint_network_description::Entity::update_many()
        .filter(
            sigint_network_description::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_description::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;
    sigint_network_encryption_key::Entity::update_many()
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_encryption_key::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;
    reassign_encryption_key_freqs(txn, freq_id_from, freq_id_to, None)
        .await
        .context(h!())?;
    Ok(())
}

async fn active_source_frequency_ids(
    txn: &DatabaseTransaction,
    network_id_from: i64,
) -> Result<HashSet<i64>, AppError> {
    let mut ids = sigint_network_description::Entity::find()
        .select_only()
        .column(sigint_network_description::Column::SigintNetworkFreqId)
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .filter(
            sigint_network_description::Column::SigintNetworkFreqId
                .is_not_null(),
        )
        .into_tuple::<i64>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    ids.extend(
        sigint_network_encryption_key::Entity::find()
            .select_only()
            .column(sigint_network_encryption_key::Column::SigintNetworkFreqId)
            .filter(
                sigint_network_encryption_key::Column::SigintNetworkId
                    .eq(network_id_from),
            )
            .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
            .filter(
                sigint_network_encryption_key::Column::SigintNetworkFreqId
                    .is_not_null(),
            )
            .into_tuple::<i64>()
            .all(txn)
            .await
            .context(h!())?,
    );
    let active_keys = sigint_network_encryption_key::Entity::find()
        .select_only()
        .column(sigint_network_encryption_key::Column::Id)
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkId
                .eq(network_id_from),
        )
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .into_query();
    ids.extend(
        sigint_network_encryption_key_freq::Entity::find()
            .select_only()
            .column(sigint_network_encryption_key_freq::Column::SigintNetworkFreqId)
            .filter(
                sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                    .in_subquery(active_keys),
            )
            .into_tuple::<i64>()
            .all(txn)
            .await
            .context(h!())?,
    );
    Ok(ids)
}

async fn reassign_active_deleted_frequency_references(
    txn: &DatabaseTransaction,
    network_id_from: i64,
    freq_id_from: i64,
    freq_id_to: i64,
) -> Result<(), AppError> {
    sigint_network_description::Entity::update_many()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .filter(
            sigint_network_description::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_description::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;
    sigint_network_encryption_key::Entity::update_many()
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkId
                .eq(network_id_from),
        )
        .filter(sigint_network_encryption_key::Column::Deleted.eq(false))
        .filter(
            sigint_network_encryption_key::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .col_expr(
            sigint_network_encryption_key::Column::SigintNetworkFreqId,
            Expr::value(freq_id_to),
        )
        .exec(txn)
        .await
        .context(h!())?;
    reassign_encryption_key_freqs(
        txn,
        freq_id_from,
        freq_id_to,
        Some(network_id_from),
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn reconcile_referenced_deleted_source_frequencies(
    txn: &DatabaseTransaction,
    network_id_from: i64,
    network_id_to: i64,
    target_freq_ids: &HashMap<String, (i64, bool)>,
) -> Result<(), AppError> {
    let deleted_source_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_freq::Column::Deleted.eq(true))
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;
    if deleted_source_freqs.is_empty() {
        return Ok(());
    }
    let active_freq_ids = active_source_frequency_ids(txn, network_id_from)
        .await
        .context(h!())?;
    let mut deleted_target_freq_ids = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_freq::Column::Deleted.eq(true))
        .order_by_asc(sigint_network_freq::Column::Id)
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|freq| (freq.freq, freq.id))
        .collect::<HashMap<_, _>>();
    for source_freq in deleted_source_freqs {
        if !active_freq_ids.contains(&source_freq.id) {
            continue;
        }
        let target_freq_id = if let Some((id, _)) =
            target_freq_ids.get(&source_freq.freq)
        {
            *id
        } else if let Some(id) = deleted_target_freq_ids.get(&source_freq.freq)
        {
            *id
        } else {
            let mut target_freq = source_freq.clone().into_active_model();
            target_freq.id = NotSet;
            target_freq.network_id = Set(network_id_to);
            target_freq.created_at = NotSet;
            let target_freq = target_freq.insert(txn).await.context(h!())?;
            deleted_target_freq_ids.insert(target_freq.freq, target_freq.id);
            target_freq.id
        };
        reassign_active_deleted_frequency_references(
            txn,
            network_id_from,
            source_freq.id,
            target_freq_id,
        )
        .await
        .context(h!())?;
    }
    Ok(())
}

async fn move_network_frequency(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    freq: sigint_network_freq::Model,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let id = freq.id;
    let freq_value = freq.freq.clone();
    let json_old = sigint_network_freq::Entity::find_by_id(id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;

    let mut freq = freq.into_active_model();
    freq.network_id = Set(network_id_to);
    freq.update(txn).await.context(h!())?;

    info!(
        "Frequency {id} ({freq_value}MHz) has been moved from network {network_id_from} to {network_id_to}"
    );

    let json_new = sigint_network_freq::Entity::find_by_id(id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    sigint_network_freq_changelog::ActiveModel {
        id: NotSet,
        sigint_network_freq_id: Set(id),
        login_id: Set(*login),
        action: Set(ChangelogActionEnum::Merge),
        created_at: NotSet,
        new_value: Set(Some(json_new)),
        old_value: Set(Some(json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;
    Ok(())
}

///Reassign frequencies from the old networt to the new one
async fn reassign_freqs(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let mut freqs_to = sigint_network_freq::Entity::find()
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_to));
    if !merge_inactive {
        freqs_to = freqs_to
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .filter(sigint_network_freq::Column::ActiveTo.is_null());
    }
    let freqs_to = freqs_to.into_query();

    let mut freqs_from = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_freq::Column::Freq.not_in_subquery(freqs_to));
    if !merge_inactive {
        freqs_from = freqs_from
            .filter(sigint_network_freq::Column::Deleted.eq(false))
            .filter(sigint_network_freq::Column::ActiveTo.is_null());
    }
    let freqs_from = freqs_from
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;

    for freq in freqs_from {
        move_network_frequency(
            txn,
            login,
            freq,
            network_id_from,
            network_id_to,
        )
        .await
        .context(h!())?;
    }

    // Reconcile source frequencies that were not moved by the active-frequency pass.
    let mut freqs_to_delete = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from));
    if !merge_inactive {
        freqs_to_delete = freqs_to_delete
            .filter(sigint_network_freq::Column::Deleted.eq(false));
    }
    let mut freqs_to_delete = freqs_to_delete
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;
    freqs_to_delete
        .sort_by_key(|freq| (freq.deleted, freq.active_to.is_some(), freq.id));
    let target_freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_freq::Column::Id)
        .all(txn)
        .await
        .context(h!())?;
    let mut target_freq_ids = HashMap::new();
    for target_freq in target_freqs {
        let active = target_freq.active_to.is_none();
        target_freq_ids
            .entry(target_freq.freq)
            .and_modify(|entry: &mut (i64, bool)| {
                if active && !entry.1 {
                    *entry = (target_freq.id, active);
                }
            })
            .or_insert((target_freq.id, active));
    }
    let mut deleted_freqs = Vec::new();
    let now = Utc::now().naive_utc();
    for network_freq in freqs_to_delete {
        let target_freq_id = target_freq_ids
            .get(&network_freq.freq)
            .filter(|(_, active)| {
                network_freq.deleted
                    || network_freq.active_to.is_some()
                    || *active
            })
            .map(|(id, _)| *id);
        if let Some(target_freq_id) = target_freq_id {
            reassign_duplicate_frequency_references(
                txn,
                network_freq.id,
                target_freq_id,
            )
            .await
            .context(h!())?;
        } else {
            if !network_freq.deleted {
                target_freq_ids.insert(
                    network_freq.freq.clone(),
                    (network_freq.id, network_freq.active_to.is_none()),
                );
            }
            move_network_frequency(
                txn,
                login,
                network_freq,
                network_id_from,
                network_id_to,
            )
            .await
            .context(h!())?;
            continue;
        }
        let old_network_freq = network_freq.clone();
        let mut network_freq = network_freq.into_active_model();
        network_freq.deleted = Set(true);
        network_freq.active_to = Set(old_network_freq.active_to.or(Some(now)));
        let network_freq = network_freq.update(txn).await.context(h!())?;
        deleted_freqs.push(network_freq.freq.clone());
        record_activity_decision_if_changed(
            txn,
            ActivityDecisionTarget::Frequency {
                network_id: network_id_from,
                network_freq_id: network_freq.id,
                freq: &network_freq.freq,
            },
            ActivityDecisionActor::merge(Some(*login)),
            SIGINT_NETWORK_ACTIVITY_REASON_MERGE_FREQUENCY_CLOSED,
            ActivityState::frequency(&old_network_freq),
            ActivityState::frequency(&network_freq),
            ActivityDecisionEvidence::default(),
        )
        .await
        .context(h!())?;
    }
    info!(
        "Marked as deleted {} remaining freqs: {:?}",
        deleted_freqs.len(),
        deleted_freqs
    );

    if !merge_inactive {
        reconcile_referenced_deleted_source_frequencies(
            txn,
            network_id_from,
            network_id_to,
            &target_freq_ids,
        )
        .await
        .context(h!())?;
    }

    Ok(())
}

/// Reassign posts to the new network
async fn reassign_posts(
    txn: &DatabaseTransaction,
    merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let mut posts_to = sigint_network_post::Entity::find()
        .select_only()
        .column(sigint_network_post::Column::PostId)
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_to));
    if !merge_inactive {
        posts_to =
            posts_to.filter(sigint_network_post::Column::Deleted.eq(false));
    }
    let posts_to = posts_to.into_query();

    let mut posts_from = sigint_network_post::Entity::find()
        .find_also_related(SigintPost)
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_post::Column::PostId.not_in_subquery(posts_to));
    if !merge_inactive {
        posts_from =
            posts_from.filter(sigint_network_post::Column::Deleted.eq(false));
    }
    let posts_from = posts_from.all(txn).await.context(h!())?;

    for (network_post, post) in posts_from {
        let post_id = network_post.post_id;
        let post_name = post.map_or(String::default(), |p| p.name);
        let mut post_model = network_post.into_active_model();
        post_model.network_id = Set(network_id_to);
        post_model.update(txn).await.context(h!())?;
        info!(
            "Post \"{post_name}\" with id: {post_id} has been moved from network {network_id_from} to {network_id_to}"
        );
    }

    // Delete all remaining posts in the source network (those not reassigned)
    // Collect IDs first for logging
    let mut remaining_posts = sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from));
    if !merge_inactive {
        remaining_posts = remaining_posts
            .filter(sigint_network_post::Column::Deleted.eq(false));
    }
    let post_ids: Vec<i64> = remaining_posts
        .clone()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|post| post.id)
        .collect();

    let mut update_remaining_posts = sigint_network_post::Entity::update_many()
        .col_expr(sigint_network_post::Column::Deleted, Expr::value(true))
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from));
    if !merge_inactive {
        update_remaining_posts = update_remaining_posts
            .filter(sigint_network_post::Column::Deleted.eq(false));
    }
    let update_res = update_remaining_posts.exec(txn).await.context(h!())?;
    info!(
        "Marked as deleted {} remaining posts with IDs: {:?}",
        update_res.rows_affected, post_ids
    );

    Ok(())
}

/// Reassign descriptions to the new network
async fn reassign_descriptions(
    txn: &DatabaseTransaction,
    merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let mut descriptions_from = sigint_network_description::Entity::find()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        );
    if !merge_inactive {
        descriptions_from = descriptions_from
            .filter(sigint_network_description::Column::Deleted.eq(false));
    }
    let descriptions_from = descriptions_from.all(txn).await.context(h!())?;

    for description in descriptions_from {
        let descr_id = description.id;
        let mut descr_model = description.into_active_model();
        descr_model.network_id = Set(network_id_to);
        descr_model.update(txn).await.context(h!())?;
        info!(
            "Network description with id: {descr_id} has been moved from network {network_id_from} to {network_id_to}"
        );
    }

    // Delete all remaining descriptions in the source network (those not reassigned)
    // Collect IDs first for logging
    let mut remaining_descriptions = sigint_network_description::Entity::find()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        );
    if !merge_inactive {
        remaining_descriptions = remaining_descriptions
            .filter(sigint_network_description::Column::Deleted.eq(false));
    }
    let descr_ids: Vec<i64> = remaining_descriptions
        .clone()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|descr| descr.id)
        .collect();

    let mut update_remaining_descriptions =
        sigint_network_description::Entity::update_many()
            .col_expr(
                sigint_network_description::Column::Deleted,
                Expr::value(true),
            )
            .filter(
                sigint_network_description::Column::NetworkId
                    .eq(network_id_from),
            );
    if !merge_inactive {
        update_remaining_descriptions = update_remaining_descriptions
            .filter(sigint_network_description::Column::Deleted.eq(false));
    }
    let update_res = update_remaining_descriptions
        .exec(txn)
        .await
        .context(h!())?;
    info!(
        "Marked as deleted {} remaining network descriptions with IDs: {:?}",
        update_res.rows_affected, descr_ids
    );
    Ok(())
}

/// Reassign network callsigns from the old networt to the new one
async fn reassign_callsigns(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let mut callsigns_to = sigint_network_callsign::Entity::find()
        .select_only()
        .column(sigint_network_callsign::Column::SigintCallsign)
        .filter(
            sigint_network_callsign::Column::SigintNetworkId.eq(network_id_to),
        );
    if !merge_inactive {
        callsigns_to = callsigns_to
            .filter(sigint_network_callsign::Column::Deleted.eq(false));
    }
    let callsigns_to = callsigns_to.into_query();

    let mut callsigns_from = sigint_network_callsign::Entity::find()
        .filter(
            sigint_network_callsign::Column::SigintNetworkId
                .eq(network_id_from),
        )
        .filter(
            sigint_network_callsign::Column::SigintCallsign
                .not_in_subquery(callsigns_to),
        );
    if !merge_inactive {
        callsigns_from = callsigns_from
            .filter(sigint_network_callsign::Column::Deleted.eq(false));
    }
    let callsigns_from = callsigns_from.all(txn).await.context(h!())?;

    for net_callsign in callsigns_from {
        let id = net_callsign.id;
        let callsign_val = net_callsign.sigint_callsign.clone();
        let json_old = sigint_network_callsign::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;

        let mut net_callsign_model = net_callsign.into_active_model();
        net_callsign_model.sigint_network_id = Set(network_id_to);
        net_callsign_model.update(txn).await.context(h!())?;

        info!(
            "Network callsign \"{callsign_val}\" has been moved from network {network_id_from} to {network_id_to}"
        );

        // Log the change of an old network in the changelog
        let json_new = sigint_network_callsign::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_network_callsign_changelog::ActiveModel {
            id: NotSet,
            sigint_network_callsign_id: Set(id),
            login_id: Set(*login),
            action: Set(ChangelogActionEnum::Merge),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }

    // Delete all remaining network callsigns in the source network (those not reassigned)
    // Collect IDs first for logging
    let mut remaining_callsigns = sigint_network_callsign::Entity::find()
        .filter(
            sigint_network_callsign::Column::SigintNetworkId
                .eq(network_id_from),
        );
    if !merge_inactive {
        remaining_callsigns = remaining_callsigns
            .filter(sigint_network_callsign::Column::Deleted.eq(false));
    }
    let callsign_vals: Vec<String> = remaining_callsigns
        .clone()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|c| c.sigint_callsign)
        .collect();
    let mut update_remaining_callsigns =
        sigint_network_callsign::Entity::update_many().filter(
            sigint_network_callsign::Column::SigintNetworkId
                .eq(network_id_from),
        );
    if !merge_inactive {
        update_remaining_callsigns = update_remaining_callsigns
            .filter(sigint_network_callsign::Column::Deleted.eq(false));
    }
    let update_res = update_remaining_callsigns
        .col_expr(sigint_network_callsign::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .context(h!())?;
    info!(
        "Marked as deleted {} remaining network callsigns: {:?}",
        update_res.rows_affected, callsign_vals
    );

    Ok(())
}

/// Reassign network aor to the new network
async fn reassign_aors(
    txn: &DatabaseTransaction,
    _merge_inactive: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> Result<(), AppError> {
    let aors_to = sigint_network_aor::Entity::find()
        .select_only()
        .column(sigint_network_aor::Column::AorId)
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id_to))
        .into_query();

    let aors_from = sigint_network_aor::Entity::find()
        .find_also_related(AreaOfResponsibility)
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_aor::Column::AorId.not_in_subquery(aors_to))
        .all(txn)
        .await
        .context(h!())?;

    for (network_aor, aor) in aors_from {
        let aor_id = network_aor.aor_id;
        let aor_name = aor.map_or(String::default(), |a| a.name);
        let mut net_aor_model = network_aor.into_active_model();
        net_aor_model.network_id = Set(network_id_to);
        net_aor_model.update(txn).await.context(h!())?;
        info!(
            "AOR \"{aor_name}\" with id: {aor_id} has been moved from network {network_id_from} to {network_id_to}"
        );
    }

    // Delete all remaining aors in the source network (those not reassigned)
    // Collect IDs first for logging
    let aort_ids: Vec<i64> = sigint_network_aor::Entity::find()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id_from))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|a| a.id)
        .collect();

    let update_res = sigint_network_aor::Entity::delete_many()
        .filter(sigint_network_aor::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;
    info!(
        "Deleted {} remaining aors with IDs: {:?}",
        update_res.rows_affected, aort_ids
    );

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, find_test_organism, mk_sigint_network, mk_sigint_network_freq,
        mk_sigint_network_unit, mk_sigint_unit,
    };
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn network_merge_preserves_references_and_queues_recalculation() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let source = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let target = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let source_unit =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let target_unit =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let source_link = mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(source.id),
                unit_id: Set(source_unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_unit(
            &env.dbx,
            sigint_network_unit::ActiveModel {
                network_id: Set(target.id),
                unit_id: Set(target_unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let key = sigint_network_encryption_key::ActiveModel {
            organism_id: Set(find_test_organism(&env.dbx).await.unwrap().id),
            sigint_network_id: Set(Some(source.id)),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let saved_filter = sigint_saved_filter::ActiveModel {
            name: Set("merge reference".to_string()),
            req: Set(serde_json::json!({
                "selected_networks": [source.id, target.id, source.id]
            })),
            login_id: Set(Some(login)),
            r#type: Set(Some(SigintSavedFilterTypeEnum::Analysis)),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();

        assert!(merge_two_networks(
            &txn, &login, false, false, source.id, source.id
        )
        .await
        .is_err());
        merge_two_networks(&txn, &login, false, false, source.id, target.id)
            .await
            .unwrap();

        let source = sigint_network::Entity::find_by_id(source.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(source.deleted);
        assert_eq!(source.merged_to, Some(target.id));
        let target_units = sigint_network_unit::Entity::find()
            .filter(sigint_network_unit::Column::NetworkId.eq(target.id))
            .select_only()
            .column(sigint_network_unit::Column::UnitId)
            .into_tuple::<i64>()
            .all(&txn)
            .await
            .unwrap();
        assert!(target_units.contains(&source_unit.id));
        assert!(target_units.contains(&target_unit.id));
        let changelog = sigint_network_unit_changelog::Entity::find()
            .filter(
                sigint_network_unit_changelog::Column::SigintNetworkUnitId
                    .eq(source_link.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(changelog.old_value.unwrap()["network_id"], source.id);
        assert_eq!(changelog.new_value.unwrap()["network_id"], target.id);
        assert_eq!(
            sigint_network_encryption_key::Entity::find_by_id(key.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .sigint_network_id,
            Some(target.id)
        );
        assert_eq!(
            sigint_saved_filter::Entity::find_by_id(saved_filter.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .req["selected_networks"],
            serde_json::json!([target.id])
        );
        for network_id in [source.id, target.id] {
            assert!(
                network_invalidation_task::Entity::find()
                    .filter(
                        network_invalidation_task::Column::SigintNetworkId
                            .eq(network_id)
                    )
                    .count(&txn)
                    .await
                    .unwrap()
                    > 0
            );
        }
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn network_merge_repoints_duplicate_frequency_references() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let organism_id = find_test_organism(&env.dbx).await.unwrap().id;
        let source = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let target = mk_sigint_network(&env.dbx, Default::default())
            .await
            .unwrap();
        let source_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(source.id),
                freq: Set("146.5000".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let target_freq = mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(target.id),
                freq: Set(source_freq.freq.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let key = sigint_network_encryption_key::ActiveModel {
            organism_id: Set(organism_id),
            sigint_network_id: Set(Some(source.id)),
            sigint_network_freq_id: Set(Some(source_freq.id)),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let duplicate_key = sigint_network_encryption_key::ActiveModel {
            organism_id: Set(organism_id),
            sigint_network_id: Set(Some(source.id)),
            deleted: Set(false),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        for (key_id, freq_id) in [
            (key.id, source_freq.id),
            (duplicate_key.id, source_freq.id),
            (duplicate_key.id, target_freq.id),
        ] {
            sigint_network_encryption_key_freq::ActiveModel {
                sigint_network_encryption_key_id: Set(key_id),
                sigint_network_freq_id: Set(freq_id),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
        }
        let description = sigint_network_description::ActiveModel {
            network_id: Set(source.id),
            login_id: Set(login),
            r#type: Set(NetworkDescriptionType::Sign),
            description: Set("same frequency".to_string()),
            topic: Set(String::new()),
            deleted: Set(false),
            sigint_network_freq_id: Set(Some(source_freq.id)),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();

        let txn = env.dbx.begin().await.unwrap();
        merge_two_networks(&txn, &login, false, false, source.id, target.id)
            .await
            .unwrap();

        assert!(
            sigint_network_freq::Entity::find_by_id(source_freq.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        let key = sigint_network_encryption_key::Entity::find_by_id(key.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(key.sigint_network_id, Some(target.id));
        assert_eq!(key.sigint_network_freq_id, Some(target_freq.id));
        for key_id in [key.id, duplicate_key.id] {
            let links = sigint_network_encryption_key_freq::Entity::find()
                .filter(
                    sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                        .eq(key_id),
                )
                .all(&txn)
                .await
                .unwrap();
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].sigint_network_freq_id, target_freq.id);
        }
        let description =
            sigint_network_description::Entity::find_by_id(description.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(description.network_id, target.id);
        assert_eq!(description.sigint_network_freq_id, Some(target_freq.id));
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn network_merge_reconciles_deleted_frequency_refs_of_active_owners()
    {
        for target_has_freq in [false, true] {
            let env = cleanup().await.unwrap();
            let login = crate::users::login_id_by_name(&env.dbx, "Tester")
                .await
                .unwrap();
            let organism_id = find_test_organism(&env.dbx).await.unwrap().id;
            let source = mk_sigint_network(&env.dbx, Default::default())
                .await
                .unwrap();
            let target = mk_sigint_network(&env.dbx, Default::default())
                .await
                .unwrap();
            let source_freq = mk_sigint_network_freq(
                &env.dbx,
                sigint_network_freq::ActiveModel {
                    network_id: Set(source.id),
                    freq: Set("148.0000".to_string()),
                    deleted: Set(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let target_freq = if target_has_freq {
                Some(
                    mk_sigint_network_freq(
                        &env.dbx,
                        sigint_network_freq::ActiveModel {
                            network_id: Set(target.id),
                            freq: Set(source_freq.freq.clone()),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let mut key_ids = Vec::new();
            for deleted in [false, true] {
                let key = sigint_network_encryption_key::ActiveModel {
                    organism_id: Set(organism_id),
                    sigint_network_id: Set(Some(source.id)),
                    sigint_network_freq_id: Set(Some(source_freq.id)),
                    deleted: Set(deleted),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
                sigint_network_encryption_key_freq::ActiveModel {
                    sigint_network_encryption_key_id: Set(key.id),
                    sigint_network_freq_id: Set(source_freq.id),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
                key_ids.push(key.id);
            }
            let mut description_ids = Vec::new();
            for deleted in [false, true] {
                let description = sigint_network_description::ActiveModel {
                    network_id: Set(source.id),
                    login_id: Set(login),
                    r#type: Set(NetworkDescriptionType::Sign),
                    description: Set("deleted source frequency".to_string()),
                    topic: Set(String::new()),
                    deleted: Set(deleted),
                    sigint_network_freq_id: Set(Some(source_freq.id)),
                    ..Default::default()
                }
                .insert(&env.dbx)
                .await
                .unwrap();
                description_ids.push(description.id);
            }

            let txn = env.dbx.begin().await.unwrap();
            merge_two_networks(
                &txn, &login, false, false, source.id, target.id,
            )
            .await
            .unwrap();
            let source_freq =
                sigint_network_freq::Entity::find_by_id(source_freq.id)
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(source_freq.network_id, source.id);
            let target_freq_id = if let Some(target_freq) = target_freq {
                target_freq.id
            } else {
                let copied = sigint_network_freq::Entity::find()
                    .filter(
                        sigint_network_freq::Column::NetworkId.eq(target.id),
                    )
                    .filter(
                        sigint_network_freq::Column::Freq.eq(&source_freq.freq),
                    )
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(copied.deleted);
                copied.id
            };
            for (deleted, key_id, description_id) in [
                (false, key_ids[0], description_ids[0]),
                (true, key_ids[1], description_ids[1]),
            ] {
                let expected_freq_id = if deleted {
                    source_freq.id
                } else {
                    target_freq_id
                };
                let expected_network_id =
                    if deleted { source.id } else { target.id };
                let key =
                    sigint_network_encryption_key::Entity::find_by_id(key_id)
                        .one(&txn)
                        .await
                        .unwrap()
                        .unwrap();
                assert_eq!(key.sigint_network_id, Some(expected_network_id));
                assert_eq!(key.sigint_network_freq_id, Some(expected_freq_id));
                let links = sigint_network_encryption_key_freq::Entity::find()
                    .filter(
                        sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                            .eq(key_id),
                    )
                    .all(&txn)
                    .await
                    .unwrap();
                assert_eq!(links.len(), 1);
                assert_eq!(links[0].sigint_network_freq_id, expected_freq_id);
                let description =
                    sigint_network_description::Entity::find_by_id(
                        description_id,
                    )
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(description.network_id, expected_network_id);
                assert_eq!(
                    description.sigint_network_freq_id,
                    Some(expected_freq_id)
                );
            }
            txn.rollback().await.unwrap();
        }
    }

    #[tokio::test]
    #[serial]
    async fn network_merge_preserves_unmatched_key_frequencies() {
        for (merge_inactive, source_closed, target_state, deleted_source) in [
            (false, true, None, false),
            (false, false, Some((true, false)), false),
            (true, false, Some((true, false)), true),
            (true, false, Some((false, true)), false),
        ] {
            let env = cleanup().await.unwrap();
            let login = crate::users::login_id_by_name(&env.dbx, "Tester")
                .await
                .unwrap();
            let source = mk_sigint_network(&env.dbx, Default::default())
                .await
                .unwrap();
            let target = mk_sigint_network(&env.dbx, Default::default())
                .await
                .unwrap();
            let closed_at = Utc::now().naive_utc();
            if deleted_source {
                mk_sigint_network_freq(
                    &env.dbx,
                    sigint_network_freq::ActiveModel {
                        network_id: Set(source.id),
                        freq: Set("147.0000".to_string()),
                        deleted: Set(true),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            }
            let source_freq = mk_sigint_network_freq(
                &env.dbx,
                sigint_network_freq::ActiveModel {
                    network_id: Set(source.id),
                    freq: Set("147.0000".to_string()),
                    active_to: Set(source_closed.then_some(closed_at)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let source_active_to = source_freq.active_to;
            if let Some((deleted, closed)) = target_state {
                mk_sigint_network_freq(
                    &env.dbx,
                    sigint_network_freq::ActiveModel {
                        network_id: Set(target.id),
                        freq: Set(source_freq.freq.clone()),
                        deleted: Set(deleted),
                        active_to: Set(closed.then_some(closed_at)),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            }
            let key = sigint_network_encryption_key::ActiveModel {
                organism_id: Set(find_test_organism(&env.dbx)
                    .await
                    .unwrap()
                    .id),
                sigint_network_id: Set(Some(source.id)),
                sigint_network_freq_id: Set(Some(source_freq.id)),
                deleted: Set(false),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            sigint_network_encryption_key_freq::ActiveModel {
                sigint_network_encryption_key_id: Set(key.id),
                sigint_network_freq_id: Set(source_freq.id),
                ..Default::default()
            }
            .insert(&env.dbx)
            .await
            .unwrap();

            let txn = env.dbx.begin().await.unwrap();
            merge_two_networks(
                &txn,
                &login,
                false,
                merge_inactive,
                source.id,
                target.id,
            )
            .await
            .unwrap();

            let source_freq =
                sigint_network_freq::Entity::find_by_id(source_freq.id)
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(source_freq.network_id, target.id);
            assert!(!source_freq.deleted);
            assert_eq!(source_freq.active_to, source_active_to);
            let key = sigint_network_encryption_key::Entity::find_by_id(key.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(key.sigint_network_id, Some(target.id));
            assert_eq!(key.sigint_network_freq_id, Some(source_freq.id));
            let links = sigint_network_encryption_key_freq::Entity::find()
                .filter(
                    sigint_network_encryption_key_freq::Column::SigintNetworkEncryptionKeyId
                        .eq(key.id),
                )
                .all(&txn)
                .await
                .unwrap();
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].sigint_network_freq_id, source_freq.id);
            txn.rollback().await.unwrap();
        }
    }

    #[tokio::test]
    #[serial]
    async fn checked_network_merge_compares_all_linked_units() {
        let env = cleanup().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        let source = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("shared name".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let target = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                name: Set("shared name".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let shared =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let extra = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        for (network_id, unit_id) in [
            (source.id, shared.id),
            (target.id, shared.id),
            (target.id, extra.id),
        ] {
            mk_sigint_network_unit(
                &env.dbx,
                sigint_network_unit::ActiveModel {
                    network_id: Set(network_id),
                    unit_id: Set(unit_id),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let txn = env.dbx.begin().await.unwrap();
        assert!(merge_two_networks(
            &txn, &login, true, false, source.id, target.id
        )
        .await
        .is_err());
        txn.rollback().await.unwrap();
    }
}
