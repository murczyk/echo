use super::super::super::{
    ltree::{child_hierarchy_path, hierarchy_entry_ids, root_hierarchy_path},
    map_transaction_body_error,
    path::name_key,
    query::{map_directory_model, map_root_model},
    DomainFileEntryKind, FilesystemError, PreparedFileMutation, RootEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use chrono::NaiveDateTime;
use sea_orm::sea_query::{Expr, OnConflict, SimpleExpr};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseTransaction, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use uuid::Uuid;

pub(super) struct DirectoryParent {
    pub(super) entry_id: Uuid,
    pub(super) hierarchy_path: String,
}

pub(super) async fn ensure_target_root(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    now: NaiveDateTime,
) -> Result<Uuid, FilesystemError> {
    let source_path = &mutation.source_path;
    let root_name_key = name_key(&source_path.root_name);
    let hierarchy_path = root_hierarchy_path(mutation.candidate_root_entry_id);
    file_entry::Entity::insert(file_entry::ActiveModel {
        id: Set(mutation.candidate_root_entry_id),
        device_id: Set(mutation.device_id),
        parent_id: Set(None),
        kind: Set(DomainFileEntryKind::Directory.as_db_str().to_string()),
        name: Set(source_path.root_name.clone()),
        name_key: Set(root_name_key.clone()),
        path_syntax: Set(Some(source_path.path_syntax.as_db_str().to_string())),
        absolute_path: Set(None),
        hierarchy_path: Set(hierarchy_path),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        content_path: Set(None),
    })
    .on_conflict(
        OnConflict::columns([
            file_entry::Column::DeviceId,
            file_entry::Column::PathSyntax,
            file_entry::Column::NameKey,
        ])
        .target_and_where(file_entry::Column::ParentId.is_null())
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(transaction)
    .await
    .map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })?;

    let root = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(mutation.device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(
            file_entry::Column::Kind
                .eq(DomainFileEntryKind::Directory.as_db_str()),
        )
        .filter(
            file_entry::Column::PathSyntax
                .eq(source_path.path_syntax.as_db_str()),
        )
        .filter(file_entry::Column::NameKey.eq(root_name_key))
        .one(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "mutation_root_resolution_failed",
        ))?;

    Ok(map_root_model(root)?.entry_id)
}

pub(super) async fn lock_roots(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    root_entry_ids: &[Uuid],
) -> Result<Vec<file_entry::Model>, FilesystemError> {
    let mut root_entry_ids = root_entry_ids.to_vec();
    root_entry_ids.sort_unstable();
    root_entry_ids.dedup();

    let roots = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(
            file_entry::Column::Kind
                .eq(DomainFileEntryKind::Directory.as_db_str()),
        )
        .filter(file_entry::Column::Id.is_in(root_entry_ids.clone()))
        .order_by_asc(file_entry::Column::Id)
        .lock_exclusive()
        .all(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;

    if roots.len() != root_entry_ids.len() {
        return Err(FilesystemError::Invariant("mutation_root_lock_mismatch"));
    }

    Ok(roots)
}

pub(super) fn root_entry_id(
    hierarchy_path: &str,
) -> Result<Uuid, FilesystemError> {
    hierarchy_entry_ids(hierarchy_path)?
        .first()
        .copied()
        .ok_or(FilesystemError::Invariant("mutation_file_root_missing"))
}

pub(super) async fn ensure_directory_chain(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    root: &RootEntry,
    now: NaiveDateTime,
) -> Result<DirectoryParent, FilesystemError> {
    let directory_component_count = mutation
        .source_path
        .components
        .len()
        .checked_sub(1)
        .expect("parsed source path has a file component");
    if mutation.candidate_directory_entry_ids.len() != directory_component_count
    {
        return Err(FilesystemError::Invariant(
            "mutation_directory_candidate_count_mismatch",
        ));
    }

    let mut parent = DirectoryParent {
        entry_id: root.entry_id,
        hierarchy_path: root.hierarchy_path.clone(),
    };
    for (component, candidate_directory_entry_id) in mutation
        .source_path
        .components
        .iter()
        .take(directory_component_count)
        .zip(&mutation.candidate_directory_entry_ids)
    {
        let component_name_key = name_key(component);
        let hierarchy_path = child_hierarchy_path(
            &parent.hierarchy_path,
            *candidate_directory_entry_id,
        );
        file_entry::Entity::insert(file_entry::ActiveModel {
            id: Set(*candidate_directory_entry_id),
            device_id: Set(mutation.device_id),
            parent_id: Set(Some(parent.entry_id)),
            kind: Set(DomainFileEntryKind::Directory.as_db_str().to_string()),
            name: Set(component.to_string()),
            name_key: Set(component_name_key.clone()),
            path_syntax: Set(None),
            absolute_path: Set(None),
            hierarchy_path: Set(hierarchy_path),
            mime_type: Set(None),
            extension: Set(None),
            file_metadata_created_at: Set(None),
            file_metadata_modified_at: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            content_path: Set(None),
        })
        .on_conflict(
            OnConflict::columns([
                file_entry::Column::DeviceId,
                file_entry::Column::ParentId,
                file_entry::Column::NameKey,
            ])
            .target_and_where(
                Expr::col(file_entry::Column::Kind)
                    .eq(SimpleExpr::Constant(
                        DomainFileEntryKind::Directory
                            .as_db_str()
                            .to_string()
                            .into(),
                    ))
                    .and(file_entry::Column::ParentId.is_not_null()),
            )
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;

        let directory = file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(mutation.device_id))
            .filter(file_entry::Column::ParentId.eq(parent.entry_id))
            .filter(
                file_entry::Column::Kind
                    .eq(DomainFileEntryKind::Directory.as_db_str()),
            )
            .filter(file_entry::Column::NameKey.eq(component_name_key))
            .one(transaction)
            .await
            .map_err(|error| {
                map_transaction_body_error(
                    anyhow::Error::new(error).context(h!()),
                )
            })?
            .ok_or(FilesystemError::Invariant(
                "mutation_directory_resolution_failed",
            ))?;
        let directory = map_directory_model(directory)?;
        parent = DirectoryParent {
            entry_id: directory.entry_id,
            hierarchy_path: directory.hierarchy_path,
        };
    }

    Ok(parent)
}

pub(super) async fn prune_empty_directory_chain(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    mut directory_entry_id: Uuid,
) -> Result<(), FilesystemError> {
    loop {
        let directory = file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::Id.eq(directory_entry_id))
            .filter(
                file_entry::Column::Kind
                    .eq(DomainFileEntryKind::Directory.as_db_str()),
            )
            .lock_exclusive()
            .one(transaction)
            .await
            .map_err(|error| {
                map_transaction_body_error(
                    anyhow::Error::new(error).context(h!()),
                )
            })?
            .ok_or(FilesystemError::Invariant(
                "mutation_prune_directory_missing",
            ))?;
        if directory.parent_id.is_none() {
            return Ok(());
        }
        let directory = map_directory_model(directory)?;

        let has_child = file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::ParentId.eq(directory.entry_id))
            .one(transaction)
            .await
            .map_err(|error| {
                map_transaction_body_error(
                    anyhow::Error::new(error).context(h!()),
                )
            })?
            .is_some();
        if has_child {
            return Ok(());
        }

        let delete_result = file_entry::Entity::delete_many()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::Id.eq(directory.entry_id))
            .filter(
                file_entry::Column::Kind
                    .eq(DomainFileEntryKind::Directory.as_db_str()),
            )
            .exec(transaction)
            .await
            .map_err(|error| {
                map_transaction_body_error(
                    anyhow::Error::new(error).context(h!()),
                )
            })?;
        if delete_result.rows_affected != 1 {
            return Err(FilesystemError::Invariant(
                "mutation_prune_delete_mismatch",
            ));
        }

        directory_entry_id = directory.parent_entry_id;
    }
}
