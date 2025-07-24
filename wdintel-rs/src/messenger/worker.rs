use crate::config::{read_config, Config};
use crate::entities::datasource::Model;
use crate::entities::*;
use crate::error::{AppError, ContextAndError};
use crate::location::SettlementsData;
use crate::messenger::bl::list_linked_accounts;
use crate::messenger::types::EchoAccountF1;
use crate::types::Mode;
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
        error!("failed to enable verbose logging: {:?}", e);
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
            let client_name = cli.name;
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
        crate::location::load_from_file(settlement_paths).context(h!())?,
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
    let mut existing_groups = BTreeMap::new();
    let groups_raw = signal_group::Entity::find()
        .filter(signal_group::Column::MasterKey.is_in(group_master_keys))
        .all(txn)
        .await
        .cae(h!())?;
    for g in groups_raw {
        let key = g.master_key.clone();
        match existing_groups.get(&key) {
            None => {
                existing_groups.insert(key, g);
            }
            Some(g2) => {
                if g.created_at > g2.created_at {
                    existing_groups.insert(key, g);
                } else {
                    existing_groups.insert(key, g2.clone());
                }
            }
        }
    }

    for g in groups {
        match existing_groups.remove(&g.id.clone()) {
            None => match g.message_source {
                MessageSource::Signal => {
                    signal_group::ActiveModel {
                        name: Set(Some(g.name)),
                        datasource_id: NotSet,
                        created_at: NotSet,
                        ignore_operativny: NotSet,
                        master_key: Set(g.id),
                        is_secret: NotSet,
                    }
                    .insert(txn)
                    .await
                    .context(h!())?;
                }
                MessageSource::Whatsapp => {
                    whatsapp_group::ActiveModel {
                        name: Set(g.name),
                        created_at: NotSet,
                        jid: Set(g.id),
                        owner_jid: NotSet,
                    }
                    .insert(txn)
                    .await
                    .context(h!())?;
                }
            },
            Some(group_model) => {
                let name = Some(g.name);
                if group_model.name != name {
                    let mut model = group_model.into_active_model();
                    model.name = Set(name);
                    model.update(txn).await.context(h!())?;
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
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let datasources = collect_datasources(db).await.context(h!())?;
    let txn = db.begin().await.context(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .context(h!())?;
    txn.commit().await.context(h!())?;

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
                    &m,
                    &txn,
                    &datasources,
                    redis,
                    config,
                    rq,
                    settlements.clone(),
                )
                .await
                {
                    warn!("bot failed to process a message: {:?}", e);
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

async fn collect_datasources(
    db: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<MessageSource, Model>> {
    let mut all_data_sources = datasource::Entity::find()
        .all(db)
        .await
        .context(h!())?
        .into_iter()
        .map(|s| (s.kind.clone(), s))
        .collect::<BTreeMap<_, _>>();
    let mut result = BTreeMap::new();
    if let Some(source) = all_data_sources.remove("signal") {
        result.insert(MessageSource::Signal, source);
    }
    if let Some(source) = all_data_sources.remove("whatsapp") {
        result.insert(MessageSource::Whatsapp, source);
    }
    Ok(result)
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.context(h!())?;
    let live_clients = list_linked_accounts(&txn).await.context(h!())?;
    txn.commit().await.context(h!())?;
    Ok(live_clients)
}

async fn receive_once(
    m: &MessageF1,
    txn: &DatabaseTransaction,
    datasources: &BTreeMap<MessageSource, Model>,
    redis: &mut ConnectionManager,
    config: &Config,
    rq: &Client,
    settlements: Arc<RwLock<crate::location::SettlementsData>>,
) -> Result<(), AppError> {
    let datasource_id =
        datasources.get(&m.message_source).map(|m| m.id.clone());
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
        timestamp: Set(Some(m.timestamp.clone())),
        sender: Set(m.sender.clone().map(|s| s.uuid)),
        duplicate_of: Set(m_duplicate_id),
        format: NotSet,
        datasource_id: Set(datasource_id),
        deleted: NotSet,
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
