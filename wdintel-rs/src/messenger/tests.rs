use super::*;
use crate::entities::*;
use crate::functest::tests::*;
use crate::messenger::bl::bl_group_update;
use crate::messenger::types::GroupUpdateReq;
use serial_test::serial;

/// Test updating a group with AORs - when we add a second AOR to a group that already has one
#[serial]
#[tokio::test]
async fn test_bl_group_update_add_second_aor() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();

    let group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let aor1 = mk_aor(
        &txn,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let aor2 = mk_aor(
        &txn,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let req1 = GroupUpdateReq {
        master_key: group.master_key.clone(),
        short_note: Some("Test group".to_string()),
        long_note: None,
        area_of_responsibility_id: None,
        area_of_responsibility_ids: Some(vec![aor1.id]),
        is_rer: None,
        fills_etalonka: None,
        disable_network_assignment: None,
    };

    let res1 = bl_group_update(&req1, &txn).await.unwrap();

    assert_eq!(res1.aors.len(), 1);
    assert_eq!(res1.aors[0].id, aor1.id);

    let group_aors_after_first = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group.master_key.clone()),
        )
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(group_aors_after_first.len(), 1);
    assert_eq!(group_aors_after_first[0].aor_id, aor1.id);

    let req2 = GroupUpdateReq {
        master_key: group.master_key.clone(),
        short_note: Some("Test group updated".to_string()),
        long_note: Some("Added second AOR".to_string()),
        area_of_responsibility_id: None,
        area_of_responsibility_ids: Some(vec![aor1.id, aor2.id]),
        is_rer: None,
        fills_etalonka: None,
        disable_network_assignment: None,
    };

    let res2 = bl_group_update(&req2, &txn).await.unwrap();

    assert_eq!(res2.aors.len(), 2);
    let aor_ids: Vec<i64> = res2.aors.iter().map(|aor| aor.id).collect();
    assert!(aor_ids.contains(&aor1.id));
    assert!(aor_ids.contains(&aor2.id));

    let group_aors_after_second = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group.master_key.clone()),
        )
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(group_aors_after_second.len(), 2);

    let db_aor_ids: Vec<i64> =
        group_aors_after_second.iter().map(|ga| ga.aor_id).collect();
    assert!(db_aor_ids.contains(&aor1.id));
    assert!(db_aor_ids.contains(&aor2.id));

    assert_eq!(
        res2.group_data.short_note,
        Some("Test group updated".to_string())
    );
    assert_eq!(
        res2.group_data.long_note,
        Some("Added second AOR".to_string())
    );

    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn test_bl_group_update_fills_etalonka_invalidates_all_history() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let group_created_at = chrono::NaiveDate::from_ymd_opt(2026, 1, 10)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let item_datetime = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();

    let group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            created_at: Set(group_created_at),
            fills_etalonka: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let msg = mk_signal_message(
        &txn,
        signal_message::ActiveModel {
            created_at: Set(group_created_at),
            timestamp: Set(Some(item_datetime)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_message_group(
        &txn,
        signal_message_group::ActiveModel {
            signal_message_id: Set(msg.id),
            group_master_key: Set(Some(group.master_key.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let inbox_item = mk_sigint_inbox_item(
        &txn,
        sigint_inbox_item::ActiveModel {
            id: Set(msg.id),
            date: Set(Some(item_datetime.date().to_string())),
            time: Set(Some(
                item_datetime.time().format("%H:%M:%S").to_string(),
            )),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let expected_since_ts = inbox_item.datetime.unwrap();
    assert!(expected_since_ts < group_created_at);

    let req = GroupUpdateReq {
        master_key: group.master_key.clone(),
        short_note: None,
        long_note: None,
        area_of_responsibility_id: None,
        area_of_responsibility_ids: Some(vec![]),
        is_rer: None,
        fills_etalonka: Some(false),
        disable_network_assignment: None,
    };
    let res = bl_group_update(&req, &txn).await.unwrap();

    assert!(res.network_invalidation_enqueued);
    let task = network_invalidation_task::Entity::find()
        .filter(
            network_invalidation_task::Column::GroupMasterKey
                .eq(group.master_key.clone()),
        )
        .order_by_desc(network_invalidation_task::Column::Id)
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.since_ts, expected_since_ts);

    txn.rollback().await.unwrap();
}
