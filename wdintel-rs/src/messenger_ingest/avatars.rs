use crate::config::{
    MESSENGER_INGEST_AVATAR_MAX_SIZE_BYTES,
    MESSENGER_INGEST_CONCURRENT_AVATAR_CODE,
    MESSENGER_INGEST_MESSAGE_STATUS_CREATED,
    MESSENGER_INGEST_MESSAGE_STATUS_EXISTING,
};
use crate::entities::{
    messenger_account, messenger_avatar, messenger_chat, messenger_chat_member,
    messenger_contact,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::media::{MediaUploadInput, StagedAvatar};
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, parse_i64_decimal, resolve_account_ref,
    resolve_chat_member_ref, resolve_chat_ref, resolve_contact_ref,
    timestamp_from_millis, MessengerIngestAccountRef,
};
use crate::messenger_ingest::types::{
    MessengerIngestAccountAvatarSubmitReq, MessengerIngestAvatarInput,
    MessengerIngestAvatarItem, MessengerIngestAvatarSubmitRsp,
    MessengerIngestChatAvatarSubmitReq,
    MessengerIngestChatMemberAvatarSubmitReq,
    MessengerIngestContactAvatarSubmitReq,
};
use crate::messenger_ingest::uploads::{
    ensure_uploads_enabled, upload_handler,
};
use crate::types::{Env, ShortContext};
use chrono::NaiveDateTime;
use sea_orm::*;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnerKind {
    Account,
    Chat,
    ChatMember,
    Contact,
}

impl OwnerKind {
    fn avatar_column(self) -> messenger_avatar::Column {
        match self {
            Self::Account => messenger_avatar::Column::MessengerAccountId,
            Self::Chat => messenger_avatar::Column::MessengerChatId,
            Self::ChatMember => messenger_avatar::Column::MessengerChatMemberId,
            Self::Contact => messenger_avatar::Column::MessengerContactId,
        }
    }
}

/// A resolved avatar owner: the kind and the Echo id of the row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OwnerKey {
    kind: OwnerKind,
    id: Uuid,
    /// The owner's current avatar when it was resolved.
    current: Option<Uuid>,
}

/// The submitted avatar with its owner resolved and its fields parsed.
struct AvatarRequest<'a> {
    item: &'a MessengerIngestAvatarInput,
    owner: OwnerKey,
    messenger_type: String,
    telegram_photo_id: Option<i64>,
    set_at: Option<NaiveDateTime>,
}

// Avatar submits of the four owner kinds. Each resolves its owner and hands
// it to `run`; the upload is a shared TUS upload of the ingest API. An
// avatar already stored under the same owner and `external_id` is returned
// as `existing` and its upload is not read. A request without an avatar
// removes the owner's current avatar and keeps its history.

pub(crate) async fn submit_account_avatar(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestAccountAvatarSubmitReq,
) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
    let (txn, account) = begin(env, scope, &req.account).await.c(h!())?;
    let owner = OwnerKey {
        kind: OwnerKind::Account,
        id: account.id,
        current: account.avatar_id,
    };
    run(env, scope, txn, &account, owner, req.avatar.as_ref()).await
}

pub(crate) async fn submit_chat_avatar(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestChatAvatarSubmitReq,
) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
    let (txn, account) = begin(env, scope, &req.account).await.c(h!())?;
    let chat = resolve_chat_ref(&txn, &account, &req.chat).await.c(h!())?;
    let owner = OwnerKey {
        kind: OwnerKind::Chat,
        id: chat.id,
        current: chat.avatar_id,
    };
    run(env, scope, txn, &account, owner, req.avatar.as_ref()).await
}

pub(crate) async fn submit_chat_member_avatar(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestChatMemberAvatarSubmitReq,
) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
    let (txn, account) = begin(env, scope, &req.account).await.c(h!())?;
    let chat = resolve_chat_ref(&txn, &account, &req.chat).await.c(h!())?;
    let member = resolve_chat_member_ref(&txn, &chat, &req.member)
        .await
        .c(h!())?;
    let owner = OwnerKey {
        kind: OwnerKind::ChatMember,
        id: member.id,
        current: member.avatar_id,
    };
    run(env, scope, txn, &account, owner, req.avatar.as_ref()).await
}

pub(crate) async fn submit_contact_avatar(
    env: &Env,
    scope: &IngestScope,
    req: MessengerIngestContactAvatarSubmitReq,
) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
    let (txn, account) = begin(env, scope, &req.account).await.c(h!())?;
    let contact = resolve_contact_ref(&txn, &account, &req.contact)
        .await
        .c(h!())?;
    let owner = OwnerKey {
        kind: OwnerKind::Contact,
        id: contact.id,
        current: contact.avatar_id,
    };
    run(env, scope, txn, &account, owner, req.avatar.as_ref()).await
}

/// Opens the resolving transaction of a submit and resolves the account.
async fn begin(
    env: &Env,
    scope: &IngestScope,
    account: &MessengerIngestAccountRef,
) -> Result<(DatabaseTransaction, messenger_account::Model), AppError> {
    ensure_uploads_enabled(env).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let account = resolve_account_ref(&txn, scope, account).await.c(h!())?;
    Ok((txn, account))
}

/// Same phases as `attachments::submit_attachments`: the open transaction
/// has resolved the owner; a short read looks for the stored avatar, a new
/// upload is copied to S3 outside any transaction, and a short write locks
/// the owner and stores the avatar. The staged copy is removed when the
/// write fails; the upload is consumed only after it commits.
async fn run(
    env: &Env,
    scope: &IngestScope,
    txn: DatabaseTransaction,
    account: &messenger_account::Model,
    owner: OwnerKey,
    avatar: Option<&MessengerIngestAvatarInput>,
) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
    let Some(item) = avatar else {
        // Lock and clear in the resolving transaction, so a concurrent
        // submit cannot set a newer avatar between the two.
        lock_owner(&txn, owner).await.c(h!())?;
        set_current(&txn, owner, None).await.c(h!())?;
        txn.commit().await.c(h!())?;
        return Ok(MessengerIngestAvatarSubmitRsp { avatar: None });
    };

    // 1. Read: look for the avatar in the owner's history.
    let request = build_request(account, owner, item).c(h!())?;
    let stored = find_existing(&txn, &request).await.c(h!())?;
    if let (Some(row), false) = (&stored, item.is_current) {
        // Nothing to write: report the stored avatar as it was read.
        txn.commit().await.c(h!())?;
        return Ok(MessengerIngestAvatarSubmitRsp {
            avatar: Some(avatar_item(
                row,
                MESSENGER_INGEST_MESSAGE_STATUS_EXISTING,
                owner.current,
            )),
        });
    }
    txn.commit().await.c(h!())?;

    // 2. Stage: validate the upload and copy it to S3, no transaction.
    let staged = if stored.is_some() {
        None
    } else {
        let upload = resolve_upload(env, scope, &request).await.c(h!())?;
        let avatar = crate::messenger::media::stage_avatar(
            &upload,
            &env.config,
            &env.s3,
            MESSENGER_INGEST_AVATAR_MAX_SIZE_BYTES,
        )
        .await
        .c(h!())?;
        Some((avatar, upload))
    };

    // 3. Write: lock the owner, re-check, store and point the owner.
    let persisted = persist_staged(
        env,
        &request,
        staged.as_ref().map(|(avatar, _)| avatar),
    )
    .await;
    let avatar = match persisted {
        Ok(avatar) => avatar,
        Err(error) => {
            // The upload is kept, so the collector can retry the request.
            if let Some((avatar, _)) = &staged {
                crate::messenger::media::discard_staged_avatar(
                    &env.config,
                    &env.s3,
                    avatar,
                )
                .await;
            }
            return Err(error);
        }
    };

    // 4. Finalize: consume the upload.
    if let Some((_, upload)) = staged {
        crate::messenger::media::delete_uploaded_attachment_files(&[upload])
            .await;
    }
    Ok(MessengerIngestAvatarSubmitRsp {
        avatar: Some(avatar),
    })
}

fn build_request<'a>(
    account: &messenger_account::Model,
    owner: OwnerKey,
    item: &'a MessengerIngestAvatarInput,
) -> Result<AvatarRequest<'a>, AppError> {
    ensure_provider_fields(&account.messenger_type, item.telegram.is_some())
        .c(h!())?;
    let telegram_photo_id = item
        .telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram photo_id", &telegram.photo_id)
        })
        .transpose()
        .c(h!())?;
    Ok(AvatarRequest {
        item,
        owner,
        messenger_type: account.messenger_type.clone(),
        telegram_photo_id,
        set_at: timestamp_from_millis(item.set_at).c(h!())?,
    })
}

/// The stored avatar under the requested owner and `external_id`. A retry
/// must repeat the stored Telegram `photo_id`; `set_at` is not compared.
async fn find_existing(
    txn: &impl ConnectionTrait,
    request: &AvatarRequest<'_>,
) -> Result<Option<messenger_avatar::Model>, AppError> {
    let row = messenger_avatar::Entity::find()
        .filter(request.owner.kind.avatar_column().eq(request.owner.id))
        .filter(
            messenger_avatar::Column::ExternalId
                .eq(request.item.external_id.as_str()),
        )
        .one(txn)
        .await
        .c(h!())?;
    if let Some(row) = &row {
        if row.telegram_photo_id != request.telegram_photo_id {
            return Err(AppError::BL {
                msg: format!(
                    "telegram fields do not match avatar {}",
                    row.external_id
                ),
            });
        }
    }
    Ok(row)
}

/// The completed ingest upload of the login for a new avatar; the JSON file
/// name and MIME type override the TUS metadata when sent.
async fn resolve_upload(
    env: &Env,
    scope: &IngestScope,
    request: &AvatarRequest<'_>,
) -> Result<MediaUploadInput, AppError> {
    let upload = upload_handler(&env.config.storage_dir)
        .resolve_completed_uploads(
            &scope.login_id,
            std::slice::from_ref(&request.item.upload_url),
        )
        .await
        .c(h!())?
        .pop()
        .ok_or(AppError::NotFound)
        .c(h!())?;
    Ok(MediaUploadInput {
        name: request.item.file_name.clone().or(upload.name),
        content_type: request.item.content_type.clone().or(upload.content_type),
        path: upload.path,
    })
}

/// Stores the staged avatar, if any, and moves the owner's current-avatar
/// pointer in one short transaction and commits. A concurrent submit may
/// have stored the avatar since the read; the request then fails with a
/// retryable `409` and its staged copy is discarded by the caller.
async fn persist_staged(
    env: &Env,
    request: &AvatarRequest<'_>,
    staged: Option<&StagedAvatar>,
) -> Result<MessengerIngestAvatarItem, AppError> {
    let txn = env.dbx.begin().await.c(h!())?;
    let mut current = lock_owner(&txn, request.owner).await.c(h!())?;
    let stored = find_existing(&txn, request).await.c(h!())?;
    let (row, status) = match (stored, staged) {
        (Some(_), Some(_)) => return Err(concurrent_submit(request)),
        (Some(row), None) => (row, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING),
        (None, Some(staged)) => {
            ensure_photo_unused(&txn, request).await.c(h!())?;
            let row = insert_avatar(&txn, request, staged).await.c(h!())?;
            (row, MESSENGER_INGEST_MESSAGE_STATUS_CREATED)
        }
        (None, None) => {
            return Err(AppError::BL {
                msg: "upload not found or incomplete".to_string(),
            });
        }
    };
    if request.item.is_current {
        set_current(&txn, request.owner, Some(row.id))
            .await
            .c(h!())?;
        current = Some(row.id);
    }
    txn.commit().await.c(h!())?;
    Ok(avatar_item(&row, status, current))
}

fn avatar_item(
    row: &messenger_avatar::Model,
    status: &str,
    current: Option<Uuid>,
) -> MessengerIngestAvatarItem {
    MessengerIngestAvatarItem {
        id: row.id.to_string(),
        external_id: row.external_id.clone(),
        status: status.to_string(),
        is_current: current == Some(row.id),
    }
}

/// Locks one live owner row and returns its current avatar. An owner
/// deleted since the read is `NotFound`.
async fn lock_owner(
    txn: &DatabaseTransaction,
    owner: OwnerKey,
) -> Result<Option<Uuid>, AppError> {
    let avatar_id = match owner.kind {
        OwnerKind::Account => messenger_account::Entity::find_by_id(owner.id)
            .filter(messenger_account::Column::Deleted.eq(false))
            .lock_exclusive()
            .one(txn)
            .await
            .c(h!())?
            .map(|row| row.avatar_id),
        OwnerKind::Chat => messenger_chat::Entity::find_by_id(owner.id)
            .filter(messenger_chat::Column::Deleted.eq(false))
            .lock_exclusive()
            .one(txn)
            .await
            .c(h!())?
            .map(|row| row.avatar_id),
        OwnerKind::ChatMember => {
            messenger_chat_member::Entity::find_by_id(owner.id)
                .filter(messenger_chat_member::Column::Deleted.eq(false))
                .lock_exclusive()
                .one(txn)
                .await
                .c(h!())?
                .map(|row| row.avatar_id)
        }
        OwnerKind::Contact => messenger_contact::Entity::find_by_id(owner.id)
            .filter(messenger_contact::Column::Deleted.eq(false))
            .lock_exclusive()
            .one(txn)
            .await
            .c(h!())?
            .map(|row| row.avatar_id),
    };
    avatar_id.ok_or(AppError::NotFound)
}

/// The avatar was stored by a concurrent submit since the read.
fn concurrent_submit(request: &AvatarRequest<'_>) -> AppError {
    let external_id = &request.item.external_id;
    AppError::ConflictJson {
        body: serde_json::json!({
            "message": format!(
                "avatar {external_id} was submitted concurrently; retry the request"
            ),
            "details": {
                "code": MESSENGER_INGEST_CONCURRENT_AVATAR_CODE,
                "external_id": external_id,
            },
        }),
    }
}

/// A Telegram `photo_id` belongs to one avatar per owner. Checked under
/// the owner lock, so it needs no unique index.
async fn ensure_photo_unused(
    txn: &DatabaseTransaction,
    request: &AvatarRequest<'_>,
) -> Result<(), AppError> {
    let Some(photo_id) = request.telegram_photo_id else {
        return Ok(());
    };
    let used = messenger_avatar::Entity::find()
        .filter(request.owner.kind.avatar_column().eq(request.owner.id))
        .filter(messenger_avatar::Column::TelegramPhotoId.eq(photo_id))
        .count(txn)
        .await
        .c(h!())?;
    if used > 0 {
        return Err(AppError::BL {
            msg: format!(
                "telegram photo_id {photo_id} already belongs to another avatar"
            ),
        });
    }
    Ok(())
}

async fn insert_avatar(
    txn: &DatabaseTransaction,
    request: &AvatarRequest<'_>,
    avatar: &StagedAvatar,
) -> Result<messenger_avatar::Model, AppError> {
    let mut row = messenger_avatar::ActiveModel {
        id: Set(Uuid::now_v7()),
        messenger_type: Set(request.messenger_type.clone()),
        external_id: Set(request.item.external_id.clone()),
        telegram_photo_id: Set(request.telegram_photo_id),
        content_type: Set(avatar.content_type.clone()),
        file_name: Set(avatar.file_name.clone()),
        file_ext: Set(avatar.file_ext.clone()),
        size_bytes: Set(avatar.size_bytes),
        is_encrypted: Set(avatar.is_encrypted),
        storage_key: Set(avatar.storage_key.clone()),
        external_set_at: Set(request.set_at),
        ..Default::default()
    };
    let owner = Set(Some(request.owner.id));
    match request.owner.kind {
        OwnerKind::Account => row.messenger_account_id = owner,
        OwnerKind::Chat => row.messenger_chat_id = owner,
        OwnerKind::ChatMember => row.messenger_chat_member_id = owner,
        OwnerKind::Contact => row.messenger_contact_id = owner,
    }
    Ok(row.insert(txn).await.c(h!())?)
}

/// Points the owner at the avatar, or at none.
async fn set_current(
    txn: &DatabaseTransaction,
    owner: OwnerKey,
    avatar_id: Option<Uuid>,
) -> Result<(), AppError> {
    let avatar_id = Set(avatar_id);
    match owner.kind {
        OwnerKind::Account => {
            messenger_account::ActiveModel {
                id: Set(owner.id),
                avatar_id,
                ..Default::default()
            }
            .update(txn)
            .await
            .c(h!())?;
        }
        OwnerKind::Chat => {
            messenger_chat::ActiveModel {
                id: Set(owner.id),
                avatar_id,
                ..Default::default()
            }
            .update(txn)
            .await
            .c(h!())?;
        }
        OwnerKind::ChatMember => {
            messenger_chat_member::ActiveModel {
                id: Set(owner.id),
                avatar_id,
                ..Default::default()
            }
            .update(txn)
            .await
            .c(h!())?;
        }
        OwnerKind::Contact => {
            messenger_contact::ActiveModel {
                id: Set(owner.id),
                avatar_id,
                ..Default::default()
            }
            .update(txn)
            .await
            .c(h!())?;
        }
    }
    Ok(())
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
    use crate::messenger_ingest::refs::{
        MessengerIngestAccountRef, MessengerIngestChatMemberRef,
        MessengerIngestChatRef, MessengerIngestContactRef,
    };
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestAccountsSyncReq,
        MessengerIngestChatInput, MessengerIngestChatMemberInput,
        MessengerIngestChatMembersSyncReq, MessengerIngestChatsSyncReq,
        MessengerIngestContactInput, MessengerIngestContactsSyncReq,
        MessengerIngestTelegramAccountId, MessengerIngestTelegramAvatar,
        MessengerIngestTelegramChatId,
    };
    use crate::sigint::file_upload::tus::{
        CompletedUploadWriteResult, TusHandler, TusUploadMetadata,
    };
    use opendal::{services::Memory, Operator};
    use serial_test::serial;
    use std::collections::BTreeMap;

    struct Fixture {
        env: Env,
        scope: IngestScope,
        account: MessengerIngestAccountRef,
        chat: MessengerIngestChatRef,
        member: MessengerIngestChatMemberRef,
        contact: MessengerIngestContactRef,
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
        let members = crate::messenger_ingest::members::sync_chat_members(
            &env.dbx,
            &scope,
            MessengerIngestChatMembersSyncReq {
                account: account.clone(),
                chat: chat.clone(),
                created: vec![MessengerIngestChatMemberInput {
                    external_id: "member-1".to_string(),
                    username: None,
                    first_name: None,
                    last_name: None,
                    phone: None,
                    is_bot: None,
                    role: None,
                    joined_date: None,
                    telegram: None,
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let member = members.created.into_values().next().unwrap();
        let member = MessengerIngestChatMemberRef {
            id: member.id,
            external_id: member.external_id,
            telegram: member.telegram,
        };
        let contacts = crate::messenger_ingest::contacts::sync_contacts(
            &env.dbx,
            &scope,
            MessengerIngestContactsSyncReq {
                account: account.clone(),
                created: vec![MessengerIngestContactInput {
                    external_id: "contact-1".to_string(),
                    username: None,
                    first_name: None,
                    last_name: None,
                    phone: None,
                    is_mutual: None,
                    is_close_friend: None,
                    telegram: None,
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap();
        let contact = contacts.created.into_values().next().unwrap();
        let contact = MessengerIngestContactRef {
            id: contact.id,
            external_id: contact.external_id,
            telegram: contact.telegram,
        };
        Fixture {
            env,
            scope,
            account,
            chat,
            member,
            contact,
            _storage: storage,
        }
    }

    async fn upload_bytes(
        handler: &TusHandler,
        login: &Uuid,
        filename: &str,
        filetype: &str,
        bytes: &'static [u8],
    ) -> String {
        let result = handler
            .create_completed_upload(
                login,
                TusUploadMetadata {
                    filename: Some(filename.to_string()),
                    filetype: Some(filetype.to_string()),
                    ..Default::default()
                },
                futures_util::stream::iter([Ok(
                    actix_web::web::Bytes::from_static(bytes),
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

    async fn upload(fixture: &Fixture) -> String {
        upload_bytes(
            &upload_handler(&fixture.env.config.storage_dir),
            &fixture.scope.login_id,
            "avatar.jpg",
            "image/jpeg",
            b"jpeg bytes",
        )
        .await
    }

    fn avatar(
        external_id: &str,
        upload_url: &str,
        is_current: bool,
    ) -> MessengerIngestAvatarInput {
        MessengerIngestAvatarInput {
            external_id: external_id.to_string(),
            upload_url: upload_url.to_string(),
            file_name: None,
            content_type: None,
            set_at: None,
            is_current,
            telegram: None,
        }
    }

    async fn account_submit(
        fixture: &Fixture,
        avatar: Option<MessengerIngestAvatarInput>,
    ) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
        submit_account_avatar(
            &fixture.env,
            &fixture.scope,
            MessengerIngestAccountAvatarSubmitReq {
                account: fixture.account.clone(),
                avatar,
            },
        )
        .await
    }

    async fn chat_submit(
        fixture: &Fixture,
        avatar: Option<MessengerIngestAvatarInput>,
    ) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
        submit_chat_avatar(
            &fixture.env,
            &fixture.scope,
            MessengerIngestChatAvatarSubmitReq {
                account: fixture.account.clone(),
                chat: fixture.chat.clone(),
                avatar,
            },
        )
        .await
    }

    async fn member_submit(
        fixture: &Fixture,
        avatar: Option<MessengerIngestAvatarInput>,
    ) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
        submit_chat_member_avatar(
            &fixture.env,
            &fixture.scope,
            MessengerIngestChatMemberAvatarSubmitReq {
                account: fixture.account.clone(),
                chat: fixture.chat.clone(),
                member: fixture.member.clone(),
                avatar,
            },
        )
        .await
    }

    async fn contact_submit(
        fixture: &Fixture,
        avatar: Option<MessengerIngestAvatarInput>,
    ) -> Result<MessengerIngestAvatarSubmitRsp, AppError> {
        submit_contact_avatar(
            &fixture.env,
            &fixture.scope,
            MessengerIngestContactAvatarSubmitReq {
                account: fixture.account.clone(),
                contact: fixture.contact.clone(),
                avatar,
            },
        )
        .await
    }

    async fn avatar_count(fixture: &Fixture) -> u64 {
        messenger_avatar::Entity::find()
            .count(&fixture.env.dbx)
            .await
            .unwrap()
    }

    async fn chat_avatar_id(fixture: &Fixture) -> Option<Uuid> {
        messenger_chat::Entity::find_by_id(
            Uuid::parse_str(&fixture.chat.id).unwrap(),
        )
        .one(&fixture.env.dbx)
        .await
        .unwrap()
        .unwrap()
        .avatar_id
    }

    fn stored(
        rsp: MessengerIngestAvatarSubmitRsp,
    ) -> MessengerIngestAvatarItem {
        rsp.avatar.unwrap()
    }

    #[tokio::test]
    #[serial]
    async fn avatars_are_stored_per_owner_and_consume_uploads() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let handler = upload_handler(&fixture.env.config.storage_dir);
        let mut urls = vec![];
        for _ in 0..4 {
            urls.push(upload(&fixture).await);
        }
        // The same external_id under different owners is a different
        // avatar.
        let account = avatar("photo-1", &urls[0], true);
        let chat = avatar("photo-1", &urls[1], true);

        let created = stored(
            account_submit(&fixture, Some(account.clone()))
                .await
                .unwrap(),
        );
        assert_eq!(created.status, MESSENGER_INGEST_MESSAGE_STATUS_CREATED);
        assert!(created.is_current);
        let chat_created =
            stored(chat_submit(&fixture, Some(chat.clone())).await.unwrap());
        member_submit(&fixture, Some(avatar("photo-1", &urls[2], true)))
            .await
            .unwrap();
        contact_submit(&fixture, Some(avatar("photo-1", &urls[3], true)))
            .await
            .unwrap();
        assert_eq!(avatar_count(&fixture).await, 4);
        for url in &urls {
            assert!(handler
                .open_completed_url(&fixture.scope.login_id, url)
                .await
                .unwrap()
                .is_none());
        }

        // A retry no longer needs the consumed upload.
        let again =
            stored(account_submit(&fixture, Some(account)).await.unwrap());
        assert_eq!(again.status, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING);
        assert_eq!(again.id, created.id);
        let again = stored(chat_submit(&fixture, Some(chat)).await.unwrap());
        assert_eq!(again.id, chat_created.id);
        assert_eq!(avatar_count(&fixture).await, 4);
        let account_row = messenger_account::Entity::find_by_id(
            Uuid::parse_str(&fixture.account.id).unwrap(),
        )
        .one(&fixture.env.dbx)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            account_row.avatar_id,
            Some(Uuid::parse_str(&created.id).unwrap())
        );
    }

    #[tokio::test]
    #[serial]
    async fn current_avatar_switches_and_clears_keeping_history() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let first_url = upload(&fixture).await;
        let second_url = upload(&fixture).await;
        let old = stored(
            chat_submit(&fixture, Some(avatar("old", &first_url, false)))
                .await
                .unwrap(),
        );
        assert!(!old.is_current);
        assert_eq!(chat_avatar_id(&fixture).await, None);
        let new = stored(
            chat_submit(&fixture, Some(avatar("new", &second_url, true)))
                .await
                .unwrap(),
        );
        assert!(new.is_current);
        assert_eq!(
            chat_avatar_id(&fixture).await,
            Some(Uuid::parse_str(&new.id).unwrap())
        );

        // Switching back to the stored avatar needs no upload.
        let switched = stored(
            chat_submit(&fixture, Some(avatar("old", "unused", true)))
                .await
                .unwrap(),
        );
        assert_eq!(switched.status, MESSENGER_INGEST_MESSAGE_STATUS_EXISTING);
        assert_eq!(switched.id, old.id);
        assert!(switched.is_current);

        let cleared = chat_submit(&fixture, None).await.unwrap();
        assert_eq!(cleared.avatar, None);
        assert_eq!(chat_avatar_id(&fixture).await, None);
        assert_eq!(avatar_count(&fixture).await, 2);
    }

    #[tokio::test]
    #[serial]
    async fn avatar_rejects_unsupported_content() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let url = upload_bytes(
            &upload_handler(&fixture.env.config.storage_dir),
            &fixture.scope.login_id,
            "notes.txt",
            "text/plain",
            b"plain text",
        )
        .await;

        let error =
            account_submit(&fixture, Some(avatar("photo-1", &url, true)))
                .await
                .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
        assert_eq!(avatar_count(&fixture).await, 0);
        // Nothing was stored, so the upload can be retried.
        assert!(upload_handler(&fixture.env.config.storage_dir)
            .open_completed_url(&fixture.scope.login_id, &url)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    #[serial]
    async fn avatar_owner_must_belong_to_the_account() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let url = upload(&fixture).await;
        let mut chat = fixture.chat.clone();
        chat.id = Uuid::now_v7().to_string();

        let error = submit_chat_avatar(
            &fixture.env,
            &fixture.scope,
            MessengerIngestChatAvatarSubmitReq {
                account: fixture.account.clone(),
                chat,
                avatar: Some(avatar("photo-1", &url, true)),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn avatar_telegram_photo_ids_are_checked() {
        let fixture = fixture(MESSENGER_TYPE_TELEGRAM).await;
        let url = upload(&fixture).await;
        let mut item = avatar("photo-1", &url, true);
        item.telegram = Some(MessengerIngestTelegramAvatar {
            photo_id: "5413920012345678901".to_string(),
        });
        account_submit(&fixture, Some(item.clone())).await.unwrap();
        let row = messenger_avatar::Entity::find()
            .one(&fixture.env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.telegram_photo_id, Some(5_413_920_012_345_678_901));

        // A retry with another photo_id is rejected.
        let mut changed = item.clone();
        changed.telegram = Some(MessengerIngestTelegramAvatar {
            photo_id: "1".to_string(),
        });
        let error = account_submit(&fixture, Some(changed)).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // The same photo_id under another external_id is rejected.
        let other_url = upload(&fixture).await;
        let mut other = avatar("photo-2", &other_url, false);
        other.telegram = item.telegram.clone();
        let error = account_submit(&fixture, Some(other)).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
        assert_eq!(avatar_count(&fixture).await, 1);
    }

    #[tokio::test]
    #[serial]
    async fn avatar_telegram_fields_are_rejected_for_other_messengers() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let url = upload(&fixture).await;
        let mut item = avatar("photo-1", &url, true);
        item.telegram = Some(MessengerIngestTelegramAvatar {
            photo_id: "1".to_string(),
        });

        let error = account_submit(&fixture, Some(item)).await.unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn avatar_racing_a_concurrent_submit_is_a_conflict() {
        let fixture = fixture(MESSENGER_TYPE_MAX).await;
        let first = upload(&fixture).await;
        let second = upload(&fixture).await;
        account_submit(&fixture, Some(avatar("photo-1", &first, true)))
            .await
            .unwrap();

        // A request that read "photo-1" as new before the submit above
        // committed: it staged its own copy and now tries to store it.
        let item = avatar("photo-1", &second, true);
        let account = resolve_account_ref(
            &fixture.env.dbx,
            &fixture.scope,
            &fixture.account,
        )
        .await
        .unwrap();
        let owner = OwnerKey {
            kind: OwnerKind::Account,
            id: account.id,
            current: account.avatar_id,
        };
        let request = build_request(&account, owner, &item).unwrap();
        let upload = resolve_upload(&fixture.env, &fixture.scope, &request)
            .await
            .unwrap();
        let staged = crate::messenger::media::stage_avatar(
            &upload,
            &fixture.env.config,
            &fixture.env.s3,
            MESSENGER_INGEST_AVATAR_MAX_SIZE_BYTES,
        )
        .await
        .unwrap();
        let error = persist_staged(&fixture.env, &request, Some(&staged))
            .await
            .unwrap_err();
        crate::messenger::media::discard_staged_avatar(
            &fixture.env.config,
            &fixture.env.s3,
            &staged,
        )
        .await;

        let AppError::ConflictJson { body } = error else {
            panic!("expected a conflict, got {error:?}");
        };
        assert_eq!(
            body["details"]["code"],
            MESSENGER_INGEST_CONCURRENT_AVATAR_CODE
        );
        assert_eq!(avatar_count(&fixture).await, 1);
        assert!(upload_handler(&fixture.env.config.storage_dir)
            .open_completed_url(&fixture.scope.login_id, &second)
            .await
            .unwrap()
            .is_some());
    }
}
