use crate::config::Config;
use crate::entities::*;
use crate::h;
use crate::location::SettlementsData;
use crate::sigint::worker::incoming_message_after_insert;
use anyhow::Context;
use itertools::Itertools;
use log::{debug, info};
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

pub async fn upsert_datasource(
    db: &DatabaseConnection,
    new_datasource: datasource::Model,
) -> anyhow::Result<(i64, i64)> {
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
            rec.display_name = Set(new_datasource.display_name);
            rec.update(db).await.context(h!())?.id
        }
    };
    Ok((source_datasource_id, target_datasource_id))
}

pub async fn upsert_signal_profiles(
    db: &DatabaseConnection,
    profiles: Vec<signal_profile::Model>,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for new_profile in profiles {
        let source_profile_id = new_profile.uuid.clone();
        let existing_profile = signal_profile::Entity::find()
            .filter(signal_profile::Column::Uuid.eq(source_profile_id.clone()))
            .one(db)
            .await
            .context(h!())?;

        let target_profile_id = match existing_profile {
            None => {
                let mut rec = new_profile.into_active_model();
                rec.created_at = NotSet;
                rec.insert(db).await.context(h!())?.uuid
            }
            Some(existing_profile) => {
                let mut rec = existing_profile.into_active_model();
                rec.family_name = Set(new_profile.family_name);
                rec.given_name = Set(new_profile.given_name);
                rec.update(db).await.context(h!())?.uuid
            }
        };
        result.insert(source_profile_id, target_profile_id);
    }
    Ok(result)
}

pub async fn upsert_signal_groups(
    db: &DatabaseConnection,
    groups: Vec<signal_group::Model>,
    datasource_mapping: (i64, i64),
) -> anyhow::Result<()> {
    let (_, target_datasource_id) = datasource_mapping;
    let mut result = BTreeMap::new();
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
        let source_group_id = new_group.master_key.clone();
        let target_group_id =
            match existing_groups.get(&source_group_id).cloned() {
                None => {
                    info!("inserting group {}", new_group.master_key);
                    let mut rec = new_group.into_active_model();
                    rec.datasource_id = Set(Some(target_datasource_id));
                    rec.created_at = NotSet;
                    rec.insert(db).await.context(h!())?.master_key
                }
                Some(existing_group) => {
                    let mut rec = existing_group.into_active_model();
                    rec.ignore_operativny = Set(new_group.ignore_operativny);
                    rec.name = Set(new_group.name);
                    rec.is_secret = Set(new_group.is_secret);
                    rec.datasource_id = Set(Some(target_datasource_id));
                    rec.update(db).await.context(h!())?.master_key
                }
            };
        result.insert(source_group_id, target_group_id);
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
    datasource_mapping: (i64, i64),
    signal_profiles_map: BTreeMap<String, String>,
    settlements: Arc<RwLock<SettlementsData>>,
    config: Config,
    redis: ConnectionManager,
    rq: Client,
) -> anyhow::Result<()> {
    let (_, target_datasource_id) = datasource_mapping;
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
            .filter(
                signal_message::Column::DatasourceId.eq(target_datasource_id),
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
                info!("upsert_messages progress: {:.1}%", progress);
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
            let sender = match &new_message.sender {
                None => None,
                Some(id) => signal_profiles_map.get(id).cloned(),
            };
            let duplicate_of = match new_message.duplicate_of {
                None => None,
                Some(id) => message_ids_map.get(&id).cloned(),
            };

            let mut rec = new_message.into_active_model();
            rec.id = NotSet;
            rec.datasource_id = Set(Some(target_datasource_id));
            rec.sender = Set(sender);
            rec.duplicate_of = Set(duplicate_of);
            rec.external_id = Set(Some(source_message_id));
            let new_id = rec.insert(db).await.context(h!())?.id;
            message_ids_map.insert(source_message_id, new_id);
            new_messages_counter += 1;

            let txn = db.begin().await.context(h!())?;
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
