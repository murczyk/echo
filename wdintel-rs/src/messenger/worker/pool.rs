use crate::config::*;
use crate::entities::signal_message_queue;
use crate::entities::*;
use crate::location::SettlementsDataConfig;
use crate::messenger::types::{EchoAccountF1, Message};
use crate::types::*;
use anyhow::Context;
use echo_im::types::{MessageAttachmentF1, MessageF1, MessageSource, SenderF1};
use redis::aio::ConnectionManager;
use reqwest::Client;
use sea_orm::sea_query::Expr;
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
    pub metrics: Option<crate::telemetry::Metrics>,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct ProcessQueueOutcome {
    pub success_count: usize,
    pub failed_count: usize,
}

pub async fn process_queue(
    pool: &mut ProcessorPool,
    queue: Vec<signal_message_queue::Model>,
    attachments: Vec<signal_message_queue_attachment::Model>,
    datasources: Vec<EchoAccountF1>,
) -> anyhow::Result<ProcessQueueOutcome> {
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
            item_queue.push_back(item);
        }
    }
    let mut outcome = ProcessQueueOutcome::default();
    while let Some(item) = item_queue.pop_front() {
        if pool.join_set.len() >= pool.capacity {
            trace!(
                "Concurrency limit reached. Waiting for a task to complete..."
            );
            let result = pool.join_set.join_next().await.c(h!())?.c(h!())?;
            record_processing_result(
                &mut outcome,
                handle_processing_result(pool, result).await.c(h!())?,
            );
        }
        pool.join_set.spawn(process_item_nofail(item, ctx.clone()));
    }
    wait_for_remaining_tasks(pool, &mut outcome).await.c(h!())?;
    trace!("All tasks completed.");
    Ok(outcome)
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
        deleted: entry.deleted,
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
    outcome: &mut ProcessQueueOutcome,
) -> anyhow::Result<()> {
    while let Some(res) = pool.join_set.join_next().await {
        let result = res.c(h!())?;
        record_processing_result(
            outcome,
            handle_processing_result(pool, result).await.c(h!())?,
        );
    }
    Ok(())
}

fn record_processing_result(outcome: &mut ProcessQueueOutcome, failed: bool) {
    if failed {
        outcome.failed_count += 1;
    } else {
        outcome.success_count += 1;
    }
}

async fn handle_processing_result(
    pool: &ProcessorPool,
    result: ItemProcessingResult,
) -> anyhow::Result<bool> {
    let messenger = message_source_label(&result.item.message.message_source);
    let latency_seconds = processing_latency_seconds(&result.item.model);
    if let Some(error) = result.error {
        let error_summary = queue_error_summary(&error);
        let retry = schedule_retry_if_unchanged(
            &pool.ctx.dbx,
            &result.item.model,
            &error_summary,
        )
        .await
        .c(h!())?;
        if let Some((attempt_count, delay_seconds)) = retry {
            error!(
                "failed to process message queue item: queue_id={} datasource_id={} inbox_message_id={} attempt={} retry_in_seconds={} error={}",
                result.item.model.id,
                result.item.model.datasource_id,
                result.item.model.internal_id,
                attempt_count,
                delay_seconds,
                error_summary,
            );
        }
        if let Some(metrics) = &pool.ctx.metrics {
            metrics.record_messenger_processing(
                messenger,
                "retry",
                latency_seconds,
            );
        }
        return Ok(true);
    }

    delete_message_and_attachments_nofail(&pool.ctx.dbx, &result.item.model)
        .await;
    if let Some(metrics) = &pool.ctx.metrics {
        metrics.record_messenger_processing(
            messenger,
            "success",
            latency_seconds,
        );
    }
    Ok(false)
}

fn message_source_label(message_source: &MessageSource) -> &'static str {
    match message_source {
        MessageSource::Signal => "signal",
        MessageSource::Whatsapp => "whatsapp",
    }
}

fn processing_latency_seconds(queue_item: &signal_message_queue::Model) -> f64 {
    Utc::now()
        .naive_utc()
        .signed_duration_since(queue_item.created_at)
        .num_milliseconds()
        .max(0) as f64
        / 1000.0
}

fn retry_delay_seconds(attempt_count: i32) -> u64 {
    let index = usize::try_from(attempt_count.max(0))
        .unwrap_or(usize::MAX)
        .min(MESSENGER_QUEUE_RETRY_DELAYS_SEC.len() - 1);
    MESSENGER_QUEUE_RETRY_DELAYS_SEC[index]
}

fn queue_error_summary(error: &anyhow::Error) -> String {
    format!("{error:#}")
        .split_whitespace()
        .join(" ")
        .chars()
        .take(MESSENGER_QUEUE_ERROR_MAX_CHARS)
        .collect()
}

async fn schedule_retry_if_unchanged(
    dbx: &DatabaseConnection,
    queue_item: &signal_message_queue::Model,
    error_summary: &str,
) -> anyhow::Result<Option<(i32, u64)>> {
    let delay_seconds = retry_delay_seconds(queue_item.attempt_count);
    let attempt_count = queue_item.attempt_count.saturating_add(1);
    let next_attempt_at = Utc::now().naive_utc()
        + chrono::TimeDelta::seconds(delay_seconds as i64);
    let update_result = signal_message_queue::Entity::update_many()
        .col_expr(
            signal_message_queue::Column::AttemptCount,
            Expr::value(attempt_count),
        )
        .col_expr(
            signal_message_queue::Column::NextAttemptAt,
            Expr::value(next_attempt_at),
        )
        .col_expr(
            signal_message_queue::Column::LastError,
            Expr::value(Some(error_summary.to_string())),
        )
        .filter(signal_message_queue::Column::Id.eq(queue_item.id))
        .filter(
            signal_message_queue::Column::CreatedAt.eq(queue_item.created_at),
        )
        .exec(dbx)
        .await
        .c(h!())?;
    if update_result.rows_affected == 0 {
        info!(
            "retained updated signal queue item instead of scheduling stale snapshot: queue_id={} datasource_id={} inbox_message_id={}",
            queue_item.id, queue_item.datasource_id, queue_item.internal_id
        );
        return Ok(None);
    }
    Ok(Some((attempt_count, delay_seconds)))
}

async fn delete_message_and_attachments_if_unchanged(
    dbx: &DatabaseConnection,
    queue_item: &signal_message_queue::Model,
) -> anyhow::Result<()> {
    let txn = dbx.begin().await.c(h!())?;
    let delete_result = signal_message_queue::Entity::delete_many()
        .filter(signal_message_queue::Column::Id.eq(queue_item.id))
        .filter(
            signal_message_queue::Column::CreatedAt.eq(queue_item.created_at),
        )
        .exec(&txn)
        .await
        .c(h!())?;
    if delete_result.rows_affected == 0 {
        info!(
            "retained updated signal queue item after processing stale snapshot: queue_id={} datasource_id={} inbox_message_id={}",
            queue_item.id, queue_item.datasource_id, queue_item.internal_id
        );
    }
    txn.commit().await.c(h!())?;
    Ok(())
}

async fn delete_message_and_attachments_nofail(
    dbx: &DatabaseConnection,
    queue_item: &signal_message_queue::Model,
) {
    if let Err(e) =
        delete_message_and_attachments_if_unchanged(dbx, queue_item).await
    {
        error!(
            "failed to delete processed message queue item {}: {:#?}",
            queue_item.id, e
        );
    }
}

pub async fn mk_message_processor_pool(
    env: Arc<Env>,
) -> anyhow::Result<ProcessorPool> {
    let redis = crate::new_redis(&env.config).await.c(h!())?;
    let ctx = Arc::new(WorkerContext {
        config: env.config.clone(),
        settlements: env.settlements.clone(),
        rq: env.rq.clone(),
        redis,
        dbx: env.dbx.clone(),
        s3: env.s3.clone(),
        metrics: env.metrics.clone(),
    });
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
    pub error: Option<anyhow::Error>,
}

struct PreparedItemMedia {
    linked_message_ids: Vec<i64>,
    source_attachments_hash: Option<Option<String>>,
    attachments: Vec<MessageAttachmentF1>,
    staged: crate::messenger::media::StagedMediaAttachments,
}

async fn process_item_nofail(
    item: Item,
    ctx: Arc<WorkerContext>,
) -> ItemProcessingResult {
    let error = process_item_once(ctx, item.clone()).await.err();
    ItemProcessingResult { item, error }
}

async fn process_item_once(
    context: Arc<WorkerContext>,
    item: Item,
) -> anyhow::Result<()> {
    let m = item.message;
    let datasource_id = item.datasource_id;
    let client_name = item.client_name;
    let prepared_media = prepare_item_media(&context, datasource_id, &m)
        .await
        .context(h!())?;
    let txn = match context.dbx.begin().await.c(h!()) {
        Ok(txn) => txn,
        Err(err) => {
            if let Some(prepared_media) = &prepared_media {
                prepared_media
                    .staged
                    .cleanup_after_rollback(&context.config, &context.s3)
                    .await;
            }
            return Err(err);
        }
    };
    let mut changed_inbox_item_ids = vec![];
    let mut superseded_media_ids = vec![];
    let mut superseded_media_storage_keys = vec![];
    let mut superseded_ocr_result_keys = vec![];
    let mut pending_dedupe_updates = vec![];
    let mut uploaded_files_ready_for_deletion = vec![];
    let mut redis = context.redis.clone();
    // let current_time = Utc::now().naive_utc();
    // if m.timestamp < current_time - TimeDelta::minutes(15) {
    //     warn!(
    //         "[{}] message is too old: created at {}, current time: {}; skipping: [{}] {}",
    //         client_name, m.timestamp, current_time, m.internal_id, m.text
    //     );
    //     return;
    // }
    let transaction_result: anyhow::Result<()> = async {
        if m.deleted {
            let result =
                crate::messenger::reconcile::reconcile_deleted_message(
                    &txn,
                    context.settlements.clone(),
                    &context.rq,
                    &context.config,
                    datasource_id,
                    &m,
                )
                .await
                .c(h!())?;
            changed_inbox_item_ids.extend(result.changed_inbox_item_ids);
            superseded_media_ids.extend(result.superseded_media_ids);
            superseded_ocr_result_keys
                .extend(result.superseded_ocr_result_keys);
            pending_dedupe_updates.extend(result.pending_dedupe_updates);
            uploaded_files_ready_for_deletion
                .extend(result.uploaded_files_ready_for_deletion);
            return Ok(());
        }
        let prepared_media = prepared_media.as_ref().c(h!())?;
        let linked_messages =
            crate::messenger::reconcile::load_active_linked_messages(
                &txn,
                datasource_id,
                &m,
            )
            .await
            .c(h!())?;
        let linked_message_ids = linked_messages
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>();
        if linked_message_ids != prepared_media.linked_message_ids {
            anyhow::bail!(
                "active inbox links changed while staging media: datasource_id={} echo_inbox_message_id={}",
                datasource_id,
                m.internal_id
            );
        }
        if let Some(source_message) = linked_messages.first() {
            if prepared_media.source_attachments_hash.as_ref()
                != Some(&source_message.attachments_hash)
            {
                anyhow::bail!(
                    "active inbox attachment hash changed while staging media: datasource_id={} echo_inbox_message_id={}",
                    datasource_id,
                    m.internal_id
                );
            }
            let current_attachments =
                crate::messenger::reconcile::effective_snapshot_attachments(
                    &txn,
                    datasource_id,
                    &m,
                    source_message.id,
                )
                .await
                .c(h!())?;
            if !same_attachments(
                &current_attachments,
                &prepared_media.attachments,
            ) {
                anyhow::bail!(
                    "active inbox attachments changed while staging media: datasource_id={} echo_inbox_message_id={}",
                    datasource_id,
                    m.internal_id
                );
            }
        }
        if !linked_messages.is_empty() {
            let result =
                crate::messenger::reconcile::reconcile_active_message_with_staged_media(
                    &txn,
                    &mut redis,
                    context.settlements.clone(),
                    &context.rq,
                    &context.config,
                    datasource_id,
                    &m,
                    linked_messages,
                    prepared_media.attachments.clone(),
                    &prepared_media.staged,
                )
                .await
                .c(h!())?;
            changed_inbox_item_ids.extend(result.changed_inbox_item_ids);
            superseded_media_ids.extend(result.superseded_media_ids);
            superseded_media_storage_keys
                .extend(result.superseded_media_storage_keys);
            superseded_ocr_result_keys
                .extend(result.superseded_ocr_result_keys);
            pending_dedupe_updates.extend(result.pending_dedupe_updates);
            uploaded_files_ready_for_deletion
                .extend(result.uploaded_files_ready_for_deletion);
        } else if let Some(group_id) = m.group_id.clone() {
            let message = Message {
                body: m.text.clone(),
                group_id,
                sender: m.sender.clone().map(|s| s.uuid),
                timestamp: m.timestamp,
                datasource_id,
                inbox_message_id: Some(m.internal_id as i64),
            };
            let result = crate::message_queue::process_signal_message_queue_item_with_staged_media(
                    message,
                    &prepared_media.staged,
                    &mut redis,
                    context.settlements.clone(),
                    &context.rq,
                    &context.config,
                    &txn,
                    false,
                    &mut changed_inbox_item_ids,
                )
                .await
                .c(h!())?;
            uploaded_files_ready_for_deletion
                .extend(result.uploaded_files_ready_for_deletion);
        } else {
            warn!(
                "[{client_name}] skipping message {:?} with no group, possibly a private message",
                m.id
            );
        }
        Ok(())
    }
    .await;
    if let Err(err) = transaction_result {
        if let Err(rollback_err) = txn.rollback().await {
            error!(
                "failed to rollback messenger queue transaction: {:?}",
                rollback_err
            );
        }
        if let Some(prepared_media) = &prepared_media {
            prepared_media
                .staged
                .cleanup_after_rollback(&context.config, &context.s3)
                .await;
        }
        return Err(err);
    }
    if let Err(err) = txn.commit().await.c(h!()) {
        if let Some(prepared_media) = &prepared_media {
            prepared_media
                .staged
                .finalize_after_commit(
                    &context.config,
                    &context.s3,
                    &context.dbx,
                )
                .await;
        }
        return Err(err);
    }
    if let Some(prepared_media) = &prepared_media {
        prepared_media
            .staged
            .finalize_after_commit(&context.config, &context.s3, &context.dbx)
            .await;
    }
    crate::messenger::media::delete_uploaded_attachment_files(
        &uploaded_files_ready_for_deletion,
    )
    .await;
    if let Err(err) = crate::messenger::reconcile::apply_pending_dedupe_updates(
        &mut redis,
        pending_dedupe_updates,
    )
    .await
    {
        error!(
            "failed to apply pending dedupe updates after queue commit: {:?}",
            err
        );
    }
    if let Err(err) =
        crate::inbox::fanout_inbox_changes(&mut redis, changed_inbox_item_ids)
            .await
    {
        error!(
            "failed to fanout inbox changes after queue commit: {:?}",
            err
        );
    }
    crate::messenger::reconcile::delete_media_objects_best_effort(
        &context.config,
        &context.s3,
        &context.dbx,
        superseded_media_ids,
        superseded_media_storage_keys,
        superseded_ocr_result_keys,
    )
    .await;
    Ok(())
}

fn same_attachments(
    left: &[MessageAttachmentF1],
    right: &[MessageAttachmentF1],
) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.path == right.path && left.name == right.name
        })
}

async fn prepare_item_media(
    context: &WorkerContext,
    datasource_id: i64,
    message: &MessageF1,
) -> anyhow::Result<Option<PreparedItemMedia>> {
    if message.deleted {
        return Ok(None);
    }
    let linked_messages =
        crate::messenger::reconcile::load_active_linked_messages(
            &context.dbx,
            datasource_id,
            message,
        )
        .await
        .c(h!())?;
    let attachments = match linked_messages.first() {
        Some(source_message) => {
            crate::messenger::reconcile::effective_snapshot_attachments(
                &context.dbx,
                datasource_id,
                message,
                source_message.id,
            )
            .await
            .c(h!())?
        }
        None if message.group_id.is_some() => message.attachments.clone(),
        None => vec![],
    };
    let staged = match linked_messages.first() {
        Some(source_message) => {
            crate::message_queue::stage_queue_media_for_active_edit(
                &attachments,
                &source_message.attachments_hash,
                &context.config,
                &context.s3,
            )
            .await
            .c(h!())?
        }
        None => crate::message_queue::stage_queue_media(
            &attachments,
            &context.config,
            &context.s3,
        )
        .await
        .c(h!())?,
    };
    Ok(Some(PreparedItemMedia {
        linked_message_ids: linked_messages
            .iter()
            .map(|message| message.id)
            .collect(),
        source_attachments_hash: linked_messages
            .first()
            .map(|message| message.attachments_hash.clone()),
        attachments,
        staged,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_uses_capped_schedule() {
        assert_eq!(retry_delay_seconds(0), 5);
        assert_eq!(retry_delay_seconds(1), 15);
        assert_eq!(retry_delay_seconds(2), 60);
        assert_eq!(retry_delay_seconds(3), 300);
        assert_eq!(retry_delay_seconds(4), 900);
        assert_eq!(retry_delay_seconds(5), 1800);
        assert_eq!(retry_delay_seconds(100), 1800);
    }

    #[test]
    fn queue_error_summary_is_single_line_and_bounded() {
        let detail = "x".repeat(MESSENGER_QUEUE_ERROR_MAX_CHARS + 100);
        let error = anyhow!("first line\nsecond line {detail}");
        let summary = queue_error_summary(&error);

        assert!(!summary.contains('\n'));
        assert_eq!(summary.chars().count(), MESSENGER_QUEUE_ERROR_MAX_CHARS);
    }

    #[test]
    fn negative_attempt_count_uses_initial_delay_defensively() {
        assert_eq!(retry_delay_seconds(-1), 5);
    }
}
