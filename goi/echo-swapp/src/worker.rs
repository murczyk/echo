use crate::{automation, error::ShortContext, h, messenger};
use sea_orm::DatabaseConnection;
use tokio::time::{sleep, Duration};

const MESSENGER_WORKER_SLEEP_MS: u64 = 5_000;
const CLEANUP_WORKER_SLEEP_MS: u64 = 60_000;

pub fn spawn_workers(db: DatabaseConnection) {
    tokio::spawn(messenger_worker(db.clone()));
    tokio::spawn(cleanup_worker(db));
}

async fn messenger_worker(db: DatabaseConnection) {
    log::info!("starting echo-swapp messenger worker");
    loop {
        if let Err(err) = messenger_worker_tick(&db).await {
            log::error!("echo-swapp messenger worker tick failed: {err:#}");
        }
        sleep(Duration::from_millis(MESSENGER_WORKER_SLEEP_MS)).await;
    }
}

async fn messenger_worker_tick(db: &DatabaseConnection) -> anyhow::Result<()> {
    if messenger::global_is_paused(db).await.c(h!())? {
        return Ok(());
    }
    let messengers = messenger::list(db).await.c(h!())?;
    for messenger in messengers {
        if messenger.is_paused {
            continue;
        }
        let is_linked =
            messenger::is_linked(db, &messenger.name, messenger.kind)
                .await
                .c(h!())?;
        if !is_linked {
            continue;
        }
        messenger::refresh_groups(db, &messenger.name, messenger.kind)
            .await
            .c(h!())?;
    }
    automation::worker_tick(db).await.c(h!())?;
    Ok(())
}

async fn cleanup_worker(db: DatabaseConnection) {
    log::info!("starting echo-swapp cleanup worker");
    loop {
        if let Err(err) = automation::delete_expired_send_log(&db).await {
            log::error!(
                "echo-swapp automation send log cleanup failed: {err:#}"
            );
        }
        if let Err(err) = echo_im::worker::run_cleanup_worker(&db).await {
            log::error!("echo-swapp cleanup worker failed: {err:#}");
        }
        sleep(Duration::from_millis(CLEANUP_WORKER_SLEEP_MS)).await;
    }
}
