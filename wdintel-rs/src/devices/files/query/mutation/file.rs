use super::super::super::{
    ltree::child_hierarchy_path,
    map_database_error, map_transaction_body_error,
    path::name_key,
    query::{map_file_model, map_root_model},
    DomainFileEntryKind, FileEntry, FileMutationResult, FilesystemError,
    PreparedFileMutation, RootEntry,
};
use super::hierarchy::{
    ensure_directory_chain, ensure_target_root, lock_roots,
    prune_empty_directory_chain, root_entry_id, DirectoryParent,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QuerySelect, Select, Statement,
};
use uuid::Uuid;

pub(super) async fn create_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    now: NaiveDateTime,
) -> Result<FileMutationResult, FilesystemError> {
    let target_root_entry_id =
        ensure_target_root(transaction, mutation, now).await?;
    let roots =
        lock_roots(transaction, mutation.device_id, &[target_root_entry_id])
            .await?;
    let root = locked_target_root(roots, target_root_entry_id)?;
    let parent =
        ensure_directory_chain(transaction, mutation, &root, now).await?;
    let file = insert_file(transaction, mutation, &parent, now).await?;

    Ok(FileMutationResult {
        operation: mutation.operation,
        root,
        file,
        path_components: mutation.source_path.components.clone(),
    })
}

pub(super) async fn update_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    now: NaiveDateTime,
) -> Result<FileMutationResult, FilesystemError> {
    let optimistic_file = file_query(mutation.device_id, mutation.file_id)
        .one(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::NotFound)?;
    let optimistic_file = map_file_model(optimistic_file)?;
    let optimistic_root_entry_id =
        root_entry_id(&optimistic_file.hierarchy_path)?;

    let target_root_entry_id =
        ensure_target_root(transaction, mutation, now).await?;
    let roots = lock_roots(
        transaction,
        mutation.device_id,
        &[optimistic_root_entry_id, target_root_entry_id],
    )
    .await?;
    let root = locked_target_root(roots, target_root_entry_id)?;

    let locked_file = file_query(mutation.device_id, mutation.file_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::NotFound)?;
    let locked_file_entry = map_file_model(locked_file.clone())?;
    ensure_file_root_unchanged(
        optimistic_root_entry_id,
        &locked_file_entry.hierarchy_path,
    )?;

    let parent =
        ensure_directory_chain(transaction, mutation, &root, now).await?;
    let old_parent_entry_id = locked_file_entry.parent_entry_id;
    let file =
        update_file_row(transaction, locked_file, mutation, &parent, now)
            .await?;
    if old_parent_entry_id != parent.entry_id {
        prune_empty_directory_chain(
            transaction,
            mutation.device_id,
            old_parent_entry_id,
        )
        .await?;
    }

    Ok(FileMutationResult {
        operation: mutation.operation,
        root,
        file,
        path_components: mutation.source_path.components.clone(),
    })
}

pub(in crate::devices::files) fn ensure_file_root_unchanged(
    optimistic_root_entry_id: Uuid,
    locked_hierarchy_path: &str,
) -> Result<(), FilesystemError> {
    if root_entry_id(locked_hierarchy_path)? == optimistic_root_entry_id {
        Ok(())
    } else {
        Err(FilesystemError::Conflict)
    }
}

pub(super) async fn reconcile_file_mutation(
    db: &DatabaseConnection,
    expected: &FileMutationResult,
    transaction_id: &str,
) -> Result<bool, FilesystemError> {
    let status = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select pg_xact_status($1::text::xid8) as status",
            [transaction_id.into()],
        ))
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?;
    let Some(status) = status else {
        return Ok(false);
    };
    let status: Option<String> = status
        .try_get("", "status")
        .c(h!())
        .map_err(FilesystemError::Internal)?;
    if status.as_deref() != Some("committed") {
        return Ok(false);
    }

    let leaf = file_query(expected.file.device_id, expected.file.file_id)
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?;
    let Some(leaf) = leaf else {
        return Ok(false);
    };
    let Ok(file) = map_file_model(leaf) else {
        return Ok(false);
    };
    let Ok(root_entry_id) = root_entry_id(&file.hierarchy_path) else {
        return Ok(false);
    };
    let root = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(expected.file.device_id))
        .filter(file_entry::Column::Id.eq(root_entry_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(
            file_entry::Column::Kind
                .eq(DomainFileEntryKind::Directory.as_db_str()),
        )
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?;
    let Some(root) = root else {
        return Ok(false);
    };
    let Ok(root) = map_root_model(root) else {
        return Ok(false);
    };

    Ok(file == expected.file && root == expected.root)
}

fn file_query(device_id: Uuid, file_id: Uuid) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Id.eq(file_id))
        .filter(
            file_entry::Column::Kind.eq(DomainFileEntryKind::File.as_db_str()),
        )
}

fn locked_target_root(
    roots: Vec<file_entry::Model>,
    target_root_entry_id: Uuid,
) -> Result<RootEntry, FilesystemError> {
    let root = roots
        .into_iter()
        .find(|root| root.id == target_root_entry_id)
        .ok_or(FilesystemError::Invariant("mutation_root_lock_mismatch"))?;
    map_root_model(root)
}

async fn insert_file(
    transaction: &DatabaseTransaction,
    mutation: &PreparedFileMutation,
    parent: &DirectoryParent,
    now: NaiveDateTime,
) -> Result<FileEntry, FilesystemError> {
    let file_name = mutation.source_path.file_name().to_string();
    let hierarchy_path =
        child_hierarchy_path(&parent.hierarchy_path, mutation.file_id);
    let file = file_entry::ActiveModel {
        id: Set(mutation.file_id),
        device_id: Set(mutation.device_id),
        parent_id: Set(Some(parent.entry_id)),
        kind: Set(DomainFileEntryKind::File.as_db_str().to_string()),
        name: Set(file_name.clone()),
        name_key: Set(name_key(&file_name)),
        path_syntax: Set(Some(
            mutation.source_path.path_syntax.as_db_str().to_string(),
        )),
        absolute_path: Set(Some(mutation.source_path.absolute_path.clone())),
        hierarchy_path: Set(hierarchy_path),
        mime_type: Set(mutation.metadata.mime_type.clone()),
        extension: Set(mutation.metadata.extension.clone()),
        file_metadata_created_at: Set(mutation
            .metadata
            .file_metadata_created_at),
        file_metadata_modified_at: Set(mutation
            .metadata
            .file_metadata_modified_at),
        created_at: Set(now),
        updated_at: Set(now),
        content_path: Set(None),
    }
    .insert(transaction)
    .await
    .map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })?;

    map_file_model(file)
}

async fn update_file_row(
    transaction: &DatabaseTransaction,
    entry: file_entry::Model,
    mutation: &PreparedFileMutation,
    parent: &DirectoryParent,
    now: NaiveDateTime,
) -> Result<FileEntry, FilesystemError> {
    let file_name = mutation.source_path.file_name().to_string();
    let hierarchy_path =
        child_hierarchy_path(&parent.hierarchy_path, mutation.file_id);
    let mut file = entry.into_active_model();
    file.parent_id = Set(Some(parent.entry_id));
    file.name = Set(file_name.clone());
    file.name_key = Set(name_key(&file_name));
    file.path_syntax = Set(Some(
        mutation.source_path.path_syntax.as_db_str().to_string(),
    ));
    file.absolute_path = Set(Some(mutation.source_path.absolute_path.clone()));
    file.hierarchy_path = Set(hierarchy_path);
    file.mime_type = Set(mutation.metadata.mime_type.clone());
    file.extension = Set(mutation.metadata.extension.clone());
    file.file_metadata_created_at =
        Set(mutation.metadata.file_metadata_created_at);
    file.file_metadata_modified_at =
        Set(mutation.metadata.file_metadata_modified_at);
    file.updated_at = Set(now);
    let file = file.update(transaction).await.map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })?;

    map_file_model(file)
}
