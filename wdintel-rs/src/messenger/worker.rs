use crate::config::{read_config, Config};
use crate::entities::*;
use crate::error::{AppError, ContextAndError};
use crate::location::SettlementsData;
use crate::messenger::bl::list_accounts;
use crate::messenger::types::EchoAccountF1;
use crate::types::*;
use crate::{h, new_redis};
use anyhow::Context;
use chrono::*;
use echo_im::types::{MessageF1, MessageSource};
use log::*;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

pub async fn receive_thread_nofail(mode: Mode) {
    let (config, settlements, rq, mut redis, dbx) =
        setup_worker(mode).await.unwrap();
    info!("started receive_thread_nofail");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&dbx).await
    {
        error!("failed to enable verbose logging: {e:?}");
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    loop {
        let clients = match list_clients(&dbx).await {
            Ok(txn) => txn,
            Err(e) => {
                error!("failed to load clients: {e:?}");
                continue;
            }
        };
        for cli in clients {
            let Some(client_name) = cli.system_service_name else {
                continue;
            };
            if let Err(e) = receive_thread(
                &client_name,
                &mut client_groups_sync_ts_map,
                &dbx,
                &mut redis,
                &config,
                &rq,
                settlements.clone(),
            )
            .await
            {
                println!("> {client_name}::receive_thread_nofail error: {e:?}");
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    }
}

async fn setup_worker(
    mode: Mode,
) -> anyhow::Result<(
    Config,
    Arc<RwLock<SettlementsData>>,
    Client,
    ConnectionManager,
    DatabaseConnection,
)> {
    let config = read_config(mode).context(h!())?;
    let db = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let settlement_paths = config.settlement_paths().context(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_from_file(settlement_paths, mode)
            .context(h!())?,
    ));
    let rq = Client::builder()
        .timeout(core::time::Duration::from_secs(crate::config::RQ_TIMEOUT))
        .build()
        .context(h!())?;
    let redis = new_redis(&config).await.context(h!())?;
    Ok((config, settlements, rq, redis, db))
}

async fn receive_thread(
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    config: &Config,
    rq: &Client,
    settlements: Arc<RwLock<SettlementsData>>,
) -> Result<(), AppError> {
    echo_im::worker::signal_worker_tick_once(client_name, dbx)
        .await
        .context(h!())?;
    echo_im::worker::whatsapp_worker_tick_once(client_name, dbx)
        .await
        .context(h!())?;
    if !config.read_from_legacy_data_sources.unwrap_or(true) {
        let txn = dbx.begin().await.context(h!())?;
        sync_groups(&txn, client_name, client_groups_sync_ts_map)
            .await
            .context(h!())?;
        txn.commit().await.context(h!())?;
    }
    sync_inbox(Utc::now(), dbx, client_name, redis, config, rq, settlements)
        .await
        .context(h!())?;
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    Ok(())
}

async fn sync_groups(
    txn: &DatabaseTransaction,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
) -> anyhow::Result<()> {
    let datasource = load_client_datasource(txn, client_name)
        .await
        .context(h!())?;
    let now = Utc::now().naive_utc();
    if let Some(last_updated_ts) =
        client_groups_sync_ts_map.get(client_name).cloned()
    {
        let stale_at = last_updated_ts + chrono::TimeDelta::minutes(2);
        if now <= stale_at {
            return Ok(()); // already in sync
        }
    }
    let unsorted_groups =
        echo_im::list_groups(client_name, txn).await.context(h!())?;
    let mut groups = vec![];
    let mut deleted_groups = vec![];
    for g in unsorted_groups {
        if g.deleted_by_messenger {
            deleted_groups.push(g);
        } else {
            groups.push(g);
        }
    }
    let group_master_keys =
        groups.iter().map(|x| x.id.clone()).collect::<Vec<_>>();
    let mut existing_groups: BTreeMap<(String, i64), GroupData> =
        BTreeMap::new();

    #[derive(Clone)]
    struct GroupData {
        id: String,
        name: Option<String>,
        created_at: NaiveDateTime,
        model_a: Option<signal_group::Model>,
        model_b: Option<whatsapp_group::Model>,
        datasource_id: i64,
    }

    let mut groups_raw = vec![];
    signal_group::Entity::find()
        .filter(
            signal_group::Column::MasterKey.is_in(group_master_keys.clone()),
        )
        .all(txn)
        .await
        .cae(h!())?
        .into_iter()
        .for_each(|g| {
            groups_raw.push(GroupData {
                model_a: Some(g.clone()),
                model_b: None,
                id: g.master_key,
                name: g.name,
                created_at: g.created_at,
                datasource_id: datasource.id,
            })
        });
    whatsapp_group::Entity::find()
        .filter(whatsapp_group::Column::Jid.is_in(group_master_keys))
        .all(txn)
        .await
        .cae(h!())?
        .into_iter()
        .for_each(|g| {
            groups_raw.push(GroupData {
                model_a: None,
                model_b: Some(g.clone()),
                id: g.jid,
                name: Some(g.name),
                created_at: g.created_at,
                datasource_id: datasource.id,
            })
        });
    for g in groups_raw {
        let key = (g.id.clone(), g.datasource_id);
        match existing_groups.get(&key) {
            None => {
                existing_groups.insert(key, g);
            }
            Some(g2) => {
                if g.created_at > g2.created_at {
                    existing_groups.insert(key, g.clone());
                } else {
                    existing_groups.insert(key, g2.clone());
                }
            }
        }
    }

    for g in groups {
        let group_id = g.id.clone();
        match existing_groups.get(&(group_id.clone(), datasource.id)) {
            None => {
                let model = signal_group::ActiveModel {
                    name: Set(Some(g.name.clone())),
                    datasource_id: Set(Some(datasource.id)),
                    created_at: NotSet,
                    ignore_operativny: NotSet,
                    master_key: Set(group_id.clone()),
                    is_secret: NotSet,
                };
                crate::messenger::group::add_group(model, txn)
                    .await
                    .context(h!())?;
                if g.message_source.eq(&MessageSource::Whatsapp) {
                    whatsapp_group::ActiveModel {
                        name: Set(g.name.clone()),
                        created_at: NotSet,
                        jid: Set(group_id.clone()),
                        owner_jid: NotSet,
                    }
                    .insert(txn)
                    .await
                    .context(h!())?;
                }
            }
            Some(group_model) => {
                let datasource_id = group_model.datasource_id;
                let name = Some(g.name.clone());
                if group_model.name != name
                    || group_model.datasource_id != datasource_id
                {
                    if let Some(ref model) = group_model.model_a {
                        let mut model = model.clone().into_active_model();
                        model.name = Set(name);
                        model.datasource_id = Set(Some(datasource_id));
                        model.update(txn).await.context(h!())?;
                    } else {
                        let mut model = group_model
                            .model_b
                            .clone()
                            .context(h!())?
                            .into_active_model();
                        model.name = Set(g.name.clone());
                        model.update(txn).await.context(h!())?;
                    }
                }
            }
        }
    }

    let mut signal_ids_to_delete = vec![];
    let mut whatsapp_ids_to_delete = vec![];
    for g in deleted_groups {
        if !g.id.is_empty() {
            signal_ids_to_delete.push(g.id.clone());
            if g.message_source == MessageSource::Whatsapp {
                whatsapp_ids_to_delete.push(g.id);
            }
        }
    }
    if !signal_ids_to_delete.is_empty() {
        signal_group::Entity::delete_many()
            .filter(signal_group::Column::MasterKey.is_in(signal_ids_to_delete))
            .exec(txn)
            .await
            .context(h!())?;
    }
    if !whatsapp_ids_to_delete.is_empty() {
        whatsapp_group::Entity::delete_many()
            .filter(whatsapp_group::Column::Jid.is_in(whatsapp_ids_to_delete))
            .exec(txn)
            .await
            .context(h!())?;
    }
    client_groups_sync_ts_map.insert(client_name.to_string(), now);
    Ok(())
}
async fn sync_inbox(
    inbox_sync_at: DateTime<Utc>,
    db: &DatabaseConnection,
    client_name: &str,
    redis: &mut ConnectionManager,
    config: &Config,
    rq: &Client,
    settlements: Arc<RwLock<SettlementsData>>,
) -> anyhow::Result<()> {
    debug!("syncing inbox for client_name={client_name}");
    let datasource = load_client_datasource(db, client_name)
        .await
        .context(h!())?;
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.context(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .context(h!())?;
    txn.commit().await.context(h!())?;

    sync_senders(db, &inbox_messages).await.context(h!())?;

    for (i, m) in inbox_messages.iter().enumerate() {
        {
            debug!(
                "processing inbox message {} of {}; m.id={}",
                i + 1,
                inbox_messages.len(),
                m.id.clone().unwrap_or("".to_string())
            );
            let txn = db.begin().await.context(h!())?;
            debug!(
                "process_inbox_message_nofail client_name={}; message_id={}",
                client_name,
                m.id.clone().unwrap_or("".to_string())
            );
            // let current_time = Utc::now().naive_utc();
            // if m.timestamp < current_time - TimeDelta::minutes(15) {
            //     warn!(
            //         "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
            //         client_name, m.timestamp, current_time, m.internal_id, m.text
            //     );
            //     return;
            // }
            if !config.read_from_legacy_data_sources.unwrap_or(true) {
                if let Err(e) = receive_once(
                    m,
                    &txn,
                    &datasource,
                    redis,
                    config,
                    rq,
                    settlements.clone(),
                )
                .await
                {
                    warn!("bot failed to process a message: {e:?}");
                }
            }
            echo_im::mark_inbox_as_seen(client_name, vec![m.internal_id], &txn)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
        }
    }
    Ok(())
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.context(h!())?;
    let live_clients = list_accounts(None, &txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(live_clients)
}

async fn receive_once(
    m: &MessageF1,
    txn: &DatabaseTransaction,
    datasource: &datasource::Model,
    redis: &mut ConnectionManager,
    config: &Config,
    rq: &Client,
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
) -> Result<(), AppError> {
    if m.group_id.is_none() {
        warn!("skipping message {:?} with no group, possibly a private message: {}", m.id, m.text);
        return Ok(());
    }
    let body = m.text.clone();
    // Normalize body
    let body = body.replace("\r\n", "\n");
    let m_duplicate = crate::sigint::find_duplicate(txn, &body)
        .await
        .context(h!())?;
    let m_duplicate_id = m_duplicate.as_ref().map(|x| x.id);
    let signal_message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body.clone())),
        created_at: NotSet,
        group_master_key: Set(m.group_id.clone()),
        timestamp: Set(Some(m.timestamp)),
        sender: Set(m.sender.clone().map(|s| s.uuid)),
        duplicate_of: Set(m_duplicate_id),
        format: NotSet,
        datasource_id: Set(Some(datasource.id)),
        deleted: NotSet,
        external_id: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?;

    for a in &m.attachments {
        let _signal_attachment = signal_attachment::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message.id),
            path: Set(a.path.clone()),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }

    crate::rer_importer::bgworker::inbox_item_oneoff_nofail(
        settlements.clone(),
        txn,
        rq,
        config,
        redis,
        signal_message.id,
        None,
    )
    .await;

    crate::sigint::worker::incoming_message_after_insert(
        txn,
        signal_message.id,
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn load_client_datasource<'a, 'async_trait, C>(
    txn: &'a C,
    client_name: &str,
) -> anyhow::Result<datasource::Model>
where
    C: ConnectionTrait + 'async_trait,
{
    datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            datasource::Relation::EchoClientLock.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .filter(echo_client::Column::Name.eq(client_name))
        .one(txn)
        .await
        .context(h!())?
        .context(h!())
}

async fn sync_senders(
    db: &DatabaseConnection,
    inbox_messages: &[MessageF1],
) -> anyhow::Result<()> {
    let mut senders = inbox_messages
        .iter()
        .flat_map(|m| m.sender.clone())
        .map(|s| (s.uuid.clone(), s))
        .collect::<BTreeMap<_, _>>();
    let sender_ids = senders.keys().cloned().collect::<Vec<_>>();
    let existing_senders = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.is_in(sender_ids))
        .select_only()
        .column(signal_profile::Column::Uuid)
        .into_tuple::<String>()
        .all(db)
        .await
        .context(h!())?;
    for s in existing_senders {
        senders.remove(&s);
    }
    for (uuid, s) in senders {
        signal_profile::ActiveModel {
            uuid: Set(uuid),
            given_name: Set(s.name.clone()),
            family_name: NotSet,
            created_at: NotSet,
        }
        .insert(db)
        .await
        .context(h!())?;
    }
    Ok(())
}
