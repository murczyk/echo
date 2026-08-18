use crate::config::*;
use crate::entities::sea_orm_active_enums::*;
use crate::entities::*;
use crate::error::*;
use crate::messenger::bl::list_echo_accounts;
use crate::messenger::types::*;
use crate::types::info;
use crate::types::*;
use ::serde::{Deserialize, Serialize};
use chrono::*;
use redis::AsyncCommands;
use sea_orm::*;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::runtime::*;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

pub mod cleanup;
pub mod group;
pub mod pool;
pub mod queue;
pub mod recovery;

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
    env: Arc<Env>,
    cancel_token: CancellationToken,
    shutdown_handle: Handle,
) {
    loop {
        if let Err(e) =
            receive_thread_inner(env.clone(), &cancel_token, &shutdown_handle)
                .await
        {
            error!("receive_thread_nofail encountered an error: {:?}", e);
            sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
        }
        sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
    }
}

pub async fn receive_thread_inner(
    env: Arc<Env>,
    cancel_token: &CancellationToken,
    shutdown_handle: &Handle,
) -> Result<(), AppError> {
    let config = &env.config;
    let settlements = env.settlements.clone();
    let rq = &env.rq;
    let mut redis = env.redis.clone();
    let dbx = &env.dbx;
    let s3 = &env.s3;

    info!("started receive_thread_inner");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(dbx).await
    {
        error!("failed to enable verbose logging: {:?}", e);
    };

    let mut workers: JoinSet<WorkerStatus> = JoinSet::new();
    let mut running_ids: HashSet<i64> = HashSet::new();
    let mut echo_im_sync_recovery_next_at: Option<NaiveDateTime> = None;

    loop {
        receive_thread_inner_2(
            cancel_token,
            shutdown_handle,
            config,
            dbx,
            &mut redis,
            &mut workers,
            &mut running_ids,
        )
        .await
        .c(h!())?;
        let recovered_missing_count = maybe_run_echo_im_sync_recovery(
            config,
            settlements.clone(),
            rq,
            s3,
            dbx,
            &mut redis,
            &mut echo_im_sync_recovery_next_at,
        )
        .await;
        if recovered_missing_count < ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize {
            sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
        }
    }
}

async fn maybe_run_echo_im_sync_recovery(
    config: &Config,
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    rq: &reqwest::Client,
    s3: &Option<opendal::Operator>,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
    next_run_at: &mut Option<NaiveDateTime>,
) -> usize {
    let now = Utc::now().naive_utc();
    if next_run_at.is_some_and(|next_run_at| next_run_at > now) {
        return 0;
    }

    let deps = recovery::EchoImSyncRecoveryDeps {
        config,
        settlements,
        rq,
        s3,
    };
    match recovery::run_echo_im_sync_recovery_once(dbx, redis, &deps).await {
        Ok(missing_count) => {
            if missing_count < ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize {
                *next_run_at = Some(
                    now + chrono::TimeDelta::seconds(
                        ECHO_IM_SYNC_RECOVERY_IDLE_SLEEP_SEC,
                    ),
                );
            } else {
                *next_run_at = None;
            }
            missing_count
        }
        Err(err) => {
            error!("echo_im sync recovery failed: {:?}", err);
            *next_run_at = Some(
                now + chrono::TimeDelta::seconds(
                    ECHO_IM_SYNC_RECOVERY_IDLE_SLEEP_SEC,
                ),
            );
            0
        }
    }
}

pub async fn receive_thread_inner_2(
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
    if datasource.status
        != AccountStatus::Active.into_value().value.into_owned()
    {
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
                    dbx.clone(),
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
    dbx: DatabaseConnection,
    config: Config,
    redis: redis::aio::ConnectionManager,
    worker_name: String,
    cancel_token: CancellationToken,
) -> WorkerStatus {
    let worker_name_val = worker_name.clone();

    let failed = match run_new_worker(
        datasource_id,
        dbx,
        config,
        redis,
        worker_name_val.clone(),
        cancel_token,
    )
    .await
    {
        Ok(_) => false,
        Err(e) => {
            error!(
                "failed to run worker {worker_name_val}, stopping. Root cause: {:?}",
                e
            );
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
    dbx: DatabaseConnection,
    config: Config,
    mut redis: redis::aio::ConnectionManager,
    worker_name: String,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    info!("spawning new worker: {worker_name}");
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
            if cli.status
                != AccountStatus::Active.into_value().value.into_owned()
            {
                info!("datasource {datasource_id} is paused, stopping worker...");
                return Ok(());
            }
            let sync_result =
                sync_client_once(&config, cli, &dbx, &mut redis).await;
            if sync_result.maintenance_skipped {
                sleep(Duration::from_secs(
                    SIGNAL_RESTART_MAINTENANCE_RETRY_SEC,
                ))
                .await;
                continue;
            }
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
            maintenance_skipped: false,
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
            maintenance_skipped: false,
        };
    };
    let mut client_groups_sync_ts_map =
        BTreeMap::<String, NaiveDateTime>::new();
    let receive_result = receive_thread(
        config,
        &client_name,
        &mut client_groups_sync_ts_map,
        dbx,
        redis,
    )
    .await;
    let (num_synced_inbox_messages, maintenance_skipped) = match receive_result
    {
        Ok(ReceiveThreadResult::Synced(count)) => (count, false),
        Ok(ReceiveThreadResult::Maintenance) => (0, true),
        Err(failure) => {
            error!(
                "> {client_name}::receive_thread_nofail failed: {}",
                crate::messenger::signal_restart::normalized_failure(&failure)
            );
            (0, false)
        }
    };
    if maintenance_skipped {
        return SyncResult {
            is_healthy: true,
            num_synced_inbox_messages,
            maintenance_skipped,
        };
    }
    let is_healthy = !is_datasource_offline(dbx, cli.id).await;
    SyncResult {
        is_healthy,
        num_synced_inbox_messages,
        maintenance_skipped,
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
        crate::server::discord::discord_notify(
            config,
            DISCORD_WEBHOOK_ALERT,
            &content,
        ),
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

enum ReceiveThreadResult {
    Synced(usize),
    Maintenance,
}

async fn receive_thread(
    config: &Config,
    client_name: &str,
    client_groups_sync_ts_map: &mut BTreeMap<String, NaiveDateTime>,
    dbx: &DatabaseConnection,
    redis: &mut redis::aio::ConnectionManager,
) -> Result<ReceiveThreadResult, AppError> {
    let datasource = load_client_datasource(dbx, client_name).await.c(h!())?;
    let datasource_id = datasource.id;
    if datasource.echo_client_lock_id.is_none() {
        trace!("datasource {datasource_id} is not linked, skipping");
        return Ok(ReceiveThreadResult::Synced(0));
    }
    if datasource.status == AccountStatus::Paused {
        trace!("datasource {datasource_id} is paused, skipping");
        return Ok(ReceiveThreadResult::Synced(0));
    }
    ensure_initial_signal_login_delay().await;
    let restapi_error_discord_webhook_url =
        crate::system_settings::get_echo_restapi_error_discord_webhook_url(dbx)
            .await
            .c(h!())?;
    let tick_outcome = echo_im::worker::signal_worker_tick_once_with_options(
        client_name,
        dbx,
        crate::messenger::signal_restart::signal_worker_options(
            crate::messenger::signal_restart::RedisSignalRestartCoordinator::new(
                redis.clone(),
            ),
            restapi_error_discord_webhook_url,
        ),
    )
    .await
    .c(h!())?;
    if tick_outcome == echo_im::worker::SignalWorkerTickOutcome::Maintenance {
        return Ok(ReceiveThreadResult::Maintenance);
    }
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

    Ok(ReceiveThreadResult::Synced(items_synced))
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
        trace!(
            "[{client_name}] datasource {datasource_id} is not linked, skipping"
        );
        return Ok(0);
    }
    let time = inbox_sync_at - TimeDelta::seconds(100); // double-check maybe we missed messages not labeled as seen
    let txn = db.begin().await.c(h!())?;
    let inbox_updates =
        echo_im::list_updates_since(client_name, time.naive_utc(), &txn)
            .await
            .c(h!())?;
    let inbox_updates = coalesce_latest_inbox_states(inbox_updates);
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
        .chain(inbox_updates.iter().filter(|message| !message.deleted))
        .flat_map(|m| m.sender.clone())
        .map(|s| (s.uuid.clone(), s.clone()))
        .collect::<BTreeMap<_, _>>();

    let synced_item_count = inbox_messages.len() + inbox_updates.len();
    let mut ids = vec![];
    for item in &inbox_messages {
        ids.push(item.internal_id);
        upsert_signal_message_queue_snapshot(item, datasource.id, &txn)
            .await
            .c(h!())?;
    }
    for update in &inbox_updates {
        upsert_signal_message_queue_snapshot(update, datasource.id, &txn)
            .await
            .c(h!())?;
    }
    echo_im::mark_inbox_as_seen(client_name, ids, &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;

    notify_private_messages(config, client_name, private_message_bodies).await;
    sync_senders(db, senders).await.c(h!())?;
    Ok(synced_item_count)
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
            crate::server::discord::discord_notify(
                config,
                DISCORD_WEBHOOK_ALERT,
                &content,
            ),
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

fn coalesce_latest_inbox_states(
    updates: Vec<echo_im::types::MessageF1>,
) -> Vec<echo_im::types::MessageF1> {
    let mut seen = HashSet::new();
    let mut result = vec![];
    for update in updates.into_iter().rev() {
        if seen.insert(update.internal_id) {
            result.push(update);
        }
    }
    result.reverse();
    result
}

async fn upsert_signal_message_queue_snapshot(
    item: &echo_im::types::MessageF1,
    datasource_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let existing_snapshot = load_signal_message_queue_snapshot(
        txn,
        datasource_id,
        item.internal_id,
    )
    .await
    .c(h!())?;
    let effective_attachments = effective_queue_snapshot_attachments(
        item,
        datasource_id,
        existing_snapshot
            .as_ref()
            .map(|(_, attachments)| attachments.len())
            .unwrap_or(0),
        txn,
    )
    .await
    .c(h!())?;
    if let Some((existing_item, existing_attachments)) = existing_snapshot {
        if queue_snapshot_matches(
            &existing_item,
            &existing_attachments,
            item,
            &effective_attachments,
        ) {
            trace!(
                "skipped unchanged inbox snapshot: queue_id={} datasource_id={} inbox_message_id={}",
                existing_item.id, datasource_id, item.internal_id
            );
            return Ok(());
        }
    }

    let signal_message_queue_item = signal_message_queue::ActiveModel {
        id: NotSet,
        datasource_id: Set(datasource_id),
        internal_id: Set(item.internal_id as i64),
        external_id: Set(item.id.clone()),
        body: Set(item.text.clone()),
        sender_name: Set(item.sender.as_ref().and_then(|x| x.name.clone())),
        sender_id: Set(item
            .sender
            .as_ref()
            .map(|x| x.uuid.clone())
            .map(|id| clear_messenger_login_string(&id))),
        sender_phone_number: Set(item
            .sender
            .as_ref()
            .and_then(|x| x.phone_number.clone())),
        group_id: Set(item.group_id.clone()),
        timestamp: Set(item.timestamp),
        created_at: NotSet,
        deleted: Set(item.deleted),
    };
    signal_message_queue::Entity::insert(signal_message_queue_item)
        .on_conflict(
            sea_query::OnConflict::columns([
                signal_message_queue::Column::DatasourceId,
                signal_message_queue::Column::InternalId,
            ])
            .update_columns([
                signal_message_queue::Column::ExternalId,
                signal_message_queue::Column::Body,
                signal_message_queue::Column::SenderName,
                signal_message_queue::Column::SenderId,
                signal_message_queue::Column::SenderPhoneNumber,
                signal_message_queue::Column::GroupId,
                signal_message_queue::Column::Timestamp,
                signal_message_queue::Column::CreatedAt,
                signal_message_queue::Column::Deleted,
            ])
            .to_owned(),
        )
        .exec(txn)
        .await
        .c(h!())?;

    let signal_message_queue_item = signal_message_queue::Entity::find()
        .filter(signal_message_queue::Column::DatasourceId.eq(datasource_id))
        .filter(
            signal_message_queue::Column::InternalId
                .eq(item.internal_id as i64),
        )
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?;

    signal_message_queue_attachment::Entity::delete_many()
        .filter(
            signal_message_queue_attachment::Column::MessageId
                .eq(signal_message_queue_item.id),
        )
        .exec(txn)
        .await
        .c(h!())?;

    if item.deleted {
        info!(
            "queued inbox tombstone: queue_id={} datasource_id={} inbox_message_id={}",
            signal_message_queue_item.id, datasource_id, item.internal_id
        );
        return Ok(());
    }

    for attachment in &effective_attachments {
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
    let attachment_paths: Vec<_> = effective_attachments
        .iter()
        .map(|a| a.path.clone())
        .collect();
    info!(
        "queued inbox snapshot: queue_id={} datasource_id={} inbox_message_id={} attachments_count={} attachment_paths={:?}",
        signal_message_queue_item.id,
        datasource_id,
        item.internal_id,
        attachment_paths.len(),
        attachment_paths
    );
    Ok(())
}

async fn effective_queue_snapshot_attachments(
    item: &echo_im::types::MessageF1,
    datasource_id: i64,
    previous_attachment_count: usize,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<echo_im::types::MessageAttachmentF1>> {
    if item.deleted {
        return Ok(vec![]);
    }
    if !item.attachments.is_empty() {
        return Ok(trim_echo_attachment_batch_for_queue(
            item.attachments.clone(),
            previous_attachment_count,
            datasource_id,
            item.internal_id,
        ));
    }
    if let Some(attachments) =
        crate::messenger::attachments::load_latest_echo_attachment_batch(
            txn,
            datasource_id,
            item.internal_id,
        )
        .await
        .c(h!())?
    {
        return Ok(trim_echo_attachment_batch_for_queue(
            attachments,
            previous_attachment_count,
            datasource_id,
            item.internal_id,
        ));
    }
    Ok(vec![])
}

fn trim_echo_attachment_batch_for_queue(
    attachments: Vec<echo_im::types::MessageAttachmentF1>,
    previous_attachment_count: usize,
    datasource_id: i64,
    echo_inbox_message_id: i32,
) -> Vec<echo_im::types::MessageAttachmentF1> {
    let original_attachment_count = attachments.len();
    let attachments =
        crate::messenger::attachments::latest_attachment_batch_by_expected_count(
            attachments,
            previous_attachment_count,
        );
    if !attachments.is_empty() {
        info!(
            "using attachment batch for queued inbox snapshot: datasource_id={} echo_inbox_message_id={} attachments_count={} previous_attachment_count={} original_attachment_count={}",
            datasource_id,
            echo_inbox_message_id,
            attachments.len(),
            previous_attachment_count,
            original_attachment_count
        );
    }
    attachments
}

async fn load_signal_message_queue_snapshot(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    internal_id: i32,
) -> anyhow::Result<
    Option<(
        signal_message_queue::Model,
        Vec<signal_message_queue_attachment::Model>,
    )>,
> {
    let Some(queue_item) = signal_message_queue::Entity::find()
        .filter(signal_message_queue::Column::DatasourceId.eq(datasource_id))
        .filter(signal_message_queue::Column::InternalId.eq(internal_id as i64))
        .one(txn)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    let attachments = signal_message_queue_attachment::Entity::find()
        .filter(
            signal_message_queue_attachment::Column::MessageId
                .eq(queue_item.id),
        )
        .order_by_asc(signal_message_queue_attachment::Column::Id)
        .all(txn)
        .await
        .c(h!())?;
    Ok(Some((queue_item, attachments)))
}

fn queue_snapshot_matches(
    existing_item: &signal_message_queue::Model,
    existing_attachments: &[signal_message_queue_attachment::Model],
    item: &echo_im::types::MessageF1,
    effective_attachments: &[echo_im::types::MessageAttachmentF1],
) -> bool {
    existing_item.external_id == item.id
        && existing_item.body == item.text
        && existing_item.sender_name
            == item.sender.as_ref().and_then(|sender| sender.name.clone())
        && existing_item.sender_id
            == item
                .sender
                .as_ref()
                .map(|sender| clear_messenger_login_string(&sender.uuid))
        && existing_item.sender_phone_number
            == item
                .sender
                .as_ref()
                .and_then(|sender| sender.phone_number.clone())
        && existing_item.group_id == item.group_id
        && existing_item.timestamp == item.timestamp
        && existing_item.deleted == item.deleted
        && queue_attachment_snapshot(existing_attachments)
            == message_attachment_snapshot(effective_attachments)
}

fn queue_attachment_snapshot(
    attachments: &[signal_message_queue_attachment::Model],
) -> Vec<(String, Option<String>)> {
    let mut snapshot = attachments
        .iter()
        .map(|attachment| (attachment.path.clone(), attachment.name.clone()))
        .collect::<Vec<_>>();
    snapshot.sort();
    snapshot
}

fn message_attachment_snapshot(
    attachments: &[echo_im::types::MessageAttachmentF1],
) -> Vec<(String, Option<String>)> {
    let mut snapshot = attachments
        .iter()
        .map(|attachment| (attachment.path.clone(), attachment.name.clone()))
        .collect::<Vec<_>>();
    snapshot.sort();
    snapshot
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
    if sender_ids.is_empty() {
        return Ok(());
    }
    let mut existing_senders = signal_profile::Entity::find()
        .filter(signal_profile::Column::Uuid.eq_any(sender_ids))
        .select_only()
        .column(signal_profile::Column::Uuid)
        .column(signal_profile::Column::GivenName)
        .into_tuple::<(String, Option<String>)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|(uuid, given_name)| {
            (clear_messenger_login_string(&uuid), (uuid, given_name))
        })
        .collect::<BTreeMap<_, _>>();
    for (uuid, sender) in senders {
        let name = normalize_sender_profile_name(sender.name);
        match existing_senders.remove(&uuid) {
            Some((existing_uuid, old_name)) => {
                update_sender_profile_name(db, existing_uuid, old_name, name)
                    .await
                    .c(h!())?;
            }
            None => {
                signal_profile::ActiveModel {
                    uuid: Set(uuid),
                    given_name: Set(name),
                    family_name: NotSet,
                    created_at: NotSet,
                }
                .insert(db)
                .await
                .c(h!())?;
            }
        }
    }
    Ok(())
}

async fn update_sender_profile_name(
    db: &DatabaseConnection,
    uuid: String,
    old_name: Option<String>,
    name: Option<String>,
) -> anyhow::Result<()> {
    if name.is_none() || old_name == name {
        return Ok(());
    }
    signal_profile::ActiveModel {
        uuid: Set(uuid.clone()),
        given_name: Set(name.clone()),
        family_name: NotSet,
        created_at: NotSet,
    }
    .update(db)
    .await
    .c(h!())?;
    info!(
        "SENDER_RENAME source=messenger_sync profile_uuid={} old_name={:?} new_name={:?}",
        uuid, old_name, name
    );
    Ok(())
}

fn normalize_sender_profile_name(name: Option<String>) -> Option<String> {
    name.and_then(|name| {
        let name = name.trim();
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    })
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
    use crate::entities::sea_orm_active_enums::{
        AccountStatus, EchoMessageSource,
    };
    use crate::functest::tests::cleanup_locked;
    use serial_test::serial;
    use uuid::Uuid;

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

    #[test]
    fn normalize_sender_profile_name_trims_blank_names() {
        assert_eq!(
            normalize_sender_profile_name(Some(" Григорий ".to_string())),
            Some("Григорий".to_string())
        );
        assert_eq!(normalize_sender_profile_name(Some(" ".to_string())), None);
        assert_eq!(normalize_sender_profile_name(None), None);
    }

    #[test]
    fn clear_messenger_login_string_normalizes_whatsapp_device_suffix() {
        assert_eq!(
            clear_messenger_login_string("276343128371348:5@lid"),
            "276343128371348@lid"
        );
        assert_eq!(
            clear_messenger_login_string("276343128371348:5@s.whatsapp.net"),
            "276343128371348@s.whatsapp.net"
        );
    }

    #[test]
    fn coalesce_latest_inbox_states_keeps_last_snapshot_per_message() {
        let result = coalesce_latest_inbox_states(vec![
            test_message(7, "old", false),
            test_message(8, "other", false),
            test_message(7, "deleted", true),
        ]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].internal_id, 8);
        assert_eq!(result[1].internal_id, 7);
        let message = result
            .iter()
            .find(|message| message.internal_id == 7)
            .unwrap();
        assert_eq!(message.text, "deleted");
        assert!(message.deleted);
    }

    #[test]
    fn queue_snapshot_matches_identical_payload() {
        let mut message = test_message(9, "same", false);
        message.id = Some("external-9".to_string());
        message.sender = Some(echo_im::types::SenderF1 {
            uuid: "276343128371348:5@lid".to_string(),
            name: Some("Sender".to_string()),
            phone_number: Some("123".to_string()),
        });
        message.attachments = vec![
            echo_im::types::MessageAttachmentF1 {
                path: "/tmp/a.txt".to_string(),
                name: Some("a.txt".to_string()),
            },
            echo_im::types::MessageAttachmentF1 {
                path: "/tmp/b.txt".to_string(),
                name: Some("b.txt".to_string()),
            },
        ];
        let existing_item = signal_message_queue::Model {
            id: 1,
            datasource_id: 2,
            internal_id: 9,
            external_id: Some("external-9".to_string()),
            body: "same".to_string(),
            sender_id: Some("276343128371348@lid".to_string()),
            sender_name: Some("Sender".to_string()),
            sender_phone_number: Some("123".to_string()),
            group_id: Some("group".to_string()),
            timestamp: message.timestamp,
            created_at: message.timestamp,
            deleted: false,
        };
        let existing_attachments = vec![
            signal_message_queue_attachment::Model {
                id: 2,
                message_id: 1,
                path: "/tmp/b.txt".to_string(),
                name: Some("b.txt".to_string()),
                created_at: message.timestamp,
            },
            signal_message_queue_attachment::Model {
                id: 1,
                message_id: 1,
                path: "/tmp/a.txt".to_string(),
                name: Some("a.txt".to_string()),
                created_at: message.timestamp,
            },
        ];

        assert!(queue_snapshot_matches(
            &existing_item,
            &existing_attachments,
            &message,
            &message.attachments
        ));

        message.text = "changed".to_string();
        assert!(!queue_snapshot_matches(
            &existing_item,
            &existing_attachments,
            &message,
            &message.attachments
        ));
    }

    #[tokio::test]
    #[serial]
    async fn queue_snapshot_hydrates_empty_attachments_from_echo_attachment() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let (account, datasource) = mk_linked_datasource(&env.dbx).await;
        let inbox = mk_echo_inbox_message(&env.dbx, account.id).await;
        let attachment_path = format!("/tmp/queue-fallback-{}", Uuid::new_v4());
        mk_echo_attachment(
            &env.dbx,
            account.id,
            inbox.id,
            &attachment_path,
            Some("fallback.txt"),
        )
        .await;

        let mut snapshot = test_message(inbox.id, "caption", false);
        snapshot.attachments = vec![echo_im::types::MessageAttachmentF1 {
            path: attachment_path.clone(),
            name: Some("fallback.txt".to_string()),
        }];
        let txn = env.dbx.begin().await.unwrap();
        upsert_signal_message_queue_snapshot(&snapshot, datasource.id, &txn)
            .await
            .unwrap();
        txn.commit().await.unwrap();

        let mut update = test_message(inbox.id, "caption edited", false);
        update.attachments = vec![];
        let txn = env.dbx.begin().await.unwrap();
        upsert_signal_message_queue_snapshot(&update, datasource.id, &txn)
            .await
            .unwrap();
        txn.commit().await.unwrap();

        let queue_item = signal_message_queue::Entity::find()
            .filter(
                signal_message_queue::Column::DatasourceId.eq(datasource.id),
            )
            .filter(
                signal_message_queue::Column::InternalId
                    .eq(i64::from(inbox.id)),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(queue_item.body, "caption edited");
        let attachments = signal_message_queue_attachment::Entity::find()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .eq(queue_item.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].path, attachment_path);
        assert_eq!(attachments[0].name.as_deref(), Some("fallback.txt"));
    }

    #[tokio::test]
    #[serial]
    async fn queue_snapshot_prefers_non_empty_snapshot_attachments() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let (account, datasource) = mk_linked_datasource(&env.dbx).await;
        let inbox = mk_echo_inbox_message(&env.dbx, account.id).await;
        let created_at = Utc::now().naive_utc();
        mk_echo_attachment_at(
            &env.dbx,
            account.id,
            inbox.id,
            "/tmp/stale-a.jpg",
            Some("a.jpg"),
            created_at,
        )
        .await;
        mk_echo_attachment_at(
            &env.dbx,
            account.id,
            inbox.id,
            "/tmp/stale-b.jpg",
            Some("b.jpg"),
            created_at,
        )
        .await;

        let mut snapshot = test_message(inbox.id, "caption edited", false);
        snapshot.attachments = vec![echo_im::types::MessageAttachmentF1 {
            path: "/tmp/current-b.jpg".to_string(),
            name: Some("b.jpg".to_string()),
        }];
        let txn = env.dbx.begin().await.unwrap();
        upsert_signal_message_queue_snapshot(&snapshot, datasource.id, &txn)
            .await
            .unwrap();
        txn.commit().await.unwrap();

        let queue_item = signal_message_queue::Entity::find()
            .filter(
                signal_message_queue::Column::DatasourceId.eq(datasource.id),
            )
            .filter(
                signal_message_queue::Column::InternalId
                    .eq(i64::from(inbox.id)),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let attachments = signal_message_queue_attachment::Entity::find()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .eq(queue_item.id),
            )
            .all(&env.dbx)
            .await
            .unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].path, "/tmp/current-b.jpg");
        assert_eq!(attachments[0].name.as_deref(), Some("b.jpg"));
    }

    fn test_message(
        internal_id: i32,
        text: &str,
        deleted: bool,
    ) -> echo_im::types::MessageF1 {
        echo_im::types::MessageF1 {
            id: Some(format!("external-{internal_id}")),
            text: text.to_string(),
            timestamp: NaiveDate::from_ymd_opt(2026, 7, 9)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
            internal_id,
            group_id: Some("group".to_string()),
            sender_phone_number: None,
            sender: None,
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            reply_to: None,
            deleted,
        }
    }

    async fn mk_linked_datasource(
        dbx: &DatabaseConnection,
    ) -> (echo_account::Model, datasource::Model) {
        let now = Utc::now().naive_utc();
        let phone_seed = Uuid::new_v4().simple().to_string();
        let account = echo_account::ActiveModel {
            id: NotSet,
            source: Set(EchoMessageSource::Signal),
            phone_number: Set(format!("+{}", &phone_seed[..12])),
            is_linked: Set(true),
            created_at: Set(now),
            synced_at: Set(None),
            last_trusted_at: Set(None),
            linked_at: Set(Some(now)),
        }
        .insert(dbx)
        .await
        .unwrap();
        let client = echo_client::ActiveModel {
            id: NotSet,
            name: Set(format!("test-client-{}", Uuid::new_v4())),
            created_at: Set(now),
            deleted: Set(false),
            display_name: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();
        let lock = echo_client_lock::ActiveModel {
            id: NotSet,
            client_id: Set(client.id),
            account_id: Set(account.id),
            created_at: Set(now),
            remove_requested: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
        let datasource = datasource::ActiveModel {
            id: NotSet,
            kind: Set("signal".to_string()),
            display_name: Set(format!("test datasource {}", Uuid::new_v4())),
            signal_phone: Set(Some(account.phone_number.clone())),
            api_endpoint: Set(None),
            enabled: Set(Some(true)),
            group_master_key: Set(None),
            sender_uuid: Set(None),
            description: Set(None),
            status: Set(AccountStatus::Active),
            echo_client_lock_id: Set(Some(i64::from(lock.id))),
            created_at: Set(now),
            default_aor_id: Set(None),
            api_login_id: Set(None),
            updated_by_login_id: Set(None),
            deleted: Set(false),
            last_sync_at: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();

        (account, datasource)
    }

    async fn mk_echo_inbox_message(
        dbx: &DatabaseConnection,
        account_id: i32,
    ) -> echo_inbox_message::Model {
        let now = Utc::now().naive_utc();
        echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(format!("inbox {}", Uuid::new_v4())),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(None),
            sender_id: Set(None),
            group_id: Set(None),
            account_id: Set(account_id),
            created_at: Set(now),
            timestamp: Set(Some(now)),
            updated_at: Set(now),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_echo_attachment(
        dbx: &DatabaseConnection,
        account_id: i32,
        message_id: i32,
        path: &str,
        name: Option<&str>,
    ) -> echo_attachment::Model {
        mk_echo_attachment_at(
            dbx,
            account_id,
            message_id,
            path,
            name,
            Utc::now().naive_utc(),
        )
        .await
    }

    async fn mk_echo_attachment_at(
        dbx: &DatabaseConnection,
        account_id: i32,
        message_id: i32,
        path: &str,
        name: Option<&str>,
        created_at: NaiveDateTime,
    ) -> echo_attachment::Model {
        echo_attachment::ActiveModel {
            id: NotSet,
            name: Set(name.map(ToString::to_string)),
            path: Set(path.to_string()),
            message_id: Set(message_id),
            account_id: Set(account_id),
            created_at: Set(created_at),
            updated_at: Set(created_at),
        }
        .insert(dbx)
        .await
        .unwrap()
    }
}
