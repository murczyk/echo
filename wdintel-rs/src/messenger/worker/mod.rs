use crate::config::*;
use crate::entities::sea_orm_active_enums::*;
use crate::entities::*;
use crate::error::*;
use crate::messenger::bl::list_echo_accounts;
use crate::messenger::types::*;
use crate::new_pg_pool_from_mode;
use crate::types::info;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use ::serde::{Deserialize, Serialize};
use chrono::*;
use redis::AsyncCommands;
use sea_orm::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::runtime::*;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

pub mod cleanup;
pub mod group;
pub mod pool;
pub mod queue;

static SIGNAL_LOGIN_DELAY_DONE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct UnlinkedDatasourceNotificationState {
    next_allowed_at_ts: i64,
    consecutive_failures: usize,
}

/// Receive thread for all datasources (messengers)
///
/// - queries echo-im for signal/whatsapp
/// - updates group list
/// - receives new messages
/// - puts them into the signal_message_queue table for further processing
/// - messages are further processed by process_signal_message_queue_item function
pub async fn receive_thread_nofail(
    mode: Mode,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) {
    loop {
        if let Err(e) =
            receive_thread_inner(mode, &cancel_token, &shutdown_handle).await
        {
            error!("receive_thread_nofail encountered an error: {:?}", e);
            sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
        }
        sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
    }
}

pub async fn receive_thread_inner(
    mode: Mode,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let mut redis = crate::new_redis(&config).await.c(h!())?;

    info!("started receive_thread_inner");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&dbx).await
    {
        error!("failed to enable verbose logging: {:?}", e);
    };

    let mut workers: JoinSet<WorkerStatus> = JoinSet::new();
    let mut running_ids: HashSet<i64> = HashSet::new();

    loop {
        receive_thread_inner_2(
            mode,
            cancel_token,
            shutdown_handle,
            &config,
            &dbx,
            &mut redis,
            &mut workers,
            &mut running_ids,
        )
        .await
        .c(h!())?;
        sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
    }
}

pub async fn receive_thread_inner_2(
    mode: Mode,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
    config: &Config,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
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
            config,
            dbx,
            redis,
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
    config: &Config,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    workers: &mut JoinSet<WorkerStatus>,
    running_ids: &mut HashSet<i64>,
    now: NaiveDateTime,
    datasource: &EchoAccountF1,
) -> Result<(), AppError> {
    if datasource.status != AccountStatus::Active.into_value() {
        trace!(
            "datasource {} is {}, skipping worker spawn",
            datasource.id,
            datasource.status
        );
        return Ok(());
    }
    if has_unlinked_echo_account(datasource) {
        notify_unlinked_datasource(redis, config, dbx, datasource)
            .await
            .c(h!())?;
        return Ok(());
    }
    clear_unlinked_datasource_notification(redis, datasource.id)
        .await
        .c(h!())?;
    if !running_ids.contains(&datasource.id) {
        running_ids.insert(datasource.id);
        let Some(client_name) = datasource.system_service_name.clone() else {
            trace!("client name is missing, skipping: {:?}", datasource);
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
        let redis = redis.clone();
        info!(
            "🚀 Spawning new worker for datasource {}, name={worker_name}",
            datasource.display_name
        );
        workers.spawn_on(
            {
                spawn_new_worker(
                    datasource_id,
                    mode,
                    config.clone(),
                    redis,
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
    config: Config,
    redis: redis::aio::ConnectionManager,
    worker_name: String,
    cancel_token: CancellationToken,
) -> WorkerStatus {
    let worker_name_val = worker_name.clone();

    let failed = match run_new_worker(
        datasource_id,
        mode,
        config,
        redis,
        worker_name_val.clone(),
        cancel_token,
    )
    .await
    {
        Ok(_) => false,
        Err(e) => {
            error!("failed to run worker {worker_name_val}, stopping. Root cause: {:?}", e);
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
    config: Config,
    mut redis: redis::aio::ConnectionManager,
    worker_name: String,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    info!("spawning new worker: {worker_name}");
    let dbx = new_pg_pool_from_mode(mode).await.c(h!())?;
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
            else {
                info!(
                    "datasource {datasource_id} went offline, stopping worker..."
                );
                sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS))
                    .await;
                return Ok(());
            };
            if cli.status != AccountStatus::Active.into_value() {
                info!("datasource {datasource_id} is paused, stopping worker...");
                return Ok(());
            }
            let sync_result =
                sync_client_once(&config, cli, &dbx, &mut redis).await;
            if !sync_result.is_healthy {
                sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS))
                    .await;
                bail!("worker thread {worker_name} is not healthy, restarting...");
            }
            if sync_result.num_synced_inbox_messages < 1 {
                sleep(Duration::from_millis(MESSENGER_WORKER_IDLE_SLEEP_MS)).await;
            }
        }
    }.await;
    result
}

async fn sync_client_once(
    config: &Config,
    cli: EchoAccountF1,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> SyncResult {
    if has_unlinked_echo_account(&cli) {
        if let Err(e) =
            notify_unlinked_datasource(redis, config, dbx, &cli).await
        {
            error!(
                "failed to process unlinked datasource notification for {}: {:?}",
                cli.id, e
            );
        }
        return SyncResult {
            is_healthy: false,
            num_synced_inbox_messages: 0,
        };
    }
    if let Err(e) = clear_unlinked_datasource_notification(redis, cli.id).await
    {
        error!(
            "failed to clear unlinked datasource notification state for {}: {:?}",
            cli.id, e
        );
    }
    let Some(client_name) = cli.system_service_name else {
        trace!("client name is missing, skipping: {:?}", cli);
        return SyncResult {
            is_healthy: false,
            num_synced_inbox_messages: 0,
        };
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    let num_synced_inbox_messages = receive_thread(
        config,
        &client_name,
        &mut client_groups_sync_ts_map,
        dbx,
    )
    .await
    .unwrap_or_else(|e| {
        error!("> {client_name}::receive_thread_nofail error: {:?}", e);
        0
    });
    let is_healthy = !is_datasource_offline(dbx, cli.id).await;
    SyncResult {
        is_healthy,
        num_synced_inbox_messages,
    }
}

fn has_unlinked_echo_account(datasource: &EchoAccountF1) -> bool {
    datasource.echo_client_lock_id.is_some() && !datasource.is_linked
}

fn unlinked_datasource_notification_state_key(datasource_id: i64) -> String {
    format!(
        "{}:{datasource_id}",
        MESSENGER_UNLINKED_DATASOURCE_NOTIFICATION_STATE_REDIS_PREFIX
    )
}

async fn notify_unlinked_datasource(
    redis: &mut redis::aio::ConnectionManager,
    config: &Config,
    dbx: &DatabaseConnection,
    datasource: &EchoAccountF1,
) -> Result<(), AppError> {
    if is_datasource_deleted(dbx, datasource.id).await.c(h!())? {
        clear_unlinked_datasource_notification(redis, datasource.id)
            .await
            .c(h!())?;
        return Ok(());
    }

    let now_ts = Utc::now().timestamp();
    let state =
        load_unlinked_datasource_notification_state(redis, datasource.id)
            .await
            .c(h!())?;
    let should_notify =
        should_send_unlinked_datasource_notification(state, now_ts);
    if !should_notify {
        return Ok(());
    }
    let send_result =
        send_unlinked_datasource_notification(config, datasource).await;
    let next_state = next_unlinked_datasource_notification_state(
        state,
        send_result.is_ok(),
        now_ts,
    );
    save_unlinked_datasource_notification_state(
        redis,
        datasource.id,
        &next_state,
    )
    .await
    .c(h!())?;
    if let Err(e) = send_result {
        error!(
            "failed to send discord alert for unlinked datasource {}: {:?}",
            datasource.id, e
        );
    }
    Ok(())
}

async fn clear_unlinked_datasource_notification(
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
) -> Result<(), AppError> {
    let key = unlinked_datasource_notification_state_key(datasource_id);
    let _: usize = redis.del(key).await.c(h!())?;
    Ok(())
}

async fn load_unlinked_datasource_notification_state(
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
) -> Result<Option<UnlinkedDatasourceNotificationState>, AppError> {
    let key = unlinked_datasource_notification_state_key(datasource_id);
    let raw: Option<String> = redis.get(key).await.c(h!())?;
    Ok(raw
        .map(|raw| serde_json::from_str(&raw).c(h!()))
        .transpose()?)
}

async fn save_unlinked_datasource_notification_state(
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
    state: &UnlinkedDatasourceNotificationState,
) -> Result<(), AppError> {
    let key = unlinked_datasource_notification_state_key(datasource_id);
    let raw = serde_json::to_string(state).c(h!())?;
    let _: () = redis
        .set_ex(
            key,
            raw,
            MESSENGER_UNLINKED_DATASOURCE_NOTIFICATION_STATE_TTL_SEC,
        )
        .await
        .c(h!())?;
    Ok(())
}

fn should_send_unlinked_datasource_notification(
    state: Option<UnlinkedDatasourceNotificationState>,
    now_ts: i64,
) -> bool {
    let Some(state) = state else {
        return true;
    };
    state.next_allowed_at_ts <= now_ts
}

fn next_unlinked_datasource_notification_state(
    state: Option<UnlinkedDatasourceNotificationState>,
    is_sent_successfully: bool,
    now_ts: i64,
) -> UnlinkedDatasourceNotificationState {
    let consecutive_failures =
        state.map(|state| state.consecutive_failures).unwrap_or(0);
    if is_sent_successfully {
        return UnlinkedDatasourceNotificationState {
            next_allowed_at_ts: now_ts
                + MESSENGER_UNLINKED_DISCORD_ALERT_SUCCESS_COOLDOWN_SEC as i64,
            consecutive_failures: 0,
        };
    }
    UnlinkedDatasourceNotificationState {
        next_allowed_at_ts: now_ts
            + unlinked_datasource_notification_retry_delay(consecutive_failures)
                as i64,
        consecutive_failures: (consecutive_failures + 1)
            .min(MESSENGER_UNLINKED_DISCORD_ALERT_RETRY_DELAYS_SEC.len()),
    }
}

fn unlinked_datasource_notification_retry_delay(
    consecutive_failures: usize,
) -> u64 {
    let idx = consecutive_failures
        .min(MESSENGER_UNLINKED_DISCORD_ALERT_RETRY_DELAYS_SEC.len() - 1);
    MESSENGER_UNLINKED_DISCORD_ALERT_RETRY_DELAYS_SEC[idx]
}

async fn is_datasource_deleted(
    dbx: &DatabaseConnection,
    id: i64,
) -> Result<bool, AppError> {
    let is_deleted = datasource::Entity::find_by_id(id)
        .select_only()
        .column(datasource::Column::Deleted)
        .into_tuple::<bool>()
        .one(dbx)
        .await
        .c(h!())?;
    Ok(is_deleted.unwrap_or(true))
}

async fn send_unlinked_datasource_notification(
    config: &Config,
    datasource: &EchoAccountF1,
) -> Result<(), AppError> {
    let client_name = datasource
        .system_service_name
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let content = format!(
        "Echo-акаунт не прив'язаний для datasource #{} ({}) public_host={} messenger={} client={} phone={}",
        datasource.id,
        datasource.display_name,
        config.public_host,
        datasource.messenger,
        client_name,
        datasource.phone_number,
    );
    tokio::time::timeout(
        Duration::from_secs(MESSENGER_UNLINKED_DISCORD_ALERT_TIMEOUT_SEC),
        crate::server::discord::discord_notify(config, &content),
    )
    .await
    .map_err(|e| anyhow::Error::new(e).c(h!()))??;
    Ok(())
}

async fn is_datasource_offline(dbx: &DatabaseConnection, id: i64) -> bool {
    let cutoff_ts = Utc::now().naive_utc() - TimeDelta::minutes(5);
    let m_datasource = datasource::Entity::find_by_id(id)
        .one(dbx)
        .await
        .ok()
        .flatten();
    let Some(datasource) = m_datasource else {
        return true;
    };
    let Some(last_sync_at) = datasource.last_sync_at else {
        return false;
    };
    last_sync_at < cutoff_ts
}

async fn receive_thread(
    config: &Config,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
    dbx: &DatabaseConnection,
) -> Result<usize, AppError> {
    let datasource = load_client_datasource(dbx, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("datasource {datasource_id} is not linked, skipping");
        return Ok(0);
    }
    if datasource.status.eq(&AccountStatus::Paused) {
        trace!("datasource {datasource_id} is paused, skipping");
        return Ok(0);
    }
    ensure_initial_signal_login_delay().await;
    echo_im::worker::signal_worker_tick_once(client_name, dbx)
        .await
        .c(h!())?;
    echo_im::worker::whatsapp_worker_tick_once(client_name, dbx)
        .await
        .c(h!())?;
    let txn = dbx.begin().await.c(h!())?;
    group::sync_groups(&txn, client_name, client_groups_sync_ts_map)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    let items_synced = sync_inbox(config, Utc::now(), dbx, client_name)
        .await
        .c(h!())?;

    let mut model = datasource.into_active_model();
    model.last_sync_at = Set(Some(Utc::now().naive_utc()));
    model.update(dbx).await.c(h!())?;

    Ok(items_synced)
}

async fn ensure_initial_signal_login_delay() {
    let Ok(_) = SIGNAL_LOGIN_DELAY_DONE.compare_exchange(
        false,
        true,
        Ordering::SeqCst,
        Ordering::SeqCst,
    ) else {
        return;
    };

    info!(
        "Initial Signal login delay started ({SIGNAL_LOGIN_INITIAL_SLEEP_MS} ms)",
    );
    sleep(Duration::from_millis(SIGNAL_LOGIN_INITIAL_SLEEP_MS)).await;
    info!("Initial Signal login delay finished");
}

fn sources_eq(
    s1: &echo_im::types::MessageSource,
    s2: &EchoMessageSource,
) -> bool {
    matches!(
        (s1, s2),
        (
            echo_im::types::MessageSource::Signal,
            EchoMessageSource::Signal
        ) | (
            echo_im::types::MessageSource::Whatsapp,
            EchoMessageSource::Whatsapp
        )
    )
}

async fn sync_inbox(
    config: &Config,
    inbox_sync_at: DateTime<Utc>,
    db: &DatabaseConnection,
    client_name: &str,
) -> anyhow::Result<usize> {
    let datasource = load_client_datasource(db, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("[{client_name}] datasource {datasource_id} is not linked, skipping");
        return Ok(0);
    }
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.c(h!())?;
    let inbox_updates =
        echo_im::list_updates_since(client_name, time.naive_utc(), &txn)
            .await
            .c(h!())?;
    apply_inbox_updates(datasource.id, &inbox_updates, &txn)
        .await
        .c(h!())?;
    let inbox_messages =
        echo_im::list_inbox_since(client_name, time.naive_utc(), &txn)
            .await
            .c(h!())?;
    let private_message_bodies = inbox_messages
        .iter()
        .filter(|message| message.group_id.is_none())
        .map(|message| message.text.clone())
        .collect_vec();
    let inbox_internal_ids: Vec<i32> =
        inbox_messages.iter().map(|m| m.internal_id).collect();
    let db_attachment_counts = if inbox_internal_ids.is_empty() {
        BTreeMap::new()
    } else {
        let rows = echo_attachment::Entity::find()
            .filter(
                echo_attachment::Column::MessageId
                    .is_in(inbox_internal_ids.clone()),
            )
            .all(&txn)
            .await
            .c(h!())?;
        let mut counts = BTreeMap::new();
        for att in rows {
            *counts.entry(att.message_id).or_insert(0usize) += 1;
        }
        counts
    };
    let message_attachment_info: Vec<_> = inbox_messages
        .iter()
        .map(|m| {
            (
                m.internal_id,
                m.attachments.len(),
                db_attachment_counts
                    .get(&m.internal_id)
                    .cloned()
                    .unwrap_or(0),
            )
        })
        .collect();
    let inbox_message_count = inbox_internal_ids.len();
    if inbox_message_count == 0 && message_attachment_info.is_empty() {
        trace!(
            "[{client_name}] inbox sync: messages={inbox_message_count} attachment_counts={:?}",
            message_attachment_info
        );
    } else {
        info!(
            "[{client_name}] inbox sync: messages={inbox_message_count} attachment_counts={:?}",
            message_attachment_info
        );
    }
    let senders = inbox_messages
        .iter()
        .flat_map(|m| m.sender.clone())
        .map(|s| (s.uuid.clone(), s.clone()))
        .collect::<BTreeMap<_, _>>();

    let items = inbox_messages
        .into_iter()
        .map(|m| (m, datasource.id))
        .collect_vec();
    let inbox_num = items.len();
    let mut ids = vec![];
    for (item, datasource_id) in items {
        ids.push(item.internal_id);
        write_to_signal_message_queue(item, datasource_id, &txn)
            .await
            .c(h!())?;
    }
    echo_im::mark_inbox_as_seen(client_name, ids, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;

    notify_private_messages(config, client_name, private_message_bodies).await;
    sync_senders(db, senders).await.c(h!())?;
    Ok(inbox_num)
}

async fn notify_private_messages(
    config: &Config,
    client_name: &str,
    message_bodies: Vec<String>,
) {
    for message_body in message_bodies {
        let content = format!(
            "Private message received at echo server {} on service account {}: \n{}",
            config.public_host, client_name, message_body
        );
        let result = tokio::time::timeout(
            Duration::from_secs(
                MESSENGER_PRIVATE_MESSAGE_DISCORD_ALERT_TIMEOUT_SEC,
            ),
            crate::server::discord::discord_notify(config, &content),
        )
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => error!(
                "failed to send private message discord alert for client {client_name}: {e:?}"
            ),
            Err(e) => error!(
                "timed out sending private message discord alert for client {client_name}: {e:?}"
            ),
        }
    }
}

async fn write_to_signal_message_queue(
    item: echo_im::types::MessageF1,
    datasource_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let attachments = item.attachments.clone();
    let signal_message_queue_item = signal_message_queue::ActiveModel {
        id: NotSet,
        datasource_id: Set(datasource_id),
        internal_id: Set(item.internal_id as i64),
        external_id: Set(item.id),
        body: Set(item.text.clone()),
        sender_name: Set(item.sender.clone().and_then(|x| x.name)),
        sender_id: Set(item
            .sender
            .clone()
            .map(|x| x.uuid)
            .map(|id| clear_messenger_login_string(&id))),
        sender_phone_number: Set(item.sender.and_then(|x| x.phone_number)),
        group_id: Set(item.group_id.clone()),
        timestamp: Set(item.timestamp),
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;
    for attachment in &attachments {
        signal_message_queue_attachment::ActiveModel {
            id: NotSet,
            message_id: Set(signal_message_queue_item.id),
            path: Set(attachment.path.clone()),
            name: Set(attachment.name.clone()),
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    let attachment_paths: Vec<_> =
        item.attachments.iter().map(|a| a.path.clone()).collect();
    info!(
        "enqueued message to signal queue: queue_id={} datasource_id={} attachments_count={} attachment_paths={:?}",
        signal_message_queue_item.id,
        datasource_id,
        attachment_paths.len(),
        attachment_paths
    );
    Ok(())
}

async fn apply_inbox_updates(
    datasource_id: i64,
    updates: &[echo_im::types::MessageF1],
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    for update in updates {
        if update.deleted {
            mark_message_deleted(datasource_id, update.internal_id as i64, txn)
                .await
                .c(h!())?;
        }
    }
    Ok(())
}

async fn mark_message_deleted(
    datasource_id: i64,
    inbox_message_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let queue_items = signal_message_queue::Entity::find()
        .filter(signal_message_queue::Column::DatasourceId.eq(datasource_id))
        .filter(signal_message_queue::Column::InternalId.eq(inbox_message_id))
        .all(txn)
        .await
        .c(h!())?;
    if !queue_items.is_empty() {
        let queue_ids: Vec<i64> = queue_items.iter().map(|q| q.id).collect();
        signal_message_queue_attachment::Entity::delete_many()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .is_in(queue_ids.clone()),
            )
            .exec(txn)
            .await
            .c(h!())?;
        signal_message_queue::Entity::delete_many()
            .filter(signal_message_queue::Column::Id.is_in(queue_ids))
            .exec(txn)
            .await
            .c(h!())?;
        info!(
            "removed {} pending queue items for deleted inbox_message_id={}",
            queue_items.len(),
            inbox_message_id
        );
    }

    let inbox_id_i32 = match i32::try_from(inbox_message_id) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "failed to convert inbox_message_id={inbox_message_id} to i32: {e}; skipping delete"
            );
            return Ok(());
        }
    };
    let inbox_message = echo_inbox_message::Entity::find_by_id(inbox_id_i32)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;
    let Some(group_id) = inbox_message.group_id else {
        // private chat, nothing to map into signal_message
        return Ok(());
    };
    let Some(echo_group) = echo_group::Entity::find_by_id(group_id)
        .one(txn)
        .await
        .c(h!())?
    else {
        warn!(
                "no echo_group found for id={group_id} while deleting inbox_message_id={inbox_message_id}"
            );
        return Ok(());
    };
    let group_master_key = echo_group.group_id;
    let datasource_group = datasource_group::Entity::find()
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq(group_master_key.clone()),
        )
        .one(txn)
        .await
        .c(h!())?;
    let Some(datasource_group_id) = datasource_group.map(|g| g.id) else {
        warn!(
            "no datasource_group found for datasource_id={datasource_id} group_master_key={group_master_key}"
        );
        return Ok(());
    };
    let messages = signal_message::Entity::find()
        .filter(
            signal_message::Column::DatasourceGroupId.eq(datasource_group_id),
        )
        .filter(signal_message::Column::Timestamp.eq(inbox_message.timestamp))
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            signal_message::Column::Body.eq(Some(inbox_message.body.clone())),
        )
        .all(txn)
        .await
        .c(h!())?;
    if messages.is_empty() {
        if queue_items.is_empty() {
            warn!(
                "no signal_message found to delete: inbox_message_id={inbox_message_id} datasource_id={datasource_id}"
            );
        }
        return Ok(());
    }
    for message in messages {
        let mut message_am = message.into_active_model();
        message_am.deleted = Set(true);
        message_am.update(txn).await.c(h!())?;
    }
    Ok(())
}

async fn list_clients(
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    let txn = dbx.begin().await.c(h!())?;
    let live_clients = list_echo_accounts(None, &txn).await.c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(live_clients)
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
    input_senders: BTreeMap<String, echo_im::types::SenderF1>,
) -> anyhow::Result<()> {
    let mut senders = BTreeMap::new();
    for (uuid, sender) in input_senders {
        senders.insert(clear_messenger_login_string(&uuid), sender);
    }
    let sender_ids = senders.keys().cloned().collect::<Vec<_>>();
    let existing_senders = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq_any(sender_ids))
        .select_only()
        .column(signal_profile::Column::Uuid)
        .into_tuple::<String>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|id| clear_messenger_login_string(&id))
        .collect::<Vec<_>>();
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

pub fn clear_messenger_login_string(input: &str) -> String {
    let is_whatsapp_id =
        input.ends_with("@lid") || input.ends_with("@s.whatsapp.net");
    if !is_whatsapp_id || !input.contains(":") {
        return input.to_string();
    }
    // 1. Split by '@' to separate the ID/Semicolon part from the "lid" part
    let parts: Vec<&str> = input.split('@').collect();

    if parts.len() != 2 {
        return input.to_string(); // Return original if format is unexpected
    }

    let id_section = parts[0];
    let domain_section = parts[1];

    // 2. Split the first section by ':' and take only the first part (the number)
    let clean_id = id_section.split(':').next().unwrap_or(id_section);

    // 3. Reconstruct the string
    format!("{}@{}", clean_id, domain_section)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlinked_notification_suppresses_duplicates_until_success_cooldown() {
        let now_ts = 1_000;

        assert!(should_send_unlinked_datasource_notification(None, now_ts));

        let state =
            next_unlinked_datasource_notification_state(None, true, now_ts);

        assert!(!should_send_unlinked_datasource_notification(
            Some(state),
            now_ts + 30,
        ));
        assert!(should_send_unlinked_datasource_notification(
            Some(state),
            now_ts
                + MESSENGER_UNLINKED_DISCORD_ALERT_SUCCESS_COOLDOWN_SEC as i64,
        ));
    }

    #[test]
    fn unlinked_notification_uses_capped_retry_backoff() {
        let now_ts = 1_000;

        let state_1 =
            next_unlinked_datasource_notification_state(None, false, now_ts);
        assert!(!should_send_unlinked_datasource_notification(
            Some(state_1),
            now_ts,
        ));
        assert!(should_send_unlinked_datasource_notification(
            Some(state_1),
            now_ts + 1,
        ));

        let retry_1_at = now_ts + 1;
        let state_2 = next_unlinked_datasource_notification_state(
            Some(state_1),
            false,
            retry_1_at,
        );
        assert!(!should_send_unlinked_datasource_notification(
            Some(state_2),
            retry_1_at + 4,
        ));
        assert!(should_send_unlinked_datasource_notification(
            Some(state_2),
            retry_1_at + 5,
        ));

        let retry_2_at = retry_1_at + 5;
        let state_3 = next_unlinked_datasource_notification_state(
            Some(state_2),
            false,
            retry_2_at,
        );
        assert!(!should_send_unlinked_datasource_notification(
            Some(state_3),
            retry_2_at + 14,
        ));
        assert!(should_send_unlinked_datasource_notification(
            Some(state_3),
            retry_2_at + 15,
        ));

        let retry_3_at = retry_2_at + 15;
        let state_4 = next_unlinked_datasource_notification_state(
            Some(state_3),
            false,
            retry_3_at,
        );
        assert!(!should_send_unlinked_datasource_notification(
            Some(state_4),
            retry_3_at + 14,
        ));
        assert!(should_send_unlinked_datasource_notification(
            Some(state_4),
            retry_3_at + 15,
        ));
    }

    #[test]
    fn clear_unlinked_notification_resets_retry_state() {
        let now_ts = 1_000;
        let state =
            next_unlinked_datasource_notification_state(None, false, now_ts);

        assert!(!should_send_unlinked_datasource_notification(
            Some(state),
            now_ts,
        ));
        assert!(should_send_unlinked_datasource_notification(None, now_ts));
    }
}
