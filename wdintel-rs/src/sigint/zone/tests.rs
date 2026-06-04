use super::*;
use crate::functest::tests::*;

/// Test updating a zone datasource group is working
#[serial]
#[tokio::test]
async fn test_bl_szd_group_update_01() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let szd = mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let group_master_key = szd.group_master_key.clone();
    // explicitly check there are no group aors
    let signal_group_aors = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group_master_key.clone()),
        )
        .all(&txn)
        .await
        .unwrap();
    assert!(
        signal_group_aors.is_empty(),
        "Expected no group AORs, found: {signal_group_aors:?}"
    );
    let aor = mk_aor(
        &txn,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let req = ZoneDatasourceGroupUpdateReq {
        id: szd.id,
        is_secret: false,
        user_logins: vec![],
        admin_logins: vec![],
        short_note: None,
        long_note: None,
        area_of_responsibility_id: None,
        area_of_responsibility_ids: Some(vec![aor.id]),
    };
    let res = bl_szd_group_update(&req, &szd, &txn).await.unwrap();

    assert!(res.aor.is_some());
    let signal_group_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.eq(group_master_key))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(signal_group_aors.len(), 1);
    assert_eq!(signal_group_aors[0].aor_id, aor.id);

    txn.rollback().await.unwrap();
}

/// Test listing zone datasource groups when two groups are assigned to the same AOR
#[serial]
#[tokio::test]
async fn test_bl_szd_groups_list_01() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();

    let zone = mk_sigint_zone(
        &txn,
        sigint_zone::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let datasource = mk_datasource(
        &txn,
        datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let aor = mk_aor(
        &txn,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let group1 = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let group2 = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Create two sigint_zone_datasource records (groups) using the signal_group master keys
    mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone.id),
            datasource_id: Set(datasource.id),
            group_master_key: Set(group1.master_key.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            sigint_zone_id: Set(zone.id),
            datasource_id: Set(datasource.id),
            group_master_key: Set(group2.master_key.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Create signal_group_aor records to assign both groups to the same AOR
    mk_signal_group_aor(
        &txn,
        signal_group_aor::ActiveModel {
            master_key: Set(group1.master_key.clone()),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    mk_signal_group_aor(
        &txn,
        signal_group_aor::ActiveModel {
            master_key: Set(group2.master_key.clone()),
            aor_id: Set(aor.id),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Call bl_szd_groups_list
    let res = bl_szd_groups_list(zone.id, datasource.id, &txn)
        .await
        .unwrap();

    // Verify we got both groups
    assert_eq!(res.groups.len(), 2);

    // Verify each group has an AOR assigned
    for group in &res.groups {
        assert!(
            group.areas_of_responsibility.is_some(),
            "Group {} should have an AOR assigned",
            group.group_master_key
        );
        assert_eq!(
            group.areas_of_responsibility.as_ref().unwrap()[0].id,
            aor.id,
            "Group {} should be assigned to the correct AOR",
            group.group_master_key
        );
    }

    txn.rollback().await.unwrap();
}
