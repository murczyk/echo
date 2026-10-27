use crate::config::{
    MESSENGER_INGEST_DATASOURCE_KIND, MESSENGER_INGEST_DATASOURCE_LABEL_PREFIX,
    MESSENGER_INGEST_LAST_SYNC_REFRESH_SECS,
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
        .ok_or(AppError::NotFound)
        .c(h!())?;
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
        if last_sync_is_stale(datasource.last_sync_at, now) {
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

/// `datasource` is replicated to analytics, so `last_sync_at` is refreshed
/// only when it is unset or older than the refresh interval instead of on
/// every request.
fn last_sync_is_stale(
    last_sync_at: Option<chrono::NaiveDateTime>,
    now: chrono::NaiveDateTime,
) -> bool {
    last_sync_at.is_none_or(|last_sync_at| {
        now - last_sync_at
            >= chrono::Duration::seconds(
                MESSENGER_INGEST_LAST_SYNC_REFRESH_SECS,
            )
    })
}

/// Whether a signal message was submitted through the messenger ingest
/// API, judged by the kind of its group's datasource. Ingest messages are
/// stored one-to-one with their inbox item and are never split.
pub async fn is_messenger_ingest_message<C: ConnectionTrait>(
    txn: &C,
    message: &crate::entities::signal_message::Model,
) -> Result<bool, AppError> {
    let Some(datasource_group_id) = message.datasource_group_id else {
        return Ok(false);
    };
    let count = crate::entities::datasource_group::Entity::find_by_id(
        datasource_group_id,
    )
    .inner_join(datasource::Entity)
    .filter(datasource::Column::Kind.eq(MESSENGER_INGEST_DATASOURCE_KIND))
    .count(txn)
    .await
    .c(h!())?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_sync_is_refreshed_only_when_stale() {
        let now = chrono::Utc::now().naive_utc();
        let interval =
            chrono::Duration::seconds(MESSENGER_INGEST_LAST_SYNC_REFRESH_SECS);
        assert!(last_sync_is_stale(None, now));
        assert!(!last_sync_is_stale(Some(now), now));
        assert!(!last_sync_is_stale(
            Some(now - interval + chrono::Duration::seconds(1)),
            now
        ));
        assert!(last_sync_is_stale(Some(now - interval), now));
    }
}
