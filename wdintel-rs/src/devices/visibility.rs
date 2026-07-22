use super::access::DeviceActor;
use super::main_db::MainDb;
use crate::entities::device;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, QueryFilter, QuerySelect, Select,
};
use std::collections::BTreeMap;
use uuid::Uuid;

#[allow(dead_code)]
pub(in crate::devices) enum DeviceReadScope {
    ActiveOnly,
    IncludeArchived,
}

#[allow(dead_code)]
pub(in crate::devices) enum FileRegistryDeviceAccess {
    Read,
    SourceWrite,
}

#[allow(dead_code)]
pub(in crate::devices) struct DeviceVisibility;

impl DeviceVisibility {
    #[allow(dead_code)]
    pub(in crate::devices) fn query(
        actor: &DeviceActor,
        scope: DeviceReadScope,
    ) -> Result<Select<device::Entity>, AppError> {
        actor.require_read()?;

        let query = device::Entity::find();
        match scope {
            DeviceReadScope::ActiveOnly => {
                Ok(query.filter(device::Column::Archived.eq(false)))
            }
            DeviceReadScope::IncludeArchived => Ok(query),
        }
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn find_for_read<C>(
        main_db: &MainDb<'_, C>,
        actor: &DeviceActor,
        device_id: Uuid,
        scope: DeviceReadScope,
    ) -> Result<device::Model, AppError>
    where
        C: ConnectionTrait,
    {
        Self::query(actor, scope)?
            .filter(device::Column::Id.eq(device_id))
            .one(main_db.connection())
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn find_active_for_write<C>(
        main_db: &MainDb<'_, C>,
        actor: &DeviceActor,
        device_id: Uuid,
    ) -> Result<device::Model, AppError>
    where
        C: ConnectionTrait,
    {
        let device = Self::find_for_read(
            main_db,
            actor,
            device_id,
            DeviceReadScope::IncludeArchived,
        )
        .await?;
        if device.archived {
            return Err(archived_device_error());
        }
        Ok(device)
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn find_active_for_update(
        main_db: &MainDb<'_, DatabaseTransaction>,
        actor: &DeviceActor,
        device_id: Uuid,
    ) -> Result<device::Model, AppError> {
        let device = Self::query(actor, DeviceReadScope::IncludeArchived)?
            .filter(device::Column::Id.eq(device_id))
            .lock_exclusive()
            .one(main_db.connection())
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)?;
        if device.archived {
            return Err(archived_device_error());
        }
        Ok(device)
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn verify_file_registry_access(
        main_db: MainDb<'_, DatabaseConnection>,
        actor: &DeviceActor,
        device_id: Uuid,
        access: FileRegistryDeviceAccess,
    ) -> Result<Uuid, AppError> {
        match access {
            FileRegistryDeviceAccess::Read => {
                Self::find_for_read(
                    &main_db,
                    actor,
                    device_id,
                    DeviceReadScope::IncludeArchived,
                )
                .await?;
            }
            FileRegistryDeviceAccess::SourceWrite => {
                actor.require_source_write()?;
                Self::find_active_for_write(&main_db, actor, device_id).await?;
            }
        }

        Ok(device_id)
    }
}

fn archived_device_error() -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        "device_id".to_string(),
        "Архівований пристрій не можна редагувати".to_string(),
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE};
    use crate::devices::filesystem::FilesystemRepository;
    use crate::devices::schema_tests::device_active_model;
    use crate::entities::{login, system_settings};
    use crate::functest::tests::{cleanup_locked, mk_login};
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, DatabaseConnection,
        TransactionTrait,
    };
    use serde_json::json;
    use std::time::Duration;
    use tokio::time::timeout;
    use uuid::Uuid;

    async fn enable_devices_section(dbx: &DatabaseConnection) {
        system_settings::ActiveModel {
            devices_section_enabled: Set(true),
            ..Default::default()
        }
        .insert(dbx)
        .await
        .unwrap();
    }

    fn actor(login: &str, roles: &[&str]) -> DeviceActor {
        DeviceActor::from_roles_for_test(login, roles)
    }

    async fn insert_login(
        dbx: &DatabaseConnection,
        roles: &[&str],
    ) -> login::Model {
        mk_login(
            dbx,
            login::ActiveModel {
                login: Set(format!("device-visibility-{}", Uuid::now_v7())),
                roles: Set(json!(roles)),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    async fn insert_device(
        dbx: &DatabaseConnection,
        created_by: &str,
        archived: bool,
    ) -> device::Model {
        let source_label = format!("device-visibility-{}", Uuid::now_v7());
        device_active_model(
            created_by,
            &source_label,
            Some("Visibility device"),
            json!({}),
            archived,
            archived.then(|| Utc::now().naive_utc()),
        )
        .insert(dbx)
        .await
        .unwrap()
    }

    fn assert_not_found(result: Result<device::Model, AppError>) {
        assert!(matches!(result, Err(AppError::NotFound)));
    }

    fn assert_archived_device_error(error: AppError) {
        match error {
            AppError::Form(errors) => {
                assert_eq!(
                    errors.get("device_id").map(String::as_str),
                    Some("Архівований пристрій не можна редагувати"),
                );
            }
            error => {
                panic!("expected archived-device form error, got {error:?}")
            }
        }
    }

    fn assert_device_operation_forbidden(error: AppError) {
        match error {
            AppError::Forbidden(message) => {
                assert_eq!(message, "device operation is forbidden");
            }
            error => panic!(
                "expected device-operation forbidden error, got {error:?}"
            ),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn visibility_reads_active_and_archived_devices_without_owner_filter()
    {
        let (env, _guard) = cleanup_locked().await.unwrap();
        enable_devices_section(&env.dbx).await;
        let reader = insert_login(&env.dbx, &[ROLE_CYBER]).await;
        let owner = insert_login(&env.dbx, &[]).await;
        let active = insert_device(&env.dbx, &owner.login, false).await;
        let archived = insert_device(&env.dbx, &owner.login, true).await;
        let actor = actor(&reader.login, &[ROLE_CYBER]);
        let main_db = MainDb::new(&env.dbx);

        assert_ne!(active.created_by, reader.login);
        assert_eq!(
            DeviceVisibility::find_for_read(
                &main_db,
                &actor,
                active.id,
                DeviceReadScope::ActiveOnly,
            )
            .await
            .unwrap()
            .id,
            active.id,
        );
        assert_eq!(
            DeviceVisibility::find_for_read(
                &main_db,
                &actor,
                archived.id,
                DeviceReadScope::IncludeArchived,
            )
            .await
            .unwrap()
            .id,
            archived.id,
        );

        assert_not_found(
            DeviceVisibility::find_for_read(
                &main_db,
                &actor,
                archived.id,
                DeviceReadScope::ActiveOnly,
            )
            .await,
        );
        assert_not_found(
            DeviceVisibility::find_for_read(
                &main_db,
                &actor,
                Uuid::now_v7(),
                DeviceReadScope::ActiveOnly,
            )
            .await,
        );
        assert_eq!(
            DeviceVisibility::verify_file_registry_access(
                MainDb::new(&env.dbx),
                &actor,
                archived.id,
                FileRegistryDeviceAccess::Read,
            )
            .await
            .unwrap(),
            archived.id,
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn visibility_enforces_write_gates_archived_form_and_transaction_lock(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        enable_devices_section(&env.dbx).await;
        let owner = insert_login(&env.dbx, &[]).await;
        let active = insert_device(&env.dbx, &owner.login, false).await;
        let archived = insert_device(&env.dbx, &owner.login, true).await;
        let cyber = actor("cyber", &[ROLE_CYBER]);
        let source = actor("source", &[ROLE_DEVICE_SOURCE]);
        let analyst = actor("analyst", &[ROLE_DEVICE_ANALYST]);

        assert_device_operation_forbidden(
            cyber.require_source_write().unwrap_err(),
        );
        assert_device_operation_forbidden(
            cyber.require_analytical_write().unwrap_err(),
        );
        source.require_source_write().unwrap();
        assert_device_operation_forbidden(
            source.require_analytical_write().unwrap_err(),
        );
        analyst.require_source_write().unwrap();
        analyst.require_analytical_write().unwrap();

        assert_device_operation_forbidden(
            DeviceVisibility::verify_file_registry_access(
                MainDb::new(&env.dbx),
                &cyber,
                active.id,
                FileRegistryDeviceAccess::SourceWrite,
            )
            .await
            .unwrap_err(),
        );
        assert_eq!(
            DeviceVisibility::verify_file_registry_access(
                MainDb::new(&env.dbx),
                &source,
                active.id,
                FileRegistryDeviceAccess::SourceWrite,
            )
            .await
            .unwrap(),
            active.id,
        );

        let main_db = MainDb::new(&env.dbx);
        assert_archived_device_error(
            DeviceVisibility::find_active_for_write(
                &main_db,
                &source,
                archived.id,
            )
            .await
            .unwrap_err(),
        );

        let transaction = env.dbx.begin().await.unwrap();
        assert_eq!(
            DeviceVisibility::find_active_for_update(
                &MainDb::new(&transaction),
                &analyst,
                active.id,
            )
            .await
            .unwrap()
            .id,
            active.id,
        );
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn file_registry_handoff_releases_the_single_slot_main_pool() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        enable_devices_section(&env.dbx).await;
        let owner = insert_login(&env.dbx, &[]).await;
        let device = insert_device(&env.dbx, &owner.login, false).await;
        let actor = actor("source", &[ROLE_DEVICE_SOURCE]);
        let main_pool =
            crate::new_pg_pool_from_conn_string_with_max_connections(
                crate::mk_conn_string(&env.config),
                1,
            )
            .await
            .unwrap();

        let verified_device_id = DeviceVisibility::verify_file_registry_access(
            MainDb::new(&main_pool),
            &actor,
            device.id,
            FileRegistryDeviceAccess::SourceWrite,
        )
        .await
        .unwrap();

        let transaction = timeout(Duration::from_secs(5), main_pool.begin())
            .await
            .expect("main pool slot was not released")
            .unwrap();
        let roots = FilesystemRepository::new(&env.file_registry_db)
            .list_roots(verified_device_id)
            .await
            .unwrap();
        assert!(roots.is_empty());
        transaction.rollback().await.unwrap();
        main_pool.close().await.unwrap();
    }
}
