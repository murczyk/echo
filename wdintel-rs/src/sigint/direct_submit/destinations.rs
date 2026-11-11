use super::{query, types::DirectSubmitPayload};
use crate::entities::signal_group;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use sea_orm::DatabaseTransaction;

pub(super) async fn resolve(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    primary: Option<signal_group::Model>,
    payload: &DirectSubmitPayload,
    allow_multiple: bool,
) -> anyhow::Result<Vec<signal_group::Model>> {
    anyhow::ensure!(
        payload.additional_signal_group_master_keys.is_empty()
            || allow_multiple,
        "Кілька груп можна обрати лише для нового повідомлення."
    );
    let mut groups = primary.into_iter().collect::<Vec<_>>();
    for key in &payload.additional_signal_group_master_keys {
        let key = key.trim();
        anyhow::ensure!(!key.is_empty(), "Оберіть групу.");
        if groups.iter().any(|group| group.master_key == key) {
            continue;
        }
        groups.push(
            query::find_available_signal_group(txn, login, key)
                .await
                .c(h!())?,
        );
    }
    Ok(groups)
}

pub(super) async fn prepare(
    txn: &DatabaseTransaction,
    login: &uuid::Uuid,
    groups: Vec<signal_group::Model>,
    item: &InboxSubmitItem,
    is_new_message: bool,
) -> anyhow::Result<(Option<i64>, Vec<(String, i64)>)> {
    let mut primary_datasource_id = None;
    let mut destinations = Vec::with_capacity(groups.len());
    for group in groups {
        if is_new_message {
            crate::messenger::group::requirements::validate(&group, item)
                .c(h!())?;
        }
        crate::messenger::group::native::lock_for_publish_if_native(
            txn,
            &group.master_key,
            login,
        )
        .await
        .c(h!())?;
        let datasource_id = match group.datasource_id {
            Some(id) => id,
            None => {
                query::resolve_datasource_id_for_group(txn, &group.master_key)
                    .await
                    .c(h!())?
            }
        };
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                txn,
                group.master_key.clone(),
                datasource_id,
            )
            .await
            .c(h!())?;
        primary_datasource_id.get_or_insert(datasource_id);
        destinations.push((group.master_key, datasource_group_id));
    }
    Ok((primary_datasource_id, destinations))
}
