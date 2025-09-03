use crate::config::Config;
use crate::entities::*;
use crate::h;
use crate::location::SettlementsData;
use crate::sigint::worker::incoming_message_after_insert;
use anyhow::Context;
use itertools::Itertools;
use log::{debug, error, info};
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

pub async fn upsert_datasource(
    db: &DatabaseConnection,
    mut new_datasource: datasource::Model,
) -> anyhow::Result<(i64, i64)> {
    new_datasource.echo_client_lock_id = None;
    let existing_data_source = datasource::Entity::find()
        .filter(datasource::Column::Kind.eq(new_datasource.kind.clone()))
        .filter(
            datasource::Column::SignalPhone
                .eq(new_datasource.signal_phone.clone()),
        )
        .one(db)
        .await
        .context(h!())?;

    let source_datasource_id = new_datasource.id;
    let target_datasource_id = match existing_data_source {
        None => {
            let mut rec = new_datasource.into_active_model();
            rec.id = NotSet;
            rec.created_at = NotSet;
            rec.insert(db).await.context(h!())?.id
        }
        Some(existing_datasource) => {
            let mut rec = existing_datasource.into_active_model();
            let display_name = new_datasource.display_name;
            if !display_name.is_empty() {
                rec.display_name = Set(display_name);
            }
            rec.update(db).await.context(h!())?.id
        }
    };
    Ok((source_datasource_id, target_datasource_id))
}

pub async fn upsert_signal_profiles(
    db: &DatabaseConnection,
    profiles: Vec<signal_profile::Model>,
) -> anyhow::Result<()> {
    for new_profile in profiles {
        let source_profile_id = new_profile.uuid.clone();
        let existing_profile = signal_profile::Entity::find()
            .filter(signal_profile::Column::Uuid.eq(source_profile_id.clone()))
            .one(db)
            .await
            .context(h!())?;

        match existing_profile {
            None => {
                let mut rec = new_profile.into_active_model();
                rec.created_at = NotSet;
                if let Err(e) = rec.insert(db).await.context(h!()) {
                    error!("failed to insert new profile: {e:?}")
                }
            }
            Some(existing_profile) => {
                let mut rec = existing_profile.into_active_model();
                if let Some(family_name) = new_profile.family_name {
                    rec.family_name = Set(Some(family_name));
                }
                if let Some(given_name) = new_profile.given_name {
                    rec.given_name = Set(Some(given_name));
                }
                if let Err(e) = rec.update(db).await.context(h!()) {
                    error!(
                        "failed to update profile {source_profile_id} : {e:?}"
                    )
                }
            }
        };
    }
    Ok(())
}

pub async fn upsert_signal_groups(
    db: &DatabaseConnection,
    groups: Vec<signal_group::Model>,
    target_datasource_id: i64,
) -> anyhow::Result<()> {
    let group_keys = groups.iter().map(|g| g.master_key.clone()).collect_vec();
    let existing_groups = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(group_keys))
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|g| (g.master_key.clone(), g))
        .collect::<BTreeMap<_, _>>();
    for new_group in groups {
        let source_master_key = new_group.master_key.clone();
        let existing_group = existing_groups.get(&source_master_key).cloned();
        match existing_group {
            None => {
                info!("inserting group {}", new_group.master_key);
                let mut rec = new_group.into_active_model();
                rec.created_at = NotSet;
                match crate::messenger::group::add_group(rec, db)
                    .await
                    .context(h!())
                {
                    Ok(inserted) => {
                        // ensure mapping in datasource_group
                        let _ = datasource_group::ActiveModel {
                            id: NotSet,
                            group_master_key: Set(inserted.master_key.clone()),
                            datasource_id: Set(target_datasource_id),
                            last_sync_at: NotSet,
                            created_at: NotSet,
                            name: Set(inserted.name.clone().unwrap_or_default()),
                        }
                        .insert(db)
                        .await
                        .map_err(|e| {
                            error!("failed to create datasource_group mapping: {e:?}");
                            e
                        });
                    }
                    Err(e) => {
                        error!("failed to insert new group: {e:?}")
                    }
                }
            }
            Some(existing_group) => {
                let name = existing_group.name.clone().unwrap_or_default();
                let mut rec = existing_group.into_active_model();
                if let Some(name) = new_group.name {
                    rec.name = Set(Some(name));
                }
                rec.ignore_operativny = Set(new_group.ignore_operativny);
                rec.is_secret = Set(new_group.is_secret);
                if let Err(e) = rec.update(db).await.context(h!()) {
                    error!("failed to update group {source_master_key} : {e:?}")
                }
                // ensure mapping exists after update
                let mapping_exists = datasource_group::Entity::find()
                    .filter(
                        datasource_group::Column::GroupMasterKey
                            .eq(source_master_key.clone()),
                    )
                    .filter(
                        datasource_group::Column::DatasourceId
                            .eq(target_datasource_id),
                    )
                    .count(db)
                    .await
                    .context(h!())
                    .unwrap_or(0)
                    > 0;
                if !mapping_exists {
                    let _ = datasource_group::ActiveModel {
                        id: NotSet,
                        group_master_key: Set(source_master_key.clone()),
                        datasource_id: Set(target_datasource_id),
                        last_sync_at: NotSet,
                        created_at: NotSet,
                        name: Set(name),
                    }
                    .insert(db)
                    .await
                    .map_err(|e| {
                        error!(
                            "failed to create datasource_group mapping: {e:?}"
                        );
                        e
                    });
                }
            }
        }
    }
    Ok(())
}

pub async fn upsert_whatsapp_groups(
    db: &DatabaseConnection,
    groups: Vec<whatsapp_group::Model>,
) -> anyhow::Result<()> {
    let mut result = BTreeMap::new();
    for new_group in groups {
        let source_group_id = new_group.jid.clone();
        let existing_group = whatsapp_group::Entity::find()
            .filter(whatsapp_group::Column::Deleted.eq(false))
            .filter(whatsapp_group::Column::Jid.eq(source_group_id.clone()))
            .one(db)
            .await
            .context(h!())?;

        let target_group_id = match existing_group {
            None => {
                let mut rec = new_group.into_active_model();
                rec.created_at = NotSet;
                rec.insert(db).await.context(h!())?.jid
            }
            Some(existing_group) => {
                let mut rec = existing_group.into_active_model();
                rec.owner_jid = Set(new_group.owner_jid);
                rec.name = Set(new_group.name);
                rec.update(db).await.context(h!())?.jid
            }
        };
        result.insert(source_group_id, target_group_id);
    }
    Ok(())
}

pub async fn upsert_messages(
    db: &DatabaseConnection,
    messages: Vec<super::types::Message>,
    datasource_groups: Vec<datasource_group::Model>,
    datasource_mapping: (i64, i64),
    settlements: Arc<RwLock<SettlementsData>>,
    config: Config,
    redis: ConnectionManager,
    rq: Client,
) -> anyhow::Result<()> {
    let datasource_groups = datasource_groups
        .into_iter()
        .map(|g| (g.id, (g.group_master_key, g.datasource_id)))
        .collect::<HashMap<_, _>>();
    let (source_datasource_id, target_datasource_id) = datasource_mapping;
    let mut progress: f64 = 0.0;
    let mut processed = 0;
    let total_messages = messages.len() as f64;
    let mut messages = messages;
    messages.sort_by_key(|m| m.message.created_at);
    let message_chunks = messages.chunks(10000);
    let mut redis = redis;
    let mut message_ids_map = BTreeMap::new();
    let mut new_messages_counter = 0;
    for messages in message_chunks.into_iter() {
        let message_ids = messages.iter().map(|x| x.message.id).collect_vec();
        let existing_messages = signal_message::Entity::find()
            .filter(signal_message::Column::ExternalId.is_in(message_ids))
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::DatasourceGroup.def(),
            )
            .filter(
                datasource_group::Column::DatasourceId.eq(target_datasource_id),
            )
            .all(db)
            .await
            .context(h!())?
            .into_iter()
            .flat_map(|m| m.external_id.map(|id| (id, m)))
            .collect::<BTreeMap<_, _>>();
        for entry in messages {
            let current_progress = processed as f64 * 100.0 / total_messages;
            if current_progress - progress > 0.1 {
                info!("upsert_messages progress: {progress:.1}%");
                progress = current_progress;
            }
            processed += 1;
            let source_message_id = entry.message.id;
            if existing_messages.contains_key(&source_message_id) {
                debug!("message {source_message_id} already exists");
                continue;
            }
            let new_message = entry.message.clone();
            let m_created_at =
                match (&entry.inbox_item.date, &entry.inbox_item.time) {
                    (Some(d), Some(t)) => Some((d.clone(), t.clone())),
                    _ => None,
                };
            let duplicate_of = match new_message.duplicate_of {
                None => None,
                Some(id) => message_ids_map.get(&id).cloned(),
            };

            let txn = db.begin().await.context(h!())?;

            let datasource_group_id = if let Some(group_id) = new_message.datasource_group_id {
                let (master_key, datasource_id) =
                    datasource_groups.get(&group_id).context(h!())?;
                if !source_datasource_id.eq(datasource_id) {
                    error!("bad message occurred (id={source_message_id}): expected datasource {source_datasource_id}, actual datasource {datasource_id}. skipping...");
                    continue;
                }
                let datasource_group_id = crate::messenger::group::ensure_datasource_group_id(
                    &txn,
                    master_key.to_string(),
                    target_datasource_id,
                )
                .await
                .context(h!())?;
                Some(datasource_group_id)
            } else {
                None
            };

            let mut rec = new_message.into_active_model();
            rec.id = NotSet;
            rec.datasource_group_id = Set(datasource_group_id);
            rec.duplicate_of = Set(duplicate_of);
            rec.external_id = Set(Some(source_message_id));
            let new_id = rec.insert(db).await.context(h!())?.id;
            message_ids_map.insert(source_message_id, new_id);
            new_messages_counter += 1;

            crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
                settlements.clone(),
                &txn,
                &rq,
                &config,
                &mut redis,
                new_id,
                m_created_at,
            )
            .await;
            incoming_message_after_insert(&txn, new_id)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
        }
    }
    info!("inserted {new_messages_counter} new messages");
    Ok(())
}
