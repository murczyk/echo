//! Hard-deletes replayed messages in batches. Replays are found through the
//! negative `external_id` marker (`signal_message_external_id_idx`).
//! Children referencing `signal_message` / `sigint_inbox_item` with
//! ON DELETE NO ACTION are deleted first; the rest cascade. Stored media
//! objects are never deleted: replays share them with their sources.

use crate::config::MESSAGE_REPLAY_PURGE_BATCH_SIZE;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::*;

/// Returns the purged message ids (also inbox item ids) for fanout; empty
/// once no replay is left.
pub async fn purge_batch(
    txn: &DatabaseTransaction,
) -> Result<Vec<i64>, AppError> {
    let message_ids = load_replay_batch(txn).await?;
    if message_ids.is_empty() {
        return Ok(message_ids);
    }
    let network_freq_ids =
        crate::sigint::network::recalculation::load_freq_ids_for_message_links(
            txn,
            &message_ids,
        )
        .await
        .c(h!())?;
    crate::rer_importer::inbox::prepare_messages_network_activity_change(
        txn,
        &message_ids,
        "purged replayed messages",
    )
    .await
    .c(h!())?;
    delete_blocking_children(txn, &message_ids).await?;
    delete_messages(txn, &message_ids).await?;
    crate::sigint::network::recalculation::enqueue_last_seen_for_freq_ids(
        txn,
        network_freq_ids,
    )
    .await
    .c(h!())?;
    Ok(message_ids)
}

async fn load_replay_batch(
    txn: &DatabaseTransaction,
) -> Result<Vec<i64>, AppError> {
    Ok(signal_message::Entity::find()
        .filter(signal_message::Column::ExternalId.lt(0))
        .order_by_asc(signal_message::Column::ExternalId)
        .limit(MESSAGE_REPLAY_PURGE_BATCH_SIZE)
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?)
}

/// Rows that would block (NO ACTION) deleting the messages or their inbox
/// items; each lookup column is indexed.
async fn delete_blocking_children(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
) -> Result<(), AppError> {
    sigint_peleng::Entity::delete_many()
        .filter(
            sigint_peleng::Column::SourceInboxItemId
                .is_in(message_ids.to_vec()),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_comment::Entity::delete_many()
        .filter(
            sigint_comment::Column::SignalMessageId.is_in(message_ids.to_vec()),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_bookmark::Entity::delete_many()
        .filter(
            sigint_bookmark::Column::SignalMessageId
                .is_in(message_ids.to_vec()),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_important::Entity::delete_many()
        .filter(
            sigint_important::Column::SignalMessageId
                .is_in(message_ids.to_vec()),
        )
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

async fn delete_messages(
    txn: &DatabaseTransaction,
    message_ids: &[i64],
) -> Result<(), AppError> {
    sigint_inbox_item::Entity::delete_many()
        .filter(sigint_inbox_item::Column::Id.is_in(message_ids.to_vec()))
        .exec(txn)
        .await
        .c(h!())?;
    signal_message::Entity::delete_many()
        .filter(signal_message::Column::Id.is_in(message_ids.to_vec()))
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}
