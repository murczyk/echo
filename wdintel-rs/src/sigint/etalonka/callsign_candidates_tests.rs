use super::query::{
    load_callsigns, load_callsigns_from_activity_info, CallsignActivityInfo,
};
use super::types::{CallsignRes, NetworkFreqFilter};
use crate::entities::*;
use crate::functest::tests::*;
use crate::inbox::callsigns::{sync, InboxItemCallsigns};
use crate::rer_importer::report_chunking::ReportPeriodEnd;
use crate::sigint::callsign::bl_network_callsign::{
    bl_add_as_known_network_callsigns, bl_delete_network_callsign,
};
use crate::sigint::network::types::SingleNetworkCallsignsSection;
use chrono::{Duration, NaiveDateTime, Utc};
use sea_orm::*;
use serial_test::serial;
use std::collections::HashMap;

struct CallsignCandidatesFixture {
    network_id: i64,
    login_id: uuid::Uuid,
    current_catalog_id: i64,
    old_network_callsign_id: i64,
    old_catalog_id: i64,
    groups: Vec<String>,
    activity: HashMap<String, CallsignActivityInfo>,
    filter: NetworkFreqFilter,
}

impl CallsignCandidatesFixture {
    async fn new(db: &DatabaseConnection, old_callsign: &str) -> Self {
        let now = Utc::now().naive_utc();
        let login = find_test_login(db).await.unwrap();
        let unit = mk_sigint_unit(db, Default::default()).await.unwrap();
        let network = mk_sigint_network(db, Default::default()).await.unwrap();
        mk_sigint_network_unit(
            db,
            sigint_network_unit::ActiveModel {
                network_id: Set(network.id),
                unit_id: Set(unit.id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let old_catalog =
            catalog_callsign(db, unit.id, old_callsign, "ПНА").await;
        let current_catalog =
            catalog_callsign(db, unit.id, "филин", "Ка-52").await;
        let old_network_callsign = sigint_network_callsign::ActiveModel {
            sigint_network_id: Set(network.id),
            sigint_callsign: Set("филин".to_string()),
            sigint_callsign_id: Set(Some(old_catalog.id)),
            created_at: Set(now - Duration::hours(2)),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
        let group = mk_datasource_group(db, Default::default()).await.unwrap();
        let activity_at = now - Duration::hours(1);
        seed_callsign_message(db, network.id, group.id, login.id, activity_at)
            .await;
        Self {
            network_id: network.id,
            login_id: login.id,
            current_catalog_id: current_catalog.id,
            old_network_callsign_id: old_network_callsign.id,
            old_catalog_id: old_catalog.id,
            groups: vec![group.group_master_key],
            activity: HashMap::from([(
                "филин".to_string(),
                CallsignActivityInfo {
                    message_count: 1,
                    last_datetime: Some(
                        activity_at.and_utc().timestamp_millis(),
                    ),
                    freqs: Some(vec!["122.5500".to_string()]),
                    network_names: None,
                },
            )]),
            filter: NetworkFreqFilter {
                active_freqs_only: false,
                since_date_inclusive_ms: Some(
                    (now - Duration::days(21)).and_utc().timestamp_millis(),
                ),
                till_date_inclusive_ms: Some(now.and_utc().timestamp_millis()),
                till_date_end: ReportPeriodEnd::Inclusive,
            },
        }
    }

    async fn assert_candidates(
        &self,
        db: &DatabaseConnection,
        expected: &[i64],
    ) {
        for section in [None, Some(SingleNetworkCallsignsSection::Catalog)] {
            let candidates = load_callsigns_from_activity_info(
                db,
                self.network_id,
                None,
                true,
                section.clone(),
                &self.activity,
            )
            .await
            .unwrap();
            assert_catalog_candidates(&candidates, expected);
            for filter in [None, Some(&self.filter)] {
                let candidates = load_callsigns(
                    db,
                    &self.groups,
                    self.network_id,
                    None,
                    true,
                    section.clone(),
                    filter,
                    true,
                )
                .await
                .unwrap();
                assert_catalog_candidates(&candidates, expected);
            }
        }
    }
}

async fn catalog_callsign(
    db: &DatabaseConnection,
    unit_id: i64,
    callsign: &str,
    position: &str,
) -> sigint_callsign::Model {
    sigint_callsign::ActiveModel {
        callsign: Set(callsign.to_string()),
        position: Set(position.to_string()),
        comment: Set(String::new()),
        unit_id: Set(unit_id),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap()
}

async fn seed_callsign_message(
    db: &DatabaseConnection,
    network_id: i64,
    group_id: i64,
    login_id: uuid::Uuid,
    activity_at: NaiveDateTime,
) {
    mk_sigint_network_freq(
        db,
        sigint_network_freq::ActiveModel {
            network_id: Set(network_id),
            freq: Set("122.5500".to_string()),
            active_from: Set(activity_at - Duration::hours(1)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            datasource_group_id: Set(Some(group_id)),
            timestamp: Set(Some(activity_at)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let inbox_item = mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            freq: Set(Some("122.5500".to_string())),
            datetime: Set(Some(activity_at)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_sigint_inbox_item_network(
        db,
        sigint_inbox_item_network::ActiveModel {
            sigint_network_id: Set(network_id),
            sigint_inbox_item_id: Set(message.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sync(
        db,
        inbox_item.id,
        inbox_item.id_uuid,
        InboxItemCallsigns {
            primary: vec!["филин".to_string()],
            ..Default::default()
        },
        login_id,
    )
    .await
    .unwrap();
}

fn assert_catalog_candidates(candidates: &[CallsignRes], expected: &[i64]) {
    let ids = candidates
        .iter()
        .flat_map(|callsign| callsign.known_callsigns.iter().flatten())
        .map(|callsign| {
            assert_eq!(callsign.callsign, "филин");
            assert_eq!(callsign.position, "Ка-52");
            callsign.id
        })
        .collect::<Vec<_>>();
    assert_eq!(ids, expected);
    assert_eq!(candidates.len(), usize::from(!expected.is_empty()));
    for candidate in candidates {
        assert_eq!(candidate.message_count, 1);
    }
}

#[tokio::test]
#[serial]
async fn same_callsign_affiliations_remain_selectable_3900() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = CallsignCandidatesFixture::new(&env.dbx, "филин").await;
    fixture
        .assert_candidates(&env.dbx, &[fixture.current_catalog_id])
        .await;

    let txn = env.dbx.begin().await.unwrap();
    let added = bl_add_as_known_network_callsigns(
        fixture.network_id,
        vec![fixture.current_catalog_id],
        &fixture.login_id,
        &txn,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    fixture.assert_candidates(&env.dbx, &[]).await;

    let added = sigint_network_callsign::Entity::find_by_id(added[0])
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(added.sigint_callsign_id, Some(fixture.current_catalog_id));
    let old = sigint_network_callsign::Entity::find_by_id(
        fixture.old_network_callsign_id,
    )
    .one(&env.dbx)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(old.sigint_callsign_id, Some(fixture.old_catalog_id));
    assert!(!old.deleted);
}

#[tokio::test]
#[serial]
async fn deleted_callsign_affiliation_keeps_catalog_candidate_3900() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = CallsignCandidatesFixture::new(&env.dbx, "карта").await;
    fixture
        .assert_candidates(&env.dbx, &[fixture.current_catalog_id])
        .await;
    let txn = env.dbx.begin().await.unwrap();
    bl_delete_network_callsign(
        fixture.old_network_callsign_id,
        &fixture.login_id,
        &txn,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    fixture
        .assert_candidates(&env.dbx, &[fixture.current_catalog_id])
        .await;
}
