use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::{config, h};
use anyhow::Context;
use chrono::*;
use dialoguer::theme::ColorfulTheme;
use dialoguer::Confirm;
use echo_migration::Expr;
use indicatif::ProgressBar;
use log::*;
use sea_orm::*;
use std::collections::*;
use tokio::time::sleep;

pub async fn oneoff_calculate_signal_message_groups(
    mode: Mode,
) -> Result<(), AppError> {
    info!("oneoff_calculate_signal_message_groups started");
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;

    let total_records_to_process = signal_message::Entity::find()
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SignalMessageGroup.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message_group::Column::Id.is_null())
        .count(&dbx)
        .await
        .context(h!())?;

    if total_records_to_process < 1 {
        info!("Nothing to do");
        return Ok(());
    }

    let datasource_group_keys = datasource_group::Entity::find()
        .select_only()
        .column(datasource_group::Column::Id)
        .column(datasource_group::Column::GroupMasterKey)
        .into_tuple::<(i64, String)>()
        .all(&dbx)
        .await
        .context(h!())?
        .into_iter()
        .collect::<HashMap<_, _>>();

    let pb = ProgressBar::new(total_records_to_process);
    let mut offset = 0;

    let mut message_ids = HashSet::new();

    loop {
        info!("oneoff_calculate_signal_message_groups work in progress: {}/{total_records_to_process}", message_ids.len());
        sleep(std::time::Duration::from_secs(
            ONEOFF_CALCULATE_SIGNAL_MESSAGE_GROUPS_SLEEP_SEC,
        ))
        .await;
        let new_messages = signal_message::Entity::find()
            .join(
                JoinType::LeftJoin,
                signal_message::Relation::SignalMessageGroup.def(),
            )
            .filter(signal_message_group::Column::Id.is_null())
            .filter(signal_message::Column::Deleted.eq(false))
            .limit(ONEOFF_CALCULATE_SIGNAL_MESSAGR_GROUPS_BATCH_SIZE)
            .offset(offset)
            .all(&dbx)
            .await
            .context(h!())?;
        if new_messages.is_empty() {
            break;
        }
        offset += new_messages.len() as u64;
        for message in new_messages {
            let id = message.duplicate_of.unwrap_or(message.id);
            message_ids.insert(id);
            let group_master_key = message
                .datasource_group_id
                .and_then(|id| datasource_group_keys.get(&id).cloned());
            let new_model = signal_message_group::ActiveModel {
                id: NotSet,
                signal_message_id: Set(id),
                group_master_key: Set(group_master_key),
                sender: Set(message.sender.clone()),
                message_uid: Set(message.message_uid.clone()),
                datasource_group_id: Set(message.datasource_group_id),
                created_at: Set(message.created_at),
            };
            let insert_result = new_model.insert(&dbx).await;
            if let Err(e) = insert_result {
                warn!("Failed to insert new message: {e:#?}");
            }
            if message.duplicate_of.is_some() {
                let mut rec = message.into_active_model();
                rec.deleted = Set(true);
                rec.update(&dbx).await.context(h!())?;
            }
            pb.inc(1);
        }
    }
    Ok(())
}

pub async fn oneoff_unlink_reserve_group_dupes(
    mode: Mode,
) -> Result<(), AppError> {
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    crate::sigint::zone::bl::unlink_reserve_group_dupes(&dbx)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn oneoff_fix_echoim_groups(
    mode: Mode,
    interactive: bool,
) -> Result<(), AppError> {
    info!("oneoff_assign_message_ids started");
    let config = config::read_config(mode).context(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let group_names = signal_group::Entity::find()
        .select_only()
        .filter(signal_group::Column::Name.is_not_null())
        .column(signal_group::Column::MasterKey)
        .column(signal_group::Column::Name)
        .into_tuple::<(String, String)>()
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashMap<String, String>>();
    for (key, name) in group_names {
        if name.trim().is_empty() {
            continue;
        }
        datasource_group::Entity::update_many()
            .filter(datasource_group::Column::GroupMasterKey.eq(key))
            .filter(
                datasource_group::Column::Name
                    .eq("".to_string())
                    .or(datasource_group::Column::Name.is_null()),
            )
            .col_expr(datasource_group::Column::Name, Expr::value(name))
            .exec(&dbx)
            .await
            .context(h!())?;
    }
    fix_retro_signal_group_mappings(&dbx, interactive)
        .await
        .context(h!())?;
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
    insert_missing_datasource_groups(&dbx).await.context(h!())?;
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

async fn check_should_populate_signal_message_group_ids<'a, 'async_trait, C>(
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
            deleted: NotSet,
        }
        .insert(dbx)
        .await
        .context(h!())?;
        existing_groups.push(new_group);
    }
    Ok(existing_groups)
}

async fn fix_retro_signal_group_mappings(
    db: &DatabaseConnection,
    interactive: bool,
) -> anyhow::Result<()> {
    let ts_cutoff =
        Utc::now() - Duration::days(config::MAX_AGE_MESSAGES_TO_UPDATE);
    let keys_mapping = echo_group::Entity::find()
        .filter(echo_group::Column::GroupId.starts_with("group."))
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|g| {
            g.internal_id.map(|internal_id| (g.group_id, internal_id))
        })
        .collect::<HashMap<_, _>>();
    let mut all_keys = vec![];
    for (k, v) in keys_mapping.clone() {
        all_keys.push(k);
        all_keys.push(v);
    }
    if all_keys.is_empty() {
        return Ok(());
    }
    info!("all group keys: {all_keys:?}");
    let datasource_groups = datasource_group::Entity::find()
        .filter(
            datasource_group::Column::GroupMasterKey.is_in(all_keys.clone()),
        )
        .all(db)
        .await
        .context(h!())?;
    for (group_id, internal_id) in keys_mapping {
        let from_groups = datasource_groups
            .iter()
            .filter(|g| g.group_master_key.eq(&internal_id))
            .collect::<Vec<_>>();
        let to_groups = datasource_groups
            .iter()
            .filter(|g| g.group_master_key.eq(&group_id))
            .collect::<Vec<_>>();
        info!("{internal_id} => {group_id}: ");
        info!("from: {from_groups:?}");
        info!("to: {to_groups:?}");
        for source_group in from_groups {
            let target_group_id = to_groups
                .iter()
                .find(|g| g.datasource_id.eq(&source_group.datasource_id))
                .map(|g| g.id);
            if target_group_id.is_none() {
                if interactive {
                    let prompt = format!("Do you want to change master key of datasource group {} (id={}, datasource_id={}) from {} to {}?", source_group.name, source_group.id, source_group.datasource_id, source_group.group_master_key, group_id);
                    let confirmed =
                        Confirm::with_theme(&ColorfulTheme::default())
                            .with_prompt(prompt)
                            .default(false)
                            .interact()
                            .context(h!())?;
                    if !confirmed {
                        continue;
                    };
                } else {
                    info!("Changing master key of datasource group {} (id={}, datasource_id={}) from {} to {}", source_group.name, source_group.id, source_group.datasource_id, source_group.group_master_key, group_id);
                }

                let id = source_group.id;
                let name = source_group.name.clone();
                let mut model = source_group.clone().into_active_model();
                model.group_master_key = Set(group_id.clone());
                if let Err(e) = model.update(db).await {
                    info!("failed to update {name}(id={id}), skipping: {e:?}");
                    continue;
                }
            }
            let Some(target_group_id) = target_group_id else {
                error!("[unexpected] missing target group id, skipping...");
                continue;
            };
            if interactive {
                let confirmed = Confirm::with_theme(&ColorfulTheme::default())
                    .with_prompt(format!(
                        "Do you want to remap messages from group {} to group {}?",
                        source_group.id, target_group_id
                    ))
                    .default(false)
                    .interact()
                    .context(h!())?;
                if !confirmed {
                    continue;
                }
            } else {
                info!(
                    "Remapping messages from group {} to group {}?",
                    source_group.id, target_group_id
                );
            }
            loop {
                let messages_to_update = signal_message::Entity::find()
                    .filter(
                        signal_message::Column::DatasourceGroupId
                            .eq(source_group.id),
                    )
                    .filter(
                        signal_message::Column::CreatedAt
                            .gte(ts_cutoff.naive_utc()),
                    )
                    .select_only()
                    .column(signal_message::Column::Id)
                    .order_by_desc(signal_message::Column::CreatedAt)
                    .limit(20000)
                    .into_tuple::<i64>()
                    .all(db)
                    .await
                    .context(h!())?;
                if messages_to_update.is_empty() {
                    break;
                }
                signal_message::Entity::update_many()
                    .filter(
                        signal_message::Column::Id.is_in(messages_to_update),
                    )
                    .col_expr(
                        signal_message::Column::DatasourceGroupId,
                        Expr::value(target_group_id),
                    )
                    .exec(db)
                    .await
                    .context(h!())?;
            }
        }

        //

        let organism_groups = organism_group::Entity::find()
            .filter(
                organism_group::Column::SignalGroupMasterKey
                    .is_in(all_keys.clone()),
            )
            .all(db)
            .await
            .context(h!())?
            .into_iter()
            .map(|s| (s.signal_group_master_key.clone(), s))
            .collect::<HashMap<_, _>>();
        let from_ds = organism_groups.get(&internal_id).cloned();
        let to_ds = organism_groups.get(&group_id).cloned();
        match (from_ds, to_ds) {
            (Some(from), Some(_)) => {
                from.delete(db).await.context(h!())?;
            }
            (Some(from), None) => {
                let mut model = from.clone().into_active_model();
                model.signal_group_master_key = Set(group_id.clone());
                if let Err(e) = model.update(db).await {
                    error!(
                        "[unexpected] failed to update group {from:?}: {e:?}"
                    );
                }
            }
            _ => {}
        }

        let sigint_zone_datasources = sigint_zone_datasource::Entity::find()
            .filter(
                sigint_zone_datasource::Column::GroupMasterKey
                    .is_in(all_keys.clone()),
            )
            .all(db)
            .await
            .context(h!())?
            .into_iter()
            .map(|s| (s.group_master_key.clone(), s))
            .collect::<HashMap<_, _>>();
        let from_ds = sigint_zone_datasources.get(&internal_id).cloned();
        let to_ds = sigint_zone_datasources.get(&group_id).cloned();
        match (from_ds, to_ds) {
            (Some(from), Some(_)) => {
                from.delete(db).await.context(h!())?;
            }
            (Some(from), None) => {
                let mut model = from.into_active_model();
                model.group_master_key = Set(group_id.clone());
                if let Err(e) = model.update(db).await {
                    error!("unexpected {}: {e:?}", h!());
                }
            }
            _ => {}
        }
    }
    Ok(())
}
