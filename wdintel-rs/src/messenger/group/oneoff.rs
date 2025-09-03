use crate::entities::{datasource_group, signal_group, signal_message};
use crate::error::AppError;
use crate::types::Mode;
use crate::{config, h};
use anyhow::Context;
use echo_migration::Expr;
use log::{error, info};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, JoinType, NotSet, PaginatorTrait, QueryFilter, QuerySelect,
    RelationTrait, Set,
};
use std::collections::{HashMap, HashSet};
pub async fn check_should_populate_signal_message_group_ids<
    'a,
    'async_trait,
    C,
>(
    db: &C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let pending_messages_count = signal_message::Entity::find()
        .filter(signal_message::Column::DatasourceGroupId.is_null())
        .count(db)
        .await
        .context(h!())?;
    if pending_messages_count > 0 {
        error!("Oneoff command 'oneoff_populate_signal_message_group_ids' should be executed! Pending signal messages: {pending_messages_count}");
    }
    Ok(())
}

pub async fn oneoff_populate_signal_message_group_ids(
    mode: Mode,
) -> Result<(), AppError> {
    info!("oneoff_assign_message_ids started");
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let datasource_groups = datasource_group::Entity::find()
        .all(&dbx)
        .await
        .context(h!())?;
    let mut counter = 1;
    let count = datasource_groups.len();
    for datasource_group in datasource_groups {
        let group_filter = if datasource_group
            .group_master_key
            .eq(config::UNKNOWN_GROUP_MASTER_KEY)
        {
            datasource_group::Column::GroupMasterKey.is_null()
        } else {
            datasource_group::Column::GroupMasterKey
                .eq(datasource_group.group_master_key.clone())
        };
        loop {
            let messages_to_update = signal_message::Entity::find()
                .join(
                    JoinType::InnerJoin,
                    signal_message::Relation::DatasourceGroup.def(),
                )
                .filter(signal_message::Column::DatasourceGroupId.is_null())
                .filter(
                    datasource_group::Column::DatasourceId
                        .eq(datasource_group.datasource_id),
                )
                .filter(group_filter.clone())
                .select_only()
                .column(signal_message::Column::Id)
                .limit(20000)
                .into_tuple::<i64>()
                .all(&dbx)
                .await
                .context(h!())?;
            if messages_to_update.is_empty() {
                info!(
                    "[{counter}/{count}] update for datasource_group {} done",
                    datasource_group.id
                );
                counter += 1;
                break;
            } else {
                info!("[{counter}/{count}] updating signal_message.group_id values for datasource_group {}...", datasource_group.id);
            }
            signal_message::Entity::update_many()
                .filter(signal_message::Column::Id.is_in(messages_to_update))
                .col_expr(
                    signal_message::Column::DatasourceGroupId,
                    Expr::value(datasource_group.id),
                )
                .exec(&dbx)
                .await
                .context(h!())?;
        }
    }
    info!("oneoff_assign_message_ids done");
    check_should_populate_signal_message_group_ids(&dbx)
        .await
        .context(h!())?;
    Ok(())
}

async fn insert_missing_datasource_groups(
    dbx: &DatabaseConnection,
) -> Result<Vec<datasource_group::Model>, AppError> {
    let source_datasource_groups = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column(datasource_group::Column::GroupMasterKey)
        .column(datasource_group::Column::DatasourceId)
        .group_by(datasource_group::Column::GroupMasterKey)
        .group_by(datasource_group::Column::DatasourceId)
        .into_tuple::<(Option<String>, i64)>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    let mut existing_groups = datasource_group::Entity::find()
        .all(dbx)
        .await
        .context(h!())?;
    let mut existing_groups_dictionary = existing_groups
        .clone()
        .into_iter()
        .map(|g| (g.group_master_key, g.datasource_id))
        .collect::<HashSet<_>>();
    let group_names = signal_group::Entity::find()
        .select_only()
        .column(signal_group::Column::MasterKey)
        .column(signal_group::Column::Name)
        .into_tuple::<(String, Option<String>)>()
        .all(dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashMap<_, _>>();

    for (group_master_key, datasource_id) in source_datasource_groups {
        let group_master_key = group_master_key
            .unwrap_or(config::UNKNOWN_GROUP_MASTER_KEY.to_string());
        let group_key = (group_master_key.clone(), datasource_id);
        if existing_groups_dictionary.contains(&group_key) {
            continue;
        } else {
            existing_groups_dictionary.insert(group_key);
        }
        let group_name = group_names
            .get(&group_master_key)
            .cloned()
            .flatten()
            .unwrap_or("".to_string());
        let new_group = datasource_group::ActiveModel {
            group_master_key: Set(group_master_key),
            name: Set(group_name),
            datasource_id: Set(datasource_id),
            created_at: NotSet,
            id: NotSet,
            last_sync_at: NotSet,
        }
        .insert(dbx)
        .await
        .context(h!())?;
        existing_groups.push(new_group);
    }
    Ok(existing_groups)
}
