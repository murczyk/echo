use super::main_db::MainDb;
use crate::config::{
    ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICES_EDITOR, ROLE_DEVICE_ANALYST,
    ROLE_DEVICE_SOURCE,
};
use crate::error::AppError;
use crate::h;
use crate::system_settings::ensure_devices_section_enabled;
use crate::types::ShortContext;
use actix_identity::Identity;
use sea_orm::DatabaseConnection;

const DEVICE_OPERATION_FORBIDDEN: &str = "device operation is forbidden";

#[allow(dead_code)]
pub(in crate::devices) struct DeviceFieldGroups {
    pub source_data: bool,
    pub analytical_data: bool,
}

pub(in crate::devices) struct DeviceActor {
    login: String,
    can_read: bool,
    can_write_source_data: bool,
    can_write_analytical_data: bool,
}

impl DeviceActor {
    fn from_roles(login: String, roles: &[String]) -> Self {
        let mut actor = Self {
            login,
            can_read: false,
            can_write_source_data: false,
            can_write_analytical_data: false,
        };

        for role in roles {
            match role.as_str() {
                ROLE_CYBER => actor.can_read = true,
                ROLE_DEVICE_SOURCE => {
                    actor.can_read = true;
                    actor.can_write_source_data = true;
                }
                ROLE_DEVICE_ANALYST => {
                    actor.can_read = true;
                    actor.can_write_source_data = true;
                    actor.can_write_analytical_data = true;
                }
                ROLE_ADMIN => {
                    actor.can_read = true;
                    actor.can_write_source_data = true;
                    actor.can_write_analytical_data = true;
                }
                _ => {}
            }
        }

        actor
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn login(&self) -> &str {
        &self.login
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn can_read(&self) -> bool {
        self.can_read
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn can_write_source_data(&self) -> bool {
        self.can_write_source_data
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn can_write_analytical_data(&self) -> bool {
        self.can_write_analytical_data
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn require_read(&self) -> Result<(), AppError> {
        if self.can_read {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn require_source_write(
        &self,
    ) -> Result<(), AppError> {
        if self.can_write_source_data {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn require_analytical_write(
        &self,
    ) -> Result<(), AppError> {
        if self.can_write_analytical_data {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

    #[allow(dead_code)]
    pub(in crate::devices) fn require_field_groups(
        &self,
        groups: DeviceFieldGroups,
    ) -> Result<(), AppError> {
        if groups.source_data {
            self.require_source_write()?;
        }
        if groups.analytical_data {
            self.require_analytical_write()?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(in crate::devices) fn from_roles_for_test(
        login: &str,
        roles: &[&str],
    ) -> Self {
        Self::from_roles(
            login.to_string(),
            &roles
                .iter()
                .map(|role| (*role).to_string())
                .collect::<Vec<_>>(),
        )
    }
}

fn forbidden_device_operation() -> AppError {
    AppError::Forbidden(DEVICE_OPERATION_FORBIDDEN.to_string())
}

#[allow(dead_code)]
pub(in crate::devices) struct DeviceActorResolver;

impl DeviceActorResolver {
    #[allow(dead_code)]
    pub(in crate::devices) async fn resolve(
        main_db: &MainDb<'_, DatabaseConnection>,
        identity: &Identity,
    ) -> Result<DeviceActor, AppError> {
        let login = identity.id().map_err(|_| AppError::Unauthenticated)?;
        resolve_current_login(main_db, &login).await
    }
}

async fn resolve_current_login(
    main_db: &MainDb<'_, DatabaseConnection>,
    login: &str,
) -> Result<DeviceActor, AppError> {
    let login_validation =
        crate::users::validate_login(main_db.connection(), login).await?;
    if let Some(error) = login_validation.validation_error {
        return Err(error);
    }
    let login = login_validation
        .login_model
        .ok_or(AppError::Unauthenticated)?;

    ensure_devices_section_enabled(main_db.connection()).await?;

    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    Ok(DeviceActor::from_roles(login.login, &roles))
}
#[allow(dead_code)]
pub async fn ensure_device_reader(
    dbx: &DatabaseConnection,
    user: &Identity,
) -> Result<String, AppError> {
    let login = user.id().c(h!())?;
    ensure_devices_section_enabled(dbx).await.c(h!())?;
    crate::users::has_any_role(
        dbx,
        &login,
        vec![ROLE_CYBER, ROLE_DEVICES_EDITOR],
    )
    .await
    .c(h!())?;
    Ok(login)
}

#[allow(dead_code)]
pub async fn ensure_device_editor(
    dbx: &DatabaseConnection,
    user: &Identity,
) -> Result<String, AppError> {
    let login = user.id().c(h!())?;
    ensure_devices_section_enabled(dbx).await.c(h!())?;
    crate::users::has_role(dbx, &login, ROLE_DEVICES_EDITOR)
        .await
        .c(h!())?;
    Ok(login)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICES_EDITOR, ROLE_DEVICE_ANALYST,
        ROLE_DEVICE_SOURCE,
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
        DeviceActor::from_roles_for_test("device-actor-test", roles)
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
            error => panic!(
                "expected device-operation forbidden error, got {error:?}"
            ),
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
            vec![ROLE_DEVICES_EDITOR],
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
    async fn resolver_uses_current_roles_and_rejects_disabled_or_missing_login()
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

        let analyst =
            resolve_current_login(&main_db, &login_name).await.unwrap();
        assert_eq!(capabilities(&analyst), (true, true, true));

        let mut login = login.into_active_model();
        login.roles = Set(json!([ROLE_DEVICE_SOURCE]));
        login.update(&env.dbx).await.unwrap();

        let source =
            resolve_current_login(&main_db, &login_name).await.unwrap();
        assert_eq!(capabilities(&source), (true, true, false));

        let missing_login_error =
            match resolve_current_login(&main_db, "missing-device-actor").await
            {
                Err(error) => error,
                Ok(_) => panic!("expected missing-login error"),
            };
        assert!(matches!(missing_login_error, AppError::Unauthenticated));

        let mut settings = settings.into_active_model();
        settings.devices_section_enabled = Set(false);
        settings.update(&env.dbx).await.unwrap();

        let disabled_section_error =
            match resolve_current_login(&main_db, &login_name).await {
                Err(error) => error,
                Ok(_) => panic!("expected disabled-section error"),
            };
        assert!(matches!(
            disabled_section_error,
            AppError::Forbidden(message) if message == "devices_section_enabled is disabled"
        ));
    }
}
