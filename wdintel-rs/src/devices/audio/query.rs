use super::{
    probe::ProbedAudio, storage::SourceFingerprint, types::*,
    DeviceAudioRuntime,
};
use crate::devices::devices::query::{scoped_devices_query, DeviceReadScope};
use crate::entities::{device, login};
use crate::error::AppError;
use crate::file_registry::entities::{device_audio, device_audio_ingest};
use crate::h;
use crate::types::{ShortContext, Uuid};
use chrono::{SubsecRound, Utc};
use sea_orm::sea_query::{Expr, ExprTrait, LockType, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait,
    FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    Set, TransactionTrait,
};

#[derive(Debug, FromQueryResult)]
pub(super) struct VisibleDevice {
    pub id: Uuid,
    pub archived: bool,
}

#[derive(FromQueryResult)]
pub(super) struct AudioRow {
    pub id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub recording_started_at: chrono::DateTime<chrono::FixedOffset>,
    pub recording_ended_at: chrono::DateTime<chrono::FixedOffset>,
    pub duration_us: i64,
    pub processed: bool,
    pub processing_version: Uuid,
}

impl AudioRow {
    pub fn summary(self) -> DeviceAudio {
        DeviceAudio {
            id: self.id.to_string(),
            device_id: self.device_id.to_string(),
            name: self.name,
            recording_started_at: self
                .recording_started_at
                .with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            recording_ended_at: self
                .recording_ended_at
                .with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            duration_seconds: self.duration_us as f64
                / super::DEVICE_AUDIO_MICROSECONDS_PER_SECOND as f64,
            processed: self.processed,
            processing_version: self.processing_version.to_string(),
        }
    }
}

pub(super) fn page_query(
    command: &ListDeviceAudioCommand,
    boundary: Option<&super::cursor::Boundary>,
) -> sea_orm::Select<device_audio::Entity> {
    use device_audio::Column as C;
    let mut query = device_audio::Entity::find()
        .filter(C::DeviceId.eq(command.device_id))
        .select_only()
        .columns([
            C::Id,
            C::DeviceId,
            C::Name,
            C::RecordingStartedAt,
            C::RecordingEndedAt,
            C::DurationUs,
            C::Processed,
            C::ProcessingVersion,
        ]);
    if command.unprocessed_only {
        query = query.filter(C::Processed.eq(false));
    }
    if let Some(boundary) = boundary {
        query = query.filter(
            Expr::tuple([Expr::col(C::RecordingStartedAt), Expr::col(C::Id)])
                .lt(Expr::tuple([
                    Expr::value(boundary.start.fixed_offset()),
                    Expr::value(boundary.id),
                ])),
        );
    }
    query
        .order_by_desc(C::RecordingStartedAt)
        .order_by_desc(C::Id)
        .limit(u64::from(command.limit) + 1)
}

#[derive(FromQueryResult)]
pub(super) struct AudioDetailRow {
    id: Uuid,
    device_id: Uuid,
    name: String,
    recording_started_at: chrono::DateTime<chrono::FixedOffset>,
    recording_ended_at: chrono::DateTime<chrono::FixedOffset>,
    duration_us: i64,
    processed: bool,
    processing_version: Uuid,
    transcription: String,
    text_version: Uuid,
}

impl AudioDetailRow {
    pub fn details(
        self,
        automatic_transcription: super::types::DeviceAudioAutomaticTranscriptionSnapshot,
        transcription_availability: super::types::DeviceAudioTranscriptionAvailability,
    ) -> DeviceAudioDetails {
        let audio = AudioRow {
            id: self.id,
            device_id: self.device_id,
            name: self.name,
            recording_started_at: self.recording_started_at,
            recording_ended_at: self.recording_ended_at,
            duration_us: self.duration_us,
            processed: self.processed,
            processing_version: self.processing_version,
        }
        .summary();
        DeviceAudioDetails {
            audio,
            transcription: DeviceAudioTranscription {
                text: self.transcription,
                text_version: self.text_version.to_string(),
            },
            can_edit: transcription_availability.can_edit_manual,
            automatic_transcription,
            transcription_availability,
        }
    }
}

pub(super) async fn audio_detail<C: ConnectionTrait>(
    db: &C,
    command: &DeviceAudioDetailCommand,
) -> anyhow::Result<AudioDetailRow> {
    use device_audio::Column as C;
    device_audio::Entity::find_by_id(command.audio_id)
        .filter(C::DeviceId.eq(command.device_id))
        .select_only()
        .columns([
            C::Id,
            C::DeviceId,
            C::Name,
            C::RecordingStartedAt,
            C::RecordingEndedAt,
            C::DurationUs,
            C::Processed,
            C::ProcessingVersion,
            C::Transcription,
            C::TextVersion,
        ])
        .into_model::<AudioDetailRow>()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
}

pub(super) async fn find_visible_device<C: ConnectionTrait>(
    dbx: &C,
    actor: &login::Model,
    device_id: Uuid,
) -> anyhow::Result<VisibleDevice> {
    scoped_devices_query(actor, DeviceReadScope::IncludeArchived)
        .c(h!())?
        .filter(device::Column::Id.eq(device_id))
        .select_only()
        .columns([device::Column::Id, device::Column::Archived])
        .into_model::<VisibleDevice>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
}

#[derive(FromQueryResult)]
pub(super) struct AudioTextRow {
    pub transcription: String,
    pub text_version: Uuid,
}

#[derive(FromQueryResult)]
pub(super) struct AudioProcessingRow {
    pub processed: bool,
    pub processing_version: Uuid,
}

pub(super) async fn locked_processing<C: ConnectionTrait>(
    db: &C,
    command: &SetDeviceAudioProcessingCommand,
) -> anyhow::Result<AudioProcessingRow> {
    use device_audio::Column as C;
    device_audio::Entity::find_by_id(command.audio_id)
        .filter(C::DeviceId.eq(command.device_id))
        .select_only()
        .columns([C::Processed, C::ProcessingVersion])
        .lock(LockType::Update)
        .into_model::<AudioProcessingRow>()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
}

pub(super) async fn update_processing<C: ConnectionTrait>(
    db: &C,
    command: &SetDeviceAudioProcessingCommand,
    version: Uuid,
) -> anyhow::Result<()> {
    use device_audio::Column as C;
    device_audio::Entity::update_many()
        .filter(C::Id.eq(command.audio_id))
        .filter(C::DeviceId.eq(command.device_id))
        .col_expr(C::Processed, Expr::value(command.processed))
        .col_expr(C::ProcessingVersion, Expr::value(version))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn locked_text<C: ConnectionTrait>(
    db: &C,
    command: &SaveDeviceAudioTranscriptionCommand,
) -> anyhow::Result<AudioTextRow> {
    use device_audio::Column as C;
    device_audio::Entity::find_by_id(command.audio_id)
        .filter(C::DeviceId.eq(command.device_id))
        .select_only()
        .columns([C::Transcription, C::TextVersion])
        .lock(LockType::Update)
        .into_model::<AudioTextRow>()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
}

pub(super) async fn update_text<C: ConnectionTrait>(
    db: &C,
    command: &SaveDeviceAudioTranscriptionCommand,
    version: Uuid,
) -> anyhow::Result<()> {
    use device_audio::Column as C;
    device_audio::Entity::update_many()
        .filter(C::Id.eq(command.audio_id))
        .filter(C::DeviceId.eq(command.device_id))
        .col_expr(C::Transcription, Expr::value(command.text.clone()))
        .col_expr(C::TextVersion, Expr::value(version))
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn find_attempt<C: ConnectionTrait>(
    db: &C,
    reference: &str,
) -> anyhow::Result<Option<device_audio_ingest::Model>> {
    device_audio_ingest::Entity::find()
        .filter(device_audio_ingest::Column::TusUploadRef.eq(reference))
        .one(db)
        .await
        .c(h!())
}

pub(super) fn check_attempt(
    attempt: &device_audio_ingest::Model,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<()> {
    if attempt.actor_id != actor || attempt.device_id != command.device_id {
        return Err(AppError::NotFound.into());
    }
    if attempt.name != command.name
        || attempt.recording_started_at != command.recording_started_at
    {
        return Err(conflict(
            "device_audio_upload_metadata_conflict",
            "Метадані цього завантаження вже зафіксовано",
        ));
    }
    Ok(())
}

pub(super) fn conflict(code: &str, message: &str) -> anyhow::Error {
    AppError::ConflictJson { body: serde_json::json!({"message": message, "details": {"code": code}}) }.into()
}

pub(super) fn rejected() -> anyhow::Error {
    conflict(
        "device_audio_upload_rejected",
        "Завантаження відхилено; створіть нове завантаження",
    )
}

pub(super) fn new_attempt(
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
    source: &crate::sigint::file_upload::tus::TusUpload,
) -> device_audio_ingest::ActiveModel {
    let id = Uuid::new_v4();
    let audio_id = Uuid::new_v4();
    let now = Utc::now().trunc_subsecs(6).fixed_offset();
    device_audio_ingest::ActiveModel {
        id: Set(id),
        audio_id: Set(audio_id),
        device_id: Set(command.device_id),
        actor_id: Set(actor),
        tus_upload_ref: Set(command.upload_url.clone()),
        tus_upload_id: Set(source.file_id),
        tus_owner_id: Set(actor),
        name: Set(command.name.clone()),
        name_key: Set(command.name.as_bytes().to_vec()),
        recording_started_at: Set(command.recording_started_at.fixed_offset()),
        created_at: Set(now),
        storage_key: Set(format!(
            "device-audio/{}/{audio_id}/{id}",
            command.device_id
        )),
        status: Set("finalizing".into()),
        lease_token: Set(Uuid::new_v4()),
        heartbeat_at: Set(now),
        source_size_bytes: Set(None),
        source_sha256: Set(None),
        duration_us: Set(None),
        mime_type: Set(None),
        cleanup_token: Set(None),
        next_cleanup_at: Set(None),
        source_consumed_at: Set(None),
        last_error: Set(None),
    }
}

pub(super) async fn reserve_attempt(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
    source: &crate::sigint::file_upload::tus::TusUpload,
) -> anyhow::Result<device_audio_ingest::Model> {
    let db = runtime.file_database().c(h!())?;
    let transaction = db.begin().await.c(h!())?;
    device_audio_ingest::Entity::insert(new_attempt(actor, command, source))
        .on_conflict(
            OnConflict::column(device_audio_ingest::Column::TusUploadRef)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&transaction)
        .await
        .c(h!())?;
    let attempt = device_audio_ingest::Entity::find()
        .filter(
            device_audio_ingest::Column::TusUploadRef.eq(&command.upload_url),
        )
        .lock(LockType::Update)
        .one(&transaction)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio attempt disappeared"))
        .c(h!())?;
    check_attempt(&attempt, actor, command).c(h!())?;
    let attempt = if attempt.status == "finalizing" {
        let now =
            std::cmp::Ord::max(Utc::now().fixed_offset(), attempt.heartbeat_at);
        let mut attempt = attempt.into_active_model();
        attempt.lease_token = Set(Uuid::new_v4());
        attempt.heartbeat_at = Set(now);
        attempt.update(&transaction).await.c(h!())?
    } else {
        attempt
    };
    transaction.commit().await.c(h!())?;
    Ok(attempt)
}

pub(super) async fn heartbeat(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
    lease: Uuid,
) -> anyhow::Result<()> {
    device_audio_ingest::Entity::update_many()
        .col_expr(
            device_audio_ingest::Column::HeartbeatAt,
            Utc::now().fixed_offset().into(),
        )
        .filter(device_audio_ingest::Column::Id.eq(id))
        .filter(device_audio_ingest::Column::LeaseToken.eq(lease))
        .filter(
            device_audio_ingest::Column::Status
                .is_in(["finalizing", "storing"]),
        )
        .exec(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn allow_store(
    runtime: &DeviceAudioRuntime,
    attempt: &device_audio_ingest::Model,
    fingerprint: SourceFingerprint,
    media: &ProbedAudio,
) -> anyhow::Result<()> {
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let current = locked_attempt(&transaction, attempt.id).await.c(h!())?;
    if current.status != "finalizing"
        || current.lease_token != attempt.lease_token
    {
        return Err(rejected());
    }
    let mut current = current.into_active_model();
    current.status = Set("storing".into());
    current.source_size_bytes =
        Set(Some(i64::try_from(fingerprint.size_bytes).c(h!())?));
    current.source_sha256 = Set(Some(fingerprint.sha256.to_vec()));
    current.duration_us = Set(Some(media.duration_us));
    current.mime_type = Set(Some(media.mime_type.into()));
    current.heartbeat_at = Set(Utc::now().fixed_offset());
    current.update(&transaction).await.c(h!())?;
    transaction.commit().await.c(h!())
}

pub(super) async fn locked_attempt<C: ConnectionTrait>(
    db: &C,
    id: Uuid,
) -> anyhow::Result<device_audio_ingest::Model> {
    device_audio_ingest::Entity::find_by_id(id)
        .lock(LockType::Update)
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio attempt is missing"))
        .c(h!())
}

pub(super) async fn own_ready<C: ConnectionTrait>(
    db: &C,
    attempt: &device_audio_ingest::Model,
) -> anyhow::Result<Option<device_audio::Model>> {
    let audio = device_audio::Entity::find_by_id(attempt.audio_id)
        .filter(device_audio::Column::IngestId.eq(attempt.id))
        .filter(device_audio::Column::StorageKey.eq(&attempt.storage_key))
        .one(db)
        .await
        .c(h!())?;
    if (attempt.status == "ready") != audio.is_some() {
        anyhow::bail!("audio ready ledger and publication disagree");
    }
    Ok(audio)
}

pub(super) async fn reconcile_rejection(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
    reject_finalizing: bool,
) -> anyhow::Result<Option<device_audio::Model>> {
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let attempt = locked_attempt(&transaction, id).await.c(h!())?;
    if let Some(audio) = own_ready(&transaction, &attempt).await.c(h!())? {
        return Ok(Some(audio));
    }
    if attempt.status == "storing"
        || (reject_finalizing && attempt.status == "finalizing")
    {
        mark_deleting(&transaction, attempt, "receive rejected")
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    Ok(None)
}

pub(super) async fn mark_deleting<C: ConnectionTrait>(
    db: &C,
    attempt: device_audio_ingest::Model,
    reason: &str,
) -> anyhow::Result<device_audio_ingest::Model> {
    let mut attempt = attempt.into_active_model();
    attempt.status = Set("deleting".into());
    attempt.cleanup_token = Set(Some(Uuid::new_v4()));
    attempt.next_cleanup_at = Set(Some(Utc::now().fixed_offset()));
    attempt.last_error = Set(Some(reason.into()));
    attempt.update(db).await.c(h!())
}

pub(super) async fn publish(
    runtime: &DeviceAudioRuntime,
    attempt: &device_audio_ingest::Model,
    media: &ProbedAudio,
) -> anyhow::Result<ReceiveDeviceAudioOutcome> {
    let policy =
        super::transcription::publication_guard(runtime, attempt.device_id)
            .await;
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let enabled = super::transcription::publication_setting(
        &transaction,
        attempt.device_id,
    )
    .await
    .c(h!())?;
    let current = locked_attempt(&transaction, attempt.id).await.c(h!())?;
    if current.status != "storing" || current.lease_token != attempt.lease_token
    {
        return Err(rejected());
    }
    let audio = ready_audio(&current, media).c(h!())?;
    let inserted = device_audio::Entity::insert(audio)
        .on_conflict(
            OnConflict::columns([
                device_audio::Column::DeviceId,
                device_audio::Column::NameKey,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(&transaction)
        .await
        .c(h!())?;
    let outcome = if inserted == 0 {
        mark_deleting(&transaction, current, "duplicate name")
            .await
            .c(h!())?;
        ReceiveDeviceAudioOutcome::Duplicate
    } else {
        let mut current = current.into_active_model();
        current.status = Set("ready".into());
        let current = current.update(&transaction).await.c(h!())?;
        let audio = own_ready(&transaction, &current)
            .await
            .c(h!())?
            .ok_or_else(|| anyhow::anyhow!("published audio is missing"))
            .c(h!())?;
        super::transcription::publish(
            &transaction,
            audio.device_id,
            audio.id,
            enabled,
            policy.as_ref(),
        )
        .await
        .c(h!())?;
        accepted(&audio)
    };
    if let Some(policy) = policy {
        policy.commit_files(transaction).await.c(h!())?;
    } else {
        transaction.commit().await.c(h!())?;
    }
    Ok(outcome)
}

fn ready_audio(
    attempt: &device_audio_ingest::Model,
    media: &ProbedAudio,
) -> anyhow::Result<device_audio::ActiveModel> {
    Ok(device_audio::ActiveModel {
        id: Set(attempt.audio_id),
        device_id: Set(attempt.device_id),
        ingest_id: Set(attempt.id),
        name: Set(attempt.name.clone()),
        name_key: Set(attempt.name_key.clone()),
        recording_started_at: Set(attempt.recording_started_at),
        duration_us: Set(media.duration_us),
        recording_ended_at: Set(media.recording_ended_at.fixed_offset()),
        created_at: Set(Utc::now().fixed_offset()),
        mime_type: Set(media.mime_type.into()),
        source_size_bytes: Set(attempt
            .source_size_bytes
            .ok_or_else(|| anyhow::anyhow!("missing source size"))
            .c(h!())?),
        source_sha256: Set(attempt
            .source_sha256
            .clone()
            .ok_or_else(|| anyhow::anyhow!("missing source digest"))
            .c(h!())?),
        storage_key: Set(attempt.storage_key.clone()),
        transcription: Set(String::new()),
        text_version: Set(Uuid::new_v4()),
        processed: Set(false),
        processing_version: Set(Uuid::new_v4()),
        automatic_transcription: Set(None),
        automatic_transcribed_at: Set(None),
    })
}

pub(super) fn accepted(
    audio: &device_audio::Model,
) -> ReceiveDeviceAudioOutcome {
    ReceiveDeviceAudioOutcome::Accepted(ReceiveDeviceAudioRsp {
        audio: audio_summary(audio),
    })
}

pub(super) fn audio_summary(audio: &device_audio::Model) -> DeviceAudio {
    DeviceAudio {
        id: audio.id.to_string(),
        device_id: audio.device_id.to_string(),
        name: audio.name.clone(),
        recording_started_at: audio
            .recording_started_at
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        recording_ended_at: audio
            .recording_ended_at
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        duration_seconds: audio.duration_us as f64
            / super::DEVICE_AUDIO_MICROSECONDS_PER_SECOND as f64,
        processed: audio.processed,
        processing_version: audio.processing_version.to_string(),
    }
}

pub(super) async fn record_consumed(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
) -> anyhow::Result<()> {
    device_audio_ingest::Entity::update_many()
        .col_expr(
            device_audio_ingest::Column::SourceConsumedAt,
            Utc::now().fixed_offset().into(),
        )
        .filter(device_audio_ingest::Column::Id.eq(id))
        .filter(
            device_audio_ingest::Column::Status.is_in(["ready", "deleting"]),
        )
        .filter(device_audio_ingest::Column::SourceConsumedAt.is_null())
        .exec(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn confirmed_terminal(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
) -> anyhow::Result<bool> {
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let attempt = locked_attempt(&transaction, id).await.c(h!())?;
    own_ready(&transaction, &attempt).await.c(h!())?;
    let terminal = matches!(attempt.status.as_str(), "ready" | "deleting");
    transaction.commit().await.c(h!())?;
    Ok(terminal)
}
