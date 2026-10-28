use crate::config::MESSENGER_INGEST_SYNC_MAX_ITEMS;
use crate::entities::sea_orm_active_enums::InterseptionKind;
use crate::entities::{datasource_group, messenger_account, signal_group};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::access::IngestScope;
use crate::messenger_ingest::refs::{
    ensure_provider_fields, ensure_unique_created_external_ids,
    find_scoped_account_by_external_id, find_scoped_account_by_id,
    parse_i64_decimal,
};
use crate::messenger_ingest::types::{
    MessengerIngestAccountInput, MessengerIngestAccountItem,
    MessengerIngestAccountsSyncReq, MessengerIngestAccountsSyncRsp,
    MessengerIngestTelegramAccountId,
};
use crate::types::ShortContext;
use chrono::{NaiveDateTime, Utc};
use sea_orm::*;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) async fn sync_accounts(
    db: &DatabaseConnection,
    scope: &IngestScope,
    req: MessengerIngestAccountsSyncReq,
) -> Result<MessengerIngestAccountsSyncRsp, AppError> {
    let item_count = req.created.len() + req.updated.len() + req.deleted.len();
    if item_count > MESSENGER_INGEST_SYNC_MAX_ITEMS {
        return Err(AppError::BL {
            msg: format!(
                "too many items: {item_count}, max {MESSENGER_INGEST_SYNC_MAX_ITEMS}"
            ),
        });
    }
    ensure_unique_created_external_ids(
        "account",
        req.created.iter().map(|item| item.external_id.as_str()),
    )
    .c(h!())?;

    let now = Utc::now().naive_utc();
    let mut created = BTreeMap::new();
    let mut updated = BTreeMap::new();
    let mut deleted = vec![];

    // One transaction for the whole batch: the delta shape has no
    // per-item error channel, so any item error rolls the request back.
    let txn = db.begin().await.c(h!())?;
    for item in &req.created {
        let account = create_or_restore_account(scope, item, now, &txn)
            .await
            .c(h!())?;
        created.insert(account.id.to_string(), account_item(&account));
    }
    for (id, item) in &req.updated {
        let account =
            update_account(scope, id, item, now, &txn).await.c(h!())?;
        updated.insert(account.id.to_string(), account_item(&account));
    }
    for id in &req.deleted {
        if let Some(deleted_id) =
            delete_account(scope, id, now, &txn).await.c(h!())?
        {
            deleted.push(deleted_id);
        }
    }
    txn.commit().await.c(h!())?;

    Ok(MessengerIngestAccountsSyncRsp {
        created,
        updated,
        deleted,
    })
}

fn account_item(
    account: &messenger_account::Model,
) -> MessengerIngestAccountItem {
    MessengerIngestAccountItem {
        id: account.id.to_string(),
        external_id: account.external_id.clone(),
        display_name: account.display_name.clone(),
        phone: account.phone.clone(),
        username: account.username.clone(),
        first_name: account.first_name.clone(),
        last_name: account.last_name.clone(),
        status: account.status.clone(),
        status_error: account.status_error.clone(),
        status_changed_at: account
            .status_changed_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        is_active: account.is_active,
        is_paused: account.is_paused,
        notes: account.notes.clone(),
        created_at: account
            .external_created_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        last_sync: account
            .external_last_sync_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        messenger_type: account.messenger_type.clone(),
        telegram: account.telegram_user_id.map(|id| {
            MessengerIngestTelegramAccountId {
                user_id: id.to_string(),
            }
        }),
    }
}

pub(crate) async fn create_or_restore_account(
    scope: &IngestScope,
    item: &MessengerIngestAccountInput,
    now: NaiveDateTime,
    txn: &DatabaseTransaction,
) -> anyhow::Result<messenger_account::Model> {
    ensure_provider_fields(&item.messenger_type, item.telegram.is_some())
        .c(h!())?;
    let user_id = item
        .telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram user_id", &telegram.user_id)
        })
        .transpose()
        .c(h!())?;

    // The unique (datasource_id, external_id) constraint spans deleted
    // rows, so a create for a previously deleted external id restores it.
    // A create for a live external id is applied as a full update, so a
    // collector that lost the response can resend it and learn the uuid.
    // Either way the messenger ids must match the stored account: a
    // restore never moves the account's history to another identity.
    let existing =
        find_scoped_account_by_external_id(txn, scope, &item.external_id)
            .await
            .c(h!())?;
    if let Some(account) = existing {
        ensure_same_messenger_type(&account, item).c(h!())?;
        ensure_same_telegram_user_id(&account, user_id).c(h!())?;
        if account.deleted {
            // The Telegram id index covers live rows only, so another
            // account may have taken the id while this one was deleted.
            ensure_telegram_user_id_free(txn, scope, user_id)
                .await
                .c(h!())?;
        }
        return restore_and_update_account(
            scope, &account, item, user_id, now, txn,
        )
        .await;
    }
    ensure_telegram_user_id_free(txn, scope, user_id)
        .await
        .c(h!())?;

    let id = Uuid::now_v7();
    let datasource_group = create_account_group(
        txn,
        scope,
        id,
        &item.display_name,
        &item.messenger_type,
        now,
    )
    .await
    .c(h!())?;
    let account = messenger_account::ActiveModel {
        id: Set(id),
        datasource_id: Set(scope.datasource_id()),
        datasource_group_id: Set(datasource_group.id),
        external_id: Set(item.external_id.clone()),
        display_name: Set(item.display_name.clone()),
        messenger_type: Set(item.messenger_type.clone()),
        telegram_user_id: Set(user_id),
        phone: Set(item.phone.clone()),
        username: Set(item.username.clone()),
        first_name: Set(item.first_name.clone()),
        last_name: Set(item.last_name.clone()),
        status: Set(item.status.clone()),
        status_error: Set(item.status_error.clone()),
        status_changed_at: Set(ts_from_millis(item.status_changed_at).c(h!())?),
        is_active: Set(item.is_active),
        is_paused: Set(item.is_paused),
        notes: Set(item.notes.clone()),
        external_created_at: Set(ts_from_millis(item.created_at).c(h!())?),
        external_last_sync_at: Set(ts_from_millis(item.last_sync).c(h!())?),
        deleted: Set(false),
        created_at: Set(now),
        updated_at: Set(now),
        // Sync never touches `avatar_id`; the avatar submit owns it.
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(account)
}

/// A Telegram user id may belong to only one live account per datasource.
async fn ensure_telegram_user_id_free(
    txn: &DatabaseTransaction,
    scope: &IngestScope,
    user_id: Option<i64>,
) -> Result<(), AppError> {
    let Some(user_id) = user_id else {
        return Ok(());
    };
    let conflicting = messenger_account::Entity::find()
        .filter(
            messenger_account::Column::DatasourceId.eq(scope.datasource_id()),
        )
        .filter(messenger_account::Column::Deleted.eq(false))
        .filter(messenger_account::Column::TelegramUserId.eq(user_id))
        .one(txn)
        .await
        .c(h!())?;
    if conflicting.is_some() {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id {user_id} already belongs to another account"
            ),
        });
    }
    Ok(())
}

/// A stored Telegram user id never changes, and an account without one
/// cannot gain one through an update.
fn ensure_same_telegram_user_id(
    account: &messenger_account::Model,
    user_id: Option<i64>,
) -> Result<(), AppError> {
    if account.telegram_user_id != user_id {
        return Err(AppError::BL {
            msg: format!(
                "telegram user_id does not match account {}",
                account.external_id
            ),
        });
    }
    Ok(())
}

/// Full-state write of an existing account: restores a deleted one or
/// overwrites a live one.
async fn restore_and_update_account(
    scope: &IngestScope,
    account: &messenger_account::Model,
    item: &MessengerIngestAccountInput,
    user_id: Option<i64>,
    now: NaiveDateTime,
    txn: &DatabaseTransaction,
) -> anyhow::Result<messenger_account::Model> {
    ensure_same_messenger_type(account, item).c(h!())?;
    ensure_account_group(txn, scope, account, &item.display_name, now)
        .await
        .c(h!())?;
    let account = messenger_account::ActiveModel {
        id: Set(account.id),
        datasource_id: Set(account.datasource_id),
        datasource_group_id: Set(account.datasource_group_id),
        external_id: Set(account.external_id.clone()),
        display_name: Set(item.display_name.clone()),
        messenger_type: Set(item.messenger_type.clone()),
        telegram_user_id: Set(user_id),
        phone: Set(item.phone.clone()),
        username: Set(item.username.clone()),
        first_name: Set(item.first_name.clone()),
        last_name: Set(item.last_name.clone()),
        status: Set(item.status.clone()),
        status_error: Set(item.status_error.clone()),
        status_changed_at: Set(ts_from_millis(item.status_changed_at).c(h!())?),
        is_active: Set(item.is_active),
        is_paused: Set(item.is_paused),
        notes: Set(item.notes.clone()),
        external_created_at: Set(ts_from_millis(item.created_at).c(h!())?),
        external_last_sync_at: Set(ts_from_millis(item.last_sync).c(h!())?),
        deleted: Set(false),
        created_at: Set(account.created_at),
        updated_at: Set(now),
        // Sync never touches `avatar_id`; the avatar submit owns it.
        ..Default::default()
    }
    .update(txn)
    .await
    .c(h!())?;
    Ok(account)
}

/// An account never changes messenger: its group mirror, chats and
/// provider ids all belong to the original messenger.
fn ensure_same_messenger_type(
    account: &messenger_account::Model,
    item: &MessengerIngestAccountInput,
) -> Result<(), AppError> {
    if account.messenger_type != item.messenger_type {
        return Err(AppError::BL {
            msg: format!(
                "messenger_type {} does not match account {}",
                item.messenger_type, account.external_id
            ),
        });
    }
    Ok(())
}

async fn update_account(
    scope: &IngestScope,
    id: &str,
    item: &MessengerIngestAccountInput,
    now: NaiveDateTime,
    txn: &DatabaseTransaction,
) -> anyhow::Result<messenger_account::Model> {
    let id = crate::messenger_ingest::refs::parse_echo_uuid(id).c(h!())?;
    let account = find_scoped_account_by_id(txn, scope, id).await.c(h!())?;
    ensure_provider_fields(&item.messenger_type, item.telegram.is_some())
        .c(h!())?;
    let user_id = item
        .telegram
        .as_ref()
        .map(|telegram| {
            parse_i64_decimal("telegram user_id", &telegram.user_id)
        })
        .transpose()
        .c(h!())?;
    ensure_same_messenger_type(&account, item).c(h!())?;
    ensure_same_telegram_user_id(&account, user_id).c(h!())?;

    ensure_account_group(txn, scope, &account, &item.display_name, now)
        .await
        .c(h!())?;
    let account = messenger_account::ActiveModel {
        id: Set(account.id),
        datasource_id: Set(account.datasource_id),
        datasource_group_id: Set(account.datasource_group_id),
        external_id: Set(account.external_id.clone()),
        display_name: Set(item.display_name.clone()),
        messenger_type: Set(item.messenger_type.clone()),
        telegram_user_id: Set(user_id),
        phone: Set(item.phone.clone()),
        username: Set(item.username.clone()),
        first_name: Set(item.first_name.clone()),
        last_name: Set(item.last_name.clone()),
        status: Set(item.status.clone()),
        status_error: Set(item.status_error.clone()),
        status_changed_at: Set(ts_from_millis(item.status_changed_at).c(h!())?),
        is_active: Set(item.is_active),
        is_paused: Set(item.is_paused),
        notes: Set(item.notes.clone()),
        external_created_at: Set(ts_from_millis(item.created_at).c(h!())?),
        external_last_sync_at: Set(ts_from_millis(item.last_sync).c(h!())?),
        deleted: Set(false),
        created_at: Set(account.created_at),
        updated_at: Set(now),
        // Sync never touches `avatar_id`; the avatar submit owns it.
        ..Default::default()
    }
    .update(txn)
    .await
    .c(h!())?;
    Ok(account)
}

/// Soft-deletes an account and its group mirror. A uuid that is already
/// deleted or foreign is a no-op, so deletion is idempotent.
async fn delete_account(
    scope: &IngestScope,
    id: &str,
    now: NaiveDateTime,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Option<String>> {
    let id = crate::messenger_ingest::refs::parse_echo_uuid(id).c(h!())?;
    let account = find_scoped_account_by_id(txn, scope, id).await;
    let account = match account {
        Ok(account) => account,
        Err(AppError::NotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    let datasource_group =
        datasource_group::Entity::find_by_id(account.datasource_group_id)
            .one(txn)
            .await
            .c(h!())?
            .c(h!())?;
    let group_master_key = datasource_group.group_master_key.clone();
    let mut datasource_group = datasource_group.into_active_model();
    datasource_group.deleted = Set(true);
    datasource_group.last_sync_at = Set(now);
    datasource_group.update(txn).await.c(h!())?;

    let signal_group = signal_group::Entity::find_by_id(group_master_key)
        .one(txn)
        .await
        .c(h!())?;
    if let Some(signal_group) = signal_group {
        if signal_group.datasource_id == Some(scope.datasource_id()) {
            let mut signal_group = signal_group.into_active_model();
            signal_group.deleted = Set(true);
            signal_group.update(txn).await.c(h!())?;
        }
    }

    let mut account = account.into_active_model();
    account.deleted = Set(true);
    account.updated_at = Set(now);
    account.update(txn).await.c(h!())?;
    Ok(Some(id.to_string()))
}

async fn create_account_group(
    txn: &DatabaseTransaction,
    scope: &IngestScope,
    account_id: Uuid,
    display_name: &str,
    messenger_type: &str,
    now: NaiveDateTime,
) -> anyhow::Result<datasource_group::Model> {
    // One signal_group and one datasource_group per messenger account;
    // the echo-generated key keeps accounts of different datasources apart.
    let master_key = format!("messenger_ingest.{account_id}");
    let signal_group = crate::operator::insert_or_sync_signal_group(
        txn,
        scope.datasource_id(),
        master_key,
        display_name,
    )
    .await
    .c(h!())?;

    // Messenger messages are attributed by unit mask, not by frequency.
    let mut signal_group = signal_group.into_active_model();
    signal_group.interseption_kind = Set(InterseptionKind::Other);
    let signal_group = signal_group.update(txn).await.c(h!())?;

    let datasource_group = datasource_group::ActiveModel {
        datasource_id: Set(scope.datasource_id()),
        group_master_key: Set(signal_group.master_key.clone()),
        name: Set(display_name.to_string()),
        messenger_type: Set(Some(messenger_type.to_string())),
        last_sync_at: Set(now),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())?;
    Ok(datasource_group)
}

/// Keeps the group mirror (signal_group + datasource_group names and the
/// messenger type) in step with the account on every update.
async fn ensure_account_group(
    txn: &DatabaseTransaction,
    scope: &IngestScope,
    account: &messenger_account::Model,
    display_name: &str,
    now: NaiveDateTime,
) -> anyhow::Result<()> {
    let datasource_group =
        datasource_group::Entity::find_by_id(account.datasource_group_id)
            .one(txn)
            .await
            .c(h!())?
            .c(h!())?;
    if datasource_group.deleted
        || datasource_group.name != display_name
        || datasource_group.messenger_type.as_deref()
            != Some(account.messenger_type.as_str())
    {
        let signal_group = signal_group::Entity::find_by_id(
            datasource_group.group_master_key.clone(),
        )
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
        crate::operator::sync_signal_group(
            txn,
            scope.datasource_id(),
            &signal_group,
            display_name,
        )
        .await
        .c(h!())?;
        let mut datasource_group = datasource_group.into_active_model();
        datasource_group.name = Set(display_name.to_string());
        datasource_group.messenger_type =
            Set(Some(account.messenger_type.clone()));
        datasource_group.deleted = Set(false);
        datasource_group.last_sync_at = Set(now);
        datasource_group.update(txn).await.c(h!())?;
    }
    Ok(())
}

fn ts_from_millis(ms: Option<i64>) -> anyhow::Result<Option<NaiveDateTime>> {
    ms.map(|ms| {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| dt.naive_utc())
            .ok_or_else(|| anyhow::anyhow!("invalid timestamp: {ms}"))
    })
    .transpose()
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
    use serial_test::serial;

    async fn mk_ingest_scope(
        txn: &DatabaseTransaction,
        roles: &[&str],
    ) -> IngestScope {
        let login = mk_login(
            txn,
            login::ActiveModel {
                roles: Set(serde_json::json!(roles)),
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

    fn account_input(
        external_id: &str,
        user_id: &str,
    ) -> MessengerIngestAccountInput {
        MessengerIngestAccountInput {
            messenger_type: MESSENGER_TYPE_TELEGRAM.to_string(),
            external_id: external_id.to_string(),
            display_name: format!("Account {external_id}"),
            phone: None,
            username: Some("tg_username".to_string()),
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
            telegram: Some(MessengerIngestTelegramAccountId {
                user_id: user_id.to_string(),
            }),
        }
    }

    #[tokio::test]
    #[serial]
    async fn account_sync_creates_updates_and_deletes() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope =
            mk_ingest_scope(&txn, &[ROLE_API, ROLE_MESSENGER_INGEST]).await;
        let now = Utc::now().naive_utc();

        // created → the echo uuid is minted and the group mirror is set up.
        let account = create_or_restore_account(
            &scope,
            &account_input("collector-account-1", "700001"),
            now,
            &txn,
        )
        .await
        .unwrap();
        assert_eq!(account.telegram_user_id, Some(700001));
        assert_eq!(account.display_name, "Account collector-account-1");

        let datasource_group =
            crate::entities::datasource_group::Entity::find_by_id(
                account.datasource_group_id,
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            datasource_group.messenger_type.as_deref(),
            Some(MESSENGER_TYPE_TELEGRAM)
        );
        assert_eq!(datasource_group.name, "Account collector-account-1");
        let signal_group = crate::entities::signal_group::Entity::find_by_id(
            datasource_group.group_master_key.clone(),
        )
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            signal_group.master_key,
            format!("messenger_ingest.{}", account.id)
        );

        // updated → full-state update, group name kept in sync.
        let mut changed = account_input("collector-account-1", "700001");
        changed.display_name = "Renamed account".to_string();
        changed.is_active = Some(false);
        let account = update_account(
            &scope,
            &account.id.to_string(),
            &changed,
            now,
            &txn,
        )
        .await
        .unwrap();
        assert_eq!(account.display_name, "Renamed account");
        let datasource_group =
            crate::entities::datasource_group::Entity::find_by_id(
                account.datasource_group_id,
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(datasource_group.name, "Renamed account");

        // deleted → soft-deleted together with the group mirror.
        let deleted =
            delete_account(&scope, &account.id.to_string(), now, &txn)
                .await
                .unwrap();
        assert_eq!(deleted.as_deref(), Some(account.id.to_string().as_str()));
        let datasource_group =
            crate::entities::datasource_group::Entity::find_by_id(
                account.datasource_group_id,
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(datasource_group.deleted);

        // A restore cannot move the account to another Telegram user.
        let error = create_or_restore_account(
            &scope,
            &account_input("collector-account-1", "700099"),
            now,
            &txn,
        )
        .await
        .unwrap_err()
        .downcast::<AppError>()
        .unwrap();
        assert!(matches!(error, AppError::BL { .. }));

        // Re-creating the same external id restores the account.
        let restored = create_or_restore_account(
            &scope,
            &account_input("collector-account-1", "700001"),
            now,
            &txn,
        )
        .await
        .unwrap();
        assert_eq!(restored.id, account.id);
        assert!(!restored.deleted);
    }

    #[tokio::test]
    #[serial]
    async fn account_update_rejects_foreign_uuid() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope =
            mk_ingest_scope(&txn, &[ROLE_API, ROLE_MESSENGER_INGEST]).await;
        let now = Utc::now().naive_utc();

        let account = create_or_restore_account(
            &scope,
            &account_input("collector-account-2", "700002"),
            now,
            &txn,
        )
        .await
        .unwrap();

        let other_scope =
            mk_ingest_scope(&txn, &[ROLE_API, ROLE_MESSENGER_INGEST]).await;
        let error = update_account(
            &other_scope,
            &account.id.to_string(),
            &account_input("collector-account-2", "700002"),
            now,
            &txn,
        )
        .await
        .unwrap_err()
        .downcast::<AppError>()
        .unwrap();
        assert!(matches!(error, AppError::NotFound));
    }

    #[tokio::test]
    #[serial]
    async fn account_create_rejects_messenger_id_conflict() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope =
            mk_ingest_scope(&txn, &[ROLE_API, ROLE_MESSENGER_INGEST]).await;
        let now = Utc::now().naive_utc();

        create_or_restore_account(
            &scope,
            &account_input("collector-account-3", "700003"),
            now,
            &txn,
        )
        .await
        .unwrap();
        let error = create_or_restore_account(
            &scope,
            &account_input("collector-account-4", "700003"),
            now,
            &txn,
        )
        .await
        .unwrap_err()
        .downcast::<AppError>()
        .unwrap();
        assert!(matches!(error, AppError::BL { .. }));
    }

    #[tokio::test]
    #[serial]
    async fn account_create_of_live_external_id_updates_it() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let scope =
            mk_ingest_scope(&txn, &[ROLE_API, ROLE_MESSENGER_INGEST]).await;
        let now = Utc::now().naive_utc();
        let account = create_or_restore_account(
            &scope,
            &account_input("collector-account-5", "700005"),
            now,
            &txn,
        )
        .await
        .unwrap();

        // A resent create returns the same account with the new body.
        let mut resent = account_input("collector-account-5", "700005");
        resent.display_name = "Renamed".to_string();
        let again = create_or_restore_account(&scope, &resent, now, &txn)
            .await
            .unwrap();
        assert_eq!(again.id, account.id);
        assert_eq!(again.display_name, "Renamed");

        // Messenger ids must still match.
        let mut other_type = account_input("collector-account-5", "700005");
        other_type.messenger_type = MESSENGER_TYPE_MAX.to_string();
        other_type.telegram = None;
        for item in [account_input("collector-account-5", "700006"), other_type]
        {
            let error = create_or_restore_account(&scope, &item, now, &txn)
                .await
                .unwrap_err()
                .downcast::<AppError>()
                .unwrap();
            assert!(matches!(error, AppError::BL { .. }));
        }
    }
}
