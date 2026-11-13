use super::*;
use crate::functest::tests::*;
use serial_test::serial;

async fn commented_message(
    db: &DatabaseConnection,
    login_id: uuid::Uuid,
    comment: &str,
    deleted: bool,
) -> i64 {
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            deleted: Set(deleted),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            signal_message_id: Set(message.id),
            login_id: Set(login_id),
            comment: Set(comment.to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    message.id
}

async fn exists(db: &DatabaseConnection, id: i64) -> bool {
    signal_message::Entity::find_by_id(id)
        .one(db)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
#[serial]
async fn issue_4110_purges_the_copies_the_previous_replay_left_behind() {
    let env = cleanup().await.unwrap();
    let db = &env.dbx;
    let system = crate::users::system_login_id(db).await.unwrap();
    let user = find_test_login(db).await.unwrap().id;
    // Its cleanup soft-deleted most copies; one may still be live.
    let soft_deleted =
        commented_message(db, system, MESSAGE_REPLAY_LEGACY_MARKER, true).await;
    let live =
        commented_message(db, system, MESSAGE_REPLAY_LEGACY_MARKER, false)
            .await;
    // The same text from a person, and another system comment, mark nothing.
    let by_user =
        commented_message(db, user, MESSAGE_REPLAY_LEGACY_MARKER, false).await;
    let other = commented_message(db, system, "Примітка системи", false).await;
    let mut purged = vec![];
    loop {
        let txn = db.begin().await.unwrap();
        let batch = purge_legacy_batch(&txn).await.unwrap();
        txn.commit().await.unwrap();
        if batch.is_empty() {
            break;
        }
        purged.extend(batch);
    }
    assert!(purged.contains(&soft_deleted) && purged.contains(&live));
    assert!(!purged.contains(&by_user) && !purged.contains(&other));
    for id in [soft_deleted, live] {
        assert!(!exists(db, id).await);
        assert!(sigint_inbox_item::Entity::find_by_id(id)
            .one(db)
            .await
            .unwrap()
            .is_none());
    }
    assert!(exists(db, by_user).await && exists(db, other).await);
}
