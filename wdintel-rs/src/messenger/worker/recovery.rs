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
use crate::messenger::missing_message::{
    load_scheduled_missing_messages, mark_missing_message_deleted,
    mark_missing_message_error, mark_missing_message_resolved,
    record_deleted_missing_message, record_missing_message,
    schedule_missing_message, SYSTEM_SCHEDULED_BY,
};
use crate::messenger::types::{EchoAccountF1, Message};
use crate::types::*;
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::{
    ActiveEnum, ActiveModelTrait, ActiveValue::Set, ColumnTrait, Condition,
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
    groups: BTreeMap<i32, echo_group::Model>,
    senders: BTreeMap<i32, echo_sender::Model>,
    attachments: HashMap<i32, Vec<echo_attachment::Model>>,
}

struct ProcessCandidatesResult {
    missing_count: usize,
    max_processed_cursor: Option<crate::system_settings::EchoImSyncCursor>,
}

pub async fn run_echo_im_sync_recovery_once(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
) -> anyhow::Result<usize> {
    let datasources =
        active_linked_datasources_by_account(dbx).await.c(h!())?;
    if datasources.is_empty() {
        return Ok(0);
    }

    let scheduled_count =
        process_scheduled_missing_messages(dbx, redis, deps, &datasources)
            .await
            .c(h!())?;

    let sync_cursor = crate::system_settings::get_echo_im_sync_cursor(dbx)
        .await
        .c(h!())?;
    let autofix_enabled =
        crate::system_settings::autofix_echoim_missing_messages_enabled(dbx)
            .await
            .c(h!())?;
    let cutoff = Utc::now().naive_utc()
        - chrono::TimeDelta::minutes(ECHO_IM_SYNC_RECOVERY_LAG_MINUTES);
    if cutoff < sync_cursor.created_at {
        return Ok(scheduled_count);
    }

    let account_ids = datasources.keys().cloned().collect_vec();
    let inbox_messages =
        load_candidate_inbox_messages(dbx, &account_ids, sync_cursor, cutoff)
            .await
            .c(h!())?;
    if inbox_messages.is_empty() {
        return Ok(scheduled_count);
    }

    let maps = load_recovery_maps(dbx, &datasources, &inbox_messages)
        .await
        .c(h!())?;
    let result = process_candidates(
        dbx,
        redis,
        deps,
        &datasources,
        &maps,
        &inbox_messages,
        autofix_enabled,
    )
    .await
    .c(h!())?;

    if let Some(max_cursor) = result.max_processed_cursor {
        crate::system_settings::advance_echo_im_sync_cursor(dbx, max_cursor)
            .await
            .c(h!())?;
    }

    Ok(scheduled_count + result.missing_count)
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
    sync_cursor: crate::system_settings::EchoImSyncCursor,
    cutoff: NaiveDateTime,
) -> anyhow::Result<Vec<echo_inbox_message::Model>> {
    echo_inbox_message::Entity::find()
        .filter(
            echo_inbox_message::Column::AccountId.is_in(account_ids.to_vec()),
        )
        .filter(
            Condition::any()
                .add(
                    echo_inbox_message::Column::CreatedAt
                        .gt(sync_cursor.created_at),
                )
                .add(
                    Condition::all()
                        .add(
                            echo_inbox_message::Column::CreatedAt
                                .eq(sync_cursor.created_at),
                        )
                        .add(
                            echo_inbox_message::Column::Id
                                .gt(sync_cursor.inbox_message_id),
                        ),
                ),
        )
        .filter(echo_inbox_message::Column::CreatedAt.lte(cutoff))
        .order_by_asc(echo_inbox_message::Column::CreatedAt)
        .order_by_asc(echo_inbox_message::Column::Id)
        .limit(ECHO_IM_SYNC_RECOVERY_SCAN_BATCH_SIZE)
        .all(dbx)
        .await
        .c(h!())
}

async fn load_recovery_maps(
    dbx: &DatabaseConnection,
    datasources: &BTreeMap<i32, EchoAccountF1>,
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

    let existing_signal_ids = load_existing_signal_ids(
        dbx,
        datasources,
        &groups,
        inbox_messages,
        &inbox_ids_i64,
    )
    .await
    .c(h!())?;

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
    let mut queue_items = BTreeMap::new();
    for queue_item in queue_items_vec {
        queue_items
            .entry(queue_item.internal_id)
            .or_insert(queue_item);
    }

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
        groups,
        senders,
        attachments,
    })
}

async fn load_existing_signal_ids(
    dbx: &DatabaseConnection,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    groups: &BTreeMap<i32, echo_group::Model>,
    inbox_messages: &[echo_inbox_message::Model],
    inbox_ids: &[i64],
) -> anyhow::Result<HashSet<i64>> {
    if inbox_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let inbox_messages = inbox_messages
        .iter()
        .map(|message| (i64::from(message.id), message))
        .collect::<BTreeMap<_, _>>();
    Ok(signal_message::Entity::find()
        .filter(
            signal_message::Column::EchoInboxMessageId
                .is_in(inbox_ids.to_vec()),
        )
        .filter(signal_message::Column::MessageUid.is_not_null())
        .find_also_related(datasource_group::Entity)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|(signal_message, datasource_group)| {
            let echo_inbox_message_id = signal_message.echo_inbox_message_id?;
            let inbox_message = inbox_messages.get(&echo_inbox_message_id)?;
            let datasource_group = datasource_group.as_ref()?;
            if signal_message_matches_echo_inbox(
                inbox_message,
                datasource_group,
                datasources,
                groups,
            ) {
                Some(echo_inbox_message_id)
            } else {
                None
            }
        })
        .collect())
}

fn signal_message_matches_echo_inbox(
    inbox_message: &echo_inbox_message::Model,
    datasource_group: &datasource_group::Model,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    groups: &BTreeMap<i32, echo_group::Model>,
) -> bool {
    let Some(datasource) = datasources.get(&inbox_message.account_id) else {
        return false;
    };
    if datasource_group.datasource_id != datasource.id {
        return false;
    }
    let Some(group_id) = inbox_message.group_id else {
        return false;
    };
    let Some(group) = groups.get(&group_id) else {
        return false;
    };
    datasource_group.group_master_key == group.group_id
}

async fn process_candidates(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    maps: &RecoveryMaps,
    inbox_messages: &[echo_inbox_message::Model],
    autofix_enabled: bool,
) -> anyhow::Result<ProcessCandidatesResult> {
    let mut result = ProcessCandidatesResult {
        missing_count: 0,
        max_processed_cursor: None,
    };
    for inbox_message in inbox_messages {
        if result.missing_count >= ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize {
            break;
        }

        let inbox_id = i64::from(inbox_message.id);
        if maps.existing_signal_ids.contains(&inbox_id) {
            result.max_processed_cursor =
                Some(echo_im_sync_cursor_for_message(inbox_message));
            continue;
        }
        if let Some(queue_item) = maps.queue_items.get(&inbox_id) {
            log_queued_inbox(inbox_message, queue_item);
            break;
        }
        result.max_processed_cursor =
            Some(echo_im_sync_cursor_for_message(inbox_message));
        result.missing_count += 1;
        if skipped_inbox_reason(inbox_message)
            == Some(SkippedInboxReason::Deleted)
        {
            log_skipped_inbox(
                inbox_message,
                recovery_datasource_id(inbox_message, datasources, None),
                SkippedInboxReason::Deleted,
            );
            record_deleted_missing_message(dbx, inbox_message.id)
                .await
                .c(h!())?;
            continue;
        }
        let scheduled_by = if autofix_enabled {
            Some(SYSTEM_SCHEDULED_BY)
        } else {
            None
        };
        let missing_message =
            record_missing_message(dbx, inbox_message.id, scheduled_by)
                .await
                .c(h!())?;
        if autofix_enabled && !missing_message.is_resolved {
            let missing_message = schedule_missing_message(
                dbx,
                missing_message,
                SYSTEM_SCHEDULED_BY,
            )
            .await
            .c(h!())?;
            process_missing_message_recovery(
                dbx,
                redis,
                deps,
                datasources,
                maps,
                missing_message,
                inbox_message,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(result)
}

fn echo_im_sync_cursor_for_message(
    inbox_message: &echo_inbox_message::Model,
) -> crate::system_settings::EchoImSyncCursor {
    crate::system_settings::EchoImSyncCursor {
        created_at: inbox_message.created_at,
        inbox_message_id: inbox_message.id,
    }
}

async fn process_scheduled_missing_messages(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    datasources: &BTreeMap<i32, EchoAccountF1>,
) -> anyhow::Result<usize> {
    let missing_messages =
        load_scheduled_missing_messages(dbx, ECHO_IM_SYNC_RECOVERY_BATCH_SIZE)
            .await
            .c(h!())?;
    if missing_messages.is_empty() {
        return Ok(0);
    }

    let inbox_ids = missing_messages
        .iter()
        .map(|message| message.message_id)
        .collect_vec();
    let inbox_messages = echo_inbox_message::Entity::find()
        .filter(echo_inbox_message::Column::Id.is_in(inbox_ids))
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|message| (message.id, message))
        .collect::<BTreeMap<_, _>>();
    let inbox_messages_vec = inbox_messages.values().cloned().collect_vec();
    let maps = load_recovery_maps(dbx, datasources, &inbox_messages_vec)
        .await
        .c(h!())?;

    let mut processed_count = 0usize;
    for missing_message in missing_messages {
        processed_count += 1;
        let Some(inbox_message) =
            inbox_messages.get(&missing_message.message_id)
        else {
            let message_id = missing_message.message_id;
            error!(
                "skipping echo_im inbox message during recovery because row is missing: inbox_id={message_id}"
            );
            mark_missing_message_deleted(dbx, missing_message)
                .await
                .c(h!())?;
            continue;
        };
        process_missing_message_recovery(
            dbx,
            redis,
            deps,
            datasources,
            &maps,
            missing_message,
            inbox_message,
        )
        .await
        .c(h!())?;
    }

    Ok(processed_count)
}

async fn process_missing_message_recovery(
    dbx: &DatabaseConnection,
    redis: &mut ConnectionManager,
    deps: &EchoImSyncRecoveryDeps<'_>,
    datasources: &BTreeMap<i32, EchoAccountF1>,
    maps: &RecoveryMaps,
    missing_message: echo_missing_message::Model,
    inbox_message: &echo_inbox_message::Model,
) -> anyhow::Result<()> {
    let inbox_id = i64::from(inbox_message.id);
    let datasource_id = recovery_datasource_id(
        inbox_message,
        datasources,
        maps.queue_items.get(&inbox_id),
    );
    if maps.existing_signal_ids.contains(&inbox_id) {
        mark_missing_message_resolved(dbx, missing_message)
            .await
            .c(h!())?;
        return Ok(());
    }
    if let Some(queue_item) = maps.queue_items.get(&inbox_id) {
        log_queued_inbox(inbox_message, queue_item);
        mark_missing_message_error(
            dbx,
            missing_message,
            queued_inbox_error(queue_item),
        )
        .await
        .c(h!())?;
        return Ok(());
    }

    if let Some(reason) = skipped_inbox_reason(inbox_message) {
        log_skipped_inbox(inbox_message, datasource_id, reason);
        if reason == SkippedInboxReason::Deleted {
            mark_missing_message_deleted(dbx, missing_message)
                .await
                .c(h!())?;
        } else {
            mark_missing_message_error(
                dbx,
                missing_message,
                format!("skipped during recovery: {}", reason.as_str()),
            )
            .await
            .c(h!())?;
        }
        return Ok(());
    }

    let recovery = recover_inbox_message(
        dbx,
        redis,
        deps,
        datasources,
        inbox_message,
        maps,
    )
    .await;

    match recovery {
        Ok(message_uid) => {
            log_recovered_inbox(inbox_message, datasource_id, &message_uid);
            mark_missing_message_resolved(dbx, missing_message)
                .await
                .c(h!())?;
        }
        Err(err) => {
            log_recovery_error(inbox_message, datasource_id, &err);
            mark_missing_message_error(
                dbx,
                missing_message,
                format!("{err:?}"),
            )
            .await
            .c(h!())?;
        }
    }

    Ok(())
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SkippedInboxReason {
    Deleted,
    Duplicate,
    Private,
}

impl SkippedInboxReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deleted => "deleted",
            Self::Duplicate => "duplicate",
            Self::Private => "private",
        }
    }
}

fn skipped_inbox_reason(
    message: &echo_inbox_message::Model,
) -> Option<SkippedInboxReason> {
    if message.deleted {
        Some(SkippedInboxReason::Deleted)
    } else if message.duplicate_of.is_some() {
        Some(SkippedInboxReason::Duplicate)
    } else if message.group_id.is_none() {
        Some(SkippedInboxReason::Private)
    } else {
        None
    }
}

fn log_skipped_inbox(
    message: &echo_inbox_message::Model,
    datasource_id: Option<i64>,
    reason: SkippedInboxReason,
) {
    error!(
        "skipping echo_im inbox message during recovery: reason={} inbox_id={} echo_external_id={:?} datasource_id={:?} account_id={} group_id={:?} created_at={} timestamp={:?}",
        reason.as_str(),
        message.id,
        message.internal_id,
        datasource_id,
        message.account_id,
        message.group_id,
        message.created_at,
        message.timestamp,
    );
}

fn log_queued_inbox(
    message: &echo_inbox_message::Model,
    queue_item: &signal_message_queue::Model,
) {
    info!(
        "skipping echo_im inbox message during recovery because normal queue processing is pending: inbox_id={} queue_item_id={} datasource_id={} account_id={} created_at={} queue_created_at={}",
        message.id,
        queue_item.id,
        queue_item.datasource_id,
        message.account_id,
        message.created_at,
        queue_item.created_at,
    );
}

fn queued_inbox_error(queue_item: &signal_message_queue::Model) -> String {
    format!(
        "signal_message_queue item still exists: id={}; normal queue worker owns processing",
        queue_item.id
    )
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

pub async fn oneoff_audit_missing_echo_im_messages(
    mode: Mode,
    ps: &crate::OneoffAuditMissingEchoImMessagesPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let (since_ts, till_ts) = audit_missing_echo_im_messages_bounds(ps)?;
    let echo_inbox_ids =
        load_echo_inbox_message_external_ids(&dbx, since_ts, till_ts).await?;
    let existing_external_ids =
        load_signal_message_echo_inbox_message_ids(&dbx, &echo_inbox_ids)
            .await?;
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

async fn load_signal_message_echo_inbox_message_ids(
    dbx: &DatabaseConnection,
    external_ids: &[i64],
) -> Result<HashSet<i64>, AppError> {
    if external_ids.is_empty() {
        return Ok(HashSet::new());
    }

    Ok(signal_message::Entity::find()
        .select_only()
        .column(signal_message::Column::EchoInboxMessageId)
        .filter(
            signal_message::Column::EchoInboxMessageId
                .is_in(external_ids.to_vec()),
        )
        .into_tuple::<Option<i64>>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .flatten()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sea_orm_active_enums::{
        AccountStatus, EchoMessageSource, EchoMissingMessageStatus,
    };
    use crate::functest::tests::cleanup;
    use sea_orm::*;
    use serial_test::serial;
    use uuid::Uuid;

    static TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    #[tokio::test]
    #[serial]
    async fn active_linked_datasources_include_only_active_linked_accounts() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;

        let (active_account, _active_datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let (paused_account, _paused_datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Paused, true).await;
        let (unlinked_account, _unlinked_datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, false).await;

        let datasources = active_linked_datasources_by_account(&env.dbx)
            .await
            .unwrap();

        assert!(datasources.contains_key(&active_account.id));
        assert!(!datasources.contains_key(&paused_account.id));
        assert!(!datasources.contains_key(&unlinked_account.id));
    }

    #[tokio::test]
    #[serial]
    async fn candidate_selection_filters_by_account_cursor_cutoff_and_order() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let account = mk_echo_account(&env.dbx, true).await;
        let other_account = mk_echo_account(&env.dbx, true).await;
        let base = Utc::now().naive_utc() - chrono::TimeDelta::hours(2);
        let cursor = base + chrono::TimeDelta::minutes(10);
        let cutoff = base + chrono::TimeDelta::minutes(40);

        mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            base + chrono::TimeDelta::minutes(5),
        )
        .await;
        let expected_second = mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            base + chrono::TimeDelta::minutes(30),
        )
        .await;
        let expected_first = mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            base + chrono::TimeDelta::minutes(20),
        )
        .await;
        mk_inbox_message(
            &env.dbx,
            other_account.id,
            None,
            base + chrono::TimeDelta::minutes(25),
        )
        .await;
        mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            base + chrono::TimeDelta::minutes(45),
        )
        .await;

        let candidates = load_candidate_inbox_messages(
            &env.dbx,
            &[account.id],
            crate::system_settings::EchoImSyncCursor {
                created_at: cursor,
                inbox_message_id: 0,
            },
            cutoff,
        )
        .await
        .unwrap();
        let ids = candidates
            .into_iter()
            .map(|message| message.id)
            .collect_vec();

        assert_eq!(ids, vec![expected_first.id, expected_second.id]);
    }

    #[tokio::test]
    #[serial]
    async fn recovery_maps_match_signal_and_queue_by_echo_inbox_id() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "map-group").await;
        let sender = mk_echo_sender(&env.dbx, account.id).await;
        let base = old_ts();
        let existing_inbox =
            mk_inbox_message(&env.dbx, account.id, Some(group.id), base).await;
        let existing_inbox_id = existing_inbox.id;
        let queue_inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            base + chrono::TimeDelta::minutes(1),
        )
        .await;
        let queue_inbox_id = queue_inbox.id;
        let queue_item = mk_queue_item(
            &env.dbx,
            datasource.id,
            i64::from(queue_inbox.id),
            "map-group",
            base,
        )
        .await;
        mk_echo_attachment(&env.dbx, account.id, queue_inbox.id, "/tmp/echo")
            .await;
        let mut queue_inbox = queue_inbox.into_active_model();
        queue_inbox.sender_id = Set(Some(sender.id));
        let queue_inbox = queue_inbox.update(&env.dbx).await.unwrap();
        mk_existing_signal_for_inbox(
            &env.dbx,
            existing_inbox.id,
            datasource.id,
            &group.group_id,
        )
        .await;

        let datasources = active_linked_datasources_by_account(&env.dbx)
            .await
            .unwrap();
        let maps = load_recovery_maps(
            &env.dbx,
            &datasources,
            &[existing_inbox, queue_inbox],
        )
        .await
        .unwrap();

        assert!(maps
            .existing_signal_ids
            .contains(&i64::from(existing_inbox_id)));
        assert_eq!(
            maps.queue_items.get(&queue_item.internal_id).unwrap().id,
            queue_item.id
        );
        assert_eq!(maps.groups[&group.id].group_id, "map-group");
        assert_eq!(maps.senders[&sender.id].uuid, sender.uuid);
        assert_eq!(maps.attachments[&queue_inbox_id].len(), 1);
    }

    #[tokio::test]
    #[serial]
    async fn existing_messages_do_not_consume_missing_recovery_batch() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "batch-group").await;
        let cursor = old_ts();
        insert_system_settings_with_autofix(&env.dbx, cursor, false, true)
            .await;
        let mut last_missing_created_at = cursor;

        for i in 0..ECHO_IM_SYNC_RECOVERY_BATCH_SIZE {
            let inbox = mk_inbox_message(
                &env.dbx,
                account.id,
                Some(group.id),
                cursor + chrono::TimeDelta::seconds(i as i64 + 1),
            )
            .await;
            mk_existing_signal_for_inbox(
                &env.dbx,
                inbox.id,
                datasource.id,
                &group.group_id,
            )
            .await;
        }
        for i in 0..ECHO_IM_SYNC_RECOVERY_BATCH_SIZE {
            last_missing_created_at =
                cursor + chrono::TimeDelta::seconds(i as i64 + 101);
            let inbox = mk_inbox_message(
                &env.dbx,
                account.id,
                Some(group.id),
                last_missing_created_at,
            )
            .await;
            let mut inbox = inbox.into_active_model();
            inbox.deleted = Set(true);
            inbox.update(&env.dbx).await.unwrap();
        }

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize);
        assert_eq!(
            crate::system_settings::get_echo_im_sync_since(&env.dbx)
                .await
                .unwrap(),
            last_missing_created_at
        );
    }

    #[tokio::test]
    #[serial]
    async fn recovery_cursor_uses_inbox_id_tiebreaker_for_same_created_at() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "same-ts-group").await;
        let cursor = old_ts();
        let shared_created_at = cursor + chrono::TimeDelta::minutes(1);
        insert_system_settings(&env.dbx, cursor, false).await;
        let mut inbox_ids = vec![];

        for _ in 0..(ECHO_IM_SYNC_RECOVERY_BATCH_SIZE + 1) {
            let inbox = mk_inbox_message(
                &env.dbx,
                account.id,
                Some(group.id),
                shared_created_at,
            )
            .await;
            inbox_ids.push(inbox.id);
        }

        let first_count = run_recovery(&env).await;
        let cursor_after_first =
            crate::system_settings::get_echo_im_sync_cursor(&env.dbx)
                .await
                .unwrap();

        assert_eq!(first_count, ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize);
        assert_eq!(cursor_after_first.created_at, shared_created_at);
        assert_eq!(
            cursor_after_first.inbox_message_id,
            inbox_ids[ECHO_IM_SYNC_RECOVERY_BATCH_SIZE as usize - 1]
        );

        let second_count = run_recovery(&env).await;
        let cursor_after_second =
            crate::system_settings::get_echo_im_sync_cursor(&env.dbx)
                .await
                .unwrap();

        assert_eq!(second_count, 1);
        assert_eq!(cursor_after_second.created_at, shared_created_at);
        assert_eq!(
            cursor_after_second.inbox_message_id,
            *inbox_ids.last().unwrap()
        );
        assert_eq!(
            echo_missing_message::Entity::find()
                .filter(
                    echo_missing_message::Column::MessageId.is_in(inbox_ids)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            ECHO_IM_SYNC_RECOVERY_BATCH_SIZE + 1
        );
    }

    #[tokio::test]
    #[serial]
    async fn recovery_advances_cursor_for_skipped_and_failed_rows() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "failed-group").await;
        let cursor = old_ts();
        insert_system_settings_with_autofix(&env.dbx, cursor, false, true)
            .await;
        let original = mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            cursor - chrono::TimeDelta::minutes(1),
        )
        .await;
        mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let deleted = mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            cursor + chrono::TimeDelta::minutes(2),
        )
        .await;
        let duplicate = mk_inbox_message(
            &env.dbx,
            account.id,
            None,
            cursor + chrono::TimeDelta::minutes(3),
        )
        .await;
        let failed = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(4),
        )
        .await;
        let queue_item = mk_queue_item(
            &env.dbx,
            datasource.id,
            i64::from(failed.id),
            "failed-group",
            failed.created_at,
        )
        .await;
        let mut queue_item = queue_item.into_active_model();
        queue_item.group_id = Set(None);
        queue_item.update(&env.dbx).await.unwrap();
        update_inbox_flags(&env.dbx, deleted.id, true, None).await;
        update_inbox_flags(&env.dbx, duplicate.id, false, Some(original.id))
            .await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 3);
        assert_eq!(
            crate::system_settings::get_echo_im_sync_cursor(&env.dbx)
                .await
                .unwrap(),
            crate::system_settings::EchoImSyncCursor {
                created_at: duplicate.created_at,
                inbox_message_id: duplicate.id,
            }
        );
        assert_eq!(
            signal_message::Entity::find()
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial]
    async fn direct_recovery_creates_signal_and_marks_inbox_seen() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "direct-group").await;
        let sender = mk_echo_sender(&env.dbx, account.id).await;
        let cursor = old_ts();
        insert_system_settings_with_autofix(&env.dbx, cursor, false, true)
            .await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let mut inbox = inbox.into_active_model();
        inbox.body = Set(format!("direct recovery {}", Uuid::new_v4()));
        inbox.sender_id = Set(Some(sender.id));
        inbox.timestamp = Set(Some(cursor + chrono::TimeDelta::minutes(2)));
        let inbox = inbox.update(&env.dbx).await.unwrap();

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let signal_message =
            signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
                .await
                .unwrap();
        assert_eq!(signal_message.created_at, inbox.created_at);
        assert_eq!(signal_message.timestamp, inbox.timestamp);
        assert_eq!(signal_message.body, Some(inbox.body.clone()));
        assert!(
            echo_inbox_message::Entity::find_by_id(inbox.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .seen
        );
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Resolved);
        assert_eq!(
            missing_message.scheduled_by,
            Some(SYSTEM_SCHEDULED_BY.to_string())
        );
    }

    #[tokio::test]
    #[serial]
    async fn recovery_records_missing_message_without_autofix() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "pending-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        assert!(signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
            .await
            .is_none());
        assert!(
            !echo_inbox_message::Entity::find_by_id(inbox.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .seen
        );
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(!missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Pending);
        assert_eq!(missing_message.scheduled_by, None);
    }

    #[tokio::test]
    #[serial]
    async fn recovery_records_deleted_missing_message_without_autofix() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "deleted-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        update_inbox_flags(&env.dbx, inbox.id, true, None).await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        assert!(signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
            .await
            .is_none());
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Deleted);
        assert_eq!(missing_message.error, None);
        assert_eq!(missing_message.scheduled_by, None);
    }

    #[tokio::test]
    #[serial]
    async fn scheduled_deleted_inbox_message_is_marked_deleted() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group =
            mk_echo_group(&env.dbx, account.id, "scheduled-deleted-group")
                .await;
        let cursor = old_ts();
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        insert_system_settings(
            &env.dbx,
            cursor + chrono::TimeDelta::minutes(2),
            false,
        )
        .await;
        update_inbox_flags(&env.dbx, inbox.id, true, None).await;
        let missing_message =
            record_missing_message(&env.dbx, inbox.id, Some("ManualUser"))
                .await
                .unwrap();

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let missing_message =
            echo_missing_message::Entity::find_by_id(missing_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Deleted);
        assert_eq!(missing_message.error, None);
        assert_eq!(
            missing_message.scheduled_by,
            Some("ManualUser".to_string())
        );
    }

    #[tokio::test]
    #[serial]
    async fn scheduled_missing_message_without_inbox_is_marked_deleted() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group =
            mk_echo_group(&env.dbx, account.id, "missing-inbox-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let missing_message =
            record_missing_message(&env.dbx, inbox.id, Some("ManualUser"))
                .await
                .unwrap();
        echo_inbox_message::Entity::delete_by_id(inbox.id)
            .exec(&env.dbx)
            .await
            .unwrap();

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let missing_message =
            echo_missing_message::Entity::find_by_id(missing_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Deleted);
        assert_eq!(missing_message.error, None);
        assert_eq!(
            missing_message.scheduled_by,
            Some("ManualUser".to_string())
        );
    }

    #[tokio::test]
    #[serial]
    async fn staged_signal_message_without_uid_is_not_existing_recovery() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "staged-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        mk_staged_signal_for_inbox(&env.dbx, inbox.id).await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(!missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Pending);
    }

    #[tokio::test]
    #[serial]
    async fn unstaged_signal_message_without_uid_is_not_existing_recovery() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "partial-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                group.group_id.clone(),
                datasource.id,
            )
            .await
            .unwrap();
        mk_signal_for_inbox_with_datasource_group(
            &env.dbx,
            inbox.id,
            datasource_group_id,
            false,
            None,
            None,
            Some(i64::from(inbox.id)),
        )
        .await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(!missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Pending);
    }

    #[tokio::test]
    #[serial]
    async fn external_id_collision_from_other_group_is_not_existing_recovery() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let (_other_account, other_datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Paused, true).await;
        let group =
            mk_echo_group(&env.dbx, account.id, "collision-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                &env.dbx,
                "imported-group".to_string(),
                other_datasource.id,
            )
            .await
            .unwrap();
        mk_signal_for_inbox_with_datasource_group(
            &env.dbx,
            inbox.id,
            datasource_group_id,
            false,
            Some(format!("uid-{}", Uuid::new_v4())),
            Some(i64::from(inbox.id)),
            None,
        )
        .await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(!missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Pending);
    }

    #[tokio::test]
    #[serial]
    async fn duplicate_missing_message_record_keeps_single_row() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group =
            mk_echo_group(&env.dbx, account.id, "duplicate-group").await;
        let inbox =
            mk_inbox_message(&env.dbx, account.id, Some(group.id), old_ts())
                .await;

        let first = record_missing_message(&env.dbx, inbox.id, None)
            .await
            .unwrap();
        let second = record_missing_message(
            &env.dbx,
            inbox.id,
            Some(SYSTEM_SCHEDULED_BY),
        )
        .await
        .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(
            echo_missing_message::Entity::find()
                .filter(echo_missing_message::Column::MessageId.eq(inbox.id))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial]
    async fn scheduled_missing_message_is_processed_without_autofix() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, _datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "manual-group").await;
        let cursor = old_ts();
        insert_system_settings(&env.dbx, cursor, false).await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let missing_message = record_missing_message(&env.dbx, inbox.id, None)
            .await
            .unwrap();
        crate::messenger::missing_message::schedule_missing_message_by_id(
            &env.dbx,
            missing_message.id,
            "ManualUser",
        )
        .await
        .unwrap();

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        assert!(signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
            .await
            .is_some());
        assert!(
            echo_inbox_message::Entity::find_by_id(inbox.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .seen
        );
        let missing_message = missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .unwrap();
        assert!(missing_message.is_resolved);
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Resolved);
        assert_eq!(
            missing_message.scheduled_by,
            Some("ManualUser".to_string())
        );
    }

    #[tokio::test]
    #[serial]
    async fn recovery_skips_queued_inbox_messages() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "queue-group").await;
        let cursor = old_ts();
        insert_system_settings_with_autofix(&env.dbx, cursor, false, true)
            .await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let later_inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(2),
        )
        .await;
        let queue_created_at = cursor + chrono::TimeDelta::minutes(5);
        let queue_item = mk_queue_item(
            &env.dbx,
            datasource.id,
            i64::from(inbox.id),
            "queue-group",
            queue_created_at,
        )
        .await;
        mk_queue_attachment(&env.dbx, queue_item.id, "/tmp/no-s3-needed").await;

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 0);
        assert!(signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
            .await
            .is_none());
        assert!(signal_message_queue::Entity::find_by_id(queue_item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            signal_message_queue_attachment::Entity::find()
                .filter(
                    signal_message_queue_attachment::Column::MessageId
                        .eq(queue_item.id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
        assert!(
            !echo_inbox_message::Entity::find_by_id(inbox.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .seen
        );
        assert!(missing_message_by_message_id(&env.dbx, inbox.id)
            .await
            .is_none());
        assert!(missing_message_by_message_id(&env.dbx, later_inbox.id)
            .await
            .is_none());
        assert_eq!(
            crate::system_settings::get_echo_im_sync_cursor(&env.dbx)
                .await
                .unwrap(),
            crate::system_settings::EchoImSyncCursor {
                created_at: cursor,
                inbox_message_id: 0,
            }
        );
    }

    #[tokio::test]
    #[serial]
    async fn scheduled_queued_message_is_not_recovered_in_parallel() {
        let _guard = TEST_LOCK.lock().await;
        let env = recovery_env().await;
        let (account, datasource) =
            mk_linked_datasource(&env.dbx, AccountStatus::Active, true).await;
        let group = mk_echo_group(&env.dbx, account.id, "queued-group").await;
        let cursor = old_ts();
        insert_system_settings_with_autofix(&env.dbx, cursor, false, true)
            .await;
        let inbox = mk_inbox_message(
            &env.dbx,
            account.id,
            Some(group.id),
            cursor + chrono::TimeDelta::minutes(1),
        )
        .await;
        let queue_item = mk_queue_item(
            &env.dbx,
            datasource.id,
            i64::from(inbox.id),
            "queued-group",
            cursor + chrono::TimeDelta::minutes(2),
        )
        .await;
        let missing_message =
            record_missing_message(&env.dbx, inbox.id, Some("ManualUser"))
                .await
                .unwrap();

        let missing_count = run_recovery(&env).await;

        assert_eq!(missing_count, 1);
        assert!(signal_message_by_echo_inbox_message_id(&env.dbx, inbox.id)
            .await
            .is_none());
        assert!(signal_message_queue::Entity::find_by_id(queue_item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            signal_message_queue_attachment::Entity::find()
                .filter(
                    signal_message_queue_attachment::Column::MessageId
                        .eq(queue_item.id)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert!(
            !echo_inbox_message::Entity::find_by_id(inbox.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .seen
        );
        let missing_message =
            echo_missing_message::Entity::find_by_id(missing_message.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(missing_message.status, EchoMissingMessageStatus::Error);
        assert!(missing_message
            .error
            .unwrap()
            .contains("normal queue worker owns processing"));
    }

    async fn recovery_env() -> Arc<Env> {
        let env = cleanup().await.unwrap();
        cleanup_recovery_tables(&env.dbx).await;
        env
    }

    async fn cleanup_recovery_tables(dbx: &DatabaseConnection) {
        signal_message_media::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        sigint_inbox_item::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        signal_message_group::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        signal_message::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        signal_message_queue_attachment::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        signal_message_queue::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        echo_missing_message::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        echo_message_reaction_queue::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        echo_inbox_message_changed::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        echo_attachment::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        echo_inbox_message::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        system_settings::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
    }

    async fn run_recovery(env: &Arc<Env>) -> usize {
        let mut redis = env.redis.clone();
        let deps = EchoImSyncRecoveryDeps {
            config: &env.config,
            settlements: env.settlements.clone(),
            rq: &env.rq,
            s3: &env.s3,
        };
        run_echo_im_sync_recovery_once(&env.dbx, &mut redis, &deps)
            .await
            .unwrap()
    }

    fn old_ts() -> NaiveDateTime {
        chrono::DateTime::<chrono::Utc>::from_timestamp_micros(
            Utc::now().timestamp_micros(),
        )
        .unwrap()
        .naive_utc()
            - chrono::TimeDelta::hours(2)
    }

    async fn mk_echo_account(
        dbx: &DatabaseConnection,
        is_linked: bool,
    ) -> echo_account::Model {
        let now = Utc::now().naive_utc();
        let phone_seed = Uuid::new_v4().simple().to_string();
        echo_account::ActiveModel {
            id: NotSet,
            source: Set(EchoMessageSource::Signal),
            phone_number: Set(format!("+{}", &phone_seed[..12])),
            is_linked: Set(is_linked),
            created_at: Set(now),
            synced_at: Set(None),
            last_trusted_at: Set(None),
            linked_at: Set(Some(now)),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_linked_datasource(
        dbx: &DatabaseConnection,
        status: AccountStatus,
        is_linked: bool,
    ) -> (echo_account::Model, datasource::Model) {
        let account = mk_echo_account(dbx, is_linked).await;
        let client = echo_client::ActiveModel {
            id: NotSet,
            name: Set(format!("test-client-{}", Uuid::new_v4())),
            created_at: Set(Utc::now().naive_utc()),
            deleted: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
        let lock = echo_client_lock::ActiveModel {
            id: NotSet,
            client_id: Set(client.id),
            account_id: Set(account.id),
            created_at: Set(Utc::now().naive_utc()),
            remove_requested: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap();
        let datasource = datasource::ActiveModel {
            id: NotSet,
            kind: Set("signal".to_string()),
            display_name: Set(format!("test datasource {}", Uuid::new_v4())),
            signal_phone: Set(Some(account.phone_number.clone())),
            api_endpoint: Set(None),
            enabled: Set(Some(true)),
            group_master_key: Set(None),
            sender_uuid: Set(None),
            description: Set(None),
            status: Set(status),
            echo_client_lock_id: Set(Some(i64::from(lock.id))),
            created_at: Set(Utc::now().naive_utc()),
            default_aor_id: Set(None),
            api_login: Set(None),
            updated_by: Set(None),
            deleted: Set(false),
            last_sync_at: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap();

        (account, datasource)
    }

    async fn mk_echo_group(
        dbx: &DatabaseConnection,
        account_id: i32,
        group_id: &str,
    ) -> echo_group::Model {
        let now = Utc::now().naive_utc();
        echo_group::ActiveModel {
            id: NotSet,
            group_id: Set(group_id.to_string()),
            internal_id: Set(Some(format!("internal-{group_id}"))),
            name: Set(Some(group_id.to_string())),
            account_id: Set(account_id),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_by_messanger: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_echo_sender(
        dbx: &DatabaseConnection,
        account_id: i32,
    ) -> echo_sender::Model {
        let now = Utc::now().naive_utc();
        echo_sender::ActiveModel {
            id: NotSet,
            uuid: Set(format!("sender-{}", Uuid::new_v4())),
            name: Set(Some("Sender".to_string())),
            phone_number: Set(None),
            account_id: Set(account_id),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_inbox_message(
        dbx: &DatabaseConnection,
        account_id: i32,
        group_id: Option<i32>,
        created_at: NaiveDateTime,
    ) -> echo_inbox_message::Model {
        echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(format!("body {}", Uuid::new_v4())),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(None),
            sender_id: Set(None),
            group_id: Set(group_id),
            account_id: Set(account_id),
            created_at: Set(created_at),
            timestamp: Set(Some(created_at)),
            updated_at: Set(created_at),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_echo_attachment(
        dbx: &DatabaseConnection,
        account_id: i32,
        message_id: i32,
        path: &str,
    ) -> echo_attachment::Model {
        let now = Utc::now().naive_utc();
        echo_attachment::ActiveModel {
            id: NotSet,
            name: Set(Some("attachment.txt".to_string())),
            path: Set(path.to_string()),
            message_id: Set(message_id),
            account_id: Set(account_id),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_queue_item(
        dbx: &DatabaseConnection,
        datasource_id: i64,
        internal_id: i64,
        group_id: &str,
        created_at: NaiveDateTime,
    ) -> signal_message_queue::Model {
        signal_message_queue::ActiveModel {
            id: NotSet,
            datasource_id: Set(datasource_id),
            internal_id: Set(internal_id),
            external_id: Set(Some(format!("queue-{internal_id}"))),
            body: Set(format!("queue body {}", Uuid::new_v4())),
            sender_id: Set(Some(format!("sender-{}", Uuid::new_v4()))),
            sender_name: Set(None),
            sender_phone_number: Set(None),
            group_id: Set(Some(group_id.to_string())),
            timestamp: Set(created_at + chrono::TimeDelta::seconds(1)),
            created_at: Set(created_at),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_queue_attachment(
        dbx: &DatabaseConnection,
        message_id: i64,
        path: &str,
    ) -> signal_message_queue_attachment::Model {
        signal_message_queue_attachment::ActiveModel {
            id: NotSet,
            message_id: Set(message_id),
            path: Set(path.to_string()),
            name: Set(Some("attachment.txt".to_string())),
            created_at: Set(Utc::now().naive_utc()),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_existing_signal_for_inbox(
        dbx: &DatabaseConnection,
        inbox_id: i32,
        datasource_id: i64,
        group_master_key: &str,
    ) -> signal_message::Model {
        let datasource_group_id =
            crate::messenger::group::ensure_datasource_group_id(
                dbx,
                group_master_key.to_string(),
                datasource_id,
            )
            .await
            .unwrap();
        mk_existing_signal_for_inbox_with_datasource_group(
            dbx,
            inbox_id,
            datasource_group_id,
        )
        .await
    }

    async fn mk_existing_signal_for_inbox_with_datasource_group(
        dbx: &DatabaseConnection,
        inbox_id: i32,
        datasource_group_id: i64,
    ) -> signal_message::Model {
        mk_signal_for_inbox_with_datasource_group(
            dbx,
            inbox_id,
            datasource_group_id,
            false,
            Some(format!("uid-{}", Uuid::new_v4())),
            None,
            Some(i64::from(inbox_id)),
        )
        .await
    }

    async fn mk_signal_for_inbox_with_datasource_group(
        dbx: &DatabaseConnection,
        _inbox_id: i32,
        datasource_group_id: i64,
        deleted: bool,
        message_uid: Option<String>,
        external_id: Option<i64>,
        echo_inbox_message_id: Option<i64>,
    ) -> signal_message::Model {
        let now = Utc::now().naive_utc();
        signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(format!("existing {}", Uuid::new_v4()))),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: Set(now),
            timestamp: Set(Some(now)),
            sender: Set(None),
            format: Set(None),
            deleted: Set(deleted),
            external_id: Set(external_id),
            echo_inbox_message_id: Set(echo_inbox_message_id),
            message_uid: Set(message_uid),
            operator_tags: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn mk_staged_signal_for_inbox(
        dbx: &DatabaseConnection,
        inbox_id: i32,
    ) -> signal_message::Model {
        let now = Utc::now().naive_utc();
        signal_message::ActiveModel {
            id: NotSet,
            body: Set(Some(format!("staged {}", Uuid::new_v4()))),
            datasource_group_id: Set(None),
            created_at: Set(now),
            timestamp: Set(Some(now)),
            sender: Set(None),
            format: Set(None),
            deleted: Set(true),
            external_id: Set(None),
            echo_inbox_message_id: Set(Some(i64::from(inbox_id))),
            message_uid: Set(None),
            operator_tags: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_system_settings(
        dbx: &DatabaseConnection,
        echo_im_sync_since: NaiveDateTime,
        deleted: bool,
    ) -> system_settings::Model {
        insert_system_settings_with_autofix(
            dbx,
            echo_im_sync_since,
            deleted,
            false,
        )
        .await
    }

    async fn insert_system_settings_with_autofix(
        dbx: &DatabaseConnection,
        echo_im_sync_since: NaiveDateTime,
        deleted: bool,
        autofix_echoim_missing_messages: bool,
    ) -> system_settings::Model {
        system_settings::ActiveModel {
            id: NotSet,
            rer_analysis_units_exact_match_only_default: Set(true),
            created_at: Set(Utc::now().naive_utc()),
            updated_at: Set(Utc::now().naive_utc()),
            echo_im_sync_since: Set(echo_im_sync_since),
            echo_im_sync_since_inbox_message_id: Set(0),
            updated_by: Set(None),
            deleted: Set(deleted),
            rer_duty_test_enabled: Set(false),
            rer_duty_test_since_ms: Set(0),
            rer_duty_test_limit: Set(1),
            rer_duty_poll_interval_sec: Set(1),
            rer_duty_insert_historical_interceptions: Set(false),
            short_url_enabled: Set(false),
            support_non_rer_interceptions: Set(false),
            peleng_bounds_enabled: Set(false),
            peleng_bounds_top_left_lat: Set(None),
            peleng_bounds_top_left_lng: Set(None),
            peleng_bounds_bottom_right_lat: Set(None),
            peleng_bounds_bottom_right_lng: Set(None),
            default_neo_analysis: Set(false),
            autofix_echoim_missing_messages: Set(
                autofix_echoim_missing_messages,
            ),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn update_inbox_flags(
        dbx: &DatabaseConnection,
        id: i32,
        deleted: bool,
        duplicate_of: Option<i32>,
    ) {
        let mut inbox_message = echo_inbox_message::Entity::find_by_id(id)
            .one(dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        inbox_message.deleted = Set(deleted);
        inbox_message.duplicate_of = Set(duplicate_of);
        inbox_message.update(dbx).await.unwrap();
    }

    async fn signal_message_by_echo_inbox_message_id(
        dbx: &DatabaseConnection,
        inbox_id: i32,
    ) -> Option<signal_message::Model> {
        signal_message::Entity::find()
            .filter(
                signal_message::Column::EchoInboxMessageId
                    .eq(i64::from(inbox_id)),
            )
            .one(dbx)
            .await
            .unwrap()
    }

    async fn missing_message_by_message_id(
        dbx: &DatabaseConnection,
        message_id: i32,
    ) -> Option<echo_missing_message::Model> {
        echo_missing_message::Entity::find()
            .filter(echo_missing_message::Column::MessageId.eq(message_id))
            .one(dbx)
            .await
            .unwrap()
    }
}
