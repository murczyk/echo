use super::main_db::MainDb;
use crate::config::{
    ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::entities::login;
use crate::error::AppError;
use crate::system_settings::ensure_devices_section_enabled;
use crate::types::Uuid;
use actix_identity::Identity;
use sea_orm::DatabaseConnection;

const DEVICE_OPERATION_FORBIDDEN: &str = "device operation is forbidden";

pub(in crate::devices) struct DeviceFieldGroups {
    pub source_data: bool,
    pub analytical_data: bool,
}

pub(in crate::devices) fn organism_id(
    login: &login::Model,
) -> Result<i64, AppError> {
    login.organism_id.ok_or_else(forbidden_device_operation)
}

pub(in crate::devices) fn require_read(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(
        roles,
        &[
            ROLE_CYBER,
            ROLE_DEVICE_SOURCE,
            ROLE_DEVICE_ANALYST,
            ROLE_ADMIN,
        ],
    )
}

pub(in crate::devices) fn require_source_write(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(
        roles,
        &[ROLE_DEVICE_SOURCE, ROLE_DEVICE_ANALYST, ROLE_ADMIN],
    )
}

pub(in crate::devices) fn require_analytical_write(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(roles, &[ROLE_DEVICE_ANALYST, ROLE_ADMIN])
}

pub(in crate::devices) fn require_field_groups(
    roles: &serde_json::Value,
    groups: DeviceFieldGroups,
) -> Result<(), AppError> {
    if groups.source_data {
        require_source_write(roles)?;
    }
    if groups.analytical_data {
        require_analytical_write(roles)?;
    }
    Ok(())
}

fn require_any_role(
    roles: &serde_json::Value,
    allowed_roles: &[&str],
) -> Result<(), AppError> {
    let allowed = roles.as_array().is_some_and(|roles| {
        roles.iter().all(serde_json::Value::is_string)
            && roles
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|role| allowed_roles.contains(&role))
    });
    if allowed {
        Ok(())
    } else {
        Err(forbidden_device_operation())
    }
}

fn forbidden_device_operation() -> AppError {
    AppError::Forbidden(DEVICE_OPERATION_FORBIDDEN.to_string())
}

pub(in crate::devices) async fn resolve_current_login(
    main_db: &MainDb<'_, DatabaseConnection>,
    identity: &Identity,
) -> Result<login::Model, AppError> {
    let login_id = crate::users::login_id_from_identity(identity)?;
    resolve_login_by_id(main_db, &login_id).await
}

async fn resolve_login_by_id(
    main_db: &MainDb<'_, DatabaseConnection>,
    login_id: &Uuid,
) -> Result<login::Model, AppError> {
    let login_validation =
        crate::users::validate_login_id(main_db.connection(), login_id).await?;
    if let Some(error) = login_validation.validation_error {
        return Err(error);
    }
    let login = login_validation
        .login_model
        .ok_or(AppError::Unauthenticated)?;

    ensure_devices_section_enabled(main_db.connection()).await?;

    login.organism_id.ok_or_else(forbidden_device_operation)?;
    Ok(login)
}

#[cfg(test)]
pub(in crate::devices) fn login_with_roles(
    login: &login::Model,
    roles: &[&str],
) -> login::Model {
    let mut login = login.clone();
    login.roles = serde_json::json!(roles);
    login
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
    };
    use crate::entities::{organism, system_settings};
    use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
    use crate::types::Uuid;
    use sea_orm::{
        ActiveModelTrait, ActiveValue::Set, DatabaseConnection, IntoActiveModel,
    };
    use serde_json::json;
    use serial_test::serial;

    fn roles(roles: &[&str]) -> serde_json::Value {
        json!(roles)
    }

    fn capabilities(roles: &serde_json::Value) -> (bool, bool, bool) {
        (
            require_read(roles).is_ok(),
            require_source_write(roles).is_ok(),
            require_analytical_write(roles).is_ok(),
        )
    }

    fn assert_device_operation_forbidden(error: AppError) {
        match error {
            AppError::Forbidden(message) => {
                assert_eq!(message, DEVICE_OPERATION_FORBIDDEN);
            }
            error => {
                panic!(
                    "expected device-operation forbidden error, got {error:?}"
                )
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
    fn access_maps_each_exact_device_role() {
        let cases = [
            (ROLE_CYBER, (true, false, false)),
            (ROLE_DEVICE_SOURCE, (true, true, false)),
            (ROLE_DEVICE_ANALYST, (true, true, true)),
            (ROLE_ADMIN, (true, true, true)),
        ];

        for (role, expected_capabilities) in cases {
            assert_eq!(capabilities(&roles(&[role])), expected_capabilities);
        }
    }

    #[test]
    fn access_unions_combined_device_roles() {
        let cases = vec![
            (vec![ROLE_CYBER, ROLE_DEVICE_SOURCE], (true, true, false)),
            (vec![ROLE_CYBER, ROLE_DEVICE_ANALYST], (true, true, true)),
            (vec![ROLE_DEVICE_SOURCE, "Unrelated"], (true, true, false)),
        ];

        for (roles, expected_capabilities) in cases {
            assert_eq!(capabilities(&json!(roles)), expected_capabilities);
        }
    }

    #[test]
    fn access_ignores_legacy_and_unrelated_roles() {
        let cases = vec![
            vec!["DevicesEditor"],
            vec!["Unrelated"],
            vec!["deviceanalyst"],
        ];

        for roles in cases {
            assert_eq!(capabilities(&json!(roles)), (false, false, false));
        }
    }

    #[test]
    fn access_requirements_return_generic_forbidden_error() {
        let roles = roles(&[]);

        for result in [
            require_read(&roles),
            require_source_write(&roles),
            require_analytical_write(&roles),
        ] {
            assert_device_operation_forbidden(result.unwrap_err());
        }
    }

    #[test]
    fn access_authorizes_all_field_group_combinations() {
        let source_roles = roles(&[ROLE_DEVICE_SOURCE]);
        let analyst_roles = roles(&[ROLE_DEVICE_ANALYST]);
        let cases = [
            (false, false, true),
            (true, false, true),
            (false, true, false),
            (true, true, false),
        ];

        for (source_data, analytical_data, source_allowed) in cases {
            let source_result = require_field_groups(
                &source_roles,
                DeviceFieldGroups {
                    source_data,
                    analytical_data,
                },
            );
            if source_allowed {
                source_result.unwrap();
            } else {
                assert_device_operation_forbidden(source_result.unwrap_err());
            }

            require_field_groups(
                &analyst_roles,
                DeviceFieldGroups {
                    source_data,
                    analytical_data,
                },
            )
            .unwrap();
        }
    }

    #[tokio::test]
    #[serial]
    async fn resolve_uses_current_roles_and_rejects_disabled_or_missing_login()
    {
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
        let login_name = format!("device-access-{}", Uuid::now_v7());
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set(login_name),
                roles: Set(json!([ROLE_DEVICE_ANALYST])),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let main_db = MainDb::new(&env.dbx);
        let login_id = login.id;

        let analyst = resolve_login_by_id(&main_db, &login_id).await.unwrap();
        assert_eq!(capabilities(&analyst.roles), (true, true, true));
        assert_eq!(organism_id(&analyst).unwrap(), organism.id);

        let mut login = login.into_active_model();
        login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
        let login = login.update(&env.dbx).await.unwrap();

        let source = resolve_login_by_id(&main_db, &login_id).await.unwrap();
        assert_eq!(capabilities(&source.roles), (true, true, false));

        let mut login = login.into_active_model();
        login.organism_id = Set(None);
        let login = login.update(&env.dbx).await.unwrap();
        let missing_organism_error =
            match resolve_login_by_id(&main_db, &login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected missing-organism error"),
            };
        assert!(matches!(missing_organism_error, AppError::Unauthenticated));

        let mut login = login.into_active_model();
        login.organism_id = Set(Some(organism.id));
        login.update(&env.dbx).await.unwrap();

        let missing_login_id = Uuid::now_v7();
        let missing_login_error =
            match resolve_login_by_id(&main_db, &missing_login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected missing-login error"),
            };
        assert!(matches!(missing_login_error, AppError::Unauthenticated));

        let mut settings = settings.into_active_model();
        settings.devices_section_enabled = Set(false);
        settings.update(&env.dbx).await.unwrap();

        let disabled_section_error =
            match resolve_login_by_id(&main_db, &login_id).await {
                Err(error) => error,
                Ok(_) => panic!("expected disabled-section error"),
            };
        assert!(matches!(
            disabled_section_error,
            AppError::Forbidden(message)
                if message == "devices_section_enabled is disabled"
        ));
    }
}
