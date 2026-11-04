use crate::config::ROLE_CYBER_MESSENGERS;
use crate::error::AppError;
use crate::h;
use crate::messenger::group::get_identity_sigint_groups;
use crate::types::ShortContext;
use crate::users::{ensure_base_role_by_id, has_role, login_id_from_identity};

/// Everything a viewer endpoint needs to scope its reads: the groups of the
/// calling login. There is no unscoped variant of any viewer query.
pub struct MessengersScope {
    pub group_master_keys: Vec<String>,
}

/// Requires `CyberMessengers` and the base role, then resolves the login's
/// groups. These include messenger account groups, unlike the RER feeds.
pub async fn ensure_messengers_access(
    dbx: &sea_orm::DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<MessengersScope, AppError> {
    let login_id = login_id_from_identity(user).c(h!())?;
    has_role(dbx, &login_id, ROLE_CYBER_MESSENGERS)
        .await
        .c(h!())?;
    ensure_base_role_by_id(dbx, &login_id).await.c(h!())?;
    let group_master_keys =
        get_identity_sigint_groups(dbx, &login_id).await.c(h!())?;
    Ok(MessengersScope { group_master_keys })
}
