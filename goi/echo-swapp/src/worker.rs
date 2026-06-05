use crate::messenger::{self, MessengerKind};
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
    let messengers = messenger::list(db).await?;
    for messenger in messengers {
        let is_linked = if messenger.is_linked {
            true
        } else {
            messenger::is_linked(db, &messenger.name, messenger.kind).await?
        };
        if !is_linked {
            continue;
        }
        match messenger.kind {
            MessengerKind::Signal => {
                echo_im::worker::signal_worker_tick_once(&messenger.name, db)
                    .await?
            }
            MessengerKind::Whatsapp => {
                echo_im::worker::whatsapp_worker_tick_once(&messenger.name, db)
                    .await?
            }
        }
    }
    Ok(())
}

async fn cleanup_worker(db: DatabaseConnection) {
    log::info!("starting echo-swapp cleanup worker");
    loop {
        if let Err(err) = echo_im::worker::run_cleanup_worker(&db).await {
            log::error!("echo-swapp cleanup worker failed: {err:#}");
        }
        sleep(Duration::from_millis(CLEANUP_WORKER_SLEEP_MS)).await;
    }
}
