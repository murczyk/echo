use crate::{
    automation,
    chat_redis::ChatRedis,
    chats,
    config::{
        Config, AUTOMATION_WORKER_SLEEP_MILLIS,
        CHAT_REDIS_RECONNECT_SLEEP_MILLIS, CHAT_WORKER_SLEEP_MILLIS,
        MESSENGER_FULL_SYNC_WORKER_SLEEP_MILLIS,
        MESSENGER_SIGNAL_OUTBOX_WORKER_SLEEP_MILLIS,
    },
    error::ShortContext,
    h, messenger,
};
use sea_orm::DatabaseConnection;
use tokio::time::{sleep, Duration};

const CLEANUP_WORKER_SLEEP_MS: u64 = 60_000;

pub fn spawn_workers(
    db: DatabaseConnection,
    config: Config,
    chat_redis: ChatRedis,
) {
    tokio::spawn(messenger_worker(db.clone()));
    tokio::spawn(signal_outbox_worker(db.clone()));
    tokio::spawn(automation_worker(db.clone()));
    tokio::spawn(cleanup_worker(db.clone(), chat_redis.clone()));
    tokio::spawn(chat_worker(db.clone(), chat_redis.clone()));
    tokio::spawn(chat_redis_reconnect_worker(config, chat_redis));
    tokio::spawn(echo_install_utils::tmpdir::cleanup_tmp_worker_nofail());
}

async fn chat_worker(db: DatabaseConnection, chat_redis: ChatRedis) {
    log::info!("starting echo-messengers chat worker");
    loop {
        if let Err(err) = chats::ingestion_tick(&db, &chat_redis).await {
            log::error!("chat ingestion tick failed: {err:#}");
        }
        if let Err(err) = chats::webhook_tick(&db).await {
            log::error!("chat webhook delivery tick failed: {err:#}");
        }
        sleep(Duration::from_millis(CHAT_WORKER_SLEEP_MILLIS)).await;
    }
}

async fn chat_redis_reconnect_worker(config: Config, chat_redis: ChatRedis) {
    loop {
        match chat_redis.reconnect(&config).await {
            Ok(true) => log::info!("chat unread Redis connection restored"),
            Ok(false) => {}
            Err(err) => {
                log::warn!("chat unread Redis reconnect failed: {err:#}")
            }
        }
        sleep(Duration::from_millis(CHAT_REDIS_RECONNECT_SLEEP_MILLIS)).await;
    }
}

async fn automation_worker(db: DatabaseConnection) {
    log::info!("starting echo-messengers automation worker");
    loop {
        if let Err(err) = automation_worker_tick(&db).await {
            log::error!(
                "echo-messengers automation worker tick failed: {err:#}"
            );
        }
        sleep(Duration::from_millis(AUTOMATION_WORKER_SLEEP_MILLIS)).await;
    }
}

async fn automation_worker_tick(db: &DatabaseConnection) -> anyhow::Result<()> {
    if messenger::global_is_paused(db).await.c(h!())? {
        return Ok(());
    }
    automation::worker_tick(db).await.c(h!())
}

async fn signal_outbox_worker(db: DatabaseConnection) {
    log::info!("starting echo-messengers Signal outbox worker");
    loop {
        if let Err(err) = signal_outbox_worker_tick(&db).await {
            log::error!(
                "echo-messengers Signal outbox worker tick failed: {err:#}"
            );
        }
        sleep(Duration::from_millis(
            MESSENGER_SIGNAL_OUTBOX_WORKER_SLEEP_MILLIS,
        ))
        .await;
    }
}

async fn signal_outbox_worker_tick(
    db: &DatabaseConnection,
) -> anyhow::Result<()> {
    if messenger::global_is_paused(db).await.c(h!())? {
        return Ok(());
    }
    let names = messenger::signal_messengers_with_scheduled_messages(db)
        .await
        .c(h!())?;
    for name in names {
        if let Err(err) =
            messenger::send_next_scheduled_signal_message(db, &name).await
        {
            log::error!(
                "failed to send next scheduled Signal message for {name}: {err:#}"
            );
        }
    }
    Ok(())
}

async fn messenger_worker(db: DatabaseConnection) {
    log::info!("starting echo-messengers messenger worker");
    loop {
        if let Err(err) = messenger_worker_tick(&db).await {
            log::error!(
                "echo-messengers messenger worker tick failed: {err:#}"
            );
        }
        sleep(Duration::from_millis(
            MESSENGER_FULL_SYNC_WORKER_SLEEP_MILLIS,
        ))
        .await;
    }
}

async fn messenger_worker_tick(db: &DatabaseConnection) -> anyhow::Result<()> {
    if messenger::global_is_paused(db).await.c(h!())? {
        return Ok(());
    }
    let messengers = messenger::list(db).await.c(h!())?;
    for messenger in messengers {
        messenger::sync(db, &messenger.name).await.c(h!())?;
    }
    messenger::repair_blank_whatsapp_group_names(db)
        .await
        .c(h!())?;
    Ok(())
}

async fn cleanup_worker(db: DatabaseConnection, chat_redis: ChatRedis) {
    log::info!("starting echo-messengers cleanup worker");
    loop {
        if let Err(err) = automation::delete_expired_send_log(&db).await {
            log::error!(
                "echo-messengers automation send log cleanup failed: {err:#}"
            );
        }
        if let Err(err) = echo_im::worker::run_cleanup_worker(&db).await {
            log::error!("echo-messengers cleanup worker failed: {err:#}");
        }
        if let Err(err) = chats::prune_unread(&db, &chat_redis).await {
            log::error!("chat unread cleanup failed: {err:#}");
        }
        if let Err(err) = chats::cleanup_webhook_deliveries(&db).await {
            log::error!("chat webhook cleanup failed: {err:#}");
        }
        sleep(Duration::from_millis(CLEANUP_WORKER_SLEEP_MS)).await;
    }
}
