use super::{load_settings, types::MessengerAlertSettings};
use crate::config::{
    MESSENGER_ALERT_BATCH_SIZE, MESSENGER_ALERT_POLL_SECONDS,
    MESSENGER_ALERT_SENDER_TIMEOUT_SECONDS,
};
use crate::h;
use crate::types::Env;
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use echo_im::types::{MessageSource, SendMessageReq};
use sea_orm::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(FromQueryResult)]
struct Delivery {
    id: Uuid,
    receipt_id: Uuid,
    recipient_login_id: Uuid,
    recipient_profile_id: String,
    message_url: String,
    outbox_instance_id: Option<i32>,
    sender_datasource_id: Option<i64>,
    attempted_sender_ids: Vec<i64>,
}

pub async fn run(env: Arc<Env>, cancel: CancellationToken) {
    loop {
        if cancel.is_cancelled() {
            return;
        }
        if let Err(error) = process_batch(&env.dbx).await {
            log::error!("messenger alerts: {error:#}");
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(MESSENGER_ALERT_POLL_SECONDS)) => {}
        }
    }
}

pub async fn process_batch(db: &DatabaseConnection) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct Pending {
        id: Uuid,
    }
    let pending = Pending::find_by_statement(Statement::from_string(
        DatabaseBackend::Postgres,
        format!("select id from messenger_alert_delivery where status in ('queued', 'sending') and next_attempt_at <= now() order by next_attempt_at, id limit {MESSENGER_ALERT_BATCH_SIZE}"),
    )).all(db).await.context(h!())?;
    for delivery in pending {
        if let Err(error) = process_delivery(db, delivery.id).await {
            log::error!("messenger alert {}: {error:#}", delivery.id);
            postpone(db, delivery.id).await.context(h!())?;
        }
    }
    Ok(())
}

async fn process_delivery(
    db: &DatabaseConnection,
    id: Uuid,
) -> anyhow::Result<()> {
    let txn = db.begin().await.context(h!())?;
    let delivery = Delivery::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select id, receipt_id, recipient_login_id, recipient_profile_id, message_url, outbox_instance_id, sender_datasource_id, attempted_sender_ids from messenger_alert_delivery where id = $1 and status in ('queued', 'sending') and next_attempt_at <= now() for update skip locked",
        vec![id.into()],
    )).one(&txn).await.context(h!())?;
    let Some(mut delivery) = delivery else {
        return Ok(());
    };
    let settings = load_settings(&txn).await.context(h!())?;
    let allowed = settings.enabled
        && recipient_is_eligible(&txn, &delivery).await.context(h!())?;
    if let Some(instance_id) = delivery.outbox_instance_id {
        let sender_enabled = match delivery.sender_datasource_id {
            Some(sender_id)
                if settings.sender_datasource_ids.contains(&sender_id) =>
            {
                datasource_can_send(&txn, sender_id).await.context(h!())?
            }
            _ => false,
        };
        if reconcile_outbox(
            &txn,
            &delivery,
            instance_id,
            allowed && sender_enabled,
        )
        .await
        .context(h!())?
        {
            txn.commit().await.context(h!())?;
            return Ok(());
        }
    }
    if !allowed {
        finish(
            &txn,
            delivery.id,
            "skipped",
            Some("Сповіщення вимкнено або одержувач більше не має доступу"),
        )
        .await
        .context(h!())?;
    } else {
        schedule_sender(&txn, &mut delivery, &settings)
            .await
            .context(h!())?;
    }
    txn.commit().await.context(h!())?;
    Ok(())
}

async fn datasource_can_send(
    txn: &DatabaseTransaction,
    id: i64,
) -> anyhow::Result<bool> {
    Ok(txn.query_one_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "select d.id from datasource d join echo_client_lock ecl on ecl.id = d.echo_client_lock_id join echo_client ec on ec.id = ecl.client_id join echo_account ea on ea.id = ecl.account_id where d.id = $1 and d.deleted = false and d.status = 'active' and d.can_send_messages = true and ec.deleted = false and ecl.remove_requested = false and ea.is_linked = true",
        vec![id.into()],
    )).await.context(h!())?.is_some())
}

async fn recipient_is_eligible(
    txn: &DatabaseTransaction,
    delivery: &Delivery,
) -> anyhow::Result<bool> {
    #[derive(FromQueryResult)]
    struct Context {
        group_master_key: String,
        roles: serde_json::Value,
    }
    let context = Context::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select ne.group_master_key, l.roles from notification_receipt nr join notification_event ne on ne.id = nr.event_id join login l on l.id = nr.recipient_login_id join organism o on o.id = l.organism_id join user_settings us on us.login_id = l.id join signal_message sm on sm.id = ne.signal_message_id join sigint_inbox_item sii on sii.id = sm.id join sigint_important si on si.id = ne.sigint_important_id where nr.id = $1 and l.id = $2 and l.signal_profile_id = $3 and us.receive_alerts_in_messenger = true and l.deleted = false and l.deleted_permanently = false and o.enabled = true and o.deleted_permanently = false and sm.deleted = false and si.deleted = false and exists (select 1 from signal_message_group smg where smg.signal_message_id = sm.id and smg.group_master_key = ne.group_master_key)",
        vec![delivery.receipt_id.into(), delivery.recipient_login_id.into(), delivery.recipient_profile_id.clone().into()],
    )).one(txn).await.context(h!())?;
    let Some(context) = context else {
        return Ok(false);
    };
    let roles =
        serde_json::from_value::<Vec<String>>(context.roles).context(h!())?;
    if !crate::users::role_matches(&roles, "Rer").context(h!())?
        && !crate::users::role_matches(&roles, "CyberViewer").context(h!())?
    {
        return Ok(false);
    }
    Ok(
        !crate::rer_importer::important::recipients_with_group_access(
            txn,
            &[delivery.recipient_login_id],
            &context.group_master_key,
        )
        .await
        .context(h!())?
        .is_empty(),
    )
}

async fn reconcile_outbox(
    txn: &DatabaseTransaction,
    delivery: &Delivery,
    instance_id: i32,
    allowed: bool,
) -> anyhow::Result<bool> {
    #[derive(FromQueryResult)]
    struct Outbox {
        status: String,
        send_ok: bool,
        sent_at: Option<NaiveDateTime>,
        created_at: NaiveDateTime,
    }
    let outbox = Outbox::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select status::text, send_ok, sent_at, created_at from echo_outbox_message_instance where id = $1 for update",
        vec![instance_id.into()],
    )).one(txn).await.context(h!())?;
    let Some(outbox) = outbox else {
        finish(
            txn,
            delivery.id,
            "failed",
            Some("Втрачено стан доставки Echo IM"),
        )
        .await
        .context(h!())?;
        return Ok(true);
    };
    if outbox.send_ok || outbox.status == "received" {
        txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "update messenger_alert_delivery set status = 'sent', sent_at = coalesce($2, now()), error = null, updated_at = now() where id = $1",
            vec![delivery.id.into(), outbox.sent_at.into()],
        )).await.context(h!())?;
        return Ok(true);
    }
    let timed_out = (Utc::now().naive_utc() - outbox.created_at).num_seconds()
        >= MESSENGER_ALERT_SENDER_TIMEOUT_SECONDS;
    let replaceable = outbox.status == "error"
        || outbox.status == "expired"
        || (outbox.status == "scheduled" && (timed_out || !allowed));
    if !replaceable {
        postpone(txn, delivery.id).await.context(h!())?;
        return Ok(true);
    }
    txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update echo_outbox_message_instance set status = 'expired', updated_at = now() where id = $1",
        vec![instance_id.into()],
    )).await.context(h!())?;
    txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update messenger_alert_delivery set outbox_instance_id = null, error = $2, updated_at = now() where id = $1",
        vec![delivery.id.into(), format!("Відправник не доставив повідомлення: {}", outbox.status).into()],
    )).await.context(h!())?;
    Ok(false)
}

async fn schedule_sender(
    txn: &DatabaseTransaction,
    delivery: &mut Delivery,
    settings: &MessengerAlertSettings,
) -> anyhow::Result<()> {
    #[derive(FromQueryResult)]
    struct Sender {
        id: i64,
        name: String,
        source: String,
    }
    let source = if delivery.recipient_profile_id.contains('@') {
        "whatsapp"
    } else {
        "signal"
    };
    let senders = Sender::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "select d.id, ec.name, ea.source::text source from datasource d join echo_client_lock ecl on ecl.id = d.echo_client_lock_id join echo_client ec on ec.id = ecl.client_id join echo_account ea on ea.id = ecl.account_id where d.id = any($1) and not (d.id = any($2)) and d.deleted = false and d.status = 'active' and d.can_send_messages = true and ec.deleted = false and ecl.remove_requested = false and ea.is_linked = true and ea.source::text = $3 order by array_position($1, d.id)",
        vec![settings.sender_datasource_ids.clone().into(), delivery.attempted_sender_ids.clone().into(), source.into()],
    )).all(txn).await.context(h!())?;
    for sender in senders {
        delivery.attempted_sender_ids.push(sender.id);
        let attempt = txn.begin().await.context(h!())?;
        let result = echo_im::send_message(SendMessageReq {
            text: format!("Вітаю! Вас згадано у важливому повідомленні, посилання: {}", delivery.message_url),
            source: if sender.source == "signal" { MessageSource::Signal } else { MessageSource::Whatsapp },
            group_ids: vec![], recipient_phone_numbers: vec![delivery.recipient_profile_id.clone()], attachments: vec![],
        }, &sender.name, &attempt, None).await;
        match result {
            Ok(Some(receipt)) => {
                let message_id = receipt
                    .strip_prefix("id:")
                    .context(h!())?
                    .parse::<i32>()
                    .context(h!())?;
                let instance = echo_im::entities::echo_outbox_message_instance::Entity::find()
                    .filter(echo_im::entities::echo_outbox_message_instance::Column::MessageId.eq(message_id))
                    .one(&attempt).await.context(h!())?.context(h!())?;
                attempt.commit().await.context(h!())?;
                txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                    "update messenger_alert_delivery set status = 'sending', sender_datasource_id = $2, outbox_instance_id = $3, attempted_sender_ids = $4, updated_at = now(), next_attempt_at = now() + make_interval(secs => $5) where id = $1",
                    vec![delivery.id.into(), sender.id.into(), instance.id.into(), delivery.attempted_sender_ids.clone().into(), (MESSENGER_ALERT_POLL_SECONDS as f64).into()],
                )).await.context(h!())?;
                return Ok(());
            }
            result => {
                attempt.rollback().await.context(h!())?;
                let error = match result {
                    Err(error) => format!("{error:#}"),
                    _ => "Акаунт не підключений".into(),
                };
                txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                    "update messenger_alert_delivery set attempted_sender_ids = $2, error = $3, updated_at = now() where id = $1",
                    vec![delivery.id.into(), delivery.attempted_sender_ids.clone().into(), error.into()],
                )).await.context(h!())?;
            }
        }
    }
    finish(
        txn,
        delivery.id,
        "failed",
        Some("Немає доступного відправника для месенджера одержувача"),
    )
    .await
    .context(h!())?;
    Ok(())
}

async fn postpone(txn: &impl ConnectionTrait, id: Uuid) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update messenger_alert_delivery set next_attempt_at = now() + make_interval(secs => $2), updated_at = now() where id = $1",
        vec![id.into(), (MESSENGER_ALERT_POLL_SECONDS as f64).into()],
    )).await.context(h!())?;
    Ok(())
}

async fn finish(
    txn: &DatabaseTransaction,
    id: Uuid,
    status: &str,
    error: Option<&str>,
) -> anyhow::Result<()> {
    txn.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update messenger_alert_delivery set status = $2, error = concat_ws('; ', error, $3::text), updated_at = now() where id = $1",
        vec![id.into(), status.into(), error.map(str::to_string).into()],
    )).await.context(h!())?;
    Ok(())
}
