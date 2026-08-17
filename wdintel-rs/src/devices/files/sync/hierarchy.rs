use super::super::{
    ltree::{child_hierarchy_path, hierarchy_entry_ids, root_hierarchy_path},
    map_transaction_body_error,
    query::{map_directory_model, map_root_model},
    FilesystemError, PreparedFileMutation,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use chrono::NaiveDateTime;
use sea_orm::{
    ConnectionTrait, DatabaseTransaction, DbBackend, FromQueryResult, Statement,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

const INSERT_ROOTS_SQL: &str = r#"
    insert into file_entry (
        id,
        device_id,
        parent_id,
        kind,
        name,
        absolute_path,
        hierarchy_path,
        mime_type,
        extension,
        file_metadata_created_at,
        file_metadata_modified_at,
        created_at,
        updated_at,
        content_path,
        revision,
        sync_id,
        source_file_state,
        source_file_state_settled_at,
        source_file_state_settled_by
    )
    select
        input.candidate_id,
        input.device_id,
        null,
        'directory'::public.file_entry_kind,
        input.name,
        null,
        input.hierarchy_path::public.ltree,
        null,
        null,
        null,
        null,
        $2::timestamp without time zone,
        $2::timestamp without time zone,
        null,
        null,
        null,
        null,
        null,
        null
    from jsonb_to_recordset($1::jsonb) as input(
        candidate_id uuid,
        device_id uuid,
        name text,
        hierarchy_path text
    )
    on conflict (device_id, name)
        where parent_id is null
    do nothing
"#;

const SELECT_ROOTS_SQL: &str = r#"
    select
        entry.id,
        entry.device_id,
        entry.parent_id,
        entry.kind,
        entry.name,
        entry.absolute_path,
        entry.hierarchy_path::text as hierarchy_path,
        entry.mime_type,
        entry.extension,
        entry.file_metadata_created_at,
        entry.file_metadata_modified_at,
        entry.created_at,
        entry.updated_at,
        entry.content_path,
        entry.revision,
        entry.sync_id,
        entry.source_file_state,
        entry.source_file_state_settled_at,
        entry.source_file_state_settled_by
    from jsonb_to_recordset($1::jsonb) as input(
        device_id uuid,
        name text
    )
    join file_entry as entry
      on entry.device_id = input.device_id
     and entry.parent_id is null
     and entry.kind = 'directory'::public.file_entry_kind
     and entry.name = input.name
    order by entry.id
    for update of entry
"#;

const INSERT_DIRECTORIES_SQL: &str = r#"
    insert into file_entry (
        id,
        device_id,
        parent_id,
        kind,
        name,
        absolute_path,
        hierarchy_path,
        mime_type,
        extension,
        file_metadata_created_at,
        file_metadata_modified_at,
        created_at,
        updated_at,
        content_path,
        revision,
        sync_id,
        source_file_state,
        source_file_state_settled_at,
        source_file_state_settled_by
    )
    select
        input.candidate_id,
        input.device_id,
        input.parent_id,
        'directory'::public.file_entry_kind,
        input.name,
        null,
        input.hierarchy_path::public.ltree,
        null,
        null,
        null,
        null,
        $2::timestamp without time zone,
        $2::timestamp without time zone,
        null,
        null,
        null,
        null,
        null,
        null
    from jsonb_to_recordset($1::jsonb) as input(
        candidate_id uuid,
        device_id uuid,
        parent_id uuid,
        name text,
        hierarchy_path text
    )
    on conflict (device_id, parent_id, name)
        where kind = 'directory'::public.file_entry_kind
          and parent_id is not null
    do nothing
"#;

const SELECT_DIRECTORIES_SQL: &str = r#"
    select
        entry.id,
        entry.device_id,
        entry.parent_id,
        entry.kind,
        entry.name,
        entry.absolute_path,
        entry.hierarchy_path::text as hierarchy_path,
        entry.mime_type,
        entry.extension,
        entry.file_metadata_created_at,
        entry.file_metadata_modified_at,
        entry.created_at,
        entry.updated_at,
        entry.content_path,
        entry.revision,
        entry.sync_id,
        entry.source_file_state,
        entry.source_file_state_settled_at,
        entry.source_file_state_settled_by
    from jsonb_to_recordset($1::jsonb) as input(
        device_id uuid,
        parent_id uuid,
        name text
    )
    join file_entry as entry
      on entry.device_id = input.device_id
     and entry.parent_id = input.parent_id
     and entry.kind = 'directory'::public.file_entry_kind
     and entry.name = input.name
    order by entry.id
"#;

#[derive(Serialize)]
struct RootInput {
    candidate_id: Uuid,
    device_id: Uuid,
    name: String,
    hierarchy_path: String,
}

#[derive(Serialize)]
struct DirectoryInput {
    candidate_id: Uuid,
    device_id: Uuid,
    parent_id: Uuid,
    name: String,
    hierarchy_path: String,
}

#[derive(Clone)]
struct DirectoryParent {
    entry_id: Uuid,
    hierarchy_path: String,
}

pub(super) struct ResolvedNewFileHierarchy {
    pub(super) root_id: Uuid,
    pub(super) parent_id: Uuid,
    pub(super) parent_hierarchy_path: String,
}

pub(super) async fn resolve_new_file_hierarchies(
    transaction: &DatabaseTransaction,
    mutations: &[&PreparedFileMutation],
    now: NaiveDateTime,
) -> Result<Vec<ResolvedNewFileHierarchy>, FilesystemError> {
    let Some(first) = mutations.first() else {
        return Ok(Vec::new());
    };
    let device_id = first.device_id;
    let mut max_directory_depth = 0;
    for mutation in mutations {
        if mutation.device_id != device_id {
            return Err(FilesystemError::Invariant(
                "mutation_hierarchy_device_mismatch",
            ));
        }
        let directory_depth = directory_depth(mutation)?;
        max_directory_depth = max_directory_depth.max(directory_depth);
    }

    let roots = resolve_roots(transaction, mutations, now).await?;
    let mut root_ids = Vec::with_capacity(mutations.len());
    let mut parents = Vec::with_capacity(mutations.len());
    for mutation in mutations {
        let key = (mutation.device_id, mutation.source_path.root_name.clone());
        let root = roots.get(&key).ok_or(FilesystemError::Invariant(
            "mutation_root_resolution_failed",
        ))?;
        root_ids.push(root.entry_id);
        parents.push(DirectoryParent {
            entry_id: root.entry_id,
            hierarchy_path: root.hierarchy_path.clone(),
        });
    }

    for depth in 0..max_directory_depth {
        let directories = resolve_directory_depth(
            transaction,
            mutations,
            &parents,
            depth,
            now,
        )
        .await?;
        for (index, mutation) in mutations.iter().enumerate() {
            if depth >= directory_depth(mutation)? {
                continue;
            }
            let component = &mutation.source_path.components[depth];
            let key = (
                mutation.device_id,
                parents[index].entry_id,
                component.clone(),
            );
            parents[index] = directories.get(&key).cloned().ok_or(
                FilesystemError::Invariant(
                    "mutation_directory_resolution_failed",
                ),
            )?;
        }
    }

    Ok(root_ids
        .into_iter()
        .zip(parents)
        .map(|(root_id, parent)| ResolvedNewFileHierarchy {
            root_id,
            parent_id: parent.entry_id,
            parent_hierarchy_path: parent.hierarchy_path,
        })
        .collect())
}

async fn resolve_roots(
    transaction: &DatabaseTransaction,
    mutations: &[&PreparedFileMutation],
    now: NaiveDateTime,
) -> Result<HashMap<(Uuid, String), super::super::RootEntry>, FilesystemError> {
    let mut inputs = BTreeMap::new();
    for mutation in mutations {
        let key = (mutation.device_id, mutation.source_path.root_name.clone());
        inputs.entry(key).or_insert_with(|| RootInput {
            candidate_id: mutation.candidate_root_entry_id,
            device_id: mutation.device_id,
            name: mutation.source_path.root_name.clone(),
            hierarchy_path: root_hierarchy_path(
                mutation.candidate_root_entry_id,
            ),
        });
    }
    let payload = serialize_inputs(&inputs.values().collect::<Vec<_>>())?;

    transaction
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            INSERT_ROOTS_SQL,
            [payload.clone().into(), now.into()],
        ))
        .await
        .map_err(map_database)?;
    let rows =
        file_entry::Model::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            SELECT_ROOTS_SQL,
            [payload.into()],
        ))
        .all(transaction)
        .await
        .map_err(map_database)?;

    let mut roots = HashMap::with_capacity(rows.len());
    for row in rows {
        let root = map_root_model(row)?;
        let key = (root.device_id, root.name.clone());
        if !inputs.contains_key(&key) || roots.insert(key, root).is_some() {
            return Err(FilesystemError::Invariant(
                "mutation_root_resolution_not_unique",
            ));
        }
    }
    if roots.len() != inputs.len() {
        return Err(FilesystemError::Invariant(
            "mutation_root_resolution_failed",
        ));
    }
    Ok(roots)
}

async fn resolve_directory_depth(
    transaction: &DatabaseTransaction,
    mutations: &[&PreparedFileMutation],
    parents: &[DirectoryParent],
    depth: usize,
    now: NaiveDateTime,
) -> Result<HashMap<(Uuid, Uuid, String), DirectoryParent>, FilesystemError> {
    if mutations.len() != parents.len() {
        return Err(FilesystemError::Invariant(
            "mutation_hierarchy_parent_count_mismatch",
        ));
    }

    let mut inputs = BTreeMap::new();
    for (mutation, parent) in mutations.iter().zip(parents) {
        if depth >= directory_depth(mutation)? {
            continue;
        }
        let component = &mutation.source_path.components[depth];
        let candidate_id = mutation.candidate_directory_entry_ids[depth];
        let key = (mutation.device_id, parent.entry_id, component.clone());
        inputs.entry(key).or_insert_with(|| DirectoryInput {
            candidate_id,
            device_id: mutation.device_id,
            parent_id: parent.entry_id,
            name: component.clone(),
            hierarchy_path: child_hierarchy_path(
                &parent.hierarchy_path,
                candidate_id,
            ),
        });
    }
    if inputs.is_empty() {
        return Ok(HashMap::new());
    }
    let payload = serialize_inputs(&inputs.values().collect::<Vec<_>>())?;

    transaction
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            INSERT_DIRECTORIES_SQL,
            [payload.clone().into(), now.into()],
        ))
        .await
        .map_err(map_database)?;
    let rows =
        file_entry::Model::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            SELECT_DIRECTORIES_SQL,
            [payload.into()],
        ))
        .all(transaction)
        .await
        .map_err(map_database)?;

    let mut directories = HashMap::with_capacity(rows.len());
    for row in rows {
        let directory = map_directory_model(row)?;
        let key = (
            directory.device_id,
            directory.parent_entry_id,
            directory.name.clone(),
        );
        let parent = DirectoryParent {
            entry_id: directory.entry_id,
            hierarchy_path: directory.hierarchy_path,
        };
        if !inputs.contains_key(&key)
            || directories.insert(key, parent).is_some()
        {
            return Err(FilesystemError::Invariant(
                "mutation_directory_resolution_not_unique",
            ));
        }
    }
    if directories.len() != inputs.len() {
        return Err(FilesystemError::Invariant(
            "mutation_directory_resolution_failed",
        ));
    }
    Ok(directories)
}

fn directory_depth(
    mutation: &PreparedFileMutation,
) -> Result<usize, FilesystemError> {
    let directory_depth =
        mutation.source_path.components.len().checked_sub(1).ok_or(
            FilesystemError::Invariant("mutation_file_component_missing"),
        )?;
    if mutation.candidate_directory_entry_ids.len() != directory_depth {
        return Err(FilesystemError::Invariant(
            "mutation_directory_candidate_count_mismatch",
        ));
    }
    Ok(directory_depth)
}

fn serialize_inputs<T: Serialize + ?Sized>(
    inputs: &T,
) -> Result<String, FilesystemError> {
    serde_json::to_string(inputs).map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })
}

fn map_database(error: sea_orm::DbErr) -> FilesystemError {
    map_transaction_body_error(anyhow::Error::new(error).context(h!()))
}

pub(super) fn root_entry_id(
    hierarchy_path: &str,
) -> Result<Uuid, FilesystemError> {
    hierarchy_entry_ids(hierarchy_path)?
        .first()
        .copied()
        .ok_or(FilesystemError::Invariant("mutation_file_root_missing"))
}
