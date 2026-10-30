use super::super::DeviceAudioRuntime;
use crate::entities::{device, system_settings};
use crate::{h, types::ShortContext};
use sea_orm::{
    ColumnTrait, DatabaseTransaction, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
};
use uuid::Uuid;

pub(in crate::devices::audio) struct MainGuard {
    transaction: DatabaseTransaction,
    device_id: Uuid,
    archived: Option<bool>,
    pub global_enabled: bool,
    devices_enabled: bool,
}

impl MainGuard {
    pub fn active(&self) -> bool {
        self.archived == Some(false)
    }

    pub async fn authorize_read(&self, actor_id: Uuid) -> anyhow::Result<bool> {
        let actor = crate::devices::access::resolve_login_by_id(
            &self.transaction,
            &actor_id,
        )
        .await
        .c(h!())?;
        crate::devices::access::require_audio_read(&actor.roles).c(h!())?;
        super::super::query::find_visible_device(
            &self.transaction,
            &actor,
            self.device_id,
        )
        .await
        .c(h!())?;
        Ok(self.active()
            && crate::devices::access::require_audio_edit(&actor.roles).is_ok())
    }

    pub async fn authorize_source(&self, actor_id: Uuid) -> anyhow::Result<()> {
        let actor = crate::devices::access::resolve_login_by_id(
            &self.transaction,
            &actor_id,
        )
        .await
        .c(h!())?;
        crate::devices::access::require_audio_source(&actor.roles).c(h!())?;
        super::super::query::find_visible_device(
            &self.transaction,
            &actor,
            self.device_id,
        )
        .await
        .c(h!())?;
        anyhow::ensure!(
            self.active(),
            crate::error::AppError::Forbidden(
                "archived device cannot be changed".into()
            )
        );
        Ok(())
    }

    pub async fn acquire(
        runtime: &DeviceAudioRuntime,
        device_id: Uuid,
        policy: bool,
    ) -> anyhow::Result<Self> {
        let transaction = runtime.dbx.begin().await.c(h!())?;
        let (global_enabled, devices_enabled) = if policy {
            system_settings::Entity::find()
                .filter(system_settings::Column::Deleted.eq(false))
                .order_by_desc(system_settings::Column::UpdatedAt)
                .select_only()
                .columns([
                    system_settings::Column::EnableAudioTranscription,
                    system_settings::Column::DevicesSectionEnabled,
                ])
                .lock_shared()
                .into_tuple::<(bool, bool)>()
                .one(&transaction)
                .await
                .c(h!())?
                .map(|(transcription, devices)| {
                    (transcription && devices, devices)
                })
                .unwrap_or((false, false))
        } else {
            (false, false)
        };
        let archived = device::Entity::find_by_id(device_id)
            .select_only()
            .column(device::Column::Archived)
            .lock_shared()
            .into_tuple::<bool>()
            .one(&transaction)
            .await
            .c(h!())?;
        Ok(Self {
            transaction,
            device_id,
            archived,
            global_enabled,
            devices_enabled,
        })
    }

    pub async fn forwarding_snapshot(
        &self,
    ) -> anyhow::Result<crate::devices::audio::forwarding::Snapshot> {
        let mut snapshot = crate::devices::audio::forwarding::snapshot(
            &self.transaction,
            self.device_id,
        )
        .await
        .c(h!())?;
        if !self.active() || !self.devices_enabled {
            snapshot.groups.clear();
        }
        Ok(snapshot)
    }

    pub async fn commit_files(
        &self,
        files: DatabaseTransaction,
    ) -> anyhow::Result<()> {
        let current = device::Entity::find_by_id(self.device_id)
            .select_only()
            .column(device::Column::Archived)
            .into_tuple::<bool>()
            .one(&self.transaction)
            .await
            .c(h!())?;
        anyhow::ensure!(current == self.archived, "device guard changed");
        files.commit().await.c(h!())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::audio::acceptance_tests::enabled_audio_device;
    use sea_orm::{ConnectionTrait, DbBackend, Statement};

    #[actix_web::test]
    #[serial_test::serial]
    async fn a_known_lost_main_guard_cannot_commit_files_changes() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let (_, device) = enabled_audio_device(&env).await;
        let guard = MainGuard::acquire(&env.device_audio, device, false)
            .await
            .unwrap();
        let pid: i32 = guard
            .transaction
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "SELECT pg_backend_pid() AS pid",
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        let files = env.device_audio.file_database().unwrap();
        let transaction = files.begin().await.unwrap();
        super::super::admission::lock_setting(&transaction, device)
            .await
            .unwrap();
        env.dbx
            .execute_unprepared(&format!("SELECT pg_terminate_backend({pid})"))
            .await
            .unwrap();
        assert!(guard.commit_files(transaction).await.is_err());
        let setting = crate::file_registry::entities::device_audio_asr_setting::Entity::find_by_id(device).one(files).await.unwrap();
        assert!(
            setting.is_none(),
            "files changes must roll back after known loss of the main guard"
        );
    }
}
