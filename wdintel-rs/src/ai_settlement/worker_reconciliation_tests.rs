use super::{complete_job, enqueue_if_enabled, tests::enable_worker};
use crate::entities::{
    ai_settlement_worker_job, group_stats_recalculation_task,
    network_recalculation_task,
    sea_orm_active_enums::{NetworkRecalculationTaskKind, SettlementKind},
    settlement, sigint_inbox_item, sigint_inbox_item_network,
    sigint_inbox_item_settlement, sigint_network, sigint_network_aor,
    sigint_network_freq, sigint_network_settlement, signal_group_aor,
    signal_message, signal_message_group,
};
use crate::functest::tests::{
    cleanup_locked, find_test_login, mk_sigint_inbox_item, mk_sigint_network,
    mk_sigint_network_aor, mk_sigint_network_freq, mk_signal_message,
    mk_signal_message_group,
};
use crate::rer_importer::inbox::bl::{
    submit_upsert_inbox_item, InboxLocationSubmitMode,
};
use crate::rer_importer::types::{InboxInsertPayload, InboxMessage};
use chrono::{Duration, Utc};
use sea_orm::{
    sea_query::Expr, ActiveModelTrait, ActiveValue::Set, ColumnTrait,
    DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};

#[tokio::test]
#[serial_test::serial]
async fn manual_saves_cancel_pending_ai_replacements_2133() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let config = enable_worker(&env.dbx).await;
    let login = find_test_login(&env.dbx).await.unwrap();
    for (location_mode, location) in [
        (InboxLocationSubmitMode::PreserveTyped, Some("Робоботине")),
        (InboxLocationSubmitMode::PreserveTyped, None),
        (InboxLocationSubmitMode::Parse, Some("н.п. Вовчанськ")),
    ] {
        let message = mk_signal_message(
            &env.dbx,
            signal_message::ActiveModel {
                body: Set(Some("#2133 manual location".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item(
            &env.dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                location_v2: Set(Some("|OLD|".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        enqueue_if_enabled(&env.dbx, message.id).await.unwrap();
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        let submitted = InboxMessage::from(InboxInsertPayload {
            text: "#2133 manual location".to_string(),
            location: location.map(str::to_string),
            ..Default::default()
        });
        let transaction = env.dbx.begin().await.unwrap();
        submit_upsert_inbox_item(
            env.settlements.clone(),
            &transaction,
            message.id,
            &submitted,
            &login.id,
            &vec![login.id],
            location_mode,
            false,
            true,
        )
        .await
        .unwrap();
        transaction.commit().await.unwrap();
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert_late_results_preserve_manual_location(
            &env.dbx, message.id, &config, false,
        )
        .await;
        assert_late_results_preserve_manual_location(
            &env.dbx, message.id, &config, true,
        )
        .await;
        assert!(ai_settlement_worker_job::Entity::find_by_id(message.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }
}

async fn assert_late_results_preserve_manual_location(
    dbx: &DatabaseConnection,
    message_id: i64,
    config: &super::WorkerConfig,
    with_preexisting_job: bool,
) {
    let inbox_item = sigint_inbox_item::Entity::find_by_id(message_id)
        .one(dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(inbox_item.reviewed, Some(true));
    let links = sigint_inbox_item_settlement::Entity::find()
        .filter(sigint_inbox_item_settlement::Column::ItemId.eq(message_id))
        .order_by_asc(sigint_inbox_item_settlement::Column::Id)
        .all(dbx)
        .await
        .unwrap();
    for result in [vec![], vec!["UNRELATED AI LOCATION".to_string()]] {
        if with_preexisting_job {
            ai_settlement_worker_job::ActiveModel {
                sigint_inbox_item_id: Set(message_id),
                ..Default::default()
            }
            .insert(dbx)
            .await
            .unwrap();
        }
        assert!(!complete_job(
            dbx,
            message_id,
            "#2133 manual location",
            config,
            result,
        )
        .await
        .unwrap());
        assert_eq!(
            sigint_inbox_item::Entity::find_by_id(message_id)
                .one(dbx)
                .await
                .unwrap(),
            Some(inbox_item.clone()),
        );
        assert_eq!(
            sigint_inbox_item_settlement::Entity::find()
                .filter(
                    sigint_inbox_item_settlement::Column::ItemId.eq(message_id),
                )
                .order_by_asc(sigint_inbox_item_settlement::Column::Id)
                .all(dbx)
                .await
                .unwrap(),
            links,
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn replacement_and_removal_reconcile_networks_and_statistics_2133() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let dbx = &env.dbx;
    let config = enable_worker(dbx).await;
    let (inbox_item, networks, frequency_ids, group_master_key) =
        network_fixture(dbx).await;
    assert_networks(dbx, inbox_item.id, &networks[..1]).await;

    // Only a removed link clears its frequency's last-seen time. A kept link
    // still supplies it, so the network's last activity stays visible until
    // the queued recalculation runs (ECHO-4202).
    for (settlements, expected, removed_frequency) in [
        (
            vec!["#2133 FAR".to_string()],
            &networks[1..],
            Some(frequency_ids[0]),
        ),
        (vec![], networks.as_slice(), None),
    ] {
        sigint_network_freq::Entity::update_many()
            .col_expr(
                sigint_network_freq::Column::LastSeenDt,
                Expr::value(inbox_item.datetime),
            )
            .filter(
                sigint_network_freq::Column::Id.is_in(frequency_ids.clone()),
            )
            .exec(dbx)
            .await
            .unwrap();
        network_recalculation_task::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        group_stats_recalculation_task::Entity::delete_many()
            .exec(dbx)
            .await
            .unwrap();
        enqueue_if_enabled(dbx, inbox_item.id).await.unwrap();
        assert!(complete_job(
            dbx,
            inbox_item.id,
            "#2133 network reconciliation",
            &config,
            settlements,
        )
        .await
        .unwrap());
        assert_networks(dbx, inbox_item.id, expected).await;
        for frequency_id in &frequency_ids {
            let last_seen_dt =
                sigint_network_freq::Entity::find_by_id(*frequency_id)
                    .one(dbx)
                    .await
                    .unwrap()
                    .unwrap()
                    .last_seen_dt;
            assert_eq!(
                last_seen_dt.is_none(),
                removed_frequency == Some(*frequency_id),
                "frequency {frequency_id}"
            );
        }
        let queued_frequency_ids = network_recalculation_task::Entity::find()
            .select_only()
            .column(network_recalculation_task::Column::NetworkFreqId)
            .filter(
                network_recalculation_task::Column::TaskKind
                    .eq(NetworkRecalculationTaskKind::NetworkFreqLastSeen),
            )
            .filter(network_recalculation_task::Column::LoginId.is_null())
            .order_by_asc(network_recalculation_task::Column::NetworkFreqId)
            .into_tuple::<i64>()
            .all(dbx)
            .await
            .unwrap();
        assert_eq!(queued_frequency_ids, frequency_ids);
        assert!(group_stats_recalculation_task::Entity::find()
            .filter(
                group_stats_recalculation_task::Column::GroupMasterKey
                    .eq(&group_master_key),
            )
            .one(dbx)
            .await
            .unwrap()
            .is_some());
    }
    settlement::Entity::delete_many()
        .filter(settlement::Column::Id.is_in([2_133_301, 2_133_302]))
        .exec(dbx)
        .await
        .unwrap();
}

async fn assert_networks(
    dbx: &DatabaseConnection,
    item_id: i64,
    expected: &[i64],
) {
    let actual = sigint_inbox_item_network::Entity::find()
        .select_only()
        .column(sigint_inbox_item_network::Column::SigintNetworkId)
        .filter(
            sigint_inbox_item_network::Column::SigintInboxItemId.eq(item_id),
        )
        .order_by_asc(sigint_inbox_item_network::Column::SigintNetworkId)
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .unwrap();
    assert_eq!(actual, expected);
}

async fn network_fixture(
    dbx: &DatabaseConnection,
) -> (sigint_inbox_item::Model, Vec<i64>, Vec<i64>, String) {
    let group_aor = signal_group_aor::Entity::find()
        .one(dbx)
        .await
        .unwrap()
        .unwrap();
    let now = Utc::now().naive_utc();
    let mut networks = Vec::new();
    let mut frequency_ids = Vec::new();
    for (settlement_id, name, lon) in [
        (2_133_301, "#2133 NEAR", 1.0),
        (2_133_302, "#2133 FAR", 9.0),
    ] {
        let (network_id, frequency_id) = insert_anchored_network(
            dbx,
            group_aor.aor_id,
            settlement_id,
            name,
            lon,
        )
        .await;
        networks.push(network_id);
        frequency_ids.push(frequency_id);
    }
    let message = mk_signal_message(
        dbx,
        signal_message::ActiveModel {
            body: Set(Some("#2133 network reconciliation".to_string())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let inbox_item = mk_sigint_inbox_item(
        dbx,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            freq: Set(Some("146.4500".to_string())),
            datetime: Set(Some(now)),
            location_v2: Set(Some("|#2133 NEAR|".to_string())),
            parsed_unit_v2: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_message_group(
        dbx,
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group_aor.master_key.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    crate::sigint::network::etalon_calc::calculate_sigint_inbox_item_networks(
        vec![inbox_item.clone()],
        dbx,
    )
    .await
    .unwrap();
    (inbox_item, networks, frequency_ids, group_aor.master_key)
}

async fn insert_anchored_network(
    dbx: &DatabaseConnection,
    aor_id: i64,
    settlement_id: i32,
    name: &str,
    lon: f64,
) -> (i64, i64) {
    settlement::Entity::delete_by_id(settlement_id)
        .exec(dbx)
        .await
        .unwrap();
    settlement::ActiveModel {
        id: Set(settlement_id),
        name: Set(name.to_string()),
        kind: Set(SettlementKind::Village),
        lat: Set(Some(0.0)),
        lon: Set(Some(lon)),
        ..Default::default()
    }
    .insert(dbx)
    .await
    .unwrap();
    let network = mk_sigint_network(
        dbx,
        sigint_network::ActiveModel {
            location: Set(format!("|{name}|")),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let frequency = mk_sigint_network_freq(
        dbx,
        sigint_network_freq::ActiveModel {
            network_id: Set(network.id),
            freq: Set("146.4500".to_string()),
            active_from: Set(Utc::now().naive_utc() - Duration::days(1)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_network_aor(
        dbx,
        sigint_network_aor::ActiveModel {
            network_id: Set(network.id),
            aor_id: Set(aor_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sigint_network_settlement::Entity::update_many()
        .col_expr(
            sigint_network_settlement::Column::SettlementId,
            Expr::value(Some(settlement_id)),
        )
        .col_expr(
            sigint_network_settlement::Column::IsUndefined,
            Expr::value(Some(false)),
        )
        .filter(sigint_network_settlement::Column::NetworkId.eq(network.id))
        .exec(dbx)
        .await
        .unwrap();
    (network.id, frequency.id)
}
