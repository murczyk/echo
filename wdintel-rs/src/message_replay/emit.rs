//! Pushes one source message through the regular ingest pipeline, the same
//! entry point messenger messages use, moved onto the replay timeline.

use crate::h;
use crate::message_queue::{
    process_signal_message_queue_item_with_staged_media_and_options,
    ProcessSignalMessageQueueItemOptions,
};
use crate::message_replay::body::remap_body;
use crate::message_replay::clock::ReplayClock;
use crate::message_replay::source::ReplaySource;
use crate::messenger::media::{
    StagedMediaAttachments, UploadedAttachmentDeletion,
};
use crate::messenger::types::Message;
use crate::types::{Env, ShortContext};
use redis::aio::ConnectionManager;
use sea_orm::DatabaseTransaction;

/// Marks a replayed message and links it to its source. Positive
/// `external_id`s belong to the cross-instance importer.
pub fn replay_external_id(source_id: i64) -> i64 {
    -source_id
}

pub struct EmittedReplay {
    pub signal_message_id: i64,
    pub shown_at: chrono::NaiveDateTime,
    /// Inbox items changed by the replay (split children included), for
    /// fanout.
    pub changed_inbox_item_ids: Vec<i64>,
}

pub async fn emit_source(
    env: &Env,
    redis: &mut ConnectionManager,
    txn: &DatabaseTransaction,
    clock: &ReplayClock,
    source: &ReplaySource,
) -> anyhow::Result<EmittedReplay> {
    let message = replay_message(clock, source).c(h!())?;
    let shown_at = message.timestamp;
    let mut changed_inbox_item_ids = vec![];
    let processed =
        process_signal_message_queue_item_with_staged_media_and_options(
            message,
            &source_media_hash(source),
            redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            txn,
            false,
            &mut changed_inbox_item_ids,
            ProcessSignalMessageQueueItemOptions {
                created_at: None,
                skip_dedupe: true,
                login_id: source.message.login_id,
                external_id: Some(replay_external_id(source.message.id)),
            },
        )
        .await
        .c(h!())?;
    copy_media(
        env,
        txn,
        processed.signal_message_id,
        processed.signal_message_uuid,
        source,
    )
    .await
    .c(h!())?;
    Ok(EmittedReplay {
        signal_message_id: processed.signal_message_id,
        shown_at,
        changed_inbox_item_ids,
    })
}

fn replay_message(
    clock: &ReplayClock,
    source: &ReplaySource,
) -> anyhow::Result<Message> {
    let source_ts = source.message.timestamp.c(h!())?;
    let body = source.message.body.clone().unwrap_or_default();
    Ok(Message {
        body: remap_body(
            &body,
            &|instant| clock.shown_at(instant),
            source_ts,
            crate::config::get_tz(),
        ),
        group_id: source.group_master_key.clone(),
        sender: source.message.sender.clone(),
        timestamp: clock.shown_at(source_ts),
        datasource_id: source.datasource_id,
        inbox_message_id: None,
    })
}

/// Carries the source attachments hash without uploading objects: the
/// stored media is shared with the source by [`copy_media`].
fn source_media_hash(source: &ReplaySource) -> StagedMediaAttachments {
    StagedMediaAttachments::without_uploaded_objects(
        0,
        source.message.attachments_hash.clone(),
        UploadedAttachmentDeletion::Preserve,
    )
}

/// Shares the source media storage objects, like copying a message does,
/// and queues the same follow-up audio processing.
async fn copy_media(
    env: &Env,
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    signal_message_uuid: Option<uuid::Uuid>,
    source: &ReplaySource,
) -> anyhow::Result<()> {
    if source.media.is_empty() {
        return Ok(());
    }
    crate::sigint::direct_submit::query::copy_signal_message_media(
        env,
        txn,
        signal_message_id,
        signal_message_uuid,
        &source.media,
    )
    .await
    .c(h!())?;
    crate::messenger::audio_ref::reconcile(env, txn, signal_message_id)
        .await
        .c(h!())?;
    crate::transcriber::media_queue::reconcile_message(
        txn,
        signal_message_id,
        &[],
    )
    .await
    .c(h!())?;
    Ok(())
}
