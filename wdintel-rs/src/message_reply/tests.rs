use super::{insert, query, record_source, stage_source, types};
use crate::entities::{
    intel_product, login, signal_group, signal_message, signal_message_group,
};
use crate::functest::tests::{
    cleanup_locked, find_test_login, mk_datasource, mk_signal_group,
    mk_signal_message, mk_signal_message_group,
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
            sender: Set(None),
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

fn native_snapshot(
    receipt: i64,
    original: Option<i64>,
) -> echo_im::types::MessageF1 {
    echo_im::types::MessageF1 {
        id: Some(format!("receipt-{receipt}")),
        text: "Native message".into(),
        sender: None,
        sender_phone_number: None,
        group_id: None,
        attachments: vec![],
        message_source: echo_im::types::MessageSource::Signal,
        timestamp: chrono::Utc::now().naive_utc(),
        internal_id: receipt.try_into().unwrap(),
        reply_to: original.map(|id| echo_im::types::ReplyF1 {
            receipt: format!("inbox-id:{id}"),
            is_outbox_message: false,
            timestamp: None,
            text: String::new(),
        }),
        deleted: false,
    }
}

async fn stage_native(
    db: &DatabaseTransaction,
    receipt: i64,
    original: Option<i64>,
    canonical: i64,
) {
    stage_source(db, 3612, &native_snapshot(receipt, original))
        .await
        .unwrap();
    record_source(db, 3612, receipt, canonical).await.unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_reparented_long_threads_without_recursive_trigger_updates(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let head = message(&env.dbx, login.id, "Late head").await;
    let first = message(&env.dbx, login.id, "First reply").await;
    let txn = env.dbx.begin().await.unwrap();
    let mut previous = first.id;
    for _ in 0..128 {
        let reply = message(&env.dbx, login.id, "Nested native reply").await;
        insert(&txn, Some(previous), reply.id, false, false)
            .await
            .unwrap();
        previous = reply.id;
    }
    insert(&txn, Some(head.id), first.id, false, false)
        .await
        .unwrap();
    let thread = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![previous],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert_eq!(thread.replies.len(), 129);
    assert!(thread
        .replies
        .iter()
        .all(|relation| relation.original_signal_message_id == Some(head.id)));
    txn.rollback().await.unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_resolved_late_native_ancestors_and_kept_deleted_head_threads(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let head = message(&env.dbx, login.id, "Thread head").await;
    let middle = message(&env.dbx, login.id, "Middle reply").await;
    let tail = message(&env.dbx, login.id, "Tail reply").await;
    let sibling = message(&env.dbx, login.id, "Sibling reply").await;
    let txn = env.dbx.begin().await.unwrap();
    stage_native(&txn, 3, Some(2), tail.id).await;
    stage_native(&txn, 4, Some(3), sibling.id).await;
    stage_native(&txn, 2, Some(1), middle.id).await;
    let mut snapshot = native_snapshot(1, None);
    snapshot.message_source = echo_im::types::MessageSource::Whatsapp;
    stage_source(&txn, 3612, &snapshot).await.unwrap();
    record_source(&txn, 3612, 1, head.id).await.unwrap();
    txn.commit().await.unwrap();
    for anchor in [head.id, middle.id, tail.id, sibling.id] {
        let thread = load(&env.dbx, login.id, vec![anchor]).await;
        assert_eq!(thread.replies.len(), 3);
        assert!(thread.replies.iter().all(|relation| relation
            .original_signal_message_id
            == Some(head.id)));
        assert_eq!(thread.reply_messages.len(), 4);
    }
    let relations = crate::entities::message_reply::Entity::find()
        .order_by_asc(crate::entities::message_reply::Column::Id)
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(relations[0].engaged_message_id, Some(middle.id));
    assert_eq!(relations[1].engaged_message_id, Some(tail.id));
    set_deleted(&env.dbx, middle.id, true).await;
    let thread = load(&env.dbx, login.id, vec![tail.id]).await;
    assert_eq!(
        thread
            .replies
            .iter()
            .filter(|relation| relation.reply_deleted)
            .count(),
        1
    );
    assert!(thread
        .reply_messages
        .iter()
        .any(|message| message.id == sibling.id));
    signal_message::Entity::delete_by_id(head.id)
        .exec(&env.dbx)
        .await
        .unwrap();
    let thread = load(&env.dbx, login.id, vec![tail.id]).await;
    assert_eq!(thread.replies.len(), 3);
    assert!(thread
        .replies
        .iter()
        .all(|relation| relation.original_deleted
            && relation.original_signal_message_id.is_none()));
    assert!(thread
        .reply_messages
        .iter()
        .any(|message| message.id == sibling.id));
    crate::entities::message_reply_change::Entity::delete_many()
        .exec(&env.dbx)
        .await
        .unwrap();
    let appended = message(&env.dbx, login.id, "After head deletion").await;
    insert(&env.dbx, Some(tail.id), appended.id, false, false)
        .await
        .unwrap();
    assert_eq!(
        load(&env.dbx, login.id, vec![appended.id])
            .await
            .replies
            .len(),
        4
    );
    assert!(
        crate::entities::message_reply_change::Entity::find_by_id(tail.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some()
    );
    let native_append =
        message(&env.dbx, login.id, "Native reply after head retention").await;
    let txn = env.dbx.begin().await.unwrap();
    stage_native(&txn, 5, Some(1), native_append.id).await;
    txn.commit().await.unwrap();
    let thread = load(&env.dbx, login.id, vec![native_append.id]).await;
    assert_eq!(thread.replies.len(), 5);
    assert!(thread
        .replies
        .iter()
        .all(|relation| relation.original_deleted));
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
async fn replies_3612_submitted_single_target_threads_atomically_and_rejected_hidden_sources(
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
        "text": "Нова відповідь", "engaged_message_id": first.id,
        "signal_group_master_key": forbidden.master_key
    }))
    .unwrap();
    let submitted = crate::sigint::direct_submit::bl::submit_signal_message(
        &login.id, &env, payload,
    )
    .await
    .unwrap();
    let response =
        load(&env.dbx, login.id, vec![submitted.signal_message_id]).await;
    assert_eq!(response.replies.len(), 1);
    let payload = serde_json::from_value(serde_json::json!({
        "text": "Відповідь на відповідь", "engaged_message_id": submitted.signal_message_id,
    })).unwrap();
    let nested = crate::sigint::direct_submit::bl::submit_signal_message(
        &login.id, &env, payload,
    )
    .await
    .unwrap();
    for anchor in [
        first.id,
        submitted.signal_message_id,
        nested.signal_message_id,
    ] {
        let thread = load(&env.dbx, login.id, vec![anchor]).await;
        assert_eq!(thread.replies.len(), 2);
        assert!(thread
            .replies
            .iter()
            .all(|reply| reply.original_signal_message_id == Some(first.id)));
    }
    let relation = crate::entities::message_reply::Entity::find()
        .filter(
            crate::entities::message_reply::Column::ReplySignalMessageId
                .eq(nested.signal_message_id),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        relation.engaged_message_id,
        Some(submitted.signal_message_id)
    );
    assert!(serde_json::from_value::<crate::sigint::direct_submit::types::DirectSubmitPayload>(
        serde_json::json!({"text": "Кілька цілей", "engaged_message_id": [first.id, second.id]})
    ).is_err());
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
        "text": "Заборонена відповідь", "engaged_message_id": hidden_message.id
    }))
    .unwrap();
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
        no_destination.id,
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
    assert_eq!(split.replies.len(), 1);
    assert_eq!(
        split.replies[0].original_signal_message_id,
        Some(promoted_original.id)
    );
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
    assert_eq!(promoted.replies.len(), 2);
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
        2
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

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_kept_collapsed_quotes_and_split_shared_deleted_reply_history(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let original = message(&env.dbx, login.id, "Canonical original").await;
    let reply = message(&env.dbx, login.id, "Canonical reply").await;
    let promoted = message(&env.dbx, login.id, "Moved original").await;
    let txn = env.dbx.begin().await.unwrap();
    stage_native(&txn, 1, None, original.id).await;
    stage_native(&txn, 2, Some(1), original.id).await;
    let req = types::MessageRepliesReq {
        signal_message_ids: vec![original.id],
        screen: types::MessageReplyScreen::Duty,
    };
    let collapsed = query::load(&txn, &login.id, &req).await.unwrap();
    assert_eq!(collapsed.replies.len(), 1);
    assert_eq!(collapsed.replies[0].original_signal_message_id, None);
    assert!(!collapsed.replies[0].deleted);
    record_source(&txn, 3612, 2, reply.id).await.unwrap();
    let restored = query::load(&txn, &login.id, &req).await.unwrap();
    assert_eq!(
        restored.replies[0].original_signal_message_id,
        Some(original.id)
    );
    assert_eq!(restored.replies[0].reply_signal_message_id, Some(reply.id));
    stage_native(&txn, 4, None, original.id).await;
    stage_native(&txn, 5, Some(4), reply.id).await;
    signal_message::Entity::delete_by_id(reply.id)
        .exec(&txn)
        .await
        .unwrap();
    record_source(&txn, 3612, 1, promoted.id).await.unwrap();
    let history = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![original.id, promoted.id],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert_eq!(history.replies.len(), 2);
    assert!(history.replies.iter().all(|relation| relation.deleted
        && relation.reply_signal_message_id.is_none()));
    assert!(history.replies.iter().any(|relation| relation
        .original_signal_message_id
        == Some(original.id)));
    assert!(history.replies.iter().any(|relation| relation
        .original_signal_message_id
        == Some(promoted.id)));
    txn.rollback().await.unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_concurrent_canonical_moves_did_not_leave_orphan_relationships(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let original = message(&env.dbx, login.id, "Original").await;
    let reply = message(&env.dbx, login.id, "Shared reply").await;
    let first = message(&env.dbx, login.id, "First moved original").await;
    let second = message(&env.dbx, login.id, "Second moved original").await;
    let setup = env.dbx.begin().await.unwrap();
    stage_native(&setup, 1, None, original.id).await;
    stage_native(&setup, 4, None, original.id).await;
    stage_native(&setup, 2, Some(1), reply.id).await;
    stage_native(&setup, 3, Some(4), reply.id).await;
    setup.commit().await.unwrap();
    let first_move = env.dbx.begin().await.unwrap();
    record_source(&first_move, 3612, 1, first.id).await.unwrap();
    let db = env.dbx.clone();
    let mut second_move = tokio::spawn(async move {
        let txn = db.begin().await.unwrap();
        record_source(&txn, 3612, 4, second.id).await.unwrap();
        txn.commit().await.unwrap();
    });
    let finished = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        &mut second_move,
    )
    .await;
    first_move.commit().await.unwrap();
    if let Ok(result) = finished {
        result.unwrap();
    } else {
        second_move.await.unwrap();
    }
    let response = load(&env.dbx, login.id, vec![reply.id]).await;
    assert_eq!(response.replies.len(), 1);
    assert_eq!(
        response.replies[0].original_signal_message_id,
        Some(second.id)
    );
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_queue_split_bound_quotes_to_the_first_active_result() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let original = message(&env.dbx, login.id, "Quoted original").await;
    let txn = env.dbx.begin().await.unwrap();
    let datasource = mk_datasource(&txn, Default::default()).await.unwrap();
    let mut snapshot = native_snapshot(1, None);
    stage_source(&txn, datasource.id, &snapshot).await.unwrap();
    record_source(&txn, datasource.id, 1, original.id)
        .await
        .unwrap();
    let body = (0..12)
        .map(|index| {
            format!(
                "22.10, 10:{index:02}:00\n{}\n{}\n{}\n{}",
                "plain words ".repeat(15),
                "more words ".repeat(15),
                "other words ".repeat(15),
                "last words ".repeat(15)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    snapshot = native_snapshot(2, Some(1));
    snapshot.text = body.clone();
    stage_source(&txn, datasource.id, &snapshot).await.unwrap();
    let mut changed = vec![];
    crate::message_queue::process_signal_message_queue_item(
        crate::messenger::types::Message {
            body,
            group_id: "vukho-test-master-key".into(),
            sender: None,
            timestamp: snapshot.timestamp,
            datasource_id: datasource.id,
            inbox_message_id: Some(2),
        },
        vec![],
        &mut env.redis.clone(),
        env.settlements.clone(),
        &env.rq,
        &env.config,
        &env.s3,
        &txn,
        false,
        &mut changed,
    )
    .await
    .unwrap();
    assert!(changed.len() > 1);
    let first = *changed.iter().min().unwrap();
    let response = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![first],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert_eq!(response.replies.len(), 1);
    assert_eq!(
        response.replies[0].original_signal_message_id,
        Some(original.id)
    );
    assert_eq!(response.replies[0].reply_signal_message_id, Some(first));
    assert!(!response.replies[0].deleted);

    let later = mk_signal_message(
        &txn,
        signal_message::ActiveModel {
            login_id: Set(Some(login.id)),
            datasource_group_id: Set(None),
            sender: Set(None),
            body: Set(Some("Quotes the split source".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    stage_source(&txn, datasource.id, &native_snapshot(3, Some(2)))
        .await
        .unwrap();
    record_source(&txn, datasource.id, 3, later.id)
        .await
        .unwrap();
    let response = query::load(
        &txn,
        &login.id,
        &types::MessageRepliesReq {
            signal_message_ids: vec![later.id],
            screen: types::MessageReplyScreen::Duty,
        },
    )
    .await
    .unwrap();
    assert_eq!(response.replies.len(), 2);
    assert!(response.replies.iter().all(|relation| relation
        .original_signal_message_id
        == Some(original.id)));
    let relation = crate::entities::message_reply::Entity::find()
        .filter(
            crate::entities::message_reply::Column::ReplySignalMessageId
                .eq(later.id),
        )
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(relation.engaged_message_id, Some(first));
    txn.rollback().await.unwrap();
}

// https://github.com/echoua/echo/issues/3612
#[tokio::test]
#[serial_test::serial]
async fn replies_3612_did_not_expose_other_senders_or_hidden_nested_reports() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let hidden = crate::functest::tests::mk_login(&env.dbx, Default::default())
        .await
        .unwrap();
    let source = message(&env.dbx, login.id, "Readable source").await;
    let spoofed = message(&env.dbx, login.id, "Other sender's content").await;
    let mut spoofed = spoofed.into_active_model();
    spoofed.sender = Set(Some(hidden.id.to_string()));
    let spoofed = spoofed.update(&env.dbx).await.unwrap();
    assert!(load(&env.dbx, login.id, vec![spoofed.id])
        .await
        .reply_messages
        .is_empty());
    let direct =
        message(&env.dbx, hidden.id, "Readable through its direct source")
            .await;
    let nested = message(&env.dbx, hidden.id, "Hidden nested report").await;
    for (report, parent) in [(direct.id, source.id), (nested.id, direct.id)] {
        intel_product::ActiveModel {
            intel_message_id: Set(report), source_message_id: Set(parent),
            created_at: Set(chrono::Utc::now().naive_utc()),
            relation_kind: Set(crate::entities::sea_orm_active_enums::IntelProductRelationKind::Report),
            ..Default::default()
        }.insert(&env.dbx).await.unwrap();
    }
    assert_eq!(
        load(&env.dbx, login.id, vec![direct.id])
            .await
            .reply_messages
            .len(),
        1
    );
    assert!(load(&env.dbx, login.id, vec![nested.id])
        .await
        .reply_messages
        .is_empty());
}
