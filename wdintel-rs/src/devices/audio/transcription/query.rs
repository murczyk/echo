use super::super::DeviceAudioRuntime;
use super::admission::lock_setting;
use super::guards::MainGuard;
use super::{AttemptToken, AudioTarget, Claim, SourceFingerprint};
use crate::devices::config::*;
use crate::file_registry::entities::{
    device_audio as audio, device_audio_asr_job as job,
    device_audio_asr_scheduler as scheduler,
    device_audio_asr_setting as setting,
};
use crate::{h, types::ShortContext};
use chrono::Utc;
use sea_orm::{
    sea_query::{Expr, ExprTrait},
    ActiveModelTrait, ColumnTrait, Condition, DatabaseTransaction, EntityTrait,
    FromQueryResult, IntoActiveModel, JoinType, QueryFilter, QueryOrder,
    QuerySelect, Set, TransactionTrait,
};
use uuid::Uuid;

#[derive(FromQueryResult)]
pub(super) struct Source {
    pub id: Uuid,
    pub device_id: Uuid,
    pub ingest_id: Uuid,
    pub source_size_bytes: i64,
    pub source_sha256: Vec<u8>,
    pub storage_key: String,
    pub mime_type: String,
    pub has_automatic: bool,
}

pub(super) async fn source<C: sea_orm::ConnectionTrait>(
    db: &C,
    target: AudioTarget,
    lock: bool,
) -> anyhow::Result<Option<Source>> {
    use audio::Column as A;
    let mut select = audio::Entity::find_by_id(target.audio_id)
        .filter(A::DeviceId.eq(target.device_id))
        .select_only()
        .columns([
            A::Id,
            A::DeviceId,
            A::IngestId,
            A::SourceSizeBytes,
            A::SourceSha256,
            A::StorageKey,
            A::MimeType,
        ])
        .column_as(
            Expr::col(A::AutomaticTranscription).is_not_null(),
            "has_automatic",
        );
    if lock {
        select = select.lock_exclusive();
    }
    select.into_model::<Source>().one(db).await.c(h!())
}

pub(super) fn matches_source(source: &Source, claim: &Claim) -> bool {
    source.id == claim.target.audio_id
        && source.device_id == claim.target.device_id
        && source.ingest_id == claim.source.ingest_id
        && source.source_size_bytes == claim.source.size_bytes
        && source.source_sha256.as_slice() == claim.source.sha256
}

pub(super) async fn lock_scheduler(
    files: &DatabaseTransaction,
) -> anyhow::Result<scheduler::Model> {
    scheduler::Entity::find_by_id(1_i16)
        .lock_exclusive()
        .one(files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio ASR scheduler missing"))
        .c(h!())
}

fn cycle_length() -> u32 {
    DEVICE_AUDIO_ASR_INTERACTIVE_WEIGHT
        + DEVICE_AUDIO_ASR_BACKGROUND_WEIGHT
        + DEVICE_AUDIO_ASR_BACKFILL_WEIGHT
}

fn priority(turn: u32) -> i16 {
    if turn < DEVICE_AUDIO_ASR_INTERACTIVE_WEIGHT {
        0
    } else if turn
        < DEVICE_AUDIO_ASR_INTERACTIVE_WEIGHT
            + DEVICE_AUDIO_ASR_BACKGROUND_WEIGHT
    {
        1
    } else {
        2
    }
}

async fn candidates(
    runtime: &DeviceAudioRuntime,
    priority: i16,
) -> anyhow::Result<Vec<(Uuid, Uuid)>> {
    use job::Column as J;
    use setting::Column as S;
    job::Entity::find()
        .join(
            JoinType::LeftJoin,
            job::Entity::belongs_to(setting::Entity)
                .from(J::DeviceId)
                .to(S::DeviceId)
                .into(),
        )
        .select_only()
        .columns([J::AudioId, J::DeviceId])
        .filter(J::Priority.eq(priority))
        .filter(J::State.is_in(["queued", "retry_wait", "policy_pending"]))
        .filter(J::NextAttemptAt.lte(Utc::now().fixed_offset()))
        .filter(
            Condition::any()
                .add(J::State.eq("policy_pending"))
                .add(S::DeviceId.is_null())
                .add(S::Enabled.eq(true)),
        )
        .order_by_asc(J::NextAttemptAt)
        .order_by_asc(J::AudioId)
        .limit(DEVICE_AUDIO_ASR_CLAIM_SCAN_SIZE)
        .into_tuple::<(Uuid, Uuid)>()
        .all(runtime.file_database().c(h!())?)
        .await
        .c(h!())
}

pub(super) async fn claim(
    runtime: &DeviceAudioRuntime,
    owner: Uuid,
) -> anyhow::Result<Option<Claim>> {
    let scheduler = scheduler::Entity::find_by_id(1_i16)
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio ASR scheduler missing"))
        .c(h!())?;
    if scheduler.slot_audio_id.is_some() {
        return Ok(None);
    }
    let mut visited = [false; 3];
    for offset in 0..cycle_length() {
        let turn = (scheduler.turn as u32 + offset) % cycle_length();
        let priority = priority(turn);
        if visited[priority as usize] {
            continue;
        }
        visited[priority as usize] = true;
        for (audio_id, device_id) in
            candidates(runtime, priority).await.c(h!())?
        {
            if let Some(claim) = claim_candidate(
                runtime,
                AudioTarget {
                    audio_id,
                    device_id,
                },
                owner,
                scheduler.turn,
                turn,
            )
            .await
            .c(h!())?
            {
                return Ok(Some(claim));
            }
        }
    }
    Ok(None)
}

async fn claim_candidate(
    runtime: &DeviceAudioRuntime,
    target: AudioTarget,
    owner: Uuid,
    expected_turn: i16,
    chosen_turn: u32,
) -> anyhow::Result<Option<Claim>> {
    let main = MainGuard::acquire(runtime, target.device_id, true)
        .await
        .c(h!())?;
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let scheduler = lock_scheduler(&files).await.c(h!())?;
    if scheduler.slot_audio_id.is_some() || scheduler.turn != expected_turn {
        return Ok(None);
    }
    let enabled = lock_setting(&files, target.device_id).await.c(h!())?;
    let Some(source) = source(&files, target, true).await.c(h!())? else {
        return Ok(None);
    };
    let Some(job) = job::Entity::find_by_id(target.audio_id)
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    if !matches!(
        job.state.as_str(),
        "queued" | "retry_wait" | "policy_pending"
    ) || job.next_attempt_at.is_none_or(|at| at > Utc::now())
    {
        return Ok(None);
    }
    if !main.active() || source.has_automatic {
        set_state(
            &files,
            job,
            if source.has_automatic {
                "succeeded"
            } else {
                "cancelled"
            },
            None,
        )
        .await
        .c(h!())?;
        main.commit_files(files).await.c(h!())?;
        return Ok(None);
    }
    if !enabled || !main.global_enabled {
        if job.state == "policy_pending" {
            set_state(&files, job, "suppressed", None).await.c(h!())?;
            main.commit_files(files).await.c(h!())?;
        }
        return Ok(None);
    }
    if exhausted(&job) {
        set_state(&files, job, "failed", Some("retry_exhausted"))
            .await
            .c(h!())?;
        main.commit_files(files).await.c(h!())?;
        return Ok(None);
    }
    let claim = reserve(&files, job, scheduler, source, owner, chosen_turn)
        .await
        .c(h!())?;
    main.commit_files(files).await.c(h!())?;
    Ok(Some(claim))
}

async fn reserve(
    files: &DatabaseTransaction,
    job: job::Model,
    scheduler: scheduler::Model,
    source: Source,
    owner: Uuid,
    turn: u32,
) -> anyhow::Result<Claim> {
    let claim = Claim {
        target: AudioTarget {
            device_id: source.device_id,
            audio_id: source.id,
        },
        token: AttemptToken {
            generation: job.generation,
            attempt_id: Uuid::new_v4(),
            owner_id: owner,
        },
        source: SourceFingerprint {
            ingest_id: source.ingest_id,
            size_bytes: source.source_size_bytes,
            sha256: source
                .source_sha256
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid source digest"))
                .c(h!())?,
        },
    };
    let count = job.attempt_count + 1;
    let mut job = job.into_active_model();
    clear_attempt(&mut job);
    job.state = Set("preparing".into());
    job.attempt_id = Set(Some(claim.token.attempt_id));
    job.owner_id = Set(Some(owner));
    job.heartbeat_at = Set(Some(Utc::now().fixed_offset()));
    job.attempt_count = Set(count);
    job.status_version = Set(Uuid::new_v4());
    job.updated_at = Set(Utc::now().fixed_offset());
    job.error_code = Set(None);
    job.next_attempt_at = Set(None);
    job.update(files).await.c(h!())?;
    let mut scheduler = scheduler.into_active_model();
    scheduler.slot_audio_id = Set(Some(claim.target.audio_id));
    scheduler.slot_attempt_id = Set(Some(claim.token.attempt_id));
    scheduler.turn = Set(((turn + 1) % cycle_length()) as i16);
    scheduler.update(files).await.c(h!())?;
    Ok(claim)
}

pub(super) struct LockedAttempt {
    pub main: MainGuard,
    pub files: DatabaseTransaction,
    pub scheduler: scheduler::Model,
    pub job: job::Model,
    pub source: Source,
    pub enabled: bool,
}

pub(super) async fn locked_attempt(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
    policy: bool,
) -> anyhow::Result<Option<LockedAttempt>> {
    let main = MainGuard::acquire(runtime, claim.target.device_id, policy)
        .await
        .c(h!())?;
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let scheduler = lock_scheduler(&files).await.c(h!())?;
    if scheduler.slot_audio_id != Some(claim.target.audio_id)
        || scheduler.slot_attempt_id != Some(claim.token.attempt_id)
    {
        return Ok(None);
    }
    let enabled = lock_setting(&files, claim.target.device_id).await.c(h!())?;
    let Some(source) = source(&files, claim.target, true).await.c(h!())? else {
        return Ok(None);
    };
    let Some(job) = job::Entity::find_by_id(claim.target.audio_id)
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?
    else {
        return Ok(None);
    };
    if job.generation != claim.token.generation
        || job.attempt_id != Some(claim.token.attempt_id)
        || job.owner_id != Some(claim.token.owner_id)
        || !matches_source(&source, claim)
    {
        return Ok(None);
    }
    Ok(Some(LockedAttempt {
        main,
        files,
        scheduler,
        job,
        source,
        enabled,
    }))
}

pub(super) async fn dispatch(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
    instance: Uuid,
    remote_audio: Uuid,
) -> anyhow::Result<bool> {
    let Some(locked) = locked_attempt(runtime, claim, true).await.c(h!())?
    else {
        return Ok(false);
    };
    if locked.job.state != "preparing" {
        return Ok(false);
    }
    if !locked.main.active()
        || locked.source.has_automatic
        || !locked.enabled
        || !locked.main.global_enabled
    {
        let state = if !locked.main.active() {
            "cancelled"
        } else if locked.source.has_automatic {
            "succeeded"
        } else {
            "queued"
        };
        release(&locked.files, locked.scheduler).await.c(h!())?;
        set_state(&locked.files, locked.job, state, None)
            .await
            .c(h!())?;
        locked.main.commit_files(locked.files).await.c(h!())?;
        return Ok(false);
    }
    let now = Utc::now().fixed_offset();
    let mut job = locked.job.into_active_model();
    job.state = Set("running".into());
    job.dispatched_at = Set(Some(now));
    job.heartbeat_at = Set(Some(now));
    job.instance_id = Set(Some(instance));
    job.remote_audio_id = Set(Some(remote_audio));
    job.source_sha256 = Set(Some(claim.source.sha256.to_vec()));
    job.status_version = Set(Uuid::new_v4());
    job.updated_at = Set(now);
    job.update(&locked.files).await.c(h!())?;
    locked.main.commit_files(locked.files).await.c(h!())?;
    Ok(true)
}

pub(super) async fn complete(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
    text: &str,
) -> anyhow::Result<bool> {
    let Some(locked) = locked_attempt(runtime, claim, false).await.c(h!())?
    else {
        return Ok(false);
    };
    if !matches!(locked.job.state.as_str(), "running" | "outcome_unknown")
        || locked.source.has_automatic
    {
        return Ok(false);
    }
    let state = if !locked.main.active() {
        "cancelled"
    } else if text.trim().is_empty() {
        "no_speech"
    } else {
        "succeeded"
    };
    super::backfill_recovery::resolved(&locked.files, &locked.job, state, None)
        .await
        .c(h!())?;
    if state == "succeeded" {
        let updated = audio::Entity::update_many()
            .col_expr(
                audio::Column::AutomaticTranscription,
                Expr::value(text.to_owned()),
            )
            .col_expr(
                audio::Column::AutomaticTranscribedAt,
                Expr::value(Utc::now().naive_utc()),
            )
            .filter(audio::Column::Id.eq(claim.target.audio_id))
            .filter(audio::Column::AutomaticTranscription.is_null())
            .exec(&locked.files)
            .await
            .c(h!())?;
        anyhow::ensure!(
            updated.rows_affected == 1,
            "automatic transcription publication was fenced"
        );
    }
    release(&locked.files, locked.scheduler).await.c(h!())?;
    set_state(&locked.files, locked.job, state, None)
        .await
        .c(h!())?;
    locked.main.commit_files(locked.files).await.c(h!())?;
    Ok(true)
}

pub(super) async fn release(
    files: &DatabaseTransaction,
    scheduler: scheduler::Model,
) -> anyhow::Result<()> {
    let mut scheduler = scheduler.into_active_model();
    scheduler.slot_audio_id = Set(None);
    scheduler.slot_attempt_id = Set(None);
    scheduler.update(files).await.c(h!())?;
    Ok(())
}

pub(super) fn clear_attempt(job: &mut job::ActiveModel) {
    job.attempt_id = Set(None);
    job.owner_id = Set(None);
    job.heartbeat_at = Set(None);
    job.dispatched_at = Set(None);
    job.instance_id = Set(None);
    job.remote_audio_id = Set(None);
    job.source_sha256 = Set(None);
}

pub(super) async fn set_state(
    files: &DatabaseTransaction,
    job: job::Model,
    state: &str,
    error: Option<&str>,
) -> anyhow::Result<()> {
    let mut job = job.into_active_model();
    clear_attempt(&mut job);
    job.state = Set(state.into());
    job.status_version = Set(Uuid::new_v4());
    job.updated_at = Set(Utc::now().fixed_offset());
    job.error_code = Set(error.map(str::to_owned));
    job.next_attempt_at =
        Set((state == "queued").then(|| Utc::now().fixed_offset()));
    job.update(files).await.c(h!())?;
    Ok(())
}

pub(super) fn exhausted(job: &job::Model) -> bool {
    job.attempt_count >= DEVICE_AUDIO_ASR_MAX_ATTEMPTS
        || (Utc::now() - job.generation_started_at.with_timezone(&Utc))
            .num_seconds()
            >= DEVICE_AUDIO_ASR_MAX_TOTAL_AGE_SECS
}

pub(super) async fn defer_provider(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
) -> anyhow::Result<()> {
    let Some(locked) = locked_attempt(runtime, claim, false).await.c(h!())?
    else {
        return Ok(());
    };
    if locked.job.state != "preparing" {
        return Ok(());
    }
    finish_safe_failure(locked, "provider_unavailable", true, None)
        .await
        .c(h!())
}

pub(super) async fn fail(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
    failure: super::Failure,
) -> anyhow::Result<()> {
    let Some(locked) = locked_attempt(runtime, claim, false).await.c(h!())?
    else {
        return Ok(());
    };
    fail_locked(locked, failure).await.c(h!())
}

async fn fail_locked(
    locked: LockedAttempt,
    failure: super::Failure,
) -> anyhow::Result<()> {
    if !matches!(
        locked.job.state.as_str(),
        "preparing" | "running" | "outcome_unknown"
    ) {
        return Ok(());
    }
    match failure {
        super::Failure::Unknown => {
            if locked.job.state == "outcome_unknown" {
                return Ok(());
            }
            anyhow::ensure!(
                locked.job.state == "running",
                "unknown before dispatch"
            );
            let mut job = locked.job.into_active_model();
            job.state = Set("outcome_unknown".into());
            job.error_code = Set(Some("recovery_required".into()));
            job.status_version = Set(Uuid::new_v4());
            job.updated_at = Set(Utc::now().fixed_offset());
            job.update(&locked.files).await.c(h!())?;
        }
        super::Failure::Safe(reason) => {
            return finish_safe_failure(locked, reason, false, None)
                .await
                .c(h!());
        }
        super::Failure::Overloaded { retry_after_secs } => {
            return finish_safe_failure(
                locked,
                "provider_overloaded",
                false,
                retry_after_secs,
            )
            .await
            .c(h!());
        }
    }
    locked.main.commit_files(locked.files).await.c(h!())
}

async fn finish_safe_failure(
    mut locked: LockedAttempt,
    reason: &str,
    refund: bool,
    retry_after_secs: Option<u64>,
) -> anyhow::Result<()> {
    if refund {
        locked.job.attempt_count = locked.job.attempt_count.saturating_sub(1);
    }
    let count = locked.job.attempt_count;
    let state = if !locked.main.active() {
        "cancelled"
    } else if exhausted(&locked.job) {
        "failed"
    } else {
        "retry_wait"
    };
    super::backfill_recovery::resolved(
        &locked.files,
        &locked.job,
        state,
        Some(reason),
    )
    .await
    .c(h!())?;
    let delay = if refund {
        DEVICE_AUDIO_ASR_RETRY_BASE_SECS
    } else {
        std::cmp::min(
            DEVICE_AUDIO_ASR_RETRY_BASE_SECS
                .saturating_mul(1_u64 << (count - 1).clamp(0, 30)),
            DEVICE_AUDIO_ASR_RETRY_MAX_SECS,
        )
    };
    let delay = std::cmp::min(
        retry_after_secs.unwrap_or(delay),
        DEVICE_AUDIO_ASR_RETRY_MAX_SECS,
    );
    let mut job = locked.job.into_active_model();
    clear_attempt(&mut job);
    job.attempt_count = Set(count);
    job.state = Set(state.into());
    job.error_code = Set(Some(reason.into()));
    job.next_attempt_at = Set((state == "retry_wait").then(|| {
        (Utc::now() + chrono::Duration::seconds(delay as i64)).fixed_offset()
    }));
    job.status_version = Set(Uuid::new_v4());
    job.updated_at = Set(Utc::now().fixed_offset());
    release(&locked.files, locked.scheduler).await.c(h!())?;
    job.update(&locked.files).await.c(h!())?;
    locked.main.commit_files(locked.files).await.c(h!())
}

pub(super) async fn recover_stale(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    recover_slot(runtime, None).await.c(h!())
}

pub(super) async fn abandon_owner(
    runtime: &DeviceAudioRuntime,
    owner: Uuid,
) -> anyhow::Result<()> {
    recover_slot(runtime, Some(owner)).await.c(h!())
}

async fn recover_slot(
    runtime: &DeviceAudioRuntime,
    stopped_owner: Option<Uuid>,
) -> anyhow::Result<()> {
    let db = runtime.file_database().c(h!())?;
    let Some(slot) =
        scheduler::Entity::find_by_id(1_i16).one(db).await.c(h!())?
    else {
        return Ok(());
    };
    let Some(id) = slot.slot_audio_id else {
        return Ok(());
    };
    let Some(job) = job::Entity::find_by_id(id).one(db).await.c(h!())? else {
        return Ok(());
    };
    if !stale(&job)
        && (stopped_owner.is_none() || job.owner_id != stopped_owner)
    {
        return Ok(());
    }
    let target = AudioTarget {
        audio_id: id,
        device_id: job.device_id,
    };
    let Some(source) = source(db, target, false).await.c(h!())? else {
        return Ok(());
    };
    let (Some(attempt_id), Some(owner_id)) = (job.attempt_id, job.owner_id)
    else {
        return Ok(());
    };
    let claim = Claim {
        target,
        token: AttemptToken {
            generation: job.generation,
            attempt_id,
            owner_id,
        },
        source: SourceFingerprint {
            ingest_id: source.ingest_id,
            size_bytes: source.source_size_bytes,
            sha256: source
                .source_sha256
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid source digest"))
                .c(h!())?,
        },
    };
    let Some(locked) = locked_attempt(runtime, &claim, false).await.c(h!())?
    else {
        return Ok(());
    };
    if stale(&locked.job)
        || (stopped_owner.is_some() && locked.job.owner_id == stopped_owner)
    {
        let failure = if locked.job.state == "preparing" {
            super::Failure::Safe("preparation_interrupted")
        } else {
            super::Failure::Unknown
        };
        fail_locked(locked, failure).await.c(h!())?;
    }
    Ok(())
}

fn stale(job: &job::Model) -> bool {
    matches!(job.state.as_str(), "preparing" | "running")
        && job.heartbeat_at.is_some_and(|heartbeat| {
            (Utc::now() - heartbeat.with_timezone(&Utc)).num_seconds()
                >= DEVICE_AUDIO_ASR_STALE_SECS
        })
}

pub(super) async fn heartbeat(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
) -> anyhow::Result<()> {
    job::Entity::update_many()
        .col_expr(
            job::Column::HeartbeatAt,
            Expr::value(Utc::now().fixed_offset()),
        )
        .filter(job::Column::AudioId.eq(claim.target.audio_id))
        .filter(job::Column::Generation.eq(claim.token.generation))
        .filter(job::Column::AttemptId.eq(claim.token.attempt_id))
        .filter(job::Column::OwnerId.eq(claim.token.owner_id))
        .filter(job::Column::State.is_in(["preparing", "running"]))
        .exec(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    Ok(())
}

pub(super) async fn has_due_work(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<bool> {
    let db = runtime.file_database().c(h!())?;
    if scheduler::Entity::find_by_id(1_i16)
        .one(db)
        .await
        .c(h!())?
        .is_some_and(|slot| slot.slot_audio_id.is_some())
    {
        return Ok(false);
    }
    for priority in 0..3 {
        if !candidates(runtime, priority).await.c(h!())?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn resolve_pending(
    runtime: &DeviceAudioRuntime,
) -> anyhow::Result<()> {
    let db = runtime.file_database().c(h!())?;
    let pending = job::Entity::find()
        .select_only()
        .columns([job::Column::AudioId, job::Column::DeviceId])
        .filter(job::Column::State.eq("policy_pending"))
        .order_by_asc(job::Column::AudioId)
        .limit(DEVICE_AUDIO_ASR_CLAIM_SCAN_SIZE)
        .into_tuple::<(Uuid, Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    for (audio_id, device_id) in pending {
        let main =
            MainGuard::acquire(runtime, device_id, true).await.c(h!())?;
        let files = db.begin().await.c(h!())?;
        let enabled = lock_setting(&files, device_id).await.c(h!())?;
        let Some(job) = job::Entity::find_by_id(audio_id)
            .lock_exclusive()
            .one(&files)
            .await
            .c(h!())?
        else {
            continue;
        };
        if job.state != "policy_pending" {
            continue;
        }
        let state = if !main.active() {
            "cancelled"
        } else if enabled && main.global_enabled {
            "queued"
        } else {
            "suppressed"
        };
        set_state(&files, job, state, None).await.c(h!())?;
        main.commit_files(files).await.c(h!())?;
    }
    Ok(())
}
