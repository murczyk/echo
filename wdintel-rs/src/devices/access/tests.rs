use super::*;
use crate::config::{
    ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::entities::{login, organism, system_settings};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Uuid;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, DatabaseConnection, IntoActiveModel,
};
use serde_json::json;
use serial_test::serial;

fn actor(roles: &[&str]) -> DeviceActor {
    crate::devices::access::test_support::device_actor(
        "device-actor-test",
        roles,
    )
}

fn capabilities(actor: &DeviceActor) -> (bool, bool, bool) {
    (
        actor.can_read(),
        actor.can_write_source_data(),
        actor.can_write_analytical_data(),
    )
}

fn assert_device_operation_forbidden(error: AppError) {
    match error {
        AppError::Forbidden(message) => {
            assert_eq!(message, DEVICE_OPERATION_FORBIDDEN);
        }
        error => {
            panic!("expected device-operation forbidden error, got {error:?}")
        }
    }
}

async fn insert_devices_settings(
    dbx: &DatabaseConnection,
    enabled: bool,
) -> system_settings::Model {
    system_settings::ActiveModel {
        devices_section_enabled: Set(enabled),
        ..Default::default()
    }
    .insert(dbx)
    .await
    .unwrap()
}

#[test]
fn actor_maps_each_exact_device_role() {
    let cases = [
        (ROLE_CYBER, (true, false, false)),
        (ROLE_DEVICE_SOURCE, (true, true, false)),
        (ROLE_DEVICE_ANALYST, (true, true, true)),
        (ROLE_ADMIN, (true, true, true)),
    ];

    for (role, expected_capabilities) in cases {
        assert_eq!(capabilities(&actor(&[role])), expected_capabilities);
    }
}

#[test]
fn actor_unions_combined_device_roles() {
    let cases = vec![
        (vec![ROLE_CYBER, ROLE_DEVICE_SOURCE], (true, true, false)),
        (vec![ROLE_CYBER, ROLE_DEVICE_ANALYST], (true, true, true)),
        (vec![ROLE_DEVICE_SOURCE, "Unrelated"], (true, true, false)),
    ];

    for (roles, expected_capabilities) in cases {
        assert_eq!(capabilities(&actor(&roles)), expected_capabilities);
    }
}

#[test]
fn actor_ignores_legacy_and_unrelated_roles() {
    let cases = vec![
        vec!["DevicesEditor"],
        vec!["Unrelated"],
        vec!["deviceanalyst"],
    ];

    for roles in cases {
        assert_eq!(capabilities(&actor(&roles)), (false, false, false));
    }
}

#[test]
fn actor_write_requirements_return_generic_forbidden_error() {
    let actor = actor(&[]);

    for result in [
        actor.require_read(),
        actor.require_source_write(),
        actor.require_analytical_write(),
    ] {
        assert_device_operation_forbidden(result.unwrap_err());
    }
}

#[test]
fn actor_authorizes_all_field_group_combinations() {
    let source_actor = actor(&[ROLE_DEVICE_SOURCE]);
    let analyst_actor = actor(&[ROLE_DEVICE_ANALYST]);
    let cases = [
        (false, false, true),
        (true, false, true),
        (false, true, false),
        (true, true, false),
    ];

    for (source_data, analytical_data, source_allowed) in cases {
        let source_result =
            source_actor.require_field_groups(DeviceFieldGroups {
                source_data,
                analytical_data,
            });
        if source_allowed {
            source_result.unwrap();
        } else {
            assert_device_operation_forbidden(source_result.unwrap_err());
        }

        analyst_actor
            .require_field_groups(DeviceFieldGroups {
                source_data,
                analytical_data,
            })
            .unwrap();
    }
}

#[tokio::test]
#[serial]
async fn resolver_uses_current_roles_and_rejects_disabled_or_missing_login() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let settings = insert_devices_settings(&env.dbx, true).await;
    let organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login_name = format!("device-actor-{}", Uuid::now_v7());
    let login = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(login_name.clone()),
            roles: Set(json!([ROLE_DEVICE_ANALYST])),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let main_db = MainDb::new(&env.dbx);
    let login_id = login.id;

    let analyst = resolve_current_login(&main_db, &login_id).await.unwrap();
    assert_eq!(capabilities(&analyst), (true, true, true));

    let mut login = login.into_active_model();
    login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
    login.update(&env.dbx).await.unwrap();

    let source = resolve_current_login(&main_db, &login_id).await.unwrap();
    assert_eq!(capabilities(&source), (true, true, false));

    let missing_login_id = Uuid::now_v7();
    let missing_login_error =
        match resolve_current_login(&main_db, &missing_login_id).await {
            Err(error) => error,
            Ok(_) => panic!("expected missing-login error"),
        };
    assert!(matches!(missing_login_error, AppError::Unauthenticated));

    let mut settings = settings.into_active_model();
    settings.devices_section_enabled = Set(false);
    settings.update(&env.dbx).await.unwrap();

    let disabled_section_error =
        match resolve_current_login(&main_db, &login_id).await {
            Err(error) => error,
            Ok(_) => panic!("expected disabled-section error"),
        };
    assert!(matches!(
        disabled_section_error,
        AppError::Forbidden(message) if message == "devices_section_enabled is disabled"
    ));
}
