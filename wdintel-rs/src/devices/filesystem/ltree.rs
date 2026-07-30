use super::error::FilesystemError;
use crate::file_registry::entities::file_entry;
use sea_orm::sea_query::{
    extension::postgres::{PgExpr, PgLTree},
    Expr, SimpleExpr,
};
use std::fmt::Write;
use uuid::Uuid;

pub(super) fn uuid_label(entry_id: Uuid) -> String {
    let mut label = String::with_capacity(33);
    label.push('n');
    write!(&mut label, "{}", entry_id.simple())
        .expect("writing to String cannot fail");
    label
}

pub(super) fn root_hierarchy_path(entry_id: Uuid) -> String {
    uuid_label(entry_id)
}

pub(super) fn child_hierarchy_path(
    parent_path: &str,
    entry_id: Uuid,
) -> String {
    let mut hierarchy_path = String::with_capacity(parent_path.len() + 34);
    hierarchy_path.push_str(parent_path);
    hierarchy_path.push('.');
    hierarchy_path.push('n');
    write!(&mut hierarchy_path, "{}", entry_id.simple())
        .expect("writing to String cannot fail");
    hierarchy_path
}

pub(super) fn expected_hierarchy_path(
    ordered_entry_ids: &[Uuid],
) -> Result<String, FilesystemError> {
    let Some((first_entry_id, remaining_entry_ids)) =
        ordered_entry_ids.split_first()
    else {
        return Err(FilesystemError::Invariant("hierarchy_path_empty"));
    };
    let mut hierarchy_path =
        String::with_capacity(ordered_entry_ids.len() * 34 - 1);
    hierarchy_path.push('n');
    write!(&mut hierarchy_path, "{}", first_entry_id.simple())
        .expect("writing to String cannot fail");

    for entry_id in remaining_entry_ids {
        hierarchy_path.push('.');
        hierarchy_path.push('n');
        write!(&mut hierarchy_path, "{}", entry_id.simple())
            .expect("writing to String cannot fail");
    }

    Ok(hierarchy_path)
}

pub(super) fn verify_hierarchy_path(
    ordered_entry_ids: &[Uuid],
    hierarchy_path: &str,
) -> Result<(), FilesystemError> {
    if expected_hierarchy_path(ordered_entry_ids)? == hierarchy_path {
        Ok(())
    } else {
        Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
    }
}

pub(super) fn hierarchy_entry_ids(
    hierarchy_path: &str,
) -> Result<Vec<Uuid>, FilesystemError> {
    let entry_ids = hierarchy_path
        .split('.')
        .map(|label| {
            let Some(entry_id) = label.strip_prefix('n') else {
                return Err(FilesystemError::Invariant(
                    "hierarchy_path_mismatch",
                ));
            };
            if entry_id.len() != 32
                || !entry_id.bytes().all(|character| {
                    character.is_ascii_digit()
                        || (b'a'..=b'f').contains(&character)
                })
            {
                return Err(FilesystemError::Invariant(
                    "hierarchy_path_mismatch",
                ));
            }
            let entry_id = Uuid::parse_str(entry_id).map_err(|_| {
                FilesystemError::Invariant("hierarchy_path_mismatch")
            })?;
            if uuid_label(entry_id) != label {
                return Err(FilesystemError::Invariant(
                    "hierarchy_path_mismatch",
                ));
            }
            Ok(entry_id)
        })
        .collect::<Result<Vec<_>, _>>()?;
    verify_hierarchy_path(&entry_ids, hierarchy_path)
        .map_err(|_| FilesystemError::Invariant("hierarchy_path_mismatch"))?;
    Ok(entry_ids)
}

pub(super) fn descendant_expr(hierarchy_path: &str) -> SimpleExpr {
    Expr::col((file_entry::Entity, file_entry::Column::HierarchyPath))
        .contained(Expr::val(hierarchy_path.to_string()).cast_as(PgLTree))
}

pub(super) fn ancestor_expr(hierarchy_path: &str) -> SimpleExpr {
    Expr::col((file_entry::Entity, file_entry::Column::HierarchyPath))
        .contains(Expr::val(hierarchy_path.to_string()).cast_as(PgLTree))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_paths_use_only_lowercase_uuid_labels() {
        let root_id = Uuid::from_u128(0x018f0000000700080000000000000002);
        let directory_id = Uuid::from_u128(0x018f0000000700080000000000000001);
        let root_label = "n018f0000000700080000000000000002";
        let directory_label = "n018f0000000700080000000000000001";

        assert_eq!(uuid_label(root_id), root_label);
        assert_eq!(root_hierarchy_path(root_id), root_label);
        assert_eq!(
            child_hierarchy_path(root_label, directory_id),
            format!("{root_label}.{directory_label}")
        );
    }

    #[test]
    fn expected_hierarchy_path_requires_exact_nonempty_uuid_chain() {
        let root_id = Uuid::from_u128(1);
        let directory_id = Uuid::from_u128(2);
        let expected =
            "n00000000000000000000000000000001.n00000000000000000000000000000002";

        assert_eq!(
            expected_hierarchy_path(&[root_id, directory_id]).unwrap(),
            expected
        );
        assert!(
            verify_hierarchy_path(&[root_id, directory_id], expected).is_ok()
        );
        assert!(matches!(
            expected_hierarchy_path(&[]),
            Err(FilesystemError::Invariant("hierarchy_path_empty"))
        ));
        assert!(matches!(
            verify_hierarchy_path(&[root_id, directory_id], "nwrong"),
            Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
        ));
    }

    #[test]
    fn hierarchy_entry_ids_requires_canonical_nonempty_labels() {
        let root_id = Uuid::from_u128(1);
        let directory_id = Uuid::from_u128(2);
        let hierarchy_path =
            expected_hierarchy_path(&[root_id, directory_id]).unwrap();

        assert_eq!(
            hierarchy_entry_ids(&hierarchy_path).unwrap(),
            vec![root_id, directory_id]
        );
        for hierarchy_path in [
            "",
            "nwrong",
            "n0000000000000000000000000000000A",
            "n00000000000000000000000000000001..n00000000000000000000000000000002",
        ] {
            assert!(matches!(
                hierarchy_entry_ids(hierarchy_path),
                Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
            ));
        }
    }
}
