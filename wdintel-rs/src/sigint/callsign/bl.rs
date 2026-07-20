use super::types::*;
use crate::config::SIGINT_SOURCE_RO_ID;
use crate::entities::*;
use crate::sigint::etalonka::types::{KnownCallsignRes, KnownCallsignShortRes};
use crate::types::*;
use sea_orm::*;
use std::collections::{HashMap, HashSet};

const CALLSIGN_IDENTITY_REQUIRED_MSG: &str =
    "Заповніть поле \"Позивний\" або \"ПІП\"";
const RO_CALLSIGN_RADIO_FREQ_REQUIRED_MSG: &str =
    "При виборі джерела 'РО' необхідно вказати частоту";

fn has_callsign_identity(callsign: &str, full_name: &str) -> bool {
    !callsign.trim().is_empty() || !full_name.trim().is_empty()
}

fn effective_update_full_name<'a>(
    req: &'a UpdateCallsignReq,
    current_full_name: &'a str,
) -> &'a str {
    if req.full_name_is_missing {
        current_full_name
    } else {
        req.full_name.as_deref().unwrap_or("")
    }
}

fn validate_ro_callsign_radio_freq(
    source_id: Option<i32>,
    radio_freq: Option<&str>,
) -> Result<(), AppError> {
    if source_id == Some(SIGINT_SOURCE_RO_ID)
        && radio_freq.is_none_or(|radio_freq| radio_freq.trim().is_empty())
    {
        return Err(AppError::BL {
            msg: RO_CALLSIGN_RADIO_FREQ_REQUIRED_MSG.to_string(),
        });
    }

    Ok(())
}

fn has_callsign_legacy_content(
    position: &str,
    comment: &str,
    radio_freq: Option<&str>,
    developing: bool,
    unit_id: i64,
    source_id: Option<i32>,
    callsign_additional_sources: &[i64],
) -> bool {
    !position.trim().is_empty()
        || !comment.trim().is_empty()
        || radio_freq.is_some_and(|radio_freq| !radio_freq.trim().is_empty())
        || developing
        || unit_id > 0
        || source_id.is_some()
        || !callsign_additional_sources.is_empty()
}

fn has_callsign_create_content(
    position: &str,
    comment: &str,
    radio_freq: Option<&str>,
    developing: bool,
) -> bool {
    !position.trim().is_empty()
        || !comment.trim().is_empty()
        || radio_freq.is_some_and(|radio_freq| !radio_freq.trim().is_empty())
        || developing
}

fn validate_create_callsign_req(
    req: &CreateCallsignReq,
) -> Result<(), AppError> {
    validate_ro_callsign_radio_freq(req.source_id, req.radio_freq.as_deref())?;

    if has_callsign_identity(&req.callsign, &req.full_name) {
        return Ok(());
    }

    if has_callsign_create_content(
        &req.position,
        &req.comment,
        req.radio_freq.as_deref(),
        req.developing,
    ) {
        return Ok(());
    }

    Err(AppError::BL {
        msg: CALLSIGN_IDENTITY_REQUIRED_MSG.to_string(),
    })
}

fn validate_update_callsign_req(
    req: &UpdateCallsignReq,
    current_full_name: &str,
) -> Result<(), AppError> {
    validate_ro_callsign_radio_freq(req.source_id, req.radio_freq.as_deref())?;

    if has_callsign_identity(
        &req.callsign,
        effective_update_full_name(req, current_full_name),
    ) {
        return Ok(());
    }

    if has_callsign_legacy_content(
        &req.position,
        &req.comment,
        req.radio_freq.as_deref(),
        req.developing,
        req.unit_id,
        req.source_id,
        &req.callsign_additional_sources,
    ) {
        return Ok(());
    }

    Err(AppError::BL {
        msg: CALLSIGN_IDENTITY_REQUIRED_MSG.to_string(),
    })
}

pub async fn bl_callsign_create(
    req: &CreateCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
) -> Result<sigint_callsign::Model, AppError> {
    validate_create_callsign_req(req)?;

    let callsign = sigint_callsign::ActiveModel {
        id: NotSet,
        callsign: Set(req.callsign.clone().trim().to_lowercase()),
        position: Set(req.position.clone()),
        unit_id: Set(req.unit_id),
        comment: Set(req.comment.clone()),
        full_name: Set(req.full_name.clone()),
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
        login_id: Set(*user_id),
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
    req: &UpdateCallsignReq,
    user_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
) -> Result<sigint_callsign::Model, AppError> {
    let callsign = find_callsign(txn, req.id).await.context(h!())?;
    validate_update_callsign_req(req, &callsign.full_name)?;
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
    if !req.full_name_is_missing {
        callsign.full_name = Set(req.full_name.clone().unwrap_or_default());
    }
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
        login_id: Set(*user_id),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn create_req() -> CreateCallsignReq {
        CreateCallsignReq {
            callsign: String::new(),
            position: String::new(),
            comment: String::new(),
            full_name: String::new(),
            unit_id: 0,
            source_id: None,
            callsign_additional_sources: vec![],
            developing: false,
            radio_freq: None,
        }
    }

    fn update_req() -> UpdateCallsignReq {
        UpdateCallsignReq {
            id: 1,
            callsign: String::new(),
            position: String::new(),
            comment: String::new(),
            full_name: Some(String::new()),
            full_name_is_missing: false,
            unit_id: 0,
            active: true,
            source_id: None,
            callsign_additional_sources: vec![],
            created_at: 0,
            developing: false,
            radio_freq: None,
        }
    }

    #[test]
    fn validate_create_callsign_req_allows_identity_or_legacy_content() {
        let mut req = create_req();
        req.full_name = "Іваненко Іван Іванович".to_string();
        assert!(validate_create_callsign_req(&req).is_ok());

        let mut req = create_req();
        req.comment = "невстановлений оператор".to_string();
        assert!(validate_create_callsign_req(&req).is_ok());
    }

    #[test]
    fn validate_create_callsign_req_rejects_identityless_record_with_only_unit_and_source(
    ) {
        let mut req = create_req();
        req.unit_id = 123;
        req.source_id = Some(2);

        assert!(validate_create_callsign_req(&req).is_err());
    }

    #[test]
    fn validate_create_callsign_req_rejects_empty_record() {
        assert!(validate_create_callsign_req(&create_req()).is_err());
    }

    #[test]
    fn validate_create_callsign_req_rejects_identityless_record_with_only_confirmation_sources(
    ) {
        let mut req = create_req();
        req.callsign_additional_sources = vec![7, 11];

        assert!(validate_create_callsign_req(&req).is_err());
    }

    #[test]
    fn validate_create_callsign_req_rejects_ro_callsign_without_radio_freq() {
        let mut req = create_req();
        req.callsign = "alpha".to_string();
        req.source_id = Some(SIGINT_SOURCE_RO_ID);

        assert!(validate_create_callsign_req(&req).is_err());
    }

    #[test]
    fn validate_create_callsign_req_allows_ro_callsign_with_radio_freq() {
        let mut req = create_req();
        req.callsign = "alpha".to_string();
        req.source_id = Some(SIGINT_SOURCE_RO_ID);
        req.radio_freq = Some("145.500".to_string());

        assert!(validate_create_callsign_req(&req).is_ok());
    }

    #[test]
    fn validate_update_callsign_req_allows_identityless_record_with_other_content(
    ) {
        let mut req = update_req();
        req.comment = "невстановлений оператор".to_string();

        assert!(validate_update_callsign_req(&req, "").is_ok());
    }

    #[test]
    fn validate_update_callsign_req_rejects_empty_record() {
        assert!(validate_update_callsign_req(&update_req(), "").is_err());
    }

    #[test]
    fn validate_update_callsign_req_rejects_ro_callsign_without_radio_freq() {
        let mut req = update_req();
        req.callsign = "alpha".to_string();
        req.source_id = Some(SIGINT_SOURCE_RO_ID);

        assert!(validate_update_callsign_req(&req, "").is_err());
    }

    #[test]
    fn validate_update_callsign_req_allows_ro_callsign_with_radio_freq() {
        let mut req = update_req();
        req.callsign = "alpha".to_string();
        req.source_id = Some(SIGINT_SOURCE_RO_ID);
        req.radio_freq = Some("145.500".to_string());

        assert!(validate_update_callsign_req(&req, "").is_ok());
    }

    #[test]
    fn validate_update_callsign_req_preserves_legacy_missing_full_name() {
        let mut req = update_req();
        req.full_name = None;
        req.full_name_is_missing = true;
        req.comment = "невстановлений оператор".to_string();

        assert!(validate_update_callsign_req(&req, "").is_ok());
    }

    #[test]
    fn validate_update_callsign_req_allows_explicit_full_name_clear() {
        let mut req = update_req();
        req.full_name = Some(String::new());
        req.comment = "невстановлений оператор".to_string();

        assert!(validate_update_callsign_req(&req, "").is_ok());
    }

    #[test]
    fn validate_update_callsign_req_allows_legacy_request_when_db_has_full_name_only(
    ) {
        let mut req = update_req();
        req.full_name = None;
        req.full_name_is_missing = true;

        assert!(validate_update_callsign_req(&req, "Іваненко Іван Іванович")
            .is_ok());
    }

    #[test]
    fn validate_update_callsign_req_allows_null_full_name_to_clear_identity() {
        let mut req = update_req();
        req.full_name = None;
        req.full_name_is_missing = false;
        req.comment = "невстановлений оператор".to_string();

        assert!(validate_update_callsign_req(&req, "").is_ok());
    }
}
