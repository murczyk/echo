use super::{core, model};
use crate::devices::filesystem::{FileEntryKind, FilesystemError, RootEntry};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn list_roots(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<Vec<RootEntry>, FilesystemError> {
    let roots = core::apply_root_order(
        file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::ParentId.is_null())
            .filter(
                file_entry::Column::Kind
                    .eq(FileEntryKind::Directory.as_db_str()),
            ),
    )
    .all(db)
    .await
    .c(h!())
    .map_err(FilesystemError::Internal)?;

    roots.into_iter().map(model::map_root_model).collect()
}
