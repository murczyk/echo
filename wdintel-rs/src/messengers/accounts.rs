use crate::entities::{datasource_group, messenger_account};
use crate::error::AppError;
use crate::h;
use crate::messenger_ingest::refs::parse_echo_uuid;
use crate::messengers::access::MessengersScope;
use crate::messengers::types::{
    MessengersAccountItem, MessengersAccountUpdateReq,
    MessengersAccountsListRsp, MessengersDatasourceGroup,
    MessengersTelegramAccountId,
};
use crate::types::ShortContext;
use chrono::Utc;
use sea_orm::*;

pub(crate) async fn list_accounts(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
) -> Result<MessengersAccountsListRsp, AppError> {
    let accounts = visible_accounts(scope)
        .order_by_asc(messenger_account::Column::DisplayName)
        .order_by_asc(messenger_account::Column::Id)
        .all(dbx)
        .await
        .c(h!())?;
    let items = accounts
        .iter()
        .map(|(account, datasource_group)| {
            let datasource_group = datasource_group.as_ref().c(h!())?;
            Ok(account_item(account, datasource_group))
        })
        .collect::<Result<Vec<_>, AppError>>()
        .c(h!())?;
    Ok(MessengersAccountsListRsp { items })
}

/// Longest `internal_notes` accepted, in characters. The UI field has the
/// same `maxLength`, so only direct API calls can exceed it.
const INTERNAL_NOTES_MAX_CHARS: usize = 512;

/// Full-state write of the fields Echo users own: `null` clears a field.
pub(crate) async fn update_account(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    req: MessengersAccountUpdateReq,
) -> Result<(), AppError> {
    validate_internal_notes(req.internal_notes.as_deref()).c(h!())?;
    let account = resolve_account(dbx, scope, &req.account_id).await.c(h!())?;
    let mut account = account.into_active_model();
    account.internal_notes = Set(req.internal_notes);
    account.updated_at = Set(Utc::now().naive_utc());
    account.update(dbx).await.c(h!())?;
    Ok(())
}

fn validate_internal_notes(notes: Option<&str>) -> Result<(), AppError> {
    match notes {
        Some(notes) if notes.chars().count() > INTERNAL_NOTES_MAX_CHARS => {
            Err(AppError::BL {
                msg: format!(
                    "internal_notes is longer than \
                     {INTERNAL_NOTES_MAX_CHARS} characters"
                ),
            })
        }
        _ => Ok(()),
    }
}

/// The account a request refers to. An invalid id is a `400`; an account that
/// is unknown, deleted or outside the caller's groups is a `404`.
pub(crate) async fn resolve_account(
    dbx: &DatabaseConnection,
    scope: &MessengersScope,
    account_id: &str,
) -> Result<messenger_account::Model, AppError> {
    let account_id = parse_echo_uuid(account_id).c(h!())?;
    let account = visible_accounts(scope)
        .filter(messenger_account::Column::Id.eq(account_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    Ok(account.0)
}

/// Live accounts whose group the caller can access. Deleting an account
/// also deletes its group, so `deleted` here only guards a partial state.
fn visible_accounts(
    scope: &MessengersScope,
) -> SelectTwo<messenger_account::Entity, datasource_group::Entity> {
    messenger_account::Entity::find()
        .find_also_related(datasource_group::Entity)
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(scope.group_master_keys.clone()),
        )
        .filter(messenger_account::Column::Deleted.eq(false))
}

fn account_item(
    account: &messenger_account::Model,
    datasource_group: &datasource_group::Model,
) -> MessengersAccountItem {
    MessengersAccountItem {
        id: account.id.to_string(),
        messenger_type: account.messenger_type.clone(),
        external_id: account.external_id.clone(),
        display_name: account.display_name.clone(),
        username: account.username.clone(),
        first_name: account.first_name.clone(),
        last_name: account.last_name.clone(),
        phone: account.phone.clone(),
        status: account.status.clone(),
        status_error: account.status_error.clone(),
        status_changed_at: account
            .status_changed_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        is_active: account.is_active,
        is_paused: account.is_paused,
        created_at: account
            .external_created_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        last_sync: account
            .external_last_sync_at
            .map(|dt| dt.and_utc().timestamp_millis()),
        notes: account.notes.clone(),
        internal_notes: account.internal_notes.clone(),
        external_url: account.external_url.clone(),
        telegram: account.telegram_user_id.map(|id| {
            MessengersTelegramAccountId {
                user_id: id.to_string(),
            }
        }),
        datasource_group: datasource_group_item(datasource_group),
    }
}

fn datasource_group_item(
    datasource_group: &datasource_group::Model,
) -> MessengersDatasourceGroup {
    MessengersDatasourceGroup {
        id: datasource_group.id,
        group_master_key: datasource_group.group_master_key.clone(),
        datasource_id: datasource_group.datasource_id,
        name: datasource_group.name.clone(),
        last_sync_at: datasource_group
            .last_sync_at
            .and_utc()
            .timestamp_millis(),
        created_at: datasource_group.created_at.and_utc().timestamp_millis(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_notes_limit_counts_characters() {
        let at_limit = "ї".repeat(INTERNAL_NOTES_MAX_CHARS);
        let over_limit = "a".repeat(INTERNAL_NOTES_MAX_CHARS + 1);
        assert!(validate_internal_notes(None).is_ok());
        assert!(validate_internal_notes(Some(&at_limit)).is_ok());
        assert!(validate_internal_notes(Some(&over_limit)).is_err());
    }
}
