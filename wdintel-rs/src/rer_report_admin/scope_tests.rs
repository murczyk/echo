use super::*;
use crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind;
use crate::entities::{
    sigint_inbox_item, sigint_inbox_item_unit, signal_message,
    signal_message_group,
};
use crate::functest::tests::*;
use crate::rer_report_admin::{create_metadata, CreateRerReportMetadataReq};
use sea_orm::{ActiveModelTrait, IntoActiveModel, QuerySelect, Set};
use serial_test::serial;

#[tokio::test]
#[serial]
async fn issue_3940_scope_inherits_full_hierarchy_and_keeps_snapshot() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let root = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            army_region: Set("Захід".into()),
            army: Set("1 А".into()),
            corps: Set("1 АК".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let peer = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            army_region: Set(root.army_region.clone()),
            army: Set(root.army.clone()),
            corps: Set(root.corps.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let leaf = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            army_region: Set(format!("\t{}\u{a0}", root.army_region)),
            army: Set(root.army.clone()),
            corps: Set(root.corps.clone()),
            brigade: Set("1 бр".into()),
            company: Set("\t\r\n\u{a0}".into()),
            platoon: Set("1 взвод".into()),
            section: Set("1 секція".into()),
            active: Set(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let outsider = mk_sigint_unit(
        &env.dbx,
        sigint_unit::ActiveModel {
            army_region: Set("Схід".into()),
            army: Set(root.army.clone()),
            corps: Set(root.corps.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let row = create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: root.id,
            report_name: "Спільний".into(),
            locations: vec!["Північ".into()],
        },
    )
    .await
    .unwrap();
    let orphan = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: orphan.id,
            report_name: "Спільний".into(),
            locations: vec![],
        },
    )
    .await
    .unwrap();
    let snapshot = load(&env.dbx).await.unwrap();
    assert_eq!(snapshot.units[&leaf.id].target.report_name, "Спільний");
    assert!(!snapshot.units.contains_key(&outsider.id));
    assert!(!snapshot.units.contains_key(&peer.id));
    assert_eq!(
        snapshot.units[&orphan.id].target.parent_path,
        snapshot.units[&root.id].target.parent_path
    );
    let now = chrono::Utc::now().naive_utc();
    let item = mk_sigint_inbox_item(
        &env.dbx,
        sigint_inbox_item::ActiveModel {
            datetime: Set(Some(now)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sigint_inbox_item_unit::ActiveModel {
        item_id: Set(item.id),
        unit_id: Set(leaf.id),
        kind: Set(SigintInboxItemUnitKind::Parsed),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let peer_item = mk_sigint_inbox_item(
        &env.dbx,
        sigint_inbox_item::ActiveModel {
            datetime: Set(Some(now)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sigint_inbox_item_unit::ActiveModel {
        item_id: Set(peer_item.id),
        unit_id: Set(peer.id),
        kind: Set(SigintInboxItemUnitKind::Parsed),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let candidates = signal_message::Entity::find()
        .filter(configured_membership_expr())
        .select_only()
        .column(signal_message::Column::Id)
        .into_tuple::<i64>()
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(candidates, vec![item.id]);
    for item_id in [item.id, peer_item.id] {
        mk_signal_message_group(
            &env.dbx,
            signal_message_group::ActiveModel {
                signal_message_id: Set(item_id),
                group_master_key: Set(Some("vukho-test-master-key".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let req: crate::rer_importer::types::AnalysisStatsReq = serde_json::from_value(serde_json::json!({
        "since_date_inclusive_ms": (now - chrono::Duration::hours(1)).and_utc().timestamp_millis(),
        "till_date_noninclusive_ms": (now + chrono::Duration::hours(1)).and_utc().timestamp_millis(),
        "only_for_rer_report": true
    })).unwrap();
    let login = crate::users::login_id_by_name(&env.dbx, "Tester")
        .await
        .unwrap();
    let (_, selected_count) =
        crate::rer_importer::analysis::stats::fetch_counts_for_login(
            &actix_web::web::Json(req),
            &login,
            &env,
            vec!["vukho-test-master-key".into()],
        )
        .await
        .unwrap();
    assert_eq!(selected_count, 1);
    let mut leaf_edit = leaf.clone().into_active_model();
    leaf_edit.active = Set(true);
    leaf_edit.update(&env.dbx).await.unwrap();
    create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: leaf.id,
            report_name: "Окремий".into(),
            locations: vec![],
        },
    )
    .await
    .unwrap();
    let current = load(&env.dbx).await.unwrap();
    assert_eq!(current.units[&leaf.id].target.report_name, "Окремий");
    assert_eq!(snapshot.units[&leaf.id].target.report_name, "Спільний");
    assert!(create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: outsider.id,
            report_name: "Спільний".into(),
            locations: vec![],
        }
    )
    .await
    .is_err());
    crate::rer_report_admin::delete_metadata(&env.dbx, row.id)
        .await
        .unwrap();
    let current = load(&env.dbx).await.unwrap();
    assert!(!current.units.contains_key(&root.id));
    assert_eq!(current.units[&orphan.id].target.parent_name, "Спільний");
}
