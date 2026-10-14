use super::super::DeviceAudioRuntime;
use super::guards::MainGuard;
use crate::file_registry::entities::{
    device_audio_asr_job as job, device_audio_asr_setting as setting,
};
use crate::{h, types::ShortContext};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, DatabaseTransaction, EntityTrait,
    QuerySelect, Set,
};
use uuid::Uuid;

pub(super) async fn lock_setting(
    files: &DatabaseTransaction,
    device_id: Uuid,
) -> anyhow::Result<bool> {
    setting::Entity::insert(setting::ActiveModel {
        device_id: Set(device_id),
        enabled: Set(true),
        updated_at: Set(Utc::now().fixed_offset()),
        updated_by_login_id: Set(None),
    })
    .on_conflict(
        OnConflict::column(setting::Column::DeviceId)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(files)
    .await
    .c(h!())?;
    setting::Entity::find_by_id(device_id)
        .select_only()
        .column(setting::Column::Enabled)
        .lock_exclusive()
        .into_tuple::<bool>()
        .one(files)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("audio ASR setting missing"))
        .c(h!())
}

pub(in crate::devices::audio) async fn publication_guard(
    runtime: &DeviceAudioRuntime,
    device_id: Uuid,
) -> Option<MainGuard> {
    match MainGuard::acquire(runtime, device_id, true).await {
        Ok(guard) => Some(guard),
        Err(_) => {
            log::warn!(
                "device ASR policy unavailable; admission will remain pending"
            );
            None
        }
    }
}

pub(in crate::devices::audio) async fn publication_setting(
    files: &DatabaseTransaction,
    device_id: Uuid,
) -> anyhow::Result<bool> {
    lock_setting(files, device_id).await.c(h!())
}

pub(in crate::devices::audio) async fn publish(
    files: &DatabaseTransaction,
    device_id: Uuid,
    audio_id: Uuid,
    enabled: bool,
    guard: Option<&MainGuard>,
) -> anyhow::Result<()> {
    let state = match guard {
        Some(guard) if !guard.active() || !guard.global_enabled || !enabled => {
            "suppressed"
        }
        Some(_) => "queued",
        None if !enabled => "suppressed",
        None => "policy_pending",
    };
    let now = Utc::now().fixed_offset();
    job::ActiveModel {
        audio_id: Set(audio_id),
        device_id: Set(device_id),
        state: Set(state.into()),
        trigger: Set("background".into()),
        priority: Set(1),
        generation: Set(Uuid::new_v4()),
        status_version: Set(Uuid::new_v4()),
        attempt_id: Set(None),
        attempt_count: Set(0),
        created_at: Set(now),
        generation_started_at: Set(now),
        next_attempt_at: Set((state != "suppressed").then_some(now)),
        owner_id: Set(None),
        heartbeat_at: Set(None),
        dispatched_at: Set(None),
        instance_id: Set(None),
        remote_audio_id: Set(None),
        source_sha256: Set(None),
        error_code: Set(None),
        updated_at: Set(now),
        recovered_attempt_id: Set(None),
        recovery_verified_at: Set(None),
        recovery_verified_by: Set(None),
        recovery_note: Set(None),
    }
    .insert(files)
    .await
    .c(h!())?;
    Ok(())
}
