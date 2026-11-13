use super::*;
use crate::functest::tests::*;
use chrono::{Duration, Utc};
use serial_test::serial;

struct Fixture<'a> {
    login_id: uuid::Uuid,
    comment: &'a str,
    deleted: bool,
    body: &'a str,
    /// When the comment was written; the old replay wrote before this replay
    /// was installed.
    days_ago: i64,
}

async fn commented_message(
    db: &DatabaseConnection,
    fixture: Fixture<'_>,
) -> i64 {
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            deleted: Set(fixture.deleted),
            body: Set(Some(fixture.body.to_string())),
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
            login_id: Set(fixture.login_id),
            comment: Set(fixture.comment.to_string()),
            created_at: Set(
                Utc::now().naive_utc() - Duration::days(fixture.days_ago)
            ),
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
async fn issue_4110_purges_only_the_copies_the_previous_replay_left_behind() {
    let env = cleanup().await.unwrap();
    let db = &env.dbx;
    let system = crate::users::system_login_id(db).await.unwrap();
    let user = find_test_login(db).await.unwrap().id;
    let copy = |deleted, body, days_ago| Fixture {
        login_id: system,
        comment: MESSAGE_REPLAY_LEGACY_MARKER,
        deleted,
        body,
        days_ago,
    };
    // A copy the old cleanup hid: the one thing to purge.
    let hidden =
        commented_message(db, copy(true, "Позивний Береза", 400)).await;
    // Still visible, so never touched.
    let live = commented_message(db, copy(false, "Позивний Береза", 400)).await;
    // Comment parsing gave this real message the marker from its own text.
    let parsed = commented_message(
        db,
        copy(true, "Позивний Береза. Comment: [DUPLICATE]", 400),
    )
    .await;
    // Written after this replay was installed, so not the old replay's.
    let recent = commented_message(db, copy(true, "Позивний Береза", 0)).await;
    // A comment migrated into a message of its own would be orphaned.
    let migrated =
        commented_message(db, copy(true, "Позивний Береза", 400)).await;
    let comment_message =
        mk_signal_message(db, Default::default()).await.unwrap();
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            signal_message_id: Set(migrated),
            login_id: Set(user),
            comment: Set("Перевірено".into()),
            migrated_signal_message_id: Set(Some(comment_message.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // The same text from a person, and another system comment.
    let by_user = commented_message(
        db,
        Fixture {
            login_id: user,
            ..copy(true, "Позивний Береза", 400)
        },
    )
    .await;
    let other = commented_message(
        db,
        Fixture {
            comment: "Примітка системи",
            ..copy(true, "Позивний Береза", 400)
        },
    )
    .await;
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
    assert!(purged.contains(&hidden));
    assert!(!exists(db, hidden).await);
    assert!(sigint_inbox_item::Entity::find_by_id(hidden)
        .one(db)
        .await
        .unwrap()
        .is_none());
    for kept in [live, parsed, recent, migrated, by_user, other] {
        assert!(!purged.contains(&kept), "{kept} was purged");
        assert!(exists(db, kept).await);
    }
    assert!(exists(db, comment_message.id).await);
}
