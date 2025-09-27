use super::types::*;
use crate::entities::*;
use crate::sigint::etalonka::types::{KnownCallsignRes, KnownCallsignShortRes};
use crate::types::*;
use sea_orm::*;

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
