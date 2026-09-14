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
use std::collections::HashSet;

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
    let unit_from = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_from))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    let unit_to = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_to))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    if perform_merge_check {
        // Validate if merge is allowed (Names should match)
        if network_from.name != network_to.name {
            return Err(AppError::BL {
                msg: "Networks names or kinds mismatch".to_string(),
            });
        }

        // Ensure they belong to the same unit
        if unit_from != unit_to {
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

    reassign_units(txn, network_id_from, network_id_to)
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
            let mut unit = unit.into_active_model();
            unit.network_id = Set(network_id_to);
            unit.update(txn).await.c(h!())?;
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

    reassign_encryption_key_freqs(txn, freq_id_from, freq_id_to)
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
) -> Result<(), AppError> {
    let key_freqs_from = sigint_network_encryption_key_freq::Entity::find()
        .filter(
            sigint_network_encryption_key_freq::Column::SigintNetworkFreqId
                .eq(freq_id_from),
        )
        .all(txn)
        .await
        .context(h!())?;

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
        let id = freq.id;
        let freq_value = freq.freq.clone();
        let json_old = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;

        let mut freq_model = freq.into_active_model();
        freq_model.network_id = Set(network_id_to);
        freq_model.update(txn).await.context(h!())?;

        info!(
            "Frequency {id} ({freq_value}MHz) has been moved from network {network_id_from} to {network_id_to}"
        );

        // Log the change of an old network in the changelog
        let json_new = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
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
    }

    // Delete all remaining freqs in the source network (those not reassigned)
    // Collect IDs first for logging
    let mut freqs_to_delete = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from));
    if !merge_inactive {
        freqs_to_delete = freqs_to_delete
            .filter(sigint_network_freq::Column::Deleted.eq(false));
    }
    let freqs_to_delete = freqs_to_delete
        .order_by_asc(sigint_network_freq::Column::Id)
        .lock_exclusive()
        .all(txn)
        .await
        .context(h!())?;
    let freq_vals = freqs_to_delete
        .iter()
        .map(|network_freq| network_freq.freq.clone())
        .collect::<Vec<_>>();
    let rows_affected = freqs_to_delete.len();
    let now = Utc::now().naive_utc();
    for network_freq in freqs_to_delete {
        let old_network_freq = network_freq.clone();
        let mut network_freq = network_freq.into_active_model();
        network_freq.deleted = Set(true);
        network_freq.active_to = Set(old_network_freq.active_to.or(Some(now)));
        let network_freq = network_freq.update(txn).await.context(h!())?;
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
        rows_affected, freq_vals
    );

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
        cleanup, find_test_organism, mk_sigint_network, mk_sigint_network_unit,
        mk_sigint_unit,
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
        mk_sigint_network_unit(
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
}
