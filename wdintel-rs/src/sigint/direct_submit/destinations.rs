use super::{query, types::DirectSubmitPayload};
use crate::datasource::native::is_native_group;
use crate::entities::signal_group;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use sea_orm::*;

#[derive(FromQueryResult)]
struct DestinationDatasource {
    datasource_id: i64,
    datasource_group_id: i64,
}

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
    if groups.len() > 1 {
        let is_native =
            is_native_group(txn, &groups[0].master_key).await.c(h!())?;
        for group in &groups[1..] {
            anyhow::ensure!(
                is_native
                    == is_native_group(txn, &group.master_key)
                        .await
                        .c(h!())?,
                "Не можна одночасно надсилати повідомлення у групи Echo Native та зовнішніх джерел."
            );
        }
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
        let destination =
            prepare_datasource_group(txn, &group).await.c(h!())?;
        primary_datasource_id.get_or_insert(destination.datasource_id);
        destinations.push((group.master_key, destination.datasource_group_id));
    }
    Ok((primary_datasource_id, destinations))
}

async fn prepare_datasource_group(
    txn: &DatabaseTransaction,
    group: &signal_group::Model,
) -> anyhow::Result<DestinationDatasource> {
    let destination = DestinationDatasource::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select dg.datasource_id, dg.id as datasource_group_id
            from datasource_group dg
            join datasource d on d.id = dg.datasource_id
            where dg.group_master_key = $1
            order by (dg.deleted or d.deleted),
                coalesce(dg.datasource_id = $2, false) desc,
                dg.created_at desc, dg.id desc
            limit 1
            "#,
            vec![group.master_key.clone().into(), group.datasource_id.into()],
        ),
    )
    .one(txn)
    .await
    .c(h!())?;
    if let Some(destination) = destination {
        return Ok(destination);
    }
    let datasource_id = group
        .datasource_id
        .unwrap_or(crate::config::SIGNAL_DATASOURCE_ID);
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            group.master_key.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    Ok(DestinationDatasource {
        datasource_id,
        datasource_group_id,
    })
}
