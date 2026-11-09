use super::*;
use crate::entities::sea_orm_active_enums::{AccountStatus, EchoMessageSource};
use crate::entities::*;
use crate::functest::tests::{
    cleanup_locked, find_test_login, find_test_signal_group,
};
use crate::sigint::direct_submit::{bl, types::DirectSubmitPayload};
use serial_test::serial;

async fn messenger(
    db: &DatabaseConnection,
    source: EchoMessageSource,
) -> datasource::Model {
    let account = echo_account::ActiveModel {
        source: Set(source.clone()),
        phone_number: Set(format!(
            "+380{}",
            uuid::Uuid::now_v7().as_u128() % 1_000_000_000
        )),
        is_linked: Set(true),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let client = echo_client::ActiveModel {
        name: Set(format!("group-sending-{}", uuid::Uuid::now_v7())),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let lock = echo_client_lock::ActiveModel {
        account_id: Set(account.id),
        client_id: Set(client.id),
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

async fn configure(
    env: &Env,
    source: EchoMessageSource,
) -> (uuid::Uuid, String, datasource::Model) {
    let login = find_test_login(&env.dbx).await.unwrap();
    let datasource = messenger(&env.dbx, source).await;
    let group = find_test_signal_group(&env.dbx).await.unwrap();
    let key = group.master_key.clone();
    let mut group = group.into_active_model();
    group.datasource_id = Set(Some(datasource.id));
    group.update(&env.dbx).await.unwrap();
    assert!(!read(&env.dbx, &key).await.unwrap().send_messages);
    let txn = env.dbx.begin().await.unwrap();
    set(&txn, &key, Some(true), Some(&[login.organism_id.unwrap()]))
        .await
        .unwrap();
    txn.commit().await.unwrap();
    (login.id, key, datasource)
}

fn payload(key: &str, text: &str) -> DirectSubmitPayload {
    serde_json::from_value(serde_json::json!({
        "text": text, "signal_group_master_key": key,
    }))
    .unwrap()
}

async fn outbox_count(db: &DatabaseConnection) -> usize {
    echo_outbox_message::Entity::find()
        .all(db)
        .await
        .unwrap()
        .len()
}

#[actix_web::test]
#[serial]
async fn issue_4103_only_allowed_new_items_reach_the_originating_messenger() {
    for source in [EchoMessageSource::Signal, EchoMessageSource::Whatsapp] {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let (login_id, key, datasource) = configure(&env, source).await;
        let before = outbox_count(&env.dbx).await;
        let created = bl::submit_signal_message(
            &login_id,
            &env,
            payload(&key, "New item"),
        )
        .await
        .unwrap();
        assert_eq!(outbox_count(&env.dbx).await, before + 1);
        let outbox = echo_outbox_message::Entity::find()
            .order_by_desc(echo_outbox_message::Column::Id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert!(outbox.body.contains("New item"));
        let instance = echo_outbox_message_instance::Entity::find()
            .filter(
                echo_outbox_message_instance::Column::MessageId.eq(outbox.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let target = echo_group::Entity::find_by_id(instance.group_id.unwrap())
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.group_id, key);

        bl::edit_signal_message(
            &login_id,
            &env,
            created.signal_message_id,
            payload(&key, "Edited item"),
        )
        .await
        .unwrap();
        assert_eq!(outbox_count(&env.dbx).await, before + 1);

        let txn = env.dbx.begin().await.unwrap();
        set(&txn, &key, None, Some(&[])).await.unwrap();
        txn.commit().await.unwrap();
        let local = bl::submit_signal_message(
            &login_id,
            &env,
            payload(&key, "Local only"),
        )
        .await
        .unwrap();
        assert!(signal_message::Entity::find_by_id(local.signal_message_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert_eq!(outbox_count(&env.dbx).await, before + 1);

        let login = find_test_login(&env.dbx).await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        set(&txn, &key, Some(false), Some(&[login.organism_id.unwrap()]))
            .await
            .unwrap();
        txn.commit().await.unwrap();
        bl::submit_signal_message(
            &login_id,
            &env,
            payload(&key, "Group disabled"),
        )
        .await
        .unwrap();
        assert_eq!(outbox_count(&env.dbx).await, before + 1);

        let txn = env.dbx.begin().await.unwrap();
        set(&txn, &key, Some(true), None).await.unwrap();
        txn.commit().await.unwrap();
        let mut datasource = datasource.into_active_model();
        datasource.can_send_messages = Set(Some(false));
        datasource.update(&env.dbx).await.unwrap();
        bl::submit_signal_message(
            &login_id,
            &env,
            payload(&key, "Messenger disabled"),
        )
        .await
        .unwrap();
        assert_eq!(outbox_count(&env.dbx).await, before + 1);
        assert!(!read(&env.dbx, &key).await.unwrap().can_send_messages);
        let txn = env.dbx.begin().await.unwrap();
        assert!(set(&txn, &key, Some(true), None).await.is_err());
        txn.rollback().await.unwrap();
    }
}

#[actix_web::test]
#[serial]
async fn issue_4103_text_and_attachment_queue_rolls_back_with_the_item() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (login_id, key, datasource) =
        configure(&env, EchoMessageSource::Signal).await;
    let lock = echo_client_lock::Entity::find_by_id(
        i32::try_from(datasource.echo_client_lock_id.unwrap()).unwrap(),
    )
    .one(&env.dbx)
    .await
    .unwrap()
    .unwrap();
    echo_account::ActiveModel {
        id: Set(lock.account_id),
        is_linked: Set(false),
        ..Default::default()
    }
    .update(&env.dbx)
    .await
    .unwrap();
    let mut env = env.as_ref().clone();
    let operator = opendal::Operator::new(opendal::services::Memory::default())
        .unwrap()
        .finish();
    env.s3 = Some(operator.clone());
    env.s3_config = Some(crate::storage::S3Config {
        bucket: "test".into(),
        region: String::new(),
        endpoint: String::new(),
        access_key_id: String::new(),
        secret_access_key: String::new(),
        prefix: String::new(),
    });
    let txn = env.dbx.begin().await.unwrap();
    set(&txn, &key, Some(false), None).await.unwrap();
    txn.commit().await.unwrap();
    let item = bl::submit_signal_message(
        &login_id,
        &env,
        payload(&key, "With attachment"),
    )
    .await
    .unwrap();
    let bytes = b"attachment contents";
    operator
        .write("sending-test.txt", bytes.to_vec())
        .await
        .unwrap();
    signal_message_media::ActiveModel {
        id: Set(uuid::Uuid::now_v7()),
        signal_message_id: Set(item.signal_message_id),
        content_type: Set("text/plain".into()),
        file_ext: Set(Some("txt".into())),
        file_name: Set(Some("test.txt".into())),
        size_bytes: Set(bytes.len() as i64),
        is_encrypted: Set(false),
        storage_key: Set(Some("sending-test.txt".into())),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let before = outbox_count(&env.dbx).await;
    let txn = env.dbx.begin().await.unwrap();
    set(&txn, &key, Some(true), None).await.unwrap();
    enqueue(&env, &txn, &login_id, item.signal_message_id)
        .await
        .unwrap();
    txn.rollback().await.unwrap();
    assert_eq!(outbox_count(&env.dbx).await, before);
    let txn = env.dbx.begin().await.unwrap();
    set(&txn, &key, Some(true), None).await.unwrap();
    enqueue(&env, &txn, &login_id, item.signal_message_id)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    let attachment = echo_outbox_message_attachment::Entity::find()
        .order_by_desc(echo_outbox_message_attachment::Column::Id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        STANDARD.decode(attachment.content_base64.unwrap()).unwrap(),
        bytes
    );
    assert_eq!(attachment.extension.as_deref(), Some("txt"));
}
