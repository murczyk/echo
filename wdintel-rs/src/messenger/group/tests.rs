use super::*;
use crate::functest::tests::*;
use serial_test::serial;

/// Test that insert_group_aor doesn't override existing AOR assignments
#[serial]
#[tokio::test]
async fn test_insert_group_aor_respects_existing_assignments() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();

    let datasource = mk_datasource(
        &txn,
        datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            datasource_id: Set(Some(datasource.id)),
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

    let datasource_default_aor = mk_aor(
        &txn,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let mut datasource_active = datasource.into_active_model();
    datasource_active.default_aor_id = Set(Some(datasource_default_aor.id));
    let _datasource = datasource_active.update(&txn).await.unwrap();

    signal_group_aor::ActiveModel {
        master_key: Set(group.master_key.clone()),
        aor_id: Set(aor1.id),
        id: NotSet,
        created_at: NotSet,
    }
    .insert(&txn)
    .await
    .unwrap();

    signal_group_aor::ActiveModel {
        master_key: Set(group.master_key.clone()),
        aor_id: Set(aor2.id),
        id: NotSet,
        created_at: NotSet,
    }
    .insert(&txn)
    .await
    .unwrap();

    let aor_count_before = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group.master_key.clone()),
        )
        .count(&txn)
        .await
        .unwrap();
    assert_eq!(aor_count_before, 2);

    let result = insert_group_aor(&txn, &group).await;

    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        None,
        "Function should return None when group already has AOR assignments"
    );

    let aor_count_after = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group.master_key.clone()),
        )
        .count(&txn)
        .await
        .unwrap();

    assert_eq!(
        aor_count_after, 2,
        "Expected 2 AOR assignments but found {aor_count_after}"
    );

    let assigned_aor_ids: Vec<i64> = signal_group_aor::Entity::find()
        .filter(
            signal_group_aor::Column::MasterKey.eq(group.master_key.clone()),
        )
        .all(&txn)
        .await
        .unwrap()
        .iter()
        .map(|aor| aor.aor_id)
        .collect();

    assert!(assigned_aor_ids.contains(&aor1.id));
    assert!(assigned_aor_ids.contains(&aor2.id));

    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn test_set_signal_group_archived_deletes_direction_links() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();

    let datasource = mk_datasource(
        &txn,
        datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let zone = mk_sigint_zone(
        &txn,
        sigint_zone::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            datasource_id: Set(Some(datasource.id)),
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
            group_master_key: Set(group.master_key.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    set_signal_group_archived(&txn, &group.master_key, true)
        .await
        .unwrap();

    let group = signal_group::Entity::find_by_id(group.master_key.clone())
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert!(group.is_archived);

    let direction_links = sigint_zone_datasource::Entity::find()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey
                .eq(&group.master_key),
        )
        .count(&txn)
        .await
        .unwrap();
    assert_eq!(direction_links, 0);

    set_signal_group_archived(&txn, &group.master_key, false)
        .await
        .unwrap();

    let group = signal_group::Entity::find_by_id(group.master_key.clone())
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert!(!group.is_archived);

    let direction_links = sigint_zone_datasource::Entity::find()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey
                .eq(&group.master_key),
        )
        .count(&txn)
        .await
        .unwrap();
    assert_eq!(direction_links, 0);

    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn test_get_identity_sigint_groups_includes_secret_organism_invites() {
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
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login = mk_login(
        &txn,
        login::ActiveModel {
            login: Set("secret-organism-viewer".to_string()),
            sigint_zone_id: Set(Some(zone.id)),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            datasource_id: Set(Some(datasource.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_datasource_group(
        &txn,
        datasource_group::ActiveModel {
            datasource_id: Set(datasource.id),
            group_master_key: Set(group.master_key.clone()),
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
            group_master_key: Set(group.master_key.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    crate::sigint::zone::bl::update_signal_group_access_and_admins(
        vec![],
        vec![organism.id],
        vec![],
        true,
        &group.master_key,
        &txn,
    )
    .await
    .unwrap();

    let organism_group_count = organism_group::Entity::find()
        .filter(organism_group::Column::OrganismId.eq(organism.id))
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(group.master_key.clone()),
        )
        .count(&txn)
        .await
        .unwrap();
    assert_eq!(organism_group_count, 0);

    let master_keys = get_identity_sigint_groups(&txn, &login.login)
        .await
        .unwrap();

    assert_eq!(master_keys, vec![group.master_key]);

    txn.rollback().await.unwrap();
}
