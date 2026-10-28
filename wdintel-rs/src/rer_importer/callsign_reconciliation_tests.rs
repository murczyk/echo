// Regressions: https://github.com/echoua/echo/issues/3888
use super::*;
use crate::functest::tests::*;
use crate::inbox::callsigns::{sync, InboxItemCallsigns};

async fn seed_aviation_item(
    db: &DatabaseConnection,
) -> (sigint_inbox_item::Model, signal_message::Model) {
    let group = mk_signal_group(
        db,
        signal_group::ActiveModel {
            is_aviation_group: Set(Some(true)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            body: Set(Some("19.10.2026, 10:05:32\n134.3750\n🔴\n43, 41,\nНВ\n\n— Второй, ручной, прием.".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_message_group(
        db,
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group.master_key)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let item = mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            reviewed: Set(None),
            datetime: Set(Some(Utc::now().naive_utc())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    (item, message)
}

async fn recompute(
    env: &Env,
    item: &sigint_inbox_item::Model,
    message: &signal_message::Model,
) -> RecomputedInboxCallsigns {
    let existing = load_existing_callsigns(&env.dbx, [item.id])
        .await
        .unwrap()
        .remove(&item.id)
        .unwrap_or_default();
    recompute_inbox_item_callsigns(
        &env.ai_engine_client,
        &env.dbx,
        &env.rq,
        item,
        Some(message),
        existing,
        None,
    )
    .await
    .unwrap()
    .unwrap()
}

async fn seed_previous_callsigns_and_feedback(
    env: &Env,
    item: &sigint_inbox_item::Model,
    message: &signal_message::Model,
) -> i64 {
    let system_id = crate::users::system_login_id(&env.dbx).await.unwrap();
    let actor = mk_login(&env.dbx, Default::default()).await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    sync(
        &txn,
        item.id,
        item.id_uuid,
        InboxItemCallsigns {
            primary: vec!["старый".into()],
            alg2: vec!["второй".into()],
        },
        system_id,
    )
    .await
    .unwrap();
    crate::ai_callsign::feedback::record_edit(
        &txn,
        actor.id,
        &crate::ai_callsign::feedback::CallsignEdit {
            message_id: item.id,
            action_id: uuid::Uuid::new_v4().to_string(),
            added: vec!["ручной".into()],
            removed: vec!["41".into()],
        },
        &[item.id],
        message.body.as_deref().unwrap(),
    )
    .await
    .unwrap();
    let stale_network = mk_sigint_inbox_item_network(
        &txn,
        sigint_inbox_item_network::ActiveModel {
            sigint_inbox_item_id: Set(item.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();

    stale_network.id
}

async fn stored_callsign_rows(
    db: &DatabaseConnection,
    item_id: i64,
) -> Vec<sigint_inbox_item_callsign::Model> {
    sigint_inbox_item_callsign::Entity::find()
        .filter(
            sigint_inbox_item_callsign::Column::SigintInboxItemId.eq(item_id),
        )
        .order_by_asc(sigint_inbox_item_callsign::Column::Id)
        .all(db)
        .await
        .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn reconciliation_preserves_feedback_secondary_highlights_and_reruns() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (item, message) = seed_aviation_item(&env.dbx).await;
    let system_id = crate::users::system_login_id(&env.dbx).await.unwrap();
    let stale_network_id =
        seed_previous_callsigns_and_feedback(&env, &item, &message).await;

    let recomputed = recompute(&env, &item, &message).await;
    assert_eq!(recomputed.after, vec!["43", "ручной"]);
    let tokens: Vec<CNCallsign> =
        serde_json::from_value(recomputed.callsign_tokens.clone()).unwrap();
    assert_eq!(tokens.len(), 3);
    assert!(tokens.iter().any(|callsign| callsign.etalon == "второй"));
    let txn = env.dbx.begin().await.unwrap();
    persist_recomputed_inbox_item_callsigns(
        &txn,
        item.clone(),
        &recomputed,
        system_id,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let persisted = load_existing_callsigns(&env.dbx, [item.id]).await.unwrap();
    assert_eq!(persisted[&item.id].primary, recomputed.after);
    assert_eq!(persisted[&item.id].alg2, vec!["второй"]);
    assert!(
        sigint_inbox_item_network::Entity::find_by_id(stale_network_id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::Reason
                    .eq(format!("callsign reprocessing {}", item.id))
            )
            .count(&env.dbx)
            .await
            .unwrap()
            > 0
    );
    let before = stored_callsign_rows(&env.dbx, item.id).await;
    let recomputed = recompute(&env, &item, &message).await;
    let txn = env.dbx.begin().await.unwrap();
    persist_recomputed_inbox_item_callsigns(
        &txn,
        item.clone(),
        &recomputed,
        system_id,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let after = stored_callsign_rows(&env.dbx, item.id).await;
    assert_eq!(before, after);
    let item = SigintInboxItem::find_by_id(item.id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.callsign_tokens, Some(recomputed.callsign_tokens));
}

async fn apply_concurrent_change(
    env: &Env,
    item: &sigint_inbox_item::Model,
    message: &signal_message::Model,
    system_id: uuid::Uuid,
    change: &str,
) {
    let txn = env.dbx.begin().await.unwrap();
    match change {
        "review" => {
            let mut current = item.clone().into_active_model();
            current.reviewed = Set(Some(true));
            current.update(&txn).await.unwrap();
        }
        "primary" | "alg2" => {
            let current = InboxItemCallsigns {
                primary: if change == "primary" {
                    vec!["новый".into()]
                } else {
                    vec![]
                },
                alg2: if change == "alg2" {
                    vec!["второй".into()]
                } else {
                    vec![]
                },
            };
            sync(&txn, item.id, item.id_uuid, current, system_id)
                .await
                .unwrap();
        }
        "body" | "delete" => {
            let mut message = message.clone().into_active_model();
            if change == "body" {
                message.body = Set(Some("changed".into()));
            } else {
                message.deleted = Set(true);
            }
            message.update(&txn).await.unwrap();
        }
        "feedback" => {
            let actor = mk_login(&txn, Default::default()).await.unwrap();
            crate::ai_callsign::feedback::record_edit(
                &txn,
                actor.id,
                &crate::ai_callsign::feedback::CallsignEdit {
                    message_id: item.id,
                    action_id: uuid::Uuid::new_v4().to_string(),
                    added: vec![],
                    removed: vec!["43".into()],
                },
                &[item.id],
                message.body.as_deref().unwrap(),
            )
            .await
            .unwrap();
        }
        _ => unreachable!(),
    }
    txn.commit().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn reconciliation_rejects_stale_review_body_feedback_and_callsigns() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let system_id = crate::users::system_login_id(&env.dbx).await.unwrap();
    for change in ["review", "primary", "alg2", "body", "delete", "feedback"] {
        let (item, message) = seed_aviation_item(&env.dbx).await;
        let recomputed = recompute(&env, &item, &message).await;
        apply_concurrent_change(&env, &item, &message, system_id, change).await;
        let txn = env.dbx.begin().await.unwrap();
        assert!(
            persist_recomputed_inbox_item_callsigns(
                &txn,
                item.clone(),
                &recomputed,
                system_id
            )
            .await
            .is_err(),
            "{change}"
        );
        txn.rollback().await.unwrap();
        let current = SigintInboxItem::find_by_id(item.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.callsign_tokens, item.callsign_tokens, "{change}");
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reconciliation_selection_respects_review_deletion_and_time_bounds() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let start = Utc::now().naive_utc();
    let end = start + chrono::Duration::hours(1);
    let mut expected = vec![];
    for (reviewed, deleted, timestamp, included) in [
        (None, false, start, true),
        (Some(false), false, start, true),
        (Some(true), false, start, false),
        (Some(false), true, start, false),
        (
            Some(false),
            false,
            start - chrono::Duration::seconds(1),
            false,
        ),
        (Some(false), false, end, false),
    ] {
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                deleted: Set(deleted),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let item = mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                datetime: Set(Some(timestamp)),
                reviewed: Set(reviewed),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if included {
            expected.push(item.id);
        }
    }
    let mut actual = load_unreviewed_inbox_items(&env.dbx, start, end)
        .await
        .unwrap()
        .into_iter()
        .map(|(item, _)| item.id)
        .collect::<Vec<_>>();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected);
    assert!(parse_reprocess_period(
        "2026-10-19T00:00:00",
        "2026-10-19T00:00:00"
    )
    .is_err());
    assert!(parse_reprocess_period(
        "2026-10-20T00:00:00",
        "2026-10-19T00:00:00"
    )
    .is_err());
}
