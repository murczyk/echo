use super::*;
use crate::config::{ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE};
use crate::devices::filesystem::FilesystemRepository;
use crate::devices::schema_tests::device_active_model;
use crate::entities::{login, organism, system_settings};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, TransactionTrait,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

async fn enable_devices_section(dbx: &DatabaseConnection) {
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(dbx)
    .await
    .unwrap();
}

fn actor(login: &str, organism_id: i64, roles: &[&str]) -> DeviceActor {
    crate::devices::access::test_support::device_actor(
        login,
        organism_id,
        roles,
    )
}

async fn insert_login(
    dbx: &DatabaseConnection,
    organism_id: i64,
    roles: &[&str],
) -> login::Model {
    mk_login(
        dbx,
        login::ActiveModel {
            login: Set(format!("device-visibility-{}", Uuid::now_v7())),
            roles: Set(json!(roles)),
            organism_id: Set(Some(organism_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn insert_device(
    dbx: &DatabaseConnection,
    created_by: &str,
    organism_id: i64,
    archived: bool,
) -> device::Model {
    let source_label = format!("device-visibility-{}", Uuid::now_v7());
    device_active_model(
        created_by,
        organism_id,
        &source_label,
        Some("Visibility device"),
        json!({}),
        archived,
        archived.then(|| Utc::now().naive_utc()),
    )
    .insert(dbx)
    .await
    .unwrap()
}

async fn insert_organism(dbx: &DatabaseConnection) -> organism::Model {
    mk_organism(
        dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap()
}
async fn insert_child_organism(
    dbx: &DatabaseConnection,
    parent_id: i64,
) -> organism::Model {
    mk_organism(
        dbx,
        organism::ActiveModel {
            parent_id: Set(Some(parent_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

fn assert_not_found(result: Result<device::Model, AppError>) {
    assert!(matches!(result, Err(AppError::NotFound)));
}

fn assert_archived_device_error(error: AppError) {
    match error {
        AppError::Form(errors) => {
            assert_eq!(
                errors.get("device_id").map(String::as_str),
                Some("Архівований пристрій не можна редагувати"),
            );
        }
        error => {
            panic!("expected archived-device form error, got {error:?}")
        }
    }
}

fn assert_device_operation_forbidden(error: AppError) {
    match error {
        AppError::Forbidden(message) => {
            assert_eq!(message, "device operation is forbidden");
        }
        error => {
            panic!("expected device-operation forbidden error, got {error:?}")
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn visibility_reads_same_organism_and_hides_other_organisms() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    enable_devices_section(&env.dbx).await;
    let reader_organism = insert_organism(&env.dbx).await;
    let other_organism = insert_organism(&env.dbx).await;
    let reader =
        insert_login(&env.dbx, reader_organism.id, &[ROLE_CYBER]).await;
    let owner = insert_login(&env.dbx, reader_organism.id, &[]).await;
    let other_owner = insert_login(&env.dbx, other_organism.id, &[]).await;
    let active =
        insert_device(&env.dbx, &owner.login, reader_organism.id, false).await;
    let archived =
        insert_device(&env.dbx, &owner.login, reader_organism.id, true).await;
    let other_device =
        insert_device(&env.dbx, &other_owner.login, other_organism.id, false)
            .await;
    let actor = actor(&reader.login, reader_organism.id, &[ROLE_CYBER]);
    let main_db = MainDb::new(&env.dbx);

    assert_ne!(active.created_by, reader.login);
    assert_eq!(
        DeviceVisibility::find_for_read(
            &main_db,
            &actor,
            active.id,
            DeviceReadScope::ActiveOnly,
        )
        .await
        .unwrap()
        .id,
        active.id,
    );
    assert_eq!(
        DeviceVisibility::find_for_read(
            &main_db,
            &actor,
            archived.id,
            DeviceReadScope::IncludeArchived,
        )
        .await
        .unwrap()
        .id,
        archived.id,
    );

    assert_not_found(
        DeviceVisibility::find_for_read(
            &main_db,
            &actor,
            archived.id,
            DeviceReadScope::ActiveOnly,
        )
        .await,
    );
    assert_not_found(
        DeviceVisibility::find_for_read(
            &main_db,
            &actor,
            other_device.id,
            DeviceReadScope::IncludeArchived,
        )
        .await,
    );
    assert_not_found(
        DeviceVisibility::find_for_read(
            &main_db,
            &actor,
            Uuid::now_v7(),
            DeviceReadScope::ActiveOnly,
        )
        .await,
    );
    assert_eq!(
        DeviceVisibility::verify_file_registry_access(
            MainDb::new(&env.dbx),
            &actor,
            archived.id,
            FileRegistryDeviceAccess::Read,
        )
        .await
        .unwrap(),
        archived.id,
    );
    assert!(matches!(
        DeviceVisibility::verify_file_registry_access(
            MainDb::new(&env.dbx),
            &actor,
            other_device.id,
            FileRegistryDeviceAccess::Read,
        )
        .await,
        Err(AppError::NotFound)
    ));
}
#[tokio::test]
#[serial_test::serial]
async fn visibility_includes_transitive_descendants_but_not_ancestors_or_siblings(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    enable_devices_section(&env.dbx).await;
    let root = insert_organism(&env.dbx).await;
    let child = insert_child_organism(&env.dbx, root.id).await;
    let grandchild = insert_child_organism(&env.dbx, child.id).await;
    let sibling = insert_child_organism(&env.dbx, root.id).await;
    let unrelated = insert_organism(&env.dbx).await;

    let root_owner = insert_login(&env.dbx, root.id, &[]).await;
    let child_owner = insert_login(&env.dbx, child.id, &[]).await;
    let grandchild_owner = insert_login(&env.dbx, grandchild.id, &[]).await;
    let sibling_owner = insert_login(&env.dbx, sibling.id, &[]).await;
    let unrelated_owner = insert_login(&env.dbx, unrelated.id, &[]).await;
    let root_device =
        insert_device(&env.dbx, &root_owner.login, root.id, false).await;
    let child_device =
        insert_device(&env.dbx, &child_owner.login, child.id, false).await;
    let grandchild_device =
        insert_device(&env.dbx, &grandchild_owner.login, grandchild.id, false)
            .await;
    let sibling_device =
        insert_device(&env.dbx, &sibling_owner.login, sibling.id, false).await;
    let unrelated_device =
        insert_device(&env.dbx, &unrelated_owner.login, unrelated.id, false)
            .await;

    let root_actor = actor("root-reader", root.id, &[ROLE_CYBER]);
    let child_actor = actor("child-reader", child.id, &[ROLE_CYBER]);
    let root_visible_ids =
        DeviceVisibility::query(&root_actor, DeviceReadScope::IncludeArchived)
            .unwrap()
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect::<BTreeSet<_>>();
    assert_eq!(
        root_visible_ids,
        BTreeSet::from([
            root_device.id,
            child_device.id,
            grandchild_device.id,
            sibling_device.id,
        ]),
    );

    let child_visible_ids =
        DeviceVisibility::query(&child_actor, DeviceReadScope::IncludeArchived)
            .unwrap()
            .all(&env.dbx)
            .await
            .unwrap()
            .into_iter()
            .map(|device| device.id)
            .collect::<BTreeSet<_>>();
    assert_eq!(
        child_visible_ids,
        BTreeSet::from([child_device.id, grandchild_device.id]),
    );
    assert!(!root_visible_ids.contains(&unrelated_device.id));

    assert_eq!(
        DeviceVisibility::verify_file_registry_access(
            MainDb::new(&env.dbx),
            &root_actor,
            grandchild_device.id,
            FileRegistryDeviceAccess::Read,
        )
        .await
        .unwrap(),
        grandchild_device.id,
    );
    assert_not_found(
        DeviceVisibility::find_for_read(
            &MainDb::new(&env.dbx),
            &child_actor,
            root_device.id,
            DeviceReadScope::IncludeArchived,
        )
        .await,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn visibility_enforces_write_gates_archived_form_and_transaction_lock() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    enable_devices_section(&env.dbx).await;
    let organism = insert_organism(&env.dbx).await;
    let owner = insert_login(&env.dbx, organism.id, &[]).await;
    let active =
        insert_device(&env.dbx, &owner.login, organism.id, false).await;
    let archived =
        insert_device(&env.dbx, &owner.login, organism.id, true).await;
    let cyber = actor("cyber", organism.id, &[ROLE_CYBER]);
    let source = actor("source", organism.id, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor("analyst", organism.id, &[ROLE_DEVICE_ANALYST]);

    assert_device_operation_forbidden(
        cyber.require_source_write().unwrap_err(),
    );
    assert_device_operation_forbidden(
        cyber.require_analytical_write().unwrap_err(),
    );
    source.require_source_write().unwrap();
    assert_device_operation_forbidden(
        source.require_analytical_write().unwrap_err(),
    );
    analyst.require_source_write().unwrap();
    analyst.require_analytical_write().unwrap();

    assert_device_operation_forbidden(
        DeviceVisibility::verify_file_registry_access(
            MainDb::new(&env.dbx),
            &cyber,
            active.id,
            FileRegistryDeviceAccess::SourceWrite,
        )
        .await
        .unwrap_err(),
    );
    assert_eq!(
        DeviceVisibility::verify_file_registry_access(
            MainDb::new(&env.dbx),
            &source,
            active.id,
            FileRegistryDeviceAccess::SourceWrite,
        )
        .await
        .unwrap(),
        active.id,
    );

    let main_db = MainDb::new(&env.dbx);
    assert_archived_device_error(
        DeviceVisibility::find_active_for_write(&main_db, &source, archived.id)
            .await
            .unwrap_err(),
    );

    let transaction = env.dbx.begin().await.unwrap();
    assert_eq!(
        DeviceVisibility::find_active_for_update(
            &MainDb::new(&transaction),
            &analyst,
            active.id,
        )
        .await
        .unwrap()
        .id,
        active.id,
    );
    transaction.rollback().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn file_registry_handoff_releases_the_single_slot_main_pool() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    enable_devices_section(&env.dbx).await;
    let organism = insert_organism(&env.dbx).await;
    let owner = insert_login(&env.dbx, organism.id, &[]).await;
    let device =
        insert_device(&env.dbx, &owner.login, organism.id, false).await;
    let actor = actor("source", organism.id, &[ROLE_DEVICE_SOURCE]);
    let main_pool = crate::new_pg_pool_from_conn_string_with_max_connections(
        crate::mk_conn_string(&env.config),
        1,
    )
    .await
    .unwrap();

    let verified_device_id = DeviceVisibility::verify_file_registry_access(
        MainDb::new(&main_pool),
        &actor,
        device.id,
        FileRegistryDeviceAccess::SourceWrite,
    )
    .await
    .unwrap();

    let transaction = timeout(Duration::from_secs(5), main_pool.begin())
        .await
        .expect("main pool slot was not released")
        .unwrap();
    let roots = FilesystemRepository::new(&env.file_registry_db)
        .list_roots(verified_device_id)
        .await
        .unwrap();
    assert!(roots.is_empty());
    transaction.rollback().await.unwrap();
    main_pool.close().await.unwrap();
}
