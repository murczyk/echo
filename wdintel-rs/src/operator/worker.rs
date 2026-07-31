use crate::config::OPERATOR_INBOX_WORKER_LOOKBACK_HOURS;
use crate::entities::*;
use crate::error::AppError;
use crate::h;
use crate::types::{Mode, ShortContext};
use crate::utils::orm::ArrayColumnOps;
use crate::utils::worker_watch;
use chrono::{NaiveDateTime, Utc};
use echo_migration::JoinType;
use sea_orm::*;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

const RECEIVE_INTERVAL_SECONDS: u32 = 3;

pub async fn run_operator_inbox_worker_nofail(mode: Mode) {
    let (config, settlements, rq, mut redis, dbx) =
        crate::utils::setup_worker(mode).await.unwrap();
    let mut all_datasources = vec![];

    let mut last_datasource_sync_at = tokio::time::Instant::now();
    let mut receive_interval = tokio::time::interval_at(
        last_datasource_sync_at,
        tokio::time::Duration::from_secs(RECEIVE_INTERVAL_SECONDS as u64),
    );
    let sync_duration = tokio::time::Duration::from_secs(5);

    loop {
        let _loop_guard = worker_watch::loop_guard("operator_inbox_worker");

        let now = receive_interval.tick().await;
        if now.duration_since(last_datasource_sync_at) > sync_duration {
            all_datasources = datasource::Entity::find()
                .filter(datasource::Column::Kind.eq("echo_operator"))
                .filter(datasource::Column::Deleted.eq(false))
                .order_by_asc(datasource::Column::Id)
                .all(&dbx)
                .await
                .c(h!())
                .unwrap_or(vec![]);
            last_datasource_sync_at = now;
        }

        for datasource in &all_datasources {
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
        if let Err(e) = import_sigint_inbox_message_metadata(&dbx).await.c(h!())
        {
            println!("> echo_operator::import_sigint_inbox_message_metadata error: {e:?}");
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
    let echo_operator_queue =
        load_echo_operator_queue(dbx, datasource.id).await.c(h!())?;
    for id in echo_operator_queue {
        let txn = dbx.begin().await.c(h!())?;
        let changed_inbox_item_ids =
            crate::rer_importer::bgworker::process_message_to_inbox_nofail(
                settlements.clone(),
                &txn,
                rq,
                config,
                id,
                None,
            )
            .await;

        crate::sigint::worker::incoming_message_after_insert(&txn, id)
            .await
            .c(h!())?;
        txn.commit().await.c(h!())?;
        crate::inbox::fanout_inbox_changes(redis, changed_inbox_item_ids)
            .await
            .c(h!())?;
    }
    Ok(())
}

async fn load_echo_operator_queue(
    dbx: &DatabaseConnection,
    datasource_id: i64,
) -> Result<Vec<i64>, AppError> {
    let datasource_group_ids =
        load_operator_datasource_group_ids(dbx, datasource_id)
            .await
            .c(h!())?;
    if datasource_group_ids.is_empty() {
        return Ok(vec![]);
    }

    let now = Utc::now().naive_utc();
    let since =
        now - chrono::Duration::hours(OPERATOR_INBOX_WORKER_LOOKBACK_HOURS);
    let till = now - chrono::Duration::seconds(RECEIVE_INTERVAL_SECONDS as i64);
    let mut rows = vec![];
    for datasource_group_id in datasource_group_ids {
        rows.extend(
            load_echo_operator_queue_for_group(
                dbx,
                datasource_group_id,
                since,
                till,
            )
            .await
            .c(h!())?,
        );
    }
    rows.sort_by_key(|(_, left)| *left);
    rows.truncate(50);

    Ok(rows.into_iter().map(|(id, _)| id).collect())
}

async fn load_echo_operator_queue_for_group(
    dbx: &DatabaseConnection,
    datasource_group_id: i64,
    since: NaiveDateTime,
    till: NaiveDateTime,
) -> Result<Vec<(i64, NaiveDateTime)>, AppError> {
    let rows = signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::Id)
        .column(signal_message::Column::CreatedAt)
        .join(
            JoinType::LeftJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .filter(sigint_inbox_item::Column::Id.is_null())
        .filter(
            signal_message::Column::DatasourceGroupId.eq(datasource_group_id),
        )
        // Intentionally ignore older operator backlog here. This worker is a
        // near-live bridge, and old recovery must be handled explicitly rather
        // than reopening broad scans on signal_message.
        .filter(signal_message::Column::CreatedAt.gte(since))
        .filter(signal_message::Column::CreatedAt.lte(till))
        .order_by_asc(signal_message::Column::CreatedAt)
        .limit(50)
        .into_tuple::<(i64, NaiveDateTime)>()
        .all(dbx)
        .await
        .c(h!())?;

    Ok(rows)
}

async fn load_operator_datasource_group_ids(
    dbx: &DatabaseConnection,
    datasource_id: i64,
) -> Result<Vec<i64>, AppError> {
    let ids = datasource_group::Entity::find()
        .select_only()
        .column(datasource_group::Column::Id)
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;

    Ok(ids)
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
