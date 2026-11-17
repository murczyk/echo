use crate::config::MESSENGERS_AVATAR_CACHE_CONTROL;
use crate::entities::{
    messenger_avatar, messenger_chat, messenger_chat_member, messenger_contact,
};
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::accounts::resolve_account;
use crate::types::{Env, ShortContext};
use actix_web::http::header;
use actix_web::HttpResponse;
use sea_orm::*;
use uuid::Uuid;

/// The avatar's content. An avatar is visible to the logins that can see the
/// account that owns it; anything else is a `404`. Not ranged: avatars are at
/// most `MESSENGER_INGEST_AVATAR_MAX_SIZE_BYTES`.
pub(crate) async fn serve_avatar(
    env: &Env,
    scope: &MessengersScope,
    avatar_id: Uuid,
) -> Result<HttpResponse, AppError> {
    let avatar = authorized_avatar(&env.dbx, scope, avatar_id)
        .await
        .c(h!())?;
    let mut response = HttpResponse::Ok();
    response
        .insert_header((header::CONTENT_TYPE, avatar.content_type.clone()))
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header((
            header::CACHE_CONTROL,
            MESSENGERS_AVATAR_CACHE_CONTROL,
        ));
    let mut response = if avatar.is_encrypted {
        response.body(decrypted_avatar(env, &avatar).await.c(h!())?)
    } else {
        let size = u64::try_from(avatar.size_bytes).c(h!())?;
        let stream = crate::storage::stream_s3_object_range_with_operator(
            &env.s3,
            &env.s3_config,
            &avatar.storage_key,
            0..size,
        )
        .await
        .c(h!())?;
        response
            .insert_header((header::CONTENT_LENGTH, size.to_string()))
            .streaming(stream)
    };
    // Avatars come from the messenger, and an SVG one would otherwise run as
    // a page on Echo's origin when opened in a tab.
    crate::rer_importer::apply_media_document_security_headers(
        &mut response,
        &avatar.content_type,
    );
    Ok(response)
}

async fn decrypted_avatar(
    env: &Env,
    avatar: &messenger_avatar::Model,
) -> Result<Vec<u8>, AppError> {
    let s3_config = env.config.s3_config.as_ref().ok_or(AppError::BL {
        msg: "S3 is not configured".to_string(),
    })?;
    // The download answers an empty body when either is missing, and an
    // empty avatar would be cached by the browser.
    if env.s3.is_none() || env.s3_config.is_none() {
        return Err(AppError::BL {
            msg: "S3 is not configured".to_string(),
        });
    }
    crate::storage::download_and_decrypt_messenger_media_from_s3_with_operator(
        &env.s3,
        &env.s3_config,
        &s3_config.strongbox_key,
        &avatar.storage_key,
    )
    .await
}

async fn authorized_avatar(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    avatar_id: Uuid,
) -> Result<messenger_avatar::Model, AppError> {
    let avatar = messenger_avatar::Entity::find_by_id(avatar_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let account_id = owner_account_id(dbx, &avatar).await.c(h!())?;
    resolve_account(dbx, scope, &account_id.to_string())
        .await
        .c(h!())?;
    Ok(avatar)
}

/// The account that owns the avatar, directly or through its chat, member
/// or contact.
async fn owner_account_id(
    dbx: &DatabaseConnection,
    avatar: &messenger_avatar::Model,
) -> Result<Uuid, AppError> {
    if let Some(account_id) = avatar.messenger_account_id {
        return Ok(account_id);
    }
    if let Some(contact_id) = avatar.messenger_contact_id {
        let contact = messenger_contact::Entity::find_by_id(contact_id)
            .one(dbx)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        return Ok(contact.messenger_account_id);
    }
    let chat_id =
        match (avatar.messenger_chat_id, avatar.messenger_chat_member_id) {
            (Some(chat_id), _) => chat_id,
            (None, Some(member_id)) => {
                messenger_chat_member::Entity::find_by_id(member_id)
                    .one(dbx)
                    .await
                    .c(h!())?
                    .ok_or(AppError::NotFound)?
                    .messenger_chat_id
            }
            (None, None) => return Err(AppError::NotFound),
        };
    let chat = messenger_chat::Entity::find_by_id(chat_id)
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(chat.messenger_account_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_INGEST_GROUP_KEY_PREFIX,
        MESSENGER_TYPE_MAX,
    };
    use crate::entities::datasource;
    use crate::functest::tests::{cleanup, mk_datasource, mk_login};
    use crate::messenger_ingest::access::IngestScope;
    use crate::messenger_ingest::types::{
        MessengerIngestAccountInput, MessengerIngestAccountsSyncReq,
        MessengerIngestChatInput, MessengerIngestChatsSyncReq,
    };
    use chrono::Utc;
    use serial_test::serial;
    use std::collections::BTreeMap;

    async fn avatar_of(
        dbx: &DatabaseConnection,
        owner: messenger_avatar::ActiveModel,
    ) -> Uuid {
        messenger_avatar::ActiveModel {
            id: Set(Uuid::now_v7()),
            messenger_type: Set(MESSENGER_TYPE_MAX.to_string()),
            external_id: Set(Uuid::now_v7().to_string()),
            content_type: Set("image/jpeg".to_string()),
            size_bytes: Set(1),
            is_encrypted: Set(true),
            storage_key: Set("avatar".to_string()),
            created_at: Set(Utc::now().naive_utc()),
            ..owner
        }
        .insert(dbx)
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    #[serial]
    async fn avatar_is_visible_only_through_the_owning_account() {
        let env = cleanup().await.unwrap();
        let login = mk_login(&env.dbx, Default::default()).await.unwrap();
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
        let ingest = IngestScope {
            login_id: login.id,
            datasource,
        };
        let account = crate::messenger_ingest::accounts::sync_accounts(
            &env.dbx,
            &ingest,
            MessengerIngestAccountsSyncReq {
                created: vec![MessengerIngestAccountInput {
                    messenger_type: MESSENGER_TYPE_MAX.to_string(),
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
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap()
        .created
        .into_values()
        .next()
        .unwrap();
        let chat = crate::messenger_ingest::chats::sync_chats(
            &env.dbx,
            &ingest,
            MessengerIngestChatsSyncReq {
                account:
                    crate::messenger_ingest::refs::MessengerIngestAccountRef {
                        id: account.id.clone(),
                        external_id: account.external_id.clone(),
                        messenger_type: account.messenger_type.clone(),
                        telegram: account.telegram.clone(),
                    },
                created: vec![MessengerIngestChatInput {
                    external_id: "chat-1".to_string(),
                    chat_type: None,
                    title: None,
                    username: None,
                    members_count: None,
                    account_member_status: None,
                    last_message_date: None,
                    is_bot: None,
                    telegram: None,
                }],
                updated: BTreeMap::new(),
                deleted: vec![],
            },
        )
        .await
        .unwrap()
        .created
        .into_values()
        .next()
        .unwrap();

        let account_avatar = avatar_of(
            &env.dbx,
            messenger_avatar::ActiveModel {
                messenger_account_id: Set(Some(
                    Uuid::parse_str(&account.id).unwrap(),
                )),
                ..Default::default()
            },
        )
        .await;
        let chat_avatar = avatar_of(
            &env.dbx,
            messenger_avatar::ActiveModel {
                messenger_chat_id: Set(Some(
                    Uuid::parse_str(&chat.id).unwrap(),
                )),
                ..Default::default()
            },
        )
        .await;
        let scope = |group_master_key: String| MessengersScope {
            login_id: login.id,
            group_master_keys: vec![group_master_key],
        };
        let owner =
            scope(format!("{MESSENGER_INGEST_GROUP_KEY_PREFIX}{}", account.id));
        let stranger = scope("other-group".to_string());

        for avatar_id in [account_avatar, chat_avatar] {
            let avatar = authorized_avatar(&env.dbx, &owner, avatar_id)
                .await
                .unwrap();
            assert_eq!(avatar.id, avatar_id);
            assert!(matches!(
                authorized_avatar(&env.dbx, &stranger, avatar_id).await,
                Err(AppError::NotFound)
            ));
        }
        assert!(matches!(
            authorized_avatar(&env.dbx, &owner, Uuid::now_v7()).await,
            Err(AppError::NotFound)
        ));
    }
}
