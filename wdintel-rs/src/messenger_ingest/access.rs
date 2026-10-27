use crate::config::{ROLE_API, ROLE_MESSENGER_INGEST};
use crate::entities::datasource;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use crate::users::{has_role, login_id_from_identity};
use uuid::Uuid;

/// Everything an ingest endpoint needs to scope its reads and writes:
/// the calling API login and its `echo_messenger_ingest` datasource.
/// There is no unscoped variant of any ingest repository function.
pub struct IngestScope {
    pub login_id: Uuid,
    pub datasource: datasource::Model,
}

impl IngestScope {
    pub fn datasource_id(&self) -> i64 {
        self.datasource.id
    }

    pub fn is_enabled(&self) -> bool {
        self.datasource.enabled.unwrap_or(false)
    }
}

/// Requires both the `Api` and the `MessengerIngest` role, then resolves
/// the login's ingest datasource.
pub async fn ensure_messenger_ingest_access(
    dbx: &sea_orm::DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<IngestScope, AppError> {
    let login_id = login_id_from_identity(user).c(h!())?;
    ensure_messenger_ingest_roles(dbx, &login_id)
        .await
        .c(h!())?;
    let datasource =
        crate::messenger_ingest::datasource::ensure_ingest_datasource(
            dbx, &login_id,
        )
        .await
        .c(h!())?;
    Ok(IngestScope {
        login_id,
        datasource,
    })
}

pub(crate) async fn ensure_messenger_ingest_roles(
    dbx: &sea_orm::DatabaseConnection,
    login_id: &Uuid,
) -> Result<(), AppError> {
    has_role(dbx, login_id, ROLE_API).await.c(h!())?;
    has_role(dbx, login_id, ROLE_MESSENGER_INGEST)
        .await
        .c(h!())?;
    Ok(())
}
