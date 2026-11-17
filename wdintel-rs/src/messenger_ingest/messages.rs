use crate::config::{
    MESSENGER_INGEST_CONCURRENT_SUBMIT_CODE,
    MESSENGER_INGEST_MESSAGE_STATUS_CREATED,
    MESSENGER_INGEST_MESSAGE_STATUS_EXISTING,
    MESSENGER_INGEST_SUBMIT_MAX_MESSAGES,
};
use crate::entities::{
    datasource_group, messenger_account, messenger_chat, sigint_chat_message,
    signal_message,
};
use crate::error::AppError;
use crate::h;
use crate::message_queue::ProcessSignalMessageQueueItemOptions;
use crate::messenger::types::Message;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, parse_i64_decimal, resolve_account_ref,
    resolve_chat_member_ref, resolve_chat_ref, timestamp_from_millis,
};
use crate::messenger_ingest::types::{
    MessengerIngestMessageInput, MessengerIngestMessageItem,
    MessengerIngestMessagesSubmitReq, MessengerIngestMessagesSubmitRsp,
};
use crate::types::{Env, ShortContext};
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::*;
use uuid::Uuid;

/// The chat a batch of messages is submitted to, resolved once per request.
struct SubmitTarget<'a> {
    scope: &'a IngestScope,
    account: &'a messenger_account::Model,
    chat: &'a messenger_chat::Model,
    group_master_key: &'a str,
}

pub(crate) async fn submit_messages(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestMessagesSubmitReq,
) -> Result<MessengerIngestMessagesSubmitRsp, AppError> {
    if req.messages.len() > MESSENGER_INGEST_SUBMIT_MAX_MESSAGES {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {}, max {MESSENGER_INGEST_SUBMIT_MAX_MESSAGES}",
                req.messages.len()
            ),
        });
    }

    // One transaction for the whole batch, same as the sync endpoints.
    let txn = env.dbx.begin().await.c(h!())?;
    let account = resolve_account_ref(&txn, scope, &req.account)
        .await
        .c(h!())?;
    let chat = resolve_chat_ref(&txn, &account, &req.chat).await.c(h!())?;
    let group_master_key =
        account_group_master_key(&txn, &account).await.c(h!())?;
    let target = SubmitTarget {
        scope,
        account: &account,
        chat: &chat,
        group_master_key: &group_master_key,
    };
    let mut redis = env.redis.clone();
    let mut changed_inbox_item_ids = vec![];
    let mut results = Vec::with_capacity(req.messages.len());
    for item in &req.messages {
        results.push(
            submit_message(
                &txn,
                env,
                &target,
                item,
                &mut redis,
                &mut changed_inbox_item_ids,
            )
            .await
            .c(h!())?,
        );
    }
    txn.commit().await.c(h!())?;
    // The messages are stored: a failed notification must not turn the
    // response into an error, or the collector would retry and get the
    // messages back as `existing` without any fanout at all.
    if let Err(error) =
        crate::inbox::fanout_inbox_changes(&mut redis, changed_inbox_item_ids)
            .await
    {
        log::error!(
            "failed to fanout ingested messages after commit: {error:?}"
        );
    }
    Ok(MessengerIngestMessagesSubmitRsp { results })
}

/// Idempotent insert of one message: a message already stored under the
/// same chat and `external_id` is returned as `existing` and left as is.
async fn submit_message(
    txn: &DatabaseTransaction,
    env: &Env,
    target: &SubmitTarget<'_>,
    item: &MessengerIngestMessageInput,
    redis: &mut ConnectionManager,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> Result<MessengerIngestMessageItem, AppError> {
    let telegram_message_id =
        parse_telegram_message_id(target.account, item).c(h!())?;
    let existing = sigint_chat_message::Entity::find()
        .filter(sigint_chat_message::Column::MessengerChatId.eq(target.chat.id))
        .filter(
            sigint_chat_message::Column::MessengerExternalId
                .eq(&item.external_id),
        )
        .one(txn)
        .await
        .c(h!())?;
    if let Some(chat_message) = existing {
        if chat_message.telegram_message_id != telegram_message_id {
            return Err(AppError::BL {
                msg: format!(
                    "telegram message_id does not match message {}",
                    item.external_id
                ),
            });
        }
        let id = signal_message_uuid(txn, chat_message.id).await.c(h!())?;
        return Ok(message_item(
            id,
            item,
            MESSENGER_INGEST_MESSAGE_STATUS_EXISTING,
        ));
    }
    ensure_telegram_message_id_free(txn, target.chat.id, telegram_message_id)
        .await
        .c(h!())?;
    // The sender of a new message must be a live member of the chat,
    // synced beforehand. A stored message is returned as `existing`
    // without resolving its sender, so a retry still succeeds after the
    // sender left the chat.
    let sender_id = match &item.sender {
        Some(sender) => Some(
            resolve_chat_member_ref(txn, target.chat, sender)
                .await
                .c(h!())?
                .id,
        ),
        None => None,
    };

    let timestamp = timestamp_from_millis(Some(item.date)).c(h!())?.c(h!())?;
    // The message author is the API login; the messenger sender is kept
    // on the chat message only.
    let message = Message {
        body: item.text.clone().unwrap_or_default(),
        group_id: target.group_master_key.to_string(),
        sender: None,
        timestamp,
        datasource_id: target.scope.datasource_id(),
        inbox_message_id: None,
    };
    let processed =
        crate::message_queue::process_signal_message_queue_item_with_options(
            message,
            Vec::<MessageAttachmentF1>::new(),
            redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            txn,
            false,
            changed_inbox_item_ids,
            ProcessSignalMessageQueueItemOptions {
                created_at: None,
                skip_dedupe: true,
                login_id: Some(target.scope.login_id),
                external_id: None,
                echo_unit_id: None,
            },
        )
        .await
        .c(h!())?;

    // signal_message.id = sigint_inbox_item.id: ingest messages are never
    // split, so the inbox item exists under the message id.
    sigint_chat_message::ActiveModel {
        id: Set(processed.signal_message_id),
        messenger_chat_id: Set(target.chat.id),
        messenger_external_id: Set(item.external_id.clone()),
        messenger_sent_at: Set(timestamp),
        telegram_message_id: Set(telegram_message_id),
        messenger_sender_id: Set(sender_id),
        messenger_is_outgoing: Set(item.is_outgoing),
        messenger_has_media: Set(item.has_media),
    }
    .insert(txn)
    .await
    .map_err(|error| chat_message_insert_error(error, item))
    .c(h!())?;

    let id = processed.signal_message_uuid.c(h!())?;
    Ok(message_item(
        id,
        item,
        MESSENGER_INGEST_MESSAGE_STATUS_CREATED,
    ))
}

/// Stored messages are found before the pipeline runs, so a unique
/// violation here means a concurrent request stored the same message
/// (`external_id` or Telegram `message_id`) first. The whole batch is
/// rolled back and reported as a retryable `409`; resending it returns the
/// stored messages as `existing`.
fn chat_message_insert_error(
    error: DbErr,
    item: &MessengerIngestMessageInput,
) -> AppError {
    match error.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => AppError::ConflictJson {
            body: serde_json::json!({
                "message": format!(
                    "message {} was submitted concurrently; retry the request",
                    item.external_id
                ),
                "details": {
                    "code": MESSENGER_INGEST_CONCURRENT_SUBMIT_CODE,
                    "external_id": item.external_id,
                },
            }),
        },
        _ => AppError::AnyhowError {
            source: anyhow::Error::new(error),
        },
    }
}

fn parse_telegram_message_id(
    account: &messenger_account::Model,
    item: &MessengerIngestMessageInput,
) -> Result<Option<i64>, AppError> {
    ensure_provider_fields(&account.messenger_type, item.telegram.is_some())
        .c(h!())?;
    item.telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram message_id", &telegram.message_id)
        })
        .transpose()
}

/// A Telegram message id may belong to only one message of a chat.
async fn ensure_telegram_message_id_free(
    txn: &DatabaseTransaction,
    chat_id: Uuid,
    telegram_message_id: Option<i64>,
) -> Result<(), AppError> {
    let Some(telegram_message_id) = telegram_message_id else {
        return Ok(());
    };
    let conflicting = sigint_chat_message::Entity::find()
        .filter(sigint_chat_message::Column::MessengerChatId.eq(chat_id))
        .filter(
            sigint_chat_message::Column::TelegramMessageId
                .eq(telegram_message_id),
        )
        .one(txn)
        .await
        .c(h!())?;
    if conflicting.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "telegram message_id {telegram_message_id} already belongs to another message"
            ),
        });
    }
    Ok(())
}

async fn account_group_master_key(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
) -> Result<String, AppError> {
    let datasource_group =
        datasource_group::Entity::find_by_id(account.datasource_group_id)
            .one(txn)
            .await
            .c(h!())?
            .c(h!())?;
    Ok(datasource_group.group_master_key)
}

pub(crate) async fn signal_message_uuid(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
) -> Result<Uuid, AppError> {
    let id_uuid = signal_message::Entity::find_by_id(signal_message_id)
        .select_only()
        .column(signal_message::Column::IdUuid)
        .into_tuple::<Option<Uuid>>()
        .one(txn)
        .await
        .c(h!())?
        .flatten()
        .c(h!())?;
    Ok(id_uuid)
}

fn message_item(
    id: Uuid,
    item: &MessengerIngestMessageInput,
    status: &str,
) -> MessengerIngestMessageItem {
    MessengerIngestMessageItem {
        id: id.to_string(),
        external_id: item.external_id.clone(),
        status: status.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_TYPE_MAX,
        MESSENGER_TYPE_TELEGRAM, ROLE_API, ROLE_MESSENGER_INGEST,
    };
    use crate::entities::{datasource, login, sigint_inbox_item};
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::accounts::create_or_restore_account;
    use crate::messenger_ingest::chats::create_or_restore_chat;
    use crate::messenger_ingest::members::create_or_restore_chat_member;
    use crate::messenger_ingest::refs::MessengerIngestChatMemberRef;
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestChatInput,
        MessengerIngestChatMemberInput, MessengerIngestTelegramAccountId,
        MessengerIngestTelegramChatId, MessengerIngestTelegramMessageId,
    };
    use chrono::Utc;
    use serial_test::serial;

    struct Fixture {
        scope: IngestScope,
        account: messenger_account::Model,
        chat: messenger_chat::Model,
        group_master_key: String,
    }

    async fn fixture(
        txn: &DatabaseTransaction,
        messenger_type: &str,
    ) -> Fixture {
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
        let scope = IngestScope {
            login_id: login.id,
            datasource,
        };
        let is_telegram = messenger_type == MESSENGER_TYPE_TELEGRAM;
        let now = Utc::now().naive_utc();
        let account = create_or_restore_account(
            &scope,
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
                telegram: is_telegram.then(|| {
                    MessengerIngestTelegramAccountId {
                        user_id: "700001".to_string(),
                    }
                }),
            },
            now,
            txn,
        )
        .await
        .unwrap();
        let chat = create_or_restore_chat(
            txn,
            &account,
            &MessengerIngestChatInput {
                external_id: "chat-1".to_string(),
                chat_type: Some("supergroup".to_string()),
                title: Some("Chat 1".to_string()),
                username: None,
                members_count: None,
                account_member_status: None,
                last_message_date: None,
                telegram: is_telegram.then(|| MessengerIngestTelegramChatId {
                    chat_id: "-1001".to_string(),
                }),
            },
            now,
        )
        .await
        .unwrap();
        let group_master_key =
            account_group_master_key(txn, &account).await.unwrap();
        Fixture {
            scope,
            account,
            chat,
            group_master_key,
        }
    }

    fn message_input(
        external_id: &str,
        text: &str,
        message_id: Option<&str>,
    ) -> MessengerIngestMessageInput {
        MessengerIngestMessageInput {
            external_id: external_id.to_string(),
            date: 1_760_431_100_000,
            text: Some(text.to_string()),
            is_outgoing: Some(false),
            has_media: Some(false),
            sender: None,
            telegram: message_id.map(|message_id| {
                MessengerIngestTelegramMessageId {
                    message_id: message_id.to_string(),
                }
            }),
        }
    }

    async fn submit(
        txn: &DatabaseTransaction,
        env: &Env,
        fixture: &Fixture,
        item: &MessengerIngestMessageInput,
    ) -> Result<MessengerIngestMessageItem, AppError> {
        let target = SubmitTarget {
            scope: &fixture.scope,
            account: &fixture.account,
            chat: &fixture.chat,
            group_master_key: &fixture.group_master_key,
        };
        submit_message(
            txn,
            env,
            &target,
            item,
            &mut env.redis.clone(),
            &mut vec![],
        )
        .await
    }

    async fn stored_message(
        txn: &DatabaseTransaction,
        item: &MessengerIngestMessageItem,
    ) -> signal_message::Model {
        signal_message::Entity::find()
            .filter(
                signal_message::Column::IdUuid
                    .eq(Uuid::parse_str(&item.id).unwrap()),
            )
            .one(txn)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    #[serial]
    async fn submit_stores_message_once_and_links_chat_and_sender() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        let sender = create_or_restore_chat_member(
            &txn,
            &fixture.account,
            &fixture.chat,
            &MessengerIngestChatMemberInput {
                external_id: "6011122233".to_string(),
                username: Some("observer".to_string()),
                first_name: None,
                last_name: None,
                phone: None,
                is_bot: Some(false),
                role: None,
                joined_date: None,
                telegram: Some(MessengerIngestTelegramAccountId {
                    user_id: "6011122233".to_string(),
                }),
            },
            Utc::now().naive_utc(),
        )
        .await
        .unwrap();
        let mut item = message_input("m-1", "Колона рухається", Some("48211"));
        item.sender = Some(MessengerIngestChatMemberRef {
            id: sender.id.to_string(),
            external_id: sender.external_id.clone(),
            telegram: Some(MessengerIngestTelegramAccountId {
                user_id: "6011122233".to_string(),
            }),
        });

        let created = submit(&txn, &env, &fixture, &item).await.unwrap();
        assert_eq!(created.status, MESSENGER_INGEST_MESSAGE_STATUS_CREATED);
        let message = stored_message(&txn, &created).await;
        assert_eq!(message.login_id, Some(fixture.scope.login_id));
        assert_eq!(message.sender, None);
        assert!(!message.deleted);
        assert_eq!(
            message.datasource_group_id,
            Some(fixture.account.datasource_group_id)
        );
        assert!(sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        let chat_message = sigint_chat_message::Entity::find_by_id(message.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chat_message.messenger_chat_id, fixture.chat.id);
        assert_eq!(chat_message.telegram_message_id, Some(48211));
        assert_eq!(chat_message.messenger_sender_id, Some(sender.id));

        // A retry is reported as existing and stores nothing new.
        let again = submit(&txn, &env, &fixture, &item).await.unwrap();
        assert_eq!(again.status, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING);
        assert_eq!(again.id, created.id);
    }

    #[tokio::test]
    #[serial]
    async fn submit_never_deduplicates_identical_messages() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;

        let first = submit(
            &txn,
            &env,
            &fixture,
            &message_input("m-1", "Однаковий текст", Some("1")),
        )
        .await
        .unwrap();
        let second = submit(
            &txn,
            &env,
            &fixture,
            &message_input("m-2", "Однаковий текст", Some("2")),
        )
        .await
        .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(second.status, MESSENGER_INGEST_MESSAGE_STATUS_CREATED);
        assert!(!stored_message(&txn, &first).await.deleted);
        assert!(!stored_message(&txn, &second).await.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn submit_keeps_long_messages_whole() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        let body =
            std::fs::read_to_string("data/test_multi_message.txt").unwrap();
        assert!(crate::rer_importer::multimessage::should_try_split_message(
            &body
        ));

        let created =
            submit(&txn, &env, &fixture, &message_input("m-long", &body, None))
                .await
                .unwrap();

        let message = stored_message(&txn, &created).await;
        assert!(!message.deleted);
        assert!(sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        let group_messages = signal_message::Entity::find()
            .filter(
                signal_message::Column::DatasourceGroupId
                    .eq(fixture.account.datasource_group_id),
            )
            .count(&txn)
            .await
            .unwrap();
        assert_eq!(group_messages, 1);
    }

    #[tokio::test]
    #[serial]
    async fn submit_dates_inbox_item_by_send_time_not_body() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        let item = message_input("m-1", "21.05.2024 14:30 колона", None);

        let created = submit(&txn, &env, &fixture, &item).await.unwrap();

        let message = stored_message(&txn, &created).await;
        let inbox_item = sigint_inbox_item::Entity::find_by_id(message.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inbox_item.datetime, message.timestamp);
    }

    #[tokio::test]
    #[serial]
    async fn submit_rejects_conflicting_telegram_message_ids() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        submit(&txn, &env, &fixture, &message_input("m-1", "a", Some("1")))
            .await
            .unwrap();

        // another external_id with an already used telegram message_id
        let error =
            submit(&txn, &env, &fixture, &message_input("m-2", "b", Some("1")))
                .await
                .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // a retry with a different telegram message_id
        let error =
            submit(&txn, &env, &fixture, &message_input("m-1", "a", Some("2")))
                .await
                .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn submit_supports_non_telegram_accounts() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_MAX).await;

        let created =
            submit(&txn, &env, &fixture, &message_input("m-1", "a", None))
                .await
                .unwrap();
        assert_eq!(created.status, MESSENGER_INGEST_MESSAGE_STATUS_CREATED);

        let error =
            submit(&txn, &env, &fixture, &message_input("m-2", "b", Some("2")))
                .await
                .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn submit_rejects_unknown_senders() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        let mut item = message_input("m-1", "a", Some("1"));
        item.sender = Some(MessengerIngestChatMemberRef {
            id: Uuid::now_v7().to_string(),
            external_id: "6011122233".to_string(),
            telegram: None,
        });

        let error = submit(&txn, &env, &fixture, &item).await.unwrap_err();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn resubmit_succeeds_after_sender_was_deleted() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        let sender = create_or_restore_chat_member(
            &txn,
            &fixture.account,
            &fixture.chat,
            &MessengerIngestChatMemberInput {
                external_id: "6011122233".to_string(),
                username: None,
                first_name: None,
                last_name: None,
                phone: None,
                is_bot: None,
                role: None,
                joined_date: None,
                telegram: None,
            },
            Utc::now().naive_utc(),
        )
        .await
        .unwrap();
        let mut item = message_input("m-1", "a", Some("1"));
        item.sender = Some(MessengerIngestChatMemberRef {
            id: sender.id.to_string(),
            external_id: sender.external_id.clone(),
            telegram: None,
        });
        let created = submit(&txn, &env, &fixture, &item).await.unwrap();

        let mut deleted = sender.into_active_model();
        deleted.deleted = Set(true);
        deleted.update(&txn).await.unwrap();

        // The stored message is still returned on retry...
        let again = submit(&txn, &env, &fixture, &item).await.unwrap();
        assert_eq!(again.status, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING);
        assert_eq!(again.id, created.id);
        // ...but the deleted member cannot send a new message.
        item.external_id = "m-2".to_string();
        item.telegram = Some(MessengerIngestTelegramMessageId {
            message_id: "2".to_string(),
        });
        let error = submit(&txn, &env, &fixture, &item).await.unwrap_err();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_insert_of_a_stored_message_is_a_conflict() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let fixture = fixture(&txn, MESSENGER_TYPE_TELEGRAM).await;
        submit(&txn, &env, &fixture, &message_input("m-1", "a", Some("1")))
            .await
            .unwrap();
        let second =
            submit(&txn, &env, &fixture, &message_input("m-2", "b", Some("2")))
                .await
                .unwrap();
        let second = stored_message(&txn, &second).await;

        // The unique violation a concurrent request would hit, produced in
        // a savepoint by moving the second message onto the first's key.
        let savepoint = txn.begin().await.unwrap();
        let error = sigint_chat_message::ActiveModel {
            id: Set(second.id),
            messenger_external_id: Set("m-1".to_string()),
            ..Default::default()
        }
        .update(&savepoint)
        .await
        .unwrap_err();
        savepoint.rollback().await.unwrap();

        let error =
            chat_message_insert_error(error, &message_input("m-1", "a", None));
        let AppError::ConflictJson { body } = error else {
            panic!("expected a conflict, got {error:?}");
        };
        assert_eq!(
            body["details"]["code"],
            MESSENGER_INGEST_CONCURRENT_SUBMIT_CODE
        );
        assert_eq!(body["details"]["external_id"], "m-1");
    }
}
