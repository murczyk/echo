use crate::config::{
    MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_INGEST_DATASOURCE_LABEL_PREFIX,
};
use crate::entities::{datasource, login};
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use sea_orm::*;
use uuid::Uuid;

/// Finds or creates the login's `echo_messenger_ingest` datasource.
/// `datasource.api_login_id` is unique, so a login that already owns a
/// datasource of a different kind is rejected instead of silently reusing
/// it. Modeled on `operator::ensure_api_datasource`.
pub async fn ensure_ingest_datasource(
    dbx: &DatabaseConnection,
    login_id: &Uuid,
) -> Result<datasource::Model, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let login_name = login::Entity::find_by_id(*login_id)
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let display_name =
        format!("{MESSENGER_INGEST_DATASOURCE_LABEL_PREFIX}{login_name}");

    let maybe_datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLoginId.eq(*login_id))
        .one(dbx)
        .await
        .c(h!())?;
    if let Some(datasource) = maybe_datasource {
        if datasource.kind != MESSENGER_INGEST_DATASOURCE_KIND {
            return Err(AppError::Forbidden(format!(
                "login already owns a {} datasource",
                datasource.kind
            )));
        }

        let mut needs_update = false;
        let mut updated_datasource = datasource.clone().into_active_model();

        if datasource.display_name != display_name {
            updated_datasource.display_name = Set(display_name);
            needs_update = true;
        }
        if datasource.deleted {
            // resurrect but not re-enable datasource
            updated_datasource.deleted = Set(false);
            needs_update = true;
            if datasource.enabled != Some(false) {
                updated_datasource.enabled = Set(Some(false));
                needs_update = true;
            }
            if datasource.updated_by_login_id != Some(*login_id) {
                updated_datasource.updated_by_login_id = Set(Some(*login_id));
                needs_update = true;
            }
        }
        if datasource.last_sync_at != Some(now) {
            updated_datasource.last_sync_at = Set(Some(now));
            needs_update = true;
        }

        if needs_update {
            return Ok(updated_datasource.update(dbx).await.c(h!())?);
        }
        return Ok(datasource);
    }

    let new_datasource = datasource::ActiveModel {
        kind: Set(MESSENGER_INGEST_DATASOURCE_KIND.to_string()),
        display_name: Set(display_name),
        enabled: Set(Some(true)),
        api_login_id: Set(Some(*login_id)),
        updated_by_login_id: Set(Some(*login_id)),
        last_sync_at: Set(Some(now)),
        deleted: Set(false),
        ..Default::default()
    };
    Ok(new_datasource.insert(dbx).await.c(h!())?)
}
