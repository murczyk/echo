use super::{insert, query, record_source, stage_source, types};
use crate::entities::{
    login, signal_group, signal_message, signal_message_group,
};
use crate::functest::tests::{
    cleanup_locked, find_test_login, mk_signal_group, mk_signal_message,
    mk_signal_message_group,
};
use sea_orm::sea_query::Expr;
use sea_orm::*;
use uuid::Uuid;

async fn message(
    db: &DatabaseConnection,
    login: Uuid,
    body: &str,
) -> signal_message::Model {
    mk_signal_message(
        db,
        signal_message::ActiveModel {
            body: Set(Some(body.to_string())),
            datasource_group_id: Set(None),
            login_id: Set(Some(login)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn load(
    db: &DatabaseConnection,
    login: Uuid,
    ids: Vec<i64>,
) -> types::MessageRepliesRsp {
    query::load(
        db,
        &login,
        &types::MessageRepliesReq {
            signal_message_ids: ids,
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap()
}

async fn set_deleted(db: &DatabaseConnection, id: i64, deleted: bool) {
    signal_message::Entity::update_many()
        .col_expr(signal_message::Column::Deleted, Expr::value(deleted))
        .filter(signal_message::Column::Id.eq(id))
        .exec(db)
        .await
        .unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_preserved_deleted_endpoints_and_narrow_previews() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let original =
        message(&env.dbx, login.id, "Перший\r\nДругий\nПрихований третій")
            .await;
    let reply = message(&env.dbx, login.id, "Відповідь").await;
    let id = insert(&env.dbx, Some(original.id), reply.id, false, false)
        .await
        .unwrap();
    assert_eq!(
        insert(&env.dbx, Some(original.id), reply.id, false, false)
            .await
            .unwrap(),
        id
    );
    for anchor in [original.id, reply.id] {
        let response = load(&env.dbx, login.id, vec![anchor]).await;
        assert_eq!(response.replies.len(), 1);
        assert_eq!(response.replies[0].id, id);
        let citation = response
            .reply_messages
            .iter()
            .find(|m| m.id == original.id)
            .unwrap();
        assert_eq!(citation.preview, "Перший\nДругий");
        assert!(citation.href.starts_with("/rer-duty-neo?m="));
    }
    let stage = env.dbx.begin().await.unwrap();
    stage
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "update signal_message set deleted = true where id = $1",
            vec![original.id.into()],
        ))
        .await
        .unwrap();
    stage
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "update signal_message set deleted = false where id = $1",
            vec![original.id.into()],
        ))
        .await
        .unwrap();
    let restored = query::load(
        &stage,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![reply.id],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert!(!restored.replies[0].deleted);
    stage.commit().await.unwrap();
    let mut original = original.into_active_model();
    original.deleted = Set(true);
    original.update(&env.dbx).await.unwrap();
    let response = load(&env.dbx, login.id, vec![reply.id]).await;
    assert_eq!(response.replies.len(), 1);
    assert!(response.replies[0].deleted);
    assert!(!response
        .reply_messages
        .iter()
        .any(|m| Some(m.id) == response.replies[0].original_signal_message_id));
    signal_message::Entity::delete_by_id(
        response.replies[0].original_signal_message_id.unwrap(),
    )
    .exec(&env.dbx)
    .await
    .unwrap();
    let response = load(&env.dbx, login.id, vec![reply.id]).await;
    assert_eq!(response.replies[0].original_signal_message_id, None);
    assert!(response.replies[0].deleted);
    set_deleted(&env.dbx, reply.id, true).await;
    set_deleted(&env.dbx, reply.id, false).await;
    assert!(load(&env.dbx, login.id, vec![reply.id]).await.replies[0].deleted);
    assert!(signal_message::Entity::find_by_id(reply.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .is_some());
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_distinguished_unresolved_originals_from_deleted_endpoints(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let reply = message(&env.dbx, login.id, "Очікуємо на оригінал").await;
    insert(&env.dbx, None, reply.id, false, false)
        .await
        .unwrap();
    set_deleted(&env.dbx, reply.id, true).await;
    assert!(load(&env.dbx, login.id, vec![reply.id])
        .await
        .replies
        .is_empty());
    set_deleted(&env.dbx, reply.id, false).await;
    let response = load(&env.dbx, login.id, vec![reply.id]).await;
    assert_eq!(response.replies[0].original_signal_message_id, None);
    assert!(!response.replies[0].deleted);

    let original = message(&env.dbx, login.id, "Видалена відповідь").await;
    let relation = insert(&env.dbx, Some(original.id), reply.id, false, false)
        .await
        .unwrap();
    signal_message::Entity::delete_by_id(reply.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    set_deleted(&env.dbx, original.id, true).await;
    set_deleted(&env.dbx, original.id, false).await;
    let response = load(&env.dbx, login.id, vec![original.id]).await;
    assert_eq!(response.replies[0].id, relation);
    assert_eq!(response.replies[0].reply_signal_message_id, None);
    assert!(response.replies[0].deleted);
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_submitted_multiple_citations_atomically_and_rejected_hidden_sources(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let first = message(&env.dbx, login.id, "Оригінал один").await;
    let second = message(&env.dbx, login.id, "Оригінал два").await;
    let forbidden = mk_signal_group(
        &env.dbx,
        signal_group::ActiveModel {
            master_key: Set("000-forbidden-reply-group".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for original in [&first, &second] {
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(original.id),
                group_master_key: Set(Some(forbidden.master_key.clone())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(original.id),
                group_master_key: Set(Some("vukho-test-master-key".into())),
                datasource_group_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let payload = serde_json::from_value(serde_json::json!({
        "text": "Нова відповідь", "cited_signal_message_ids": [first.id, second.id, first.id],
        "signal_group_master_key": forbidden.master_key
    })).unwrap();
    let submitted = crate::sigint::direct_submit::bl::submit_signal_message(
        &login.id, &env, payload,
    )
    .await
    .unwrap();
    let response =
        load(&env.dbx, login.id, vec![submitted.signal_message_id]).await;
    assert_eq!(response.replies.len(), 2);
    let hidden = crate::functest::tests::mk_login(
        &env.dbx,
        login::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let hidden_message =
        message(&env.dbx, hidden.id, "Недоступний оригінал").await;
    let before = signal_message::Entity::find()
        .count(&env.dbx)
        .await
        .unwrap();
    let payload = serde_json::from_value(serde_json::json!({
        "text": "Заборонена відповідь", "cited_signal_message_ids": [first.id, hidden_message.id]
    })).unwrap();
    assert!(crate::sigint::direct_submit::bl::submit_signal_message(
        &login.id, &env, payload
    )
    .await
    .is_err());
    assert_eq!(
        signal_message::Entity::find()
            .count(&env.dbx)
            .await
            .unwrap(),
        before
    );
    assert!(load(&env.dbx, login.id, vec![hidden_message.id])
        .await
        .reply_messages
        .is_empty());
    let no_destination = message(&env.dbx, login.id, "Без групи").await;
    let txn = env.dbx.begin().await.unwrap();
    assert!(super::prepare_submission(
        &txn,
        &login.id,
        &[no_destination.id],
        None
    )
    .await
    .is_err());
    txn.rollback().await.unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_source_identity_survived_queue_consumption_and_late_original(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let original = message(&env.dbx, login.id, "Оригінал").await;
    let reply = message(&env.dbx, login.id, "Відповідь раніше оригіналу").await;
    let txn = env.dbx.begin().await.unwrap();
    let mut snapshot = echo_im::types::MessageF1 {
        id: Some("receipt-test".into()),
        text: "Reply".into(),
        sender: None,
        sender_phone_number: None,
        group_id: None,
        attachments: vec![],
        message_source: echo_im::types::MessageSource::Signal,
        timestamp: chrono::Utc::now().naive_utc(),
        internal_id: 2,
        reply_to: Some(echo_im::types::ReplyF1 {
            receipt: "inbox-id:1".into(),
            is_outbox_message: false,
            timestamp: None,
            text: "Original".into(),
        }),
        deleted: false,
    };
    assert!(stage_source(&txn, 3612, &snapshot).await.unwrap());
    assert!(!stage_source(&txn, 3612, &snapshot).await.unwrap());
    snapshot.internal_id = 1;
    snapshot.message_source = echo_im::types::MessageSource::Whatsapp;
    snapshot.reply_to = None;
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 2, reply.id).await.unwrap();
    record_source(&txn, 3612, 2, reply.id).await.unwrap();
    snapshot.internal_id = 3;
    snapshot.reply_to = Some(echo_im::types::ReplyF1 {
        receipt: "inbox-id:1".into(),
        is_outbox_message: false,
        timestamp: None,
        text: "Original".into(),
    });
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 3, reply.id).await.unwrap();
    let pending = types::MessageRepliesReq {
        signal_message_ids: vec![reply.id],
        screen: types::MessageReplyScreen::Analysis,
    };
    let before = query::load(&txn, &login.id, &pending).await.unwrap();
    assert_eq!(before.replies.len(), 1);
    assert_eq!(before.replies[0].original_signal_message_id, None);
    record_source(&txn, 3612, 1, original.id).await.unwrap();
    let after = query::load(&txn, &login.id, &pending).await.unwrap();
    assert_eq!(after.replies.len(), 1);
    assert_eq!(
        after.replies[0].original_signal_message_id,
        Some(original.id)
    );
    assert!(after
        .reply_messages
        .iter()
        .all(|m| m.href.starts_with("/rer-analysis-neo?m=")));
    snapshot.internal_id = 5;
    snapshot.reply_to = Some(echo_im::types::ReplyF1 {
        receipt: "inbox-id:4".into(),
        is_outbox_message: false,
        timestamp: None,
        text: "Duplicate original".into(),
    });
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 5, reply.id).await.unwrap();
    snapshot.internal_id = 4;
    snapshot.reply_to = None;
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 4, original.id).await.unwrap();
    let merged = query::load(&txn, &login.id, &pending).await.unwrap();
    assert_eq!(merged.replies.len(), 1);
    let promoted_original =
        message(&env.dbx, login.id, "Інший канонічний оригінал").await;
    record_source(&txn, 3612, 1, promoted_original.id)
        .await
        .unwrap();
    let split = query::load(&txn, &login.id, &pending).await.unwrap();
    assert_eq!(split.replies.len(), 2);
    assert!(split.replies.iter().any(|relation| relation
        .original_signal_message_id
        == Some(original.id)));
    assert!(split
        .replies
        .iter()
        .any(|relation| relation.original_signal_message_id
            == Some(promoted_original.id)));
    record_source(&txn, 3612, 1, original.id).await.unwrap();
    assert_eq!(
        query::load(&txn, &login.id, &pending)
            .await
            .unwrap()
            .replies
            .len(),
        1
    );
    let promoted_reply =
        message(&env.dbx, login.id, "Інша канонічна відповідь").await;
    record_source(&txn, 3612, 2, promoted_reply.id)
        .await
        .unwrap();
    let promoted = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![promoted_reply.id],
            screen: types::MessageReplyScreen::Analysis,
        },
    )
    .await
    .unwrap();
    assert_eq!(promoted.replies.len(), 1);
    assert_eq!(
        promoted.replies[0].original_signal_message_id,
        Some(original.id)
    );
    assert_eq!(
        query::load(&txn, &login.id, &pending)
            .await
            .unwrap()
            .replies
            .len(),
        1
    );
    record_source(&txn, 3612, 2, reply.id).await.unwrap();
    assert_eq!(
        query::load(&txn, &login.id, &pending)
            .await
            .unwrap()
            .replies
            .len(),
        1
    );
    signal_message::Entity::delete_by_id(original.id)
        .exec(&txn)
        .await
        .unwrap();
    let later_reply =
        message(&env.dbx, login.id, "After original retention").await;
    snapshot.internal_id = 7;
    snapshot.reply_to = Some(echo_im::types::ReplyF1 {
        receipt: "inbox-id:1".into(),
        is_outbox_message: false,
        timestamp: None,
        text: "Original".into(),
    });
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 7, later_reply.id).await.unwrap();
    let tombstone = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![later_reply.id],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert!(tombstone.replies[0].deleted);
    txn.rollback().await.unwrap();
}
