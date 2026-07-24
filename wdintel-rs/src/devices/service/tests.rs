use super::read::hydrate_devices;
use super::write::{active_aor_reference_query, active_unit_reference_query};
use super::*;
use crate::config::{
    DEVICE_CUSTOM_FIELDS_MAX_COUNT, ROLE_ADMIN, ROLE_CYBER,
    ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::devices::access::DeviceActor;
use crate::devices::main_db::MainDb;
use crate::devices::schema_tests::device_active_model;
use crate::devices::visibility::DeviceReadScope;
use crate::entities::{
    area_of_responsibility, device, device_aor, login, sigint_unit,
};
use crate::functest::tests::{
    cleanup_locked, mk_aor, mk_login, mk_sigint_unit,
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

fn actor(login: &str, roles: &[&str]) -> DeviceActor {
    crate::devices::access::test_support::device_actor(login, roles)
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
    mk_login(
        dbx,
        login::ActiveModel {
            login: Set(format!("device-service-{}", Uuid::now_v7())),
            roles: Set(json!(roles)),
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
    let source_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-service-source-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let actor = crate::devices::access::test_support::device_actor(
        &source_login.login,
        &[ROLE_DEVICE_SOURCE],
    );
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
            created_by: Set(source_login.login.clone()),
            name: Set("Current unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut first_device = device_active_model(
        &source_login.login,
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

    let main_db = MainDb::new(&env.dbx);
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

    let state = DeviceService::read(
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
    let source_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-service-source-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let actor = crate::devices::access::test_support::device_actor(
        &source_login.login,
        &[ROLE_DEVICE_SOURCE],
    );
    let main_db = MainDb::new(&env.dbx);

    let state = DeviceService::create(
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
    let another_state = DeviceService::create(
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
    assert_eq!(device.archived_at, None);
}

#[tokio::test]
#[serial_test::serial]
async fn analyst_mixed_update_is_atomic_and_source_cannot_change_analysis() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-service-source-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let analyst_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("device-service-analyst-{}", Uuid::now_v7())),
            roles: Set(json!([ROLE_DEVICE_ANALYST])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let source = crate::devices::access::test_support::device_actor(
        &source_login.login,
        &[ROLE_DEVICE_SOURCE],
    );
    let analyst = crate::devices::access::test_support::device_actor(
        &analyst_login.login,
        &[ROLE_DEVICE_ANALYST],
    );
    let main_db = MainDb::new(&env.dbx);
    let created = DeviceService::create(
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
            created_by: Set(analyst_login.login.clone()),
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

    let updated = DeviceService::update(&main_db, &analyst, command)
        .await
        .unwrap();

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
    let error = DeviceService::update(&main_db, &source, forbidden_command)
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
    let source = actor(&source_login.login, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor(&analyst_login.login, &[ROLE_DEVICE_ANALYST]);
    let admin = actor(&admin_login.login, &[ROLE_ADMIN]);
    let cyber = actor(&cyber_login.login, &[ROLE_CYBER]);
    let main_db = MainDb::new(&env.dbx);

    for (login, actor) in [
        (&source_login, &source),
        (&analyst_login, &analyst),
        (&admin_login, &admin),
    ] {
        let state = DeviceService::create(
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
        DeviceService::create(
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

    let created = DeviceService::create(
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
        DeviceService::update(&main_db, &cyber, malformed_mixed)
            .await
            .unwrap_err(),
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
    let source = actor(&source_login.login, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor(&analyst_login.login, &[ROLE_DEVICE_ANALYST]);
    let cyber = actor(&cyber_login.login, &[ROLE_CYBER]);
    let main_db = MainDb::new(&env.dbx);
    let created = DeviceService::create(
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
            created_by: Set(analyst_login.login.clone()),
            name: Set("Presence unit".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut source_patch = update_command(created.id);
    source_patch.source_label =
        DevicePatchField::Value("  presence source updated  ".to_string());
    let source_updated = DeviceService::update(&main_db, &source, source_patch)
        .await
        .unwrap();
    assert_eq!(source_updated.source_label, "presence source updated");

    let mut analytical_patch = update_command(created.id);
    analytical_patch.name =
        DevicePatchField::Value(Some("Presence device".to_string()));
    analytical_patch.aor_ids =
        DevicePatchField::Value(vec![second_aor.id, first_aor.id]);
    analytical_patch.unit_id = DevicePatchField::Value(Some(unit.id));
    let analytical_updated =
        DeviceService::update(&main_db, &analyst, analytical_patch)
            .await
            .unwrap();
    assert_eq!(
        analytical_updated
            .aors
            .iter()
            .map(|aor| aor.id)
            .collect::<Vec<_>>(),
        [first_aor.id, second_aor.id]
    );

    assert_form_error(
        DeviceService::update(&main_db, &analyst, update_command(created.id))
            .await
            .unwrap_err(),
        "patch",
        "Потрібно передати хоча б одне поле для зміни",
    );
    let mut empty_custom_fields = update_command(created.id);
    empty_custom_fields.custom_fields =
        DevicePatchField::Value(BTreeMap::new());
    assert_form_error(
        DeviceService::update(&main_db, &source, empty_custom_fields)
            .await
            .unwrap_err(),
        "patch",
        "Потрібно передати хоча б одне поле для зміни",
    );
    let mut unauthorized_empty_custom_fields = update_command(created.id);
    unauthorized_empty_custom_fields.custom_fields =
        DevicePatchField::Value(BTreeMap::new());
    assert_forbidden(
        DeviceService::update(
            &main_db,
            &cyber,
            unauthorized_empty_custom_fields,
        )
        .await
        .unwrap_err(),
    );

    let mut clears = update_command(created.id);
    clears.external_url = DevicePatchField::Value(None);
    clears.name = DevicePatchField::Value(None);
    clears.aor_ids = DevicePatchField::Value(Vec::new());
    clears.unit_id = DevicePatchField::Value(None);
    let cleared = DeviceService::update(&main_db, &analyst, clears)
        .await
        .unwrap();
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
    let source = actor(&source_login.login, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor(&analyst_login.login, &[ROLE_DEVICE_ANALYST]);
    let main_db = MainDb::new(&env.dbx);
    let created = DeviceService::create(
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
            created_by: Set(analyst_login.login.clone()),
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
    DeviceService::update(&main_db, &analyst, setup)
        .await
        .unwrap();
    let before = DeviceService::read(
        &main_db,
        &analyst,
        created.id,
        DeviceReadScope::ActiveOnly,
    )
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
        DeviceService::update(&main_db, &analyst, invalid_mixed)
            .await
            .unwrap_err(),
        "aor_ids",
        "Смугу не знайдено",
    );
    let after = DeviceService::read(
        &main_db,
        &analyst,
        created.id,
        DeviceReadScope::ActiveOnly,
    )
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
        DeviceService::update(&main_db, &analyst, duplicate_aors)
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
        DeviceService::update(&main_db, &analyst, deleted_aor_patch)
            .await
            .unwrap_err(),
        "aor_ids",
        "Смугу не знайдено",
    );

    let mut missing_unit_patch = update_command(created.id);
    missing_unit_patch.unit_id = DevicePatchField::Value(Some(i64::MAX));
    assert_form_error(
        DeviceService::update(&main_db, &analyst, missing_unit_patch)
            .await
            .unwrap_err(),
        "unit_id",
        "Підрозділ не знайдено",
    );

    let deleted_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by: Set(analyst_login.login.clone()),
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
        DeviceService::update(&main_db, &analyst, deleted_unit_patch)
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
    let source = actor(&source_login.login, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor(&analyst_login.login, &[ROLE_DEVICE_ANALYST]);
    let main_db = MainDb::new(&env.dbx);
    let created = DeviceService::create(
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
    DeviceService::update(&main_db, &analyst, assign_aors)
        .await
        .unwrap();

    let mut merge = update_command(created.id);
    merge.custom_fields = DevicePatchField::Value(BTreeMap::from([
        ("remove".to_string(), None),
        ("added".to_string(), Some("new value".to_string())),
    ]));
    let merged = DeviceService::update(&main_db, &analyst, merge)
        .await
        .unwrap();
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
        DeviceService::update(&main_db, &analyst, collision)
            .await
            .unwrap_err(),
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
    let no_op_state = DeviceService::update(&main_db, &analyst, no_op)
        .await
        .unwrap();
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
    let full = DeviceService::create(
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
        DeviceService::update(&main_db, &analyst, over_limit)
            .await
            .unwrap_err(),
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
    let source = actor(&source_login.login, &[ROLE_DEVICE_SOURCE]);
    let analyst = actor(&analyst_login.login, &[ROLE_DEVICE_ANALYST]);
    let main_db = MainDb::new(&env.dbx);
    let created = DeviceService::create(
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
            created_by: Set(analyst_login.login.clone()),
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
    DeviceService::update(&main_db, &analyst, assign_references)
        .await
        .unwrap();
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
        DeviceService::read(
            &main_db,
            &analyst,
            created.id,
            DeviceReadScope::ActiveOnly,
        )
        .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        DeviceService::read(
            &main_db,
            &analyst,
            Uuid::now_v7(),
            DeviceReadScope::IncludeArchived,
        )
        .await,
        Err(AppError::NotFound)
    ));
    let state = DeviceService::read(
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
    let actor = actor(&reader.login, &[ROLE_CYBER]);
    let active_unit = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            created_by: Set(reader.login.clone()),
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
            created_by: Set(reader.login.clone()),
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
    let now = Utc::now().naive_utc();

    let mut missing_name = device_active_model(
        &reader.login,
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

    let main_db = MainDb::new(&env.dbx);
    let mut command = list_command();
    command.needs_analytical_name = Some(true);
    command.sort_by = vec![DeviceListSort::CreatedAtAsc];
    let result = DeviceService::list(&main_db, &actor, command)
        .await
        .unwrap();
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

    let result = DeviceService::list(&main_db, &actor, list_command())
        .await
        .unwrap();
    assert_eq!(result.status_counts.active, 3);
    assert_eq!(result.status_counts.archived, 1);

    for (filter_text, expected_id) in [
        ("%".to_string(), missing_name.id),
        ("Needle Alpha".to_string(), named.id),
        (uuid_match.id.to_string(), uuid_match.id),
    ] {
        let mut command = list_command();
        command.filter_text = Some(filter_text);
        let result = DeviceService::list(&main_db, &actor, command)
            .await
            .unwrap();
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
    let result = DeviceService::list(&main_db, &actor, command)
        .await
        .unwrap();
    assert_eq!(
        result
            .devices
            .iter()
            .map(|device| device.id)
            .collect::<Vec<_>>(),
        vec![missing_name.id],
    );

    let stats = DeviceService::unit_stats(&main_db, &actor).await.unwrap();
    assert_eq!(stats.len(), 1);
    assert_eq!(stats[0].unit.id, active_unit.id);
    assert_eq!(stats[0].count, 1);

    let mut command = list_command();
    command.sort_by =
        vec![DeviceListSort::CreatedAtAsc, DeviceListSort::CreatedAtDesc];
    assert_form_error(
        DeviceService::list(&main_db, &actor, command)
            .await
            .unwrap_err(),
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
