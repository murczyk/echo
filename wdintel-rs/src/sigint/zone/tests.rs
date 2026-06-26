use super::*;
use crate::functest::tests::*;

#[test]
fn test_normalize_my_admin_group_admin_logins_rejects_empty() {
    let err = normalize_my_admin_group_admin_logins(vec![
        " ".to_string(),
        "".to_string(),
    ])
    .unwrap_err();

    assert!(matches!(err, AppError::BL { .. }));
}

#[test]
fn test_normalize_my_admin_group_admin_logins_trims_and_deduplicates() {
    let admin_logins = normalize_my_admin_group_admin_logins(vec![
        " admin-b ".to_string(),
        "admin-a".to_string(),
        "admin-b".to_string(),
    ])
    .unwrap();

    assert_eq!(admin_logins, vec!["admin-a", "admin-b"]);
}

#[test]
fn test_reject_new_my_admin_group_admin_outside_organism() {
    let err = ensure_added_my_admin_group_admin_logins_allowed(
        &["current".to_string(), "outside".to_string()],
        &["current".to_string(), "same-org".to_string()],
        &[],
    )
    .unwrap_err();

    assert!(matches!(err, AppError::Forbidden(_)));
}

#[test]
fn test_keep_existing_my_admin_group_admin_outside_organism() {
    ensure_added_my_admin_group_admin_logins_allowed(
        &["current".to_string(), "outside".to_string()],
        &["current".to_string(), "same-org".to_string()],
        &["outside".to_string()],
    )
    .unwrap();
}

#[test]
fn test_reject_new_my_admin_group_user_outside_organism() {
    let err = ensure_added_my_admin_group_user_logins_allowed(
        &["current".to_string(), "outside".to_string()],
        &["current".to_string(), "same-org".to_string()],
        &[],
    )
    .unwrap_err();

    assert!(matches!(err, AppError::Forbidden(_)));
}

#[test]
fn test_keep_existing_my_admin_group_user_outside_organism() {
    ensure_added_my_admin_group_user_logins_allowed(
        &["current".to_string(), "outside".to_string()],
        &["current".to_string(), "same-org".to_string()],
        &["outside".to_string()],
    )
    .unwrap();
}

#[serial]
#[tokio::test]
async fn test_collect_active_organism_logins_excludes_deleted() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("my-admin-org".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("my-admin-other-org".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    for login in ["current-admin", "same-org"] {
        mk_login(
            &txn,
            login::ActiveModel {
                login: Set(login.to_string()),
                organism_id: Set(Some(organism.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    mk_login(
        &txn,
        login::ActiveModel {
            login: Set("other-org".to_string()),
            organism_id: Set(Some(other_organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_login(
        &txn,
        login::ActiveModel {
            login: Set("deleted-same-org".to_string()),
            organism_id: Set(Some(organism.id)),
            deleted: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_login(
        &txn,
        login::ActiveModel {
            login: Set("permanently-deleted-same-org".to_string()),
            organism_id: Set(Some(organism.id)),
            deleted_permanently: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let logins = collect_active_organism_logins(&txn, "current-admin")
        .await
        .unwrap();

    assert_eq!(logins, vec!["current-admin", "same-org"]);

    txn.rollback().await.unwrap();
}

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
        is_rer: None,
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

#[serial]
#[tokio::test]
async fn test_bl_szd_groups_list_excludes_archived_groups() {
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
    let active_group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let archived_group = mk_signal_group(
        &txn,
        signal_group::ActiveModel {
            is_archived: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    for group in [&active_group, &archived_group] {
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
    }

    let res = bl_szd_groups_list(zone.id, datasource.id, &txn)
        .await
        .unwrap();
    let group_keys = res
        .groups
        .into_iter()
        .map(|group| group.group_master_key)
        .collect::<Vec<_>>();

    assert_eq!(group_keys, vec![active_group.master_key]);

    txn.rollback().await.unwrap();
}
