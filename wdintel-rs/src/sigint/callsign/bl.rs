use super::types::*;
use crate::entities::*;
use crate::sigint::etalonka::types::{KnownCallsignRes, KnownCallsignShortRes};
use crate::types::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

pub async fn bl_callsign_create(
    req: &CreateCallsignReq,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<sigint_callsign::Model, AppError> {
    let callsign = sigint_callsign::ActiveModel {
        id: NotSet,
        callsign: Set(req.callsign.clone().trim().to_lowercase()),
        position: Set(req.position.clone()),
        unit_id: Set(req.unit_id),
        comment: Set(req.comment.clone()),
        deleted: Set(false),
        source_id: Set(req.source_id),
        created_at: NotSet,
        developing: Set(req.developing),
        radio_freq: Set(req.radio_freq.clone().unwrap_or("".to_string())),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    sync_callsign_additional_source_ids(
        txn,
        callsign.id,
        &req.callsign_additional_sources,
    )
    .await
    .context(h!())?;

    let callsign_json = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;

    let _changelog = sigint_callsign_changelog::ActiveModel {
        sigint_origin_id: NotSet,
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user_id.to_string()),
        action: Set("create".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json)),
        old_value: NotSet,
        req: Set(Some(serde_json::to_value(req).context(h!())?)),
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    Ok(callsign)
}

pub async fn bl_callsign_update(
    req: &Callsign,
    user_id: &str,
    txn: &DatabaseTransaction,
) -> Result<sigint_callsign::Model, AppError> {
    let callsign = find_callsign(txn, req.id).await.context(h!())?;
    let callsign_json_old = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(txn)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let mut callsign = callsign.into_active_model();
    callsign.callsign = Set(req.callsign.clone().trim().to_lowercase());
    callsign.position = Set(req.position.clone());
    callsign.unit_id = Set(req.unit_id);
    callsign.comment = Set(req.comment.clone());
    callsign.source_id = Set(req.source_id);
    callsign.developing = Set(req.developing);
    callsign.radio_freq = Set(req.radio_freq.clone().unwrap_or("".to_string()));
    let callsign = callsign.update(txn).await.context(h!())?;

    sync_callsign_additional_source_ids(
        txn,
        callsign.id,
        &req.callsign_additional_sources,
    )
    .await
    .context(h!())?;

    let callsign_json_new = sigint_callsign::Entity::find_by_id(callsign.id)
        .into_json()
        .one(txn)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    let _changelog = sigint_callsign_changelog::ActiveModel {
        id: NotSet,
        sigint_callsign_id: Set(callsign.id),
        login: Set(user_id.to_string()),
        action: Set("update".to_string()),
        created_at: NotSet,
        new_value: Set(Some(callsign_json_new)),
        old_value: Set(Some(callsign_json_old)),
        req: Set(None),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    Ok(callsign)
}

fn normalize_callsign_additional_source_ids(source_ids: &[i64]) -> Vec<i64> {
    let mut source_ids_set = HashSet::new();
    for source_id in source_ids.iter().copied().filter(|id| *id > 0) {
        source_ids_set.insert(source_id);
    }

    let mut source_ids = source_ids_set.into_iter().collect::<Vec<_>>();
    source_ids.sort_unstable();
    source_ids
}

pub async fn list_callsign_additional_source_ids<'a, 'async_trait, C>(
    txn: &'a C,
    callsign_id: i64,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let source_ids = callsign_additional_source::Entity::find()
        .filter(
            callsign_additional_source::Column::SigintCallsignId
                .eq(callsign_id),
        )
        .order_by_asc(callsign_additional_source::Column::Id)
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|source| source.source_id)
        .collect::<Vec<_>>();

    Ok(source_ids)
}

pub async fn list_callsign_additional_source_ids_batch<'a, 'async_trait, C>(
    txn: &'a C,
    callsign_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if callsign_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = callsign_additional_source::Entity::find()
        .filter(
            callsign_additional_source::Column::SigintCallsignId
                .is_in(callsign_ids.to_vec()),
        )
        .order_by_asc(callsign_additional_source::Column::SigintCallsignId)
        .order_by_asc(callsign_additional_source::Column::Id)
        .all(txn)
        .await
        .context(h!())?;

    let mut source_ids_by_callsign = HashMap::<i64, Vec<i64>>::new();
    for row in rows {
        source_ids_by_callsign
            .entry(row.sigint_callsign_id)
            .or_default()
            .push(row.source_id);
    }

    Ok(source_ids_by_callsign)
}

pub async fn sync_callsign_additional_source_ids(
    txn: &DatabaseTransaction,
    callsign_id: i64,
    source_ids_req: &[i64],
) -> Result<(), AppError> {
    let source_ids_req =
        normalize_callsign_additional_source_ids(source_ids_req);
    let source_ids_existing = callsign_additional_source::Entity::find()
        .filter(
            callsign_additional_source::Column::SigintCallsignId
                .eq(callsign_id),
        )
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|source| source.source_id)
        .collect::<Vec<_>>();

    let source_ids_req_set =
        source_ids_req.into_iter().collect::<HashSet<i64>>();
    let source_ids_existing_set =
        source_ids_existing.into_iter().collect::<HashSet<i64>>();

    let mut source_ids_to_insert = source_ids_req_set
        .difference(&source_ids_existing_set)
        .copied()
        .collect::<Vec<_>>();
    source_ids_to_insert.sort_unstable();

    let mut source_ids_to_delete = source_ids_existing_set
        .difference(&source_ids_req_set)
        .copied()
        .collect::<Vec<_>>();
    source_ids_to_delete.sort_unstable();

    if !source_ids_to_delete.is_empty() {
        callsign_additional_source::Entity::delete_many()
            .filter(
                callsign_additional_source::Column::SigintCallsignId
                    .eq(callsign_id),
            )
            .filter(
                callsign_additional_source::Column::SourceId
                    .is_in(source_ids_to_delete),
            )
            .exec(txn)
            .await
            .context(h!())?;
    }

    if !source_ids_to_insert.is_empty() {
        let models = source_ids_to_insert
            .into_iter()
            .map(|source_id| callsign_additional_source::ActiveModel {
                id: NotSet,
                sigint_callsign_id: Set(callsign_id),
                source_id: Set(source_id),
                created_at: NotSet,
            })
            .collect::<Vec<_>>();

        callsign_additional_source::Entity::insert_many(models)
            .exec(txn)
            .await
            .context(h!())?;
    }

    Ok(())
}

pub fn match_known_callsigns(
    known_callsigns: Option<&Vec<KnownCallsignRes>>,
    callsign: &str,
    unit_id: Option<i64>,
    unit_name: &Option<String>,
) -> Option<Vec<KnownCallsignShortRes>> {
    let known_callsigns = known_callsigns?;

    // Collect all matching known_callsigns based on the same top level units
    let matched: Vec<KnownCallsignRes> = known_callsigns
        .iter()
        .filter(|kc| {
            kc.callsign == callsign
                && unit_name
                    .as_ref()
                    .is_some_and(|u| kc.unit_name.ends_with(u))
        })
        .cloned()
        .collect();

    // If no match found, fallback to Callsign + UnitId matching
    let matched = if matched.is_empty() {
        known_callsigns
            .iter()
            .filter(|kc| kc.callsign == callsign && Some(kc.unit_id) == unit_id)
            .cloned()
            .collect()
    } else {
        matched
    };

    if matched.is_empty() {
        return None;
    }

    Some(
        matched
            .into_iter()
            .map(|kc| KnownCallsignShortRes {
                id: kc.id,
                callsign: kc.callsign,
                position: kc.position,
                comment: kc.comment,
                unit_id: kc.unit_id,
                unit_name: kc.unit_name,
                source_name: kc.source_name.unwrap_or_default(),
                created_at: kc.created_at.and_utc().timestamp_millis(),
            })
            .collect(),
    )
}

pub async fn find_callsign<'a, 'async_trait, C>(
    txn: &'a C,
    callsign_id: i64,
) -> Result<sigint_callsign::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let callsign = sigint_callsign::Entity::find_by_id(callsign_id)
        .one(txn)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(callsign)
}
