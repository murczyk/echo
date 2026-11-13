use super::*;
use crate::entities::sea_orm_active_enums::IntelProductRelationKind;
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
    /// The old replay stamped the comment and the message's `timestamp` with
    /// one clock reading.
    stamped: bool,
}

async fn commented_message(
    db: &DatabaseConnection,
    fixture: Fixture<'_>,
) -> i64 {
    let written = Utc::now().naive_utc() - Duration::days(fixture.days_ago);
    let timestamp = if fixture.stamped {
        written
    } else {
        written - Duration::seconds(13)
    };
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            timestamp: Set(Some(timestamp)),
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
            created_at: Set(written),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    message.id
}

/// A hidden copy linked through `intel_product` as a source; returns the
/// copy and the linked message.
async fn linked_copy(
    db: &DatabaseConnection,
    system: uuid::Uuid,
    kind: IntelProductRelationKind,
) -> (i64, i64) {
    let copy_id = commented_message(
        db,
        Fixture {
            login_id: system,
            comment: MESSAGE_REPLAY_LEGACY_MARKER,
            deleted: true,
            body: "Позивний Береза",
            days_ago: 400,
            stamped: true,
        },
    )
    .await;
    let intel = mk_signal_message(db, Default::default()).await.unwrap();
    intel_product::ActiveModel {
        intel_message_id: Set(intel.id),
        source_message_id: Set(copy_id),
        relation_kind: Set(kind),
        created_at: Set(Utc::now().naive_utc()),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    (copy_id, intel.id)
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
        stamped: true,
    };
    // A copy the old cleanup hid: the one thing to purge.
    let hidden =
        commented_message(db, copy(true, "Позивний Береза", 400)).await;
    // Still visible, so never touched.
    let live = commented_message(db, copy(false, "Позивний Береза", 400)).await;
    // Comment parsing gave these real messages the marker from their text,
    // and one was edited afterwards: the comment has its own insert time.
    let parsed = commented_message(
        db,
        Fixture {
            stamped: false,
            ..copy(true, "Позивний Береза. Comment: [duplicate]", 400)
        },
    )
    .await;
    let edited = commented_message(
        db,
        Fixture {
            stamped: false,
            ..copy(true, "Позивний Береза", 400)
        },
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
    // A comment linked as a message of its own, and a report citing a copy.
    let (commented, linked_comment) =
        linked_copy(db, system, IntelProductRelationKind::Comment).await;
    let (cited, report) =
        linked_copy(db, system, IntelProductRelationKind::Report).await;
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
    for kept in [
        live, parsed, edited, recent, migrated, commented, cited, by_user,
        other,
    ] {
        assert!(!purged.contains(&kept), "{kept} was purged");
        assert!(exists(db, kept).await);
    }
    for linked in [comment_message.id, linked_comment, report] {
        assert!(exists(db, linked).await);
    }
}

#[tokio::test]
#[serial]
async fn issue_4110_legacy_purge_waits_for_the_comment_migration() {
    let env = cleanup().await.unwrap();
    let db = &env.dbx;
    let system = crate::users::system_login_id(db).await.unwrap();
    let hidden = commented_message(
        db,
        Fixture {
            login_id: system,
            comment: MESSAGE_REPLAY_LEGACY_MARKER,
            deleted: true,
            body: "Позивний Береза",
            days_ago: 400,
            stamped: true,
        },
    )
    .await;
    // A comment migration batch is running: it could give the copy a
    // migrated comment between the purge's lookup and its deletes.
    let migration = db.begin().await.unwrap();
    migration
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_xact_lock($1)",
            [
                crate::sigint::comments::SIGINT_COMMENT_MIGRATION_LOCK_KEY
                    .into(),
            ],
        ))
        .await
        .unwrap();
    let mut purge = std::pin::pin!(async {
        let txn = db.begin().await.unwrap();
        let batch = purge_legacy_batch(&txn).await.unwrap();
        txn.commit().await.unwrap();
        batch
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(500), &mut purge)
            .await
            .is_err(),
        "the purge ran during the comment migration"
    );
    migration.commit().await.unwrap();
    let purged =
        tokio::time::timeout(std::time::Duration::from_secs(30), purge)
            .await
            .expect("the purge went on after the comment migration");
    assert_eq!(purged, vec![hidden]);
    assert!(!exists(db, hidden).await);
}
