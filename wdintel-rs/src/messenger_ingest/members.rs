use crate::config::MESSENGER_INGEST_SYNC_MAX_ITEMS;
use crate::entities::{
    messenger_account, messenger_chat, messenger_chat_member,
};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, ensure_unique_created_external_ids,
    find_chat_member_by_id, parse_echo_uuid, parse_i64_decimal,
    resolve_account_ref, resolve_chat_ref, timestamp_from_millis,
};
use crate::messenger_ingest::types::{
    MessengerIngestChatMemberInput, MessengerIngestChatMemberItem,
    MessengerIngestChatMembersSyncReq, MessengerIngestChatMembersSyncRsp,
    MessengerIngestTelegramAccountId,
};
use crate::types::ShortContext;
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Delta sync of the members of one chat, with the same rules as chats
/// sync. Messages reference their sender by the returned ids, so members
/// are synced before the messages they sent.
pub(crate) async fn sync_chat_members(
    db: &DatabaseConnection,
    scope: &IngestScope,
    req: MessengerIngestChatMembersSyncReq,
) -> Result<MessengerIngestChatMembersSyncRsp, AppError> {
    let item_count = req.created.len() + req.updated.len() + req.deleted.len();
    if item_count > MESSENGER_INGEST_SYNC_MAX_ITEMS {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {item_count}, max {MESSENGER_INGEST_SYNC_MAX_ITEMS}"
            ),
        });
    }
    ensure_unique_created_external_ids(
        "chat member",
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
    let chat = resolve_chat_ref(&txn, &account, &req.chat).await.c(h!())?;
    for item in &req.created {
        let member =
            create_or_restore_chat_member(&txn, &account, &chat, item, now)
                .await
                .c(h!())?;
        created.insert(member.id.to_string(), chat_member_item(&member));
    }
    for (id, item) in &req.updated {
        let member = update_chat_member(&txn, &account, &chat, id, item, now)
            .await
            .c(h!())?;
        updated.insert(member.id.to_string(), chat_member_item(&member));
    }
    for id in &req.deleted {
        if let Some(deleted_id) =
            delete_chat_member(&txn, &chat, id, now).await.c(h!())?
        {
            deleted.push(deleted_id);
        }
    }
    txn.commit().await.c(h!())?;

    Ok(MessengerIngestChatMembersSyncRsp {
        created,
        updated,
        deleted,
    })
}

pub(crate) async fn create_or_restore_chat_member(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    chat: &messenger_chat::Model,
    item: &MessengerIngestChatMemberInput,
    now: NaiveDateTime,
) -> Result<messenger_chat_member::Model, AppError> {
    let telegram_user_id = parse_telegram_user_id(account, item).c(h!())?;

    // The unique (messenger_chat_id, external_id) constraint spans deleted
    // rows, so a create for a previously deleted external id restores it
    // with its original uuid.
    let existing = messenger_chat_member::Entity::find()
        .filter(messenger_chat_member::Column::MessengerChatId.eq(chat.id))
        .filter(messenger_chat_member::Column::ExternalId.eq(&item.external_id))
        .one(txn)
        .await
        .c(h!())?;
    match existing {
        // A create for a live external id is applied as a full update, so
        // a collector that lost the response can resend it.
        Some(member) if !member.deleted => {
            ensure_same_telegram_user_id(&member, telegram_user_id).c(h!())?;
            let mut member = member.into_active_model();
            set_chat_member_fields(&mut member, item, telegram_user_id, now)
                .c(h!())?;
            Ok(member.update(txn).await.c(h!())?)
        }
        // A restore keeps the stored Telegram user id, so the messages the
        // member sent never move to another person.
        Some(member) => {
            ensure_same_telegram_user_id(&member, telegram_user_id).c(h!())?;
            ensure_telegram_user_id_free(
                txn,
                chat.id,
                telegram_user_id,
                Some(member.id),
            )
            .await
            .c(h!())?;
            let mut member = member.into_active_model();
            set_chat_member_fields(&mut member, item, telegram_user_id, now)
                .c(h!())?;
            Ok(member.update(txn).await.c(h!())?)
        }
        None => {
            ensure_telegram_user_id_free(txn, chat.id, telegram_user_id, None)
                .await
                .c(h!())?;
            let mut member = messenger_chat_member::ActiveModel {
                id: Set(Uuid::now_v7()),
                messenger_chat_id: Set(chat.id),
                messenger_type: Set(account.messenger_type.clone()),
                external_id: Set(item.external_id.clone()),
                created_at: Set(now),
                ..Default::default()
            };
            set_chat_member_fields(&mut member, item, telegram_user_id, now)
                .c(h!())?;
            Ok(member.insert(txn).await.c(h!())?)
        }
    }
}

async fn update_chat_member(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    chat: &messenger_chat::Model,
    id: &str,
    item: &MessengerIngestChatMemberInput,
    now: NaiveDateTime,
) -> Result<messenger_chat_member::Model, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let member = find_chat_member_by_id(txn, chat.id, id).await.c(h!())?;
    let telegram_user_id = parse_telegram_user_id(account, item).c(h!())?;
    if member.external_id != item.external_id {
        return Err(AppError::BL {
            msg: format!(
                "chat member external_id {} does not match chat member {}",
                item.external_id, member.external_id
            ),
        });
    }
    ensure_same_telegram_user_id(&member, telegram_user_id).c(h!())?;
    let mut member = member.into_active_model();
    set_chat_member_fields(&mut member, item, telegram_user_id, now).c(h!())?;
    Ok(member.update(txn).await.c(h!())?)
}

/// Soft-deletes a chat member. A uuid that is already deleted or foreign
/// is a no-op, so deletion is idempotent. Messages keep their sender link.
async fn delete_chat_member(
    txn: &DatabaseTransaction,
    chat: &messenger_chat::Model,
    id: &str,
    now: NaiveDateTime,
) -> Result<Option<String>, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let member = match find_chat_member_by_id(txn, chat.id, id).await {
        Ok(member) => member,
        Err(AppError::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut member = member.into_active_model();
    member.deleted = Set(true);
    member.updated_at = Set(now);
    member.update(txn).await.c(h!())?;
    Ok(Some(id.to_string()))
}

/// A stored Telegram user id never changes, and a chat member without one
/// cannot gain one through an update.
fn ensure_same_telegram_user_id(
    member: &messenger_chat_member::Model,
    telegram_user_id: Option<i64>,
) -> Result<(), AppError> {
    if member.telegram_user_id != telegram_user_id {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id does not match chat member {}",
                member.external_id
            ),
        });
    }
    Ok(())
}

fn parse_telegram_user_id(
    account: &messenger_account::Model,
    item: &MessengerIngestChatMemberInput,
) -> Result<Option<i64>, AppError> {
    ensure_provider_fields(&account.messenger_type, item.telegram.is_some())
        .c(h!())?;
    item.telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram user_id", &telegram.user_id)
        })
        .transpose()
}

/// A Telegram user id may belong to only one live member of a chat.
async fn ensure_telegram_user_id_free(
    txn: &DatabaseTransaction,
    chat_id: Uuid,
    telegram_user_id: Option<i64>,
    except_member_id: Option<Uuid>,
) -> Result<(), AppError> {
    let Some(telegram_user_id) = telegram_user_id else {
        return Ok(());
    };
    let mut conflicting = messenger_chat_member::Entity::find()
        .filter(messenger_chat_member::Column::MessengerChatId.eq(chat_id))
        .filter(messenger_chat_member::Column::Deleted.eq(false))
        .filter(
            messenger_chat_member::Column::TelegramUserId.eq(telegram_user_id),
        );
    if let Some(except_member_id) = except_member_id {
        conflicting = conflicting
            .filter(messenger_chat_member::Column::Id.ne(except_member_id));
    }
    if conflicting.one(txn).await.c(h!())?.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id {telegram_user_id} already belongs to another chat member"
            ),
        });
    }
    Ok(())
}

/// Full-state write of the collector-owned member fields; also restores a
/// soft-deleted member.
fn set_chat_member_fields(
    member: &mut messenger_chat_member::ActiveModel,
    item: &MessengerIngestChatMemberInput,
    telegram_user_id: Option<i64>,
    now: NaiveDateTime,
) -> Result<(), AppError> {
    member.telegram_user_id = Set(telegram_user_id);
    member.username = Set(item.username.clone());
    member.first_name = Set(item.first_name.clone());
    member.last_name = Set(item.last_name.clone());
    member.phone = Set(item.phone.clone());
    member.is_bot = Set(item.is_bot);
    member.role = Set(item.role.clone());
    member.joined_date = Set(timestamp_from_millis(item.joined_date).c(h!())?);
    member.deleted = Set(false);
    member.updated_at = Set(now);
    Ok(())
}

fn chat_member_item(
    member: &messenger_chat_member::Model,
) -> MessengerIngestChatMemberItem {
    MessengerIngestChatMemberItem {
        messenger_type: member.messenger_type.clone(),
        id: member.id.to_string(),
        external_id: member.external_id.clone(),
        username: member.username.clone(),
        first_name: member.first_name.clone(),
        last_name: member.last_name.clone(),
        phone: member.phone.clone(),
        is_bot: member.is_bot,
        role: member.role.clone(),
        joined_date: member
            .joined_date
            .map(|date| date.and_utc().timestamp_millis()),
        telegram: member.telegram_user_id.map(|user_id| {
            MessengerIngestTelegramAccountId {
                user_id: user_id.to_string(),
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_TYPE_MAX,
        MESSENGER_TYPE_TELEGRAM,
    };
    use crate::entities::{datasource, login};
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::accounts::create_or_restore_account;
    use crate::messenger_ingest::chats::create_or_restore_chat;
    use crate::messenger_ingest::refs::{
        resolve_chat_member_ref, MessengerIngestChatMemberRef,
    };
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestChatInput,
    };
    use serial_test::serial;

    async fn ingest_scope(txn: &DatabaseTransaction) -> IngestScope {
        let login = mk_login(
            txn,
            login::ActiveModel {
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

    async fn account(
        txn: &DatabaseTransaction,
        scope: &IngestScope,
        messenger_type: &str,
    ) -> messenger_account::Model {
        create_or_restore_account(
            scope,
            &MessengerIngestAccountInput {
                messenger_type: messenger_type.to_string(),
                external_id: "account-1".to_string(),
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
                external_url: None,
                created_at: None,
                last_sync: None,
                telegram: None,
            },
            Utc::now().naive_utc(),
            txn,
        )
        .await
        .unwrap()
    }

    async fn chat(
        txn: &DatabaseTransaction,
        account: &messenger_account::Model,
        external_id: &str,
    ) -> messenger_chat::Model {
        create_or_restore_chat(
            txn,
            account,
            &MessengerIngestChatInput {
                external_id: external_id.to_string(),
                chat_type: Some("supergroup".to_string()),
                title: Some(format!("Chat {external_id}")),
                username: None,
                members_count: None,
                account_member_status: None,
                last_message_date: None,
                telegram: None,
            },
            Utc::now().naive_utc(),
        )
        .await
        .unwrap()
    }

    fn member_input(
        external_id: &str,
        user_id: Option<&str>,
    ) -> MessengerIngestChatMemberInput {
        MessengerIngestChatMemberInput {
            external_id: external_id.to_string(),
            username: Some(format!("user_{external_id}")),
            first_name: Some("Andrii".to_string()),
            last_name: None,
            phone: Some("+380501112233".to_string()),
            is_bot: Some(false),
            role: Some("admin".to_string()),
            joined_date: Some(1_700_000_000_000),
            telegram: user_id.map(|user_id| MessengerIngestTelegramAccountId {
                user_id: user_id.to_string(),
            }),
        }
    }

    fn member_ref(
        member: &messenger_chat_member::Model,
    ) -> MessengerIngestChatMemberRef {
        MessengerIngestChatMemberRef {
            id: member.id.to_string(),
            external_id: member.external_id.clone(),
            telegram: member.telegram_user_id.map(|user_id| {
                MessengerIngestTelegramAccountId {
                    user_id: user_id.to_string(),
                }
            }),
        }
    }

    #[tokio::test]
    #[serial]
    async fn member_sync_creates_updates_deletes_and_restores() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = account(&txn, &scope, MESSENGER_TYPE_TELEGRAM).await;
        let chat = chat(&txn, &account, "chat-1").await;
        let now = Utc::now().naive_utc();

        let member = create_or_restore_chat_member(
            &txn,
            &account,
            &chat,
            &member_input("u-1", Some("6011122233")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(member.telegram_user_id, Some(6_011_122_233));
        assert_eq!(member.messenger_chat_id, chat.id);
        assert_eq!(member.role.as_deref(), Some("admin"));
        assert_eq!(
            resolve_chat_member_ref(&txn, &chat, &member_ref(&member))
                .await
                .unwrap()
                .id,
            member.id
        );

        // Updates are full state: an omitted phone clears it.
        let mut changed = member_input("u-1", Some("6011122233"));
        changed.phone = None;
        let updated = update_chat_member(
            &txn,
            &account,
            &chat,
            &member.id.to_string(),
            &changed,
            now,
        )
        .await
        .unwrap();
        assert_eq!(updated.id, member.id);
        assert_eq!(updated.phone, None);

        let deleted =
            delete_chat_member(&txn, &chat, &member.id.to_string(), now)
                .await
                .unwrap();
        assert_eq!(deleted, Some(member.id.to_string()));
        assert_eq!(
            delete_chat_member(&txn, &chat, &member.id.to_string(), now)
                .await
                .unwrap(),
            None
        );
        assert!(matches!(
            resolve_chat_member_ref(&txn, &chat, &member_ref(&member)).await,
            Err(AppError::NotFound)
        ));

        // A restore cannot move the member to another Telegram user.
        let error = create_or_restore_chat_member(
            &txn,
            &account,
            &chat,
            &member_input("u-1", Some("6011122299")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        let restored = create_or_restore_chat_member(
            &txn,
            &account,
            &chat,
            &member_input("u-1", Some("6011122233")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(restored.id, member.id);
        assert!(!restored.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn member_sync_rejects_conflicts_and_isolates_chats() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = account(&txn, &scope, MESSENGER_TYPE_TELEGRAM).await;
        let first = chat(&txn, &account, "chat-1").await;
        let second = chat(&txn, &account, "chat-2").await;
        let now = Utc::now().naive_utc();
        let member = create_or_restore_chat_member(
            &txn,
            &account,
            &first,
            &member_input("u-1", Some("1")),
            now,
        )
        .await
        .unwrap();

        // A resent create updates the live member.
        let mut resent = member_input("u-1", Some("1"));
        resent.role = Some("member".to_string());
        let again =
            create_or_restore_chat_member(&txn, &account, &first, &resent, now)
                .await
                .unwrap();
        assert_eq!(again.id, member.id);
        assert_eq!(again.role.as_deref(), Some("member"));

        // A live external_id with another Telegram user id, or a Telegram
        // user id of another member.
        for item in [member_input("u-1", None), member_input("u-2", Some("1"))]
        {
            let error = create_or_restore_chat_member(
                &txn, &account, &first, &item, now,
            )
            .await
            .unwrap_err();
            assert!(matches!(error, AppError::BL { .. }));
        }
        let error = update_chat_member(
            &txn,
            &account,
            &first,
            &member.id.to_string(),
            &member_input("u-1", Some("2")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // The same person in another chat is another member, and a member
        // of one chat is not found under another.
        let other = create_or_restore_chat_member(
            &txn,
            &account,
            &second,
            &member_input("u-1", Some("1")),
            now,
        )
        .await
        .unwrap();
        assert_ne!(other.id, member.id);
        assert!(matches!(
            resolve_chat_member_ref(&txn, &second, &member_ref(&member)).await,
            Err(AppError::NotFound)
        ));
    }

    #[tokio::test]
    #[serial]
    async fn member_sync_rejects_telegram_fields_for_max() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account = account(&txn, &scope, MESSENGER_TYPE_MAX).await;
        let chat = chat(&txn, &account, "chat-1").await;
        let now = Utc::now().naive_utc();

        let member = create_or_restore_chat_member(
            &txn,
            &account,
            &chat,
            &member_input("u-1", None),
            now,
        )
        .await
        .unwrap();
        assert_eq!(member.messenger_type, MESSENGER_TYPE_MAX);
        let error = create_or_restore_chat_member(
            &txn,
            &account,
            &chat,
            &member_input("u-2", Some("1")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }
}
