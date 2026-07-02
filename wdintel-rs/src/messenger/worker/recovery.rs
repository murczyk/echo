use super::clear_messenger_login_string;
use crate::config::*;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::location::SettlementsDataConfig;
use crate::message_queue::{
    process_signal_message_queue_item_with_options,
    ProcessSignalMessageQueueItemOptions,
};
use crate::messenger::bl::list_echo_accounts;
use crate::messenger::types::{EchoAccountF1, Message};
use crate::types::*;
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::{
    ActiveEnum, ActiveModelTrait, ActiveValue::Set, ColumnTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, TransactionTrait,
};

pub struct EchoImSyncRecoveryDeps<'a> {
    pub config: &'a Config,
    pub settlements: Arc<RwLock<SettlementsDataConfig>>,
    pub rq: &'a reqwest::Client,
    pub s3: &'a Option<opendal::Operator>,
}

struct RecoveryMaps {
    existing_signal_ids: HashSet<i64>,
    queue_items: BTreeMap<i64, signal_message_queue::Model>,
    queue_attachments:
        HashMap<i64, Vec<signal_message_queue_attachment::Model>>,
    groups: BTreeMap<i32, echo_group::Model>,
    senders: BTreeMap<i32, echo_sender::Model>,
    attachments: HashMap<i32, Vec<echo_attachment::Model>>,
}

pub async fn run_echo_im_sync_recovery_once(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
) -> anyhow::Result<usize> {
    let sync_since = crate::system_settings::get_echo_im_sync_since(dbx)
        .await
        .c(h!())?;
    let cutoff = Utc::now().naive_utc()
        - chrono::TimeDelta::minutes(ECHO_IM_SYNC_RECOVERY_LAG_MINUTES);
    if cutoff <= sync_since {
        return Ok(0);
    }

    let datasources =
        active_linked_datasources_by_account(dbx).await.c(h!())?;
    if datasources.is_empty() {
        return Ok(0);
    }

    let account_ids = datasources.keys().cloned().collect_vec();
    let inbox_messages =
        load_candidate_inbox_messages(dbx, &account_ids, sync_since, cutoff)
            .await
            .c(h!())?;
    if inbox_messages.is_empty() {
        return Ok(0);
    }

    let max_created_at = inbox_messages.iter().map(|m| m.created_at).max();
    let maps = load_recovery_maps(dbx, &inbox_messages).await.c(h!())?;
    let missing_count = process_candidates(
        dbx,
        redis,
        deps,
        &datasources,
        &maps,
        &inbox_messages,
    )
    .await
    .c(h!())?;

    if let Some(max_created_at) = max_created_at {
        crate::system_settings::advance_echo_im_sync_since(dbx, max_created_at)
            .await
            .c(h!())?;
    }

    Ok(missing_count)
}

async fn active_linked_datasources_by_account(
    dbx: &DatabaseConnection,
) -> anyhow::Result<BTreeMap<i32, EchoAccountF1>> {
    let active_status = AccountStatus::Active.into_value();
    let mut datasources = BTreeMap::new();
    for datasource in list_echo_accounts(None, dbx).await.c(h!())? {
        if !datasource.is_linked || datasource.status != active_status {
            continue;
        }
        let Some(account_id) = datasource
            .echo_account_id
            .as_deref()
            .and_then(|id| id.parse::<i32>().ok())
        else {
            continue;
        };
        datasources.insert(account_id, datasource);
    }
    Ok(datasources)
}

async fn load_candidate_inbox_messages(
    dbx: &DatabaseConnection,
    account_ids: &[i32],
    sync_since: NaiveDateTime,
    cutoff: NaiveDateTime,
) -> anyhow::Result<Vec<echo_inbox_message::Model>> {
    echo_inbox_message::Entity::find()
        .filter(
            echo_inbox_message::Column::AccountId.is_in(account_ids.to_vec()),
        )
        .filter(echo_inbox_message::Column::CreatedAt.gt(sync_since))
        .filter(echo_inbox_message::Column::CreatedAt.lte(cutoff))
        .order_by_asc(echo_inbox_message::Column::CreatedAt)
        .order_by_asc(echo_inbox_message::Column::Id)
        .limit(ECHO_IM_SYNC_RECOVERY_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())
}

async fn load_recovery_maps(
    dbx: &DatabaseConnection,
    inbox_messages: &[echo_inbox_message::Model],
) -> anyhow::Result<RecoveryMaps> {
    let inbox_ids_i64 = inbox_messages
        .iter()
        .map(|message| i64::from(message.id))
        .collect_vec();
    let inbox_ids_i32 = inbox_messages
        .iter()
        .map(|message| message.id)
        .collect_vec();

    let existing_signal_ids = if inbox_ids_i64.is_empty() {
        HashSet::new()
    } else {
        signal_message::Entity::find()
            .filter(
                signal_message::Column::ExternalId.is_in(inbox_ids_i64.clone()),
            )
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .filter_map(|message| message.external_id)
            .collect::<HashSet<_>>()
    };

    let queue_items_vec = if inbox_ids_i64.is_empty() {
        vec![]
    } else {
        signal_message_queue::Entity::find()
            .filter(
                signal_message_queue::Column::InternalId
                    .is_in(inbox_ids_i64.clone()),
            )
            .order_by_asc(signal_message_queue::Column::CreatedAt)
            .all(dbx)
            .await
            .c(h!())?
    };
    let queue_item_ids =
        queue_items_vec.iter().map(|item| item.id).collect_vec();
    let mut queue_items = BTreeMap::new();
    for queue_item in queue_items_vec {
        queue_items
            .entry(queue_item.internal_id)
            .or_insert(queue_item);
    }

    let queue_attachments = if queue_item_ids.is_empty() {
        HashMap::new()
    } else {
        signal_message_queue_attachment::Entity::find()
            .filter(
                signal_message_queue_attachment::Column::MessageId
                    .is_in(queue_item_ids),
            )
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .into_group_map_by(|attachment| attachment.message_id)
    };

    let group_ids = inbox_messages
        .iter()
        .filter_map(|message| message.group_id)
        .collect_vec();
    let groups = if group_ids.is_empty() {
        BTreeMap::new()
    } else {
        echo_group::Entity::find()
            .filter(echo_group::Column::Id.is_in(group_ids))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|group| (group.id, group))
            .collect()
    };

    let sender_ids = inbox_messages
        .iter()
        .filter_map(|message| message.sender_id)
        .collect_vec();
    let senders = if sender_ids.is_empty() {
        BTreeMap::new()
    } else {
        echo_sender::Entity::find()
            .filter(echo_sender::Column::Id.is_in(sender_ids))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .map(|sender| (sender.id, sender))
            .collect()
    };

    let attachments = if inbox_ids_i32.is_empty() {
        HashMap::new()
    } else {
        echo_attachment::Entity::find()
            .filter(echo_attachment::Column::MessageId.is_in(inbox_ids_i32))
            .all(dbx)
            .await
            .c(h!())?
            .into_iter()
            .into_group_map_by(|attachment| attachment.message_id)
    };

    Ok(RecoveryMaps {
        existing_signal_ids,
        queue_items,
        queue_attachments,
        groups,
        senders,
        attachments,
    })
}

async fn process_candidates(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    maps: &RecoveryMaps,
    inbox_messages: &[echo_inbox_message::Model],
) -> anyhow::Result<usize> {
    let mut missing_count = 0usize;
    for inbox_message in inbox_messages {
        let inbox_id = i64::from(inbox_message.id);
        if maps.existing_signal_ids.contains(&inbox_id) {
            continue;
        }
        missing_count += 1;
        let datasource_id = recovery_datasource_id(
            inbox_message,
            datasources,
            maps.queue_items.get(&inbox_id),
        );

        if let Some(reason) = skipped_inbox_reason(inbox_message) {
            log_skipped_inbox(inbox_message, datasource_id, reason);
            continue;
        }

        let recovery = if let Some(queue_item) = maps.queue_items.get(&inbox_id)
        {
            recover_queue_item(
                dbx,
                redis,
                deps,
                inbox_message,
                queue_item,
                maps,
            )
            .await
        } else {
            recover_inbox_message(
                dbx,
                redis,
                deps,
                datasources,
                inbox_message,
                maps,
            )
            .await
        };

        match recovery {
            Ok(message_uid) => {
                log_recovered_inbox(inbox_message, datasource_id, &message_uid)
            }
            Err(err) => log_recovery_error(inbox_message, datasource_id, &err),
        }
    }
    Ok(missing_count)
}

fn recovery_datasource_id(
    message: &echo_inbox_message::Model,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    queue_item: Option<&signal_message_queue::Model>,
) -> Option<i64> {
    queue_item
        .map(|queue_item| queue_item.datasource_id)
        .or_else(|| datasources.get(&message.account_id).map(|d| d.id))
}

fn skipped_inbox_reason(
    message: &echo_inbox_message::Model,
) -> Option<&'static str> {
    if message.deleted {
        Some("deleted")
    } else if message.duplicate_of.is_some() {
        Some("duplicate")
    } else if message.group_id.is_none() {
        Some("private")
    } else {
        None
    }
}

fn log_skipped_inbox(
    message: &echo_inbox_message::Model,
    datasource_id: Option<i64>,
    reason: &str,
) {
    error!(
        "skipping echo_im inbox message during recovery: reason={} inbox_id={} echo_external_id={:?} datasource_id={:?} account_id={} group_id={:?} created_at={} timestamp={:?}",
        reason,
        message.id,
        message.internal_id,
        datasource_id,
        message.account_id,
        message.group_id,
        message.created_at,
        message.timestamp,
    );
}

fn log_recovered_inbox(
    message: &echo_inbox_message::Model,
    datasource_id: Option<i64>,
    message_uid: &str,
) {
    warn!(
        "echo_im inbox message was not ingested properly but was fixed: inbox_id={} echo_external_id={:?} datasource_id={:?} account_id={} group_id={:?} created_at={} timestamp={:?} message_uid={}",
        message.id,
        message.internal_id,
        datasource_id,
        message.account_id,
        message.group_id,
        message.created_at,
        message.timestamp,
        message_uid,
    );
}

fn log_recovery_error(
    message: &echo_inbox_message::Model,
    datasource_id: Option<i64>,
    err: &anyhow::Error,
) {
    error!(
        "failed to recover echo_im inbox message: inbox_id={} echo_external_id={:?} datasource_id={:?} account_id={} group_id={:?} created_at={} timestamp={:?} error={:?}",
        message.id,
        message.internal_id,
        datasource_id,
        message.account_id,
        message.group_id,
        message.created_at,
        message.timestamp,
        err,
    );
}

async fn recover_queue_item(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    inbox_message: &echo_inbox_message::Model,
    queue_item: &signal_message_queue::Model,
    maps: &RecoveryMaps,
) -> anyhow::Result<String> {
    let group_id = queue_item.group_id.clone().c(h!())?;
    let message = Message {
        body: queue_item.body.clone(),
        group_id,
        sender: queue_item.sender_id.clone(),
        timestamp: queue_item.timestamp,
        datasource_id: queue_item.datasource_id,
        inbox_message_id: Some(queue_item.internal_id),
    };
    let attachments = maps
        .queue_attachments
        .get(&queue_item.id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|attachment| MessageAttachmentF1 {
            path: attachment.path,
            name: attachment.name,
        })
        .collect_vec();

    process_recovery_message(
        dbx,
        redis,
        deps,
        inbox_message,
        message,
        attachments,
        queue_item.created_at,
        Some(queue_item.id),
    )
    .await
}

async fn recover_inbox_message(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    inbox_message: &echo_inbox_message::Model,
    maps: &RecoveryMaps,
) -> anyhow::Result<String> {
    let datasource = datasources.get(&inbox_message.account_id).c(h!())?;
    let group_id = inbox_message.group_id.c(h!())?;
    let group = maps.groups.get(&group_id).c(h!())?;
    let sender = inbox_message
        .sender_id
        .and_then(|sender_id| maps.senders.get(&sender_id))
        .map(|sender| clear_messenger_login_string(&sender.uuid));
    let attachments = maps
        .attachments
        .get(&inbox_message.id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|attachment| MessageAttachmentF1 {
            path: attachment.path,
            name: attachment.name,
        })
        .collect_vec();
    let message = Message {
        body: inbox_message.body.clone(),
        group_id: group.group_id.clone(),
        sender,
        timestamp: inbox_message.timestamp.unwrap_or(inbox_message.created_at),
        datasource_id: datasource.id,
        inbox_message_id: Some(i64::from(inbox_message.id)),
    };

    process_recovery_message(
        dbx,
        redis,
        deps,
        inbox_message,
        message,
        attachments,
        inbox_message.created_at,
        None,
    )
    .await
}

async fn process_recovery_message(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    inbox_message: &echo_inbox_message::Model,
    message: Message,
    attachments: Vec<MessageAttachmentF1>,
    created_at: NaiveDateTime,
    queue_item_id: Option<i64>,
) -> anyhow::Result<String> {
    let txn = dbx.begin().await.c(h!())?;
    let result = process_recovery_message_in_txn(
        &txn,
        redis,
        deps,
        inbox_message,
        message,
        attachments,
        created_at,
        queue_item_id,
    )
    .await;

    match result {
        Ok((message_uid, changed_inbox_item_ids)) => {
            txn.commit().await.c(h!())?;
            if let Err(err) = crate::inbox::fanout_inbox_changes(
                redis,
                changed_inbox_item_ids,
            )
            .await
            {
                error!("failed to fanout recovered inbox changes: {:?}", err);
            }
            Ok(message_uid)
        }
        Err(err) => {
            if let Err(rollback_err) = txn.rollback().await {
                error!(
                    "failed to rollback echo_im recovery transaction: {:?}",
                    rollback_err
                );
            }
            Err(err)
        }
    }
}

async fn process_recovery_message_in_txn(
    txn: &DatabaseTransaction,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    inbox_message: &echo_inbox_message::Model,
    message: Message,
    attachments: Vec<MessageAttachmentF1>,
    created_at: NaiveDateTime,
    queue_item_id: Option<i64>,
) -> anyhow::Result<(String, Vec<i64>)> {
    let mut changed_inbox_item_ids = vec![];
    let message_uid = process_signal_message_queue_item_with_options(
        message,
        attachments,
        redis,
        deps.settlements.clone(),
        deps.rq,
        deps.config,
        deps.s3,
        txn,
        false,
        &mut changed_inbox_item_ids,
        ProcessSignalMessageQueueItemOptions {
            created_at: Some(created_at),
        },
    )
    .await
    .c(h!())?;

    mark_inbox_seen(txn, inbox_message).await.c(h!())?;
    if let Some(queue_item_id) = queue_item_id {
        delete_queue_item(txn, queue_item_id).await.c(h!())?;
    }

    Ok((message_uid, changed_inbox_item_ids))
}

async fn mark_inbox_seen(
    txn: &DatabaseTransaction,
    inbox_message: &echo_inbox_message::Model,
) -> anyhow::Result<()> {
    if inbox_message.seen {
        return Ok(());
    }
    let mut inbox_message: echo_inbox_message::ActiveModel =
        inbox_message.clone().into();
    inbox_message.seen = Set(true);
    inbox_message.update(txn).await.c(h!())?;
    Ok(())
}

async fn delete_queue_item(
    txn: &DatabaseTransaction,
    queue_item_id: i64,
) -> anyhow::Result<()> {
    signal_message_queue_attachment::Entity::delete_many()
        .filter(
            signal_message_queue_attachment::Column::MessageId
                .eq(queue_item_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    signal_message_queue::Entity::delete_by_id(queue_item_id)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn oneoff_audit_missing_echo_im_messages(
    mode: Mode,
    ps: &crate::OneoffAuditMissingEchoImMessagesPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let (since_ts, till_ts) = audit_missing_echo_im_messages_bounds(ps)?;
    let echo_inbox_ids =
        load_echo_inbox_message_external_ids(&dbx, since_ts, till_ts).await?;
    let existing_external_ids =
        load_signal_message_external_ids(&dbx, &echo_inbox_ids).await?;
    let unresolved_external_ids = echo_inbox_ids
        .iter()
        .filter(|external_id| !existing_external_ids.contains(external_id))
        .cloned()
        .collect_vec();

    println!("since_ts={since_ts}");
    println!("till_ts={till_ts}");
    println!("echo_inbox_message_count={}", echo_inbox_ids.len());
    println!(
        "resolved_signal_message_count={}",
        existing_external_ids.len()
    );
    println!(
        "unresolved_external_id_count={}",
        unresolved_external_ids.len()
    );
    for external_id in unresolved_external_ids {
        println!("{external_id}");
    }

    Ok(())
}

fn audit_missing_echo_im_messages_bounds(
    ps: &crate::OneoffAuditMissingEchoImMessagesPs,
) -> Result<(NaiveDateTime, NaiveDateTime), AppError> {
    let now = Utc::now().naive_utc();
    let since_ts = audit_missing_echo_im_messages_ts(
        ps.since_ts.as_deref(),
        now - chrono::TimeDelta::hours(24),
    )?;
    let till_ts = audit_missing_echo_im_messages_ts(
        ps.till_ts.as_deref(),
        now - chrono::TimeDelta::minutes(15),
    )?;
    if since_ts >= till_ts {
        return Err(AppError::BL {
            msg: format!(
                "since_ts must be older than till_ts: since_ts={since_ts}, till_ts={till_ts}"
            ),
        });
    }

    Ok((since_ts, till_ts))
}

fn audit_missing_echo_im_messages_ts(
    value: Option<&str>,
    default: NaiveDateTime,
) -> Result<NaiveDateTime, AppError> {
    match value {
        Some(value) => crate::utils::parse_local_datetime(value),
        None => Ok(default),
    }
}

async fn load_echo_inbox_message_external_ids(
    dbx: &DatabaseConnection,
    since_ts: NaiveDateTime,
    till_ts: NaiveDateTime,
) -> Result<Vec<i64>, AppError> {
    Ok(echo_inbox_message::Entity::find()
        .select_only()
        .column(echo_inbox_message::Column::Id)
        .filter(echo_inbox_message::Column::CreatedAt.gte(since_ts))
        .filter(echo_inbox_message::Column::CreatedAt.lt(till_ts))
        .order_by_asc(echo_inbox_message::Column::Id)
        .into_tuple::<i32>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(i64::from)
        .collect_vec())
}

async fn load_signal_message_external_ids(
    dbx: &DatabaseConnection,
    external_ids: &[i64],
) -> Result<HashSet<i64>, AppError> {
    if external_ids.is_empty() {
        return Ok(HashSet::new());
    }

    Ok(signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::ExternalId)
        .filter(signal_message::Column::ExternalId.is_in(external_ids.to_vec()))
        .into_tuple::<Option<i64>>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .flatten()
        .collect())
}
