use crate::config::*;
use crate::new_pg_pool_from_mode;
use crate::types::*;
use tokio::time::{sleep, Duration};

pub async fn run_cleanup_worker(mode: Mode) {
    loop {
        let db = match new_pg_pool_from_mode(mode).await {
            Ok(db) => db,
            Err(e) => {
                error!("Messenger Cleanup worker failed, cannot establish db connection: {e:#?}");
                sleep(Duration::from_secs(MESSENGER_CLEANUP_ERR_SLEEP_SEC))
                    .await;
                continue;
            }
        };
        if let Err(e) = echo_im::worker::run_cleanup_worker(&db).await {
            error!("Messenger Cleanup worker failed: {e:#?}");
            sleep(Duration::from_secs(15)).await;
        }

        sleep(Duration::from_secs(MESSENGER_CLEANUP_OK_SLEEP_SEC)).await;
    }
}
