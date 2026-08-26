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
        failed_inbox_unit,
        "failed_inbox_unit",
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
    ai_callsign_worker_job, failed_inbox_unit, inbox_item_callsign,
    inbox_item_metadata, inbox_item_network, inbox_item_point_token,
    inbox_item_settlement, inbox_item_tag, inbox_item_unit,
    inbox_item_unit_tag_queue, inbox_tag_model_error, intel_product_intel,
    intel_product_source, sigint_bookmark, sigint_comment,
    sigint_comment_migrated, sigint_important, sigint_peleng, sigint_search,
    signal_message_group, signal_message_media,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Checkpoint {
    phase: usize,
    cursor: i64,
}

pub async fn oneoff_backfill_signal_message_uuid(
    mode: Mode,
    ps: &OneoffBackfillSignalMessageUuidPs,
) -> Result<(), AppError> {
    if ps.batch_size == 0 {
        return Err(AppError::BL {
            msg: "batch-size must be greater than zero".to_string(),
        });
    }
    let db = crate::new_pg_maintenance_connection_from_mode(mode)
        .await
        .c(h!())?;
    let mut checkpoint = if ps.reset_checkpoint {
        Checkpoint::default()
    } else {
        crate::kv::get_kv(&db, CHECKPOINT_KEY)
            .await
            .c(h!())?
            .unwrap_or_default()
    };
    while checkpoint.phase < 23 {
        let (processed, next_cursor) = match checkpoint.phase {
            0 => {
                backfill_signal_messages(&db, checkpoint.cursor, ps.batch_size)
                    .await
                    .c(h!())?
            }
            1 => backfill_inbox_items(&db, checkpoint.cursor, ps.batch_size)
                .await
                .c(h!())?,
            2 => backfill_linked_column(
                &db,
                sigint_search::Entity,
                sigint_search::Column::LegacyId,
                sigint_search::Column::Uuid,
                inbox_item::Entity,
                inbox_item::Column::LegacyId,
                inbox_item::Column::IdUuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            3 => backfill_signal_link(
                &db,
                signal_message_group::Entity,
                signal_message_group::Column::LegacyId,
                signal_message_group::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            4 => backfill_signal_link(
                &db,
                signal_message_media::Entity,
                signal_message_media::Column::LegacyId,
                signal_message_media::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            5 => backfill_signal_link(
                &db,
                sigint_bookmark::Entity,
                sigint_bookmark::Column::LegacyId,
                sigint_bookmark::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            6 => backfill_signal_link(
                &db,
                sigint_important::Entity,
                sigint_important::Column::LegacyId,
                sigint_important::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            7 => backfill_signal_link(
                &db,
                sigint_comment::Entity,
                sigint_comment::Column::LegacyId,
                sigint_comment::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            8 => backfill_signal_link(
                &db,
                sigint_comment_migrated::Entity,
                sigint_comment_migrated::Column::LegacyId,
                sigint_comment_migrated::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            9 => backfill_signal_link(
                &db,
                intel_product_intel::Entity,
                intel_product_intel::Column::LegacyId,
                intel_product_intel::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            10 => backfill_signal_link(
                &db,
                intel_product_source::Entity,
                intel_product_source::Column::LegacyId,
                intel_product_source::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            11 => backfill_inbox_link(
                &db,
                ai_callsign_worker_job::Entity,
                ai_callsign_worker_job::Column::LegacyId,
                ai_callsign_worker_job::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            12 => backfill_inbox_link(
                &db,
                failed_inbox_unit::Entity,
                failed_inbox_unit::Column::LegacyId,
                failed_inbox_unit::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            13 => backfill_inbox_link(
                &db,
                inbox_item_callsign::Entity,
                inbox_item_callsign::Column::LegacyId,
                inbox_item_callsign::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            14 => backfill_inbox_link(
                &db,
                inbox_item_metadata::Entity,
                inbox_item_metadata::Column::LegacyId,
                inbox_item_metadata::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            15 => backfill_inbox_link(
                &db,
                inbox_item_network::Entity,
                inbox_item_network::Column::LegacyId,
                inbox_item_network::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            16 => backfill_inbox_link(
                &db,
                inbox_item_point_token::Entity,
                inbox_item_point_token::Column::LegacyId,
                inbox_item_point_token::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            17 => backfill_inbox_link(
                &db,
                inbox_item_settlement::Entity,
                inbox_item_settlement::Column::LegacyId,
                inbox_item_settlement::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            18 => backfill_inbox_link(
                &db,
                inbox_item_tag::Entity,
                inbox_item_tag::Column::LegacyId,
                inbox_item_tag::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            19 => backfill_inbox_link(
                &db,
                inbox_item_unit::Entity,
                inbox_item_unit::Column::LegacyId,
                inbox_item_unit::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            20 => backfill_inbox_link(
                &db,
                inbox_item_unit_tag_queue::Entity,
                inbox_item_unit_tag_queue::Column::LegacyId,
                inbox_item_unit_tag_queue::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            21 => backfill_inbox_link(
                &db,
                inbox_tag_model_error::Entity,
                inbox_tag_model_error::Column::LegacyId,
                inbox_tag_model_error::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            22 => backfill_inbox_link(
                &db,
                sigint_peleng::Entity,
                sigint_peleng::Column::LegacyId,
                sigint_peleng::Column::Uuid,
                checkpoint.cursor,
                ps.batch_size,
            )
            .await
            .c(h!())?,
            _ => unreachable!(),
        };
        if processed == 0 {
            println!("phase {} completed", checkpoint.phase + 1);
            checkpoint.phase += 1;
            checkpoint.cursor = 0;
        } else {
            checkpoint.cursor = next_cursor;
            println!(
                "phase {}: +{processed} rows, through legacy id {}",
                checkpoint.phase + 1,
                checkpoint.cursor
            );
        }
        crate::kv::put_kv(&db, CHECKPOINT_KEY, checkpoint.clone())
            .await
            .c(h!())?;
    }
    println!("signal-message UUID backfill completed");
    Ok(())
}

async fn backfill_signal_messages<C: ConnectionTrait>(
    db: &C,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64)> {
    let messages = signal_message::Entity::find()
        .filter(signal_message::Column::LegacyId.gt(cursor))
        .filter(signal_message::Column::IdUuid.is_null())
        .order_by_asc(signal_message::Column::LegacyId)
        .limit(batch_size)
        .all(db)
        .await
        .c(h!())?;
    let rows = messages
        .iter()
        .map(|message| {
            (
                message.legacy_id,
                signal_message_uuid(message.timestamp, message.created_at),
            )
        })
        .collect::<Vec<_>>();
    update_uuid_column(
        db,
        signal_message::Entity,
        signal_message::Column::LegacyId,
        signal_message::Column::IdUuid,
        &rows,
    )
    .await
    .c(h!())?;
    Ok((rows.len(), rows.last().map_or(cursor, |row| row.0)))
}

async fn backfill_inbox_items<C: ConnectionTrait>(
    db: &C,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64)> {
    let items = inbox_item::Entity::find()
        .filter(inbox_item::Column::LegacyId.gt(cursor))
        .filter(inbox_item::Column::IdUuid.is_null())
        .order_by_asc(inbox_item::Column::LegacyId)
        .limit(batch_size)
        .all(db)
        .await
        .c(h!())?;
    let ids = items.iter().map(|item| item.legacy_id).collect::<Vec<_>>();
    let message_uuids = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::LegacyId)
        .column(signal_message::Column::IdUuid)
        .filter(signal_message::Column::LegacyId.eq_any(ids))
        .filter(signal_message::Column::IdUuid.is_not_null())
        .into_tuple::<(i64, Uuid)>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashMap<_, _>>();
    let rows = items
        .iter()
        .filter_map(|item| {
            message_uuids
                .get(&item.legacy_id)
                .copied()
                .map(|uuid| (item.legacy_id, uuid))
        })
        .collect::<Vec<_>>();
    update_uuid_column(
        db,
        inbox_item::Entity,
        inbox_item::Column::LegacyId,
        inbox_item::Column::IdUuid,
        &rows,
    )
    .await
    .c(h!())?;
    Ok((
        rows.len(),
        items.last().map_or(cursor, |item| item.legacy_id),
    ))
}

async fn backfill_signal_link<C, E>(
    db: &C,
    entity: E,
    legacy_column: E::Column,
    uuid_column: E::Column,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64)>
where
    C: ConnectionTrait,
    E: EntityTrait + Copy,
    E::Column: ColumnTrait + Copy,
{
    backfill_linked_column(
        db,
        entity,
        legacy_column,
        uuid_column,
        signal_message::Entity,
        signal_message::Column::LegacyId,
        signal_message::Column::IdUuid,
        cursor,
        batch_size,
    )
    .await
}

async fn backfill_inbox_link<C, E>(
    db: &C,
    entity: E,
    legacy_column: E::Column,
    uuid_column: E::Column,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64)>
where
    C: ConnectionTrait,
    E: EntityTrait + Copy,
    E::Column: ColumnTrait + Copy,
{
    backfill_linked_column(
        db,
        entity,
        legacy_column,
        uuid_column,
        inbox_item::Entity,
        inbox_item::Column::LegacyId,
        inbox_item::Column::IdUuid,
        cursor,
        batch_size,
    )
    .await
}

async fn backfill_linked_column<C, E, S>(
    db: &C,
    entity: E,
    legacy_column: E::Column,
    uuid_column: E::Column,
    source_entity: S,
    source_legacy_column: S::Column,
    source_uuid_column: S::Column,
    cursor: i64,
    batch_size: u64,
) -> anyhow::Result<(usize, i64)>
where
    C: ConnectionTrait,
    E: EntityTrait + Copy,
    E::Column: ColumnTrait + Copy,
    S: EntityTrait + Copy,
    S::Column: ColumnTrait + Copy,
{
    let _ = source_entity;
    let legacy_ids = E::find()
        .select_only()
        .column(legacy_column)
        .filter(uuid_column.is_null())
        .filter(legacy_column.gt(cursor))
        .order_by_asc(legacy_column)
        .limit(batch_size)
        .into_tuple::<i64>()
        .all(db)
        .await
        .c(h!())?;
    let last_id = legacy_ids.last().copied().unwrap_or(cursor);
    let rows = S::find()
        .select_only()
        .column(source_legacy_column)
        .column(source_uuid_column)
        .filter(source_legacy_column.eq_any(legacy_ids))
        .filter(source_uuid_column.is_not_null())
        .into_tuple::<(i64, Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    update_uuid_column(db, entity, legacy_column, uuid_column, &rows)
        .await
        .c(h!())?;
    Ok((rows.len(), last_id))
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
        .col_expr(
            uuid_column,
            uuid_expression.finally(Expr::col(uuid_column)).into(),
        )
        .exec(db)
        .await
        .c(h!())?
        .rows_affected as usize)
}
