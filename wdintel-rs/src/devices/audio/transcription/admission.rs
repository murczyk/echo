use super::super::DeviceAudioRuntime;
use super::guards::MainGuard;
use crate::file_registry::entities::{
    device_audio as audio, device_audio_asr_setting as setting,
};
use crate::{h, types::ShortContext};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ColumnTrait, DatabaseTransaction, EntityTrait,
    QueryFilter, QuerySelect, Set,
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
) -> anyhow::Result<MainGuard> {
    MainGuard::acquire(runtime, device_id, true).await.c(h!())
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
    let allowed = enabled
        && guard.is_none_or(|guard| guard.active() && guard.global_enabled);
    if allowed {
        audio::Entity::update_many()
            .col_expr(
                audio::Column::AutomaticTranscriptionPending,
                sea_orm::sea_query::Expr::value(0),
            )
            .filter(audio::Column::Id.eq(audio_id))
            .filter(audio::Column::DeviceId.eq(device_id))
            .exec(files)
            .await
            .c(h!())?;
    }
    Ok(())
}
