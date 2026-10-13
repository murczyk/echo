use super::{
    super::{bl, types::DeviceAudioAsrSettingsRsp, DeviceAudioRuntime},
    admission::lock_setting,
    guards::MainGuard,
    SetSettingsCommand, SettingsCommand,
};
use crate::file_registry::entities::device_audio_asr_setting as setting;
use crate::{error::AppError, h, types::ShortContext};
use sea_orm::{
    ActiveModelTrait, EntityTrait, QuerySelect, Set, TransactionTrait,
};

pub(crate) async fn settings(
    runtime: &DeviceAudioRuntime,
    command: SettingsCommand,
) -> anyhow::Result<DeviceAudioAsrSettingsRsp> {
    bl::authorize(
        runtime,
        command.actor_id,
        command.device_id,
        bl::AudioAccess::Read,
    )
    .await
    .c(h!())?;
    let main = MainGuard::acquire(runtime, command.device_id, true)
        .await
        .c(h!())?;
    let enabled = setting::Entity::find_by_id(command.device_id)
        .select_only()
        .column(setting::Column::Enabled)
        .into_tuple::<bool>()
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .unwrap_or(true);
    let editable = main.authorize_read(command.actor_id).await.c(h!())?;
    Ok(response(command, enabled, &main, editable))
}

pub(crate) async fn set_settings(
    runtime: &DeviceAudioRuntime,
    command: SetSettingsCommand,
) -> anyhow::Result<DeviceAudioAsrSettingsRsp> {
    let scope = command.scope;
    bl::authorize(
        runtime,
        scope.actor_id,
        scope.device_id,
        bl::AudioAccess::Edit,
    )
    .await
    .c(h!())?;
    let main = MainGuard::acquire(runtime, scope.device_id, true)
        .await
        .c(h!())?;
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let current = lock_setting(&files, scope.device_id).await.c(h!())?;
    let editable = main.authorize_read(scope.actor_id).await.c(h!())?;
    if !editable {
        return Err(AppError::Forbidden(
            "audio settings cannot be changed".into(),
        )
        .into());
    }
    if current != command.enabled {
        setting::ActiveModel {
            device_id: Set(scope.device_id),
            enabled: Set(command.enabled),
            updated_at: Set(chrono::Utc::now().fixed_offset()),
            updated_by_login_id: Set(Some(scope.actor_id)),
        }
        .update(&files)
        .await
        .c(h!())?;
    }
    main.commit_files(files).await.c(h!())?;
    Ok(response(scope, command.enabled, &main, editable))
}

fn response(
    scope: SettingsCommand,
    enabled: bool,
    main: &MainGuard,
    editable: bool,
) -> DeviceAudioAsrSettingsRsp {
    let reason = if !main.active() {
        Some("Пристрій архівовано")
    } else if !editable {
        Some("Недостатньо прав для зміни налаштування")
    } else if !main.global_enabled {
        Some("Сервіс транскрибації вимкнено")
    } else {
        None
    };
    DeviceAudioAsrSettingsRsp {
        device_id: scope.device_id.to_string(),
        enabled,
        global_enabled: main.global_enabled,
        can_manage_setting: editable,
        blocked_reason: reason.map(str::to_owned),
    }
}
