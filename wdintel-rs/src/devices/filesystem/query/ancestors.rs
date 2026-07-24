use super::{super::ltree, model};
use crate::devices::filesystem::{
    map_database_error, Breadcrumb, DirectoryScope, FileEntryKind,
    FilesystemError, RootEntry, TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::{Alias, Expr, Func, SimpleExpr};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder, Select,
};
use std::collections::HashMap;
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn list_breadcrumbs(
    db: &impl ConnectionTrait,
    scope: &DirectoryScope,
) -> Result<Vec<Breadcrumb>, FilesystemError> {
    let rows = breadcrumbs_query(scope).all(db).await.map_err(|error| {
        map_database_error(anyhow::Error::new(error).context(h!()))
    })?;

    map_breadcrumb_chain(scope, rows)
}

pub(in crate::devices::filesystem) async fn load_path_components(
    db: &impl ConnectionTrait,
    entries: &[TreeEntry],
) -> Result<Vec<Vec<String>>, FilesystemError> {
    let Some(first_entry) = entries.first() else {
        return Ok(Vec::new());
    };
    let device_id = tree_entry_device_id(first_entry);
    if entries
        .iter()
        .any(|entry| tree_entry_device_id(entry) != device_id)
    {
        return Err(FilesystemError::Invariant("path_context_device_mismatch"));
    }
    let hierarchy_paths = entries
        .iter()
        .map(tree_entry_hierarchy_path)
        .collect::<Vec<_>>();
    let rows = path_context_query(device_id, &hierarchy_paths)
        .all(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?;

    map_path_components(entries, rows)
}

pub(super) fn path_context_query(
    device_id: Uuid,
    hierarchy_paths: &[&str],
) -> Select<file_entry::Entity> {
    let path_conditions = hierarchy_paths.iter().fold(
        Condition::any(),
        |conditions, hierarchy_path| {
            conditions.add(ltree::ancestor_expr(hierarchy_path))
        },
    );

    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(path_conditions)
        .order_by_asc(hierarchy_depth_expr())
        .order_by_asc(file_entry::Column::Id)
}

pub(super) fn breadcrumbs_query(
    scope: &DirectoryScope,
) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(scope.device_id()))
        .filter(
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
        .filter(ltree::ancestor_expr(scope.hierarchy_path()))
        .order_by_asc(hierarchy_depth_expr())
}

fn hierarchy_depth_expr() -> SimpleExpr {
    Func::cust(Alias::new("nlevel"))
        .arg(Expr::col((
            file_entry::Entity,
            file_entry::Column::HierarchyPath,
        )))
        .into()
}

pub(super) fn map_path_components(
    entries: &[TreeEntry],
    rows: Vec<file_entry::Model>,
) -> Result<Vec<Vec<String>>, FilesystemError> {
    let Some(first_entry) = entries.first() else {
        return Ok(Vec::new());
    };
    let device_id = tree_entry_device_id(first_entry);
    if entries
        .iter()
        .any(|entry| tree_entry_device_id(entry) != device_id)
    {
        return Err(FilesystemError::Invariant("path_context_device_mismatch"));
    }

    let mut context_by_id = HashMap::with_capacity(rows.len());
    for row in rows {
        let context = if row.parent_id.is_none() {
            PathContextEntry::Root(model::map_root_model(row)?)
        } else {
            PathContextEntry::Tree(model::map_tree_model(row)?)
        };
        context_by_id.insert(context.entry_id(), context);
    }

    entries
        .iter()
        .map(|entry| {
            map_entry_path_components(entry, device_id, &context_by_id)
        })
        .collect()
}

fn map_entry_path_components(
    entry: &TreeEntry,
    device_id: Uuid,
    context_by_id: &HashMap<Uuid, PathContextEntry>,
) -> Result<Vec<String>, FilesystemError> {
    let entry_ids =
        ltree::hierarchy_entry_ids(tree_entry_hierarchy_path(entry))?;
    let mut path_components = Vec::with_capacity(entry_ids.len() - 1);
    let mut previous_entry_id = None;

    for (position, entry_id) in entry_ids.iter().copied().enumerate() {
        let is_final_entry = position + 1 == entry_ids.len();
        let context = match context_by_id.get(&entry_id) {
            Some(context) => context,
            None if is_final_entry => return Err(FilesystemError::NotFound),
            None => {
                return Err(FilesystemError::Invariant(
                    "path_context_chain_gap",
                ));
            }
        };
        if context.device_id() != device_id {
            return Err(FilesystemError::Invariant(
                "path_context_device_mismatch",
            ));
        }
        if position == 0 {
            if !matches!(context, PathContextEntry::Root(_)) {
                return Err(FilesystemError::Invariant(
                    "path_context_chain_gap",
                ));
            }
        } else if context.parent_entry_id() != previous_entry_id {
            return Err(FilesystemError::Invariant("path_context_chain_gap"));
        }
        ltree::verify_hierarchy_path(
            &entry_ids[..=position],
            context.hierarchy_path(),
        )?;

        if is_final_entry {
            if context.entry_id() != tree_entry_id(entry)
                || context.kind() != tree_entry_kind(entry)
            {
                return Err(FilesystemError::Invariant(
                    "path_context_entry_mismatch",
                ));
            }
            path_components.push(tree_entry_name(entry).to_string());
        } else if position != 0 {
            if context.kind() != FileEntryKind::Directory {
                return Err(FilesystemError::Invariant(
                    "path_context_non_directory_ancestor",
                ));
            }
            path_components.push(context.name().to_string());
        }
        previous_entry_id = Some(entry_id);
    }

    Ok(path_components)
}

enum PathContextEntry {
    Root(RootEntry),
    Tree(TreeEntry),
}

impl PathContextEntry {
    fn device_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.device_id,
            Self::Tree(entry) => tree_entry_device_id(entry),
        }
    }

    fn entry_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.entry_id,
            Self::Tree(entry) => tree_entry_id(entry),
        }
    }

    fn parent_entry_id(&self) -> Option<Uuid> {
        match self {
            Self::Root(_) => None,
            Self::Tree(TreeEntry::Directory(directory)) => {
                Some(directory.parent_entry_id)
            }
            Self::Tree(TreeEntry::File(file)) => Some(file.parent_entry_id),
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Root(root) => &root.name,
            Self::Tree(entry) => tree_entry_name(entry),
        }
    }

    fn kind(&self) -> FileEntryKind {
        match self {
            Self::Root(_) | Self::Tree(TreeEntry::Directory(_)) => {
                FileEntryKind::Directory
            }
            Self::Tree(TreeEntry::File(_)) => FileEntryKind::File,
        }
    }

    fn hierarchy_path(&self) -> &str {
        match self {
            Self::Root(root) => &root.hierarchy_path,
            Self::Tree(entry) => tree_entry_hierarchy_path(entry),
        }
    }
}

fn tree_entry_device_id(entry: &TreeEntry) -> Uuid {
    match entry {
        TreeEntry::Directory(directory) => directory.device_id,
        TreeEntry::File(file) => file.device_id,
    }
}

fn tree_entry_id(entry: &TreeEntry) -> Uuid {
    match entry {
        TreeEntry::Directory(directory) => directory.entry_id,
        TreeEntry::File(file) => file.file_id,
    }
}

fn tree_entry_kind(entry: &TreeEntry) -> FileEntryKind {
    match entry {
        TreeEntry::Directory(_) => FileEntryKind::Directory,
        TreeEntry::File(_) => FileEntryKind::File,
    }
}

fn tree_entry_name(entry: &TreeEntry) -> &str {
    match entry {
        TreeEntry::Directory(directory) => &directory.name,
        TreeEntry::File(file) => &file.name,
    }
}

fn tree_entry_hierarchy_path(entry: &TreeEntry) -> &str {
    match entry {
        TreeEntry::Directory(directory) => &directory.hierarchy_path,
        TreeEntry::File(file) => &file.hierarchy_path,
    }
}

fn map_breadcrumb_chain(
    scope: &DirectoryScope,
    rows: Vec<file_entry::Model>,
) -> Result<Vec<Breadcrumb>, FilesystemError> {
    let mut rows = rows.into_iter();
    let root = rows.next().ok_or(FilesystemError::NotFound)?;
    let root = model::map_root_model(root)?;
    if root.device_id != scope.device_id() {
        return Err(FilesystemError::Invariant("breadcrumb_device_mismatch"));
    }

    let mut entry_ids = vec![root.entry_id];
    let mut breadcrumbs = vec![Breadcrumb {
        entry_id: root.entry_id,
        name: root.name,
    }];
    let mut previous_entry_id = root.entry_id;

    for row in rows {
        let directory = model::map_directory_model(row)?;
        if directory.device_id != scope.device_id() {
            return Err(FilesystemError::Invariant(
                "breadcrumb_device_mismatch",
            ));
        }
        if directory.parent_entry_id != previous_entry_id {
            return Err(FilesystemError::Invariant("breadcrumb_chain_gap"));
        }

        previous_entry_id = directory.entry_id;
        entry_ids.push(directory.entry_id);
        breadcrumbs.push(Breadcrumb {
            entry_id: directory.entry_id,
            name: directory.name,
        });
    }

    if entry_ids.last() != Some(&scope.entry_id()) {
        return Err(FilesystemError::NotFound);
    }
    ltree::verify_hierarchy_path(&entry_ids, scope.hierarchy_path())?;

    Ok(breadcrumbs)
}

#[cfg(test)]
mod tests;
