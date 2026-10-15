use crate::config::{
    MESSENGER_ALERT_HISTORY_PAGE_SIZE, MESSENGER_ALERT_MAX_SENDERS,
};
use crate::entities::{datasource, user_settings};
use crate::types::{AppError, Env, ShortContext};
use crate::{h, users};
use actix_identity::Identity;
use actix_web::web::{Data, Json};
use actix_web::{get, post, put};
use anyhow::Context;
use sea_orm::*;
use uuid::Uuid;

#[cfg(test)]
mod tests;
pub mod types;
pub mod worker;
use types::*;

pub async fn load_settings(
    db: &impl ConnectionTrait,
) -> anyhow::Result<MessengerAlertSettings> {
    #[derive(FromQueryResult)]
    struct Settings {
        enabled: bool,
        sender_datasource_ids: Vec<i64>,
    }
    let settings = Settings::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        "select enabled, sender_datasource_ids from messenger_alert_settings where id = 1",
    )).one(db).await.context(h!())?.context(h!())?;
    Ok(MessengerAlertSettings {
        enabled: settings.enabled,
        sender_datasource_ids: settings.sender_datasource_ids,
    })
}

#[get("/api/messenger/alerts/settings")]
pub async fn settings_get(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<MessengerAlertSettings>, AppError> {
    users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    Ok(Json(load_settings(&env.dbx).await.c(h!())?))
}

#[put("/api/messenger/alerts/settings")]
pub async fn settings_put(
    env: Data<Env>,
    user: Identity,
    req: Json<MessengerAlertSettings>,
) -> Result<Json<MessengerAlertSettings>, AppError> {
    users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    let req = req.into_inner();
    let unique = req
        .sender_datasource_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    if unique.len() != req.sender_datasource_ids.len()
        || unique.len() > MESSENGER_ALERT_MAX_SENDERS
    {
        return Err(anyhow::anyhow!("invalid sender selection").into());
    }
    let accounts = datasource::Entity::find()
        .filter(datasource::Column::Id.is_in(req.sender_datasource_ids.clone()))
        .filter(datasource::Column::Deleted.eq(false))
        .filter(datasource::Column::Kind.is_in(["signal", "whatsapp"]))
        .filter(datasource::Column::CanSendMessages.eq(true))
        .filter(datasource::Column::EchoClientLockId.is_not_null())
        .count(&env.dbx)
        .await
        .c(h!())?;
    if accounts as usize != unique.len() {
        return Err(
            anyhow::anyhow!("sender must allow sending messages").into()
        );
    }
    env.dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "update messenger_alert_settings set enabled = $1, sender_datasource_ids = $2 where id = 1",
        vec![req.enabled.into(), req.sender_datasource_ids.clone().into()],
    )).await.c(h!())?;
    Ok(Json(req))
}

#[get("/api/user/messenger-alerts")]
pub async fn preference_get(
    env: Data<Env>,
    user: Identity,
) -> Result<Json<MessengerAlertPreference>, AppError> {
    let login = users::login_id_from_identity(&user).c(h!())?;
    users::load_active_login(&env.dbx, &login).await.c(h!())?;
    let receive_alerts_in_messenger = user_settings::Entity::find()
        .filter(user_settings::Column::LoginId.eq(login))
        .select_only()
        .column(user_settings::Column::ReceiveAlertsInMessenger)
        .into_tuple::<Option<bool>>()
        .one(&env.dbx)
        .await
        .c(h!())?
        .flatten();
    Ok(Json(MessengerAlertPreference {
        receive_alerts_in_messenger,
    }))
}

#[put("/api/user/messenger-alerts")]
pub async fn preference_put(
    env: Data<Env>,
    user: Identity,
    req: Json<MessengerAlertPreference>,
) -> Result<Json<MessengerAlertPreference>, AppError> {
    let login = users::login_id_from_identity(&user).c(h!())?;
    users::load_active_login(&env.dbx, &login).await.c(h!())?;
    env.dbx.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "insert into user_settings (login_id, receive_alerts_in_messenger) values ($1, $2) on conflict (login_id) do update set receive_alerts_in_messenger = excluded.receive_alerts_in_messenger, updated_at = now()",
        vec![login.into(), req.receive_alerts_in_messenger.into()],
    )).await.c(h!())?;
    Ok(req)
}

pub async fn enqueue(
    txn: &DatabaseTransaction,
    event_id: Uuid,
    public_host: &str,
) -> anyhow::Result<()> {
    let settings = load_settings(txn).await.context(h!())?;
    if !settings.enabled || settings.sender_datasource_ids.is_empty() {
        return Ok(());
    }
    #[derive(FromQueryResult)]
    struct Recipient {
        receipt_id: Uuid,
        login_id: Uuid,
        profile_id: String,
        message_identifier: String,
    }
    let recipients = Recipient::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select nr.id receipt_id, l.id login_id, l.signal_profile_id profile_id, coalesce(sm.id_uuid::text, nullif(sm.message_uid, ''), sm.id::text) message_identifier from notification_receipt nr join login l on l.id = nr.recipient_login_id join user_settings us on us.login_id = l.id and us.receive_alerts_in_messenger = true join notification_event ne on ne.id = nr.event_id join signal_message sm on sm.id = ne.signal_message_id join sigint_inbox_item sii on sii.id = sm.id where nr.event_id = $1 and l.signal_profile_id is not null",
        vec![event_id.into()],
    )).all(txn).await.context(h!())?;
    for recipient in recipients {
        let base = if public_host.contains("://") {
            public_host.to_string()
        } else {
            format!("https://{public_host}")
        };
        let mut url = url::Url::parse(&base).context(h!())?;
        url.set_path("/rer-analysis-neo");
        url.set_query(None);
        url.set_fragment(None);
        url.query_pairs_mut()
            .append_pair("m", &recipient.message_identifier);
        txn.execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "insert into messenger_alert_delivery (id, receipt_id, recipient_login_id, recipient_profile_id, message_url) values ($1, $2, $3, $4, $5) on conflict (receipt_id) do nothing",
            vec![Uuid::now_v7().into(), recipient.receipt_id.into(), recipient.login_id.into(), recipient.profile_id.into(), url.to_string().into()],
        )).await.context(h!())?;
    }
    Ok(())
}

#[post("/api/messenger/alerts/history")]
pub async fn history(
    env: Data<Env>,
    user: Identity,
    req: Json<MessengerAlertHistoryReq>,
) -> Result<Json<MessengerAlertHistoryRsp>, AppError> {
    users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    #[derive(FromQueryResult)]
    struct Entry {
        id: Uuid,
        recipient_login: String,
        recipient_profile_id: String,
        message_url: String,
        status: String,
        sender_name: Option<String>,
        attempted_sender_ids: Vec<i64>,
        error: Option<String>,
        created_at: chrono::NaiveDateTime,
        sent_at: Option<chrono::NaiveDateTime>,
    }
    let (boundary, values) = match req.before_id {
        Some(id) => ("where delivery.id < $1", vec![id.into()]),
        None => ("", vec![]),
    };
    let rows = Entry::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("select delivery.id, l.login recipient_login, delivery.recipient_profile_id, delivery.message_url, delivery.status, d.display_name sender_name, delivery.attempted_sender_ids, delivery.error, delivery.created_at, delivery.sent_at from messenger_alert_delivery delivery join login l on l.id = delivery.recipient_login_id left join datasource d on d.id = delivery.sender_datasource_id {boundary} order by delivery.id desc limit {}", MESSENGER_ALERT_HISTORY_PAGE_SIZE + 1), values,
    )).all(&env.dbx).await.c(h!())?;
    let has_more = rows.len() > MESSENGER_ALERT_HISTORY_PAGE_SIZE;
    let entries = rows
        .into_iter()
        .take(MESSENGER_ALERT_HISTORY_PAGE_SIZE)
        .map(|row| MessengerAlertHistoryEntry {
            id: row.id,
            recipient_login: row.recipient_login,
            recipient_profile_id: row.recipient_profile_id,
            message_url: row.message_url,
            status: row.status,
            sender_name: row.sender_name,
            attempted_sender_ids: row.attempted_sender_ids,
            error: row.error,
            created_at: row.created_at.and_utc().timestamp_millis(),
            sent_at: row.sent_at.map(|dt| dt.and_utc().timestamp_millis()),
        })
        .collect::<Vec<_>>();
    let next_before_id = if has_more {
        entries.last().map(|entry| entry.id)
    } else {
        None
    };
    Ok(Json(MessengerAlertHistoryRsp {
        entries,
        next_before_id,
    }))
}
