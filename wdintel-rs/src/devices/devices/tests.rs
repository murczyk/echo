use super::bl::{create, list, read, unit_stats, update};
use super::query::{
    active_aor_reference_query, active_unit_reference_query, hydrate_devices,
    DeviceReadScope,
};
use super::types::*;
use crate::config::{
    DEVICE_CUSTOM_FIELDS_MAX_COUNT, ROLE_ADMIN, ROLE_CYBER,
    ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::devices::access;
use crate::devices::tests::schema::device_active_model;
use crate::entities::{
    area_of_responsibility, device, device_aor, login, organism, sigint_unit,
};
use crate::functest::tests::{
    cleanup_locked, mk_aor, mk_login, mk_organism, mk_sigint_unit,
};
use crate::types::{AppError, BTreeMap};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection,
    DbBackend, EntityTrait, QueryFilter, QueryOrder, QueryTrait,
};
use serde_json::json;
use uuid::Uuid;

fn update_command(device_id: Uuid) -> UpdateDeviceCommand {
    UpdateDeviceCommand {
        device_id,
        source_label: DevicePatchField::Missing,
        external_url: DevicePatchField::Missing,
        custom_fields: DevicePatchField::Missing,
        name: DevicePatchField::Missing,
        aor_ids: DevicePatchField::Missing,
        unit_id: DevicePatchField::Missing,
    }
}

fn login_with_roles(login: &login::Model, roles: &[&str]) -> login::Model {
    access::login_with_roles(login, roles)
}

fn list_command() -> ListDevicesCommand {
    ListDevicesCommand {
        filter_text: None,
        archived_scope: DeviceArchivedScope::ActiveOnly,
        needs_analytical_name: None,
        aor_ids: Vec::new(),
        unit_ids: Vec::new(),
        limit: None,
        offset: None,
        sort_by: Vec::new(),
    }
}

async fn insert_login(
    dbx: &DatabaseConnection,
    roles: &[&str],
) -> login::Model {
    let organism_id = match organism::Entity::find()
        .order_by_asc(organism::Column::Id)
        .one(dbx)
        .await
        .unwrap()
    {
        Some(organism) => organism.id,
        None => {
            mk_organism(
                dbx,
                organism::ActiveModel {
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .id
        }
    };
    mk_login(
        dbx,
        login::ActiveModel {
            login: Set(format!("device-service-{}", Uuid::now_v7())),
            roles: Set(json!(roles)),
            organism_id: Set(Some(organism_id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn link_device_aor(
    dbx: &DatabaseConnection,
    device_id: Uuid,
    aor_id: i64,
) -> device_aor::Model {
    device_aor::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(device_id),
        aor_id: Set(aor_id),
        created_at: Set(Utc::now().naive_utc()),
    }
    .insert(dbx)
    .await
    .unwrap()
}

async fn current_aor_links(
    dbx: &DatabaseConnection,
    device_id: Uuid,
) -> Vec<device_aor::Model> {
    device_aor::Entity::find()
        .filter(device_aor::Column::DeviceId.eq(device_id))
        .order_by_asc(device_aor::Column::AorId)
        .all(dbx)
        .await
        .unwrap()
}

fn assert_form_error(error: AppError, field: &str, message: &str) {
    match error {
        AppError::Form(errors) => {
            assert_eq!(errors.get(field).map(String::as_str), Some(message))
        }
        error => panic!("expected form error, got {error:?}"),
    }
}

fn assert_forbidden(error: AppError) {
    match error {
        AppError::Forbidden(message) => {
            assert_eq!(message, "device operation is forbidden");
        }
        error => panic!("expected forbidden error, got {error:?}"),
    }
}

#[tokio::test]
#[serial_test::serial]
async fn batch_hydration_preserves_input_order_and_current_references() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let actor = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let first_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("First AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Second AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(source_login.id),
            name: Set("Current unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut first_device = device_active_model(
        &source_login.login,
        source_login.organism_id.unwrap(),
        "source-first",
        Some("First device"),
        json!({"inventory_id": "one"}),
        false,
        None,
    );
    first_device.unit_id = Set(Some(unit.id));
    first_device.external_url =
        Set(Some("https://example.com/first".to_string()));
    let first_device = first_device.insert(&env.dbx).await.unwrap();
    let second_device = device_active_model(
        &source_login.login,
        source_login.organism_id.unwrap(),
        "source-second",
        None,
        json!({}),
        false,
        None,
    )
    .insert(&env.dbx)
    .await
    .unwrap();

    for aor_id in [second_aor.id, first_aor.id] {
        device_aor::ActiveModel {
            id: Set(Uuid::now_v7()),
            device_id: Set(first_device.id),
            aor_id: Set(aor_id),
            created_at: Set(Utc::now().naive_utc()),
        }
        .insert(&env.dbx)
        .await
        .unwrap();
    }

    let main_db = env.dbx.clone();
    assert!(hydrate_devices(&main_db, Vec::new())
        .await
        .unwrap()
        .is_empty());
    let states = hydrate_devices(
        &main_db,
        vec![second_device.clone(), first_device.clone()],
    )
    .await
    .unwrap();

    assert_eq!(
        states.iter().map(|state| state.id).collect::<Vec<_>>(),
        [second_device.id, first_device.id,]
    );
    assert_eq!(states[0].name, None);
    assert_eq!(states[1].source_label, "source-first");
    assert_eq!(
        states[1].aors.iter().map(|aor| aor.id).collect::<Vec<_>>(),
        [first_aor.id, second_aor.id]
    );
    assert_eq!(
        states[1]
            .unit
            .as_ref()
            .map(|unit| (unit.id, unit.name.as_str())),
        Some((unit.id, "Current unit"))
    );

    let state = read(
        &main_db,
        &actor,
        first_device.id,
        DeviceReadScope::ActiveOnly,
    )
    .await
    .unwrap();
    assert_eq!(state.id, first_device.id);
}

#[tokio::test]
#[serial_test::serial]
async fn source_create_persists_only_normalized_source_state() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let actor = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let main_db = env.dbx.clone();

    let state = create(
        &main_db,
        &actor,
        CreateDeviceCommand {
            source_label: "  device-source  ".to_string(),
            external_url: Some(" https://example.com ".to_string()),
            custom_fields: Some(BTreeMap::from([(
                " inventory_id ".to_string(),
                "node-1".to_string(),
            )])),
        },
    )
    .await
    .unwrap();
    let another_state = create(
        &main_db,
        &actor,
        CreateDeviceCommand {
            source_label: "device-source".to_string(),
            external_url: None,
            custom_fields: None,
        },
    )
    .await
    .unwrap();

    assert_ne!(state.id, another_state.id);
    assert_eq!(state.source_label, "device-source");
    assert_eq!(state.name, None);
    assert!(state.aors.is_empty());
    assert_eq!(state.unit, None);
    assert_eq!(state.external_url.as_deref(), Some("https://example.com/"));
    assert_eq!(
        state.custom_fields,
        BTreeMap::from([("inventory_id".to_string(), "node-1".to_string())])
    );
    assert_eq!(state.created_by, source_login.login);
    assert!(!state.archived);
    assert_eq!(state.created_at, state.updated_at);

    let device = device::Entity::find_by_id(state.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(device.name, None);
    assert_eq!(device.unit_id, None);
    assert_eq!(device.tags, json!([]));
    assert_eq!(device.organism_id, source_login.organism_id.unwrap());
    assert_eq!(device.archived_at, None);
}

#[tokio::test]
#[serial_test::serial]
async fn analyst_mixed_update_is_atomic_and_source_cannot_change_analysis() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let main_db = env.dbx.clone();
    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "initial source".to_string(),
            external_url: None,
            custom_fields: None,
        },
    )
    .await
    .unwrap();
    let aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Update AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(analyst_login.id),
            name: Set("Update unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut command = update_command(created.id);
    command.source_label =
        DevicePatchField::Value("  updated source  ".to_string());
    command.external_url = DevicePatchField::Value(Some(
        "https://example.com/updated".to_string(),
    ));
    command.custom_fields = DevicePatchField::Value(BTreeMap::from([(
        " inventory_id ".to_string(),
        Some("node-2".to_string()),
    )]));
    command.name =
        DevicePatchField::Value(Some("  Updated device  ".to_string()));
    command.aor_ids = DevicePatchField::Value(vec![aor.id]);
    command.unit_id = DevicePatchField::Value(Some(unit.id));

    let updated = update(&main_db, &analyst, command).await.unwrap();

    assert_eq!(updated.source_label, "updated source");
    assert_eq!(
        updated.external_url.as_deref(),
        Some("https://example.com/updated")
    );
    assert_eq!(
        updated.custom_fields,
        BTreeMap::from([("inventory_id".to_string(), "node-2".to_string())])
    );
    assert_eq!(updated.name.as_deref(), Some("Updated device"));
    assert_eq!(
        updated.aors.iter().map(|aor| aor.id).collect::<Vec<_>>(),
        [aor.id]
    );
    assert_eq!(
        updated
            .unit
            .as_ref()
            .map(|unit| (unit.id, unit.name.as_str())),
        Some((unit.id, "Update unit"))
    );
    assert_ne!(updated.updated_at, created.updated_at);

    let mut forbidden_command = update_command(created.id);
    forbidden_command.name =
        DevicePatchField::Value(Some("Source cannot set this".to_string()));
    let error = update(&main_db, &source, forbidden_command)
        .await
        .unwrap_err();
    assert!(matches!(error, AppError::Forbidden(_)));
    assert_eq!(
        device::Entity::find_by_id(created.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .name
            .as_deref(),
        Some("Updated device")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn create_allows_source_analyst_and_admin_but_not_cyber() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let admin_login = insert_login(&env.dbx, &[ROLE_ADMIN]).await;
    let cyber_login = insert_login(&env.dbx, &[ROLE_CYBER]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let admin = login_with_roles(&admin_login, &[ROLE_ADMIN]);
    let cyber = login_with_roles(&cyber_login, &[ROLE_CYBER]);
    let main_db = env.dbx.clone();

    for (login, actor) in [
        (&source_login, &source),
        (&analyst_login, &analyst),
        (&admin_login, &admin),
    ] {
        let state = create(
            &main_db,
            actor,
            CreateDeviceCommand {
                source_label: format!("create-role-{}", Uuid::now_v7()),
                external_url: None,
                custom_fields: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(state.created_by, login.login);
    }

    assert_forbidden(
        create(
            &main_db,
            &cyber,
            CreateDeviceCommand {
                source_label: "   ".to_string(),
                external_url: Some("not a URL".to_string()),
                custom_fields: None,
            },
        )
        .await
        .unwrap_err(),
    );

    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "authorization target".to_string(),
            external_url: None,
            custom_fields: None,
        },
    )
    .await
    .unwrap();
    let mut malformed_mixed = update_command(created.id);
    malformed_mixed.source_label = DevicePatchField::Value("   ".to_string());
    malformed_mixed.name = DevicePatchField::Value(Some("   ".to_string()));
    assert_forbidden(
        update(&main_db, &cyber, malformed_mixed).await.unwrap_err(),
    );
    assert_eq!(
        device::Entity::find_by_id(created.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .source_label,
        "authorization target"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn patch_presence_and_clears_follow_the_internal_contract() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let cyber_login = insert_login(&env.dbx, &[ROLE_CYBER]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let cyber = login_with_roles(&cyber_login, &[ROLE_CYBER]);
    let main_db = env.dbx.clone();
    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "presence source".to_string(),
            external_url: Some("https://example.com/original".to_string()),
            custom_fields: Some(BTreeMap::from([(
                "source_key".to_string(),
                "source value".to_string(),
            )])),
        },
    )
    .await
    .unwrap();
    let first_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("First presence AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Second presence AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(analyst_login.id),
            name: Set("Presence unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut source_patch = update_command(created.id);
    source_patch.source_label =
        DevicePatchField::Value("  presence source updated  ".to_string());
    let source_updated = update(&main_db, &source, source_patch).await.unwrap();
    assert_eq!(source_updated.source_label, "presence source updated");

    let mut analytical_patch = update_command(created.id);
    analytical_patch.name =
        DevicePatchField::Value(Some("Presence device".to_string()));
    analytical_patch.aor_ids =
        DevicePatchField::Value(vec![second_aor.id, first_aor.id]);
    analytical_patch.unit_id = DevicePatchField::Value(Some(unit.id));
    let analytical_updated =
        update(&main_db, &analyst, analytical_patch).await.unwrap();
    assert_eq!(
        analytical_updated
            .aors
            .iter()
            .map(|aor| aor.id)
            .collect::<Vec<_>>(),
        [first_aor.id, second_aor.id]
    );

    assert_form_error(
        update(&main_db, &analyst, update_command(created.id))
            .await
            .unwrap_err(),
        "patch",
        "Потрібно передати хоча б одне поле для зміни",
    );
    let mut empty_custom_fields = update_command(created.id);
    empty_custom_fields.custom_fields =
        DevicePatchField::Value(BTreeMap::new());
    assert_form_error(
        update(&main_db, &source, empty_custom_fields)
            .await
            .unwrap_err(),
        "patch",
        "Потрібно передати хоча б одне поле для зміни",
    );
    let mut unauthorized_empty_custom_fields = update_command(created.id);
    unauthorized_empty_custom_fields.custom_fields =
        DevicePatchField::Value(BTreeMap::new());
    assert_forbidden(
        update(&main_db, &cyber, unauthorized_empty_custom_fields)
            .await
            .unwrap_err(),
    );

    let mut clears = update_command(created.id);
    clears.external_url = DevicePatchField::Value(None);
    clears.name = DevicePatchField::Value(None);
    clears.aor_ids = DevicePatchField::Value(Vec::new());
    clears.unit_id = DevicePatchField::Value(None);
    let cleared = update(&main_db, &analyst, clears).await.unwrap();
    assert_eq!(cleared.external_url, None);
    assert_eq!(cleared.name, None);
    assert!(cleared.aors.is_empty());
    assert_eq!(cleared.unit, None);
}

#[tokio::test]
#[serial_test::serial]
async fn invalid_references_roll_back_mixed_patches_and_reject_deleted_rows() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let main_db = env.dbx.clone();
    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "rollback source".to_string(),
            external_url: None,
            custom_fields: Some(BTreeMap::from([(
                "stable".to_string(),
                "value".to_string(),
            )])),
        },
    )
    .await
    .unwrap();
    let active_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Active rollback AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let active_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(analyst_login.id),
            name: Set("Active rollback unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut setup = update_command(created.id);
    setup.name = DevicePatchField::Value(Some("Stable name".to_string()));
    setup.aor_ids = DevicePatchField::Value(vec![active_aor.id]);
    setup.unit_id = DevicePatchField::Value(Some(active_unit.id));
    update(&main_db, &analyst, setup).await.unwrap();
    let before =
        read(&main_db, &analyst, created.id, DeviceReadScope::ActiveOnly)
            .await
            .unwrap();
    let links_before = current_aor_links(&env.dbx, created.id).await;

    let mut invalid_mixed = update_command(created.id);
    invalid_mixed.source_label =
        DevicePatchField::Value("should roll back".to_string());
    invalid_mixed.custom_fields = DevicePatchField::Value(BTreeMap::from([(
        "stable".to_string(),
        Some("changed".to_string()),
    )]));
    invalid_mixed.name =
        DevicePatchField::Value(Some("Should roll back".to_string()));
    invalid_mixed.aor_ids = DevicePatchField::Value(vec![i64::MAX]);
    invalid_mixed.unit_id = DevicePatchField::Value(Some(active_unit.id));
    assert_form_error(
        update(&main_db, &analyst, invalid_mixed).await.unwrap_err(),
        "aor_ids",
        "Смугу не знайдено",
    );
    let after =
        read(&main_db, &analyst, created.id, DeviceReadScope::ActiveOnly)
            .await
            .unwrap();
    assert_eq!(after, before);
    let links_after = current_aor_links(&env.dbx, created.id).await;
    assert_eq!(
        links_after
            .iter()
            .map(|link| (link.id, link.created_at))
            .collect::<Vec<_>>(),
        links_before
            .iter()
            .map(|link| (link.id, link.created_at))
            .collect::<Vec<_>>()
    );

    let mut duplicate_aors = update_command(created.id);
    duplicate_aors.aor_ids =
        DevicePatchField::Value(vec![active_aor.id, active_aor.id]);
    assert_form_error(
        update(&main_db, &analyst, duplicate_aors)
            .await
            .unwrap_err(),
        "aor_ids",
        "Смуги не можуть повторюватися",
    );

    let deleted_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Deleted rollback AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    area_of_responsibility::ActiveModel {
        id: Set(deleted_aor.id),
        deleted: Set(true),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let mut deleted_aor_patch = update_command(created.id);
    deleted_aor_patch.aor_ids = DevicePatchField::Value(vec![deleted_aor.id]);
    assert_form_error(
        update(&main_db, &analyst, deleted_aor_patch)
            .await
            .unwrap_err(),
        "aor_ids",
        "Смугу не знайдено",
    );

    let mut missing_unit_patch = update_command(created.id);
    missing_unit_patch.unit_id = DevicePatchField::Value(Some(i64::MAX));
    assert_form_error(
        update(&main_db, &analyst, missing_unit_patch)
            .await
            .unwrap_err(),
        "unit_id",
        "Підрозділ не знайдено",
    );

    let deleted_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(analyst_login.id),
            name: Set("Deleted rollback unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sigint_unit::ActiveModel {
        id: Set(deleted_unit.id),
        deleted: Set(true),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let mut deleted_unit_patch = update_command(created.id);
    deleted_unit_patch.unit_id = DevicePatchField::Value(Some(deleted_unit.id));
    assert_form_error(
        update(&main_db, &analyst, deleted_unit_patch)
            .await
            .unwrap_err(),
        "unit_id",
        "Підрозділ не знайдено",
    );
}

#[tokio::test]
#[serial_test::serial]
async fn custom_field_patches_and_effective_no_ops_preserve_state() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let main_db = env.dbx.clone();
    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "no-op source".to_string(),
            external_url: None,
            custom_fields: Some(BTreeMap::from([
                ("remove".to_string(), "value".to_string()),
                ("keep".to_string(), "stable".to_string()),
            ])),
        },
    )
    .await
    .unwrap();
    let first_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("First no-op AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Second no-op AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut assign_aors = update_command(created.id);
    assign_aors.aor_ids =
        DevicePatchField::Value(vec![first_aor.id, second_aor.id]);
    update(&main_db, &analyst, assign_aors).await.unwrap();

    let mut merge = update_command(created.id);
    merge.custom_fields = DevicePatchField::Value(BTreeMap::from([
        ("remove".to_string(), None),
        ("added".to_string(), Some("new value".to_string())),
    ]));
    let merged = update(&main_db, &analyst, merge).await.unwrap();
    assert_eq!(
        merged.custom_fields,
        BTreeMap::from([
            ("added".to_string(), "new value".to_string()),
            ("keep".to_string(), "stable".to_string()),
        ])
    );

    let mut collision = update_command(created.id);
    collision.custom_fields = DevicePatchField::Value(BTreeMap::from([
        (" added ".to_string(), Some("one".to_string())),
        ("added".to_string(), Some("two".to_string())),
    ]));
    assert_form_error(
        update(&main_db, &analyst, collision).await.unwrap_err(),
        "custom_fields",
        "Ключі кастомних полів мають бути унікальними",
    );

    let before = device::Entity::find_by_id(created.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let links_before = current_aor_links(&env.dbx, created.id).await;
    let mut no_op = update_command(created.id);
    no_op.source_label =
        DevicePatchField::Value("  no-op source  ".to_string());
    no_op.aor_ids = DevicePatchField::Value(vec![second_aor.id, first_aor.id]);
    no_op.custom_fields =
        DevicePatchField::Value(BTreeMap::from([("absent".to_string(), None)]));
    let no_op_state = update(&main_db, &analyst, no_op).await.unwrap();
    assert_eq!(no_op_state.updated_at, before.updated_at);
    let after = device::Entity::find_by_id(created.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let links_after = current_aor_links(&env.dbx, created.id).await;
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(
        links_after
            .iter()
            .map(|link| (link.id, link.created_at))
            .collect::<Vec<_>>(),
        links_before
            .iter()
            .map(|link| (link.id, link.created_at))
            .collect::<Vec<_>>()
    );

    let full_custom_fields = (0..DEVICE_CUSTOM_FIELDS_MAX_COUNT)
        .map(|index| (format!("key-{index}"), format!("value-{index}")))
        .collect();
    let full = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "full custom fields".to_string(),
            external_url: None,
            custom_fields: Some(full_custom_fields),
        },
    )
    .await
    .unwrap();
    let mut over_limit = update_command(full.id);
    over_limit.custom_fields = DevicePatchField::Value(BTreeMap::from([(
        "one-more".to_string(),
        Some("value".to_string()),
    )]));
    assert_form_error(
        update(&main_db, &analyst, over_limit).await.unwrap_err(),
        "custom_fields",
        "Забагато кастомних полів",
    );
}

#[tokio::test]
#[serial_test::serial]
async fn read_handles_archives_nullable_names_and_deleted_references() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = insert_login(&env.dbx, &[ROLE_DEVICE_SOURCE]).await;
    let analyst_login = insert_login(&env.dbx, &[ROLE_DEVICE_ANALYST]).await;
    let source = login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let analyst = login_with_roles(&analyst_login, &[ROLE_DEVICE_ANALYST]);
    let main_db = env.dbx.clone();
    let created = create(
        &main_db,
        &source,
        CreateDeviceCommand {
            source_label: "read source".to_string(),
            external_url: Some("https://example.com/read".to_string()),
            custom_fields: Some(BTreeMap::from([(
                "read_key".to_string(),
                "read value".to_string(),
            )])),
        },
    )
    .await
    .unwrap();
    let first_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Deleted-first AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Deleted-second AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(analyst_login.id),
            name: Set("Deleted read unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut assign_references = update_command(created.id);
    assign_references.aor_ids =
        DevicePatchField::Value(vec![second_aor.id, first_aor.id]);
    assign_references.unit_id = DevicePatchField::Value(Some(unit.id));
    update(&main_db, &analyst, assign_references).await.unwrap();
    area_of_responsibility::ActiveModel {
        id: Set(first_aor.id),
        deleted: Set(true),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    sigint_unit::ActiveModel {
        id: Set(unit.id),
        deleted: Set(true),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    device::ActiveModel {
        id: Set(created.id),
        archived: Set(true),
        archived_at: Set(Some(Utc::now().naive_utc())),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();

    assert!(matches!(
        read(&main_db, &analyst, created.id, DeviceReadScope::ActiveOnly,)
            .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        read(
            &main_db,
            &analyst,
            Uuid::now_v7(),
            DeviceReadScope::IncludeArchived,
        )
        .await,
        Err(AppError::NotFound)
    ));
    let state = read(
        &main_db,
        &analyst,
        created.id,
        DeviceReadScope::IncludeArchived,
    )
    .await
    .unwrap();
    assert_eq!(state.name, None);
    assert_eq!(state.source_label, "read source");
    assert_eq!(
        state.external_url.as_deref(),
        Some("https://example.com/read")
    );
    assert_eq!(
        state.custom_fields,
        BTreeMap::from([("read_key".to_string(), "read value".to_string())])
    );
    assert_eq!(
        state.aors.iter().map(|aor| aor.id).collect::<Vec<_>>(),
        [first_aor.id, second_aor.id]
    );
    assert_eq!(state.aors[0].name, "Deleted-first AOR");
    assert_eq!(
        state.unit.as_ref().map(|unit| unit.name.as_str()),
        Some("Deleted read unit")
    );
    assert!(state.archived);
    assert!(state.archived_at.is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn list_and_unit_stats_follow_target_filters_sorts_and_counts() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let reader = insert_login(&env.dbx, &[ROLE_CYBER]).await;
    let actor = login_with_roles(&reader, &[ROLE_CYBER]);
    let active_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(reader.id),
            name: Set("Active target unit".to_string()),
            active: Set(true),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let inactive_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by_login_id: Set(reader.id),
            name: Set("Inactive target unit".to_string()),
            active: Set(false),
            deleted: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let aor = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            name: Set("Target list AOR".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-service-other-{}", Uuid::now_v7())),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let now = Utc::now().naive_utc();

    let mut missing_name = device_active_model(
        &reader.login,
        reader.organism_id.unwrap(),
        "literal%source",
        None,
        json!({}),
        false,
        None,
    );
    missing_name.unit_id = Set(Some(active_unit.id));
    missing_name.created_at = Set(now - chrono::Duration::hours(4));
    missing_name.updated_at = Set(now - chrono::Duration::hours(4));
    let missing_name = missing_name.insert(&env.dbx).await.unwrap();
    link_device_aor(&env.dbx, missing_name.id, aor.id).await;

    let mut named = device_active_model(
        &reader.login,
        reader.organism_id.unwrap(),
        "ordinary-source",
        Some("Needle Alpha"),
        json!({}),
        false,
        None,
    );
    named.unit_id = Set(Some(inactive_unit.id));
    named.created_at = Set(now - chrono::Duration::hours(3));
    named.updated_at = Set(now - chrono::Duration::hours(3));
    let named = named.insert(&env.dbx).await.unwrap();

    let mut uuid_match = device_active_model(
        &reader.login,
        reader.organism_id.unwrap(),
        "uuid-source",
        Some("UUID device"),
        json!({}),
        false,
        None,
    );
    uuid_match.created_at = Set(now - chrono::Duration::hours(2));
    uuid_match.updated_at = Set(now - chrono::Duration::hours(2));
    let uuid_match = uuid_match.insert(&env.dbx).await.unwrap();

    let mut archived = device_active_model(
        &reader.login,
        reader.organism_id.unwrap(),
        "archived-source",
        Some("Archived device"),
        json!({}),
        true,
        Some(now),
    );
    archived.unit_id = Set(Some(active_unit.id));
    archived.created_at = Set(now - chrono::Duration::hours(1));
    archived.updated_at = Set(now - chrono::Duration::hours(1));
    archived.insert(&env.dbx).await.unwrap();

    let mut other_device = device_active_model(
        &other_login.login,
        other_organism.id,
        "literal%source",
        None,
        json!({}),
        false,
        None,
    );
    other_device.unit_id = Set(Some(active_unit.id));
    other_device.insert(&env.dbx).await.unwrap();

    let main_db = env.dbx.clone();
    let mut command = list_command();
    command.needs_analytical_name = Some(true);
    command.sort_by = vec![DeviceListSort::CreatedAtAsc];
    let result = list(&main_db, &actor, command).await.unwrap();
    assert_eq!(
        result
            .devices
            .iter()
            .map(|device| device.id)
            .collect::<Vec<_>>(),
        vec![missing_name.id],
    );
    assert_eq!(result.status_counts.active, 1);
    assert_eq!(result.status_counts.archived, 0);

    let result = list(&main_db, &actor, list_command()).await.unwrap();
    assert_eq!(result.status_counts.active, 3);
    assert_eq!(result.status_counts.archived, 1);
    assert_eq!(result.total, 3);

    for (filter_text, expected_id) in [
        ("%".to_string(), missing_name.id),
        ("Needle Alpha".to_string(), named.id),
        (uuid_match.id.to_string(), uuid_match.id),
    ] {
        let mut command = list_command();
        command.filter_text = Some(filter_text);
        let result = list(&main_db, &actor, command).await.unwrap();
        assert_eq!(
            result
                .devices
                .iter()
                .map(|device| device.id)
                .collect::<Vec<_>>(),
            vec![expected_id],
        );
    }

    let mut command = list_command();
    command.aor_ids = vec![aor.id];
    let result = list(&main_db, &actor, command).await.unwrap();
    assert_eq!(
        result
            .devices
            .iter()
            .map(|device| device.id)
            .collect::<Vec<_>>(),
        vec![missing_name.id],
    );

    let stats = unit_stats(&main_db, &actor).await.unwrap();
    assert_eq!(stats.len(), 1);
    assert_eq!(stats[0].unit.id, active_unit.id);
    assert_eq!(stats[0].count, 1);

    let mut command = list_command();
    command.sort_by =
        vec![DeviceListSort::CreatedAtAsc, DeviceListSort::CreatedAtDesc];
    assert_form_error(
        list(&main_db, &actor, command).await.unwrap_err(),
        "sort_by",
        "Один критерій сортування не може мати різні напрямки",
    );
}

#[test]
fn active_reference_queries_filter_deleted_rows_and_take_shared_locks() {
    let aor_sql = active_aor_reference_query(&[2, 1])
        .build(DbBackend::Postgres)
        .to_string();
    assert!(aor_sql.contains(r#""deleted" = FALSE"#));
    assert!(aor_sql.contains(r#"ORDER BY "area_of_responsibility"."id" ASC"#));
    assert!(aor_sql.contains("FOR SHARE"));

    let unit_sql = active_unit_reference_query(2)
        .build(DbBackend::Postgres)
        .to_string();
    assert!(unit_sql.contains(r#""deleted" = FALSE"#));
    assert!(unit_sql.contains("FOR SHARE"));
}

mod custom_fields_tests {
    use super::super::bl::custom_fields::*;
    use crate::types::BTreeMap;
    use serde_json::json;

    #[test]
    fn custom_fields_round_trip_and_patch_keep_arbitrary_keys() {
        let fields = BTreeMap::from([
            ("inventory_id".to_string(), "node-1".to_string()),
            ("source_port".to_string(), "not-a-port".to_string()),
            ("source_version".to_string(), "2026.07".to_string()),
        ]);
        let value = custom_fields_to_json(fields.clone());
        assert_eq!(custom_fields_from_json(&value).unwrap(), fields);

        let patched = apply_custom_fields_patch(
            &value,
            BTreeMap::from([
                ("source_port".to_string(), None),
                ("source_version".to_string(), Some("2026.08".to_string())),
            ]),
        )
        .unwrap();
        assert_eq!(
            patched,
            json!({
                "inventory_id": "node-1",
                "source_version": "2026.08",
            })
        );
    }

    #[test]
    fn custom_fields_reject_non_string_values() {
        assert!(custom_fields_from_json(&json!({"inventory_id": 22})).is_err());
    }
}

mod validation_tests {
    use super::super::bl::validation::*;
    use crate::config::DEVICE_EXTERNAL_URL_MAX_CHARS;
    use crate::types::{AppError, BTreeMap};

    fn assert_form_field(err: AppError, field: &str) {
        match err {
            AppError::Form(errors) => assert!(errors.contains_key(field)),
            err => panic!("unexpected error: {err:?}"),
        }
    }

    #[test]
    fn device_name_is_trimmed_and_required() {
        assert_eq!(normalize_device_name("  Device  ").unwrap(), "Device");
        assert_form_field(normalize_device_name("   ").unwrap_err(), "name");
    }

    #[test]
    fn present_external_url_requires_nonempty_http_url_with_host() {
        assert_eq!(
            normalize_present_external_url(" https://example.com ".to_string())
                .unwrap(),
            "https://example.com/"
        );

        let empty =
            normalize_present_external_url("   ".to_string()).unwrap_err();
        match empty {
            AppError::Form(errors) => assert_eq!(
                errors.get("external_url").map(String::as_str),
                Some("Посилання не може бути порожнім")
            ),
            err => panic!("unexpected error: {err:?}"),
        }
        assert_form_field(
            normalize_present_external_url("ftp://example.com".to_string())
                .unwrap_err(),
            "external_url",
        );
        assert_form_field(
            normalize_present_external_url("https:///".to_string())
                .unwrap_err(),
            "external_url",
        );
        assert_form_field(
            normalize_present_external_url(format!(
                "https://{}/",
                "a".repeat(DEVICE_EXTERNAL_URL_MAX_CHARS)
            ))
            .unwrap_err(),
            "external_url",
        );
    }

    #[test]
    fn unique_aor_ids_are_sorted_and_reject_duplicates() {
        assert_eq!(normalize_unique_aor_ids(vec![9, 2, 5]).unwrap(), [2, 5, 9]);
        assert_eq!(
            normalize_unique_aor_ids(Vec::new()).unwrap(),
            Vec::<i64>::new()
        );
        assert_form_field(
            normalize_unique_aor_ids(vec![2, 2]).unwrap_err(),
            "aor_ids",
        );
    }

    #[test]
    fn source_label_and_custom_fields_are_normalized_without_special_keys() {
        assert_eq!(
            normalize_source_label("  source-device  ").unwrap(),
            "source-device"
        );
        assert_form_field(
            normalize_source_label("   ").unwrap_err(),
            "source_label",
        );

        let fields = normalize_custom_fields(BTreeMap::from([
            (" inventory_id ".to_string(), "node-1".to_string()),
            ("source_port".to_string(), "not-a-port".to_string()),
        ]))
        .unwrap();
        assert_eq!(
            fields,
            BTreeMap::from([
                ("inventory_id".to_string(), "node-1".to_string()),
                ("source_port".to_string(), "not-a-port".to_string()),
            ])
        );

        let patch = normalize_custom_fields_patch(BTreeMap::from([
            (" inventory_id ".to_string(), Some("node-2".to_string())),
            ("source_port".to_string(), None),
        ]))
        .unwrap();
        assert_eq!(
            patch,
            BTreeMap::from([
                ("inventory_id".to_string(), Some("node-2".to_string())),
                ("source_port".to_string(), None),
            ])
        );
        assert_form_field(
            normalize_custom_fields(BTreeMap::from([(
                " ".to_string(),
                "value".to_string(),
            )]))
            .unwrap_err(),
            "custom_fields",
        );
        assert_form_field(
            normalize_custom_fields_patch(BTreeMap::from([
                (" inventory_id ".to_string(), Some("node-1".to_string())),
                ("inventory_id".to_string(), Some("node-2".to_string())),
            ]))
            .unwrap_err(),
            "custom_fields",
        );
    }
}

mod mapping_tests {
    use super::super::bl::{map_device_details, map_device_list};
    use super::super::types::{
        DeviceAorReference, DeviceCurrentState, DeviceUnitReference,
        ListDevicesResult,
    };
    use crate::devices::devices::types::DomainDeviceStatusCounts as DomainStatusCounts;
    use crate::types::BTreeMap;
    use chrono::NaiveDate;
    use serde_json::json;
    use uuid::Uuid;

    fn device_state() -> DeviceCurrentState {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 23)
            .unwrap()
            .and_hms_opt(9, 10, 11)
            .unwrap();
        DeviceCurrentState {
            id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001")
                .unwrap(),
            source_label: "source".to_string(),
            name: None,
            aors: vec![DeviceAorReference {
                id: 7,
                name: "AOR".to_string(),
            }],
            unit: Some(DeviceUnitReference {
                id: 8,
                name: "Unit".to_string(),
            }),
            external_url: Some("https://example.com".to_string()),
            custom_fields: BTreeMap::from([(
                "inventory_id".to_string(),
                "42".to_string(),
            )]),
            created_by: "reader".to_string(),
            archived: true,
            archived_at: Some(timestamp),
            created_at: timestamp,
            updated_at: timestamp,
        }
    }

    #[test]
    fn detail_and_list_have_distinct_exact_wire_shapes() {
        assert_eq!(
            serde_json::to_value(map_device_details(device_state())).unwrap(),
            json!({
                "id": "018f0000-0000-7000-8000-000000000001",
                "source_label": "source",
                "name": null,
                "aors": [{"id": 7, "name": "AOR"}],
                "unit": {"id": 8, "name": "Unit"},
                "external_url": "https://example.com",
                "custom_fields": {"inventory_id": "42"},
                "created_by": "reader",
                "archived": true,
                "created_at": "2026-07-23T09:10:11Z",
                "updated_at": "2026-07-23T09:10:11Z",
                "archived_at": "2026-07-23T09:10:11Z"
            }),
        );

        assert_eq!(
            serde_json::to_value(map_device_list(ListDevicesResult {
                devices: vec![device_state()],
                total: 1,
                has_more: false,
                status_counts: DomainStatusCounts {
                    active: 0,
                    archived: 1,
                },
            }))
            .unwrap(),
            json!({
                "list": [{
                    "id": "018f0000-0000-7000-8000-000000000001",
                    "source_label": "source",
                    "name": null,
                    "aors": [{"id": 7, "name": "AOR"}],
                    "unit": {"id": 8, "name": "Unit"},
                    "created_by": "reader",
                    "archived": true,
                    "created_at": "2026-07-23T09:10:11Z",
                    "updated_at": "2026-07-23T09:10:11Z",
                    "archived_at": "2026-07-23T09:10:11Z"
                }],
                "total": 1,
                "has_more": false,
                "status_counts": {"active": 0, "archived": 1}
            }),
        );
    }
}

mod query_tests {
    use super::super::query::*;
    use crate::config::{ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE};
    use crate::devices::access;
    use crate::devices::files::query;
    use crate::devices::tests::schema::device_active_model;
    use crate::entities::{device, login, organism, system_settings};
    use crate::error::AppError;
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use chrono::Utc;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, DatabaseConnection,
        TransactionTrait,
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

    fn login_with_roles(login: &login::Model, roles: &[&str]) -> login::Model {
        access::login_with_roles(login, roles)
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
                panic!(
                    "expected device-operation forbidden error, got {error:?}"
                )
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
            insert_device(&env.dbx, &owner.login, reader_organism.id, false)
                .await;
        let archived =
            insert_device(&env.dbx, &owner.login, reader_organism.id, true)
                .await;
        let other_device = insert_device(
            &env.dbx,
            &other_owner.login,
            other_organism.id,
            false,
        )
        .await;
        let actor = login_with_roles(&reader, &[ROLE_CYBER]);
        let main_db = env.dbx.clone();

        assert_ne!(active.created_by, reader.login);
        assert_eq!(
            find_visible_device(
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
            find_visible_device(
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
            find_visible_device(
                &main_db,
                &actor,
                archived.id,
                DeviceReadScope::ActiveOnly,
            )
            .await,
        );
        assert_not_found(
            find_visible_device(
                &main_db,
                &actor,
                other_device.id,
                DeviceReadScope::IncludeArchived,
            )
            .await,
        );
        assert_not_found(
            find_visible_device(
                &main_db,
                &actor,
                Uuid::now_v7(),
                DeviceReadScope::ActiveOnly,
            )
            .await,
        );
        assert_eq!(
            authorize_file_registry_access(
                &env.dbx,
                &actor,
                archived.id,
                FileRegistryDeviceAccess::Read,
            )
            .await
            .unwrap(),
            archived.id,
        );
        assert!(matches!(
            authorize_file_registry_access(
                &env.dbx,
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
        let grandchild_device = insert_device(
            &env.dbx,
            &grandchild_owner.login,
            grandchild.id,
            false,
        )
        .await;
        let sibling_device =
            insert_device(&env.dbx, &sibling_owner.login, sibling.id, false)
                .await;
        let unrelated_device = insert_device(
            &env.dbx,
            &unrelated_owner.login,
            unrelated.id,
            false,
        )
        .await;

        let root_actor = login_with_roles(&root_owner, &[ROLE_CYBER]);
        let child_actor = login_with_roles(&child_owner, &[ROLE_CYBER]);
        let root_visible_ids = visible_devices_query(
            &root_actor,
            DeviceReadScope::IncludeArchived,
        )
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

        let child_visible_ids = visible_devices_query(
            &child_actor,
            DeviceReadScope::IncludeArchived,
        )
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
            authorize_file_registry_access(
                &env.dbx,
                &root_actor,
                grandchild_device.id,
                FileRegistryDeviceAccess::Read,
            )
            .await
            .unwrap(),
            grandchild_device.id,
        );
        assert_not_found(
            find_visible_device(
                &env.dbx,
                &child_actor,
                root_device.id,
                DeviceReadScope::IncludeArchived,
            )
            .await,
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn visibility_enforces_write_gates_archived_form_and_transaction_lock(
    ) {
        let (env, _guard) = cleanup_locked().await.unwrap();
        enable_devices_section(&env.dbx).await;
        let organism = insert_organism(&env.dbx).await;
        let owner = insert_login(&env.dbx, organism.id, &[]).await;
        let active =
            insert_device(&env.dbx, &owner.login, organism.id, false).await;
        let archived =
            insert_device(&env.dbx, &owner.login, organism.id, true).await;
        let cyber = login_with_roles(&owner, &[ROLE_CYBER]);
        let source = login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
        let analyst = login_with_roles(&owner, &[ROLE_DEVICE_ANALYST]);

        assert_device_operation_forbidden(
            access::require_source_write(&cyber.roles).unwrap_err(),
        );
        assert_device_operation_forbidden(
            access::require_analytical_write(&cyber.roles).unwrap_err(),
        );
        access::require_source_write(&source.roles).unwrap();
        assert_device_operation_forbidden(
            access::require_analytical_write(&source.roles).unwrap_err(),
        );
        access::require_source_write(&analyst.roles).unwrap();
        access::require_analytical_write(&analyst.roles).unwrap();

        assert_device_operation_forbidden(
            authorize_file_registry_access(
                &env.dbx,
                &cyber,
                active.id,
                FileRegistryDeviceAccess::SourceWrite,
            )
            .await
            .unwrap_err(),
        );
        assert_eq!(
            authorize_file_registry_access(
                &env.dbx,
                &source,
                active.id,
                FileRegistryDeviceAccess::SourceWrite,
            )
            .await
            .unwrap(),
            active.id,
        );

        let main_db = env.dbx.clone();
        assert_archived_device_error(
            find_active_visible_device(&main_db, &source, archived.id)
                .await
                .unwrap_err(),
        );

        let transaction = env.dbx.begin().await.unwrap();
        assert_eq!(
            lock_active_visible_device(&transaction, &analyst, active.id,)
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
        let actor = login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
        let main_pool =
            crate::new_pg_pool_from_conn_string_with_max_connections(
                crate::mk_conn_string(&env.config),
                1,
            )
            .await
            .unwrap();

        let verified_device_id = authorize_file_registry_access(
            &main_pool,
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
        let roots =
            query::list_roots(&env.file_registry_db, verified_device_id)
                .await
                .unwrap();
        assert!(roots.is_empty());
        transaction.rollback().await.unwrap();
        main_pool.close().await.unwrap();
    }
}
