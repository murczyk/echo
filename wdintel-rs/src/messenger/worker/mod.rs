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
pub mod recovery;

static SIGNAL_LOGIN_DELAY_DONE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct UnlinkedDatasourceNotificationState {
    next_allowed_at_ts: i64,
    consecutive_failures: usize,
}

struct ReceiveWorkerResources {
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    rq: reqwest::Client,
    s3: Option<opendal::Operator>,
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
    let (config, settlements, rq, mut redis, dbx) =
        crate::utils::setup_worker(mode).await.c(h!())?;
    let s3 = mk_s3(&config).c(h!())?;

    info!("started receive_thread_inner");
    if let Err(e) =
        echo_im::enable_verbose_logging_for_all_signal_clients(&dbx).await
    {
        error!("failed to enable verbose logging: {:?}", e);
    };

    let mut workers: JoinSet<WorkerStatus> = JoinSet::new();
    let mut running_ids: HashSet<i64> = HashSet::new();
    let mut echo_im_sync_recovery_next_at: Option<NaiveDateTime> = None;

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
        let recovered_missing_count = maybe_run_echo_im_sync_recovery(
            &config,
            settlements.clone(),
            &rq,
            &s3,
            &dbx,
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
    let resources = build_receive_worker_resources(mode, &config, &dbx)
        .await
        .c(h!())?;
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
                sync_client_once(&config, &resources, cli, &dbx, &mut redis)
                    .await;
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

async fn build_receive_worker_resources(
    mode: Mode,
    config: &Config,
    dbx: &DatabaseConnection,
) -> anyhow::Result<ReceiveWorkerResources> {
    let settlement_paths = config.settlement_paths().c(h!())?;
    let settlements = Arc::new(RwLock::new(
        crate::location::load_settlements_data_config(settlement_paths, mode)
            .c(h!())?,
    ));
    crate::location::aor_config::init_aor_location_config(
        dbx,
        settlements.clone(),
    )
    .await
    .c(h!())?;
    let rq = reqwest::Client::builder()
        .timeout(core::time::Duration::from_secs(crate::config::RQ_TIMEOUT))
        .build()
        .c(h!())?;
    let s3 = mk_s3(config).c(h!())?;
    Ok(ReceiveWorkerResources {
        settlements,
        rq,
        s3,
    })
}

async fn sync_client_once(
    config: &Config,
    resources: &ReceiveWorkerResources,
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
        resources,
        redis,
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

async fn receive_thread(
    config: &Config,
    resources: &ReceiveWorkerResources,
    redis: &mut redis::aio::ConnectionManager,
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
    let restapi_error_discord_webhook_url =
        crate::system_settings::get_echo_restapi_error_discord_webhook_url(dbx)
            .await
            .c(h!())?;
    echo_im::worker::signal_worker_tick_once_with_options(
        client_name,
        dbx,
        echo_im::worker::SignalWorkerOptions {
            restapi_error_discord_webhook_url,
        },
    )
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
    let items_synced =
        sync_inbox(config, resources, redis, Utc::now(), dbx, client_name)
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
    resources: &ReceiveWorkerResources,
    redis: &mut redis::aio::ConnectionManager,
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
    let mut changed_inbox_item_ids = vec![];
    apply_inbox_updates(
        config,
        resources,
        redis,
        datasource.id,
        &inbox_updates,
        &txn,
        &mut changed_inbox_item_ids,
    )
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
    if let Err(err) =
        crate::inbox::fanout_inbox_changes(redis, changed_inbox_item_ids).await
    {
        error!("failed to fanout restored inbox changes: {:?}", err);
    }

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
    config: &Config,
    resources: &ReceiveWorkerResources,
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
    updates: &[echo_im::types::MessageF1],
    txn: &DatabaseTransaction,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> anyhow::Result<()> {
    for update in updates {
        if update.deleted {
            mark_message_deleted(
                config,
                resources,
                redis,
                datasource_id,
                update.internal_id as i64,
                txn,
                changed_inbox_item_ids,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn mark_message_deleted(
    config: &Config,
    resources: &ReceiveWorkerResources,
    redis: &mut redis::aio::ConnectionManager,
    datasource_id: i64,
    inbox_message_id: i64,
    txn: &DatabaseTransaction,
    changed_inbox_item_ids: &mut Vec<i64>,
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
    let messages = load_active_messages_for_deleted_inbox(
        datasource_group_id,
        inbox_message_id,
        &inbox_message,
        txn,
    )
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
    let canonical_deleted_message = messages
        .iter()
        .find(|message| message.echo_inbox_message_id == Some(inbox_message_id))
        .or_else(|| messages.iter().min_by_key(|message| message.created_at))
        .cloned()
        .c(h!())?;
    for message in messages {
        let mut message_am = message.into_active_model();
        message_am.deleted = Set(true);
        message_am.update(txn).await.c(h!())?;
    }
    changed_inbox_item_ids.extend(
        promote_oldest_deleted_original_duplicate(
            config,
            resources,
            redis,
            txn,
            &inbox_message,
            &canonical_deleted_message,
            datasource_group_id,
            &group_master_key,
        )
        .await
        .c(h!())?,
    );
    Ok(())
}

async fn load_active_messages_for_deleted_inbox(
    datasource_group_id: i64,
    inbox_message_id: i64,
    inbox_message: &echo_inbox_message::Model,
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let exact = signal_message::Entity::find()
        .filter(
            signal_message::Column::DatasourceGroupId.eq(datasource_group_id),
        )
        .filter(signal_message::Column::EchoInboxMessageId.eq(inbox_message_id))
        .all(txn)
        .await
        .c(h!())?;
    let active_exact = exact
        .iter()
        .filter(|message| !message.deleted)
        .cloned()
        .collect::<Vec<_>>();
    if !active_exact.is_empty() {
        return Ok(active_exact);
    }
    if !exact.is_empty() && inbox_message.duplicate_of.is_none() {
        return Ok(vec![]);
    }

    signal_message::Entity::find()
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
        .c(h!())
}

async fn promote_oldest_deleted_original_duplicate(
    config: &Config,
    resources: &ReceiveWorkerResources,
    redis: &mut redis::aio::ConnectionManager,
    txn: &DatabaseTransaction,
    deleted_inbox_message: &echo_inbox_message::Model,
    deleted_signal_message: &signal_message::Model,
    datasource_group_id: i64,
    group_master_key: &str,
) -> anyhow::Result<Vec<i64>> {
    let duplicate_inbox_messages = echo_inbox_message::Entity::find()
        .filter(
            echo_inbox_message::Column::DuplicateOf
                .eq(deleted_inbox_message.id),
        )
        .filter(echo_inbox_message::Column::Deleted.eq(false))
        .filter(
            echo_inbox_message::Column::GroupId
                .eq(deleted_inbox_message.group_id),
        )
        .order_by_asc(echo_inbox_message::Column::CreatedAt)
        .order_by_asc(echo_inbox_message::Column::Id)
        .all(txn)
        .await
        .c(h!())?;

    for duplicate_inbox_message in duplicate_inbox_messages {
        let duplicate_signal_message =
            load_promotable_duplicate_signal_message(
                txn,
                duplicate_inbox_message.id,
                datasource_group_id,
            )
            .await
            .c(h!())?;
        let Some(duplicate_signal_message) = duplicate_signal_message else {
            continue;
        };
        if !duplicate_signal_message.deleted {
            return Ok(vec![]);
        }

        let echo_attachments =
            load_echo_attachments(txn, duplicate_inbox_message.id)
                .await
                .c(h!())?;
        let body = duplicate_signal_message.body.clone().unwrap_or_default();
        let is_media_only = body.trim().is_empty();
        if is_media_only
            && !can_restore_media_only_duplicate(config, &echo_attachments)
                .await
        {
            warn!(
                "skipping media-only duplicate restore: deleted_inbox_id={} duplicate_inbox_id={} duplicate_signal_message_id={}",
                deleted_inbox_message.id,
                duplicate_inbox_message.id,
                duplicate_signal_message.id,
            );
            continue;
        }

        if is_media_only
            && !store_promoted_duplicate_media(
                config,
                &resources.s3,
                txn,
                duplicate_signal_message.id,
                &echo_attachments,
            )
            .await
            .c(h!())?
        {
            continue;
        }

        let promoted_signal_message = restore_duplicate_signal_message(
            config,
            txn,
            duplicate_signal_message,
            group_master_key,
        )
        .await
        .c(h!())?;

        if !is_media_only
            && !echo_attachments.is_empty()
            && !store_promoted_duplicate_media(
                config,
                &resources.s3,
                txn,
                promoted_signal_message.id,
                &echo_attachments,
            )
            .await
            .c(h!())?
        {
            warn!(
                "restored text duplicate without media: deleted_inbox_id={} duplicate_inbox_id={} duplicate_signal_message_id={}",
                deleted_inbox_message.id,
                duplicate_inbox_message.id,
                promoted_signal_message.id,
            );
        }

        let changed_inbox_item_ids = ensure_promoted_inbox_item(
            config,
            resources,
            txn,
            promoted_signal_message.id,
        )
        .await
        .c(h!())?;
        let annotation_target_ids = if changed_inbox_item_ids.is_empty() {
            vec![promoted_signal_message.id]
        } else {
            changed_inbox_item_ids.clone()
        };
        copy_deleted_message_annotations(
            txn,
            deleted_signal_message.id,
            &annotation_target_ids,
        )
        .await
        .c(h!())?;
        resolve_duplicate_missing_message(txn, duplicate_inbox_message.id)
            .await
            .c(h!())?;
        set_signal_message_dedupe_key(
            redis,
            &promoted_signal_message.body.clone().unwrap_or_default(),
            promoted_signal_message.attachments_hash.as_deref(),
            promoted_signal_message.id,
        )
        .await
        .c(h!())?;
        return Ok(changed_inbox_item_ids);
    }

    clear_signal_message_dedupe_key(
        redis,
        &deleted_signal_message.body.clone().unwrap_or_default(),
        deleted_signal_message.attachments_hash.as_deref(),
    )
    .await
    .c(h!())?;
    Ok(vec![])
}

async fn load_promotable_duplicate_signal_message(
    txn: &DatabaseTransaction,
    duplicate_inbox_id: i32,
    datasource_group_id: i64,
) -> anyhow::Result<Option<signal_message::Model>> {
    signal_message::Entity::find()
        .filter(
            signal_message::Column::EchoInboxMessageId
                .eq(i64::from(duplicate_inbox_id)),
        )
        .filter(
            signal_message::Column::DatasourceGroupId.eq(datasource_group_id),
        )
        .one(txn)
        .await
        .c(h!())
}

async fn load_echo_attachments(
    txn: &DatabaseTransaction,
    inbox_message_id: i32,
) -> anyhow::Result<Vec<echo_attachment::Model>> {
    echo_attachment::Entity::find()
        .filter(echo_attachment::Column::MessageId.eq(inbox_message_id))
        .all(txn)
        .await
        .c(h!())
}

async fn can_restore_media_only_duplicate(
    config: &Config,
    echo_attachments: &[echo_attachment::Model],
) -> bool {
    if echo_attachments.is_empty() || config.s3_config.is_none() {
        return false;
    }
    for attachment in echo_attachments {
        if tokio::fs::metadata(&attachment.path).await.is_err() {
            return false;
        }
    }
    true
}

async fn restore_duplicate_signal_message(
    config: &Config,
    txn: &DatabaseTransaction,
    signal_message: signal_message::Model,
    group_master_key: &str,
) -> anyhow::Result<signal_message::Model> {
    let mut signal_message = signal_message.into_active_model();
    signal_message.deleted = Set(false);
    let signal_message = signal_message.update(txn).await.c(h!())?;
    let signal_message = crate::messenger::id::update_message_with_uid(
        txn,
        config,
        signal_message,
    )
    .await
    .c(h!())?;
    ensure_promoted_signal_message_group(
        txn,
        &signal_message,
        group_master_key,
    )
    .await
    .c(h!())?;
    Ok(signal_message)
}

async fn ensure_promoted_signal_message_group(
    txn: &DatabaseTransaction,
    signal_message: &signal_message::Model,
    group_master_key: &str,
) -> anyhow::Result<()> {
    let existing = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(signal_message.id),
        )
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq(Some(group_master_key.to_string())),
        )
        .one(txn)
        .await
        .c(h!())?;

    match existing {
        Some(existing) => {
            let mut existing = existing.into_active_model();
            existing.sender = Set(signal_message.sender.clone());
            existing.message_uid = Set(signal_message.message_uid.clone());
            existing.datasource_group_id =
                Set(signal_message.datasource_group_id);
            existing.update(txn).await.c(h!())?;
        }
        None => {
            signal_message_group::ActiveModel {
                id: NotSet,
                signal_message_id: Set(signal_message.id),
                group_master_key: Set(Some(group_master_key.to_string())),
                sender: Set(signal_message.sender.clone()),
                message_uid: Set(signal_message.message_uid.clone()),
                datasource_group_id: Set(signal_message.datasource_group_id),
                created_at: Set(signal_message.created_at),
            }
            .insert(txn)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn store_promoted_duplicate_media(
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    echo_attachments: &[echo_attachment::Model],
) -> anyhow::Result<bool> {
    if echo_attachments.is_empty() {
        return Ok(true);
    }
    let upload_inputs = echo_attachments
        .iter()
        .map(|attachment| crate::messenger::media::MediaUploadInput {
            path: attachment.path.clone(),
            name: attachment.name.clone(),
            content_type: None,
        })
        .collect_vec();
    match crate::messenger::media::store_media_attachments(
        &upload_inputs,
        signal_message_id,
        config,
        s3,
        txn,
        false,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(err) => {
            warn!(
                "failed to store promoted duplicate media for signal_message_id={signal_message_id}: {:?}",
                err
            );
            Ok(false)
        }
    }
}

async fn ensure_promoted_inbox_item(
    config: &Config,
    resources: &ReceiveWorkerResources,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
) -> anyhow::Result<Vec<i64>> {
    if sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .is_some()
    {
        return Ok(vec![signal_message_id]);
    }
    let changed_inbox_item_ids =
        crate::rer_importer::bgworker::process_message_to_inbox_nofail(
            resources.settlements.clone(),
            txn,
            &resources.rq,
            config,
            signal_message_id,
            None,
        )
        .await;
    crate::sigint::worker::incoming_message_after_insert(
        txn,
        signal_message_id,
    )
    .await
    .c(h!())?;
    Ok(changed_inbox_item_ids)
}

async fn copy_deleted_message_annotations(
    txn: &DatabaseTransaction,
    deleted_signal_message_id: i64,
    promoted_signal_message_ids: &[i64],
) -> anyhow::Result<()> {
    for promoted_signal_message_id in promoted_signal_message_ids {
        copy_deleted_message_comments(
            txn,
            deleted_signal_message_id,
            *promoted_signal_message_id,
        )
        .await
        .c(h!())?;
        copy_deleted_message_bookmarks(
            txn,
            deleted_signal_message_id,
            *promoted_signal_message_id,
        )
        .await
        .c(h!())?;
        copy_deleted_message_important_marks(
            txn,
            deleted_signal_message_id,
            *promoted_signal_message_id,
        )
        .await
        .c(h!())?;
        copy_deleted_message_tags(
            txn,
            deleted_signal_message_id,
            *promoted_signal_message_id,
        )
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_deleted_message_comments(
    txn: &DatabaseTransaction,
    deleted_signal_message_id: i64,
    promoted_signal_message_id: i64,
) -> anyhow::Result<()> {
    let comments = sigint_comment::Entity::find()
        .filter(
            sigint_comment::Column::SignalMessageId
                .eq(deleted_signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    let existing = sigint_comment::Entity::find()
        .filter(
            sigint_comment::Column::SignalMessageId
                .eq(promoted_signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    for comment in comments {
        let exists = existing.iter().any(|existing| {
            existing.login == comment.login
                && existing.comment == comment.comment
                && existing.sigint_post_id == comment.sigint_post_id
        });
        if exists {
            continue;
        }
        sigint_comment::ActiveModel {
            id: NotSet,
            login: Set(comment.login),
            signal_message_id: Set(promoted_signal_message_id),
            comment: Set(comment.comment),
            created_at: Set(comment.created_at),
            sigint_post_id: Set(comment.sigint_post_id),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_deleted_message_bookmarks(
    txn: &DatabaseTransaction,
    deleted_signal_message_id: i64,
    promoted_signal_message_id: i64,
) -> anyhow::Result<()> {
    let bookmarks = sigint_bookmark::Entity::find()
        .filter(
            sigint_bookmark::Column::SignalMessageId
                .eq(deleted_signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    let existing_user_ids = sigint_bookmark::Entity::find()
        .select_only()
        .column(sigint_bookmark::Column::UserId)
        .filter(
            sigint_bookmark::Column::SignalMessageId
                .eq(promoted_signal_message_id),
        )
        .into_tuple::<String>()
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    for bookmark in bookmarks {
        if existing_user_ids.contains(&bookmark.user_id) {
            continue;
        }
        sigint_bookmark::ActiveModel {
            id: NotSet,
            user_id: Set(bookmark.user_id),
            signal_message_id: Set(promoted_signal_message_id),
            created_at: Set(bookmark.created_at),
            deleted: Set(bookmark.deleted),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_deleted_message_important_marks(
    txn: &DatabaseTransaction,
    deleted_signal_message_id: i64,
    promoted_signal_message_id: i64,
) -> anyhow::Result<()> {
    let marks = sigint_important::Entity::find()
        .filter(
            sigint_important::Column::SignalMessageId
                .eq(deleted_signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    let existing_user_ids = sigint_important::Entity::find()
        .select_only()
        .column(sigint_important::Column::UserId)
        .filter(
            sigint_important::Column::SignalMessageId
                .eq(promoted_signal_message_id),
        )
        .into_tuple::<Option<String>>()
        .all(txn)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    for mark in marks {
        if existing_user_ids.contains(&mark.user_id) {
            continue;
        }
        sigint_important::ActiveModel {
            id: NotSet,
            user_id: Set(mark.user_id),
            signal_message_id: Set(promoted_signal_message_id),
            created_at: Set(mark.created_at),
            deleted: Set(mark.deleted),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn copy_deleted_message_tags(
    txn: &DatabaseTransaction,
    deleted_signal_message_id: i64,
    promoted_signal_message_id: i64,
) -> anyhow::Result<()> {
    if sigint_inbox_item::Entity::find_by_id(promoted_signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .is_none()
    {
        warn!(
            "skipping promoted tag copy without sigint_inbox_item: deleted_signal_message_id={} promoted_signal_message_id={}",
            deleted_signal_message_id,
            promoted_signal_message_id,
        );
        return Ok(());
    }
    let tags = sigint_inbox_item_tag::Entity::find()
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq(deleted_signal_message_id),
        )
        .filter(sigint_inbox_item_tag::Column::Model.is_null())
        .all(txn)
        .await
        .c(h!())?;
    let existing = sigint_inbox_item_tag::Entity::find()
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq(promoted_signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    for tag in tags {
        let exists = existing.iter().any(|existing| {
            existing.tag_id == tag.tag_id
                && existing.login == tag.login
                && existing.model == tag.model
        });
        if exists {
            continue;
        }
        sigint_inbox_item_tag::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(promoted_signal_message_id),
            tag_id: Set(tag.tag_id),
            confidence: Set(tag.confidence),
            login: Set(tag.login),
            model: Set(tag.model),
        }
        .insert(txn)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn resolve_duplicate_missing_message(
    txn: &DatabaseTransaction,
    duplicate_inbox_id: i32,
) -> anyhow::Result<()> {
    let Some(missing_message) = echo_missing_message::Entity::find()
        .filter(echo_missing_message::Column::MessageId.eq(duplicate_inbox_id))
        .filter(
            echo_missing_message::Column::Status
                .eq(EchoMissingMessageStatus::Duplicate),
        )
        .one(txn)
        .await
        .c(h!())?
    else {
        return Ok(());
    };
    crate::messenger::missing_message::mark_missing_message_resolved(
        txn,
        missing_message,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn clear_signal_message_dedupe_key(
    redis: &mut redis::aio::ConnectionManager,
    body: &str,
    attachments_hash: Option<&str>,
) -> anyhow::Result<()> {
    let key =
        crate::messenger::dedupe::redis_key_for_body_with_attachments_hash(
            body,
            attachments_hash,
        );
    redis::cmd("DEL")
        .arg(key)
        .query_async::<()>(redis)
        .await
        .c(h!())?;
    Ok(())
}

async fn set_signal_message_dedupe_key(
    redis: &mut redis::aio::ConnectionManager,
    body: &str,
    attachments_hash: Option<&str>,
    signal_message_id: i64,
) -> anyhow::Result<()> {
    let key =
        crate::messenger::dedupe::redis_key_for_body_with_attachments_hash(
            body,
            attachments_hash,
        );
    redis::cmd("SET")
        .arg(key)
        .arg(signal_message_id.to_string())
        .arg("EX")
        .arg(REDIS_MGS_ID_TTL)
        .query_async::<()>(redis)
        .await
        .c(h!())?;
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
    use crate::functest::tests::{
        cleanup, mk_datasource, mk_login, mk_sigint_bookmark,
        mk_sigint_comment, mk_sigint_important, mk_sigint_inbox_item,
        mk_sigint_inbox_item_tag,
    };

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_event_promotes_oldest_duplicate_and_creates_inbox_item() {
        let env = cleanup().await.unwrap();
        let datasource =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let echo_account = mk_test_echo_account(&env.dbx).await;
        let echo_group =
            mk_test_echo_group(&env.dbx, echo_account.id, "delete-dupe-group")
                .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                echo_group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        let ts = Utc::now().naive_utc();
        let original_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            "plain delete duplicate message",
            ts,
            None,
            true,
        )
        .await;
        let duplicate_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            &original_inbox.body,
            ts + chrono::TimeDelta::seconds(1),
            Some(original_inbox.id),
            false,
        )
        .await;
        let original_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            false,
            Some(i64::from(original_inbox.id)),
            Some("uid-original".to_string()),
        )
        .await;
        mk_test_signal_message_group(
            &env.dbx,
            original_signal_message.id,
            &echo_group.group_id,
            datasource_group_id,
            original_signal_message.message_uid.clone(),
        )
        .await;
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            true,
            Some(i64::from(duplicate_inbox.id)),
            Some("duplicate-trace-test".to_string()),
        )
        .await;
        mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("delete-dupe-user".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login: Set("delete-dupe-user".to_string()),
                signal_message_id: Set(original_signal_message.id),
                comment: Set("keep comment".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &env.dbx,
            sigint_bookmark::ActiveModel {
                user_id: Set("delete-dupe-user".to_string()),
                signal_message_id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &env.dbx,
            sigint_important::ActiveModel {
                user_id: Set(Some("delete-dupe-user".to_string())),
                signal_message_id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let original_tag = mk_sigint_inbox_item_tag(
            &env.dbx,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(original_signal_message.id),
                login: Set(Some("delete-dupe-user".to_string())),
                model: Set(None),
                confidence: Set(0.75),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        crate::messenger::missing_message::record_duplicate_missing_message(
            &env.dbx,
            duplicate_inbox.id,
        )
        .await
        .unwrap();
        let resources = ReceiveWorkerResources {
            settlements: env.settlements.clone(),
            rq: env.rq.clone(),
            s3: env.s3.clone(),
        };
        let mut redis = env.redis.clone();
        let mut changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();

        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(original_inbox.id),
            &txn,
            &mut changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let original_signal_message =
            signal_message::Entity::find_by_id(original_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let duplicate_signal_message =
            signal_message::Entity::find_by_id(duplicate_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(original_signal_message.deleted);
        assert!(!duplicate_signal_message.deleted);
        assert_ne!(
            duplicate_signal_message.message_uid.as_deref(),
            Some("duplicate-trace-test")
        );
        assert_ne!(
            duplicate_signal_message.message_uid,
            original_signal_message.message_uid
        );
        assert!(changed_inbox_item_ids.contains(&duplicate_signal_message.id));
        assert!(sigint_inbox_item::Entity::find_by_id(
            duplicate_signal_message.id
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
        let promoted_group = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(duplicate_signal_message.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            promoted_group.message_uid,
            duplicate_signal_message.message_uid
        );
        assert_eq!(
            annotation_counts(&env.dbx, duplicate_signal_message.id).await,
            (1, 1, 1)
        );
        assert_eq!(
            manual_tag_count(
                &env.dbx,
                duplicate_signal_message.id,
                original_tag.tag_id,
            )
            .await,
            1
        );
        let mut repeated_changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();
        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(original_inbox.id),
            &txn,
            &mut repeated_changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        let duplicate_signal_message =
            signal_message::Entity::find_by_id(duplicate_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(!duplicate_signal_message.deleted);
        assert!(repeated_changed_inbox_item_ids.is_empty());
        let missing_message = echo_missing_message::Entity::find()
            .filter(
                echo_missing_message::Column::MessageId.eq(duplicate_inbox.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Resolved);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_event_commits_promotion_when_inbox_parsing_fails() {
        let env = cleanup().await.unwrap();
        let datasource =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let echo_account = mk_test_echo_account(&env.dbx).await;
        let echo_group =
            mk_test_echo_group(&env.dbx, echo_account.id, "parse-fail-group")
                .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                echo_group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        let ts = Utc::now().naive_utc();
        let original_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            "11:20 123.45 TEST",
            ts,
            None,
            true,
        )
        .await;
        let duplicate_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            &original_inbox.body,
            ts + chrono::TimeDelta::seconds(1),
            Some(original_inbox.id),
            false,
        )
        .await;
        let original_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            false,
            Some(i64::from(original_inbox.id)),
            Some("uid-parse-fail-original".to_string()),
        )
        .await;
        let duplicate_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            true,
            Some(i64::from(duplicate_inbox.id)),
            Some("duplicate-trace-parse-fail".to_string()),
        )
        .await;
        let resources = ReceiveWorkerResources {
            settlements: env.settlements.clone(),
            rq: env.rq.clone(),
            s3: env.s3.clone(),
        };
        let mut redis = env.redis.clone();
        let mut changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();

        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(original_inbox.id),
            &txn,
            &mut changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let original_signal_message =
            signal_message::Entity::find_by_id(original_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let duplicate_signal_message =
            signal_message::Entity::find_by_id(duplicate_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(original_signal_message.deleted);
        assert!(!duplicate_signal_message.deleted);
        assert!(changed_inbox_item_ids.contains(&duplicate_signal_message.id));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_event_for_duplicate_trace_uses_fallback() {
        let env = cleanup().await.unwrap();
        let datasource =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let echo_account = mk_test_echo_account(&env.dbx).await;
        let echo_group =
            mk_test_echo_group(&env.dbx, echo_account.id, "trace-dupe-group")
                .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                echo_group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        let ts = Utc::now().naive_utc();
        let original_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            "duplicate trace fallback",
            ts,
            None,
            false,
        )
        .await;
        let duplicate_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            &original_inbox.body,
            ts,
            Some(original_inbox.id),
            true,
        )
        .await;
        let canonical_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            false,
            Some(i64::from(original_inbox.id)),
            Some("uid-trace-canonical".to_string()),
        )
        .await;
        let duplicate_trace_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &original_inbox.body,
            ts,
            true,
            Some(i64::from(duplicate_inbox.id)),
            Some("duplicate-trace-delete".to_string()),
        )
        .await;
        let resources = ReceiveWorkerResources {
            settlements: env.settlements.clone(),
            rq: env.rq.clone(),
            s3: env.s3.clone(),
        };
        let mut redis = env.redis.clone();
        let mut changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();

        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(duplicate_inbox.id),
            &txn,
            &mut changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        assert!(
            signal_message::Entity::find_by_id(canonical_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            signal_message::Entity::find_by_id(
                duplicate_trace_signal_message.id
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .deleted
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_event_fans_out_split_promoted_inbox_items() {
        let env = cleanup().await.unwrap();
        let datasource =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let echo_account = mk_test_echo_account(&env.dbx).await;
        let echo_group =
            mk_test_echo_group(&env.dbx, echo_account.id, "split-dupe-group")
                .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                echo_group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        let body = split_promoted_body();
        let ts = Utc::now().naive_utc();
        let original_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            &body,
            ts,
            None,
            true,
        )
        .await;
        let duplicate_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            &body,
            ts + chrono::TimeDelta::seconds(1),
            Some(original_inbox.id),
            false,
        )
        .await;
        let original_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &body,
            ts,
            false,
            Some(i64::from(original_inbox.id)),
            Some("uid-split-original".to_string()),
        )
        .await;
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("split-dupe-user".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login: Set("split-dupe-user".to_string()),
                signal_message_id: Set(original_signal_message.id),
                comment: Set("split comment".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &env.dbx,
            sigint_bookmark::ActiveModel {
                user_id: Set("split-dupe-user".to_string()),
                signal_message_id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &env.dbx,
            sigint_important::ActiveModel {
                user_id: Set(Some("split-dupe-user".to_string())),
                signal_message_id: Set(original_signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let original_tag = mk_sigint_inbox_item_tag(
            &env.dbx,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(original_signal_message.id),
                login: Set(Some("split-dupe-user".to_string())),
                model: Set(None),
                confidence: Set(0.9),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            &body,
            ts,
            true,
            Some(i64::from(duplicate_inbox.id)),
            Some("duplicate-trace-split".to_string()),
        )
        .await;
        let resources = ReceiveWorkerResources {
            settlements: env.settlements.clone(),
            rq: env.rq.clone(),
            s3: env.s3.clone(),
        };
        let mut redis = env.redis.clone();
        let mut changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();

        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(original_inbox.id),
            &txn,
            &mut changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        assert!(!changed_inbox_item_ids.is_empty());
        assert!(!changed_inbox_item_ids.contains(&duplicate_signal_message.id));
        for changed_inbox_item_id in changed_inbox_item_ids {
            assert!(sigint_inbox_item::Entity::find_by_id(
                changed_inbox_item_id
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
            assert_eq!(
                annotation_counts(&env.dbx, changed_inbox_item_id).await,
                (1, 1, 1)
            );
            assert_eq!(
                manual_tag_count(
                    &env.dbx,
                    changed_inbox_item_id,
                    original_tag.tag_id,
                )
                .await,
                1
            );
        }
        assert!(
            signal_message::Entity::find_by_id(original_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_event_does_not_promote_media_only_duplicate_without_media()
    {
        let env = cleanup().await.unwrap();
        let datasource =
            mk_datasource(&env.dbx, Default::default()).await.unwrap();
        let echo_account = mk_test_echo_account(&env.dbx).await;
        let echo_group =
            mk_test_echo_group(&env.dbx, echo_account.id, "media-dupe-group")
                .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                echo_group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        let ts = Utc::now().naive_utc();
        let original_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            "",
            ts,
            None,
            true,
        )
        .await;
        let duplicate_inbox = mk_test_echo_inbox_message(
            &env.dbx,
            echo_account.id,
            echo_group.id,
            "",
            ts + chrono::TimeDelta::seconds(1),
            Some(original_inbox.id),
            false,
        )
        .await;
        let original_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            "",
            ts,
            false,
            Some(i64::from(original_inbox.id)),
            Some("uid-media-original".to_string()),
        )
        .await;
        let duplicate_signal_message = mk_test_signal_message(
            &env.dbx,
            datasource_group_id,
            "",
            ts,
            true,
            Some(i64::from(duplicate_inbox.id)),
            Some("duplicate-trace-media".to_string()),
        )
        .await;
        let resources = ReceiveWorkerResources {
            settlements: env.settlements.clone(),
            rq: env.rq.clone(),
            s3: env.s3.clone(),
        };
        let mut redis = env.redis.clone();
        let mut changed_inbox_item_ids = vec![];
        let txn = env.dbx.begin().await.unwrap();

        mark_message_deleted(
            &env.config,
            &resources,
            &mut redis,
            datasource.id,
            i64::from(original_inbox.id),
            &txn,
            &mut changed_inbox_item_ids,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();

        let original_signal_message =
            signal_message::Entity::find_by_id(original_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        let duplicate_signal_message =
            signal_message::Entity::find_by_id(duplicate_signal_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(original_signal_message.deleted);
        assert!(duplicate_signal_message.deleted);
        assert!(changed_inbox_item_ids.is_empty());
    }

    async fn mk_test_echo_account(
        dbx: &DatabaseConnection,
    ) -> echo_account::Model {
        let now = Utc::now().naive_utc();
        let phone_seed = Uuid::new_v4().simple().to_string();
        echo_account::ActiveModel {
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
        .unwrap()
    }

    async fn mk_test_echo_group(
        dbx: &DatabaseConnection,
        account_id: i32,
        group_id: &str,
    ) -> echo_group::Model {
        let now = Utc::now().naive_utc();
        echo_group::ActiveModel {
            id: NotSet,
            group_id: Set(group_id.to_string()),
            internal_id: Set(Some(format!("internal-{group_id}"))),
            name: Set(Some(group_id.to_string())),
            account_id: Set(account_id),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_by_messanger: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_test_echo_inbox_message(
        dbx: &DatabaseConnection,
        account_id: i32,
        group_id: i32,
        body: &str,
        created_at: NaiveDateTime,
        duplicate_of: Option<i32>,
        deleted: bool,
    ) -> echo_inbox_message::Model {
        echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(body.to_string()),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(duplicate_of),
            sender_id: Set(None),
            group_id: Set(Some(group_id)),
            account_id: Set(account_id),
            created_at: Set(created_at),
            timestamp: Set(Some(created_at)),
            updated_at: Set(created_at),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(deleted),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_test_signal_message(
        dbx: &DatabaseConnection,
        datasource_group_id: i64,
        body: &str,
        timestamp: NaiveDateTime,
        deleted: bool,
        echo_inbox_message_id: Option<i64>,
        message_uid: Option<String>,
    ) -> signal_message::Model {
        signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(body.to_string())),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: Set(timestamp),
            timestamp: Set(Some(timestamp)),
            sender: Set(Some("sender-test".to_string())),
            format: Set(None),
            deleted: Set(deleted),
            external_id: Set(None),
            echo_inbox_message_id: Set(echo_inbox_message_id),
            message_uid: Set(message_uid),
            operator_tags: Set(None),
            attachments_hash: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_test_signal_message_group(
        dbx: &DatabaseConnection,
        signal_message_id: i64,
        group_master_key: &str,
        datasource_group_id: i64,
        message_uid: Option<String>,
    ) -> signal_message_group::Model {
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(signal_message_id),
            group_master_key: Set(Some(group_master_key.to_string())),
            sender: Set(Some("sender-test".to_string())),
            message_uid: Set(message_uid),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: Set(Utc::now().naive_utc()),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn annotation_counts(
        dbx: &DatabaseConnection,
        signal_message_id: i64,
    ) -> (u64, u64, u64) {
        let comments = sigint_comment::Entity::find()
            .filter(
                sigint_comment::Column::SignalMessageId.eq(signal_message_id),
            )
            .count(dbx)
            .await
            .unwrap();
        let bookmarks = sigint_bookmark::Entity::find()
            .filter(
                sigint_bookmark::Column::SignalMessageId.eq(signal_message_id),
            )
            .count(dbx)
            .await
            .unwrap();
        let important = sigint_important::Entity::find()
            .filter(
                sigint_important::Column::SignalMessageId.eq(signal_message_id),
            )
            .count(dbx)
            .await
            .unwrap();
        (comments, bookmarks, important)
    }

    async fn manual_tag_count(
        dbx: &DatabaseConnection,
        signal_message_id: i64,
        tag_id: i64,
    ) -> u64 {
        sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq(signal_message_id),
            )
            .filter(sigint_inbox_item_tag::Column::TagId.eq(tag_id))
            .filter(sigint_inbox_item_tag::Column::Model.is_null())
            .count(dbx)
            .await
            .unwrap()
    }

    fn split_promoted_body() -> String {
        let filler = "plain promoted split line\n".repeat(140);
        format!("03.04, 05:45:53\n{filler}03.04, 05:46:53\n{filler}")
    }

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
}
