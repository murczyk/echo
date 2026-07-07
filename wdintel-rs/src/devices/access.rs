use crate::config::{ROLE_CYBER, ROLE_DEVICES_EDITOR};
use crate::error::AppError;
use crate::h;
use crate::system_settings::ensure_support_non_rer_interceptions_enabled;
use crate::types::ShortContext;
use actix_identity::Identity;
use sea_orm::DatabaseConnection;

#[allow(dead_code)]
pub async fn ensure_device_reader(
    dbx: &DatabaseConnection,
    user: &Identity,
) -> Result<String, AppError> {
    let login = user.id().c(h!())?;
    ensure_support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?;
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
    ensure_support_non_rer_interceptions_enabled(dbx)
        .await
        .c(h!())?;
    crate::users::has_role(dbx, &login, ROLE_DEVICES_EDITOR)
        .await
        .c(h!())?;
    Ok(login)
}
