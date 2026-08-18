use crate::config::*;
use crate::entities::*;
use crate::location::SettlementsDataConfig;
use crate::messenger::dedupe;
use crate::messenger::media::MediaUploadInput;
use crate::types::*;
use base64::{engine::general_purpose, Engine as _};
use chrono::NaiveDateTime;
use echo_im::types::{MessageAttachmentF1, MessageF1};
use itertools::Itertools;
use redis::aio::ConnectionManager;
use sea_orm::*;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Default)]
pub struct ReconcileResult {
    pub changed_inbox_item_ids: Vec<i64>,
    pub superseded_media_ids: Vec<Uuid>,
    pub superseded_ocr_result_keys: Vec<String>,
    pub pending_dedupe_updates: Vec<DedupeRedisUpdate>,
    pub uploaded_files_ready_for_deletion: Vec<MediaUploadInput>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum DedupeRedisUpdate {
    Set {
        body: String,
        attachments_hash: Option<String>,
        signal_message_id: i64,
    },
    ClearIfValue {
        body: String,
        attachments_hash: Option<String>,
        signal_message_id: i64,
    },
}

impl DedupeRedisUpdate {
    fn set_signal_message(signal_message: &signal_message::Model) -> Self {
        Self::Set {
            body: signal_message.body.clone().unwrap_or_default(),
            attachments_hash: signal_message.attachments_hash.clone(),
            signal_message_id: signal_message.id,
        }
    }

    fn clear_signal_message(signal_message: &signal_message::Model) -> Self {
        Self::ClearIfValue {
            body: signal_message.body.clone().unwrap_or_default(),
            attachments_hash: signal_message.attachments_hash.clone(),
            signal_message_id: signal_message.id,
        }
    }
}

pub async fn load_linked_messages(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    echo_inbox_message_id: i64,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let mut linked_messages = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(
            signal_message::Column::EchoInboxMessageId
                .eq(echo_inbox_message_id),
        )
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .order_by_asc(signal_message::Column::Id)
        .all(txn)
        .await
        .c(h!())?;
    linked_messages.sort_by_key(|message| {
        (
            message.deleted,
            is_duplicate_trace_message(
                message.id,
                message.message_uid.as_deref(),
            ),
            message.id,
        )
    });
    Ok(linked_messages)
}

pub async fn load_active_linked_messages(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    snapshot: &MessageF1,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let linked_messages =
        load_linked_messages(txn, datasource_id, snapshot.internal_id as i64)
            .await
            .c(h!())?;
    if !linked_messages.is_empty() {
        return Ok(linked_messages);
    }
    load_legacy_active_linked_messages(txn, datasource_id, snapshot).await
}

pub async fn reconcile_deleted_message(
    txn: &DatabaseTransaction,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    datasource_id: i64,
    snapshot: &MessageF1,
) -> anyhow::Result<ReconcileResult> {
    let echo_inbox_message_id = snapshot.internal_id as i64;
    let linked_messages = load_deleted_linked_messages(
        txn,
        datasource_id,
        echo_inbox_message_id,
        snapshot,
    )
    .await
    .c(h!())?;
    if linked_messages.is_empty() {
        info!(
            "inbox change skipped: datasource_id={} echo_inbox_message_id={} operation=delete result=missing_linked_message",
            datasource_id, echo_inbox_message_id
        );
        return Ok(ReconcileResult::default());
    }

    let linked_row_count = linked_messages.len();
    let linked_message_ids = linked_messages
        .iter()
        .map(|message| message.id)
        .collect_vec();
    let mut changed_inbox_item_ids: Vec<i64> =
        linked_messages.iter().map(|message| message.id).collect();
    let mut pending_dedupe_updates = vec![];
    let mut deleted_count = 0;
    let mut promoted_count = 0;
    for signal_message in linked_messages {
        if signal_message.deleted {
            let changed_group_link_message_ids =
                delete_group_link_for_deleted_duplicate_trace(
                    txn,
                    &signal_message,
                )
                .await
                .c(h!())?;
            push_unique_inbox_item_ids(
                &mut changed_inbox_item_ids,
                changed_group_link_message_ids,
            );
            continue;
        }
        let original_message = signal_message.clone();
        pending_dedupe_updates
            .push(DedupeRedisUpdate::clear_signal_message(&original_message));
        let mut signal_message = signal_message.into_active_model();
        signal_message.deleted = Set(true);
        signal_message.update(txn).await.c(h!())?;
        deleted_count += 1;
        let promoted_inbox_item_ids =
            promote_duplicate_trace_for_deleted_original(
                txn,
                settlements.clone(),
                rq,
                config,
                &original_message,
            )
            .await
            .c(h!())?;
        if !promoted_inbox_item_ids.changed_inbox_item_ids.is_empty() {
            for promoted_inbox_item_id in
                promoted_inbox_item_ids.changed_inbox_item_ids
            {
                if !changed_inbox_item_ids.contains(&promoted_inbox_item_id) {
                    changed_inbox_item_ids.push(promoted_inbox_item_id);
                }
            }
            pending_dedupe_updates
                .extend(promoted_inbox_item_ids.pending_dedupe_updates);
            promoted_count += 1;
        }
    }
    info!(
        "inbox change applied: datasource_id={} echo_inbox_message_id={} operation=delete linked_row_count={} changed_row_count={} promoted_duplicate_count={}",
        datasource_id,
        echo_inbox_message_id,
        linked_row_count,
        deleted_count,
        promoted_count
    );
    for signal_message_id in linked_message_ids {
        crate::transcriber::media_queue::reconcile_message(
            txn,
            signal_message_id,
            &[],
        )
        .await
        .c(h!())?;
    }
    Ok(ReconcileResult {
        changed_inbox_item_ids,
        superseded_media_ids: vec![],
        superseded_ocr_result_keys: vec![],
        pending_dedupe_updates,
        uploaded_files_ready_for_deletion: vec![],
    })
}

#[derive(Default)]
struct DuplicatePromotionResult {
    changed_inbox_item_ids: Vec<i64>,
    pending_dedupe_updates: Vec<DedupeRedisUpdate>,
}

async fn promote_duplicate_trace_for_deleted_original(
    txn: &DatabaseTransaction,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    original_message: &signal_message::Model,
) -> anyhow::Result<DuplicatePromotionResult> {
    let duplicate_traces =
        load_duplicate_traces_for_original(txn, original_message).await?;
    let mut promoted_message = None;
    for (_, duplicate_trace) in &duplicate_traces {
        if duplicate_trace_has_promotable_content(
            txn,
            original_message.id,
            duplicate_trace,
        )
        .await
        .c(h!())?
        {
            promoted_message = Some(duplicate_trace.clone());
            break;
        }
    }
    let Some(promoted_message) = promoted_message else {
        return Ok(DuplicatePromotionResult::default());
    };
    let mut promoted_message_act = promoted_message.clone().into_active_model();
    promoted_message_act.deleted = Set(false);
    let promoted_message = promoted_message_act.update(txn).await.c(h!())?;

    for (group_link, _) in duplicate_traces {
        let mut group_link = group_link.into_active_model();
        group_link.signal_message_id = Set(promoted_message.id);
        group_link.message_uid = Set(promoted_message.message_uid.clone());
        group_link.update(txn).await.c(h!())?;
    }
    transfer_media_to_promoted_message(
        txn,
        original_message.id,
        promoted_message.id,
    )
    .await
    .c(h!())?;
    let promoted_message = crate::messenger::id::update_message_with_uid(
        txn,
        config,
        promoted_message,
    )
    .await
    .c(h!())?;
    reset_machine_derived_inbox_data(txn, promoted_message.id)
        .await
        .c(h!())?;
    let changed_inbox_item_ids =
        crate::rer_importer::bgworker::process_message_to_inbox(
            settlements,
            txn,
            rq,
            config,
            promoted_message.id,
            None,
        )
        .await
        .c(h!())?;
    for changed_inbox_item_id in &changed_inbox_item_ids {
        crate::sigint::worker::incoming_message_after_insert(
            txn,
            *changed_inbox_item_id,
        )
        .await
        .c(h!())?;
    }
    copy_manual_annotations_to_promoted_messages(
        txn,
        original_message.id,
        &changed_inbox_item_ids,
    )
    .await
    .c(h!())?;
    Ok(DuplicatePromotionResult {
        changed_inbox_item_ids,
        pending_dedupe_updates: vec![DedupeRedisUpdate::set_signal_message(
            &promoted_message,
        )],
    })
}

async fn duplicate_trace_has_promotable_content(
    txn: &DatabaseTransaction,
    original_message_id: i64,
    promoted_message: &signal_message::Model,
) -> anyhow::Result<bool> {
    if promoted_message
        .body
        .as_deref()
        .is_some_and(|body| !body.trim().is_empty())
    {
        return Ok(true);
    }
    let media_count = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .is_in([original_message_id, promoted_message.id]),
        )
        .count(txn)
        .await
        .c(h!())?;
    Ok(media_count > 0)
}

async fn copy_manual_annotations_to_promoted_messages(
    txn: &DatabaseTransaction,
    original_message_id: i64,
    promoted_message_ids: &[i64],
) -> anyhow::Result<()> {
    copy_manual_annotations_from_messages_to_promoted_messages(
        txn,
        &[original_message_id],
        promoted_message_ids,
    )
    .await
}

async fn copy_manual_annotations_from_messages_to_promoted_messages(
    txn: &DatabaseTransaction,
    original_message_ids: &[i64],
    promoted_message_ids: &[i64],
) -> anyhow::Result<()> {
    for original_message_id in original_message_ids.iter().copied().unique() {
        for promoted_message_id in promoted_message_ids.iter().copied().unique()
        {
            if original_message_id == promoted_message_id {
                continue;
            }
            copy_manual_annotations_to_promoted_message(
                txn,
                original_message_id,
                promoted_message_id,
            )
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

async fn copy_manual_annotations_to_promoted_message(
    txn: &DatabaseTransaction,
    original_message_id: i64,
    promoted_message_id: i64,
) -> anyhow::Result<()> {
    copy_annotation_rows(
        txn,
        original_message_id,
        promoted_message_id,
        r#"
            insert into sigint_comment (
                login_id,
                signal_message_id,
                comment,
                created_at,
                sigint_post_id
            )
            select
                c.login_id,
                $2,
                c.comment,
                c.created_at,
                c.sigint_post_id
            from sigint_comment c
            where c.signal_message_id = $1
              and not exists (
                  select 1
                  from sigint_comment existing
                  where existing.signal_message_id = $2
                    and existing.login_id = c.login_id
                    and existing.comment = c.comment
                    and existing.created_at = c.created_at
                    and existing.sigint_post_id is not distinct from c.sigint_post_id
              )
        "#,
    )
    .await
    .c(h!())?;
    copy_annotation_rows(
        txn,
        original_message_id,
        promoted_message_id,
        r#"
            insert into sigint_bookmark (
                login_id,
                signal_message_id,
                created_at,
                deleted
            )
            select
                b.login_id,
                $2,
                b.created_at,
                b.deleted
            from sigint_bookmark b
            where b.signal_message_id = $1
              and b.deleted = false
              and not exists (
                  select 1
                  from sigint_bookmark existing
                  where existing.signal_message_id = $2
                    and existing.login_id = b.login_id
                    and existing.deleted = false
              )
        "#,
    )
    .await
    .c(h!())?;
    copy_annotation_rows(
        txn,
        original_message_id,
        promoted_message_id,
        r#"
            insert into sigint_important (
                login_id,
                signal_message_id,
                created_at,
                deleted
            )
            select
                i.login_id,
                $2,
                i.created_at,
                i.deleted
            from sigint_important i
            where i.signal_message_id = $1
              and i.login_id is not null
              and i.deleted = false
              and not exists (
                  select 1
                  from sigint_important existing
                  where existing.signal_message_id = $2
                    and existing.login_id = i.login_id
                    and existing.deleted = false
              )
        "#,
    )
    .await
    .c(h!())?;
    copy_annotation_rows(
        txn,
        original_message_id,
        promoted_message_id,
        r#"
            insert into sigint_inbox_item_tag (
                sigint_inbox_item_id,
                tag_id,
                confidence,
                login_id,
                model
            )
            select
                $2,
                t.tag_id,
                t.confidence,
                t.login_id,
                t.model
            from sigint_inbox_item_tag t
            where t.sigint_inbox_item_id = $1
              and t.model is null
              and not exists (
                  select 1
                  from sigint_inbox_item_tag existing
                  where existing.sigint_inbox_item_id = $2
                    and existing.tag_id = t.tag_id
                    and existing.login_id is not distinct from t.login_id
                    and existing.model is null
              )
        "#,
    )
    .await
    .c(h!())?;
    copy_annotation_rows(
        txn,
        original_message_id,
        promoted_message_id,
        r#"
            update signal_message promoted
            set operator_tags = original.operator_tags
            from signal_message original
            where original.id = $1
              and promoted.id = $2
              and original.operator_tags is not null
              and promoted.operator_tags is null
        "#,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn copy_annotation_rows(
    txn: &DatabaseTransaction,
    original_message_id: i64,
    promoted_message_id: i64,
    sql: &str,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [original_message_id.into(), promoted_message_id.into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

async fn load_duplicate_traces_for_original(
    txn: &DatabaseTransaction,
    original_message: &signal_message::Model,
) -> anyhow::Result<Vec<(signal_message_group::Model, signal_message::Model)>> {
    let group_links = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId
                .eq(original_message.id),
        )
        .order_by_asc(signal_message_group::Column::CreatedAt)
        .order_by_asc(signal_message_group::Column::Id)
        .all(txn)
        .await
        .c(h!())?;
    let mut duplicate_traces = vec![];
    for group_link in group_links {
        let mut trace_query = signal_message::Entity::find()
            .filter(signal_message::Column::Id.ne(original_message.id))
            .filter(signal_message::Column::Deleted.eq(true))
            .filter(signal_message::Column::CreatedAt.eq(group_link.created_at))
            .filter(
                signal_message::Column::MessageUid.like("duplicate-trace-%"),
            )
            .order_by_asc(signal_message::Column::Id);
        trace_query = match group_link.datasource_group_id {
            Some(datasource_group_id) => trace_query.filter(
                signal_message::Column::DatasourceGroupId
                    .eq(datasource_group_id),
            ),
            None => trace_query
                .filter(signal_message::Column::DatasourceGroupId.is_null()),
        };
        let Some(trace_message) = trace_query.one(txn).await.c(h!())? else {
            continue;
        };
        if !is_duplicate_trace_message(
            trace_message.id,
            trace_message.message_uid.as_deref(),
        ) {
            continue;
        }
        duplicate_traces.push((group_link, trace_message));
    }
    Ok(duplicate_traces)
}

async fn transfer_media_to_promoted_message(
    txn: &DatabaseTransaction,
    original_message_id: i64,
    promoted_message_id: i64,
) -> anyhow::Result<()> {
    let media_rows = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId
                .eq(original_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    for media in media_rows {
        let mut media = media.into_active_model();
        media.signal_message_id = Set(promoted_message_id);
        media.update(txn).await.c(h!())?;
    }
    Ok(())
}

async fn delete_group_link_for_deleted_duplicate_trace(
    txn: &DatabaseTransaction,
    signal_message: &signal_message::Model,
) -> anyhow::Result<Vec<i64>> {
    if !is_duplicate_trace_message(
        signal_message.id,
        signal_message.message_uid.as_deref(),
    ) {
        return Ok(vec![]);
    }
    delete_previous_duplicate_group_links(txn, signal_message)
        .await
        .c(h!())
}

fn push_unique_inbox_item_ids(
    inbox_item_ids: &mut Vec<i64>,
    additional_ids: Vec<i64>,
) {
    for additional_id in additional_ids {
        if !inbox_item_ids.contains(&additional_id) {
            inbox_item_ids.push(additional_id);
        }
    }
}

async fn push_deleted_reprocessed_source_id(
    txn: &DatabaseTransaction,
    source_message_id: i64,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> anyhow::Result<()> {
    if changed_inbox_item_ids.contains(&source_message_id) {
        return Ok(());
    }
    let Some(source_message) =
        signal_message::Entity::find_by_id(source_message_id)
            .one(txn)
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    if source_message.deleted {
        changed_inbox_item_ids.push(source_message_id);
    }
    Ok(())
}

async fn load_deleted_linked_messages(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    echo_inbox_message_id: i64,
    snapshot: &MessageF1,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let linked_messages =
        load_linked_messages(txn, datasource_id, echo_inbox_message_id)
            .await
            .c(h!())?;
    if !linked_messages.is_empty() {
        return Ok(linked_messages);
    }
    load_legacy_deleted_linked_messages(txn, datasource_id, snapshot).await
}

async fn load_legacy_deleted_linked_messages(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    snapshot: &MessageF1,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let Some(match_fields) = load_legacy_deleted_match_fields(txn, snapshot)
        .await
        .c(h!())?
    else {
        return Ok(vec![]);
    };
    let mut query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::EchoInboxMessageId.is_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Body.eq(Some(match_fields.body)))
        .filter(
            signal_message::Column::Timestamp.eq(Some(match_fields.timestamp)),
        )
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(
            datasource_group::Column::GroupMasterKey.eq(&match_fields.group_id),
        );
    if let Some(sender_uuid) = snapshot_sender_uuid(snapshot) {
        query =
            query.filter(signal_message::Column::Sender.eq(Some(sender_uuid)));
    }
    let linked_messages = query
        .order_by_asc(signal_message::Column::Id)
        .limit(2)
        .all(txn)
        .await
        .c(h!())?;
    if linked_messages.len() > 1 {
        warn!(
            "inbox change legacy delete fallback skipped ambiguous match: datasource_id={} echo_inbox_message_id={} group_id={} timestamp={} match_count={}",
            datasource_id,
            snapshot.internal_id,
            match_fields.group_id,
            match_fields.timestamp,
            linked_messages.len()
        );
        return Ok(vec![]);
    }
    Ok(linked_messages)
}

struct LegacyDeletedMatchFields {
    group_id: String,
    body: String,
    timestamp: NaiveDateTime,
}

async fn load_legacy_deleted_match_fields(
    txn: &DatabaseTransaction,
    snapshot: &MessageF1,
) -> anyhow::Result<Option<LegacyDeletedMatchFields>> {
    if let Some(group_id) = snapshot.group_id.clone() {
        return Ok(Some(LegacyDeletedMatchFields {
            group_id,
            body: snapshot.text.replace("\r\n", "\n"),
            timestamp: snapshot.timestamp,
        }));
    }
    let Some(inbox_message) =
        echo_inbox_message::Entity::find_by_id(snapshot.internal_id)
            .one(txn)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    let Some(group_id) = inbox_message.group_id else {
        return Ok(None);
    };
    let Some(timestamp) = inbox_message.timestamp else {
        return Ok(None);
    };
    let Some(group) = echo_group::Entity::find_by_id(group_id)
        .one(txn)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    Ok(Some(LegacyDeletedMatchFields {
        group_id: group.group_id,
        body: inbox_message.body.replace("\r\n", "\n"),
        timestamp,
    }))
}

async fn load_legacy_active_linked_messages(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    snapshot: &MessageF1,
) -> anyhow::Result<Vec<signal_message::Model>> {
    let Some(group_id) = snapshot.group_id.as_deref() else {
        return Ok(vec![]);
    };
    let mut query = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .filter(signal_message::Column::EchoInboxMessageId.is_null())
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(signal_message::Column::Timestamp.eq(Some(snapshot.timestamp)))
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(datasource_group::Column::GroupMasterKey.eq(group_id));
    if let Some(sender_uuid) = snapshot_sender_uuid(snapshot) {
        query =
            query.filter(signal_message::Column::Sender.eq(Some(sender_uuid)));
    }
    let linked_messages = query
        .order_by_asc(signal_message::Column::Id)
        .limit(2)
        .all(txn)
        .await
        .c(h!())?;
    if linked_messages.len() > 1 {
        warn!(
            "inbox change legacy edit fallback skipped ambiguous match: datasource_id={} echo_inbox_message_id={} group_id={} timestamp={} match_count={}",
            datasource_id,
            snapshot.internal_id,
            group_id,
            snapshot.timestamp,
            linked_messages.len()
        );
        return Ok(vec![]);
    }
    Ok(linked_messages)
}

async fn effective_active_group_id(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    snapshot: &MessageF1,
    source_message: &signal_message::Model,
) -> anyhow::Result<String> {
    if let Some(group_id) = snapshot.group_id.clone() {
        return Ok(group_id);
    }
    let Some(datasource_group_id) = source_message.datasource_group_id else {
        anyhow::bail!(
            "active inbox edit has no group: datasource_id={} echo_inbox_message_id={}",
            datasource_id,
            snapshot.internal_id
        );
    };
    let Some(datasource_group) =
        datasource_group::Entity::find_by_id(datasource_group_id)
            .one(txn)
            .await
            .c(h!())?
    else {
        anyhow::bail!(
            "active inbox edit source group is missing: datasource_id={} echo_inbox_message_id={} datasource_group_id={}",
            datasource_id,
            snapshot.internal_id,
            datasource_group_id
        );
    };
    Ok(datasource_group.group_master_key)
}

pub async fn reconcile_active_message(
    txn: &DatabaseTransaction,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    datasource_id: i64,
    snapshot: &MessageF1,
    linked_messages: Vec<signal_message::Model>,
) -> anyhow::Result<ReconcileResult> {
    let Some(source_message) = linked_messages.first().cloned() else {
        return Ok(ReconcileResult::default());
    };
    let group_id = effective_active_group_id(
        txn,
        datasource_id,
        snapshot,
        &source_message,
    )
    .await
    .c(h!())?;
    let source_message_before_edit = source_message.clone();
    let source_message_id = source_message.id;
    let source_message_was_duplicate_trace = is_duplicate_trace_message(
        source_message.id,
        source_message.message_uid.as_deref(),
    );
    let previous_body = source_message.body.clone();
    let previous_attachments_hash = source_message.attachments_hash.clone();

    let body = snapshot.text.replace("\r\n", "\n");
    let snapshot_attachments = effective_snapshot_attachments(
        txn,
        datasource_id,
        snapshot,
        source_message_id,
    )
    .await
    .c(h!())?;
    let snapshot_attachments_hash =
        dedupe::attachments_hash(&snapshot_attachments).await;
    let attachments_hash = effective_edit_attachments_hash(
        txn,
        source_message_id,
        previous_attachments_hash.clone(),
        snapshot_attachments_hash.clone(),
        &snapshot_attachments,
    )
    .await
    .c(h!())?;
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            group_id.clone(),
            datasource_id,
        )
        .await
        .c(h!())?;
    let mut retired_inbox_item_ids = retire_obsolete_linked_messages(
        txn,
        source_message_id,
        &linked_messages,
    )
    .await
    .c(h!())?;

    let source_message = update_source_message_snapshot(
        txn,
        source_message,
        &body,
        snapshot,
        datasource_group_id,
        attachments_hash.clone(),
    )
    .await
    .c(h!())?;
    clear_previous_dedupe_key_if_changed(
        redis,
        source_message.id,
        previous_body.as_deref(),
        previous_attachments_hash.as_deref(),
        &body,
        attachments_hash.as_deref(),
    )
    .await
    .c(h!())?;

    let changed_group_link_message_ids = reset_source_message_group_link(
        txn,
        &source_message_before_edit,
        source_message_was_duplicate_trace,
    )
    .await
    .c(h!())?;
    let duplicate_of = match find_duplicate_for_edit(
        txn,
        redis,
        &body,
        snapshot_attachments_hash.as_deref(),
        attachments_hash.as_deref(),
        snapshot.timestamp,
        source_message.id,
    )
    .await
    {
        Ok(duplicate_of) => duplicate_of,
        Err(err) => {
            clear_current_edit_dedupe_keys_best_effort(
                redis,
                source_message_id,
                &body,
                snapshot_attachments_hash.as_deref(),
                attachments_hash.as_deref(),
            )
            .await;
            restore_previous_dedupe_key_if_changed_best_effort(
                redis,
                source_message_id,
                previous_body.as_deref(),
                previous_attachments_hash.as_deref(),
                &body,
                attachments_hash.as_deref(),
            )
            .await;
            return Err(err);
        }
    };

    let result = async {
        let unstage_result = crate::sigint::worker::unstage_message(
            txn,
            &group_id,
            source_message,
            duplicate_of,
        )
        .await
        .c(h!())?;

        if unstage_result.is_duplicate {
            copy_manual_annotations_to_promoted_message(
                txn,
                source_message_id,
                unstage_result.message.id,
            )
            .await
            .c(h!())?;
            let (superseded_media_ids, superseded_ocr_result_keys) =
                delete_media_for_message(txn, source_message_id)
                    .await
                    .c(h!())?;
            crate::transcriber::media_queue::reconcile_message(
                txn,
                source_message_id,
                &superseded_media_ids,
            )
            .await
            .c(h!())?;
            push_unique_inbox_item_ids(
                &mut retired_inbox_item_ids,
                vec![source_message_id, unstage_result.message.id],
            );
            push_unique_inbox_item_ids(
                &mut retired_inbox_item_ids,
                changed_group_link_message_ids,
            );
            info!(
                "inbox change applied: datasource_id={} echo_inbox_message_id={} operation=edit result=duplicate linked_row_count={}",
                datasource_id,
                snapshot.internal_id,
                linked_messages.len()
            );
            return Ok(ReconcileResult {
                changed_inbox_item_ids: retired_inbox_item_ids,
                superseded_media_ids,
                superseded_ocr_result_keys,
                pending_dedupe_updates: vec![],
                uploaded_files_ready_for_deletion: vec![],
            });
        }

        let signal_message = crate::messenger::id::update_message_with_uid(
            txn,
            config,
            unstage_result.message,
        )
        .await
        .c(h!())?;
        let media_replacement = replace_media_if_changed(
            txn,
            config,
            s3,
            &signal_message,
            previous_attachments_hash.clone(),
            attachments_hash.clone(),
            &snapshot_attachments,
        )
        .await
        .c(h!())?;
        if media_replacement.preserved_previous {
            restore_edit_dedupe_after_media_fallback(
                redis,
                source_message_id,
                previous_attachments_hash.as_deref(),
                &body,
                snapshot_attachments_hash.as_deref(),
                attachments_hash.as_deref(),
            )
            .await
            .c(h!())?;
        }
        let superseded_media_ids = media_replacement.superseded_media_ids;
        let superseded_ocr_result_keys =
            media_replacement.superseded_ocr_result_keys;
        let uploaded_files_ready_for_deletion =
            media_replacement.uploaded_files_ready_for_deletion;
        crate::transcriber::media_queue::reconcile_message(
            txn,
            signal_message.id,
            &superseded_media_ids,
        )
        .await
        .c(h!())?;
        reset_machine_derived_inbox_data(txn, signal_message.id)
            .await
            .c(h!())?;

        let mut changed_inbox_item_ids =
            crate::rer_importer::bgworker::process_message_to_inbox(
                settlements,
                txn,
                rq,
                config,
                signal_message.id,
                None,
            )
            .await
            .c(h!())?;
        for changed_inbox_item_id in &changed_inbox_item_ids {
            crate::sigint::worker::incoming_message_after_insert(
                txn,
                *changed_inbox_item_id,
            )
            .await
            .c(h!())?;
        }
        let annotation_source_ids =
            std::iter::once(source_message_id)
                .chain(retired_inbox_item_ids.iter().copied())
                .collect_vec();
        copy_manual_annotations_from_messages_to_promoted_messages(
            txn,
            &annotation_source_ids,
            &changed_inbox_item_ids,
        )
        .await
        .c(h!())?;
        push_deleted_reprocessed_source_id(
            txn,
            signal_message.id,
            &mut changed_inbox_item_ids,
        )
        .await
        .c(h!())?;
        changed_inbox_item_ids.extend(retired_inbox_item_ids);
        push_unique_inbox_item_ids(
            &mut changed_inbox_item_ids,
            changed_group_link_message_ids,
        );

        info!(
            "inbox change applied: datasource_id={} echo_inbox_message_id={} operation=edit result=updated linked_row_count={} changed_inbox_count={}",
            datasource_id,
            snapshot.internal_id,
            linked_messages.len(),
            changed_inbox_item_ids.len()
        );
        Ok(ReconcileResult {
            changed_inbox_item_ids,
            superseded_media_ids,
            superseded_ocr_result_keys,
            pending_dedupe_updates: vec![],
            uploaded_files_ready_for_deletion,
        })
    }
    .await;

    match result {
        Ok(result) => Ok(result),
        Err(err) => {
            clear_current_edit_dedupe_keys_best_effort(
                redis,
                source_message_id,
                &body,
                snapshot_attachments_hash.as_deref(),
                attachments_hash.as_deref(),
            )
            .await;
            restore_previous_dedupe_key_if_changed_best_effort(
                redis,
                source_message_id,
                previous_body.as_deref(),
                previous_attachments_hash.as_deref(),
                &body,
                attachments_hash.as_deref(),
            )
            .await;
            Err(err)
        }
    }
}

pub async fn delete_media_objects_best_effort(
    app_config: &crate::config::Config,
    s3: &Option<opendal::Operator>,
    media_ids: Vec<Uuid>,
    ocr_result_keys: Vec<String>,
) {
    if media_ids.is_empty() && ocr_result_keys.is_empty() {
        return;
    }
    for media_id in &media_ids {
        crate::messenger::media_cache::remove_cached_media_file_best_effort(
            app_config, *media_id,
        )
        .await;
        crate::messenger::media_thumbnail::remove_media_thumbnail_files_best_effort(
            app_config,
            *media_id,
        )
        .await;
    }
    let Some(s3) = s3 else {
        warn!(
            "S3 is not configured, skipped deletion for {} superseded media objects",
            media_ids.len()
        );
        return;
    };
    let Some(s3_config) = app_config.s3_config.as_ref() else {
        warn!(
            "S3 is not configured, skipped deletion for {} superseded media objects",
            media_ids.len()
        );
        return;
    };
    let s3_config = crate::storage::S3Config::from(s3_config);
    for media_id in media_ids {
        let object_keys = [
            crate::storage::nested_object_key(&media_id),
            crate::storage::plaintext_media_object_key(&media_id),
            crate::storage::plaintext_media_migration_marker_object_key(
                &media_id,
            ),
        ];
        for object_key in object_keys {
            let remote_key = s3_config.prefixed_key(&object_key);
            if let Err(err) = s3.delete(&remote_key).await {
                error!(
                    "failed to delete superseded media object {}: {:?}",
                    remote_key, err
                );
            }
        }
    }
    for object_key in ocr_result_keys {
        let remote_key = s3_config.prefixed_key(&object_key);
        if let Err(err) = s3.delete(&remote_key).await {
            error!(
                "failed to delete superseded OCR result {}: {:?}",
                remote_key, err
            );
        }
    }
}

async fn update_source_message_snapshot(
    txn: &DatabaseTransaction,
    signal_message: signal_message::Model,
    body: &str,
    snapshot: &MessageF1,
    datasource_group_id: i64,
    attachments_hash: Option<String>,
) -> anyhow::Result<signal_message::Model> {
    let mut signal_message = signal_message.into_active_model();
    signal_message.body = Set(Some(body.to_string()));
    signal_message.sender = Set(snapshot_sender_uuid(snapshot));
    signal_message.timestamp = Set(Some(snapshot.timestamp));
    signal_message.datasource_group_id = Set(Some(datasource_group_id));
    signal_message.deleted = Set(true);
    signal_message.external_id = Set(None);
    signal_message.echo_inbox_message_id =
        Set(Some(snapshot.internal_id as i64));
    signal_message.attachments_hash = Set(attachments_hash);
    signal_message.update(txn).await.c(h!())
}

fn snapshot_sender_uuid(snapshot: &MessageF1) -> Option<String> {
    snapshot.sender.as_ref().map(|sender| {
        crate::messenger::worker::clear_messenger_login_string(&sender.uuid)
    })
}

async fn effective_snapshot_attachments(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    snapshot: &MessageF1,
    source_message_id: i64,
) -> anyhow::Result<Vec<MessageAttachmentF1>> {
    let previous_attachment_count = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(source_message_id),
        )
        .count(txn)
        .await
        .c(h!())? as usize;
    if !snapshot.attachments.is_empty() {
        return Ok(trim_echo_attachment_batch_for_edit(
            snapshot.attachments.clone(),
            previous_attachment_count,
            datasource_id,
            snapshot.internal_id,
        ));
    }
    if let Some(attachments) =
        crate::messenger::attachments::load_latest_echo_attachment_batch(
            txn,
            datasource_id,
            snapshot.internal_id,
        )
        .await
        .c(h!())?
    {
        return Ok(trim_echo_attachment_batch_for_edit(
            attachments,
            previous_attachment_count,
            datasource_id,
            snapshot.internal_id,
        ));
    }
    Ok(vec![])
}

fn trim_echo_attachment_batch_for_edit(
    attachments: Vec<MessageAttachmentF1>,
    previous_attachment_count: usize,
    datasource_id: i64,
    echo_inbox_message_id: i32,
) -> Vec<MessageAttachmentF1> {
    let original_attachment_count = attachments.len();
    let attachments =
        crate::messenger::attachments::latest_attachment_batch_by_expected_count(
            attachments,
            previous_attachment_count,
        );
    if !attachments.is_empty() {
        info!(
            "using attachment batch for active inbox edit: datasource_id={} echo_inbox_message_id={} attachments_count={} previous_attachment_count={} original_attachment_count={}",
            datasource_id,
            echo_inbox_message_id,
            attachments.len(),
            previous_attachment_count,
            original_attachment_count
        );
    }
    attachments
}

async fn retire_obsolete_linked_messages(
    txn: &DatabaseTransaction,
    source_message_id: i64,
    linked_messages: &[signal_message::Model],
) -> anyhow::Result<Vec<i64>> {
    let mut retired_ids = vec![];
    for signal_message in linked_messages {
        if signal_message.id == source_message_id {
            continue;
        }
        retired_ids.push(signal_message.id);
        if signal_message.deleted {
            continue;
        }
        let mut signal_message = signal_message.clone().into_active_model();
        signal_message.deleted = Set(true);
        signal_message.update(txn).await.c(h!())?;
    }
    Ok(retired_ids)
}

async fn reset_source_message_group_link(
    txn: &DatabaseTransaction,
    source_message: &signal_message::Model,
    was_duplicate_trace: bool,
) -> anyhow::Result<Vec<i64>> {
    signal_message_group::Entity::delete_many()
        .filter(
            signal_message_group::Column::SignalMessageId.eq(source_message.id),
        )
        .filter(
            signal_message_group::Column::CreatedAt
                .eq(source_message.created_at),
        )
        .exec(txn)
        .await
        .c(h!())?;
    if !was_duplicate_trace {
        return Ok(vec![]);
    }
    delete_previous_duplicate_group_links(txn, source_message)
        .await
        .c(h!())
}

async fn delete_previous_duplicate_group_links(
    txn: &DatabaseTransaction,
    signal_message: &signal_message::Model,
) -> anyhow::Result<Vec<i64>> {
    let Some(datasource_group_id) = signal_message.datasource_group_id else {
        return Ok(vec![]);
    };
    let mut query = signal_message_group::Entity::find()
        .filter(
            signal_message_group::Column::SignalMessageId.ne(signal_message.id),
        )
        .filter(
            signal_message_group::Column::CreatedAt
                .eq(signal_message.created_at),
        )
        .filter(
            signal_message_group::Column::DatasourceGroupId
                .eq(datasource_group_id),
        );
    query = match &signal_message.sender {
        Some(sender) => query.filter(
            signal_message_group::Column::Sender.eq(Some(sender.clone())),
        ),
        None => query.filter(signal_message_group::Column::Sender.is_null()),
    };
    let group_links = query.all(txn).await.c(h!())?;
    if group_links.len() > 1 {
        warn!(
            "skipped ambiguous duplicate group link reset: signal_message_id={} datasource_group_id={} created_at={} match_count={}",
            signal_message.id,
            datasource_group_id,
            signal_message.created_at,
            group_links.len()
        );
        return Ok(vec![]);
    }
    let mut deleted_signal_message_ids = Vec::with_capacity(group_links.len());
    for group_link in group_links {
        deleted_signal_message_ids.push(group_link.signal_message_id);
        signal_message_group::Entity::delete_by_id(group_link.id)
            .exec(txn)
            .await
            .c(h!())?;
    }
    Ok(deleted_signal_message_ids)
}

fn is_duplicate_trace_message(
    signal_message_id: i64,
    message_uid: Option<&str>,
) -> bool {
    message_uid
        .and_then(|message_uid| message_uid.strip_prefix("duplicate-trace-"))
        .and_then(|message_id| message_id.parse::<i64>().ok())
        == Some(signal_message_id)
}

async fn find_duplicate(
    txn: &DatabaseTransaction,
    redis: &mut ConnectionManager,
    body: &str,
    attachments_hash: Option<&str>,
    timestamp: NaiveDateTime,
    signal_message_id: i64,
) -> anyhow::Result<Option<(signal_message::Model, datasource_group::Model)>> {
    let body_for_dedupe =
        dedupe::body_with_attachments_hash(body, attachments_hash);
    crate::sigint::find_duplicate_of(
        txn,
        &body_for_dedupe,
        body,
        attachments_hash,
        Some(timestamp),
        signal_message_id,
        redis,
    )
    .await
    .c(h!())
}

async fn find_duplicate_for_edit(
    txn: &DatabaseTransaction,
    redis: &mut ConnectionManager,
    body: &str,
    snapshot_attachments_hash: Option<&str>,
    attachments_hash: Option<&str>,
    timestamp: NaiveDateTime,
    signal_message_id: i64,
) -> anyhow::Result<Option<(signal_message::Model, datasource_group::Model)>> {
    let snapshot_body_for_dedupe =
        dedupe::body_with_attachments_hash(body, snapshot_attachments_hash);
    let body_for_dedupe =
        dedupe::body_with_attachments_hash(body, attachments_hash);
    crate::sigint::lock_signal_message_dedupe_keys(
        txn,
        [snapshot_body_for_dedupe.as_str(), body_for_dedupe.as_str()],
    )
    .await
    .c(h!())?;
    let duplicate_of = find_duplicate(
        txn,
        redis,
        body,
        snapshot_attachments_hash,
        timestamp,
        signal_message_id,
    )
    .await
    .c(h!())?;
    if duplicate_of.is_some() || snapshot_attachments_hash == attachments_hash {
        return Ok(duplicate_of);
    }
    clear_current_dedupe_key_if_source(
        redis,
        signal_message_id,
        body,
        snapshot_attachments_hash,
    )
    .await
    .c(h!())?;
    find_duplicate(
        txn,
        redis,
        body,
        attachments_hash,
        timestamp,
        signal_message_id,
    )
    .await
    .c(h!())
}

async fn clear_previous_dedupe_key_if_changed(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    previous_body: Option<&str>,
    previous_attachments_hash: Option<&str>,
    body: &str,
    attachments_hash: Option<&str>,
) -> anyhow::Result<()> {
    let previous_body_for_dedupe = dedupe::body_with_attachments_hash(
        previous_body.unwrap_or_default(),
        previous_attachments_hash,
    );
    let body_for_dedupe =
        dedupe::body_with_attachments_hash(body, attachments_hash);
    if previous_body_for_dedupe == body_for_dedupe {
        return Ok(());
    }

    let key = dedupe_redis_key(&previous_body_for_dedupe);
    redis::cmd("EVAL")
        .arg(
            r#"
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"#,
        )
        .arg(1)
        .arg(&key)
        .arg(signal_message_id.to_string())
        .query_async::<i64>(redis)
        .await
        .c(h!())?;
    Ok(())
}

async fn restore_previous_dedupe_key_if_changed_best_effort(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    previous_body: Option<&str>,
    previous_attachments_hash: Option<&str>,
    body: &str,
    attachments_hash: Option<&str>,
) {
    if let Err(err) = restore_previous_dedupe_key_if_changed(
        redis,
        signal_message_id,
        previous_body,
        previous_attachments_hash,
        body,
        attachments_hash,
    )
    .await
    {
        warn!(
            "failed to restore previous edit dedupe key for signal_message_id={}: {:?}",
            signal_message_id, err
        );
    }
}

async fn restore_previous_dedupe_key_if_changed(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    previous_body: Option<&str>,
    previous_attachments_hash: Option<&str>,
    body: &str,
    attachments_hash: Option<&str>,
) -> anyhow::Result<()> {
    let previous_body_for_dedupe = dedupe::body_with_attachments_hash(
        previous_body.unwrap_or_default(),
        previous_attachments_hash,
    );
    let body_for_dedupe =
        dedupe::body_with_attachments_hash(body, attachments_hash);
    if previous_body_for_dedupe == body_for_dedupe {
        return Ok(());
    }

    redis::cmd("SET")
        .arg(dedupe_redis_key(&previous_body_for_dedupe))
        .arg(signal_message_id.to_string())
        .arg("NX")
        .arg("EX")
        .arg(REDIS_MGS_ID_TTL)
        .query_async::<()>(redis)
        .await
        .c(h!())?;
    Ok(())
}

async fn clear_current_dedupe_key_if_source_best_effort(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    body: &str,
    attachments_hash: Option<&str>,
) {
    if let Err(err) = clear_current_dedupe_key_if_source(
        redis,
        signal_message_id,
        body,
        attachments_hash,
    )
    .await
    {
        warn!(
            "failed to clear stale edit dedupe key for signal_message_id={}: {:?}",
            signal_message_id, err
        );
    }
}

async fn clear_current_edit_dedupe_keys_best_effort(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    body: &str,
    snapshot_attachments_hash: Option<&str>,
    attachments_hash: Option<&str>,
) {
    clear_current_dedupe_key_if_source_best_effort(
        redis,
        signal_message_id,
        body,
        snapshot_attachments_hash,
    )
    .await;
    if snapshot_attachments_hash == attachments_hash {
        return;
    }
    clear_current_dedupe_key_if_source_best_effort(
        redis,
        signal_message_id,
        body,
        attachments_hash,
    )
    .await;
}

async fn restore_edit_dedupe_after_media_fallback(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    previous_attachments_hash: Option<&str>,
    body: &str,
    snapshot_attachments_hash: Option<&str>,
    attachments_hash: Option<&str>,
) -> anyhow::Result<()> {
    clear_current_dedupe_key_if_source(
        redis,
        signal_message_id,
        body,
        snapshot_attachments_hash,
    )
    .await
    .c(h!())?;
    if snapshot_attachments_hash != attachments_hash {
        clear_current_dedupe_key_if_source(
            redis,
            signal_message_id,
            body,
            attachments_hash,
        )
        .await
        .c(h!())?;
    }
    redis::cmd("SET")
        .arg(dedupe::redis_key_for_body_with_attachments_hash(
            body,
            previous_attachments_hash,
        ))
        .arg(signal_message_id.to_string())
        .arg("NX")
        .arg("EX")
        .arg(REDIS_MGS_ID_TTL)
        .query_async::<()>(redis)
        .await
        .c(h!())?;
    Ok(())
}

async fn clear_current_dedupe_key_if_source(
    redis: &mut ConnectionManager,
    signal_message_id: i64,
    body: &str,
    attachments_hash: Option<&str>,
) -> anyhow::Result<()> {
    let key = dedupe::redis_key_for_body_with_attachments_hash(
        body,
        attachments_hash,
    );
    redis::cmd("EVAL")
        .arg(
            r#"
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"#,
        )
        .arg(1)
        .arg(&key)
        .arg(signal_message_id.to_string())
        .query_async::<i64>(redis)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn apply_pending_dedupe_updates(
    redis: &mut ConnectionManager,
    updates: Vec<DedupeRedisUpdate>,
) -> anyhow::Result<()> {
    for update in updates {
        match update {
            DedupeRedisUpdate::Set {
                body,
                attachments_hash,
                signal_message_id,
            } => {
                redis::cmd("SET")
                    .arg(dedupe::redis_key_for_body_with_attachments_hash(
                        &body,
                        attachments_hash.as_deref(),
                    ))
                    .arg(signal_message_id.to_string())
                    .arg("EX")
                    .arg(REDIS_MGS_ID_TTL)
                    .query_async::<()>(redis)
                    .await
                    .c(h!())?;
            }
            DedupeRedisUpdate::ClearIfValue {
                body,
                attachments_hash,
                signal_message_id,
            } => {
                clear_current_dedupe_key_if_source(
                    redis,
                    signal_message_id,
                    &body,
                    attachments_hash.as_deref(),
                )
                .await
                .c(h!())?;
            }
        }
    }
    Ok(())
}

fn dedupe_redis_key(body_for_dedupe: &str) -> String {
    let body_base64 =
        general_purpose::STANDARD.encode(body_for_dedupe.as_bytes());
    format!("signal_message:{body_base64}")
}

struct MediaReplacementResult {
    superseded_media_ids: Vec<Uuid>,
    superseded_ocr_result_keys: Vec<String>,
    preserved_previous: bool,
    uploaded_files_ready_for_deletion: Vec<MediaUploadInput>,
}

async fn replace_media_if_changed(
    txn: &DatabaseTransaction,
    config: &Config,
    s3: &Option<opendal::Operator>,
    signal_message: &signal_message::Model,
    previous_attachments_hash: Option<String>,
    attachments_hash: Option<String>,
    attachments: &[MessageAttachmentF1],
) -> anyhow::Result<MediaReplacementResult> {
    let old_media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message.id),
        )
        .all(txn)
        .await
        .c(h!())?;
    let old_media_ids = old_media.iter().map(|media| media.id).collect_vec();

    if previous_attachments_hash == attachments_hash {
        return Ok(MediaReplacementResult {
            superseded_media_ids: vec![],
            superseded_ocr_result_keys: vec![],
            preserved_previous: false,
            uploaded_files_ready_for_deletion: vec![],
        });
    }

    if attachments.is_empty() {
        return Ok(MediaReplacementResult {
            superseded_media_ids: vec![],
            superseded_ocr_result_keys: vec![],
            preserved_previous: false,
            uploaded_files_ready_for_deletion: vec![],
        });
    }

    if should_preserve_unavailable_media(&old_media, attachments).await {
        update_attachments_hash(
            txn,
            signal_message.id,
            previous_attachments_hash,
        )
        .await
        .c(h!())?;
        return Ok(MediaReplacementResult {
            superseded_media_ids: vec![],
            superseded_ocr_result_keys: vec![],
            preserved_previous: true,
            uploaded_files_ready_for_deletion: vec![],
        });
    }

    let upload_inputs = attachments
        .iter()
        .cloned()
        .map(MediaUploadInput::from)
        .collect_vec();
    let delete_uploaded = config
        .feature_delete_uploaded_attachment
        .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT);
    let deletion = if delete_uploaded {
        crate::messenger::media::UploadedAttachmentDeletion::DeleteAfterCommit
    } else {
        crate::messenger::media::UploadedAttachmentDeletion::Preserve
    };
    let upload_result = crate::messenger::media::store_media_attachments(
        &upload_inputs,
        signal_message.id,
        config,
        s3,
        txn,
        deletion,
    )
    .await
    .c(h!())?;
    if upload_result.skipped_missing {
        let uploaded_media_ids = upload_result
            .media
            .into_iter()
            .map(|media| media.id)
            .collect_vec();
        delete_old_media(txn, uploaded_media_ids.clone())
            .await
            .c(h!())?;
        update_attachments_hash(
            txn,
            signal_message.id,
            previous_attachments_hash,
        )
        .await
        .c(h!())?;
        return Ok(MediaReplacementResult {
            superseded_media_ids: uploaded_media_ids,
            superseded_ocr_result_keys: vec![],
            preserved_previous: true,
            uploaded_files_ready_for_deletion: if delete_uploaded {
                upload_result.uploaded_files_ready_for_deletion
            } else {
                vec![]
            },
        });
    }
    let (superseded_media_ids, superseded_ocr_result_keys) =
        delete_old_media(txn, old_media_ids).await.c(h!())?;
    Ok(MediaReplacementResult {
        superseded_media_ids,
        superseded_ocr_result_keys,
        preserved_previous: false,
        uploaded_files_ready_for_deletion: if delete_uploaded {
            upload_result.uploaded_files_ready_for_deletion
        } else {
            vec![]
        },
    })
}

async fn effective_edit_attachments_hash(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    previous_attachments_hash: Option<String>,
    attachments_hash: Option<String>,
    attachments: &[MessageAttachmentF1],
) -> anyhow::Result<Option<String>> {
    if previous_attachments_hash == attachments_hash {
        return Ok(attachments_hash);
    }
    let old_media = signal_message_media::Entity::find()
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .all(txn)
        .await
        .c(h!())?;
    if attachments.is_empty() && !old_media.is_empty() {
        return Ok(previous_attachments_hash);
    }
    if should_preserve_unavailable_media(&old_media, attachments).await {
        return Ok(previous_attachments_hash);
    }
    Ok(attachments_hash)
}

async fn update_attachments_hash(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    attachments_hash: Option<String>,
) -> anyhow::Result<()> {
    let mut signal_message = signal_message::ActiveModel {
        id: Set(signal_message_id),
        ..Default::default()
    };
    signal_message.attachments_hash = Set(attachments_hash);
    signal_message.update(txn).await.c(h!())?;
    Ok(())
}

async fn delete_old_media(
    txn: &DatabaseTransaction,
    old_media_ids: Vec<Uuid>,
) -> anyhow::Result<(Vec<Uuid>, Vec<String>)> {
    if old_media_ids.is_empty() {
        return Ok((old_media_ids, vec![]));
    }
    let ocr_result_keys = crate::ocr::load_result_keys(txn, &old_media_ids)
        .await
        .c(h!())?;
    signal_message_media::Entity::delete_many()
        .filter(signal_message_media::Column::Id.is_in(old_media_ids.clone()))
        .exec(txn)
        .await
        .c(h!())?;
    Ok((old_media_ids, ocr_result_keys))
}

async fn delete_media_for_message(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
) -> anyhow::Result<(Vec<Uuid>, Vec<String>)> {
    let old_media_ids = signal_message_media::Entity::find()
        .select_only()
        .column(signal_message_media::Column::Id)
        .filter(
            signal_message_media::Column::SignalMessageId.eq(signal_message_id),
        )
        .into_tuple::<Uuid>()
        .all(txn)
        .await
        .c(h!())?;
    delete_old_media(txn, old_media_ids).await.c(h!())
}

async fn should_preserve_unavailable_media(
    old_media: &[signal_message_media::Model],
    attachments: &[MessageAttachmentF1],
) -> bool {
    media_filenames_match_attachments(old_media, attachments)
        && has_unavailable_attachment_path(attachments).await
}

async fn has_unavailable_attachment_path(
    attachments: &[MessageAttachmentF1],
) -> bool {
    for attachment in attachments {
        if tokio::fs::metadata(&attachment.path).await.is_err() {
            return true;
        }
    }
    false
}

fn media_filenames_match_attachments(
    media: &[signal_message_media::Model],
    attachments: &[MessageAttachmentF1],
) -> bool {
    if media.is_empty() || media.len() != attachments.len() {
        return false;
    }

    let media_names = media
        .iter()
        .filter_map(|media| media.file_name.clone())
        .sorted()
        .collect_vec();
    let attachment_names = attachments
        .iter()
        .filter_map(attachment_filename)
        .sorted()
        .collect_vec();

    media_names.len() == media.len()
        && attachment_names.len() == attachments.len()
        && media_names == attachment_names
}

fn attachment_filename(attachment: &MessageAttachmentF1) -> Option<String> {
    attachment
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.to_string())
        .or_else(|| {
            Path::new(&attachment.path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        })
}

async fn reset_machine_derived_inbox_data(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
) -> anyhow::Result<()> {
    let system_login_id = crate::users::system_login_id(txn).await?;
    if sigint_inbox_item::Entity::find_by_id(signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .is_some()
    {
        crate::inbox::callsigns::sync(
            txn,
            signal_message_id,
            crate::inbox::callsigns::InboxItemCallsigns::default(),
            system_login_id,
        )
        .await?;
    }
    sigint_search::Entity::delete_by_id(signal_message_id)
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_metadata::Entity::delete_many()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .eq(signal_message_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_peleng::Entity::delete_many()
        .filter(sigint_peleng::Column::SourceInboxItemId.eq(signal_message_id))
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_network::Entity::delete_many()
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId
                .eq(signal_message_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_point_token::Entity::delete_many()
        .filter(
            sigint_inbox_item_point_token::Column::SigintInboxItemId
                .eq(signal_message_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    sigint_important::Entity::delete_many()
        .filter(sigint_important::Column::SignalMessageId.eq(signal_message_id))
        .filter(sigint_important::Column::LoginId.is_null())
        .exec(txn)
        .await
        .c(h!())?;
    sigint_comment::Entity::delete_many()
        .filter(sigint_comment::Column::SignalMessageId.eq(signal_message_id))
        .filter(sigint_comment::Column::LoginId.eq(system_login_id))
        .exec(txn)
        .await
        .c(h!())?;
    sigint_inbox_item_tag::Entity::delete_many()
        .filter(
            sigint_inbox_item_tag::Column::SigintInboxItemId
                .eq(signal_message_id),
        )
        .filter(
            Condition::any()
                .add(sigint_inbox_item_tag::Column::LoginId.is_null())
                .add(
                    sigint_inbox_item_tag::Column::LoginId
                        .eq(Some(system_login_id)),
                )
                .add(sigint_inbox_item_tag::Column::Model.is_not_null()),
        )
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

#[cfg(test)]
#[serial_test::serial]
mod tests {
    use super::*;
    use crate::functest::tests::{
        cleanup_locked, mk_datasource, mk_datasource_group, mk_login,
        mk_sigint_bookmark, mk_sigint_comment, mk_sigint_important,
        mk_sigint_inbox_item, mk_sigint_inbox_item_tag, mk_signal_group,
        mk_signal_message,
    };
    use sea_orm::{
        ActiveValue::NotSet, ActiveValue::Set, ColumnTrait, EntityTrait,
        QueryFilter, TransactionTrait,
    };
    use serde_json::json;

    async fn mk_duplicate_trace(
        txn: &DatabaseTransaction,
        original_message_id: i64,
        original_message_uid: Option<String>,
        group_id: &str,
        datasource_group_id: i64,
        body: String,
        created_at: NaiveDateTime,
        echo_inbox_message_id: i64,
    ) -> signal_message::Model {
        let trace = mk_signal_message(
            txn,
            signal_message::ActiveModel {
                body: Set(Some(body)),
                created_at: Set(created_at),
                datasource_group_id: Set(Some(datasource_group_id)),
                timestamp: Set(Some(created_at)),
                deleted: Set(true),
                echo_inbox_message_id: Set(Some(echo_inbox_message_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let trace_id = trace.id;
        let mut trace = trace.into_active_model();
        trace.message_uid = Set(Some(format!("duplicate-trace-{trace_id}")));
        let trace = trace.update(txn).await.unwrap();
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(original_message_id),
            group_master_key: Set(Some(group_id.to_string())),
            sender: Set(trace.sender.clone()),
            message_uid: Set(original_message_uid),
            datasource_group_id: Set(Some(datasource_group_id)),
            created_at: Set(trace.created_at),
        }
        .insert(txn)
        .await
        .unwrap();
        trace
    }

    #[tokio::test]
    async fn copied_comments_distinguish_sigint_post_id() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let login_value = format!("comment-post-{}", Uuid::new_v4());
        let login = mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(login_value.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let post_a = sigint_post::ActiveModel {
            name: Set(format!("post-a-{}", Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let post_b = sigint_post::ActiveModel {
            name: Set(format!("post-b-{}", Uuid::new_v4())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let original =
            mk_signal_message(&txn, Default::default()).await.unwrap();
        let promoted =
            mk_signal_message(&txn, Default::default()).await.unwrap();
        let created_at = Utc::now().naive_utc();
        let comment = format!("same text {}", Uuid::new_v4());
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(login.id),
                comment: Set(comment.clone()),
                created_at: Set(created_at),
                sigint_post_id: Set(Some(post_a.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(promoted.id),
                login_id: Set(login.id),
                comment: Set(comment.clone()),
                created_at: Set(created_at),
                sigint_post_id: Set(Some(post_b.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        copy_manual_annotations_to_promoted_message(
            &txn,
            original.id,
            promoted.id,
        )
        .await
        .unwrap();

        let post_ids = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(promoted.id))
            .filter(sigint_comment::Column::LoginId.eq(login.id))
            .filter(sigint_comment::Column::Comment.eq(&comment))
            .all(&txn)
            .await
            .unwrap()
            .into_iter()
            .map(|comment| comment.sigint_post_id)
            .sorted()
            .collect_vec();
        assert_eq!(post_ids, vec![Some(post_a.id), Some(post_b.id)]);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_matches_legacy_unbackfilled_message() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("legacy-delete-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("legacy delete {}", Uuid::new_v4());
        let deleted_trace = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(true),
                echo_inbox_message_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let signal_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4545".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4545,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(result.changed_inbox_item_ids, vec![signal_message.id]);
        assert!(result.superseded_media_ids.is_empty());
        let signal_message =
            signal_message::Entity::find_by_id(signal_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert!(signal_message.deleted);
        let deleted_trace =
            signal_message::Entity::find_by_id(deleted_trace.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert!(deleted_trace.deleted);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn load_linked_messages_prefers_active_non_trace_source() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("linked-source-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let echo_inbox_message_id = 5252;
        let trace = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(datasource_group.id)),
                deleted: Set(true),
                echo_inbox_message_id: Set(Some(echo_inbox_message_id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let trace_id = trace.id;
        let mut trace = trace.into_active_model();
        trace.message_uid = Set(Some(format!("duplicate-trace-{trace_id}")));
        let trace = trace.update(&txn).await.unwrap();
        let active = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(datasource_group.id)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(echo_inbox_message_id)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let linked_messages =
            load_linked_messages(&txn, datasource.id, echo_inbox_message_id)
                .await
                .unwrap();

        assert_eq!(linked_messages[0].id, active.id);
        assert_eq!(linked_messages[1].id, trace.id);
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_id_only_tombstone_matches_legacy_unbackfilled_message() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("legacy-delete-id-only-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("legacy id-only delete {}", Uuid::new_v4());
        let signal_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let phone_suffix = Uuid::new_v4().simple().to_string();
        let account = echo_account::ActiveModel {
            id: NotSet,
            source: Set(
                crate::entities::sea_orm_active_enums::EchoMessageSource::Signal,
            ),
            phone_number: Set(format!("+{}", &phone_suffix[..12])),
            is_linked: Set(true),
            created_at: Set(timestamp),
            synced_at: Set(None),
            last_trusted_at: Set(None),
            linked_at: Set(Some(timestamp)),
        }
        .insert(&txn)
        .await
        .unwrap();
        let echo_group = echo_group::ActiveModel {
            id: NotSet,
            group_id: Set(group_id.clone()),
            internal_id: Set(Some(format!("internal-{group_id}"))),
            name: Set(Some(group_id.clone())),
            account_id: Set(account.id),
            created_at: Set(timestamp),
            updated_at: Set(timestamp),
            deleted_by_messanger: Set(false),
        }
        .insert(&txn)
        .await
        .unwrap();
        let inbox_message = echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(body),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(None),
            sender_id: Set(None),
            group_id: Set(Some(echo_group.id)),
            account_id: Set(account.id),
            created_at: Set(timestamp),
            timestamp: Set(Some(timestamp)),
            updated_at: Set(timestamp),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(true),
        }
        .insert(&txn)
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: inbox_message.internal_id.clone(),
            text: String::new(),
            sender: None,
            sender_phone_number: None,
            group_id: None,
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp: Utc::now().naive_utc(),
            internal_id: inbox_message.id,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(result.changed_inbox_item_ids, vec![signal_message.id]);
        assert!(
            signal_message::Entity::find_by_id(signal_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_duplicate_trace_removes_original_group_link() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("delete-duplicate-trace-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("original {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let trace = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("trace {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(true),
                echo_inbox_message_id: Set(Some(4747)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let trace_id = trace.id;
        let mut trace = trace.into_active_model();
        trace.message_uid = Set(Some(format!("duplicate-trace-{trace_id}")));
        let trace = trace.update(&txn).await.unwrap();
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(original.id),
            group_master_key: Set(Some(group_id.clone())),
            sender: Set(trace.sender.clone()),
            message_uid: Set(original.message_uid.clone()),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(trace.created_at),
        }
        .insert(&txn)
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4747".to_string()),
            text: trace.body.clone().unwrap(),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4747,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(result.changed_inbox_item_ids, vec![trace.id, original.id]);
        let original_links = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(original.id),
            )
            .filter(
                signal_message_group::Column::CreatedAt.eq(trace.created_at),
            )
            .all(&txn)
            .await
            .unwrap();
        assert!(original_links.is_empty());

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_original_promotes_duplicate_trace() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("delete-original-duplicate-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("duplicate set {}", Uuid::new_v4());
        let operator_tags = json!({"review": ["manual"]});
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4848)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                operator_tags: Set(Some(operator_tags.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate_a = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            body.clone(),
            timestamp + chrono::Duration::seconds(1),
            4849,
        )
        .await;
        let duplicate_b = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            body.clone(),
            timestamp + chrono::Duration::seconds(2),
            4850,
        )
        .await;
        let media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(original.id),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("original.txt".to_string())),
            size_bytes: Set(8),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let body_key =
            dedupe::redis_key_for_body_with_attachments_hash(&body, None);
        redis::cmd("SET")
            .arg(&body_key)
            .arg(original.id.to_string())
            .arg("EX")
            .arg(REDIS_MGS_ID_TTL)
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        crate::rer_importer::bgworker::process_message_to_inbox(
            env.settlements.clone(),
            &txn,
            &env.rq,
            &env.config,
            original.id,
            None,
        )
        .await
        .unwrap();
        let annotation_login = format!("annotation-{}", Uuid::new_v4());
        mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(annotation_login.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let annotation_login_id =
            crate::users::login_id_by_name(&txn, &annotation_login)
                .await
                .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                comment: Set("operator note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                comment: Set("second operator note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(duplicate_a.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                comment: Set("existing promoted note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &txn,
            sigint_bookmark::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &annotation_login)
                        .await
                        .unwrap(),
                )),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manual_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(original.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &annotation_login)
                        .await
                        .unwrap(),
                )),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(original.id),
            tag_id: Set(manual_tag.tag_id),
            confidence: Set(0.5),
            login_id: Set(Some(
                crate::users::login_id_by_name(&txn, &annotation_login)
                    .await
                    .unwrap(),
            )),
            model: Set(Some("model-derived".to_string())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4848".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4848,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(
            result.changed_inbox_item_ids,
            vec![original.id, duplicate_a.id]
        );
        assert_eq!(result.pending_dedupe_updates.len(), 2);
        apply_pending_dedupe_updates(
            &mut redis,
            result.pending_dedupe_updates.clone(),
        )
        .await
        .unwrap();
        let original = signal_message::Entity::find_by_id(original.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let duplicate_a = signal_message::Entity::find_by_id(duplicate_a.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let duplicate_b = signal_message::Entity::find_by_id(duplicate_b.id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(original.deleted);
        assert!(!duplicate_a.deleted);
        assert!(duplicate_b.deleted);
        assert!(!duplicate_a
            .message_uid
            .as_deref()
            .unwrap()
            .starts_with("duplicate-trace-"));
        assert_eq!(duplicate_a.operator_tags, Some(operator_tags));
        assert_eq!(
            redis::cmd("GET")
                .arg(&body_key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            Some(duplicate_a.id.to_string())
        );
        assert!(sigint_inbox_item::Entity::find_by_id(duplicate_a.id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        assert!(sigint_search::Entity::find()
            .select_only()
            .column(sigint_search::Column::Id)
            .filter(sigint_search::Column::Id.eq(duplicate_a.id))
            .into_tuple::<i64>()
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        let original_duplicate_links = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(original.id),
            )
            .filter(
                signal_message_group::Column::CreatedAt
                    .is_in([duplicate_a.created_at, duplicate_b.created_at]),
            )
            .all(&txn)
            .await
            .unwrap();
        assert!(original_duplicate_links.is_empty());
        let promoted_links = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(duplicate_a.id),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(promoted_links.len(), 2);
        assert!(promoted_links
            .iter()
            .all(|link| link.message_uid == duplicate_a.message_uid));
        let media = signal_message_media::Entity::find_by_id(media_id)
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(media.signal_message_id, duplicate_a.id);
        let mut comments = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(duplicate_a.id))
            .filter(sigint_comment::Column::LoginId.eq(annotation_login_id))
            .all(&txn)
            .await
            .unwrap()
            .into_iter()
            .map(|comment| comment.comment)
            .collect_vec();
        comments.sort();
        assert_eq!(
            comments,
            vec![
                "existing promoted note".to_string(),
                "operator note".to_string(),
                "second operator note".to_string(),
            ]
        );
        assert_eq!(
            sigint_bookmark::Entity::find()
                .filter(
                    sigint_bookmark::Column::SignalMessageId.eq(duplicate_a.id),
                )
                .filter(
                    sigint_bookmark::Column::LoginId.eq(annotation_login_id),
                )
                .filter(sigint_bookmark::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::SignalMessageId
                        .eq(duplicate_a.id),
                )
                .filter(
                    sigint_important::Column::LoginId
                        .eq(Some(annotation_login_id)),
                )
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::SignalMessageId
                        .eq(duplicate_a.id),
                )
                .filter(sigint_important::Column::LoginId.is_null())
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(duplicate_a.id),
                )
                .filter(
                    sigint_inbox_item_tag::Column::TagId.eq(manual_tag.tag_id)
                )
                .filter(
                    sigint_inbox_item_tag::Column::LoginId
                        .eq(Some(annotation_login_id)),
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_null())
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(duplicate_a.id),
                )
                .filter(
                    sigint_inbox_item_tag::Column::TagId.eq(manual_tag.tag_id)
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
                .count(&txn)
                .await
                .unwrap(),
            0
        );

        redis::cmd("DEL")
            .arg(&body_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_original_keeps_blank_duplicate_trace_deleted_without_media()
    {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("delete-blank-duplicate-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(String::new())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4948)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate_trace = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            String::new(),
            timestamp + chrono::Duration::seconds(1),
            4949,
        )
        .await;
        let snapshot = MessageF1 {
            id: Some("external-4948".to_string()),
            text: String::new(),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4948,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(result.changed_inbox_item_ids, vec![original.id]);
        assert!(
            signal_message::Entity::find_by_id(original.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            signal_message::Entity::find_by_id(duplicate_trace.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(sigint_inbox_item::Entity::find_by_id(duplicate_trace.id)
            .one(&txn)
            .await
            .unwrap()
            .is_none());

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_original_without_promotion_clears_stale_dedupe_key() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("delete-clear-dedupe-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("delete stale dedupe {}", Uuid::new_v4());
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4944)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let body_key =
            dedupe::redis_key_for_body_with_attachments_hash(&body, None);
        redis::cmd("SET")
            .arg(&body_key)
            .arg(original.id.to_string())
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4944".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4944,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();
        assert_eq!(result.pending_dedupe_updates.len(), 1);
        apply_pending_dedupe_updates(
            &mut redis,
            result.pending_dedupe_updates.clone(),
        )
        .await
        .unwrap();

        assert_eq!(
            redis::cmd("GET")
                .arg(&body_key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            None
        );

        redis::cmd("DEL")
            .arg(&body_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_original_promotes_later_nonblank_duplicate_trace() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id =
            format!("delete-later-nonblank-duplicate-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(String::new())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4947)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let blank_trace = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            String::new(),
            timestamp + chrono::Duration::seconds(1),
            4946,
        )
        .await;
        let nonblank_trace = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            format!("later duplicate content {}", Uuid::new_v4()),
            timestamp + chrono::Duration::seconds(2),
            4945,
        )
        .await;
        let snapshot = MessageF1 {
            id: Some("external-4947".to_string()),
            text: String::new(),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4947,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert_eq!(
            result.changed_inbox_item_ids,
            vec![original.id, nonblank_trace.id]
        );
        assert!(
            signal_message::Entity::find_by_id(blank_trace.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            !signal_message::Entity::find_by_id(nonblank_trace.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(sigint_inbox_item::Entity::find_by_id(nonblank_trace.id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn delete_original_copies_split_promotion_annotations_to_children() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("delete-split-duplicate-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = (0..20)
            .map(|idx| {
                format!(
                    "11.03, 10:{:02}:00\n{}\n{}\n{}\n{}",
                    idx,
                    "plain words ".repeat(8),
                    "more plain words ".repeat(8),
                    "simple body text ".repeat(8),
                    "another simple line ".repeat(8),
                )
            })
            .join("\n");
        assert!(crate::rer_importer::multimessage::should_try_split_message(
            &body
        ));
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(5048)),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate_trace = mk_duplicate_trace(
            &txn,
            original.id,
            original.message_uid.clone(),
            &group_id,
            datasource_group.id,
            body.clone(),
            timestamp + chrono::Duration::seconds(1),
            5049,
        )
        .await;
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(original.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let annotation_login = format!("split-annotation-{}", Uuid::new_v4());
        mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(annotation_login.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let annotation_login_id =
            crate::users::login_id_by_name(&txn, &annotation_login)
                .await
                .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                comment: Set("split note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &txn,
            sigint_bookmark::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &annotation_login,
                )
                .await
                .unwrap()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                signal_message_id: Set(original.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &annotation_login)
                        .await
                        .unwrap(),
                )),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manual_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(original.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &annotation_login)
                        .await
                        .unwrap(),
                )),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-5048".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 5048,
            reply_to: None,
            deleted: true,
        };

        let result = reconcile_deleted_message(
            &txn,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            datasource.id,
            &snapshot,
        )
        .await
        .unwrap();

        assert!(result.changed_inbox_item_ids.contains(&original.id));
        assert!(!result.changed_inbox_item_ids.contains(&duplicate_trace.id));
        let promoted_child_ids = result
            .changed_inbox_item_ids
            .iter()
            .copied()
            .filter(|id| *id != original.id)
            .collect_vec();
        assert!(promoted_child_ids.len() > 1);
        assert!(
            signal_message::Entity::find_by_id(duplicate_trace.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(sigint_inbox_item::Entity::find_by_id(duplicate_trace.id)
            .one(&txn)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq(duplicate_trace.id),
                )
                .count(&txn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(duplicate_trace.id),
                )
                .count(&txn)
                .await
                .unwrap(),
            0
        );

        for promoted_child_id in promoted_child_ids {
            assert!(
                !signal_message::Entity::find_by_id(promoted_child_id)
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap()
                    .deleted
            );
            assert!(sigint_inbox_item::Entity::find_by_id(promoted_child_id)
                .one(&txn)
                .await
                .unwrap()
                .is_some());
            assert_eq!(
                sigint_comment::Entity::find()
                    .filter(
                        sigint_comment::Column::SignalMessageId
                            .eq(promoted_child_id),
                    )
                    .filter(
                        sigint_comment::Column::LoginId.eq(annotation_login_id)
                    )
                    .count(&txn)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sigint_bookmark::Entity::find()
                    .filter(
                        sigint_bookmark::Column::SignalMessageId
                            .eq(promoted_child_id),
                    )
                    .filter(
                        sigint_bookmark::Column::LoginId
                            .eq(annotation_login_id)
                    )
                    .filter(sigint_bookmark::Column::Deleted.eq(false))
                    .count(&txn)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sigint_important::Entity::find()
                    .filter(
                        sigint_important::Column::SignalMessageId
                            .eq(promoted_child_id),
                    )
                    .filter(
                        sigint_important::Column::LoginId
                            .eq(Some(annotation_login_id)),
                    )
                    .filter(sigint_important::Column::Deleted.eq(false))
                    .count(&txn)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                sigint_inbox_item_tag::Entity::find()
                    .filter(
                        sigint_inbox_item_tag::Column::SigintInboxItemId
                            .eq(promoted_child_id),
                    )
                    .filter(
                        sigint_inbox_item_tag::Column::TagId
                            .eq(manual_tag.tag_id),
                    )
                    .filter(
                        sigint_inbox_item_tag::Column::LoginId
                            .eq(Some(annotation_login_id)),
                    )
                    .filter(sigint_inbox_item_tag::Column::Model.is_null())
                    .count(&txn)
                    .await
                    .unwrap(),
                1
            );
        }

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_matches_legacy_unbackfilled_message() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("legacy-edit-{}", Uuid::new_v4());
        let sender_id = format!("{}@lid", Uuid::new_v4());
        let snapshot_sender_id = sender_id.replace("@lid", ":5@lid");
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let signal_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("legacy before {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                sender: Set(Some(sender_id.clone())),
                deleted: Set(false),
                echo_inbox_message_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4646".to_string()),
            text: format!("legacy after {}", Uuid::new_v4()),
            sender: Some(echo_im::types::SenderF1 {
                uuid: snapshot_sender_id,
                name: Some("Sender".to_string()),
                phone_number: None,
            }),
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Whatsapp,
            timestamp,
            internal_id: 4646,
            reply_to: None,
            deleted: false,
        };

        let linked_messages =
            load_active_linked_messages(&txn, datasource.id, &snapshot)
                .await
                .unwrap();

        assert_eq!(linked_messages.len(), 1);
        assert_eq!(linked_messages[0].id, signal_message.id);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_normalizes_whatsapp_sender_before_unstage() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("edit-sender-{}", Uuid::new_v4());
        let sender_id = format!("{}@lid", Uuid::new_v4());
        let snapshot_sender_id = sender_id.replace("@lid", ":5@lid");
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before sender {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                sender: Set(Some(sender_id.clone())),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4746)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4746".to_string()),
            text: format!("after sender {}", Uuid::new_v4()),
            sender: Some(echo_im::types::SenderF1 {
                uuid: snapshot_sender_id,
                name: Some("Sender".to_string()),
                phone_number: None,
            }),
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Whatsapp,
            timestamp,
            internal_id: 4746,
            reply_to: None,
            deleted: false,
        };

        reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(source_message.sender.as_deref(), Some(sender_id.as_str()));
        let group_link = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(source_message.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(group_link.sender.as_deref(), Some(sender_id.as_str()));

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_preserves_media_when_snapshot_has_no_attachments() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("edit-preserve-media-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let previous_attachments_hash =
            format!("previous-attachments-{}", Uuid::new_v4());
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before media {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4747)),
                attachments_hash: Set(Some(previous_attachments_hash.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(source_message.id),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("old.txt".to_string())),
            size_bytes: Set(3),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let body = format!("after media {}", Uuid::new_v4());
        let snapshot = MessageF1 {
            id: Some("external-4747".to_string()),
            text: body.clone(),
            sender: None,
            sender_phone_number: None,
            group_id: None,
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4747,
            reply_to: None,
            deleted: false,
        };

        let result = reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        assert!(result.superseded_media_ids.is_empty());
        assert!(signal_message_media::Entity::find_by_id(media_id)
            .one(&txn)
            .await
            .unwrap()
            .is_some());
        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            source_message.attachments_hash,
            Some(previous_attachments_hash.clone())
        );

        redis::cmd("DEL")
            .arg(dedupe::redis_key_for_body_with_attachments_hash(
                &body,
                Some(&previous_attachments_hash),
            ))
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_prefers_non_empty_snapshot_attachments() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("edit-current-media-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        let account = link_datasource_to_echo_account(&txn, &datasource).await;
        let inbox_message = insert_echo_inbox_message(&txn, account.id).await;
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before media {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(i64::from(inbox_message.id))),
                attachments_hash: Set(Some("previous-attachments".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        signal_message_media::ActiveModel {
            id: Set(Uuid::now_v7()),
            signal_message_id: Set(source_message.id),
            content_type: Set("image/jpeg".to_string()),
            file_ext: Set(Some("jpg".to_string())),
            file_name: Set(Some("a.jpg".to_string())),
            size_bytes: Set(3),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let stale_created_at = Utc::now().naive_utc();
        insert_echo_attachment(
            &txn,
            account.id,
            inbox_message.id,
            "/tmp/stale-a.jpg",
            Some("a.jpg"),
            stale_created_at,
        )
        .await;
        insert_echo_attachment(
            &txn,
            account.id,
            inbox_message.id,
            "/tmp/stale-b.jpg",
            Some("b.jpg"),
            stale_created_at,
        )
        .await;
        let snapshot = MessageF1 {
            id: Some(format!("external-{}", inbox_message.id)),
            text: format!("after media {}", Uuid::new_v4()),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![MessageAttachmentF1 {
                path: "/tmp/current-b.jpg".to_string(),
                name: Some("b.jpg".to_string()),
            }],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: inbox_message.id,
            reply_to: None,
            deleted: false,
        };
        let expected_attachments_hash =
            dedupe::attachments_hash(&snapshot.attachments).await;

        reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(source_message.attachments_hash, expected_attachments_hash);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_regenerates_search_for_split_children() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("active-edit-split-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before split {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(5148)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(source_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let obsolete_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("obsolete split {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(5148)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(obsolete_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_login = format!("split-source-{}", Uuid::new_v4());
        let obsolete_login = format!("split-obsolete-{}", Uuid::new_v4());
        for annotation_login in [&source_login, &obsolete_login] {
            mk_login(
                &txn,
                login::ActiveModel {
                    id: NotSet,
                    login: Set(annotation_login.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let source_login_id =
            crate::users::login_id_by_name(&txn, &source_login)
                .await
                .unwrap();
        let obsolete_login_id =
            crate::users::login_id_by_name(&txn, &obsolete_login)
                .await
                .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &source_login,
                )
                .await
                .unwrap()),
                comment: Set("source split note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(obsolete_message.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &obsolete_login,
                )
                .await
                .unwrap()),
                comment: Set("obsolete split note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &txn,
            sigint_bookmark::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &source_login,
                )
                .await
                .unwrap()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &txn,
            sigint_bookmark::ActiveModel {
                signal_message_id: Set(obsolete_message.id),
                login_id: Set(crate::users::login_id_by_name(
                    &txn,
                    &obsolete_login,
                )
                .await
                .unwrap()),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(source_message.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &source_login)
                        .await
                        .unwrap(),
                )),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let obsolete_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(obsolete_message.id),
                login_id: Set(Some(
                    crate::users::login_id_by_name(&txn, &obsolete_login)
                        .await
                        .unwrap(),
                )),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let body = (0..20)
            .map(|idx| {
                format!(
                    "11.03, 10:{:02}:00\n{}\n{}\n{}\n{}",
                    idx,
                    "plain words ".repeat(8),
                    "more plain words ".repeat(8),
                    "simple body text ".repeat(8),
                    "another simple line ".repeat(8),
                )
            })
            .join("\n");
        assert!(crate::rer_importer::multimessage::should_try_split_message(
            &body
        ));
        let snapshot = MessageF1 {
            id: Some("external-5148".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 5148,
            reply_to: None,
            deleted: false,
        };

        let result = reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone(), obsolete_message.clone()],
        )
        .await
        .unwrap();

        let visible_child_ids = result
            .changed_inbox_item_ids
            .iter()
            .copied()
            .filter(|id| *id != source_message.id && *id != obsolete_message.id)
            .collect_vec();
        assert!(visible_child_ids.len() > 1);
        assert!(result.changed_inbox_item_ids.contains(&source_message.id));
        assert!(result.changed_inbox_item_ids.contains(&obsolete_message.id));
        assert!(
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            signal_message::Entity::find_by_id(obsolete_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .deleted
        );
        for child_id in visible_child_ids {
            assert!(
                !signal_message::Entity::find_by_id(child_id)
                    .one(&txn)
                    .await
                    .unwrap()
                    .unwrap()
                    .deleted
            );
            assert!(sigint_inbox_item::Entity::find_by_id(child_id)
                .one(&txn)
                .await
                .unwrap()
                .is_some());
            assert!(sigint_search::Entity::find()
                .select_only()
                .column(sigint_search::Column::Id)
                .filter(sigint_search::Column::Id.eq(child_id))
                .into_tuple::<i64>()
                .one(&txn)
                .await
                .unwrap()
                .is_some());
            assert_eq!(
                sigint_comment::Entity::find()
                    .filter(
                        sigint_comment::Column::SignalMessageId.eq(child_id)
                    )
                    .filter(
                        sigint_comment::Column::LoginId
                            .is_in(vec![source_login_id, obsolete_login_id])
                    )
                    .count(&txn)
                    .await
                    .unwrap(),
                2
            );
            assert_eq!(
                sigint_bookmark::Entity::find()
                    .filter(
                        sigint_bookmark::Column::SignalMessageId.eq(child_id)
                    )
                    .filter(
                        sigint_bookmark::Column::LoginId
                            .is_in(vec![source_login_id, obsolete_login_id])
                    )
                    .filter(sigint_bookmark::Column::Deleted.eq(false))
                    .count(&txn)
                    .await
                    .unwrap(),
                2
            );
            assert_eq!(
                sigint_inbox_item_tag::Entity::find()
                    .filter(
                        sigint_inbox_item_tag::Column::SigintInboxItemId
                            .eq(child_id)
                    )
                    .filter(
                        sigint_inbox_item_tag::Column::TagId.is_in(vec![
                            source_tag.tag_id,
                            obsolete_tag.tag_id
                        ])
                    )
                    .filter(sigint_inbox_item_tag::Column::Model.is_null())
                    .count(&txn)
                    .await
                    .unwrap(),
                2
            );
        }

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn failed_edit_clears_seeded_dedupe_key() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("failed-edit-dedupe-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before edit {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let body = format!("failed edit {}", Uuid::new_v4());
        let key = dedupe::redis_key_for_body_with_attachments_hash(&body, None);
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();

        let duplicate_of = find_duplicate(
            &txn,
            &mut redis,
            &body,
            None,
            timestamp,
            source_message.id,
        )
        .await
        .unwrap();

        assert!(duplicate_of.is_none());
        assert_eq!(
            redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            Some(source_message.id.to_string())
        );

        clear_current_dedupe_key_if_source(
            &mut redis,
            source_message.id,
            &body,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            None
        );

        redis::cmd("SET")
            .arg(&key)
            .arg("other-message-id")
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        clear_current_dedupe_key_if_source(
            &mut redis,
            source_message.id,
            &body,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            redis::cmd("GET")
                .arg(&key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            Some("other-message-id".to_string())
        );
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn failed_edit_restores_previous_dedupe_key() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let mut redis = env.redis.clone();
        let signal_message_id = 987_654_321;
        let previous_body = format!("previous restore {}", Uuid::new_v4());
        let edited_body = format!("edited restore {}", Uuid::new_v4());
        let previous_key = dedupe_redis_key(
            &dedupe::body_with_attachments_hash(&previous_body, None),
        );
        let edited_key = dedupe_redis_key(&dedupe::body_with_attachments_hash(
            &edited_body,
            None,
        ));
        redis::cmd("DEL")
            .arg(&previous_key)
            .arg(&edited_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        redis::cmd("SET")
            .arg(&previous_key)
            .arg(signal_message_id.to_string())
            .query_async::<()>(&mut redis)
            .await
            .unwrap();

        clear_previous_dedupe_key_if_changed(
            &mut redis,
            signal_message_id,
            Some(&previous_body),
            None,
            &edited_body,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            redis::cmd("GET")
                .arg(&previous_key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            None
        );

        restore_previous_dedupe_key_if_changed(
            &mut redis,
            signal_message_id,
            Some(&previous_body),
            None,
            &edited_body,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            redis::cmd("GET")
                .arg(&previous_key)
                .query_async::<Option<String>>(&mut redis)
                .await
                .unwrap(),
            Some(signal_message_id.to_string())
        );

        redis::cmd("DEL")
            .arg(&previous_key)
            .arg(&edited_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn duplicate_edit_deletes_trace_media() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("duplicate-edit-media-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("duplicate edit {}", Uuid::new_v4());
        let duplicate_target = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                attachments_hash: Set(Some("old-attachments".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(duplicate_target.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before edit {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4242)),
                attachments_hash: Set(Some("old-attachments".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(source_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let annotation_login_name =
            format!("duplicate-edit-{}", Uuid::new_v4());
        let annotation_login = mk_login(
            &txn,
            login::ActiveModel {
                id: NotSet,
                login: Set(annotation_login_name),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_comment(
            &txn,
            sigint_comment::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(annotation_login.id),
                comment: Set("duplicate edit note".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_bookmark(
            &txn,
            sigint_bookmark::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(annotation_login.id),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(Some(annotation_login.id)),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                signal_message_id: Set(source_message.id),
                login_id: Set(None),
                deleted: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manual_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(source_message.id),
                login_id: Set(Some(annotation_login.id)),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        sigint_inbox_item_tag::ActiveModel {
            sigint_inbox_item_id: Set(source_message.id),
            tag_id: Set(manual_tag.tag_id),
            confidence: Set(0.5),
            login_id: Set(Some(annotation_login.id)),
            model: Set(Some("model-derived".to_string())),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(source_message.id),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("old.txt".to_string())),
            size_bytes: Set(3),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4242".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4242,
            reply_to: None,
            deleted: false,
        };

        let result = reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        assert_eq!(
            result.changed_inbox_item_ids,
            vec![source_message.id, duplicate_target.id]
        );
        assert_eq!(result.superseded_media_ids, vec![media_id]);
        assert!(signal_message_media::Entity::find_by_id(media_id)
            .one(&txn)
            .await
            .unwrap()
            .is_none());
        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert!(source_message.deleted);
        assert_eq!(
            sigint_comment::Entity::find()
                .filter(
                    sigint_comment::Column::SignalMessageId
                        .eq(duplicate_target.id),
                )
                .filter(sigint_comment::Column::LoginId.eq(annotation_login.id))
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .comment,
            "duplicate edit note"
        );
        assert_eq!(
            sigint_bookmark::Entity::find()
                .filter(
                    sigint_bookmark::Column::SignalMessageId
                        .eq(duplicate_target.id),
                )
                .filter(
                    sigint_bookmark::Column::LoginId.eq(annotation_login.id)
                )
                .filter(sigint_bookmark::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::SignalMessageId
                        .eq(duplicate_target.id),
                )
                .filter(
                    sigint_important::Column::LoginId
                        .eq(Some(annotation_login.id)),
                )
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_important::Entity::find()
                .filter(
                    sigint_important::Column::SignalMessageId
                        .eq(duplicate_target.id),
                )
                .filter(sigint_important::Column::LoginId.is_null())
                .filter(sigint_important::Column::Deleted.eq(false))
                .count(&txn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(duplicate_target.id),
                )
                .filter(
                    sigint_inbox_item_tag::Column::TagId.eq(manual_tag.tag_id)
                )
                .filter(
                    sigint_inbox_item_tag::Column::LoginId
                        .eq(Some(annotation_login.id)),
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_null())
                .count(&txn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sigint_inbox_item_tag::Entity::find()
                .filter(
                    sigint_inbox_item_tag::Column::SigintInboxItemId
                        .eq(duplicate_target.id),
                )
                .filter(
                    sigint_inbox_item_tag::Column::TagId.eq(manual_tag.tag_id)
                )
                .filter(sigint_inbox_item_tag::Column::Model.is_not_null())
                .count(&txn)
                .await
                .unwrap(),
            0
        );

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn duplicate_edit_uses_preserved_hash_for_unavailable_media() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id =
            format!("duplicate-edit-preserved-media-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let body = format!("duplicate preserved media {}", Uuid::new_v4());
        let previous_attachments_hash =
            format!("preserved-attachments-{}", Uuid::new_v4());
        let duplicate_target = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                attachments_hash: Set(Some(previous_attachments_hash.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("before edit {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4546)),
                attachments_hash: Set(Some(previous_attachments_hash.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(source_message.id),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("old.txt".to_string())),
            size_bytes: Set(3),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let body_key = dedupe_redis_key(&dedupe::body_with_attachments_hash(
            &body,
            Some(&previous_attachments_hash),
        ));
        redis::cmd("DEL")
            .arg(&body_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4546".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![MessageAttachmentF1 {
                path: format!("/tmp/missing-{}/old.txt", Uuid::new_v4()),
                name: Some("old.txt".to_string()),
            }],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4546,
            reply_to: None,
            deleted: false,
        };

        let result = reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        assert_eq!(
            result.changed_inbox_item_ids,
            vec![source_message.id, duplicate_target.id]
        );
        assert_eq!(result.superseded_media_ids, vec![media_id]);
        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert!(source_message.deleted);
        assert_eq!(
            source_message.attachments_hash,
            Some(previous_attachments_hash)
        );
        assert!(signal_message_media::Entity::find_by_id(media_id)
            .one(&txn)
            .await
            .unwrap()
            .is_none());

        redis::cmd("DEL")
            .arg(&body_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn active_edit_empty_attachment_fallback_preserves_existing_media() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("edit-empty-media-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let previous_attachments_hash =
            format!("empty-fallback-media-{}", Uuid::new_v4());
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!(
                    "before empty media {}",
                    Uuid::new_v4()
                ))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4646)),
                attachments_hash: Set(Some(previous_attachments_hash.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let media_id = Uuid::now_v7();
        signal_message_media::ActiveModel {
            id: Set(media_id),
            signal_message_id: Set(source_message.id),
            content_type: Set("text/plain".to_string()),
            file_ext: Set(Some("txt".to_string())),
            file_name: Set(Some("old.txt".to_string())),
            size_bytes: Set(3),
            is_encrypted: Set(true),
            created_at: NotSet,
        }
        .insert(&txn)
        .await
        .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4646".to_string()),
            text: format!("after empty media {}", Uuid::new_v4()),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4646,
            reply_to: None,
            deleted: false,
        };

        let result = reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        assert_eq!(result.changed_inbox_item_ids, vec![source_message.id]);
        assert!(result.superseded_media_ids.is_empty());
        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            source_message.attachments_hash,
            Some(previous_attachments_hash)
        );
        assert_eq!(
            signal_message_media::Entity::find_by_id(media_id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap()
                .signal_message_id,
            source_message.id
        );

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn edit_clears_previous_dedupe_key_for_source_message() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let mut redis = env.redis.clone();
        let group_id = format!("edit-dedupe-key-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let previous_body = format!("previous body {}", Uuid::new_v4());
        let body = format!("edited duplicate body {}", Uuid::new_v4());
        mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                attachments_hash: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(previous_body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                echo_inbox_message_id: Set(Some(4343)),
                attachments_hash: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let previous_key = dedupe_redis_key(
            &dedupe::body_with_attachments_hash(&previous_body, None),
        );
        let body_key =
            dedupe_redis_key(&dedupe::body_with_attachments_hash(&body, None));
        redis::cmd("SET")
            .arg(&previous_key)
            .arg(source_message.id.to_string())
            .query_async::<()>(&mut redis)
            .await
            .unwrap();
        let snapshot = MessageF1 {
            id: Some("external-4343".to_string()),
            text: body,
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4343,
            reply_to: None,
            deleted: false,
        };

        reconcile_active_message(
            &txn,
            &mut redis,
            env.settlements.clone(),
            &env.rq,
            &env.config,
            &env.s3,
            datasource.id,
            &snapshot,
            vec![source_message.clone()],
        )
        .await
        .unwrap();

        let candidate = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(previous_body.clone())),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(true),
                attachments_hash: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let duplicate = find_duplicate(
            &txn,
            &mut redis,
            &previous_body,
            None,
            timestamp,
            candidate.id,
        )
        .await
        .unwrap();
        assert!(duplicate.is_none());

        redis::cmd("DEL")
            .arg(&previous_key)
            .arg(&body_key)
            .query_async::<i64>(&mut redis)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn edit_from_duplicate_removes_previous_original_group_link() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_id = format!("edit-duplicate-link-{}", Uuid::new_v4());
        let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
        mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(group_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                group_master_key: Set(group_id.clone()),
                datasource_id: Set(datasource.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let timestamp = Utc::now().naive_utc();
        let original = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!(
                    "original duplicate {}",
                    Uuid::new_v4()
                ))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(false),
                message_uid: Set(Some(format!("uid-{}", Uuid::new_v4()))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                body: Set(Some(format!("trace duplicate {}", Uuid::new_v4()))),
                datasource_group_id: Set(Some(datasource_group.id)),
                timestamp: Set(Some(timestamp)),
                deleted: Set(true),
                echo_inbox_message_id: Set(Some(4444)),
                attachments_hash: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_message_id = source_message.id;
        let mut source_message = source_message.into_active_model();
        source_message.message_uid =
            Set(Some(format!("duplicate-trace-{source_message_id}")));
        let source_message = source_message.update(&txn).await.unwrap();
        signal_message_group::ActiveModel {
            id: NotSet,
            signal_message_id: Set(original.id),
            group_master_key: Set(Some(group_id.clone())),
            sender: Set(source_message.sender.clone()),
            message_uid: Set(original.message_uid.clone()),
            datasource_group_id: Set(Some(datasource_group.id)),
            created_at: Set(source_message.created_at),
        }
        .insert(&txn)
        .await
        .unwrap();
        let source_message_created_at = source_message.created_at;
        let snapshot = MessageF1 {
            id: Some("external-4444".to_string()),
            text: format!("resurrected {}", Uuid::new_v4()),
            sender: None,
            sender_phone_number: None,
            group_id: Some(group_id.clone()),
            attachments: vec![],
            message_source: echo_im::types::MessageSource::Signal,
            timestamp,
            internal_id: 4444,
            reply_to: None,
            deleted: false,
        };

        let source_message_before_edit = source_message.clone();
        let source_message = update_source_message_snapshot(
            &txn,
            source_message,
            &snapshot.text,
            &snapshot,
            datasource_group.id,
            None,
        )
        .await
        .unwrap();
        let changed_group_link_message_ids = reset_source_message_group_link(
            &txn,
            &source_message_before_edit,
            is_duplicate_trace_message(
                source_message_before_edit.id,
                source_message_before_edit.message_uid.as_deref(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(changed_group_link_message_ids, vec![original.id]);
        let unstage_result = crate::sigint::worker::unstage_message(
            &txn,
            &group_id,
            source_message.clone(),
            None,
        )
        .await
        .unwrap();
        assert!(!unstage_result.is_duplicate);

        let original_links = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId.eq(original.id),
            )
            .filter(
                signal_message_group::Column::CreatedAt
                    .eq(source_message_created_at),
            )
            .all(&txn)
            .await
            .unwrap();
        assert!(original_links.is_empty());
        let source_links = signal_message_group::Entity::find()
            .filter(
                signal_message_group::Column::SignalMessageId
                    .eq(source_message.id),
            )
            .filter(
                signal_message_group::Column::CreatedAt
                    .eq(source_message_created_at),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(source_links.len(), 1);
        assert_eq!(
            source_links[0].group_master_key.as_deref(),
            Some(group_id.as_str())
        );
        let source_message =
            signal_message::Entity::find_by_id(source_message.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        assert!(!source_message.deleted);

        txn.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn reset_machine_derived_inbox_data_removes_auto_data_only() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let signal_message =
            mk_signal_message(&txn, Default::default()).await.unwrap();
        mk_sigint_inbox_item(
            &txn,
            sigint_inbox_item::ActiveModel {
                id: Set(signal_message.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let login = mk_login(&txn, Default::default()).await.unwrap();
        if login::Entity::find()
            .filter(login::Column::Login.eq(SYSTEM_LOGIN_NAME))
            .one(&txn)
            .await
            .unwrap()
            .is_none()
        {
            mk_login(
                &txn,
                login::ActiveModel {
                    id: NotSet,
                    login: Set(SYSTEM_LOGIN_NAME.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                id: NotSet,
                signal_message_id: Set(signal_message.id),
                login_id: Set(None),
                created_at: NotSet,
                deleted: Set(false),
            },
        )
        .await
        .unwrap();
        mk_sigint_important(
            &txn,
            sigint_important::ActiveModel {
                id: NotSet,
                signal_message_id: Set(signal_message.id),
                login_id: Set(Some(login.id)),
                created_at: NotSet,
                deleted: Set(false),
            },
        )
        .await
        .unwrap();
        let manual_tag = mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(signal_message.id),
                login_id: Set(Some(login.id)),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(signal_message.id),
                login_id: Set(Some(
                    crate::users::system_login_id(&txn).await.unwrap(),
                )),
                model: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_tag(
            &txn,
            sigint_inbox_item_tag::ActiveModel {
                sigint_inbox_item_id: Set(signal_message.id),
                login_id: Set(None),
                model: Set(Some("test-model".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        reset_machine_derived_inbox_data(&txn, signal_message.id)
            .await
            .unwrap();

        let importants = sigint_important::Entity::find()
            .filter(
                sigint_important::Column::SignalMessageId.eq(signal_message.id),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(importants.len(), 1);
        assert_eq!(importants[0].login_id, Some(login.id));
        let tags = sigint_inbox_item_tag::Entity::find()
            .filter(
                sigint_inbox_item_tag::Column::SigintInboxItemId
                    .eq(signal_message.id),
            )
            .all(&txn)
            .await
            .unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].id, manual_tag.id);

        txn.commit().await.unwrap();
    }

    async fn link_datasource_to_echo_account(
        txn: &DatabaseTransaction,
        datasource: &datasource::Model,
    ) -> echo_account::Model {
        let now = Utc::now().naive_utc();
        let phone_seed = Uuid::new_v4().simple().to_string();
        let account = echo_account::ActiveModel {
            id: NotSet,
            source: Set(
                crate::entities::sea_orm_active_enums::EchoMessageSource::Signal,
            ),
            phone_number: Set(format!("+{}", &phone_seed[..12])),
            is_linked: Set(true),
            created_at: Set(now),
            synced_at: Set(None),
            last_trusted_at: Set(None),
            linked_at: Set(Some(now)),
        }
        .insert(txn)
        .await
        .unwrap();
        let client = echo_client::ActiveModel {
            id: NotSet,
            name: Set(format!("test-client-{}", Uuid::new_v4())),
            created_at: Set(now),
            deleted: Set(false),
            display_name: Set(None),
        }
        .insert(txn)
        .await
        .unwrap();
        let echo_client_lock = echo_client_lock::ActiveModel {
            id: NotSet,
            client_id: Set(client.id),
            account_id: Set(account.id),
            created_at: Set(now),
            remove_requested: Set(false),
        }
        .insert(txn)
        .await
        .unwrap();
        let mut datasource = datasource.clone().into_active_model();
        datasource.echo_client_lock_id =
            Set(Some(i64::from(echo_client_lock.id)));
        datasource.update(txn).await.unwrap();
        account
    }

    async fn insert_echo_attachment(
        txn: &DatabaseTransaction,
        account_id: i32,
        message_id: i32,
        path: &str,
        name: Option<&str>,
        created_at: NaiveDateTime,
    ) -> echo_attachment::Model {
        echo_attachment::ActiveModel {
            id: NotSet,
            name: Set(name.map(ToString::to_string)),
            path: Set(path.to_string()),
            message_id: Set(message_id),
            account_id: Set(account_id),
            created_at: Set(created_at),
            updated_at: Set(created_at),
        }
        .insert(txn)
        .await
        .unwrap()
    }

    async fn insert_echo_inbox_message(
        txn: &DatabaseTransaction,
        account_id: i32,
    ) -> echo_inbox_message::Model {
        let now = Utc::now().naive_utc();
        echo_inbox_message::ActiveModel {
            id: NotSet,
            body: Set(format!("inbox {}", Uuid::new_v4())),
            internal_id: Set(Some(format!("external-{}", Uuid::new_v4()))),
            duplicate_of: Set(None),
            sender_id: Set(None),
            group_id: Set(None),
            account_id: Set(account_id),
            created_at: Set(now),
            timestamp: Set(Some(now)),
            updated_at: Set(now),
            reply_to_inbox_message_id: Set(None),
            reply_to_outbox_message_id: Set(None),
            internal_timestamp: Set(None),
            seen: Set(false),
            client_id: Set(None),
            deleted: Set(false),
        }
        .insert(txn)
        .await
        .unwrap()
    }
}
