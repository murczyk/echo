use super::{ROLE_CYBER, ROLE_DEVICE_SOURCE};
use crate::config::ROLE_ADMIN;
use crate::entities::login;
use crate::error::AppError;
use crate::h;
use crate::system_settings::ensure_devices_section_enabled;
use crate::types::{ShortContext, Uuid};
use actix_identity::Identity;
use sea_orm::DatabaseConnection;

pub(in crate::devices) const DEVICE_OPERATION_FORBIDDEN: &str =
    "device operation is forbidden";

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
    require_any_role(roles, &[ROLE_CYBER, ROLE_DEVICE_SOURCE, ROLE_ADMIN])
}

pub(in crate::devices) fn require_create(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(roles, &[ROLE_CYBER, ROLE_DEVICE_SOURCE, ROLE_ADMIN])
}

pub(in crate::devices) fn require_source_write(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(roles, &[ROLE_CYBER, ROLE_DEVICE_SOURCE, ROLE_ADMIN])
}

pub(in crate::devices) fn require_file_sync(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(roles, &[ROLE_CYBER, ROLE_DEVICE_SOURCE, ROLE_ADMIN])
}

pub(in crate::devices) fn require_analytical_write(
    roles: &serde_json::Value,
) -> Result<(), AppError> {
    require_any_role(roles, &[ROLE_DEVICE_SOURCE, ROLE_ADMIN])
}

pub(in crate::devices) fn require_field_groups(
    roles: &serde_json::Value,
    groups: DeviceFieldGroups,
) -> Result<(), AppError> {
    if groups.source_data {
        require_source_write(roles).c(h!())?;
    }
    if groups.analytical_data {
        require_analytical_write(roles).c(h!())?;
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
    dbx: &DatabaseConnection,
    identity: &Identity,
) -> Result<login::Model, AppError> {
    let login_id = crate::users::login_id_from_identity(identity).c(h!())?;
    resolve_login_by_id(dbx, &login_id).await
}

pub(in crate::devices) async fn resolve_login_by_id(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<login::Model, AppError> {
    let login = crate::users::load_active_login(dbx, login_id)
        .await
        .c(h!())?;

    ensure_devices_section_enabled(dbx).await.c(h!())?;

    login
        .organism_id
        .ok_or_else(forbidden_device_operation)
        .c(h!())?;
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
