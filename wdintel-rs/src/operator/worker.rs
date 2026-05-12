use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::utils::worker_watch;
use chrono::Utc;
use echo_migration::JoinType;
use sea_orm::*;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub async fn run_operator_inbox_worker_nofail(mode: Mode) {
    let (config, settlements, rq, mut redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    let mut all_datasources = vec![];
    let mut datasource_list_next_sync_at = Utc::now().naive_utc();
    loop {
        let _loop_guard = worker_watch::loop_guard("operator_inbox_worker");
        let now = Utc::now().naive_utc();
        if datasource_list_next_sync_at <= now {
            datasource_list_next_sync_at =
                (Utc::now() + tokio::time::Duration::from_secs(5)).naive_utc();
            all_datasources = datasource::Entity::find()
                .filter(datasource::Column::Kind.eq("echo_operator"))
                .order_by_asc(datasource::Column::Id)
                .all(&dbx)
                .await
                .c(h!())
                .unwrap_or(vec![]);
        }
        if all_datasources.is_empty() {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }
        for datasource in all_datasources.iter() {
            if let Err(e) = receive_once(
                settlements.clone(),
                &config,
                &dbx,
                &rq,
                &mut redis,
                datasource,
            )
            .await
            .c(h!())
            {
                println!("> echo_operator::receive_thread_nofail error: {e:?}");
            }
        }
    }
}

async fn receive_once(
    settlements: Arc<RwLock<crate::location::SettlementsDataConfig>>,
    config: &crate::config::Config,
    dbx: &DatabaseConnection,
    rq: &reqwest::Client,
    redis: &mut redis::aio::ConnectionManager,
    datasource: &datasource::Model,
) -> Result<(), AppError> {
    let now = Utc::now();
    let echo_operator_queue = signal_message::Entity::find()
        .select_only()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .column(signal_message::Column::Id)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_inbox_item::Column::Id.is_null())
        .filter(datasource_group::Column::DatasourceId.eq(datasource.id))
        .filter(
            signal_message::Column::CreatedAt
                .lte(now - chrono::Duration::seconds(3)),
        )
        .order_by_asc(signal_message::Column::CreatedAt)
        .limit(50)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    for id in echo_operator_queue {
        let txn = dbx.begin().await.c(h!())?;
        crate::rer_importer::bgworker::process_message_to_inbox_nofail(
            settlements.clone(),
            &txn,
            rq,
            config,
            redis,
            id,
            None,
        )
        .await;

        crate::sigint::worker::incoming_message_after_insert(&txn, id)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;
    }
    import_sigint_inbox_message_metadata(dbx).await.c(h!())?;
    Ok(())
}

async fn import_sigint_inbox_message_metadata(
    dbx: &DatabaseConnection,
) -> Result<(), AppError> {
    let txn = dbx.begin().await.c(h!())?;

    let metadata_with_messages = signal_message_metadata::Entity::find()
        .join_rev(
            JoinType::InnerJoin,
            signal_message::Entity::belongs_to(signal_message_metadata::Entity)
                .from(signal_message::Column::MessageUid)
                .to(signal_message_metadata::Column::MessageUid)
                .into(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintInboxItemMetadata.def(),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .select_only()
        .column_as(
            signal_message_metadata::Column::Id,
            "signal_message_metadata_id",
        )
        .column_as(sigint_inbox_item::Column::Id, "sigint_inbox_item_id")
        .column_as(
            sigint_inbox_item_metadata::Column::Id,
            "sigint_inbox_item_metadata_id",
        )
        .column(signal_message_metadata::Column::DmrSenderId)
        .column(signal_message_metadata::Column::DmrCallGroupId)
        .column(signal_message_metadata::Column::DmrColorCode)
        .limit(100)
        .into_model::<MetadataMessageRow>()
        .all(&txn)
        .await
        .c(h!())?;

    if metadata_with_messages.is_empty() {
        return Ok(());
    }

    let mut signal_message_metadata_ids =
        Vec::with_capacity(metadata_with_messages.len());
    let mut existing_metadata_ids =
        Vec::with_capacity(metadata_with_messages.len());

    for row in &metadata_with_messages {
        signal_message_metadata_ids.push(row.signal_message_metadata_id);
        if let Some(sigint_inbox_item_metadata_id) =
            row.sigint_inbox_item_metadata_id
        {
            existing_metadata_ids.push(sigint_inbox_item_metadata_id);
        }
    }

    let mut existing_metadata: HashMap<
        i64,
        sigint_inbox_item_metadata::ActiveModel,
    > = sigint_inbox_item_metadata::Entity::find()
        .filter(
            sigint_inbox_item_metadata::Column::Id
                .eq_any(existing_metadata_ids),
        )
        .all(&txn)
        .await
        .c(h!())?
        .into_iter()
        .map(|item| (item.id, item.into_active_model()))
        .collect();

    let mut new_metadata = vec![];

    for row in metadata_with_messages {
        if let Some(mut existing_model) = row
            .sigint_inbox_item_metadata_id
            .and_then(|id| existing_metadata.remove(&id))
        {
            if merge_metadata(&mut existing_model, row) {
                existing_model.update(&txn).await.c(h!())?;
            }
        } else {
            let new_model = sigint_inbox_item_metadata::ActiveModel {
                sigint_inbox_item_id: Set(row.sigint_inbox_item_id),
                sender_id: Set(row.dmr_sender_id),
                call_group_id: Set(row.dmr_call_group_id),
                color_code: Set(row.dmr_color_code),
                ..Default::default()
            };
            new_metadata.push(new_model);
        }
    }

    if !new_metadata.is_empty() {
        sigint_inbox_item_metadata::Entity::insert_many(new_metadata)
            .exec_without_returning(&txn)
            .await
            .c(h!())?;
    }

    signal_message_metadata::Entity::delete_many()
        .filter(
            signal_message_metadata::Column::Id
                .eq_any(signal_message_metadata_ids),
        )
        .exec(&txn)
        .await
        .c(h!())?;

    txn.commit().await.c(h!())?;

    Ok(())
}

fn merge_metadata(
    existing_model: &mut sigint_inbox_item_metadata::ActiveModel,
    row: MetadataMessageRow,
) -> bool {
    let mut updated = false;
    if row.dmr_color_code.is_some()
        && &row.dmr_color_code != existing_model.color_code.as_ref()
    {
        existing_model.color_code = Set(row.dmr_color_code);
        existing_model.color_code_start_index = Set(None);
        existing_model.color_code_end_index = Set(None);
        updated = true;
    }

    if row.dmr_sender_id.is_some()
        && &row.dmr_sender_id != existing_model.sender_id.as_ref()
    {
        existing_model.sender_id = Set(row.dmr_sender_id);
        existing_model.sender_id_start_index = Set(None);
        existing_model.sender_id_end_index = Set(None);
        updated = true;
    }

    if row.dmr_call_group_id.is_some()
        && &row.dmr_call_group_id != existing_model.call_group_id.as_ref()
    {
        existing_model.call_group_id = Set(row.dmr_call_group_id);
        existing_model.call_group_id_start_index = Set(None);
        existing_model.call_group_id_end_index = Set(None);
        updated = true;
    }

    updated
}

#[derive(FromQueryResult)]
struct MetadataMessageRow {
    pub signal_message_metadata_id: i64,
    pub sigint_inbox_item_id: i64,
    pub sigint_inbox_item_metadata_id: Option<i64>,

    pub dmr_sender_id: Option<String>,
    pub dmr_call_group_id: Option<String>,
    pub dmr_color_code: Option<String>,
}
