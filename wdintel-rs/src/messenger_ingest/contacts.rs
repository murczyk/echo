use crate::config::MESSENGER_INGEST_SYNC_MAX_ITEMS;
use crate::entities::{messenger_account, messenger_contact};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, ensure_unique_created_external_ids,
    parse_echo_uuid, parse_i64_decimal, resolve_account_ref,
};
use crate::messenger_ingest::types::{
    MessengerIngestContactInput, MessengerIngestContactItem,
    MessengerIngestContactsSyncReq, MessengerIngestContactsSyncRsp,
    MessengerIngestTelegramAccountId,
};
use crate::types::ShortContext;
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::BTreeMap;
use uuid::Uuid;

/// Delta sync of the contacts of one account, with the same rules as chats
/// sync. Contacts are kept apart from chat members: the same person may be
/// both, each with the profile the collector saw there.
pub(crate) async fn sync_contacts(
    db: &DatabaseConnection,
    scope: &IngestScope,
    req: MessengerIngestContactsSyncReq,
) -> Result<MessengerIngestContactsSyncRsp, AppError> {
    let item_count = req.created.len() + req.updated.len() + req.deleted.len();
    if item_count > MESSENGER_INGEST_SYNC_MAX_ITEMS {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {item_count}, max {MESSENGER_INGEST_SYNC_MAX_ITEMS}"
            ),
        });
    }
    ensure_unique_created_external_ids(
        "contact",
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
        let contact = create_or_restore_contact(&txn, &account, item, now)
            .await
            .c(h!())?;
        created.insert(contact.id.to_string(), contact_item(&contact));
    }
    for (id, item) in &req.updated {
        let contact = update_contact(&txn, &account, id, item, now)
            .await
            .c(h!())?;
        updated.insert(contact.id.to_string(), contact_item(&contact));
    }
    for id in &req.deleted {
        if let Some(deleted_id) =
            delete_contact(&txn, &account, id, now).await.c(h!())?
        {
            deleted.push(deleted_id);
        }
    }
    txn.commit().await.c(h!())?;

    Ok(MessengerIngestContactsSyncRsp {
        created,
        updated,
        deleted,
    })
}

pub(crate) async fn create_or_restore_contact(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    item: &MessengerIngestContactInput,
    now: NaiveDateTime,
) -> Result<messenger_contact::Model, AppError> {
    let telegram_user_id = parse_telegram_user_id(account, item).c(h!())?;

    // The unique (messenger_account_id, external_id) constraint spans
    // deleted rows, so a create for a previously deleted external id
    // restores it with its original uuid.
    let existing = messenger_contact::Entity::find()
        .filter(messenger_contact::Column::MessengerAccountId.eq(account.id))
        .filter(messenger_contact::Column::ExternalId.eq(&item.external_id))
        .one(txn)
        .await
        .c(h!())?;
    match existing {
        // A create for a live external id is applied as a full update, so
        // a collector that lost the response can resend it.
        Some(contact) if !contact.deleted => {
            ensure_same_telegram_user_id(&contact, telegram_user_id).c(h!())?;
            let mut contact = contact.into_active_model();
            set_contact_fields(&mut contact, item, telegram_user_id, now);
            Ok(contact.update(txn).await.c(h!())?)
        }
        // A restore keeps the stored Telegram user id.
        Some(contact) => {
            ensure_same_telegram_user_id(&contact, telegram_user_id).c(h!())?;
            ensure_telegram_user_id_free(
                txn,
                account.id,
                telegram_user_id,
                Some(contact.id),
            )
            .await
            .c(h!())?;
            let mut contact = contact.into_active_model();
            set_contact_fields(&mut contact, item, telegram_user_id, now);
            Ok(contact.update(txn).await.c(h!())?)
        }
        None => {
            ensure_telegram_user_id_free(
                txn,
                account.id,
                telegram_user_id,
                None,
            )
            .await
            .c(h!())?;
            let mut contact = messenger_contact::ActiveModel {
                id: Set(Uuid::now_v7()),
                messenger_account_id: Set(account.id),
                messenger_type: Set(account.messenger_type.clone()),
                external_id: Set(item.external_id.clone()),
                created_at: Set(now),
                ..Default::default()
            };
            set_contact_fields(&mut contact, item, telegram_user_id, now);
            Ok(contact.insert(txn).await.c(h!())?)
        }
    }
}

async fn update_contact(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    id: &str,
    item: &MessengerIngestContactInput,
    now: NaiveDateTime,
) -> Result<messenger_contact::Model, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let contact = find_contact_by_id(txn, account.id, id).await.c(h!())?;
    let telegram_user_id = parse_telegram_user_id(account, item).c(h!())?;
    if contact.external_id != item.external_id {
        return Err(AppError::BL {
            msg: format!(
                "contact external_id {} does not match contact {}",
                item.external_id, contact.external_id
            ),
        });
    }
    ensure_same_telegram_user_id(&contact, telegram_user_id).c(h!())?;
    let mut contact = contact.into_active_model();
    set_contact_fields(&mut contact, item, telegram_user_id, now);
    Ok(contact.update(txn).await.c(h!())?)
}

/// Soft-deletes a contact. A uuid that is already deleted or foreign is a
/// no-op, so deletion is idempotent.
async fn delete_contact(
    txn: &DatabaseTransaction,
    account: &messenger_account::Model,
    id: &str,
    now: NaiveDateTime,
) -> Result<Option<String>, AppError> {
    let id = parse_echo_uuid(id).c(h!())?;
    let contact = match find_contact_by_id(txn, account.id, id).await {
        Ok(contact) => contact,
        Err(AppError::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut contact = contact.into_active_model();
    contact.deleted = Set(true);
    contact.updated_at = Set(now);
    contact.update(txn).await.c(h!())?;
    Ok(Some(id.to_string()))
}

/// A live contact of the given account, or `NotFound`. The account was
/// resolved within the caller's scope, so the contact is too.
async fn find_contact_by_id(
    txn: &DatabaseTransaction,
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

/// A stored Telegram user id never changes, and a contact without one
/// cannot gain one through an update.
fn ensure_same_telegram_user_id(
    contact: &messenger_contact::Model,
    telegram_user_id: Option<i64>,
) -> Result<(), AppError> {
    if contact.telegram_user_id != telegram_user_id {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id does not match contact {}",
                contact.external_id
            ),
        });
    }
    Ok(())
}

fn parse_telegram_user_id(
    account: &messenger_account::Model,
    item: &MessengerIngestContactInput,
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

/// A Telegram user id may belong to only one live contact of an account.
async fn ensure_telegram_user_id_free(
    txn: &DatabaseTransaction,
    account_id: Uuid,
    telegram_user_id: Option<i64>,
    except_contact_id: Option<Uuid>,
) -> Result<(), AppError> {
    let Some(telegram_user_id) = telegram_user_id else {
        return Ok(());
    };
    let mut conflicting = messenger_contact::Entity::find()
        .filter(messenger_contact::Column::MessengerAccountId.eq(account_id))
        .filter(messenger_contact::Column::Deleted.eq(false))
        .filter(messenger_contact::Column::TelegramUserId.eq(telegram_user_id));
    if let Some(except_contact_id) = except_contact_id {
        conflicting = conflicting
            .filter(messenger_contact::Column::Id.ne(except_contact_id));
    }
    if conflicting.one(txn).await.c(h!())?.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id {telegram_user_id} already belongs to another contact"
            ),
        });
    }
    Ok(())
}

/// Full-state write of the collector-owned contact fields; also restores a
/// soft-deleted contact.
fn set_contact_fields(
    contact: &mut messenger_contact::ActiveModel,
    item: &MessengerIngestContactInput,
    telegram_user_id: Option<i64>,
    now: NaiveDateTime,
) {
    contact.telegram_user_id = Set(telegram_user_id);
    contact.username = Set(item.username.clone());
    contact.first_name = Set(item.first_name.clone());
    contact.last_name = Set(item.last_name.clone());
    contact.phone = Set(item.phone.clone());
    contact.is_mutual = Set(item.is_mutual);
    contact.is_close_friend = Set(item.is_close_friend);
    contact.deleted = Set(false);
    contact.updated_at = Set(now);
}

fn contact_item(
    contact: &messenger_contact::Model,
) -> MessengerIngestContactItem {
    MessengerIngestContactItem {
        messenger_type: contact.messenger_type.clone(),
        id: contact.id.to_string(),
        external_id: contact.external_id.clone(),
        username: contact.username.clone(),
        first_name: contact.first_name.clone(),
        last_name: contact.last_name.clone(),
        phone: contact.phone.clone(),
        is_mutual: contact.is_mutual,
        is_close_friend: contact.is_close_friend,
        telegram: contact.telegram_user_id.map(|user_id| {
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
    use crate::messenger_ingest::types::MessengerIngestAccountInput;
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
        external_id: &str,
    ) -> messenger_account::Model {
        create_or_restore_account(
            scope,
            &MessengerIngestAccountInput {
                messenger_type: messenger_type.to_string(),
                external_id: external_id.to_string(),
                display_name: format!("Account {external_id}"),
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
                telegram: None,
            },
            Utc::now().naive_utc(),
            txn,
        )
        .await
        .unwrap()
    }

    fn contact_input(
        external_id: &str,
        user_id: Option<&str>,
    ) -> MessengerIngestContactInput {
        MessengerIngestContactInput {
            external_id: external_id.to_string(),
            username: Some(format!("user_{external_id}")),
            first_name: Some("Andrii".to_string()),
            last_name: None,
            phone: Some("+380501112233".to_string()),
            is_mutual: Some(true),
            is_close_friend: Some(false),
            telegram: user_id.map(|user_id| MessengerIngestTelegramAccountId {
                user_id: user_id.to_string(),
            }),
        }
    }

    #[tokio::test]
    #[serial]
    async fn contact_sync_creates_updates_deletes_and_restores() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account =
            account(&txn, &scope, MESSENGER_TYPE_TELEGRAM, "account-1").await;
        let now = Utc::now().naive_utc();

        let contact = create_or_restore_contact(
            &txn,
            &account,
            &contact_input("u-1", Some("6011122233")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(contact.telegram_user_id, Some(6_011_122_233));
        assert_eq!(contact.messenger_account_id, account.id);
        assert_eq!(contact.is_mutual, Some(true));

        // Updates are full state: an omitted phone clears it.
        let mut changed = contact_input("u-1", Some("6011122233"));
        changed.phone = None;
        let updated = update_contact(
            &txn,
            &account,
            &contact.id.to_string(),
            &changed,
            now,
        )
        .await
        .unwrap();
        assert_eq!(updated.id, contact.id);
        assert_eq!(updated.phone, None);

        let deleted =
            delete_contact(&txn, &account, &contact.id.to_string(), now)
                .await
                .unwrap();
        assert_eq!(deleted, Some(contact.id.to_string()));
        assert_eq!(
            delete_contact(&txn, &account, &contact.id.to_string(), now)
                .await
                .unwrap(),
            None
        );
        assert!(matches!(
            find_contact_by_id(&txn, account.id, contact.id).await,
            Err(AppError::NotFound)
        ));

        // A restore cannot move the contact to another Telegram user.
        let error = create_or_restore_contact(
            &txn,
            &account,
            &contact_input("u-1", Some("6011122299")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        let restored = create_or_restore_contact(
            &txn,
            &account,
            &contact_input("u-1", Some("6011122233")),
            now,
        )
        .await
        .unwrap();
        assert_eq!(restored.id, contact.id);
        assert!(!restored.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn contact_sync_rejects_conflicts_and_isolates_accounts() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let first =
            account(&txn, &scope, MESSENGER_TYPE_TELEGRAM, "account-1").await;
        let second =
            account(&txn, &scope, MESSENGER_TYPE_TELEGRAM, "account-2").await;
        let now = Utc::now().naive_utc();
        let contact = create_or_restore_contact(
            &txn,
            &first,
            &contact_input("u-1", Some("1")),
            now,
        )
        .await
        .unwrap();

        // A resent create updates the live contact.
        let mut resent = contact_input("u-1", Some("1"));
        resent.is_close_friend = Some(true);
        let again = create_or_restore_contact(&txn, &first, &resent, now)
            .await
            .unwrap();
        assert_eq!(again.id, contact.id);
        assert_eq!(again.is_close_friend, Some(true));

        // A live external_id with another Telegram user id, or a Telegram
        // user id of another contact.
        for item in
            [contact_input("u-1", None), contact_input("u-2", Some("1"))]
        {
            let error = create_or_restore_contact(&txn, &first, &item, now)
                .await
                .unwrap_err();
            assert!(matches!(error, AppError::BL { .. }));
        }
        let error = update_contact(
            &txn,
            &first,
            &contact.id.to_string(),
            &contact_input("u-1", Some("2")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));

        // The same person in another account is another contact.
        let other = create_or_restore_contact(
            &txn,
            &second,
            &contact_input("u-1", Some("1")),
            now,
        )
        .await
        .unwrap();
        assert_ne!(other.id, contact.id);
        assert!(matches!(
            find_contact_by_id(&txn, second.id, contact.id).await,
            Err(AppError::NotFound)
        ));
    }

    #[tokio::test]
    #[serial]
    async fn contact_sync_rejects_telegram_fields_for_max() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope = ingest_scope(&txn).await;
        let account =
            account(&txn, &scope, MESSENGER_TYPE_MAX, "account-1").await;
        let now = Utc::now().naive_utc();

        let contact = create_or_restore_contact(
            &txn,
            &account,
            &contact_input("u-1", None),
            now,
        )
        .await
        .unwrap();
        assert_eq!(contact.messenger_type, MESSENGER_TYPE_MAX);
        let error = create_or_restore_contact(
            &txn,
            &account,
            &contact_input("u-2", Some("1")),
            now,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }
}
