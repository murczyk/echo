use super::{
    super::DeviceAudioRuntime, admission::lock_setting, guards::MainGuard,
    query,
};
use super::{RecoveryCommand, RecoveryInspection, RecoveryOutcome};
use crate::file_registry::entities::device_audio_asr_job as job;
use crate::{h, types::ShortContext};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, EntityTrait, IntoActiveModel, QuerySelect, Set,
    TransactionTrait,
};
use uuid::Uuid;

pub(crate) async fn inspect(
    runtime: &DeviceAudioRuntime,
    audio_id: Uuid,
) -> anyhow::Result<RecoveryInspection> {
    let job = job::Entity::find_by_id(audio_id)
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio ASR job missing"))
        .c(h!())?;
    anyhow::ensure!(
        job.state == "outcome_unknown",
        "attempt does not require recovery"
    );
    let (
        Some(attempt_id),
        Some(instance_id),
        Some(remote_audio_id),
        Some(dispatched_at),
    ) = (
        job.attempt_id,
        job.instance_id,
        job.remote_audio_id,
        job.dispatched_at,
    )
    else {
        anyhow::bail!("incomplete ASR recovery metadata");
    };
    Ok(RecoveryInspection {
        audio_id,
        attempt_id,
        instance_id,
        remote_audio_id,
        dispatched_at: dispatched_at.with_timezone(&Utc),
    })
}

pub(crate) async fn recover(
    runtime: &DeviceAudioRuntime,
    command: RecoveryCommand,
) -> anyhow::Result<RecoveryOutcome> {
    anyhow::ensure!(
        !command.verification_note.trim().is_empty()
            && !command.operator.trim().is_empty(),
        "operator verification is required"
    );
    let db = runtime.file_database().c(h!())?;
    let Some(initial) = job::Entity::find_by_id(command.audio_id)
        .one(db)
        .await
        .c(h!())?
    else {
        return Ok(RecoveryOutcome::NotUnknown);
    };
    let main = MainGuard::acquire(runtime, initial.device_id, false)
        .await
        .c(h!())?;
    let files = db.begin().await.c(h!())?;
    let scheduler = query::lock_scheduler(&files).await.c(h!())?;
    lock_setting(&files, initial.device_id).await.c(h!())?;
    let Some(job) = job::Entity::find_by_id(command.audio_id)
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?
    else {
        return Ok(RecoveryOutcome::NotUnknown);
    };
    if job.state != "outcome_unknown" {
        return Ok(RecoveryOutcome::NotUnknown);
    }
    if job.attempt_id != Some(command.expected_attempt_id)
        || scheduler.slot_audio_id != Some(command.audio_id)
        || scheduler.slot_attempt_id != Some(command.expected_attempt_id)
    {
        return Ok(RecoveryOutcome::TokenMismatch);
    }
    super::backfill_recovery::record(&files, &job)
        .await
        .c(h!())?;
    let mut job = job.into_active_model();
    query::clear_attempt(&mut job);
    job.state = Set(if main.active() { "failed" } else { "cancelled" }.into());
    job.error_code = Set(Some("operator_verified".into()));
    job.status_version = Set(Uuid::new_v4());
    job.updated_at = Set(Utc::now().fixed_offset());
    job.next_attempt_at = Set(None);
    job.recovered_attempt_id = Set(Some(command.expected_attempt_id));
    job.recovery_note = Set(Some(command.verification_note));
    job.recovery_verified_by = Set(Some(command.operator));
    job.recovery_verified_at = Set(Some(Utc::now().fixed_offset()));
    job.update(&files).await.c(h!())?;
    query::release(&files, scheduler).await.c(h!())?;
    main.commit_files(files).await.c(h!())?;
    Ok(RecoveryOutcome::Recovered)
}

pub(crate) async fn run(
    mode: crate::types::Mode,
    ps: crate::OneoffRecoverDeviceAudioTranscriptionPs,
) -> Result<(), crate::error::AppError> {
    run_inner(mode, ps).await.c(h!())?;
    Ok(())
}

async fn run_inner(
    mode: crate::types::Mode,
    ps: crate::OneoffRecoverDeviceAudioTranscriptionPs,
) -> anyhow::Result<()> {
    use dialoguer::{theme::ColorfulTheme, Confirm};
    anyhow::ensure!(
        !ps.verification_note.trim().is_empty(),
        "verification note must not be blank"
    );
    let config = crate::config::read_config(mode).c(h!())?;
    let db = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let files = crate::file_registry::connect_runtime(&config, mode)
        .await
        .c(h!())?;
    let runtime =
        super::super::build_runtime(&config, &db, files.as_ref(), None, None);
    let inspection = inspect(&runtime, ps.audio_id).await.c(h!())?;
    anyhow::ensure!(
        inspection.attempt_id == ps.expected_attempt_id,
        "attempt token changed"
    );
    println!(
        "audio={} attempt={} provider={} remote_audio={} dispatched_at={}",
        inspection.audio_id,
        inspection.attempt_id,
        inspection.instance_id,
        inspection.remote_audio_id,
        inspection.dispatched_at
    );
    println!("Verification: {}", ps.verification_note);
    if !ps.yes && !Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt("Have you verified that this ASR attempt is no longer executing on the provider?")
        .default(false).interact().c(h!())? {
        println!("Recovery cancelled.");
        return Ok(());
    }
    let command = RecoveryCommand {
        audio_id: ps.audio_id,
        expected_attempt_id: ps.expected_attempt_id,
        verification_note: ps.verification_note,
        operator: format!("uid:{}", unsafe { libc::geteuid() }),
    };
    match recover(&runtime, command).await.c(h!())? {
        RecoveryOutcome::Recovered => println!("Recovery recorded; the slot is released. No transcription was started."),
        RecoveryOutcome::TokenMismatch => anyhow::bail!("attempt token changed; no recovery applied"),
        RecoveryOutcome::NotUnknown => anyhow::bail!("attempt no longer requires recovery"),
    }
    Ok(())
}
