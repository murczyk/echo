use crate::config::*;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::new_pg_pool_from_mode;
use crate::types::*;
use sea_orm::*;
use tokio::time::{sleep, Duration};

pub async fn run_cleanup_worker(mode: Mode) {
    loop {
        let db = match new_pg_pool_from_mode(mode).await {
            Ok(db) => db,
            Err(e) => {
                error!(
                    "Messenger Cleanup worker failed, cannot establish db connection: {:#?}",
                    e
                );
                sleep(Duration::from_secs(MESSENGER_CLEANUP_ERR_SLEEP_SEC))
                    .await;
                continue;
            }
        };
        if let Err(e) = echo_im::worker::run_cleanup_worker(&db).await {
            error!("Messenger Cleanup worker failed: {:#?}", e);
            sleep(Duration::from_secs(15)).await;
        }
        match has_active_im_datasources(&db).await {
            Ok(true) => {
                echo_im::worker::cleanup_signal_attachment_worker_once(&db)
                    .await;
            }
            Ok(false) => {}
            Err(e) => error!(
                "Messenger Cleanup worker failed while checking active datasources: {:#?}",
                e
            ),
        }

        sleep(Duration::from_secs(MESSENGER_CLEANUP_OK_SLEEP_SEC)).await;
    }
}

async fn has_active_im_datasources(
    db: &DatabaseConnection,
) -> Result<bool, AppError> {
    let count = datasource::Entity::find()
        .filter(datasource::Column::Status.eq(AccountStatus::Active))
        .filter(datasource::Column::Deleted.eq(false))
        .filter(
            Condition::any()
                .add(datasource::Column::Kind.eq("signal"))
                .add(datasource::Column::Kind.eq("whatsapp")),
        )
        .count(db)
        .await
        .c(h!())?;

    Ok(count > 0)
}
