use super::main_db::MainDb;
use crate::config::{
    ROLE_ADMIN, ROLE_CYBER, ROLE_DEVICE_ANALYST, ROLE_DEVICE_SOURCE,
};
use crate::error::AppError;
use crate::h;
use crate::system_settings::ensure_devices_section_enabled;
use crate::types::{ShortContext, Uuid};
use actix_identity::Identity;
use sea_orm::DatabaseConnection;

const DEVICE_OPERATION_FORBIDDEN: &str = "device operation is forbidden";

pub(in crate::devices) struct DeviceFieldGroups {
    pub source_data: bool,
    pub analytical_data: bool,
}

pub(in crate::devices) struct DeviceActor {
    login: String,
    organism_id: i64,
    can_read: bool,
    can_write_source_data: bool,
    can_write_analytical_data: bool,
}

impl DeviceActor {
    fn from_roles(login: String, organism_id: i64, roles: &[String]) -> Self {
        let mut actor = Self {
            login,
            organism_id,
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

    pub(in crate::devices) fn login(&self) -> &str {
        &self.login
    }

    pub(in crate::devices) fn organism_id(&self) -> i64 {
        self.organism_id
    }

    pub(in crate::devices) fn require_read(&self) -> Result<(), AppError> {
        if self.can_read {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

    pub(in crate::devices) fn require_source_write(
        &self,
    ) -> Result<(), AppError> {
        if self.can_write_source_data {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

    pub(in crate::devices) fn require_analytical_write(
        &self,
    ) -> Result<(), AppError> {
        if self.can_write_analytical_data {
            Ok(())
        } else {
            Err(forbidden_device_operation())
        }
    }

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
}

fn forbidden_device_operation() -> AppError {
    AppError::Forbidden(DEVICE_OPERATION_FORBIDDEN.to_string())
}

pub(in crate::devices) struct DeviceActorResolver;

impl DeviceActorResolver {
    pub(in crate::devices) async fn resolve(
        main_db: &MainDb<'_, DatabaseConnection>,
        identity: &Identity,
    ) -> Result<DeviceActor, AppError> {
        let login_id = crate::users::login_id_from_identity(identity)?;
        resolve_current_login(main_db, &login_id).await
    }
}

async fn resolve_current_login(
    main_db: &MainDb<'_, DatabaseConnection>,
    login_id: &Uuid,
) -> Result<DeviceActor, AppError> {
    let login_validation =
        crate::users::validate_login_id(main_db.connection(), login_id).await?;
    if let Some(error) = login_validation.validation_error {
        return Err(error);
    }
    let login = login_validation
        .login_model
        .ok_or(AppError::Unauthenticated)?;

    ensure_devices_section_enabled(main_db.connection()).await?;

    let organism_id =
        login.organism_id.ok_or_else(forbidden_device_operation)?;
    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    Ok(DeviceActor::from_roles(login.login, organism_id, &roles))
}

#[cfg(test)]
pub(in crate::devices) mod test_support;

#[cfg(test)]
mod tests;
