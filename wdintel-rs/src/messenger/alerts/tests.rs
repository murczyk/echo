use super::*;
use crate::entities::sea_orm_active_enums::{
    AccountStatus, EchoMessageDeliveryStatus, EchoMessageSource,
};
use crate::entities::*;
use crate::functest::tests::{
    cleanup_locked, find_test_login, find_test_signal_group, mk_login,
    mk_sigint_important, mk_sigint_inbox_item,
};
use sea_orm::ActiveValue::Set;
use serial_test::serial;

async fn sender(
    db: &DatabaseConnection,
    source: EchoMessageSource,
    linked: bool,
) -> datasource::Model {
    let account = echo_account::ActiveModel {
        source: Set(source.clone()),
        phone_number: Set(format!(
            "+380{:09}",
            Uuid::now_v7().as_u128() % 1_000_000_000
        )),
        is_linked: Set(linked),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let client = echo_client::ActiveModel {
        name: Set(format!("alert-test-{}", Uuid::now_v7())),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let lock = echo_client_lock::ActiveModel {
        client_id: Set(client.id),
        account_id: Set(account.id),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    datasource::ActiveModel {
        kind: Set(if source == EchoMessageSource::Signal {
            "signal"
        } else {
            "whatsapp"
        }
        .into()),
        display_name: Set(client.name),
        echo_client_lock_id: Set(Some(i64::from(lock.id))),
        status: Set(AccountStatus::Active),
        can_send_messages: Set(Some(true)),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn mention(db: &DatabaseConnection, profile: &str) -> (Uuid, Uuid, Uuid) {
    let actor = find_test_login(db).await.unwrap();
    let group = find_test_signal_group(db).await.unwrap();
    signal_profile::ActiveModel {
        uuid: Set(profile.into()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let recipient = mk_login(
        db,
        login::ActiveModel {
            signal_profile_id: Set(Some(profile.into())),
            organism_id: Set(actor.organism_id),
            sigint_zone_id: Set(actor.sigint_zone_id),
            roles: Set(serde_json::json!(["Rer"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_sigint_inbox_item(db, Default::default()).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "insert into signal_message_group (signal_message_id, group_master_key) values ($1, $2)",
        vec![message.id.into(), group.master_key.clone().into()],
    )).await.unwrap();
    let important = mk_sigint_important(
        db,
        sigint_important::ActiveModel {
            login_id: Set(Some(actor.id)),
            signal_message_id: Set(message.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let event = Uuid::now_v7();
    let receipt = Uuid::now_v7();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "insert into notification_event (id, operation_id, actor_login_id, signal_message_id, sigint_important_id, group_master_key) values ($1, $2, $3, $4, $5, $6)",
        vec![event.into(), Uuid::now_v7().into(), actor.id.into(), message.id.into(), important.id.into(), group.master_key.into()],
    )).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "insert into notification_receipt (id, event_id, recipient_login_id) values ($1, $2, $3)",
        vec![receipt.into(), event.into(), recipient.id.into()],
    )).await.unwrap();
    (event, recipient.id, message.id_uuid.unwrap())
}

async fn configure(db: &DatabaseConnection, ids: Vec<i64>) {
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update messenger_alert_settings set enabled = true, sender_datasource_ids = $1 where id = 1", vec![ids.into()],
    )).await.unwrap();
}

async fn opt_in(db: &DatabaseConnection, recipient: Uuid, enabled: bool) {
    db.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "insert into user_settings (login_id, receive_alerts_in_messenger) values ($1, $2) on conflict (login_id) do update set receive_alerts_in_messenger = excluded.receive_alerts_in_messenger",
        vec![recipient.into(), enabled.into()],
    )).await.unwrap();
}

async fn queue(db: &DatabaseConnection, event: Uuid) {
    let txn = db.begin().await.unwrap();
    enqueue(&txn, event, "echo.example").await.unwrap();
    txn.commit().await.unwrap();
}

async fn delivery(db: &DatabaseConnection) -> messenger_alert_delivery::Model {
    messenger_alert_delivery::Entity::find()
        .one(db)
        .await
        .unwrap()
        .unwrap()
}

async fn poll(db: &DatabaseConnection) {
    db.execute_unprepared(
        "update messenger_alert_delivery set next_attempt_at = now()",
    )
    .await
    .unwrap();
    worker::process_batch(db).await.unwrap();
}

#[actix_web::test]
#[serial]
async fn echo_3610_alert_queue_requires_opt_in_and_rechecks_it_before_send() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let sender = sender(&env.dbx, EchoMessageSource::Signal, true).await;
    configure(&env.dbx, vec![sender.id]).await;
    let (event, recipient, message_uuid) =
        mention(&env.dbx, &Uuid::now_v7().to_string()).await;
    queue(&env.dbx, event).await;
    assert_eq!(
        messenger_alert_delivery::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        0
    );
    opt_in(&env.dbx, recipient, true).await;
    queue(&env.dbx, event).await;
    queue(&env.dbx, event).await;
    assert_eq!(
        messenger_alert_delivery::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        delivery(&env.dbx).await.message_url,
        format!("https://echo.example/rer-analysis-neo?m={message_uuid}")
    );
    opt_in(&env.dbx, recipient, false).await;
    poll(&env.dbx).await;
    assert_eq!(delivery(&env.dbx).await.status, "skipped");
    assert!(delivery(&env.dbx).await.outbox_instance_id.is_none());
}

#[actix_web::test]
#[serial]
async fn echo_3610_alerts_match_protocol_fall_back_after_error_and_wait_for_send_confirmation(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let signal = sender(&env.dbx, EchoMessageSource::Signal, true).await;
    let whatsapp = sender(&env.dbx, EchoMessageSource::Whatsapp, true).await;
    let fallback = sender(&env.dbx, EchoMessageSource::Whatsapp, true).await;
    configure(&env.dbx, vec![signal.id, whatsapp.id, fallback.id]).await;
    let (event, recipient, _) =
        mention(&env.dbx, &format!("{}@lid", Uuid::now_v7())).await;
    opt_in(&env.dbx, recipient, true).await;
    queue(&env.dbx, event).await;
    let before = echo_outbox_message::Entity::find()
        .count(&env.dbx)
        .await
        .unwrap();
    let (first_worker, second_worker) = tokio::join!(
        worker::process_batch(&env.dbx),
        worker::process_batch(&env.dbx)
    );
    first_worker.unwrap();
    second_worker.unwrap();
    assert_eq!(
        echo_outbox_message::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        before + 1
    );
    let first = delivery(&env.dbx).await;
    assert_eq!(first.sender_datasource_id, Some(whatsapp.id));
    assert_eq!(first.status, "sending");
    let first_id = first.outbox_instance_id.unwrap();
    let mut instance =
        echo_outbox_message_instance::Entity::find_by_id(first_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    instance.status = Set(EchoMessageDeliveryStatus::Error);
    instance.sent_at = Set(Some(chrono::Utc::now().naive_utc()));
    instance.update(&env.dbx).await.unwrap();
    poll(&env.dbx).await;
    let second = delivery(&env.dbx).await;
    assert_eq!(second.sender_datasource_id, Some(fallback.id));
    assert_eq!(second.attempted_sender_ids, vec![whatsapp.id, fallback.id]);
    assert_eq!(
        echo_outbox_message_instance::Entity::find_by_id(first_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .status,
        EchoMessageDeliveryStatus::Expired
    );
    let mut instance = echo_outbox_message_instance::Entity::find_by_id(
        second.outbox_instance_id.unwrap(),
    )
    .one(&env.dbx)
    .await
    .unwrap()
    .unwrap()
    .into_active_model();
    instance.status = Set(EchoMessageDeliveryStatus::Sent);
    let instance = instance.update(&env.dbx).await.unwrap();
    poll(&env.dbx).await;
    assert_eq!(delivery(&env.dbx).await.status, "sending");
    let mut instance = instance.into_active_model();
    instance.send_ok = Set(true);
    instance.sent_at = Set(Some(chrono::Utc::now().naive_utc()));
    instance.update(&env.dbx).await.unwrap();
    poll(&env.dbx).await;
    let sent = delivery(&env.dbx).await;
    assert_eq!(sent.status, "sent");
    assert!(sent.sent_at.is_some());
}

#[actix_web::test]
#[serial]
async fn echo_3610_alerts_skip_offline_accounts_and_expire_stalled_sends_before_fallback(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let offline = sender(&env.dbx, EchoMessageSource::Signal, false).await;
    let stalled = sender(&env.dbx, EchoMessageSource::Signal, true).await;
    let fallback = sender(&env.dbx, EchoMessageSource::Signal, true).await;
    configure(&env.dbx, vec![offline.id, stalled.id, fallback.id]).await;
    let (event, recipient, _) =
        mention(&env.dbx, &Uuid::now_v7().to_string()).await;
    opt_in(&env.dbx, recipient, true).await;
    queue(&env.dbx, event).await;
    poll(&env.dbx).await;
    let first = delivery(&env.dbx).await;
    assert_eq!(first.sender_datasource_id, Some(stalled.id));
    env.dbx.execute_raw(Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "update echo_outbox_message_instance set created_at = now() - interval '2 minutes' where id = $1",
        vec![first.outbox_instance_id.unwrap().into()],
    )).await.unwrap();
    poll(&env.dbx).await;
    assert_eq!(
        delivery(&env.dbx).await.sender_datasource_id,
        Some(fallback.id)
    );
    assert_eq!(
        echo_outbox_message_instance::Entity::find_by_id(
            first.outbox_instance_id.unwrap()
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .status,
        EchoMessageDeliveryStatus::Expired
    );
    opt_in(&env.dbx, recipient, false).await;
    poll(&env.dbx).await;
    assert_eq!(delivery(&env.dbx).await.status, "skipped");
}

#[actix_web::test]
#[serial]
async fn echo_3610_alerts_recheck_access_and_profile_links_before_delivery() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let sender = sender(&env.dbx, EchoMessageSource::Signal, true).await;
    configure(&env.dbx, vec![sender.id]).await;
    for remove_profile in [false, true] {
        let (event, recipient, _) =
            mention(&env.dbx, &Uuid::now_v7().to_string()).await;
        opt_in(&env.dbx, recipient, true).await;
        queue(&env.dbx, event).await;
        let mut recipient = login::Entity::find_by_id(recipient)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        if remove_profile {
            recipient.signal_profile_id = Set(None);
        } else {
            recipient.deleted = Set(true);
        }
        let recipient = recipient.update(&env.dbx).await.unwrap();
        poll(&env.dbx).await;
        let alert = messenger_alert_delivery::Entity::find()
            .filter(
                messenger_alert_delivery::Column::RecipientLoginId
                    .eq(recipient.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(alert.status, "skipped");
        assert!(alert.outbox_instance_id.is_none());
    }
}
