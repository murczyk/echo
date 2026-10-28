use crate::config::{
    MESSENGER_INGEST_CONCURRENT_ATTACH_CODE,
    MESSENGER_INGEST_MESSAGE_STATUS_CREATED,
    MESSENGER_INGEST_MESSAGE_STATUS_EXISTING,
    MESSENGER_INGEST_SUBMIT_MAX_ATTACHMENTS,
};
use crate::entities::{
    messenger_account, messenger_media_meta, sigint_chat_message,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{
    MediaUploadInput, StagedMediaAttachments, UploadedAttachmentDeletion,
};
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::messages::signal_message_uuid;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, parse_i64_decimal, resolve_account_ref,
    resolve_chat_ref, timestamp_from_millis,
};
use crate::messenger_ingest::types::{
    MessengerIngestAttachmentInput, MessengerIngestAttachmentItem,
    MessengerIngestAttachmentsSubmitReq, MessengerIngestAttachmentsSubmitRsp,
};
use crate::messenger_ingest::uploads::{
    ensure_uploads_enabled, upload_handler,
};
use crate::types::{Env, ShortContext};
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// Messenger metadata of one attachment, stored in `messenger_media_meta`
/// next to the media itself.
#[derive(Debug, PartialEq)]
struct MediaMeta {
    telegram_file_id: Option<i64>,
    telegram_media_type: Option<String>,
    external_created_at: Option<NaiveDateTime>,
}

/// Idempotent attach of completed uploads to an already submitted message.
/// An attachment already stored under the same message and `external_id`
/// is returned as `existing` and its upload is not read again, so a retry
/// after the uploads were consumed still succeeds.
///
/// Uploads are copied to S3 outside any transaction: a short read finds
/// the new attachments, staging copies them, and a short write locks the
/// message and stores the media. Staged copies are removed when the write
/// fails; uploads are consumed only after it commits.
pub(crate) async fn submit_attachments(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestAttachmentsSubmitReq,
) -> Result<MessengerIngestAttachmentsSubmitRsp, AppError> {
    if req.attachments.len() > MESSENGER_INGEST_SUBMIT_MAX_ATTACHMENTS {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {}, max {MESSENGER_INGEST_SUBMIT_MAX_ATTACHMENTS}",
                req.attachments.len()
            ),
        });
    }
    ensure_unique_external_ids(&req.attachments).c(h!())?;
    ensure_uploads_enabled(env).c(h!())?;

    // 1. Read: resolve the refs and find the attachments not stored yet.
    let txn = env.dbx.begin().await.c(h!())?;
    let account = resolve_account_ref(&txn, scope, &req.account)
        .await
        .c(h!())?;
    let chat = resolve_chat_ref(&txn, &account, &req.chat).await.c(h!())?;
    let meta = req
        .attachments
        .iter()
        .map(|item| {
            Ok((
                item.external_id.as_str(),
                media_meta(&account, item).c(h!())?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, AppError>>()
        .c(h!())?;
    let chat_message =
        find_chat_message(&txn, chat.id, &req.message_external_id, false)
            .await
            .c(h!())?;
    let existing = existing_media_ids(&txn, chat_message.id, &meta)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    let new_items = req
        .attachments
        .iter()
        .filter(|item| !existing.contains_key(&item.external_id))
        .collect::<Vec<_>>();
    if new_items.is_empty() {
        return Ok(results(&req.attachments, &existing, &BTreeMap::new()));
    }

    // 2. Stage: validate the uploads and copy them to S3, no transaction.
    let uploads = resolve_uploads(env, scope, &new_items).await.c(h!())?;
    let staged = crate::messenger::media::stage_media_attachments(
        &env.dbx,
        &uploads,
        &env.config,
        &env.s3,
        UploadedAttachmentDeletion::DeleteAfterCommit,
        None,
    )
    .await
    .c(h!())?;

    // 3. Write: lock the message, re-check, store the media and metadata.
    let persisted = persist_staged(
        env,
        chat.id,
        &req.message_external_id,
        &new_items,
        &meta,
        &staged,
    )
    .await;
    let (signal_message_id, created) = match persisted {
        Ok(persisted) => persisted,
        Err(error) => {
            // Uploads are kept, so the collector can retry the batch.
            staged.cleanup_after_rollback(&env.config, &env.s3).await;
            return Err(error);
        }
    };

    // 4. Finalize: consume the uploads and pin the media cache.
    staged
        .finalize_after_commit(&env.config, &env.s3, &env.dbx)
        .await;
    // The attachments are stored; a failed notification is logged instead
    // of failing the request, same as for messages.
    let mut redis = env.redis.clone();
    if let Err(error) =
        crate::inbox::fanout_inbox_changes(&mut redis, vec![signal_message_id])
            .await
    {
        log::error!(
            "failed to fanout ingested attachments after commit: {error:?}"
        );
    }
    Ok(results(&req.attachments, &existing, &created))
}

/// The chat message of the given chat and `external_id`, or `NotFound`.
/// With `lock`, the row is locked for the rest of the transaction, which
/// serializes the writes of concurrent attaches to one message.
async fn find_chat_message(
    txn: &DatabaseTransaction,
    chat_id: Uuid,
    message_external_id: &str,
    lock: bool,
) -> Result<sigint_chat_message::Model, AppError> {
    let mut query = sigint_chat_message::Entity::find()
        .filter(sigint_chat_message::Column::MessengerChatId.eq(chat_id))
        .filter(
            sigint_chat_message::Column::MessengerExternalId
                .eq(message_external_id),
        );
    if lock {
        query = query.lock_exclusive();
    }
    query
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
        .map_err(AppError::from)
}

fn ensure_unique_external_ids(
    attachments: &[MessengerIngestAttachmentInput],
) -> Result<(), AppError> {
    let mut seen = BTreeSet::new();
    for item in attachments {
        if !seen.insert(item.external_id.as_str()) {
            return Err(AppError::BL {
                msg: format!("duplicate attachment: {}", item.external_id),
            });
        }
    }
    Ok(())
}

fn media_meta(
    account: &messenger_account::Model,
    item: &MessengerIngestAttachmentInput,
) -> Result<MediaMeta, AppError> {
    ensure_provider_fields(&account.messenger_type, item.telegram.is_some())
        .c(h!())?;
    let telegram_file_id = item
        .telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram file_id", &telegram.file_id)
        })
        .transpose()
        .c(h!())?;
    Ok(MediaMeta {
        telegram_file_id,
        telegram_media_type: item
            .telegram
            .as_ref()
            .and_then(|telegram| telegram.media_type.clone()),
        external_created_at: timestamp_from_millis(item.created_at).c(h!())?,
    })
}

/// Media already attached under the requested `external_id`s. A retry
/// must repeat the stored Telegram fields, same as message retries;
/// `created_at` is not compared.
async fn existing_media_ids(
    txn: &DatabaseTransaction,
    chat_message_id: i64,
    meta: &BTreeMap<&str, MediaMeta>,
) -> Result<BTreeMap<String, Uuid>, AppError> {
    let rows =
        messenger_media_meta::Entity::find()
            .filter(
                messenger_media_meta::Column::SigintChatMessageId
                    .eq(chat_message_id),
            )
            .filter(messenger_media_meta::Column::ExternalId.is_in(
                meta.keys().map(|external_id| String::from(*external_id)),
            ))
            .all(txn)
            .await
            .c(h!())?;
    for row in &rows {
        let Some(requested) = meta.get(row.external_id.as_str()) else {
            continue;
        };
        if row.telegram_file_id != requested.telegram_file_id
            || row.telegram_media_type != requested.telegram_media_type
        {
            return Err(AppError::BL {
                msg: format!(
                    "telegram fields do not match attachment {}",
                    row.external_id
                ),
            });
        }
    }
    Ok(rows
        .into_iter()
        .map(|row| (row.external_id, row.id))
        .collect())
}

/// Completed ingest uploads of the login; the JSON file name and MIME type
/// override the TUS metadata when sent.
async fn resolve_uploads(
    env: &Env,
    scope: &IngestScope,
    items: &[&MessengerIngestAttachmentInput],
) -> Result<Vec<MediaUploadInput>, AppError> {
    let urls = items
        .iter()
        .map(|item| item.upload_url.clone())
        .collect::<Vec<_>>();
    let uploads = upload_handler(&env.config.storage_dir)
        .resolve_completed_uploads(&scope.login_id, &urls)
        .await
        .c(h!())?;
    Ok(uploads
        .into_iter()
        .zip(items)
        .map(|(upload, item)| MediaUploadInput {
            name: item.file_name.clone().or(upload.name),
            content_type: item.content_type.clone().or(upload.content_type),
            path: upload.path,
        })
        .collect())
}

/// Stores the staged media of the new attachments with their messenger
/// metadata in one short transaction and commits. A concurrent attach may
/// have stored some of them since the read; the request then fails with a
/// retryable `409` and its staged copies are discarded. Returns the
/// message id and the media id per attachment `external_id`.
async fn persist_staged(
    env: &Env,
    chat_id: Uuid,
    message_external_id: &str,
    items: &[&MessengerIngestAttachmentInput],
    meta: &BTreeMap<&str, MediaMeta>,
    staged: &StagedMediaAttachments,
) -> Result<(i64, BTreeMap<String, Uuid>), AppError> {
    // Media is staged in input order; a skipped upload would shift the
    // pairing, so the batch is rejected instead.
    if staged.skipped_missing() {
        return Err(AppError::BL {
            msg: "upload not found or incomplete".to_string(),
        });
    }
    let txn = env.dbx.begin().await.c(h!())?;
    let chat_message =
        find_chat_message(&txn, chat_id, message_external_id, true)
            .await
            .c(h!())?;
    // Ingest messages are never split: the chat message id is the
    // signal message id.
    let signal_message_id = chat_message.id;
    let stored_since = existing_media_ids(&txn, chat_message.id, meta)
        .await
        .c(h!())?;
    if let Some(item) = items
        .iter()
        .find(|item| stored_since.contains_key(&item.external_id))
    {
        return Err(AppError::ConflictJson {
            body: serde_json::json!({
                "message": format!(
                    "attachment {} was submitted concurrently; retry the request",
                    item.external_id
                ),
                "details": {
                    "code": MESSENGER_INGEST_CONCURRENT_ATTACH_CODE,
                    "external_id": item.external_id,
                },
            }),
        });
    }

    let message_uuid =
        signal_message_uuid(&txn, signal_message_id).await.c(h!())?;
    let media = crate::messenger::media::persist_staged_media(
        staged,
        signal_message_id,
        Some(message_uuid),
        &txn,
    )
    .await
    .c(h!())?;
    if media.len() != items.len() {
        return Err(AppError::BL {
            msg: "upload not found or incomplete".to_string(),
        });
    }
    let now = Utc::now().naive_utc();
    let mut created = BTreeMap::new();
    for (item, media) in items.iter().zip(&media) {
        let item_meta = meta.get(item.external_id.as_str()).c(h!())?;
        messenger_media_meta::ActiveModel {
            id: Set(media.id),
            sigint_chat_message_id: Set(chat_message.id),
            external_id: Set(item.external_id.clone()),
            telegram_file_id: Set(item_meta.telegram_file_id),
            telegram_media_type: Set(item_meta.telegram_media_type.clone()),
            external_created_at: Set(item_meta.external_created_at),
            created_at: Set(now),
        }
        .insert(&txn)
        .await
        .c(h!())?;
        created.insert(item.external_id.clone(), media.id);
    }
    crate::sigint::media_conversion::schedule_uploaded_media(
        &txn,
        signal_message_id,
        &media,
        &staged.stored_uploads(),
    )
    .await
    .c(h!())?;
    crate::transcriber::media_queue::reconcile_message(
        &txn,
        signal_message_id,
        &[],
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok((signal_message_id, created))
}

fn results(
    attachments: &[MessengerIngestAttachmentInput],
    existing: &BTreeMap<String, Uuid>,
    created: &BTreeMap<String, Uuid>,
) -> MessengerIngestAttachmentsSubmitRsp {
    let results = attachments
        .iter()
        .filter_map(|item| {
            let (id, status) = match existing.get(&item.external_id) {
                Some(id) => (id, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING),
                None => (
                    created.get(&item.external_id)?,
                    MESSENGER_INGEST_MESSAGE_STATUS_CREATED,
                ),
            };
            Some(MessengerIngestAttachmentItem {
                id: id.to_string(),
                external_id: item.external_id.clone(),
                status: status.to_string(),
            })
        })
        .collect();
    MessengerIngestAttachmentsSubmitRsp { results }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_TYPE_MAX,
        MESSENGER_TYPE_TELEGRAM,
    };
    use crate::entities::{datasource, login, signal_message_media};
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::refs::{
        MessengerIngestAccountRef, MessengerIngestChatRef,
    };
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestAccountsSyncReq,
        MessengerIngestChatInput, MessengerIngestChatsSyncReq,
        MessengerIngestMessageInput, MessengerIngestMessagesSubmitReq,
        MessengerIngestTelegramAccountId, MessengerIngestTelegramChatId,
        MessengerIngestTelegramMedia, MessengerIngestTelegramMessageId,
    };
    use crate::sigint::file_upload::tus::{
        CompletedUploadWriteResult, TusHandler, TusUploadMetadata,
    };
    use opendal::{services::Memory, Operator};
    use serial_test::serial;

    struct Fixture {
        env: Env,
        scope: IngestScope,
        account: MessengerIngestAccountRef,
        chat: MessengerIngestChatRef,
        chat_message_id: i64,
        _storage: tempfile::TempDir,
    }

    async fn fixture(messenger_type: &str) -> Fixture {
        let is_telegram = messenger_type == MESSENGER_TYPE_TELEGRAM;
        let storage = tempfile::tempdir().unwrap();
        let mut env = (*cleanup().await.unwrap()).clone();
        env.config.storage_dir = storage.path().display().to_string();
        env.config.s3_config = Some(crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        });
        env.s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource = mk_datasource(
            &env.dbx,
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

        let accounts = crate::messenger_ingest::accounts::sync_accounts(
            &env.dbx,
            &scope,
            MessengerIngestAccountsSyncReq {
                created: vec![MessengerIngestAccountInput {
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
                    created_at: None,
                    last_sync: None,
                    telegram: is_telegram.then(|| {
                        MessengerIngestTelegramAccountId {
                            user_id: "700001".to_string(),
                        }
                    }),
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let account = accounts.created.into_values().next().unwrap();
        let account = MessengerIngestAccountRef {
            id: account.id,
            external_id: account.external_id,
            messenger_type: account.messenger_type,
            telegram: account.telegram,
        };
        let chats = crate::messenger_ingest::chats::sync_chats(
            &env.dbx,
            &scope,
            MessengerIngestChatsSyncReq {
                account: account.clone(),
                created: vec![MessengerIngestChatInput {
                    external_id: "chat-1".to_string(),
                    chat_type: None,
                    title: Some("Chat 1".to_string()),
                    username: None,
                    members_count: None,
                    account_member_status: None,
                    last_message_date: None,
                    telegram: is_telegram.then(|| {
                        MessengerIngestTelegramChatId {
                            chat_id: "-1001".to_string(),
                        }
                    }),
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let chat = chats.created.into_values().next().unwrap();
        let chat = MessengerIngestChatRef {
            id: chat.id,
            external_id: chat.external_id,
            telegram: chat.telegram,
        };
        crate::messenger_ingest::messages::submit_messages(
            &env,
            &scope,
            MessengerIngestMessagesSubmitReq {
                account: account.clone(),
                chat: chat.clone(),
                messages: vec![MessengerIngestMessageInput {
                    external_id: "m-1".to_string(),
                    date: 1_760_431_100_000,
                    text: Some("Фото позиції".to_string()),
                    is_outgoing: Some(false),
                    has_media: Some(true),
                    sender: None,
                    telegram: is_telegram.then(|| {
                        MessengerIngestTelegramMessageId {
                            message_id: "48211".to_string(),
                        }
                    }),
                }],
            },
        )
        .await
        .unwrap();
        let chat_message_id = sigint_chat_message::Entity::find()
            .filter(
                sigint_chat_message::Column::MessengerChatId
                    .eq(Uuid::parse_str(&chat.id).unwrap()),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .id;
        Fixture {
            env,
            scope,
            account,
            chat,
            chat_message_id,
            _storage: storage,
        }
    }

    async fn upload(handler: &TusHandler, login: &Uuid) -> String {
        let result = handler
            .create_completed_upload(
                login,
                TusUploadMetadata {
                    filename: Some("upload.jpg".to_string()),
                    filetype: Some("image/jpeg".to_string()),
                    ..Default::default()
                },
                futures_util::stream::iter([Ok(
                    actix_web::web::Bytes::from_static(b"jpeg bytes"),
                )]),
            )
            .await
            .unwrap();
        let CompletedUploadWriteResult::Stored { upload_url, .. } = result
        else {
            panic!("missing upload");
        };
        upload_url
    }

    fn request(
        fixture: &Fixture,
        message_external_id: &str,
        attachments: Vec<MessengerIngestAttachmentInput>,
    ) -> MessengerIngestAttachmentsSubmitReq {
        MessengerIngestAttachmentsSubmitReq {
            account: fixture.account.clone(),
            chat: fixture.chat.clone(),
            message_external_id: message_external_id.to_string(),
            attachments,
        }
    }

    fn attachment(
        external_id: &str,
        upload_url: &str,
    ) -> MessengerIngestAttachmentInput {
        MessengerIngestAttachmentInput {
            external_id: external_id.to_string(),
            upload_url: upload_url.to_string(),
            file_name: None,
            content_type: None,
            created_at: None,
            telegram: None,
        }
    }

    #[tokio::test]
    #[serial]
    async fn attach_stores_media_once_and_links_chat_message() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let upload_url = upload(&handler, &fixture.scope.login_id).await;
        assert!(upload_url.starts_with("/api/messenger-ingest/v1/uploads/"));
        let mut item = attachment("m-1:0", &upload_url);
        item.file_name = Some("position.jpg".to_string());
        let req = request(&fixture, "m-1", vec![item]);

        let created =
            submit_attachments(&fixture.env, &fixture.scope, req.clone())
                .await
                .unwrap();
        assert_eq!(created.results.len(), 1);
        assert_eq!(
            created.results[0].status,
            MESSENGER_INGEST_MESSAGE_STATUS_CREATED
        );
        let media_id = Uuid::parse_str(&created.results[0].id).unwrap();
        let media = signal_message_media::Entity::find_by_id(media_id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(media.signal_message_id, fixture.chat_message_id);
        assert_eq!(media.file_name.as_deref(), Some("position.jpg"));
        assert_eq!(media.content_type, "image/jpeg");
        let link = messenger_media_meta::Entity::find_by_id(media_id)
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(link.sigint_chat_message_id, fixture.chat_message_id);
        // The upload is consumed after commit.
        assert!(handler
            .open_completed_url(&fixture.scope.login_id, &upload_url)
            .await
            .unwrap()
            .is_none());

        // A retry no longer needs the consumed upload.
        let again = submit_attachments(&fixture.env, &fixture.scope, req)
            .await
            .unwrap();
        assert_eq!(
            again.results[0].status,
            MESSENGER_INGEST_MESSAGE_STATUS_EXISTING
        );
        assert_eq!(again.results[0].id, created.results[0].id);
        let media_count = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId
                    .eq(fixture.chat_message_id),
            )
            .count(&fixture.env.dbx)
            .await
            .unwrap();
        assert_eq!(media_count, 1);
    }

    #[tokio::test]
    #[serial]
    async fn attach_requires_a_submitted_message() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let upload_url = upload(&handler, &fixture.scope.login_id).await;

        let error = submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(&fixture, "m-missing", vec![attachment("a", &upload_url)]),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn attach_rejects_operator_and_foreign_uploads() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let operator_handler = TusHandler::new(
            fixture.env.config.storage_dir.clone(),
            crate::sigint::file_upload::TUS_PATH_BASE,
        );
        let operator_url =
            upload(&operator_handler, &fixture.scope.login_id).await;
        let foreign_url = upload(
            &upload_handler(&fixture.env.config.storage_dir),
            &Uuid::new_v4(),
        )
        .await;

        for url in [operator_url, foreign_url] {
            let error = submit_attachments(
                &fixture.env,
                &fixture.scope,
                request(&fixture, "m-1", vec![attachment("a", &url)]),
            )
            .await
            .unwrap_err();
            assert!(matches!(error, AppError::BL { .. }), "{url}");
        }
    }

    #[tokio::test]
    #[serial]
    async fn attach_rejects_duplicate_external_ids() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let first = upload(&handler, &fixture.scope.login_id).await;
        let second = upload(&handler, &fixture.scope.login_id).await;

        let error = submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(
                &fixture,
                "m-1",
                vec![attachment("a", &first), attachment("a", &second)],
            ),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn attach_stores_telegram_meta_and_checks_retries() {
        let fixture = fixture(MESSENGER_TYPE_TELEGRAM).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let upload_url = upload(&handler, &fixture.scope.login_id).await;
        let mut item = attachment("m-1:0", &upload_url);
        item.created_at = Some(1_760_431_200_000);
        item.telegram = Some(MessengerIngestTelegramMedia {
            file_id: "5413920012345678901".to_string(),
            media_type: Some("photo".to_string()),
        });

        let created = submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(&fixture, "m-1", vec![item.clone()]),
        )
        .await
        .unwrap();
        let link = messenger_media_meta::Entity::find_by_id(
            Uuid::parse_str(&created.results[0].id).unwrap(),
        )
        .one(&fixture.env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(link.telegram_file_id, Some(5_413_920_012_345_678_901));
        assert_eq!(link.telegram_media_type.as_deref(), Some("photo"));
        assert_eq!(
            link.external_created_at,
            timestamp_from_millis(Some(1_760_431_200_000)).unwrap()
        );

        // A retry with another Telegram media type is rejected.
        item.telegram = Some(MessengerIngestTelegramMedia {
            file_id: "5413920012345678901".to_string(),
            media_type: Some("document".to_string()),
        });
        let error = submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(&fixture, "m-1", vec![item]),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn attach_rejects_telegram_fields_for_other_messengers() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let upload_url = upload(&handler, &fixture.scope.login_id).await;
        let mut item = attachment("m-1:0", &upload_url);
        item.telegram = Some(MessengerIngestTelegramMedia {
            file_id: "1".to_string(),
            media_type: None,
        });

        let error = submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(&fixture, "m-1", vec![item]),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn attach_racing_a_concurrent_attach_is_a_conflict() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let first = upload(&handler, &fixture.scope.login_id).await;
        let second = upload(&handler, &fixture.scope.login_id).await;
        submit_attachments(
            &fixture.env,
            &fixture.scope,
            request(&fixture, "m-1", vec![attachment("m-1:0", &first)]),
        )
        .await
        .unwrap();

        // A request that read "m-1:0" as new before the attach above
        // committed: it staged its own copy and now tries to store it.
        let item = attachment("m-1:0", &second);
        let account = resolve_account_ref(
            &fixture.env.dbx,
            &fixture.scope,
            &fixture.account,
        )
        .await
        .unwrap();
        let meta = BTreeMap::from([(
            item.external_id.as_str(),
            media_meta(&account, &item).unwrap(),
        )]);
        let uploads = resolve_uploads(&fixture.env, &fixture.scope, &[&item])
            .await
            .unwrap();
        let staged = crate::messenger::media::stage_media_attachments(
            &fixture.env.dbx,
            &uploads,
            &fixture.env.config,
            &fixture.env.s3,
            UploadedAttachmentDeletion::DeleteAfterCommit,
            None,
        )
        .await
        .unwrap();
        let error = persist_staged(
            &fixture.env,
            Uuid::parse_str(&fixture.chat.id).unwrap(),
            "m-1",
            &[&item],
            &meta,
            &staged,
        )
        .await
        .unwrap_err();
        staged
            .cleanup_after_rollback(&fixture.env.config, &fixture.env.s3)
            .await;

        let AppError::ConflictJson { body } = error else {
            panic!("expected a conflict, got {error:?}");
        };
        assert_eq!(
            body["details"]["code"],
            MESSENGER_INGEST_CONCURRENT_ATTACH_CODE
        );
        // Nothing else was stored, and the losing upload is kept.
        let media_count = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId
                    .eq(fixture.chat_message_id),
            )
            .count(&fixture.env.dbx)
            .await
            .unwrap();
        assert_eq!(media_count, 1);
        assert!(handler
            .open_completed_url(&fixture.scope.login_id, &second)
            .await
            .unwrap()
            .is_some());
    }
}
