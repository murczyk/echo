use super::*;
use crate::entities::{
    datasource_group, login, sigint_inbox_item_network, signal_message_group,
};
use crate::functest::tests::*;
use crate::rer_importer::types::InboxMessagesSortBy;
use chrono::NaiveDate;
use serial_test::serial;
use std::io::Read;

async fn seed_message(
    dbx: &DatabaseConnection,
    group: &datasource_group::Model,
    timestamp: NaiveDateTime,
    body: &str,
    network_ids: &[i64],
) -> i64 {
    let message = mk_signal_message(
        dbx,
        signal_message::ActiveModel {
            body: Set(Some(format!("RAW HEADER\n{body}"))),
            timestamp: Set(Some(timestamp)),
            datasource_group_id: Set(Some(group.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_signal_message_group(
        dbx,
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group.group_master_key.clone())),
            datasource_group_id: Set(Some(group.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item(
        dbx,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            reviewed: Set(Some(true)),
            body_noheader: Set(Some(serde_json::json!({"body": body}))),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    for network_id in network_ids {
        mk_sigint_inbox_item_network(
            dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(*network_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    message.id
}

#[tokio::test]
#[serial]
async fn echo_3827_report_respects_networks_filters_and_organism_comments() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = find_test_login(&env.dbx).await.unwrap();
    let peer = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(login.organism_id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let foreign_organism =
        mk_organism(&env.dbx, Default::default()).await.unwrap();
    let foreign_login = mk_login(
        &env.dbx,
        login::ActiveModel {
            organism_id: Set(Some(foreign_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_ne!(foreign_login.organism_id, login.organism_id);
    let group = find_test_datasource_group(&env.dbx).await.unwrap();
    let first_network = mk_sigint_network(
        &env.dbx,
        sigint_network::ActiveModel {
            name: Set("Network A".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let second_network = mk_sigint_network(
        &env.dbx,
        sigint_network::ActiveModel {
            name: Set("Network B".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let timestamp = NaiveDate::from_ymd_opt(2026, 10, 18)
        .unwrap()
        .and_hms_opt(7, 6, 16)
        .unwrap();
    let networks = [first_network.id, second_network.id];
    let message_id = seed_message(
        &env.dbx,
        &group,
        timestamp,
        "Intercept first\nSecond line",
        &networks,
    )
    .await;
    let uncommented_id = seed_message(
        &env.dbx,
        &group,
        timestamp + chrono::Duration::minutes(1),
        "Uncommented interception",
        &networks[..1],
    )
    .await;
    seed_message(&env.dbx, &group, timestamp, "Undefined network", &[]).await;
    seed_message(
        &env.dbx,
        &group,
        timestamp - chrono::Duration::days(2),
        "Outside period",
        &networks,
    )
    .await;
    let other_group = mk_datasource_group(&env.dbx, Default::default())
        .await
        .unwrap();
    seed_message(
        &env.dbx,
        &other_group,
        timestamp,
        "Outside group",
        &networks,
    )
    .await;
    for (author, signal_message_id, comment) in [
        (login.id, message_id, "Own comment"),
        (peer.id, message_id, "Peer comment"),
        (foreign_login.id, message_id, "Foreign comment"),
        (foreign_login.id, uncommented_id, "Foreign-only comment"),
    ] {
        mk_sigint_comment(
            &env.dbx,
            sigint_comment::ActiveModel {
                login_id: Set(author),
                signal_message_id: Set(signal_message_id),
                comment: Set(comment.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let request = InboxMessagesReq {
        since_date_inclusive_ms: Some(timestamp.and_utc().timestamp_millis()),
        till_date_inclusive_ms: Some(
            (timestamp + chrono::Duration::hours(1))
                .and_utc()
                .timestamp_millis(),
        ),
        sort_by: Some(InboxMessagesSortBy::IMSTimestamp),
        selected_groups: Some(vec![group.group_master_key.clone()]),
        nolimit: Some(true),
        ..Default::default()
    };
    let messages = load_report_messages(&env.dbx, &login.id, &env, &request)
        .await
        .unwrap();
    let networks = collect_networks(&env.dbx, &login.id, messages)
        .await
        .unwrap();
    assert_eq!(networks.len(), 2);
    assert_eq!(networks[0].name, "Network A");
    assert_eq!(networks[0].interceptions.len(), 2);
    assert_eq!(networks[1].name, "Network B");
    assert_eq!(networks[1].interceptions.len(), 1);
    assert_eq!(
        networks[0].interceptions[0].comment,
        "Own comment\nPeer comment"
    );
    assert!(networks[0].interceptions[1].comment.is_empty());
    let mut bytes = std::io::Cursor::new(Vec::new());
    build_docx(&networks, &request)
        .unwrap()
        .build()
        .pack(&mut bytes)
        .unwrap();
    let mut archive = zip::ZipArchive::new(bytes).unwrap();
    let mut document = String::new();
    archive
        .by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut document)
        .unwrap();
    assert!(document.contains("18.10.2026 10:06"));
    assert!(document.contains("Intercept first"));
    assert!(document.contains("Uncommented interception"));
    for excluded in [
        "Foreign comment",
        "Foreign-only comment",
        "Undefined network",
        "Outside period",
        "Outside group",
        "RAW HEADER",
        "EXO ID",
    ] {
        assert!(!document.contains(excluded), "{excluded}");
    }
}
