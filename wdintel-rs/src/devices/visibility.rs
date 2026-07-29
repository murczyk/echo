use super::access::DeviceActor;
use super::main_db::MainDb;
use crate::entities::{device, organism};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::sea_query::{
    Alias, CommonTableExpression, Expr, JoinType, Query, SelectStatement,
    UnionType, WithClause,
};
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

        let query = device::Entity::find().filter(
            device::Column::OrganismId
                .in_subquery(visible_organism_ids_query(actor.organism_id())),
        );
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

fn visible_organism_ids_query(organism_id: i64) -> SelectStatement {
    let visible_organism = Alias::new("visible_organism");
    let visible_organism_id = Alias::new("id");
    let descendants = Query::select()
        .column((organism::Entity, organism::Column::Id))
        .from(organism::Entity)
        .join(
            JoinType::InnerJoin,
            visible_organism.clone(),
            Expr::col((organism::Entity, organism::Column::ParentId)).equals((
                visible_organism.clone(),
                visible_organism_id.clone(),
            )),
        )
        .and_where(
            Expr::col((organism::Entity, organism::Column::DeletedPermanently))
                .eq(false),
        )
        .to_owned();
    let cte = CommonTableExpression::new()
        .table_name(visible_organism.clone())
        .column(visible_organism_id.clone())
        .query(
            Query::select()
                .expr(Expr::value(organism_id))
                .union(UnionType::Distinct, descendants)
                .to_owned(),
        )
        .to_owned();

    Query::select()
        .column((visible_organism.clone(), visible_organism_id))
        .from(visible_organism)
        .with_cte(WithClause::new().recursive(true).cte(cte).to_owned())
        .to_owned()
}

fn archived_device_error() -> AppError {
    AppError::Form(BTreeMap::from_iter([(
        "device_id".to_string(),
        "Архівований пристрій не можна редагувати".to_string(),
    )]))
}

#[cfg(test)]
mod tests;
