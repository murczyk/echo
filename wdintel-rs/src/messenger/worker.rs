use crate::config::{read_config, Config};
use crate::entities::sea_orm_active_enums::EchoMessageSource;
use crate::entities::*;
use crate::error::{AppError, ContextAndError};
use crate::h;
use crate::location::SettlementsData;
use crate::messenger::bl::list_accounts;
use crate::messenger::id;
use crate::messenger::types::{EchoAccountF1, Message};
use crate::types::*;
use crate::utils::worker_watch;
use chrono::*;
use echo_im::types::{MessageF1, MessageSource};
use echo_migration::Expr;
use log::*;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use tokio::time::{sleep, Duration};

pub async fn receive_thread_nofail(mode: Mode) {
    let config = match read_config(mode) {
        Ok(config) => config,
        Err(e) => {
            error!("failed to load config: {e:?}");
            return;
        }
    };
    let dbx = match crate::new_pg_pool_from_config(&config).await {
        Ok(db) => db,
        Err(e) => {
            error!("failed to connect to db: {e:?}");
            return;
        }
    };
    info!("started receive_thread_nofail");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&dbx).await
    {
        error!("failed to enable verbose logging: {e:?}");
    };
    let mut poison_datasources = HashSet::new();
    let mut workers_state = HashMap::<String, Vec<NaiveDateTime>>::new();
    loop {
        let now = Utc::now().naive_utc();
        let _loop_guard = worker_watch::loop_guard("messenger_receive_worker");
        let clients = match list_clients(&dbx).await {
            Ok(x) => x,
            Err(e) => {
                error!("failed to load clients: {e:?}");
                sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if clients.is_empty() {
            sleep(Duration::from_secs(1)).await;
            continue;
        }
        let client_names = clients
            .iter()
            .map(|c| c.display_name.clone())
            .collect_vec()
            .join(", ");
        trace!("[{}] updating clients: {client_names}", h!());
        let mut updated_worker_state = HashMap::new();
        for cli in clients {
            let Some(client_name) = cli.system_service_name.clone() else {
                trace!("client name is missing, skipping: {cli:?}");
                continue;
            };
            let ts_now = now.format("%Y%m%d_%H:%M:%S").to_string();
            let worker_name = format!(
                "messenger_receive_worker_{}_{client_name}-{ts_now}",
                cli.id
            );
            let client_id = cli.id;

            let Some(mut state) = workers_state.remove(&worker_name) else {
                if let Err(e) =
                    spawn_new_worker(cli.clone(), mode, worker_name.clone())
                        .await
                {
                    error!("failed to spawn worker for {client_name} (id {client_id}): {e:?}");
                }
                updated_worker_state.insert(client_name, vec![now]);
                continue;
            };
            let source_is_outdated = is_datasource_outdated(&dbx, cli.id).await;
            if !source_is_outdated {
                updated_worker_state.insert(client_name, state);
                continue;
            }
            let poison_ds_cutoff = now - TimeDelta::minutes(60);
            let is_poison_datasource =
                state.iter().filter(|ts| poison_ds_cutoff.gt(ts)).count() > 3;
            if is_poison_datasource {
                error!("datasource {client_name} (id {client_id}) is poisonous, won't make any attempts to retry");
                poison_datasources.insert(client_id);
            } else {
                warn!("datasource {client_name} (id {client_id}) is stale, restarting...");
                state.push(now);
                updated_worker_state.insert(client_name, state);
            }
        }
        workers_state = updated_worker_state;
    }
}

async fn spawn_new_worker(
    cli: EchoAccountF1,
    mode: Mode,
    worker_name: String,
) -> anyhow::Result<()> {
    tokio::spawn(async move {
        let context = match crate::utils::setup_worker(mode).await {
            Ok(c) => c,
            Err(e) => {
                error!("failed to spawn worker {worker_name}: {e:?}");
                return;
            }
        };
        let (config, settlements, rq, mut redis, dbx) = context;
        loop {
            let is_healthy = sync_client_once(
                cli.clone(),
                &config,
                settlements.clone(),
                &rq,
                &mut redis,
                &dbx,
            )
            .await;
            if !is_healthy {
                error!("worker thread {worker_name} is not healthy, killing...")
            }
        }
    });
    Ok(())
}

async fn sync_client_once(
    cli: EchoAccountF1,
    config: &Config,
    settlements: Arc<RwLock<SettlementsData>>,
    rq: &Client,
    redis: &mut ConnectionManager,
    dbx: &DatabaseConnection,
) -> bool {
    let Some(client_name) = cli.system_service_name else {
        trace!("client name is missing, skipping: {cli:?}");
        return false;
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    if let Err(e) = receive_thread(
        &client_name,
        &mut client_groups_sync_ts_map,
        dbx,
        redis,
        config,
        rq,
        settlements.clone(),
    )
    .await
    {
        println!("> {client_name}::receive_thread_nofail error: {e:?}");
    }
    !is_datasource_outdated(dbx, cli.id).await
}

async fn is_datasource_outdated(dbx: &DatabaseConnection, id: i64) -> bool {
    let cutoff_ts = Utc::now().naive_utc() - TimeDelta::minutes(5);
    datasource::Entity::find_by_id(id)
        .one(dbx)
        .await
        .ok()
        .flatten()
        .and_then(|entity| entity.last_sync_at)
        .filter(|last_sync_at| *last_sync_at > cutoff_ts)
        .is_none()
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
    let datasource = load_client_datasource(dbx, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("datasource {datasource_id} is not linked, skipping");
        return Ok(());
    }
    echo_im::worker::signal_worker_tick_once(client_name, dbx)
        .await
        .c(h!())?;
    echo_im::worker::whatsapp_worker_tick_once(client_name, dbx)
        .await
        .c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    sync_groups(&txn, client_name, client_groups_sync_ts_map)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    sync_inbox(Utc::now(), dbx, client_name, redis, config, rq, settlements)
        .await
        .c(h!())?;

    let mut model = datasource.into_active_model();
    model.last_sync_at = Set(Some(Utc::now().naive_utc()));
    model.update(dbx).await.c(h!())?;

    Ok(())
}

async fn sync_groups(
    txn: &DatabaseTransaction,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
) -> anyhow::Result<()> {
    let datasource = load_client_datasource(txn, client_name).await.c(h!())?;
    let now = Utc::now().naive_utc();
    if let Some(last_updated_ts) =
        client_groups_sync_ts_map.get(client_name).cloned()
    {
        let stale_at = last_updated_ts + TimeDelta::minutes(2);
        if now <= stale_at {
            return Ok(()); // already in sync
        }
    }
    let unsorted_groups =
        echo_im::list_groups(client_name, txn).await.c(h!())?;
    let datasource_groups =
        datasource_group::Entity::find().all(txn).await.c(h!())?;
    let messenger_profiles = echo_client_lock::Entity::find()
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoAccount.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::Datasource.def(),
        )
        .filter(echo_client::Column::Name.eq(client_name))
        .select_only()
        .column(datasource::Column::Id)
        .column(echo_account::Column::Source)
        .into_tuple::<(i64, EchoMessageSource)>()
        .all(txn)
        .await
        .c(h!())?;

    let mut groups = vec![];
    let mut deleted_groups = vec![];
    for g in unsorted_groups.clone() {
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
        .filter(signal_group::Column::Deleted.eq(false))
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
        .filter(whatsapp_group::Column::Deleted.eq(false))
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
    let mut groups_by_dsid = HashMap::new();
    for g in groups_raw {
        let datasource_id = g.datasource_id;
        let mut groups =
            groups_by_dsid.remove(&datasource_id).unwrap_or(vec![]);
        groups.push(g);
        groups_by_dsid.insert(datasource_id, groups);
    }
    for (datasource_id, groups_raw) in groups_by_dsid {
        for g in groups_raw {
            let key = (g.id.clone(), datasource_id);
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
                    deleted: NotSet,
                };
                crate::messenger::group::add_group(model, txn)
                    .await
                    .c(h!())?;
                if g.message_source.eq(&MessageSource::Whatsapp) {
                    whatsapp_group::ActiveModel {
                        name: Set(g.name.clone()),
                        created_at: NotSet,
                        jid: Set(group_id.clone()),
                        owner_jid: NotSet,
                        deleted: NotSet,
                    }
                    .insert(txn)
                    .await
                    .c(h!())?;
                }
            }
            Some(group_model) => {
                let name = Some(g.name.clone());
                if group_model.name != name {
                    if let Some(ref model) = group_model.model_a {
                        let mut model = model.clone().into_active_model();
                        model.name = Set(name);
                        model.update(txn).await.c(h!())?;
                    } else {
                        let mut model = group_model
                            .model_b
                            .clone()
                            .c(h!())?
                            .into_active_model();
                        model.name = Set(g.name.clone());
                        model.update(txn).await.c(h!())?;
                    }
                }
            }
        }
    }

    let mut datasource_groups_to_delete = vec![];

    for g in deleted_groups {
        let datasource_ids = messenger_profiles
            .iter()
            .filter(|(_, source)| sources_eq(&g.message_source, source))
            .map(|(id, _)| *id)
            .collect_vec();
        for id in datasource_ids {
            datasource_groups_to_delete.push((g.id.clone(), id));
        }
    }
    for (master_key, datasource_id) in datasource_groups_to_delete.clone() {
        datasource_group::Entity::update_many()
            .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
            .filter(datasource_group::Column::GroupMasterKey.eq(master_key))
            .col_expr(datasource_group::Column::Deleted, Expr::value(true))
            .exec(txn)
            .await
            .c(h!())?;
    }
    client_groups_sync_ts_map.insert(client_name.to_string(), now);

    for g in unsorted_groups.clone() {
        let datasource_ids = messenger_profiles
            .iter()
            .filter(|(_, source)| sources_eq(&g.message_source, source))
            .map(|(id, _)| *id)
            .collect_vec();
        let should_skip = datasource_ids.iter().any(|id| {
            datasource_groups_to_delete.contains(&(g.id.clone(), *id))
        });
        if should_skip {
            continue;
        }
        let datasource_id = datasource_ids.into_iter().next().c(h!())?;
        let datasource_group = datasource_groups
            .iter()
            .filter(|d| d.group_master_key == g.id)
            .find(|d| d.datasource_id.eq(&datasource_id))
            .cloned();
        match datasource_group {
            None => {
                datasource_group::ActiveModel {
                    id: NotSet,
                    group_master_key: Set(g.id),
                    datasource_id: Set(datasource_id),
                    last_sync_at: NotSet,
                    created_at: NotSet,
                    name: Set(g.name),
                    deleted: NotSet,
                }
                .insert(txn)
                .await
                .c(h!())?;
            }
            Some(rec) => {
                let mut rec = rec.into_active_model();
                rec.last_sync_at = Set(Utc::now().naive_utc());
                rec.name = Set(g.name);
                rec.update(txn).await.c(h!())?;
            }
        }
    }
    Ok(())
}

fn sources_eq(s1: &MessageSource, s2: &EchoMessageSource) -> bool {
    matches!(
        (s1, s2),
        (MessageSource::Signal, EchoMessageSource::Signal)
            | (MessageSource::Whatsapp, EchoMessageSource::Whatsapp)
    )
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
    let datasource = load_client_datasource(db, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("[{client_name}] datasource {datasource_id} is not linked, skipping");
        return Ok(());
    }
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.c(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .c(h!())?;
    txn.commit().await.c(h!())?;

    sync_senders(db, &inbox_messages).await.c(h!())?;

    let total_num = inbox_messages.len();
    for (i, m) in inbox_messages.into_iter().enumerate() {
        {
            debug!(
                "[{client_name}] processing inbox message {} of {}; m.id={}",
                i + 1,
                total_num,
                m.id.clone().unwrap_or("".to_string())
            );
            let txn = db.begin().await.c(h!())?;
            debug!(
                "[{client_name}] process_inbox_message_nofail client_name={}; message_id={}",
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
            let Some(group_id) = m.group_id else {
                warn!("[{client_name}] skipping message {:?} with no group, possibly a private message: {}", m.id, m.text);
                continue;
            };
            let message = Message {
                body: m.text,
                group_id,
                sender: m.sender.map(|s| s.uuid),
                timestamp: m.timestamp,
                datasource_id: datasource.id,
            };
            if let Err(e) = receive_once(
                message,
                m.attachments.into_iter().map(|a| a.path).collect_vec(),
                redis,
                settlements.clone(),
                rq,
                config,
                &txn,
                false,
            )
            .await
            {
                warn!("[{client_name}] bot failed to process a message: {e:?}");
            }
            echo_im::mark_inbox_as_seen(client_name, vec![m.internal_id], &txn)
                .await
                .c(h!())?;
            txn.commit().await.c(h!())?;
        }
    }
    Ok(())
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.c(h!())?;
    let live_clients = list_accounts(None, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(live_clients)
}

pub async fn receive_once(
    m: Message,
    attachment_paths: Vec<String>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsData>>,
    rq: &Client,
    config: &Config,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
) -> Result<String, AppError> {
    // Normalize body
    info!("received message: {m:?}");
    let body = m.body.replace("\r\n", "\n");
    let m_duplicate =
        crate::sigint::find_duplicate(txn, &body, Some(m.timestamp))
            .await
            .c(h!())?;
    let m_duplicate_id = m_duplicate.map(|(message, _)| message.id);
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            m.group_id.clone(),
            m.datasource_id,
        )
        .await
        .c(h!())?;
    let signal_message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body.clone())),
        datasource_group_id: Set(Some(datasource_group_id)),
        created_at: NotSet,
        timestamp: Set(Some(m.timestamp)),
        sender: Set(m.sender),
        duplicate_of: Set(m_duplicate_id),
        format: NotSet,
        deleted: NotSet,
        external_id: NotSet,
        message_uid: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;

    let signal_message =
        id::update_message_with_uid(txn, config, signal_message)
            .await
            .c(h!())?;

    let message_uid = signal_message.message_uid.clone().c(h!())?;

    for path in attachment_paths {
        let _signal_attachment = signal_attachment::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message.id),
            path: Set(path),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
    }

    if !skip_process_inbox_item {
        // inbox item processing happens behind the scene
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
        .c(h!())?;
    }
    Ok(message_uid)
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
        .c(h!())?
        .c(h!())
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
        .c(h!())?;
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
        .c(h!())?;
    }
    Ok(())
}
