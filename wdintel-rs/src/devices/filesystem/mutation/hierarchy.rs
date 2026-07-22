use super::super::{
    ltree::{child_hierarchy_path, hierarchy_entry_ids, root_hierarchy_path},
    path::name_key,
    query::{map_directory_model, map_root_model},
    FileEntryKind, FilesystemError, PreparedFileMutation, RootEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use chrono::NaiveDateTime;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseTransaction, DbBackend, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Statement,
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
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
        insert into public.file_entry (
            id,
            device_id,
            parent_id,
            kind,
            name,
            name_key,
            path_syntax,
            absolute_path,
            hierarchy_path,
            mime_type,
            extension,
            file_metadata_created_at,
            file_metadata_modified_at,
            created_at,
            updated_at
        ) values (
            $1,
            $2,
            null,
            'directory',
            $3,
            $4,
            $5,
            null,
            $6::public.ltree,
            null,
            null,
            null,
            null,
            $7,
            $7
        )
        on conflict (device_id, path_syntax, name_key)
            where parent_id is null
            do nothing
        "#,
        [
            mutation.candidate_root_entry_id.into(),
            mutation.device_id.into(),
            source_path.root_name.clone().into(),
            root_name_key.clone().into(),
            source_path.path_syntax.as_db_str().into(),
            hierarchy_path.into(),
            now.into(),
        ],
    );
    transaction
        .execute(statement)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;

    let root = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(mutation.device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
        .filter(
            file_entry::Column::PathSyntax
                .eq(source_path.path_syntax.as_db_str()),
        )
        .filter(file_entry::Column::NameKey.eq(root_name_key))
        .one(transaction)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?
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
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
        .filter(file_entry::Column::Id.is_in(root_entry_ids.clone()))
        .order_by_asc(file_entry::Column::Id)
        .lock_exclusive()
        .all(transaction)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;

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
        let statement = Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
            insert into public.file_entry (
                id,
                device_id,
                parent_id,
                kind,
                name,
                name_key,
                path_syntax,
                absolute_path,
                hierarchy_path,
                mime_type,
                extension,
                file_metadata_created_at,
                file_metadata_modified_at,
                created_at,
                updated_at
            ) values (
                $1,
                $2,
                $3,
                'directory',
                $4,
                $5,
                null,
                null,
                $6::public.ltree,
                null,
                null,
                null,
                null,
                $7,
                $7
            )
            on conflict (device_id, parent_id, name_key)
                where kind = 'directory' and parent_id is not null
                do nothing
            "#,
            [
                (*candidate_directory_entry_id).into(),
                mutation.device_id.into(),
                parent.entry_id.into(),
                component.to_string().into(),
                component_name_key.clone().into(),
                hierarchy_path.into(),
                now.into(),
            ],
        );
        transaction
            .execute(statement)
            .await
            .c(h!())
            .map_err(FilesystemError::Internal)?;

        let directory = file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(mutation.device_id))
            .filter(file_entry::Column::ParentId.eq(parent.entry_id))
            .filter(
                file_entry::Column::Kind
                    .eq(FileEntryKind::Directory.as_db_str()),
            )
            .filter(file_entry::Column::NameKey.eq(component_name_key))
            .one(transaction)
            .await
            .c(h!())
            .map_err(FilesystemError::Internal)?
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
                    .eq(FileEntryKind::Directory.as_db_str()),
            )
            .lock_exclusive()
            .one(transaction)
            .await
            .c(h!())
            .map_err(FilesystemError::Internal)?
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
            .c(h!())
            .map_err(FilesystemError::Internal)?
            .is_some();
        if has_child {
            return Ok(());
        }

        let delete_result = file_entry::Entity::delete_many()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(file_entry::Column::Id.eq(directory.entry_id))
            .filter(
                file_entry::Column::Kind
                    .eq(FileEntryKind::Directory.as_db_str()),
            )
            .exec(transaction)
            .await
            .c(h!())
            .map_err(FilesystemError::Internal)?;
        if delete_result.rows_affected != 1 {
            return Err(FilesystemError::Invariant(
                "mutation_prune_delete_mismatch",
            ));
        }

        directory_entry_id = directory.parent_entry_id;
    }
}
