use crate::config::{read_config, Config, IDLE_SLEEP_MS, LONG_POLL_SLEEP_MS};
use crate::entities::sea_orm_active_enums::EchoMessageSource;
use crate::entities::*;
use crate::error::{AppError, ContextAndError};
use crate::location::SettlementsData;
use crate::messenger::bl::list_echo_accounts;
use crate::messenger::id;
use crate::messenger::types::{
    EchoAccountF1, Message, SyncResult, WorkerStatus,
};
use crate::messenger::worker_pool::*;
use crate::new_pg_pool_from_mode;
use crate::types::*;
use chrono::*;
use echo_im::types::{MessageF1, MessageSource};
use echo_migration::Expr;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::*;
use tokio::runtime::*;
use tokio::task::JoinSet;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

pub async fn receive_thread_nofail(
    mode: Mode,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) {
    loop {
        if let Err(e) =
            receive_thread_inner(mode, &cancel_token, &shutdown_handle).await
        {
            error!("receive_thread_nofail encountered an error: {e:?}");
            sleep(Duration::from_millis(LONG_POLL_SLEEP_MS)).await;
        }
        sleep(Duration::from_millis(LONG_POLL_SLEEP_MS)).await;
    }
}

pub async fn receive_thread_inner(
    mode: Mode,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;

    info!("started receive_thread_inner");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&dbx).await
    {
        error!("failed to enable verbose logging: {e:?}");
    };

    let mut workers: JoinSet<WorkerStatus> = JoinSet::new();
    let mut running_ids: HashSet<i64> = HashSet::new();

    loop {
        receive_thread_inner_2(
            mode,
            cancel_token,
            shutdown_handle,
            &dbx,
            &mut workers,
            &mut running_ids,
        )
        .await
        .c(h!())?;
        sleep(Duration::from_millis(LONG_POLL_SLEEP_MS)).await;
    }
}

pub async fn receive_thread_inner_2(
    mode: Mode,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
    dbx: &DatabaseConnection,
    workers: &mut JoinSet<WorkerStatus>,
    running_ids: &mut HashSet<i64>,
) -> Result<(), AppError> {
    let now = Utc::now().naive_utc();
    while let Some(Ok(res)) = workers.try_join_next() {
        if !res.failed {
            info!(
                "✅ Worker for datasource {} was shut down: datasource disconnected.",
                res.datasource_id
            );
        } else {
            error!("⚠️ Worker for datasource {} failed!", res.datasource_id);
        }
        running_ids.remove(&res.datasource_id);
    }
    if cancel_token.is_cancelled() {
        info!("[receive_thread_nofail] cancellation requested, stopping...");
        return Ok(());
    }
    let clients = list_clients(dbx).await.c(h!())?;
    for datasource in clients {
        bl_spawn_worker_if_not_running(
            mode,
            cancel_token,
            shutdown_handle,
            workers,
            running_ids,
            now,
            &datasource,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

pub async fn bl_spawn_worker_if_not_running(
    mode: Mode,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
    workers: &mut JoinSet<WorkerStatus>,
    running_ids: &mut HashSet<i64>,
    now: NaiveDateTime,
    datasource: &EchoAccountF1,
) -> Result<(), AppError> {
    if !running_ids.contains(&datasource.id) {
        running_ids.insert(datasource.id);
        let Some(client_name) = datasource.system_service_name.clone() else {
            trace!("client name is missing, skipping: {datasource:?}");
            return Ok(());
        };
        let ts_now = now.format("%Y%m%d_%H:%M:%S").to_string();
        let worker_name = format!(
            "messenger_receive_worker_{}_{client_name}-{ts_now}",
            datasource.id
        );
        let datasource_id = datasource.id;
        let cancel_token_cloned = cancel_token.clone();
        let shutdown_handle_cloned = shutdown_handle.clone();
        info!(
            "🚀 Spawning new worker for datasource {}, name={worker_name}",
            datasource.display_name
        );
        workers.spawn_on(
            {
                spawn_new_worker(
                    datasource_id,
                    mode,
                    worker_name,
                    cancel_token_cloned,
                )
            },
            &shutdown_handle_cloned,
        );
    }
    Ok(())
}

async fn spawn_new_worker(
    datasource_id: i64,
    mode: Mode,
    worker_name: String,
    cancel_token: CancellationToken,
) -> WorkerStatus {
    let worker_name_val = worker_name.clone();

    let failed = match run_new_worker(
        datasource_id,
        mode,
        worker_name_val.clone(),
        cancel_token,
    )
    .await
    {
        Ok(_) => false,
        Err(e) => {
            error!("failed to run worker {worker_name_val}, stopping. Root cause: {e:?}");
            true
        }
    };

    info!("worker {worker_name} was shutdown, failed={failed}");
    WorkerStatus {
        datasource_id,
        failed,
    }
}

async fn run_new_worker(
    datasource_id: i64,
    mode: Mode,
    worker_name: String,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    info!("spawning new worker: {worker_name}");
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut message_processor_pool =
        mk_message_processor_pool(mode).await.c(h!())?;
    info!("{worker_name}: started processing");
    let result = async {
        loop {
            if cancel_token.is_cancelled() {
                info!("{worker_name}: cancellation requested, shutting down...");
                return Ok(());
            }
            let Some(cli) = list_echo_accounts(Some(datasource_id), &dbx)
                .await
                .c(h!())?
                .into_iter()
                .next()
                .filter(|ds| ds.is_linked)
            else {
                info!(
                    "datasource {datasource_id} went offline, stopping worker..."
                );
                sleep(Duration::from_millis(LONG_POLL_SLEEP_MS))
                    .await;
                return Ok(());
            };
            let sync_result =
                sync_client_once(cli, &dbx, &mut message_processor_pool).await;
            if !sync_result.is_healthy {
                sleep(Duration::from_millis(LONG_POLL_SLEEP_MS))
                    .await;
                bail!("worker thread {worker_name} is not healthy, restarting...");
            }
            if sync_result.num_synced_inbox_messages < 1 {
                sleep(Duration::from_millis(IDLE_SLEEP_MS)).await;
            }
        }
    }.await;
    result
}

async fn sync_client_once(
    cli: EchoAccountF1,
    dbx: &DatabaseConnection,
    processor_pool: &mut ProcessorPool,
) -> SyncResult {
    let Some(client_name) = cli.system_service_name else {
        trace!("client name is missing, skipping: {cli:?}");
        return SyncResult {
            is_healthy: false,
            num_synced_inbox_messages: 0,
        };
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    let num_synced_inbox_messages = receive_thread(
        &client_name,
        &mut client_groups_sync_ts_map,
        dbx,
        processor_pool,
    )
    .await
    .unwrap_or_else(|e| {
        error!("> {client_name}::receive_thread_nofail error: {e:?}");
        0
    });
    let is_healthy = !is_datasource_offline(dbx, cli.id).await;
    SyncResult {
        is_healthy,
        num_synced_inbox_messages,
    }
}

async fn is_datasource_offline(dbx: &DatabaseConnection, id: i64) -> bool {
    let cutoff_ts = Utc::now().naive_utc() - TimeDelta::minutes(5);
    let timestamp = datasource::Entity::find_by_id(id)
        .one(dbx)
        .await
        .ok()
        .flatten()
        .filter(|ds| ds.echo_client_lock_id.is_some()) // for Echo-IM datasources only
        .and_then(|entity| entity.last_sync_at);
    let Some(last_sync_at) = timestamp else {
        return false;
    };
    last_sync_at < cutoff_ts
}

async fn receive_thread(
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
    dbx: &DatabaseConnection,
    processor_pool: &mut ProcessorPool,
) -> Result<usize, AppError> {
    let datasource = load_client_datasource(dbx, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("datasource {datasource_id} is not linked, skipping");
        return Ok(0);
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
    let items_synced = sync_inbox(Utc::now(), dbx, client_name, processor_pool)
        .await
        .c(h!())?;

    let mut model = datasource.into_active_model();
    model.last_sync_at = Set(Some(Utc::now().naive_utc()));
    model.update(dbx).await.c(h!())?;

    Ok(items_synced)
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
    // FIXME temporary workaround, remove group_internal_keys_map after all servers migrated to ECHO-IM and stable. also drop internal id from echo-im contract
    let group_internal_keys_map = groups
        .iter()
        .filter_map(|x| x.internal_id.clone().map(|id| (id, x.id.clone())))
        .collect::<HashMap<_, _>>();
    let mut groups_to_remap = HashMap::new();
    let mut all_master_keys = group_master_keys.clone();
    for key in group_internal_keys_map.keys() {
        all_master_keys.push(key.clone())
    }

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
    let group_models = signal_group::Entity::find()
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::MasterKey.is_in(all_master_keys))
        .all(txn)
        .await
        .cae(h!())?;
    for g in group_models {
        let master_key = if let Some(actual_key) =
            group_internal_keys_map.get(&g.master_key)
        {
            groups_to_remap
                .insert(g.master_key.to_string(), actual_key.to_string());
            actual_key.clone()
        } else {
            g.master_key.clone()
        };
        groups_raw.push(GroupData {
            model_a: Some(g.clone()),
            model_b: None,
            id: master_key,
            name: g.name,
            created_at: g.created_at,
            datasource_id: datasource.id,
        })
    }
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
                let master_key = super::group::ensure_signal_group(
                    txn,
                    g.id.clone(),
                    Some(g.name.clone()),
                    datasource_id,
                )
                .await
                .c(h!())?;
                datasource_group::ActiveModel {
                    id: NotSet,
                    group_master_key: Set(master_key),
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
    for (internal_id, master_key) in groups_to_remap {
        remap_datasource_groups(&internal_id, &master_key, txn)
            .await
            .context(h!())?;
    }
    Ok(())
}

/// FIXME temporary workaround, remove group_internal_keys_map after all servers migrated to ECHO-IM and stable. also drop internal id from echo-im contract
async fn remap_datasource_groups(
    internal_id: &str,
    master_key: &str,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let groups_to_update = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(internal_id))
        .all(txn)
        .await
        .context(h!())?;
    let target_groups = datasource_group::Entity::find()
        .filter(datasource_group::Column::GroupMasterKey.eq(master_key))
        .all(txn)
        .await
        .context(h!())?;
    for g in groups_to_update {
        let m_existing_group = target_groups
            .iter()
            .find(|x| x.datasource_id.eq(&g.datasource_id))
            .cloned();
        if let Some(existing_group) = m_existing_group {
            signal_message::Entity::update_many()
                .filter(signal_message::Column::DatasourceGroupId.eq(g.id))
                .col_expr(
                    signal_message::Column::DatasourceGroupId,
                    Expr::value(existing_group.id),
                )
                .exec(txn)
                .await
                .c(h!())?;
            g.delete(txn).await.c(h!())?;
            continue;
        }
        let mut group = g.into_active_model();
        group.group_master_key = Set(master_key.to_string());
        group.update(txn).await.c(h!())?;
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
    processor_pool: &mut ProcessorPool,
) -> anyhow::Result<usize> {
    let datasource = load_client_datasource(db, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("[{client_name}] datasource {datasource_id} is not linked, skipping");
        return Ok(0);
    }
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.c(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .c(h!())?;
    txn.commit().await.c(h!())?;

    sync_senders(db, &inbox_messages).await.c(h!())?;

    let items = inbox_messages
        .into_iter()
        .map(|m| (m, datasource.id, client_name.to_string()))
        .collect_vec();
    let inbox_num = items.len();
    process_queue(items, processor_pool).await.context(h!())?;
    Ok(inbox_num)
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.c(h!())?;
    let live_clients = list_echo_accounts(None, &txn).await.c(h!())?;
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
        duplicate_of: Set(None),
        format: NotSet,
        deleted: Set(true), // unstaged message
        external_id: NotSet,
        message_uid: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;
    let m_duplicate_of = crate::sigint::find_duplicate_of(
        txn,
        &body,
        Some(m.timestamp),
        signal_message.id,
        redis,
    )
    .await
    .c(h!())?;
    let res = crate::sigint::worker::unstage_message(
        txn,
        &m.group_id,
        signal_message,
        m_duplicate_of,
    )
    .await
    .c(h!())?;

    if res.is_same_group_duplicate {
        return Ok(res.message.message_uid.context(h!())?);
    }

    let signal_message = id::update_message_with_uid(txn, config, res.message)
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
