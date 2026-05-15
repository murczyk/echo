use crate::config::*;
use crate::entities::signal_message_queue;
use crate::entities::*;
use crate::location::SettlementsDataConfig;
use crate::messenger::types::{EchoAccountF1, Message};
use crate::types::*;
use crate::utils::setup_worker;
use echo_im::types::{MessageAttachmentF1, MessageF1, MessageSource, SenderF1};
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, TransactionTrait,
};

pub struct ProcessorPool {
    pub capacity: usize,
    pub join_set: JoinSet<ItemProcessingResult>,
    pub ctx: Arc<WorkerContext>,
}

#[derive(Clone)]
pub struct WorkerContext {
    pub config: Config,
    pub settlements: Arc<RwLock<SettlementsDataConfig>>,
    pub rq: Client,
    pub redis: ConnectionManager,
    pub dbx: DatabaseConnection,
    pub s3: Option<opendal::Operator>,
}

pub async fn process_queue(
    pool: &mut ProcessorPool,
    queue: Vec<signal_message_queue::Model>,
    attachments: Vec<signal_message_queue_attachment::Model>,
    datasources: Vec<EchoAccountF1>,
) -> anyhow::Result<()> {
    let ctx = pool.ctx.clone();
    let datasources = datasources
        .into_iter()
        .map(|d| (d.id, d))
        .collect::<HashMap<_, _>>();
    let mut item_queue = VecDeque::new();
    for entry in queue {
        if let Some(item) =
            make_item_from_entry(entry, &attachments, &datasources).c(h!())?
        {
            item_queue.push_back((item, 0));
        }
    }
    loop {
        // if queue is empty -  wait for remaining tasks, probably some should be retried
        if item_queue.is_empty() {
            let queue_is_empty_and_no_retries_left: bool =
                wait_for_remaining_tasks(pool, &mut item_queue)
                    .await
                    .c(h!())?;
            if queue_is_empty_and_no_retries_left {
                break;
            }
        }
        let (item, attempt_num) = item_queue.pop_front().c(h!())?;
        if pool.join_set.len() >= pool.capacity {
            trace!(
                "Concurrency limit reached. Waiting for a task to complete..."
            );
            if let Some(res) = pool.join_set.join_next().await {
                let result = match res {
                    Ok(res) => res,
                    Err(e) => {
                        // The join pool is poisoned, finish already-processed items and halt
                        error!("unexpected error occurred while processing inbox messages: {:#?}", e);
                        // this will get us closer to "break" the loop by emptying the queue
                        item_queue.clear();
                        continue;
                    }
                };
                if result.failed {
                    if result.attempt_num > 3 {
                        error!(
                            "failed to process item, dropping after 3 attempts: {:?}",
                            item
                        );
                    } else {
                        item_queue
                            .push_front((result.item, result.attempt_num + 1));
                    }
                } else {
                    delete_message_and_attachments_nofail(
                        &pool.ctx.dbx,
                        result.item.model.id,
                    )
                    .await;
                }
            } else {
                // impossible: the pool is empty
                continue;
            }
        }
        pool.join_set.spawn(process_item_nofail(
            item,
            attempt_num,
            ctx.clone(),
        ));
    }
    trace!("All tasks completed.");
    Ok(())
}

fn make_item_from_entry(
    entry: signal_message_queue::Model,
    attachments: &[signal_message_queue_attachment::Model],
    datasources: &HashMap<i64, EchoAccountF1>,
) -> anyhow::Result<Option<Item>> {
    let message_attachments = attachments
        .iter()
        .filter(|x| x.message_id.eq(&entry.id))
        .map(|a| MessageAttachmentF1 {
            path: a.path.clone(),
            name: a.name.clone(),
        })
        .collect();
    let src_entry = entry.clone();
    let datasource = datasources.get(&entry.datasource_id).c(h!())?;
    let sender = entry.sender_id.map(|id| SenderF1 {
        uuid: id,
        name: entry.sender_name,
        phone_number: entry.sender_phone_number,
    });
    let message_source = match datasource.messenger.to_lowercase().as_str() {
        "signal" => MessageSource::Signal,
        "whatsapp" => MessageSource::Whatsapp,
        _x => {
            error!("unexpected messenger occurred, skipping: {_x}");
            return Ok(None);
        }
    };
    let sender_phone_number =
        sender.clone().and_then(|sender| sender.phone_number);
    let message = MessageF1 {
        id: entry.external_id,
        text: entry.body,
        timestamp: entry.timestamp,
        internal_id: entry.internal_id as i32,
        group_id: entry.group_id,
        sender_phone_number,
        sender,
        attachments: message_attachments,
        message_source,
        reply_to: None,
        deleted: false,
    };
    let item = Item {
        message,
        datasource_id: datasource.id,
        client_name: datasource.system_service_name.clone().c(h!())?,
        model: src_entry,
    };
    Ok(Some(item))
}

async fn wait_for_remaining_tasks(
    pool: &mut ProcessorPool,
    item_queue: &mut VecDeque<(Item, usize)>,
) -> anyhow::Result<bool> {
    while let Some(res) = pool.join_set.join_next().await {
        let result = match res {
            Ok(res) => res,
            Err(e) => {
                error!("unexpected error occurred while processing inbox messages: {:#?}", e);
                continue;
            }
        };
        if result.failed {
            item_queue.push_front((result.item, result.attempt_num + 1));
            break;
        } else {
            delete_message_and_attachments_nofail(
                &pool.ctx.dbx,
                result.item.model.id,
            )
            .await;
        }
    }
    if item_queue.is_empty() {
        // queue is empty and no retries left; that means the queue was processed
        return Ok(true);
    }
    Ok(false)
}

async fn delete_message_and_attachments(
    dbx: &DatabaseConnection,
    message_id: i64,
) -> anyhow::Result<()> {
    let txn = dbx.begin().await.c(h!())?;
    signal_message_queue_attachment::Entity::delete_many()
        .filter(
            signal_message_queue_attachment::Column::MessageId.eq(message_id),
        )
        .exec(&txn)
        .await
        .c(h!())?;
    signal_message_queue::Entity::delete_by_id(message_id)
        .exec(&txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn delete_message_and_attachments_nofail(
    dbx: &DatabaseConnection,
    message_id: i64,
) {
    if let Err(e) = delete_message_and_attachments(dbx, message_id).await {
        error!(
            "failed to delete processed message queue item {message_id}: {:#?}",
            e
        );
    }
}

pub async fn mk_message_processor_pool(
    mode: Mode,
) -> anyhow::Result<ProcessorPool> {
    let ctx = Arc::new(mk_context(mode).await.c(h!())?);
    let capacity = ctx
        .config
        .messenger_worker_pool_capacity
        .unwrap_or(MESSENGER_WORKER_POOL_DEFAULT_CAPACITY);
    let join_set = JoinSet::new();
    Ok(ProcessorPool {
        join_set,
        capacity,
        ctx,
    })
}

async fn mk_context(mode: Mode) -> anyhow::Result<WorkerContext> {
    let context = setup_worker(mode).await.context(h!())?;
    let (config, settlements, rq, redis, dbx) = context;
    let s3 = mk_s3(&config).c(h!())?;
    let result = WorkerContext {
        config,
        settlements,
        rq,
        redis,
        dbx,
        s3,
    };
    Ok(result)
}

// -------- Task-specific code --------

#[derive(Clone, Debug)]
pub struct Item {
    pub message: MessageF1,
    pub datasource_id: i64,
    pub client_name: String,
    pub model: signal_message_queue::Model,
}

pub struct ItemProcessingResult {
    pub item: Item,
    pub attempt_num: usize,
    pub failed: bool,
}

async fn process_item_nofail(
    item: Item,
    attempt_num: usize,
    ctx: Arc<WorkerContext>,
) -> ItemProcessingResult {
    if let Err(e) = process_item_once(ctx, item.clone()).await {
        error!("Process item failed: {:?}", e);
    };
    ItemProcessingResult {
        item,
        failed: false,
        attempt_num,
    }
}

async fn process_item_once(
    context: Arc<WorkerContext>,
    item: Item,
) -> anyhow::Result<()> {
    let m = item.message;
    let datasource_id = item.datasource_id;
    let client_name = item.client_name;
    let txn = context.dbx.begin().await.c(h!())?;
    // let current_time = Utc::now().naive_utc();
    // if m.timestamp < current_time - TimeDelta::minutes(15) {
    //     warn!(
    //         "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
    //         client_name, m.timestamp, current_time, m.internal_id, m.text
    //     );
    //     return;
    // }
    if let Some(group_id) = m.group_id {
        let message = Message {
            body: m.text,
            group_id,
            sender: m.sender.map(|s| s.uuid),
            timestamp: m.timestamp,
            datasource_id,
            inbox_message_id: Some(m.internal_id as i64),
        };
        let mut redis = context.redis.clone();
        if let Err(e) = crate::message_queue::process_signal_message_queue_item(
            message,
            m.attachments,
            &mut redis,
            context.settlements.clone(),
            &context.rq,
            &context.config,
            &context.s3,
            &txn,
            false,
        )
        .await
        {
            warn!("[{client_name}] bot failed to process a message: {:?}", e);
        }
    } else {
        warn!("[{client_name}] skipping message {:?} with no group, possibly a private message: {}", m.id, m.text);
    }
    txn.commit().await.c(h!())?;
    Ok(())
}
