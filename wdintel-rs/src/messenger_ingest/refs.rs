use crate::config::{
    MESSENGER_INGEST_EXTERNAL_URL_MAX_LEN, MESSENGER_INGEST_MESSENGER_TYPES,
    MESSENGER_TYPE_TELEGRAM,
};
use crate::entities::{
    messenger_account, messenger_chat, messenger_chat_member, messenger_contact,
};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::types::MessengerIngestTelegramChatId;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// The general ingest sync contract, shared by every entity kind
// (accounts, chats, messages, ...). A sync request is a delta:
// `created` is a list of new items, `updated` maps echo uuids to full
// item bodies, `deleted` is a list of echo uuids. The response mirrors
// the shape with the stored item bodies: `created` and `updated` map
// echo uuids to the resulting items and `deleted` lists the uuids that
// were actually deleted. Every collection is present and may be empty;
// no null items. A batch item cap applies per endpoint.
//
// 64-bit messenger ids travel as decimal strings on the wire and are
// parsed to integers server-side.

/// The Telegram id of an account. Provider sub-objects are optional and
/// only allowed when they match the account's `messenger_type`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestTelegramAccountId {
    pub user_id: String,
}

/// A reference to an account from a child endpoint (chats, messages, ...).
/// The collector learned all three ids from the accounts sync response.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestAccountRef {
    pub id: String,
    pub external_id: String,
    pub messenger_type: String,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

/// A reference to a chat from a child endpoint (messages, members, ...).
/// The collector learned the ids from the chats sync response.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengerIngestChatRef {
    pub id: String,
    pub external_id: String,
    pub telegram: Option<MessengerIngestTelegramChatId>,
}

/// A reference to a member of a chat (a message sender, ...). The
/// collector learned the ids from the chat members sync response.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestChatMemberRef {
    pub id: String,
    pub external_id: String,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

/// A reference to a contact of an account (an avatar owner, ...). The
/// collector learned the ids from the contacts sync response.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MessengerIngestContactRef {
    pub id: String,
    pub external_id: String,
    pub telegram: Option<MessengerIngestTelegramAccountId>,
}

/// Rejects unknown messenger types and provider sub-objects that do not
/// belong to the item's messenger. Provider sub-objects stay optional.
pub(crate) fn ensure_provider_fields(
    messenger_type: &str,
    has_telegram: bool,
) -> Result<(), AppError> {
    if !MESSENGER_INGEST_MESSENGER_TYPES.contains(&messenger_type) {
        return Err(AppError::BL {
            msg: format!("unknown messenger_type: {messenger_type}"),
        });
    }
    if has_telegram && messenger_type != MESSENGER_TYPE_TELEGRAM {
        return Err(AppError::BL {
            msg: format!(
                "telegram fields are not allowed for {messenger_type}"
            ),
        });
    }
    Ok(())
}

/// An account link as stored: `None` for an absent or blank value,
/// otherwise the normalized absolute http(s) URL. Anything else is
/// rejected, since the UI renders the link as a clickable anchor.
pub(crate) fn normalize_external_url(
    external_url: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(external_url) = external_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let max_len = MESSENGER_INGEST_EXTERNAL_URL_MAX_LEN;
    if external_url.len() > max_len {
        return Err(AppError::BL {
            msg: format!("external_url is longer than {max_len} bytes"),
        });
    }
    let url = url::Url::parse(external_url).ok().filter(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    });
    let Some(url) = url else {
        return Err(AppError::BL {
            msg: format!(
                "external_url must be an http(s) URL without credentials: {external_url}"
            ),
        });
    };
    if url.as_str().len() > max_len {
        return Err(AppError::BL {
            msg: format!("external_url is longer than {max_len} bytes"),
        });
    }
    Ok(Some(String::from(url)))
}

/// Rejects a `created` collection that names one `external_id` twice: a
/// repeated item would otherwise be applied as an update of the first.
pub(crate) fn ensure_unique_created_external_ids<'a>(
    kind: &str,
    external_ids: impl IntoIterator<Item = &'a str>,
) -> Result<(), AppError> {
    let mut seen = std::collections::BTreeSet::new();
    for external_id in external_ids {
        if !seen.insert(external_id) {
            return Err(AppError::BL {
                msg: format!(
                    "duplicate {kind} external_id in created: {external_id}"
                ),
            });
        }
    }
    Ok(())
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

/// Epoch milliseconds (UTC) from the wire to a naive UTC timestamp.
pub(crate) fn timestamp_from_millis(
    ms: Option<i64>,
) -> Result<Option<NaiveDateTime>, AppError> {
    ms.map(|ms| {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| dt.naive_utc())
            .ok_or_else(|| AppError::BL {
                msg: format!("invalid timestamp: {ms}"),
            })
    })
    .transpose()
}

/// Resolves an account ref to a live row within the scope. A ref that
/// exists under another login or datasource, or whose `external_id` or
/// messenger id disagrees with the stored row, is reported as not found,
/// so foreign ids are never confirmed to the caller.
/// Used by the child endpoints (chats, messages) from Stage 2 on.
pub(crate) async fn resolve_account_ref(
    txn: &impl ConnectionTrait,
    scope: &IngestScope,
    r: &MessengerIngestAccountRef,
) -> Result<messenger_account::Model, AppError> {
    let id = parse_echo_uuid(&r.id).c(h!())?;
    let account = find_scoped_account_by_id(txn, scope, id).await.c(h!())?;
    if account.external_id != r.external_id {
        return Err(AppError::NotFound);
    }
    if account.messenger_type != r.messenger_type {
        return Err(AppError::NotFound);
    }
    if let Some(telegram) = &r.telegram {
        let user_id = parse_i64_decimal("telegram user_id", &telegram.user_id)
            .map_err(|_| AppError::NotFound)
            .c(h!())?;
        if account.telegram_user_id != Some(user_id) {
            return Err(AppError::NotFound);
        }
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
        .filter(
            messenger_account::Column::DatasourceId.eq(scope.datasource_id()),
        )
        .filter(messenger_account::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Resolves a chat ref under an already resolved account, with the same
/// not-found semantics as `resolve_account_ref`. The Telegram chat id is
/// checked only when the caller sent one.
pub(crate) async fn resolve_chat_ref(
    txn: &impl ConnectionTrait,
    account: &messenger_account::Model,
    r: &MessengerIngestChatRef,
) -> Result<messenger_chat::Model, AppError> {
    let id = parse_echo_uuid(&r.id).c(h!())?;
    let chat = find_chat_by_id(txn, account.id, id).await.c(h!())?;
    if chat.external_id != r.external_id {
        return Err(AppError::NotFound);
    }
    if let Some(telegram) = &r.telegram {
        let chat_id = parse_i64_decimal("telegram chat_id", &telegram.chat_id)
            .map_err(|_| AppError::NotFound)
            .c(h!())?;
        if chat.telegram_chat_id != Some(chat_id) {
            return Err(AppError::NotFound);
        }
    }
    Ok(chat)
}

/// A live chat of the given account, or `NotFound`. The account was
/// resolved within the caller's scope, so the chat is too.
pub(crate) async fn find_chat_by_id(
    txn: &impl ConnectionTrait,
    account_id: Uuid,
    id: Uuid,
) -> Result<messenger_chat::Model, AppError> {
    messenger_chat::Entity::find()
        .filter(messenger_chat::Column::Id.eq(id))
        .filter(messenger_chat::Column::MessengerAccountId.eq(account_id))
        .filter(messenger_chat::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Resolves a chat member ref under an already resolved chat, with the
/// same not-found semantics as `resolve_account_ref`. Deleted members are
/// not found. The Telegram user id is checked only when the caller sent
/// one.
pub(crate) async fn resolve_chat_member_ref(
    txn: &impl ConnectionTrait,
    chat: &messenger_chat::Model,
    r: &MessengerIngestChatMemberRef,
) -> Result<messenger_chat_member::Model, AppError> {
    let id = parse_echo_uuid(&r.id).c(h!())?;
    let member = find_chat_member_by_id(txn, chat.id, id).await.c(h!())?;
    if member.external_id != r.external_id {
        return Err(AppError::NotFound);
    }
    if let Some(telegram) = &r.telegram {
        let user_id = parse_i64_decimal("telegram user_id", &telegram.user_id)
            .map_err(|_| AppError::NotFound)
            .c(h!())?;
        if member.telegram_user_id != Some(user_id) {
            return Err(AppError::NotFound);
        }
    }
    Ok(member)
}

/// A live member of the given chat, or `NotFound`. The chat was resolved
/// within the caller's scope, so the member is too.
pub(crate) async fn find_chat_member_by_id(
    txn: &impl ConnectionTrait,
    chat_id: Uuid,
    id: Uuid,
) -> Result<messenger_chat_member::Model, AppError> {
    messenger_chat_member::Entity::find()
        .filter(messenger_chat_member::Column::Id.eq(id))
        .filter(messenger_chat_member::Column::MessengerChatId.eq(chat_id))
        .filter(messenger_chat_member::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

/// Resolves a contact ref under an already resolved account, with the same
/// not-found semantics as `resolve_chat_member_ref`.
pub(crate) async fn resolve_contact_ref(
    txn: &impl ConnectionTrait,
    account: &messenger_account::Model,
    r: &MessengerIngestContactRef,
) -> Result<messenger_contact::Model, AppError> {
    let id = parse_echo_uuid(&r.id).c(h!())?;
    let contact = find_contact_by_id(txn, account.id, id).await.c(h!())?;
    if contact.external_id != r.external_id {
        return Err(AppError::NotFound);
    }
    if let Some(telegram) = &r.telegram {
        let user_id = parse_i64_decimal("telegram user_id", &telegram.user_id)
            .map_err(|_| AppError::NotFound)
            .c(h!())?;
        if contact.telegram_user_id != Some(user_id) {
            return Err(AppError::NotFound);
        }
    }
    Ok(contact)
}

/// A live contact of the given account, or `NotFound`.
pub(crate) async fn find_contact_by_id(
    txn: &impl ConnectionTrait,
    account_id: Uuid,
    id: Uuid,
) -> Result<messenger_contact::Model, AppError> {
    messenger_contact::Entity::find()
        .filter(messenger_contact::Column::Id.eq(id))
        .filter(messenger_contact::Column::MessengerAccountId.eq(account_id))
        .filter(messenger_contact::Column::Deleted.eq(false))
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
        .filter(
            messenger_account::Column::DatasourceId.eq(scope.datasource_id()),
        )
        .one(txn)
        .await
        .c(h!())?;
    Ok(maybe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MESSENGER_TYPE_MAX;

    #[test]
    fn external_url_is_blank_or_a_normalized_http_url() {
        for blank in [None, Some(""), Some("  \n")] {
            assert_eq!(normalize_external_url(blank).unwrap(), None);
        }
        for (input, stored) in [
            (
                "https://example.com/accounts/1",
                "https://example.com/accounts/1",
            ),
            ("  HTTP://Example.COM/a?b=1 ", "http://example.com/a?b=1"),
            ("https://example.com", "https://example.com/"),
        ] {
            assert_eq!(
                normalize_external_url(Some(input)).unwrap().as_deref(),
                Some(stored)
            );
        }
        let too_long = format!(
            "https://example.com/{}",
            "a".repeat(MESSENGER_INGEST_EXTERNAL_URL_MAX_LEN)
        );
        for bad in [
            "/accounts/1",
            "example.com/accounts/1",
            "javascript:alert(1)",
            "ftp://example.com",
            "https://user:pass@example.com",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    normalize_external_url(Some(bad)),
                    Err(AppError::BL { .. })
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn created_external_ids_must_be_unique() {
        assert!(ensure_unique_created_external_ids("chat", ["a", "b"]).is_ok());
        assert!(matches!(
            ensure_unique_created_external_ids("chat", ["a", "b", "a"]),
            Err(AppError::BL { .. })
        ));
    }

    #[test]
    fn provider_fields_are_optional_and_must_match_messenger() {
        assert!(ensure_provider_fields(MESSENGER_TYPE_TELEGRAM, true).is_ok());
        assert!(ensure_provider_fields(MESSENGER_TYPE_TELEGRAM, false).is_ok());
        assert!(ensure_provider_fields(MESSENGER_TYPE_MAX, false).is_ok());
        assert!(matches!(
            ensure_provider_fields(MESSENGER_TYPE_MAX, true),
            Err(AppError::BL { .. })
        ));
        assert!(matches!(
            ensure_provider_fields("Unknown", false),
            Err(AppError::BL { .. })
        ));
    }
}
