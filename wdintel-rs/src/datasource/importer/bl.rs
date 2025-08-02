use crate::config::Config;
use crate::entities::*;
use crate::h;
use crate::location::SettlementsData;
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
                rec.uuid = NotSet;
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
    for new_group in groups {
        let source_group_id = new_group.master_key.clone();
        let existing_group = signal_group::Entity::find()
            .filter(signal_group::Column::MasterKey.eq(source_group_id.clone()))
            .filter(signal_group::Column::DatasourceId.eq(target_datasource_id))
            .one(db)
            .await
            .context(h!())?;

        let target_group_id = match existing_group {
            None => {
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
            let source_message_id = entry.message.id;
            if existing_messages.contains_key(&source_message_id) {
                debug!("message {source_message_id} already exists");
                continue;
            }
            let new_message = entry.message.clone();
            let created_at = entry.inbox_item.datetime.clone();
            let current_progress = processed as f64 * 100.0 / total_messages;
            if progress < current_progress {
                info!("upsert_messages progress: {}%", progress);
                progress += 1.0;
            }
            processed += 1;
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
            let new_id = rec.insert(db).await.context(h!())?.id;
            message_ids_map.insert(source_message_id, new_id);

            let txn = db.begin().await.context(h!())?;
            crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
                settlements.clone(),
                &txn,
                &rq,
                &config,
                &mut redis,
                new_id,
                created_at,
            )
            .await;
            txn.commit().await.context(h!())?;
        }
    }
    Ok(())
}
