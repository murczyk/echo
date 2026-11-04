use crate::entities::{datasource_group, messenger_account};
use crate::error::AppError;
use crate::h;
use crate::messengers::access::MessengersScope;
use crate::messengers::types::{
    MessengersAccountItem, MessengersAccountsListRsp,
    MessengersDatasourceGroup, MessengersTelegramAccountId,
};
use crate::types::ShortContext;
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
        phone: account.phone.clone(),
        status: account.status.clone(),
        is_active: account.is_active,
        is_paused: account.is_paused,
        last_sync: account
            .external_last_sync_at
            .map(|dt| dt.and_utc().timestamp_millis()),
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
