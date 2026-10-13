use crate::entities::messenger_account;
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::types::ShortContext;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The general ingest sync contract, shared by every entity kind
/// (accounts, chats, messages, ...). A sync request is a delta:
/// `created` is a list of new items, `updated` maps echo uuids to full
/// item bodies, `deleted` is a list of echo uuids. The response mirrors
/// the shape with the stored item bodies: `created` and `updated` map
/// echo uuids to the resulting items and `deleted` lists the uuids that
/// were actually deleted. Every collection is present and may be empty;
/// no null items. A batch item cap applies per endpoint.
///
/// 64-bit messenger ids travel as decimal strings on the wire and are
/// parsed to integers server-side.

/// The Telegram id of an account. The presence of a messenger sub-object
/// on an item implies the `messenger_type`; it is never part of the API.
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
pub struct MessengerIngestTelegramAccountId {
    pub user_id: String,
}

/// A reference to an account from a child endpoint (chats, messages, ...).
/// The collector learned all three ids from the accounts sync response.
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
pub struct MessengerIngestAccountRef {
    pub id: String,
    pub external_id: String,
    pub telegram: MessengerIngestTelegramAccountId,
}

pub(crate) fn parse_echo_uuid(raw: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(raw).map_err(|_| AppError::BL {
        msg: format!("invalid echo uuid: {raw}"),
    })
}

pub(crate) fn parse_i64_decimal(
    field: &str,
    raw: &str,
) -> Result<i64, AppError> {
    raw.parse::<i64>().map_err(|_| AppError::BL {
        msg: format!("invalid {field}: {raw}"),
    })
}

/// Resolves an account ref to a live row within the scope. A ref that
/// exists under another login or datasource, or whose `external_id` or
/// messenger id disagrees with the stored row, is reported as not found,
/// so foreign ids are never confirmed to the caller.
/// Used by the child endpoints (chats, messages) from Stage 2 on.
#[allow(dead_code)]
pub(crate) async fn resolve_account_ref(
    txn: &impl ConnectionTrait,
    scope: &IngestScope,
    r: &MessengerIngestAccountRef,
) -> Result<messenger_account::Model, AppError> {
    let id = parse_echo_uuid(&r.id)?;
    let account = find_scoped_account_by_id(txn, scope, id).await?;
    if account.external_id != r.external_id {
        return Err(AppError::NotFound);
    }
    let user_id = parse_i64_decimal("telegram user_id", &r.telegram.user_id)?;
    if account.telegram_user_id != Some(user_id) {
        return Err(AppError::NotFound);
    }
    Ok(account)
}

pub(crate) async fn find_scoped_account_by_id(
    txn: &impl ConnectionTrait,
    scope: &IngestScope,
    id: Uuid,
) -> Result<messenger_account::Model, AppError> {
    messenger_account::Entity::find()
        .filter(messenger_account::Column::Id.eq(id))
        .filter(messenger_account::Column::LoginId.eq(scope.login_id))
        .filter(
            messenger_account::Column::DatasourceId.eq(scope.datasource_id()),
        )
        .filter(messenger_account::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

pub(crate) async fn find_scoped_account_by_external_id(
    txn: &impl ConnectionTrait,
    scope: &IngestScope,
    external_id: &str,
) -> Result<Option<messenger_account::Model>, AppError> {
    let maybe = messenger_account::Entity::find()
        .filter(
            messenger_account::Column::ExternalId.eq(external_id.to_string()),
        )
        .filter(messenger_account::Column::LoginId.eq(scope.login_id))
        .filter(
            messenger_account::Column::DatasourceId.eq(scope.datasource_id()),
        )
        .one(txn)
        .await
        .c(h!())?;
    Ok(maybe)
}
