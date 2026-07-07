use crate::config::*;
use crate::entities::*;
use crate::messenger::dedupe;
use crate::messenger::media::MediaUploadInput;
use crate::{
    location::SettlementsDataConfig, messenger::types::Message, types::*,
};
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::*;

/// Workhorse for the message queue
///
/// - this routine is called from [process_queue_nofail](crate::messenger::worker::queue::process_queue_nofail) which launches set of N worker threads
/// - consumes messages from [signal_message_queue table](crate::entities::signal_message_queue)
/// - inserts them into [signal_message table](crate::entities::signal_message)
/// - further see [construct_inbox_item](crate::inbox::construct_inbox_item) where we construct [sigint_inbox_item](crate::entities::sigint_inbox_item) entries from [signal_message](crate::entities::signal_message)
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessSignalMessageQueueItemOptions {
    pub created_at: Option<NaiveDateTime>,
}

#[derive(Clone, Debug)]
pub struct ProcessSignalMessageQueueItemResult {
    pub message_uid: String,
    pub is_duplicate: bool,
}

pub async fn process_signal_message_queue_item(
    m: Message,
    attachments: Vec<MessageAttachmentF1>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> Result<String, AppError> {
    Ok(process_signal_message_queue_item_with_options(
        m,
        attachments,
        redis,
        settlements,
        rq,
        config,
        s3,
        txn,
        skip_process_inbox_item,
        changed_inbox_item_ids,
        ProcessSignalMessageQueueItemOptions::default(),
    )
    .await?
    .message_uid)
}

pub async fn process_signal_message_queue_item_with_options(
    m: Message,
    attachments: Vec<MessageAttachmentF1>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
    options: ProcessSignalMessageQueueItemOptions,
) -> Result<ProcessSignalMessageQueueItemResult, AppError> {
    // Normalize body
    info!("received message: {:?}", m);
    let body = m.body.replace("\r\n", "\n");
    let attachment_paths: Vec<_> =
        attachments.iter().map(|a| a.path.clone()).collect();
    info!(
        "processing queue item: datasource_id={} attachments_count={} attachment_paths={:?}",
        m.datasource_id,
        attachments.len(),
        attachment_paths
    );
    let attachments_hash = dedupe::attachments_hash(&attachments).await;
    let body_for_dedupe =
        dedupe::body_with_attachments_hash(&body, attachments_hash.as_deref());
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            m.group_id.clone(),
            m.datasource_id,
        )
        .await
        .c(h!())?;
    let signal_message = signal_message::ActiveModel {
        id: NotSet,
        body: Set(Some(body.clone())),
        datasource_group_id: Set(Some(datasource_group_id)),
        created_at: match options.created_at {
            Some(created_at) => Set(created_at),
            None => NotSet,
        },
        timestamp: Set(Some(m.timestamp)),
        sender: Set(m.sender),
        format: NotSet,
        deleted: Set(true), // unstaged message
        external_id: Set(None),
        // Echo IM inbox id is kept here only for tracing messages back to echo_im.
        echo_inbox_message_id: Set(m.inbox_message_id),
        message_uid: NotSet,
        operator_tags: NotSet,
        attachments_hash: Set(attachments_hash),
    }
    .insert(txn)
    .await
    .c(h!())?;
    let m_duplicate_of = crate::sigint::find_duplicate_of(
        txn,
        &body_for_dedupe,
        &body,
        signal_message.attachments_hash.as_deref(),
        Some(m.timestamp),
        signal_message.id,
        redis,
    )
    .await
    .c(h!())?;
    let res = crate::sigint::worker::unstage_message(
        txn,
        &m.group_id,
        signal_message,
        m_duplicate_of,
    )
    .await
    .c(h!())?;

    if res.is_duplicate {
        if let Some(inbox_message_id) = m.inbox_message_id {
            match i32::try_from(inbox_message_id) {
                Ok(message_id) => {
                    crate::messenger::missing_message::record_duplicate_missing_message(
                        txn, message_id,
                    )
                    .await
                    .c(h!())?;
                }
                Err(e) => warn!(
                    "failed to convert duplicate inbox_message_id={inbox_message_id} to i32: {e}; skipping missing message record"
                ),
            }
        }
        return Ok(ProcessSignalMessageQueueItemResult {
            message_uid: res.message.message_uid.context(h!())?,
            is_duplicate: true,
        });
    }

    let signal_message =
        crate::messenger::id::update_message_with_uid(txn, config, res.message)
            .await
            .c(h!())?;

    let message_uid = signal_message.message_uid.clone().c(h!())?;

    if !attachments.is_empty() {
        // Recovery wraps this error in a rollback because media may carry critical context.
        let upload_inputs: Vec<MediaUploadInput> =
            attachments.clone().into_iter().map(Into::into).collect();
        crate::messenger::media::store_media_attachments(
            &upload_inputs,
            signal_message.id,
            config,
            s3,
            txn,
            config
                .feature_delete_uploaded_attachment
                .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT),
        )
        .await
        .c(h!())?;
    }

    if !skip_process_inbox_item {
        // inbox item processing happens behind the scene
        changed_inbox_item_ids.extend(
            crate::rer_importer::bgworker::process_message_to_inbox_nofail(
                settlements.clone(),
                txn,
                rq,
                config,
                signal_message.id,
                None,
            )
            .await,
        );

        crate::sigint::worker::incoming_message_after_insert(
            txn,
            signal_message.id,
        )
        .await
        .c(h!())?;
    }
    Ok(ProcessSignalMessageQueueItemResult {
        message_uid,
        is_duplicate: false,
    })
}
