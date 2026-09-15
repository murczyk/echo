use crate::error::AppError;
use crate::sigint::message_id::signal_message_uuid;
use crate::types::{Mode, ShortContext};
use crate::{h, OneoffBackfillSignalMessageUuidPs};
use sea_orm::sea_query::{Expr, ExprTrait};
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

const CHECKPOINT_KEY: &str = "oneoff_signal_message_uuid_checkpoint";

mod shadow_entities {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "signal_message")]
    pub struct Model {
        #[sea_orm(primary_key, column_name = "id")]
        pub legacy_id: i64,
        pub id_uuid: Option<Uuid>,
        pub created_at: DateTime,
        pub timestamp: Option<DateTime>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
    pub mod inbox_item {
        use sea_orm::entity::prelude::*;
        #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
        #[sea_orm(table_name = "sigint_inbox_item")]
        pub struct Model {
            #[sea_orm(primary_key, column_name = "id")]
            pub legacy_id: i64,
            pub id_uuid: Option<Uuid>,
        }
        #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
        pub enum Relation {}
        impl ActiveModelBehavior for ActiveModel {}
    }

    macro_rules! linked_entity {
        ($module:ident, $table:literal, $legacy_column:literal, $uuid_column:literal) => {
            pub mod $module {
                use sea_orm::entity::prelude::*;
                #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
                #[sea_orm(table_name = $table)]
                pub struct Model {
                    #[sea_orm(primary_key, column_name = $legacy_column)]
                    pub legacy_id: i64,
                    #[sea_orm(column_name = $uuid_column)]
                    pub uuid: Option<Uuid>,
                }
                #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
                pub enum Relation {}
                impl ActiveModelBehavior for ActiveModel {}
            }
        };
    }

    linked_entity!(sigint_search, "sigint_search", "id", "id_uuid");
    linked_entity!(
        signal_message_group,
        "signal_message_group",
        "signal_message_id",
        "signal_message_uuid"
    );
    linked_entity!(
        signal_message_media,
        "signal_message_media",
        "signal_message_id",
        "signal_message_uuid"
    );
    linked_entity!(
        sigint_bookmark,
        "sigint_bookmark",
        "signal_message_id",
        "signal_message_uuid"
    );
    linked_entity!(
        sigint_important,
        "sigint_important",
        "signal_message_id",
        "signal_message_uuid"
    );
    linked_entity!(
        sigint_comment,
        "sigint_comment",
        "signal_message_id",
        "signal_message_uuid"
    );
    linked_entity!(
        sigint_comment_migrated,
        "sigint_comment",
        "migrated_signal_message_id",
        "migrated_signal_message_uuid"
    );
    linked_entity!(
        intel_product_intel,
        "intel_product",
        "intel_message_id",
        "intel_message_uuid"
    );
    linked_entity!(
        intel_product_source,
        "intel_product",
        "source_message_id",
        "source_message_uuid"
    );
    linked_entity!(
        ai_callsign_worker_job,
        "ai_callsign_worker_job",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_failed_unit_label,
        "sigint_inbox_item_failed_unit_label",
        "inbox_item_id",
        "inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_callsign,
        "sigint_inbox_item_callsign",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_metadata,
        "sigint_inbox_item_metadata",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_network,
        "sigint_inbox_item_network",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_point_token,
        "sigint_inbox_item_point_token",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_settlement,
        "sigint_inbox_item_settlement",
        "item_id",
        "item_uuid"
    );
    linked_entity!(
        inbox_item_tag,
        "sigint_inbox_item_tag",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_item_unit,
        "sigint_inbox_item_unit",
        "item_id",
        "item_uuid"
    );
    linked_entity!(
        inbox_item_unit_tag_queue,
        "sigint_inbox_item_unit_tag_queue",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        inbox_tag_model_error,
        "sigint_inbox_tag_model_error",
        "sigint_inbox_item_id",
        "sigint_inbox_item_uuid"
    );
    linked_entity!(
        sigint_peleng,
        "sigint_peleng",
        "source_inbox_item_id",
        "source_inbox_item_uuid"
    );
}

use shadow_entities as signal_message;
use shadow_entities::inbox_item;
use shadow_entities::{
    ai_callsign_worker_job, inbox_item_callsign, inbox_item_failed_unit_label,
    inbox_item_metadata, inbox_item_network, inbox_item_point_token,
    inbox_item_settlement, inbox_item_tag, inbox_item_unit,
    inbox_item_unit_tag_queue, inbox_tag_model_error, intel_product_intel,
    intel_product_source, sigint_bookmark, sigint_comment,
    sigint_comment_migrated, sigint_important, sigint_peleng, sigint_search,
    signal_message_group, signal_message_media,
};

const CHECKPOINT_VERSION: u8 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Checkpoint {
    #[serde(default)]
    version: u8,
    phase: usize,
    cursor: i64,
}

impl Checkpoint {
    fn new() -> Self {
        Self {
            version: CHECKPOINT_VERSION,
            phase: 0,
            cursor: 0,
        }
    }
}

pub async fn oneoff_backfill_signal_message_uuid(
    mode: Mode,
    ps: &OneoffBackfillSignalMessageUuidPs,
) -> Result<(), AppError> {
    validate_batch_size(ps.batch_size).c(h!())?;
    let db = crate::new_pg_maintenance_connection_from_mode(mode)
        .await
        .c(h!())?;
    let mut checkpoint =
        load_checkpoint(&db, ps.reset_checkpoint).await.c(h!())?;
    let total_messages =
        signal_message::Entity::find().count(&db).await.c(h!())?;
    let processed_before_checkpoint = if checkpoint.phase > 0 {
        total_messages
    } else {
        signal_message::Entity::find()
            .filter(signal_message::Column::LegacyId.lte(checkpoint.cursor))
            .count(&db)
            .await
            .c(h!())?
    };
    let progress = indicatif::ProgressBar::new(total_messages);
    progress.set_style(crate::utils::get_pb_style().c(h!())?);
    progress.set_prefix("signal-message UUID backfill");
    progress.set_position(processed_before_checkpoint);
    while checkpoint.phase == 0 {
        let (processed, next_cursor, linked_rows) =
            backfill_message_batch(&db, checkpoint.cursor, ps.batch_size)
                .await
                .c(h!())?;
        if processed == 0 {
            checkpoint.phase += 1;
            checkpoint.cursor = 0;
        } else {
            checkpoint.cursor = next_cursor;
            progress.inc(processed as u64);
            progress.set_message(format!(
                "{linked_rows} linked rows in batch; through legacy message id {}",
                checkpoint.cursor
            ));
        }
        crate::kv::put_kv(&db, CHECKPOINT_KEY, checkpoint.clone())
            .await
            .c(h!())?;
        if processed > 0 && ps.pause_ms > 0 {
            tokio::time::sleep(core::time::Duration::from_millis(ps.pause_ms))
                .await;
        }
    }
    progress.finish_with_message(format!(
        "signal-message UUID backfill completed: {}/{} messages scanned",
        progress.position(),
        total_messages
    ));
    Ok(())
}

fn validate_batch_size(batch_size: u64) -> Result<(), AppError> {
    if !(1..=crate::config::SIGNAL_MESSAGE_UUID_BACKFILL_BATCH_SIZE_MAX)
        .contains(&batch_size)
    {
        return Err(AppError::BL {
            msg: format!(
                "batch-size must be between 1 and {}",
                crate::config::SIGNAL_MESSAGE_UUID_BACKFILL_BATCH_SIZE_MAX
            ),
        });
    }
    Ok(())
}

async fn load_checkpoint(
    db: &DatabaseConnection,
    reset_checkpoint: bool,
) -> anyhow::Result<Checkpoint> {
    if reset_checkpoint {
        return Ok(Checkpoint::new());
    }
    let Some(checkpoint) = crate::kv::get_kv::<Checkpoint>(db, CHECKPOINT_KEY)
        .await
        .c(h!())?
    else {
        return Ok(Checkpoint::new());
    };
    if checkpoint.version != CHECKPOINT_VERSION {
        println!(
            "ignoring legacy UUID backfill checkpoint and restarting from message id 0"
        );
        return Ok(Checkpoint::new());
    }
    Ok(checkpoint)
}

async fn backfill_message_batch(
    db: &DatabaseConnection,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64, usize)> {
    let txn = db.begin().await.c(h!())?;
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::LegacyId.gt(cursor))
        .order_by_asc(signal_message::Column::LegacyId)
        .limit(batch_size)
        .all(&txn)
        .await
        .c(h!())?;
    if messages.is_empty() {
        txn.rollback().await.c(h!())?;
        return Ok((0, cursor, 0));
    }
    let message_ids = messages
        .iter()
        .map(|message| message.legacy_id)
        .collect::<Vec<_>>();
    let message_rows = messages
        .iter()
        .map(|message| {
            (
                message.legacy_id,
                message.id_uuid.unwrap_or_else(|| {
                    signal_message_uuid(message.timestamp, message.created_at)
                }),
            )
        })
        .collect::<Vec<_>>();
    update_uuid_column(
        &txn,
        signal_message::Entity,
        signal_message::Column::LegacyId,
        signal_message::Column::IdUuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    let message_rows = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::LegacyId)
        .column(signal_message::Column::IdUuid)
        .filter(signal_message::Column::LegacyId.eq_any(message_ids.clone()))
        .filter(signal_message::Column::IdUuid.is_not_null())
        .into_tuple::<(i64, Uuid)>()
        .all(&txn)
        .await
        .c(h!())?;
    let inbox_items = inbox_item::Entity::find()
        .filter(inbox_item::Column::LegacyId.eq_any(message_ids.clone()))
        .all(&txn)
        .await
        .c(h!())?;
    let message_uuids = message_rows.iter().copied().collect::<HashMap<_, _>>();
    let inbox_rows = inbox_items
        .iter()
        .filter_map(|item| {
            message_uuids
                .get(&item.legacy_id)
                .copied()
                .map(|uuid| (item.legacy_id, item.id_uuid.unwrap_or(uuid)))
        })
        .collect::<Vec<_>>();
    let updated_inbox_rows = update_uuid_column(
        &txn,
        inbox_item::Entity,
        inbox_item::Column::LegacyId,
        inbox_item::Column::IdUuid,
        &inbox_rows,
    )
    .await
    .c(h!())?;
    let inbox_rows = inbox_item::Entity::find()
        .select_only()
        .column(inbox_item::Column::LegacyId)
        .column(inbox_item::Column::IdUuid)
        .filter(inbox_item::Column::LegacyId.eq_any(message_ids.clone()))
        .filter(inbox_item::Column::IdUuid.is_not_null())
        .into_tuple::<(i64, Uuid)>()
        .all(&txn)
        .await
        .c(h!())?;
    let mut linked_rows = updated_inbox_rows;
    linked_rows += update_linked_column(
        &txn,
        sigint_search::Entity,
        sigint_search::Column::LegacyId,
        sigint_search::Column::Uuid,
        &inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        signal_message_group::Entity,
        signal_message_group::Column::LegacyId,
        signal_message_group::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        signal_message_media::Entity,
        signal_message_media::Column::LegacyId,
        signal_message_media::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        sigint_bookmark::Entity,
        sigint_bookmark::Column::LegacyId,
        sigint_bookmark::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        sigint_important::Entity,
        sigint_important::Column::LegacyId,
        sigint_important::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        sigint_comment::Entity,
        sigint_comment::Column::LegacyId,
        sigint_comment::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        sigint_comment_migrated::Entity,
        sigint_comment_migrated::Column::LegacyId,
        sigint_comment_migrated::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        intel_product_intel::Entity,
        intel_product_intel::Column::LegacyId,
        intel_product_intel::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        &txn,
        intel_product_source::Entity,
        intel_product_source::Column::LegacyId,
        intel_product_source::Column::Uuid,
        &message_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_inbox_linked_columns(&txn, &inbox_rows)
        .await
        .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok((
        messages.len(),
        messages.last().map_or(cursor, |message| message.legacy_id),
        linked_rows,
    ))
}

async fn update_inbox_linked_columns<C: ConnectionTrait>(
    db: &C,
    inbox_rows: &[(i64, Uuid)],
) -> anyhow::Result<usize> {
    let mut linked_rows = 0;
    linked_rows += update_linked_column(
        db,
        ai_callsign_worker_job::Entity,
        ai_callsign_worker_job::Column::LegacyId,
        ai_callsign_worker_job::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_failed_unit_label::Entity,
        inbox_item_failed_unit_label::Column::LegacyId,
        inbox_item_failed_unit_label::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_callsign::Entity,
        inbox_item_callsign::Column::LegacyId,
        inbox_item_callsign::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_metadata::Entity,
        inbox_item_metadata::Column::LegacyId,
        inbox_item_metadata::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_network::Entity,
        inbox_item_network::Column::LegacyId,
        inbox_item_network::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_point_token::Entity,
        inbox_item_point_token::Column::LegacyId,
        inbox_item_point_token::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_settlement::Entity,
        inbox_item_settlement::Column::LegacyId,
        inbox_item_settlement::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_tag::Entity,
        inbox_item_tag::Column::LegacyId,
        inbox_item_tag::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_unit::Entity,
        inbox_item_unit::Column::LegacyId,
        inbox_item_unit::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_item_unit_tag_queue::Entity,
        inbox_item_unit_tag_queue::Column::LegacyId,
        inbox_item_unit_tag_queue::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        inbox_tag_model_error::Entity,
        inbox_tag_model_error::Column::LegacyId,
        inbox_tag_model_error::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    linked_rows += update_linked_column(
        db,
        sigint_peleng::Entity,
        sigint_peleng::Column::LegacyId,
        sigint_peleng::Column::Uuid,
        inbox_rows,
    )
    .await
    .c(h!())?;
    Ok(linked_rows)
}

async fn update_linked_column<C, E>(
    db: &C,
    entity: E,
    legacy_column: E::Column,
    uuid_column: E::Column,
    rows: &[(i64, Uuid)],
) -> anyhow::Result<usize>
where
    C: ConnectionTrait,
    E: EntityTrait + Copy,
    E::Column: ColumnTrait + Copy,
{
    update_uuid_column(db, entity, legacy_column, uuid_column, rows)
        .await
        .c(h!())
}

async fn update_uuid_column<C, E>(
    db: &C,
    _entity: E,
    legacy_column: E::Column,
    uuid_column: E::Column,
    rows: &[(i64, Uuid)],
) -> anyhow::Result<usize>
where
    C: ConnectionTrait,
    E: EntityTrait + Copy,
    E::Column: ColumnTrait + Copy,
{
    if rows.is_empty() {
        return Ok(0);
    }
    let uuid_expression = rows.iter().skip(1).fold(
        Expr::case(
            Expr::col(legacy_column).eq(rows[0].0),
            Expr::value(rows[0].1),
        ),
        |expression, (legacy_id, uuid)| {
            expression.case(
                Expr::col(legacy_column).eq(*legacy_id),
                Expr::value(*uuid),
            )
        },
    );
    let ids = rows.iter().map(|row| row.0).collect::<Vec<_>>();
    Ok(E::update_many()
        .filter(legacy_column.eq_any(ids))
        .filter(uuid_column.is_null())
        .col_expr(
            uuid_column,
            uuid_expression.finally(Expr::col(uuid_column)).into(),
        )
        .exec(db)
        .await
        .c(h!())?
        .rows_affected as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_backfill_batch_size_is_bounded() {
        assert!(validate_batch_size(1).is_ok());
        assert!(validate_batch_size(
            crate::config::SIGNAL_MESSAGE_UUID_BACKFILL_BATCH_SIZE_MAX
        )
        .is_ok());
        assert!(validate_batch_size(0).is_err());
        assert!(validate_batch_size(
            crate::config::SIGNAL_MESSAGE_UUID_BACKFILL_BATCH_SIZE_MAX + 1
        )
        .is_err());
    }
}
