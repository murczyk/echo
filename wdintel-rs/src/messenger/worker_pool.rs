use crate::config::Config;
use crate::h;
use crate::location::SettlementsData;
use crate::messenger::types::Message;
use crate::messenger::worker::receive_once;
use crate::types::*;
use crate::utils::setup_worker;
use anyhow::Context;
use echo_im::types::MessageF1;
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::{DatabaseConnection, TransactionTrait};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinSet;
use tokio::time::sleep;

std::thread_local! {
    pub static THREAD_CTX: RefCell<Option<WorkerContext>> = const { RefCell::new(None) };
}

pub struct ProcessorPool {
    pub capacity: usize,
    pub join_set: JoinSet<ItemProcessingResult>,
    pub runtime: Runtime,
}

#[derive(Clone)]
pub struct WorkerContext {
    pub config: Config,
    pub settlements: Arc<RwLock<SettlementsData>>,
    pub rq: Client,
    pub redis: ConnectionManager,
    pub dbx: DatabaseConnection,
}

pub async fn process_queue(
    items: Vec<Item>,
    pool: &mut ProcessorPool,
) -> anyhow::Result<()> {
    let handle = pool.runtime.handle().clone();
    let mut item_queue = VecDeque::new();
    for i in items {
        item_queue.push_back((i, 0));
    }
    loop {
        if item_queue.is_empty() {
            while let Some(res) = pool.join_set.join_next().await {
                let result = match res {
                    Ok(res) => res,
                    Err(e) => {
                        error!("unexpected error occurred while processing inbox messages: {e:#?}");
                        continue;
                    }
                };
                if result.failed {
                    item_queue
                        .push_front((result.item, result.attempt_num + 1));
                    break;
                }
            }
            if item_queue.is_empty() {
                break;
            }
        }
        let (item, attempt_num) = item_queue.pop_front().c(h!())?;
        if attempt_num > 3 {
            error!(
                "failed to process item, dropping after 3 attempts: {item:?}"
            );
            continue;
        }
        if pool.join_set.len() >= pool.capacity {
            trace!(
                "Concurrency limit reached. Waiting for a task to complete..."
            );
            if let Some(res) = pool.join_set.join_next().await {
                let result = match res {
                    Ok(res) => res,
                    Err(e) => {
                        error!("unexpected error occurred while processing inbox messages: {e:#?}");
                        continue;
                    }
                };
                if result.failed {
                    item_queue
                        .push_front((result.item, result.attempt_num + 1));
                }
            } else {
                break;
            }
        }
        pool.join_set.spawn_blocking_on(
            move || process_item_nofail(item, attempt_num),
            &handle,
        );
    }

    trace!("All tasks completed.");
    Ok(())
}

fn get_context() -> Option<WorkerContext> {
    THREAD_CTX.with(|ctx_ref_cell| ctx_ref_cell.borrow().clone())
}

pub async fn mk_message_processor_pool(
    mode: Mode,
    capacity: usize,
) -> anyhow::Result<ProcessorPool> {
    let runtime = Builder::new_multi_thread()
        .max_blocking_threads(capacity)
        .thread_name("worker-pool")
        .enable_all()
        .on_thread_start(move || {
            let handle = tokio::runtime::Handle::current();
            let mut context: Option<WorkerContext>;
            let mut attempts = 0;
            loop {
                context = match handle.block_on(mk_context(mode)) {
                    Ok(c) => Some(c),
                    Err(e) => {
                        error!("failed to set up worker context! {e:?}");
                        None
                    }
                };
                if context.is_none() {
                    attempts += 1;
                    if attempts > 10 {
                        error!("still unable to init a worker, sleeping 10 seconds and then retry again...");
                        handle.block_on(sleep(core::time::Duration::from_secs(10)));
                        break;
                    } else {
                        warn!("retrying to set up context {}", h!());
                    }
                } else {
                    THREAD_CTX.with(|ctx| {
                        let mut ctx_opt = ctx.borrow_mut();
                        *ctx_opt = context;
                    });
                    break;
                }
            }
        })
        .build()
        .c(h!())?;
    let join_set = JoinSet::new();
    Ok(ProcessorPool {
        join_set,
        runtime,
        capacity,
    })
}

async fn mk_context(mode: Mode) -> anyhow::Result<WorkerContext> {
    let context = setup_worker(mode).await.context(h!())?;
    let (config, settlements, rq, redis, dbx) = context;
    let result = WorkerContext {
        config,
        settlements,
        rq,
        redis,
        dbx,
    };
    Ok(result)
}

// -------- Task-specific code --------

pub type Item = (MessageF1, i64, String);
pub struct ItemProcessingResult {
    pub item: Item,
    pub attempt_num: usize,
    pub failed: bool,
}

#[tokio::main]
async fn process_item_nofail(
    item: (MessageF1, i64, String),
    attempt_num: usize,
) -> ItemProcessingResult {
    let mut failed = false;
    match get_context() {
        Some(context) => {
            if let Err(e) = process_item_once(context, item.clone()).await {
                error!("Process item failed: {e:?}");
            }
        }
        None => {
            error!("failed to process item: context not initialized");
            failed = true;
        }
    };
    ItemProcessingResult {
        item,
        failed,
        attempt_num,
    }
}

async fn process_item_once(
    context: WorkerContext,
    item: Item,
) -> anyhow::Result<()> {
    let (m, datasource_id, client_name) = item;
    let txn = context.dbx.begin().await.c(h!())?;
    // let current_time = Utc::now().naive_utc();
    // if m.timestamp < current_time - TimeDelta::minutes(15) {
    //     warn!(
    //         "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
    //         client_name, m.timestamp, current_time, m.internal_id, m.text
    //     );
    //     return;
    // }
    let Some(group_id) = m.group_id else {
        warn!("[{client_name}] skipping message {:?} with no group, possibly a private message: {}", m.id, m.text);
        return Ok(());
    };
    let message = Message {
        body: m.text,
        group_id,
        sender: m.sender.map(|s| s.uuid),
        timestamp: m.timestamp,
        datasource_id,
    };
    let mut redis = context.redis;
    if let Err(e) = receive_once(
        message,
        m.attachments.into_iter().map(|a| a.path).collect_vec(),
        &mut redis,
        context.settlements,
        &context.rq,
        &context.config,
        &txn,
        false,
    )
    .await
    {
        warn!("[{client_name}] bot failed to process a message: {e:?}");
    }
    echo_im::mark_inbox_as_seen(&client_name, vec![m.internal_id], &txn)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(())
}
