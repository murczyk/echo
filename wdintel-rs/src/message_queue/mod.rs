use crate::config::*;
use crate::entities::*;
use crate::messenger::dedupe;
use crate::messenger::media::MediaUploadInput;
use crate::{location::SettlementsData, messenger::types::Message, types::*};
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::*;

/// Workhorse for the message queue
///
/// - this routine is called from [process_queue_nofail](crate::messenger::worker::queue::process_queue_nofail) which launches set of N worker threads
/// - consumes messages from [signal_message_queue table](crate::entities::signal_message_queue)
/// - inserts them into [signal_message table](crate::entities::signal_message)
/// - further see [construct_inbox_item](crate::inbox::construct_inbox_item) where we construct [sigint_inbox_item](crate::entities::sigint_inbox_item) entries from [signal_message](crate::entities::signal_message)
pub async fn process_signal_message_queue_item(
    m: Message,
    attachments: Vec<MessageAttachmentF1>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsData>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
) -> Result<String, AppError> {
    // Normalize body
    info!("received message: {m:?}");
    let body = m.body.replace("\r\n", "\n");
    let body = dedupe::body_with_attachment_markers(&body, &attachments).await;
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
        created_at: NotSet,
        timestamp: Set(Some(m.timestamp)),
        sender: Set(m.sender),
        format: NotSet,
        deleted: Set(true), // unstaged message
        external_id: NotSet,
        message_uid: NotSet,
        duplicate_of: NotSet,
    }
    .insert(txn)
    .await
    .c(h!())?;
    let m_duplicate_of = crate::sigint::find_duplicate_of(
        txn,
        &body,
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
        return Ok(res.message.message_uid.context(h!())?);
    }

    let signal_message =
        crate::messenger::id::update_message_with_uid(txn, config, res.message)
            .await
            .c(h!())?;

    let message_uid = signal_message.message_uid.clone().c(h!())?;

    if !attachments.is_empty() {
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
        crate::rer_importer::bgworker::process_message_to_inbox_nofail(
            settlements.clone(),
            txn,
            rq,
            config,
            redis,
            signal_message.id,
            None,
        )
        .await;

        crate::sigint::worker::incoming_message_after_insert(
            txn,
            signal_message.id,
        )
        .await
        .c(h!())?;
    }
    Ok(message_uid)
}
