use crate::config::*;
use crate::entities::*;
use crate::messenger::media::{MediaUploadInput, StagedMediaAttachments};
use crate::{
    location::SettlementsDataConfig, messenger::types::Message, types::*,
};
use chrono::Utc;
use echo_im::types::MessageAttachmentF1;
use redis::aio::ConnectionManager;
use sea_orm::*;

/// Workhorse for the message queue
///
/// - this routine is called from [process_queue_nofail](crate::messenger::worker::queue::process_queue_nofail) which launches set of N worker threads
/// - consumes messages from [signal_message_queue table](crate::entities::signal_message_queue)
/// - inserts them into [signal_message table](crate::entities::signal_message)
/// - further see [construct_inbox_item](crate::inbox::construct_inbox_item) where we construct [sigint_inbox_item](crate::entities::sigint_inbox_item) entries from [signal_message](crate::entities::signal_message)
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessSignalMessageQueueItemOptions {
    pub created_at: Option<NaiveDateTime>,
}

#[derive(Clone, Debug)]
pub struct ProcessSignalMessageQueueItemResult {
    pub message_uid: String,
    pub is_duplicate: bool,
    pub uploaded_files_ready_for_deletion: Vec<MediaUploadInput>,
}

pub async fn process_signal_message_queue_item(
    m: Message,
    attachments: Vec<MessageAttachmentF1>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> Result<ProcessSignalMessageQueueItemResult, AppError> {
    process_signal_message_queue_item_with_options(
        m,
        attachments,
        redis,
        settlements,
        rq,
        config,
        s3,
        txn,
        skip_process_inbox_item,
        changed_inbox_item_ids,
        ProcessSignalMessageQueueItemOptions::default(),
    )
    .await
}

pub async fn process_signal_message_queue_item_with_options(
    m: Message,
    attachments: Vec<MessageAttachmentF1>,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    s3: &Option<opendal::Operator>,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
    options: ProcessSignalMessageQueueItemOptions,
) -> Result<ProcessSignalMessageQueueItemResult, AppError> {
    let staged_media =
        stage_queue_media(&attachments, config, s3).await.c(h!())?;
    process_signal_message_queue_item_with_staged_media_and_options(
        m,
        &staged_media,
        redis,
        settlements,
        rq,
        config,
        txn,
        skip_process_inbox_item,
        changed_inbox_item_ids,
        options,
    )
    .await
}

pub async fn process_signal_message_queue_item_with_staged_media(
    m: Message,
    staged_media: &StagedMediaAttachments,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
) -> Result<ProcessSignalMessageQueueItemResult, AppError> {
    process_signal_message_queue_item_with_staged_media_and_options(
        m,
        staged_media,
        redis,
        settlements,
        rq,
        config,
        txn,
        skip_process_inbox_item,
        changed_inbox_item_ids,
        ProcessSignalMessageQueueItemOptions::default(),
    )
    .await
}

pub async fn process_signal_message_queue_item_with_staged_media_and_options(
    m: Message,
    staged_media: &StagedMediaAttachments,
    redis: &mut ConnectionManager,
    settlements: Arc<RwLock<SettlementsDataConfig>>,
    rq: &reqwest::Client,
    config: &Config,
    txn: &DatabaseTransaction,
    skip_process_inbox_item: bool,
    changed_inbox_item_ids: &mut Vec<i64>,
    options: ProcessSignalMessageQueueItemOptions,
) -> Result<ProcessSignalMessageQueueItemResult, AppError> {
    // Normalize body
    info!(
        "received message for processing: datasource_id={} inbox_message_id={:?} group_id_present={} attachments_count={}",
        m.datasource_id,
        m.inbox_message_id,
        !m.group_id.is_empty(),
        staged_media.len(),
    );
    let body = m.body.replace("\r\n", "\n");
    info!(
        "processing queue item: datasource_id={} attachments_count={}",
        m.datasource_id,
        staged_media.len(),
    );
    let attachments_hash = staged_media.attachments_hash().map(str::to_string);
    let created_at = options.created_at;
    let body_for_dedupe = crate::messenger::dedupe::body_with_attachments_hash(
        &body,
        attachments_hash.as_deref(),
    );
    let datasource_group_id =
        crate::messenger::group::ensure_datasource_group_id(
            txn,
            m.group_id.clone(),
            m.datasource_id,
        )
        .await
        .c(h!())?;
    let signal_message = signal_message::ActiveModel {
        id: NotSet,
        id_uuid: Set(Some(crate::sigint::message_id::signal_message_uuid(
            Some(m.timestamp),
            created_at.unwrap_or_else(|| Utc::now().naive_utc()),
        ))),
        body: Set(Some(body.clone())),
        datasource_group_id: Set(Some(datasource_group_id)),
        created_at: match created_at {
            Some(created_at) => Set(created_at),
            None => NotSet,
        },
        timestamp: Set(Some(m.timestamp)),
        sender: Set(m.sender),
        login_id: NotSet,
        format: NotSet,
        deleted: Set(true), // unstaged message
        external_id: Set(None),
        // Echo IM inbox id is kept here only for tracing messages back to echo_im.
        echo_inbox_message_id: Set(m.inbox_message_id),
        message_uid: NotSet,
        operator_tags: NotSet,
        attachments_hash: Set(attachments_hash),
    }
    .insert(txn)
    .await
    .c(h!())?;
    let staged_signal_message_id = signal_message.id;
    let staged_signal_message_uuid = signal_message.id_uuid;
    let m_duplicate_of = crate::sigint::find_duplicate_of(
        txn,
        &body_for_dedupe,
        &body,
        signal_message.attachments_hash.as_deref(),
        Some(m.timestamp),
        signal_message.id,
        redis,
    )
    .await
    .c(h!())?;
    let res = crate::sigint::worker::unstage_message(
        txn,
        &m.group_id,
        signal_message,
        m_duplicate_of,
    )
    .await
    .c(h!())?;

    if res.is_duplicate {
        let uploaded_files_ready_for_deletion =
            store_kept_duplicate_trace_media(
                txn,
                staged_signal_message_id,
                staged_signal_message_uuid,
                staged_media,
            )
            .await
            .c(h!())?;
        if let Some(inbox_message_id) = m.inbox_message_id {
            match i32::try_from(inbox_message_id) {
                Ok(message_id) => {
                    let do_not_store_duplicate_echoim_failures =
                        crate::system_settings::do_not_store_duplicate_echoim_failures_enabled(
                            txn,
                        )
                        .await
                        .c(h!())?;
                    crate::messenger::missing_message::record_or_delete_duplicate_missing_message(
                        txn,
                        message_id,
                        do_not_store_duplicate_echoim_failures,
                    )
                    .await
                    .c(h!())?;
                }
                Err(e) => warn!(
                    "failed to convert duplicate inbox_message_id={inbox_message_id} to i32: {e}; skipping missing message record"
                ),
            }
        }
        let duplicate_target = if res.message.message_uid.is_none() {
            crate::messenger::id::update_message_with_uid(
                txn,
                config,
                res.message,
            )
            .await
            .c(h!())?
        } else {
            res.message
        };
        return Ok(ProcessSignalMessageQueueItemResult {
            message_uid: duplicate_target.message_uid.context(h!())?,
            is_duplicate: true,
            uploaded_files_ready_for_deletion,
        });
    }

    let signal_message =
        crate::messenger::id::update_message_with_uid(txn, config, res.message)
            .await
            .c(h!())?;

    let message_uid = signal_message.message_uid.clone().c(h!())?;

    let uploaded_files_ready_for_deletion = if staged_media.is_empty() {
        vec![]
    } else {
        store_queue_media(
            txn,
            signal_message.id,
            signal_message.id_uuid,
            staged_media,
        )
        .await
        .c(h!())?
    };

    if !skip_process_inbox_item {
        let processed_inbox_item_ids =
            crate::rer_importer::bgworker::process_message_to_inbox(
                settlements.clone(),
                txn,
                rq,
                config,
                signal_message.id,
                None,
            )
            .await
            .c(h!())?;
        for processed_inbox_item_id in &processed_inbox_item_ids {
            crate::sigint::worker::incoming_message_after_insert(
                txn,
                *processed_inbox_item_id,
            )
            .await
            .c(h!())?;
        }
        changed_inbox_item_ids.extend(processed_inbox_item_ids);
    }
    Ok(ProcessSignalMessageQueueItemResult {
        message_uid,
        is_duplicate: false,
        uploaded_files_ready_for_deletion,
    })
}

async fn store_kept_duplicate_trace_media(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    signal_message_uuid: Option<Uuid>,
    staged_media: &StagedMediaAttachments,
) -> Result<Vec<MediaUploadInput>, AppError> {
    if staged_media.is_empty() {
        return Ok(vec![]);
    }
    if signal_message::Entity::find_by_id(signal_message_id)
        .one(txn)
        .await
        .c(h!())?
        .is_none()
    {
        return Ok(vec![]);
    }
    persist_queue_media(
        txn,
        signal_message_id,
        signal_message_uuid,
        staged_media,
    )
    .await
    .map(|_| vec![])
}

async fn store_queue_media(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    signal_message_uuid: Option<Uuid>,
    staged_media: &StagedMediaAttachments,
) -> Result<Vec<MediaUploadInput>, AppError> {
    let media = persist_queue_media(
        txn,
        signal_message_id,
        signal_message_uuid,
        staged_media,
    )
    .await
    .c(h!())?;
    crate::sigint::media_conversion::schedule_uploaded_media(
        txn,
        signal_message_id,
        &media,
        &staged_media.stored_uploads(),
    )
    .await
    .c(h!())?;
    Ok(vec![])
}

async fn persist_queue_media(
    txn: &DatabaseTransaction,
    signal_message_id: i64,
    signal_message_uuid: Option<Uuid>,
    staged_media: &StagedMediaAttachments,
) -> Result<Vec<signal_message_media::Model>, AppError> {
    // Recovery wraps this error in a rollback because media may carry critical context.
    let media = crate::messenger::media::persist_staged_media(
        staged_media,
        signal_message_id,
        signal_message_uuid,
        txn,
    )
    .await
    .c(h!())?;
    crate::transcriber::media_queue::reconcile_message(
        txn,
        signal_message_id,
        &[],
    )
    .await
    .c(h!())?;
    Ok(media)
}

pub async fn stage_queue_media(
    attachments: &[MessageAttachmentF1],
    config: &Config,
    s3: &Option<opendal::Operator>,
) -> Result<StagedMediaAttachments, AppError> {
    stage_queue_media_with_previous_hash(attachments, config, s3, None).await
}

pub async fn stage_queue_media_for_active_edit(
    attachments: &[MessageAttachmentF1],
    previous_attachments_hash: &Option<String>,
    config: &Config,
    s3: &Option<opendal::Operator>,
) -> Result<StagedMediaAttachments, AppError> {
    stage_queue_media_with_previous_hash(
        attachments,
        config,
        s3,
        Some(previous_attachments_hash),
    )
    .await
}

async fn stage_queue_media_with_previous_hash(
    attachments: &[MessageAttachmentF1],
    config: &Config,
    s3: &Option<opendal::Operator>,
    previous_attachments_hash: Option<&Option<String>>,
) -> Result<StagedMediaAttachments, AppError> {
    let upload_inputs = attachments
        .iter()
        .cloned()
        .map(MediaUploadInput::from)
        .collect::<Vec<_>>();
    let deletion = queue_media_deletion(config);
    let attachments_hash =
        crate::messenger::dedupe::attachments_hash(&upload_inputs).await;
    if previous_attachments_hash.is_some_and(|previous_attachments_hash| {
        previous_attachments_hash == &attachments_hash
    }) {
        return Ok(StagedMediaAttachments::without_uploaded_objects(
            upload_inputs.len(),
            attachments_hash,
            deletion,
        ));
    }
    crate::messenger::media::stage_media_attachments(
        &upload_inputs,
        config,
        s3,
        deletion,
        attachments_hash,
    )
    .await
}

fn queue_media_deletion(
    config: &Config,
) -> crate::messenger::media::UploadedAttachmentDeletion {
    if config
        .feature_delete_uploaded_attachment
        .unwrap_or(FEATURE_DELETE_UPLOADED_ATTACHMENT_DEFAULT)
    {
        crate::messenger::media::UploadedAttachmentDeletion::DeleteAfterCommit
    } else {
        crate::messenger::media::UploadedAttachmentDeletion::Preserve
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use md5::{Digest, Md5};
    use opendal::{services::Memory, Operator};

    fn memory_s3_config(config: &mut Config) {
        config.s3_config = Some(crate::config::S3Config {
            s3_access_key_id: "test".into(),
            s3_secret_access_key: "test".into(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: "test".into(),
            strongbox_key: crate::storage::generate_strongbox_key_b64(),
        });
    }

    #[tokio::test]
    async fn media_staging_finishes_before_waiting_for_the_update_lock() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let holder = env.dbx.begin().await.unwrap();
        crate::battle_line::lock_updates(&holder).await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("lock-held.txt");
        tokio::fs::write(&path, b"staged before transaction")
            .await
            .unwrap();
        let mut config = env.config.clone();
        memory_s3_config(&mut config);
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());

        let staged_media = stage_queue_media(
            &[MessageAttachmentF1 {
                path: path.display().to_string(),
                name: Some("lock-held.txt".into()),
            }],
            &config,
            &s3,
        )
        .await
        .unwrap();
        assert_eq!(staged_media.len(), 1);

        let contender = env.dbx.begin().await.unwrap();
        contender
            .execute_unprepared("set local lock_timeout = '50ms'")
            .await
            .unwrap();
        assert!(crate::battle_line::lock_updates(&contender).await.is_err());
        contender.rollback().await.unwrap();
        staged_media.cleanup_after_rollback(&config, &s3).await;
        assert!(path.exists());
        holder.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn unchanged_active_edit_hash_skips_object_upload() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("unchanged.txt");
        let payload = b"unchanged media";
        tokio::fs::write(&path, payload).await.unwrap();
        let mut config = env.config.clone();
        memory_s3_config(&mut config);
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let previous_attachments_hash =
            Some(format!("[attachment sha256:{}]", sha256::digest(payload)));

        let staged_media = stage_queue_media_for_active_edit(
            &[MessageAttachmentF1 {
                path: path.display().to_string(),
                name: Some("unchanged.txt".into()),
            }],
            &previous_attachments_hash,
            &config,
            &s3,
        )
        .await
        .unwrap();

        assert_eq!(staged_media.len(), 1);
        assert_eq!(staged_media.uploaded_object_count(), 0);
    }

    #[tokio::test]
    async fn queue_ingestion_enqueues_stored_geodata_before_commit() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("queue-route.gpx");
        let payload = b"queue geodata";
        tokio::fs::write(&path, payload).await.unwrap();
        let mut config = env.config.clone();
        config.feature_delete_uploaded_attachment = Some(true);
        memory_s3_config(&mut config);
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let staged_media = stage_queue_media(
            &[MessageAttachmentF1 {
                path: path.display().to_string(),
                name: Some("queue-route.gpx".into()),
            }],
            &config,
            &s3,
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();

        store_queue_media(&txn, message.id, message.id_uuid, &staged_media)
            .await
            .unwrap();

        let media = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId.eq(message.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        let job = signal_message_media_conversion_job::Entity::find()
            .filter(
                signal_message_media_conversion_job::Column::SourceMediaId
                    .eq(media.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.signal_message_id, message.id);
        assert_eq!(job.source_file_name, "queue-route.gpx");
        assert_eq!(job.source_file_md5, format!("{:x}", Md5::digest(payload)));
        assert_eq!(job.status, SIGINT_MEDIA_CONVERSION_STATUS_PENDING);

        txn.commit().await.unwrap();
        staged_media
            .finalize_after_commit(&config, &s3, &env.dbx)
            .await;
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn queue_ingestion_enqueues_stored_audio_before_commit() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        system_settings::ActiveModel {
            enable_audio_transcription: Set(true),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
        let message = crate::functest::tests::mk_signal_message(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("queue-audio.ogg");
        tokio::fs::write(&path, b"queue audio").await.unwrap();
        let mut config = env.config.clone();
        config.feature_delete_uploaded_attachment = Some(true);
        memory_s3_config(&mut config);
        let s3 = Some(Operator::new(Memory::default()).unwrap().finish());
        let staged_media = stage_queue_media(
            &[MessageAttachmentF1 {
                path: path.display().to_string(),
                name: Some("queue-audio.ogg".into()),
            }],
            &config,
            &s3,
        )
        .await
        .unwrap();
        let txn = env.dbx.begin().await.unwrap();

        store_queue_media(&txn, message.id, message.id_uuid, &staged_media)
            .await
            .unwrap();
        let media = signal_message_media::Entity::find()
            .filter(
                signal_message_media::Column::SignalMessageId.eq(message.id),
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();
        assert!(echo_gpu_client::lookup(&txn, media.id)
            .await
            .unwrap()
            .is_some());
        assert!(path.exists());
        txn.commit().await.unwrap();
        staged_media
            .finalize_after_commit(&config, &s3, &env.dbx)
            .await;
        assert!(!path.exists());
        let remote_key =
            crate::storage::S3Config::from(config.s3_config.as_ref().unwrap())
                .prefixed_key(&crate::messenger::media::media_object_key(
                    &media,
                ));
        s3.as_ref().unwrap().stat(&remote_key).await.unwrap();
        assert!(echo_gpu_client::lookup(&env.dbx, media.id)
            .await
            .unwrap()
            .is_some());
    }
}
