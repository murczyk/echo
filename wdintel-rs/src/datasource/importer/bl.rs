use crate::config::Config;
use crate::entities::*;
use crate::location::SettlementsDataConfig;
use crate::sigint::worker::incoming_message_after_insert;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;

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
                    error!("failed to insert new profile: {:?}", e)
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
                        "failed to update profile {source_profile_id} : {:?}",
                        e
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
        .filter(signal_group::Column::MasterKey.eq_any(group_keys))
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
                            deleted: NotSet,
                        }
                        .insert(db)
                        .await
                        .map_err(|e| {
                            error!("failed to create datasource_group mapping: {:?}", e);
                            e
                        });
                    }
                    Err(e) => {
                        error!("failed to insert new group: {:?}", e)
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
                if new_group.is_secret {
                    rec.is_secret = Set(true);
                }
                if let Err(e) = rec.update(db).await.context(h!()) {
                    error!(
                        "failed to update group {source_master_key} : {:?}",
                        e
                    )
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
                        deleted: NotSet,
                    }
                    .insert(db)
                    .await
                    .map_err(|e| {
                        error!(
                            "failed to create datasource_group mapping: {:?}",
                            e
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MessageGroupKey {
    group_master_key: Option<String>,
    sender: Option<String>,
    message_uid: Option<String>,
    datasource_group_id: Option<i64>,
    created_at: NaiveDateTime,
}

impl MessageGroupKey {
    fn from_model(model: &signal_message_group::Model) -> Self {
        Self {
            group_master_key: model.group_master_key.clone(),
            sender: model.sender.clone(),
            message_uid: model.message_uid.clone(),
            datasource_group_id: model.datasource_group_id,
            created_at: model.created_at,
        }
    }
}

async fn insert_missing_message_groups<'a, 'async_trait, C>(
    txn: &'a C,
    source_message_id: i64,
    target_message_id: i64,
    message_groups: &[signal_message_group::Model],
    source_datasource_id: i64,
    target_datasource_id: i64,
    datasource_groups: &HashMap<i64, (String, i64)>,
    existing_group_keys: &mut HashSet<MessageGroupKey>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    for group_entry in message_groups.iter() {
        let master_key = group_entry.group_master_key.clone().or_else(|| {
            group_entry.datasource_group_id.and_then(|gid| {
                datasource_groups.get(&gid).map(|(key, _)| key.clone())
            })
        });

        let target_group_id = match group_entry.datasource_group_id {
            Some(group_id) => {
                if let Some((key, datasource_id)) =
                    datasource_groups.get(&group_id)
                {
                    if !source_datasource_id.eq(datasource_id) {
                        error!("bad message occurred (id={source_message_id}): expected datasource {source_datasource_id}, actual datasource {datasource_id}. skipping...");
                        continue;
                    }
                    Some(
                        crate::messenger::group::ensure_datasource_group_id(
                            txn,
                            key.clone(),
                            target_datasource_id,
                        )
                        .await
                        .context(h!())?,
                    )
                } else if let Some(ref key) = master_key {
                    Some(
                        crate::messenger::group::ensure_datasource_group_id(
                            txn,
                            key.clone(),
                            target_datasource_id,
                        )
                        .await
                        .context(h!())?,
                    )
                } else {
                    None
                }
            }
            None => {
                if let Some(ref key) = master_key {
                    Some(
                        crate::messenger::group::ensure_datasource_group_id(
                            txn,
                            key.clone(),
                            target_datasource_id,
                        )
                        .await
                        .context(h!())?,
                    )
                } else {
                    None
                }
            }
        };

        let new_key = MessageGroupKey {
            group_master_key: master_key.clone(),
            sender: group_entry.sender.clone(),
            message_uid: group_entry.message_uid.clone(),
            datasource_group_id: target_group_id,
            created_at: group_entry.created_at,
        };

        if existing_group_keys.contains(&new_key) {
            continue;
        }

        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(target_message_id),
            group_master_key: Set(master_key.clone()),
            sender: Set(group_entry.sender.clone()),
            message_uid: Set(group_entry.message_uid.clone()),
            datasource_group_id: Set(target_group_id),
            created_at: Set(group_entry.created_at),
        }
        .insert(txn)
        .await
        .context(h!())?;

        existing_group_keys.insert(new_key);
    }

    Ok(())
}

pub async fn upsert_messages(
    db: &DatabaseConnection,
    messages: Vec<super::types::Message>,
    datasource_groups: Vec<datasource_group::Model>,
    datasource_mapping: (i64, i64),
    settlements: Arc<RwLock<SettlementsDataConfig>>,
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
    let mut new_messages_counter = 0;
    for messages in message_chunks.into_iter() {
        let message_ids = messages.iter().map(|x| x.message.id).collect_vec();
        let existing_messages = load_existing_imported_messages(
            db,
            &message_ids,
            target_datasource_id,
        )
        .await
        .context(h!())?;
        let existing_message_ids =
            existing_messages.values().map(|m| m.id).collect_vec();
        let mut existing_message_groups: HashMap<
            i64,
            HashSet<MessageGroupKey>,
        > = HashMap::new();
        if !existing_message_ids.is_empty() {
            let groups = signal_message_group::Entity::find()
                .filter(
                    signal_message_group::Column::SignalMessageId
                        .eq_any(existing_message_ids.clone()),
                )
                .all(db)
                .await
                .context(h!())?;
            for group in groups {
                existing_message_groups
                    .entry(group.signal_message_id)
                    .or_default()
                    .insert(MessageGroupKey::from_model(&group));
            }
        }
        for entry in messages {
            let current_progress = processed as f64 * 100.0 / total_messages;
            if current_progress - progress > 0.1 {
                info!("upsert_messages progress: {progress:.1}%");
                progress = current_progress;
            }
            processed += 1;
            let source_message_id = entry.message.id;
            if let Some(existing_message) =
                existing_messages.get(&source_message_id)
            {
                debug!("message {source_message_id} already exists");
                let existing_message_id = existing_message.id;
                let txn = db.begin().await.context(h!())?;
                {
                    let group_keys = existing_message_groups
                        .entry(existing_message_id)
                        .or_default();
                    insert_missing_message_groups(
                        &txn,
                        source_message_id,
                        existing_message_id,
                        &entry.message_groups,
                        source_datasource_id,
                        target_datasource_id,
                        &datasource_groups,
                        group_keys,
                    )
                    .await?;
                }
                txn.commit().await.context(h!())?;
                continue;
            }
            let new_message = entry.message.clone();
            let m_created_at =
                match (&entry.inbox_item.date, &entry.inbox_item.time) {
                    (Some(d), Some(t)) => Some((d.clone(), t.clone())),
                    _ => None,
                };
            let txn = db.begin().await.context(h!())?;

            let datasource_group_id = if let Some(group_id) =
                new_message.datasource_group_id
            {
                let (master_key, datasource_id) =
                    datasource_groups.get(&group_id).context(h!())?;
                if !source_datasource_id.eq(datasource_id) {
                    error!("bad message occurred (id={source_message_id}): expected datasource {source_datasource_id}, actual datasource {datasource_id}. skipping...");
                    continue;
                }
                let datasource_group_id =
                    crate::messenger::group::ensure_datasource_group_id(
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
            rec.external_id = Set(Some(source_message_id));
            rec.echo_inbox_message_id = Set(None);
            let inserted = rec.insert(&txn).await.context(h!())?;
            let new_id = inserted.id;
            new_messages_counter += 1;

            let mut inserted_group_keys = HashSet::new();
            insert_missing_message_groups(
                &txn,
                source_message_id,
                new_id,
                &entry.message_groups,
                source_datasource_id,
                target_datasource_id,
                &datasource_groups,
                &mut inserted_group_keys,
            )
            .await?;

            let changed_inbox_item_ids =
                crate::rer_importer::bgworker::process_message_to_inbox_nofail(
                    settlements.clone(),
                    &txn,
                    &rq,
                    &config,
                    new_id,
                    m_created_at,
                )
                .await;
            incoming_message_after_insert(&txn, new_id)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
            crate::inbox::fanout_inbox_changes(
                &mut redis,
                changed_inbox_item_ids,
            )
            .await
            .context(h!())?;
        }
    }
    info!("inserted {new_messages_counter} new messages");
    Ok(())
}

async fn load_existing_imported_messages(
    db: &DatabaseConnection,
    message_ids: &[i64],
    target_datasource_id: i64,
) -> anyhow::Result<BTreeMap<i64, signal_message::Model>> {
    Ok(signal_message::Entity::find()
        .filter(signal_message::Column::ExternalId.eq_any(message_ids.to_vec()))
        .filter(signal_message::Column::EchoInboxMessageId.is_null())
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(datasource_group::Column::DatasourceId.eq(target_datasource_id))
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .flat_map(|message| message.external_id.map(|id| (id, message)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup, mk_datasource, mk_datasource_group, mk_login, mk_organism,
        mk_signal_group, mk_signal_message,
    };
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn existing_imported_messages_ignore_echo_inbox_traces() {
        let env = cleanup().await.unwrap();
        let datasource = mk_datasource(
            &env.dbx,
            datasource::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(datasource_group.id)),
                external_id: Set(Some(42)),
                echo_inbox_message_id: Set(Some(42)),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let existing =
            load_existing_imported_messages(&env.dbx, &[42], datasource.id)
                .await
                .unwrap();

        assert!(existing.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn importing_existing_group_preserves_secret_access() {
        let env = cleanup().await.unwrap();
        let datasource = mk_datasource(
            &env.dbx,
            datasource::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource.id)),
                is_secret: Set(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("import-secret-user".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let organism = mk_organism(
            &env.dbx,
            organism::ActiveModel {
                name: Set("import-secret-organism".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();
        crate::sigint::zone::bl::update_signal_group_access_and_admins(
            vec![login.id.to_string()],
            vec![organism.id],
            vec![],
            true,
            &group.master_key,
            &txn,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let access = secret_group_access(&env.dbx, &group.master_key).await;
        let mut imported_group = group.clone();
        imported_group.is_secret = false;

        upsert_signal_groups(&env.dbx, vec![imported_group], datasource.id)
            .await
            .unwrap();

        assert_eq!(
            secret_group_access(&env.dbx, &group.master_key).await,
            access
        );
    }

    async fn secret_group_access(
        db: &DatabaseConnection,
        master_key: &str,
    ) -> (bool, Vec<String>, Vec<i64>) {
        let group = signal_group::Entity::find_by_id(master_key.to_string())
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let users = crate::sigint::zone::bl::collect_direct_secret_group_users(
            vec![master_key.to_string()],
            db,
        )
        .await
        .unwrap()
        .remove(master_key)
        .unwrap_or_default();
        let organisms =
            crate::sigint::zone::bl::collect_secret_group_organism_ids(
                vec![master_key.to_string()],
                db,
            )
            .await
            .unwrap()
            .remove(master_key)
            .unwrap_or_default();
        (group.is_secret, users, organisms)
    }
}
