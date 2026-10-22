use crate::config::MESSENGER_INGEST_SYNC_MAX_ITEMS;
use crate::entities::{messenger_account, messenger_chat};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, ensure_unique_created_external_ids,
    find_chat_by_id, parse_echo_uuid, parse_i64_decimal, resolve_account_ref,
    timestamp_from_millis,
};
use crate::messenger_ingest::types::{
    MessengerIngestChatInput, MessengerIngestChatItem,
    MessengerIngestChatsSyncReq, MessengerIngestChatsSyncRsp,
    MessengerIngestTelegramChatId,
};
use crate::types::ShortContext;
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) async fn sync_chats(
    db: &DatabaseConnection,
    scope: &IngestScope,
    req: MessengerIngestChatsSyncReq,
) -> Result<MessengerIngestChatsSyncRsp, AppError> {
    let item_count = req.created.len() + req.updated.len() + req.deleted.len();
    if item_count > MESSENGER_INGEST_SYNC_MAX_ITEMS {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {item_count}, max {MESSENGER_INGEST_SYNC_MAX_ITEMS}"
            ),
        });
    }
    ensure_unique_created_external_ids(
        "chat",
        req.created.iter().map(|item| item.external_id.as_str()),
    )
    .c(h!())?;

    let now = Utc::now().naive_utc();
    let mut created = BTreeMap::new();
    let mut updated = BTreeMap::new();
    let mut deleted = vec![];

    // One transaction for the whole batch, same as accounts sync.
    let txn = db.begin().await.c(h!())?;
    let account = resolve_account_ref(&txn, scope, &req.account)
        .await
        .c(h!())?;
    for item in &req.created {
        let chat = create_or_restore_chat(&txn, &account, item, now)
            .await
            .c(h!())?;
        created.insert(chat.id.to_string(), chat_item(&chat));
    }
    for (id, item) in &req.updated {
        let chat = update_chat(&txn, &account, id, item, now).await.c(h!())?;
        updated.insert(chat.id.to_string(), chat_item(&chat));
    }
    for id in &req.deleted {
        if let Some(deleted_id) =
            delete_chat(&txn, &account, id, now).await.c(h!())?
        {
            deleted.push(deleted_id);
        }
    }
    txn.commit().await.c(h!())?;

    Ok(MessengerIngestChatsSyncRsp {
        created,
        updated,
        deleted,
    })
}

pub(crate) async fn create_or_restore_chat(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    item: &MessengerIngestChatInput,
    now: NaiveDateTime,
) -> Result<messenger_chat::Model, AppError> {
    let telegram_chat_id = parse_telegram_chat_id(account, item).c(h!())?;

    // The unique (messenger_account_id, external_id) constraint spans
    // deleted rows, so a create for a previously deleted external id
    // restores it with its original uuid.
    let existing = messenger_chat::Entity::find()
        .filter(messenger_chat::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_chat::Column::ExternalId.eq(&item.external_id))
        .one(txn)
        .await
        .c(h!())?;
    match existing {
        // A create for a live external id is applied as a full update, so
        // a collector that lost the response can resend it.
        Some(chat) if !chat.deleted => {
            ensure_same_telegram_chat_id(&chat, telegram_chat_id).c(h!())?;
            let mut chat = chat.into_active_model();
            set_chat_fields(&mut chat, item, telegram_chat_id, now).c(h!())?;
            Ok(chat.update(txn).await.c(h!())?)
        }
        // A restore keeps the stored Telegram chat id, so the chat's
        // history never moves to another chat.
        Some(chat) => {
            ensure_same_telegram_chat_id(&chat, telegram_chat_id).c(h!())?;
            ensure_telegram_chat_id_free(
                txn,
                account.id,
                telegram_chat_id,
                Some(chat.id),
            )
            .await
            .c(h!())?;
            let mut chat = chat.into_active_model();
            set_chat_fields(&mut chat, item, telegram_chat_id, now).c(h!())?;
            Ok(chat.update(txn).await.c(h!())?)
        }
        None => {
            ensure_telegram_chat_id_free(
                txn,
                account.id,
                telegram_chat_id,
                None,
            )
            .await
            .c(h!())?;
            let mut chat = messenger_chat::ActiveModel {
                id: Set(Uuid::now_v7()),
                messenger_account_id: Set(account.id),
                messenger_type: Set(account.messenger_type.clone()),
                external_id: Set(item.external_id.clone()),
                created_at: Set(now),
                ..Default::default()
            };
            set_chat_fields(&mut chat, item, telegram_chat_id, now).c(h!())?;
            Ok(chat.insert(txn).await.c(h!())?)
        }
    }
}

async fn update_chat(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    id: &str,
    item: &MessengerIngestChatInput,
    now: NaiveDateTime,
) -> Result<messenger_chat::Model, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let chat = find_chat_by_id(txn, account.id, id).await.c(h!())?;
    let telegram_chat_id = parse_telegram_chat_id(account, item).c(h!())?;
    if chat.external_id != item.external_id {
        return Err(AppError::BL {
            msg: format!(
                "chat external_id {} does not match chat {}",
                item.external_id, chat.external_id
            ),
        });
    }
    ensure_same_telegram_chat_id(&chat, telegram_chat_id).c(h!())?;
    let mut chat = chat.into_active_model();
    set_chat_fields(&mut chat, item, telegram_chat_id, now).c(h!())?;
    Ok(chat.update(txn).await.c(h!())?)
}

/// Soft-deletes a chat. A uuid that is already deleted or foreign is a
/// no-op, so deletion is idempotent. Messages of the chat are kept.
async fn delete_chat(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    id: &str,
    now: NaiveDateTime,
) -> Result<Option<String>, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let chat = match find_chat_by_id(txn, account.id, id).await {
        Ok(chat) => chat,
        Err(AppError::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut chat = chat.into_active_model();
    chat.deleted = Set(true);
    chat.updated_at = Set(now);
    chat.update(txn).await.c(h!())?;
    Ok(Some(id.to_string()))
}

/// A stored Telegram chat id never changes, and a chat without one cannot
/// gain one through an update.
fn ensure_same_telegram_chat_id(
    chat: &messenger_chat::Model,
    telegram_chat_id: Option<i64>,
) -> Result<(), AppError> {
    if chat.telegram_chat_id != telegram_chat_id {
        return Err(AppError::BL {
            msg: format!(
                "telegram chat_id does not match chat {}",
                chat.external_id
            ),
        });
    }
    Ok(())
}

fn parse_telegram_chat_id(
    account: &messenger_account::Model,
    item: &MessengerIngestChatInput,
) -> Result<Option<i64>, AppError> {
    ensure_provider_fields(&account.messenger_type, item.telegram.is_some())
        .c(h!())?;
    item.telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram chat_id", &telegram.chat_id)
        })
        .transpose()
}

/// A Telegram chat id may belong to only one live chat of an account.
async fn ensure_telegram_chat_id_free(
    txn: &DatabaseTransaction,
    account_id: Uuid,
    telegram_chat_id: Option<i64>,
    except_chat_id: Option<Uuid>,
) -> Result<(), AppError> {
    let Some(telegram_chat_id) = telegram_chat_id else {
        return Ok(());
    };
    let mut conflicting = messenger_chat::Entity::find()
        .filter(messenger_chat::Column::MessengerAccountId.eq(account_id))
        .filter(messenger_chat::Column::Deleted.eq(false))
        .filter(messenger_chat::Column::TelegramChatId.eq(telegram_chat_id));
    if let Some(except_chat_id) = except_chat_id {
        conflicting =
            conflicting.filter(messenger_chat::Column::Id.ne(except_chat_id));
    }
    if conflicting.one(txn).await.c(h!())?.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "telegram chat_id {telegram_chat_id} already belongs to another chat"
            ),
        });
    }
    Ok(())
}

/// Full-state write of the collector-owned chat fields; also restores a
/// soft-deleted chat.
fn set_chat_fields(
    chat: &mut messenger_chat::ActiveModel,
    item: &MessengerIngestChatInput,
    telegram_chat_id: Option<i64>,
    now: NaiveDateTime,
) -> Result<(), AppError> {
    chat.telegram_chat_id = Set(telegram_chat_id);
    chat.chat_type = Set(item.chat_type.clone());
    chat.title = Set(item.title.clone());
    chat.username = Set(item.username.clone());
    chat.members_count = Set(item.members_count);
    chat.account_member_status = Set(item.account_member_status.clone());
    chat.last_message_date =
        Set(timestamp_from_millis(item.last_message_date).c(h!())?);
    chat.deleted = Set(false);
    chat.updated_at = Set(now);
    Ok(())
}

fn chat_item(chat: &messenger_chat::Model) -> MessengerIngestChatItem {
    MessengerIngestChatItem {
        id: chat.id.to_string(),
        messenger_type: chat.messenger_type.clone(),
        external_id: chat.external_id.clone(),
        chat_type: chat.chat_type.clone(),
        title: chat.title.clone(),
        username: chat.username.clone(),
        members_count: chat.members_count,
        account_member_status: chat.account_member_status.clone(),
        last_message_date: chat
            .last_message_date
            .map(|date| date.and_utc().timestamp_millis()),
        telegram: chat.telegram_chat_id.map(|chat_id| {
            MessengerIngestTelegramChatId {
                chat_id: chat_id.to_string(),
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_TYPE_MAX,
        MESSENGER_TYPE_TELEGRAM, ROLE_API, ROLE_MESSENGER_INGEST,
    };
    use crate::entities::{datasource, login};
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::accounts::create_or_restore_account;
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestTelegramAccountId,
    };
    use serial_test::serial;

    async fn ingest_scope(txn: &DatabaseTransaction) -> IngestScope {
        let login = mk_login(
            txn,
            login::ActiveModel {
                roles: Set(serde_json::json!([
                    ROLE_API,
                    ROLE_MESSENGER_INGEST
                ])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource = mk_datasource(
            txn,
            datasource::ActiveModel {
                kind: Set(MESSENGER_INGEST_DATASOURCE_KIND.to_string()),
                api_login_id: Set(Some(login.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        IngestScope {
            login_id: login.id,
            datasource,
        }
    }

    fn chat_input(
        external_id: &str,
        chat_id: Option<&str>,
    ) -> MessengerIngestChatInput {
        MessengerIngestChatInput {
            external_id: external_id.to_string(),
            chat_type: Some("supergroup".to_string()),
            title: Some(format!("Chat {external_id}")),
            username: None,
            members_count: Some(10),
            account_member_status: Some("member".to_string()),
            last_message_date: Some(1_735_689_600_123),
            telegram: chat_id.map(|chat_id| MessengerIngestTelegramChatId {
                chat_id: chat_id.to_string(),
            }),
        }
    }

    async fn account(
        txn: &DatabaseTransaction,
        scope: &IngestScope,
        messenger_type: &str,
        user_id: Option<&str>,
    ) -> messenger_account::Model {
        create_or_restore_account(
            scope,
            &MessengerIngestAccountInput {
                messenger_type: messenger_type.to_string(),
                external_id: format!("account-{messenger_type}"),
                display_name: "Account 1".to_string(),
                phone: None,
                username: None,
                first_name: None,
                last_name: None,
                status: None,
                status_error: None,
                status_changed_at: None,
                is_active: Some(true),
                is_paused: None,
                notes: None,
                created_at: None,
                last_sync: None,
                telegram: user_id.map(|user_id| {
                    MessengerIngestTelegramAccountId {
                        user_id: user_id.to_string(),
                    }
                }),
            },
            Utc::now().naive_utc(),
            txn,
        )
        .await
        .unwrap()
    }

    async fn telegram_account(
        txn: &DatabaseTransaction,
        scope: &IngestScope,
    ) -> messenger_account::Model {
        account(txn, scope, MESSENGER_TYPE_TELEGRAM, Some("700001")).await
    }

    #[tokio::test]
    #[serial]
    async fn chat_sync_creates_updates_deletes_and_restores() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = telegram_account(&txn, &scope).await;
        let now = Utc::now().naive_utc();

        let chat = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", Some("-1001")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(chat.telegram_chat_id, Some(-1001));
        assert_eq!(chat.messenger_type, MESSENGER_TYPE_TELEGRAM);

        let mut changed = chat_input("chat-1", Some("-1001"));
        changed.title = Some("Renamed".to_string());
        let updated =
            update_chat(&txn, &account, &chat.id.to_string(), &changed, now)
                .await
                .unwrap();
        assert_eq!(updated.id, chat.id);
        assert_eq!(updated.title.as_deref(), Some("Renamed"));

        let deleted = delete_chat(&txn, &account, &chat.id.to_string(), now)
            .await
            .unwrap();
        assert_eq!(deleted, Some(chat.id.to_string()));
        let deleted_again =
            delete_chat(&txn, &account, &chat.id.to_string(), now)
                .await
                .unwrap();
        assert_eq!(deleted_again, None);

        // A restore cannot move the chat to another Telegram chat.
        let error = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", Some("-1099")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        let restored = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", Some("-1001")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(restored.id, chat.id);
        assert!(!restored.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn chat_sync_rejects_conflicts() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = telegram_account(&txn, &scope).await;
        let now = Utc::now().naive_utc();
        let chat = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", Some("-1001")),
            now,
        )
        .await
        .unwrap();

        // live external_id → applied as an update of the same chat
        let mut resent = chat_input("chat-1", Some("-1001"));
        resent.title = Some("Renamed".to_string());
        let again = create_or_restore_chat(&txn, &account, &resent, now)
            .await
            .unwrap();
        assert_eq!(again.id, chat.id);
        assert_eq!(again.title.as_deref(), Some("Renamed"));

        // live external_id with another telegram chat_id
        let error = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", Some("-1002")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // same telegram chat_id under another external_id
        let error = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-2", Some("-1001")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // telegram chat_id cannot change
        let error = update_chat(
            &txn,
            &account,
            &chat.id.to_string(),
            &chat_input("chat-1", Some("-1002")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // external_id cannot change
        let error = update_chat(
            &txn,
            &account,
            &chat.id.to_string(),
            &chat_input("chat-9", Some("-1001")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // unknown uuid
        let error = update_chat(
            &txn,
            &account,
            &Uuid::now_v7().to_string(),
            &chat_input("chat-1", Some("-1001")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn chat_sync_supports_non_telegram_accounts() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = account(&txn, &scope, MESSENGER_TYPE_MAX, None).await;
        let now = Utc::now().naive_utc();

        let chat = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-1", None),
            now,
        )
        .await
        .unwrap();
        assert_eq!(chat.messenger_type, MESSENGER_TYPE_MAX);
        assert_eq!(chat.telegram_chat_id, None);

        let error = create_or_restore_chat(
            &txn,
            &account,
            &chat_input("chat-2", Some("-1001")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[test]
    fn timestamps_round_trip_as_epoch_milliseconds() {
        let timestamp = timestamp_from_millis(Some(1_735_689_600_123))
            .unwrap()
            .unwrap();
        assert_eq!(timestamp.and_utc().timestamp_millis(), 1_735_689_600_123);
        assert_eq!(timestamp_from_millis(None).unwrap(), None);
    }

    #[test]
    fn invalid_timestamp_is_rejected() {
        assert!(matches!(
            timestamp_from_millis(Some(i64::MAX)),
            Err(AppError::BL { .. })
        ));
    }

    #[test]
    fn chat_item_contains_decimal_telegram_id() {
        let id = Uuid::now_v7();
        let chat = messenger_chat::Model {
            id,
            messenger_account_id: Uuid::now_v7(),
            messenger_type: MESSENGER_TYPE_TELEGRAM.to_string(),
            external_id: "chat-1".to_string(),
            telegram_chat_id: Some(-1001),
            chat_type: Some("supergroup".to_string()),
            title: Some("Chat".to_string()),
            username: None,
            members_count: Some(3),
            account_member_status: None,
            last_message_date: None,
            deleted: false,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            avatar_id: None,
        };
        let item = chat_item(&chat);
        assert_eq!(item.id, id.to_string());
        assert_eq!(
            item.telegram,
            Some(MessengerIngestTelegramChatId {
                chat_id: "-1001".to_string(),
            })
        );
    }
}
