use crate::config::*;
use crate::messenger::worker::pool::ProcessorPool;
use crate::messenger::worker::*;
use crate::utils::orm::ArrayColumnOps;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

/// Worker which ultimately consumes [signal_message_queue](crate::entities::signal_message_queue) rows
///
/// - TODO: document producers, consumers etc.
/// - at the end main processing business logic is done by [process_signal_message_queue_item](crate::message_queue::process_signal_message_queue_item)
pub async fn process_queue_nofail(mode: Mode, cancel_token: CancellationToken) {
    loop {
        if let Err(e) = process_queue_inner(mode, &cancel_token).await {
            error!("process_queue_inner encountered an error: {:?}", e);
            sleep(Duration::from_millis(MESSENGER_WORKER_LONG_SLEEP_MS)).await;
        }
        sleep(Duration::from_millis(MESSENGER_WORKER_IDLE_SLEEP_MS)).await;
    }
}

pub async fn process_queue_inner(
    mode: Mode,
    cancel_token: &CancellationToken,
) -> Result<(), AppError> {
    let config = read_config(mode).c(h!())?;
    let dbx = crate::new_pg_pool_from_config(&config).await.c(h!())?;

    info!("started process_queue_inner");

    let mut worker_pool =
        crate::messenger::worker::pool::mk_message_processor_pool(mode)
            .await
            .c(h!())?;

    loop {
        if cancel_token.is_cancelled() {
            info!("cancel token received, stopping process_queue_inner...");
            return Ok(());
        }
        let has_items = process_queue_inner_iteration(&mut worker_pool, &dbx)
            .await
            .c(h!())?;
        let sleep_duration = if has_items {
            MESSENGER_WORKER_IDLE_SLEEP_MS
        } else {
            MESSENGER_WORKER_LONG_SLEEP_MS
        };
        sleep(Duration::from_millis(sleep_duration)).await;
    }
}

/// - Pull [signal_message_queue](crate::entities::signal_message_queue) rows in batches
async fn process_queue_inner_iteration(
    worker_pool: &mut ProcessorPool,
    dbx: &DatabaseConnection,
) -> Result<bool, AppError> {
    let datasources = list_echo_accounts(None, dbx).await.c(h!())?;
    let datasource_ids = datasources
        .iter()
        .filter(|a| a.is_linked)
        .map(|a| a.id)
        .collect_vec();
    let next_items = signal_message_queue::Entity::find()
        .filter(
            signal_message_queue::Column::DatasourceId.eq_any(datasource_ids),
        )
        .order_by_asc(signal_message_queue::Column::CreatedAt)
        .limit(MESSENGER_WORKER_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())?;
    if next_items.is_empty() {
        return Ok(false);
    }
    let signal_message_queue_ids =
        next_items.iter().map(|a| a.id).collect_vec();
    let attachments = if signal_message_queue_ids.is_empty() {
        vec![]
    } else {
        signal_message_queue_attachment::Entity::find()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .eq_any(signal_message_queue_ids),
            )
            .all(dbx)
            .await
            .c(h!())?
    };
    crate::messenger::worker::pool::process_queue(
        worker_pool,
        next_items.clone(),
        attachments.clone(),
        datasources,
    )
    .await
    .c(h!())?;
    Ok(true)
}
