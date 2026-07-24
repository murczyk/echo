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
mod tests;
