use super::{core, model};
use crate::devices::filesystem::{
    map_database_error, FileEntryKind, FilesystemError, RootEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Select};
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn list_roots(
    db: &impl ConnectionTrait,
    device_id: Uuid,
) -> Result<Vec<RootEntry>, FilesystemError> {
    let roots = roots_query(device_id).all(db).await.map_err(|error| {
        map_database_error(anyhow::Error::new(error).context(h!()))
    })?;

    roots.into_iter().map(model::map_root_model).collect()
}

pub(super) fn roots_query(device_id: Uuid) -> Select<file_entry::Entity> {
    core::apply_root_order(
        file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::ParentId.is_null())
            .filter(
                file_entry::Column::Kind
                    .eq(FileEntryKind::Directory.as_db_str()),
            ),
    )
}
