use super::super::{
    ltree::{child_hierarchy_path, hierarchy_entry_ids, root_hierarchy_path},
    map_transaction_body_error,
    query::{map_directory_model, map_root_model},
    DomainFileEntryKind, FilesystemError, PreparedFileMutation,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use chrono::NaiveDateTime;
use sea_orm::sea_query::{Expr, OnConflict, SimpleExpr};
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, DatabaseTransaction,
    EntityTrait, ExprTrait, QueryFilter, QueryOrder, QuerySelect,
};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

struct RootInput {
    candidate_id: Uuid,
    device_id: Uuid,
    name: String,
    hierarchy_path: String,
}

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
        max_directory_depth =
            std::cmp::max(max_directory_depth, directory_depth);
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
    file_entry::Entity::insert_many(inputs.values().map(|input| {
        directory_active_model(
            input.candidate_id,
            input.device_id,
            None,
            &input.name,
            &input.hierarchy_path,
            now,
        )
    }))
    .on_conflict(
        OnConflict::columns([
            file_entry::Column::DeviceId,
            file_entry::Column::Name,
        ])
        .target_and_where(file_entry::Column::ParentId.is_null())
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(transaction)
    .await
    .map_err(map_database)?;
    let root_keys = inputs.keys().cloned().collect::<Vec<_>>();
    let rows = file_entry::Entity::find()
        .filter(file_entry::Column::ParentId.is_null())
        .filter(directory_kind_expr())
        .filter(
            Expr::tuple([
                Expr::col(file_entry::Column::DeviceId),
                Expr::col(file_entry::Column::Name),
            ])
            .in_tuples(root_keys),
        )
        .order_by_asc(file_entry::Column::Id)
        .lock_exclusive()
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
    file_entry::Entity::insert_many(inputs.values().map(|input| {
        directory_active_model(
            input.candidate_id,
            input.device_id,
            Some(input.parent_id),
            &input.name,
            &input.hierarchy_path,
            now,
        )
    }))
    .on_conflict(
        OnConflict::columns([
            file_entry::Column::DeviceId,
            file_entry::Column::ParentId,
            file_entry::Column::Name,
        ])
        .target_and_where(
            directory_kind_expr()
                .and(file_entry::Column::ParentId.is_not_null()),
        )
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(transaction)
    .await
    .map_err(map_database)?;
    let directory_keys = inputs.keys().cloned().collect::<Vec<_>>();
    let rows = file_entry::Entity::find()
        .filter(file_entry::Column::ParentId.is_not_null())
        .filter(directory_kind_expr())
        .filter(
            Expr::tuple([
                Expr::col(file_entry::Column::DeviceId),
                Expr::col(file_entry::Column::ParentId),
                Expr::col(file_entry::Column::Name),
            ])
            .in_tuples(directory_keys),
        )
        .order_by_asc(file_entry::Column::Id)
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

fn directory_active_model(
    id: Uuid,
    device_id: Uuid,
    parent_id: Option<Uuid>,
    name: &str,
    hierarchy_path: &str,
    now: NaiveDateTime,
) -> file_entry::ActiveModel {
    file_entry::ActiveModel {
        id: Set(id),
        device_id: Set(device_id),
        parent_id: Set(parent_id),
        kind: Set(DomainFileEntryKind::Directory),
        name: Set(name.to_owned()),
        absolute_path: Set(None),
        hierarchy_path: Set(hierarchy_path.to_owned()),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        content_path: Set(None),
        revision: Set(None),
        sync_id: Set(None),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
    }
}

fn directory_kind_expr() -> SimpleExpr {
    Expr::col(file_entry::Column::Kind).eq(SimpleExpr::Constant(
        DomainFileEntryKind::Directory.to_value().into(),
    ))
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
