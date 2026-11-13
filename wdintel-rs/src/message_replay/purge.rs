//! Hard-deletes replayed messages in batches. Replays are found through the
//! negative `external_id` marker (`signal_message_external_id_idx`), and the
//! copies the replay before #4110 left behind through its comment marker.
//! Children referencing `signal_message` / `sigint_inbox_item` with
//! ON DELETE NO ACTION are deleted first; the rest cascade. Stored media
//! objects are never deleted: replays share them with their sources.

use crate::config::{
    MESSAGE_REPLAY_INSTALL_MIGRATION, MESSAGE_REPLAY_LEGACY_MARKER,
    MESSAGE_REPLAY_PURGE_BATCH_SIZE,
};
use crate::entities::*;
use crate::h;
use crate::types::ShortContext;
use sea_orm::*;

/// Returns the purged message ids (also inbox item ids) for fanout; empty
/// once no replay is left.
pub async fn purge_batch(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<i64>> {
    let message_ids = load_replay_batch(txn).await.c(h!())?;
    purge_messages(txn, message_ids, "purged replayed messages")
        .await
        .c(h!())
}

/// Purges a batch of the copies the replay before #4110 made, which its
/// cleanup only soft-deleted. That replay is gone, so nothing else would ever
/// remove them. Returns them for fanout; empty once none is left.
///
/// The marker alone is not proof: comment parsing gives a real message the
/// same system comment when its text carries [`MESSAGE_REPLAY_LEGACY_MARKER`].
/// So only a message that passes all of these is purged:
/// - the system login's marker comment, from before this replay was
///   installed (its migration), when the old replay could still write it;
/// - the comment written at exactly the message's `timestamp`: the old replay
///   stamped both with one clock reading, while a parsed comment gets the
///   database's insert time and a message its interception time;
/// - already soft-deleted, so no visible message is ever touched;
/// - no comment migrated into a message of its own, which would be orphaned.
///   The comment migration's lock is held, so none can be migrated meanwhile;
/// - not linked through `intel_product` either way: a linked comment would be
///   orphaned, and a report would lose its source;
/// - no GOI association names its `message_uid`, and no AI intel report
///   attempt its id: GOI matching includes hidden messages, and nothing would
///   repair either reference.
///
/// Every condition is in the query, so a skipped message cannot stall it.
pub async fn purge_legacy_batch(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<i64>> {
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock($1)",
        [crate::sigint::comments::SIGINT_COMMENT_MIGRATION_LOCK_KEY.into()],
    ))
    .await
    .c(h!())?;
    let system_login_id = crate::users::system_login_id(txn).await.c(h!())?;
    let rows = txn
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
            SELECT DISTINCT c.signal_message_id
            FROM sigint_comment c
            JOIN signal_message m ON m.id = c.signal_message_id
            WHERE c.login_id = $1
              AND c.comment = $2
              AND c.created_at < (
                SELECT to_timestamp(applied_at) AT TIME ZONE 'UTC'
                FROM seaql_migrations
                WHERE version = $3
              )
              AND c.created_at = m.timestamp
              AND m.deleted
              AND NOT EXISTS (
                SELECT 1 FROM sigint_comment migrated
                WHERE migrated.signal_message_id = m.id
                  AND migrated.migrated_signal_message_id IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM intel_product p WHERE p.source_message_id = m.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM intel_product p WHERE p.intel_message_id = m.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM goi_association g
                WHERE g.message_uid = m.message_uid
              )
              AND NOT EXISTS (
                SELECT 1 FROM ai_intel_report_attempt a
                WHERE a.source_message_id = m.id
              )
            LIMIT $4
            "#,
            [
                system_login_id.into(),
                MESSAGE_REPLAY_LEGACY_MARKER.into(),
                MESSAGE_REPLAY_INSTALL_MIGRATION.into(),
                (MESSAGE_REPLAY_PURGE_BATCH_SIZE as i64).into(),
            ],
        ))
        .await
        .c(h!())?;
    let mut message_ids = rows
        .into_iter()
        .map(|row| row.try_get::<i64>("", "signal_message_id"))
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    message_ids.sort_unstable();
    purge_messages(txn, message_ids, "purged legacy replayed messages")
        .await
        .c(h!())
}

async fn purge_messages(
    txn: &DatabaseTransaction,
    message_ids: Vec<i64>,
    reason: &str,
) -> anyhow::Result<Vec<i64>> {
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
        reason,
    )
    .await
    .c(h!())?;
    delete_blocking_children(txn, &message_ids).await.c(h!())?;
    delete_messages(txn, &message_ids).await.c(h!())?;
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
) -> anyhow::Result<Vec<i64>> {
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
) -> anyhow::Result<()> {
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
) -> anyhow::Result<()> {
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

#[cfg(test)]
#[path = "purge_tests.rs"]
mod tests;
