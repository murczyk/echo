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

#[test]
fn test_group_requests_default_missing_organism_ids() {
    let update_req: ZoneDatasourceGroupUpdateReq =
        serde_json::from_value(serde_json::json!({
            "id": 1,
            "is_secret": true,
            "interseption_kind": null,
            "disable_network_assignment": null,
            "user_logins": [],
            "admin_logins": [],
            "short_note": null,
            "long_note": null,
            "area_of_responsibility_id": null,
            "area_of_responsibility_ids": null
        }))
        .unwrap();
    assert!(update_req.organism_ids.is_empty());

    let add_req: ZoneDatasourceGroupAddReq =
        serde_json::from_value(serde_json::json!({
            "zone_id": 1,
            "datasource_id": 2,
            "is_secret": true,
            "interseption_kind": null,
            "master_key": "group-key",
            "user_logins": [],
            "admin_logins": [],
            "short_note": null,
            "long_note": null
        }))
        .unwrap();
    assert!(add_req.organism_ids.is_empty());

    let my_admin_req: MyAdminSignalGroupUpdateReq =
        serde_json::from_value(serde_json::json!({
            "master_key": "group-key",
            "is_secret": true,
            "disable_network_assignment": false,
            "user_logins": [],
            "admin_logins": [],
            "area_of_responsibility_ids": null
        }))
        .unwrap();
    assert!(my_admin_req.organism_ids.is_empty());
}

#[serial]
#[tokio::test]
async fn test_collect_active_organism_login_ids_excludes_deleted() {
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
                id: NotSet,
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
            id: NotSet,
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
            id: NotSet,
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
            id: NotSet,
            login: Set("permanently-deleted-same-org".to_string()),
            organism_id: Set(Some(organism.id)),
            deleted_permanently: Set(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let current_admin_id =
        crate::users::login_id_by_name(&txn, "current-admin")
            .await
            .unwrap();
    let logins = collect_active_organism_login_ids(&txn, &current_admin_id)
        .await
        .unwrap();

    assert_eq!(logins.len(), 2);

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
        interseption_kind: None,
        disable_network_assignment: None,
        user_logins: vec![],
        organism_ids: vec![],
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

#[serial]
#[tokio::test]
async fn test_secret_group_organism_invite_materializes_direct_and_derived_users(
) {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("secret-group-organism".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let direct_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("secret-direct-user".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let organism_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("secret-organism-user".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let overlap_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("secret-overlap-user".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let szd = mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let master_key = szd.group_master_key.clone();

    bl_zones_datasources_group_update_or_add(
        vec![direct_login.id.to_string(), overlap_login.id.to_string()],
        vec![organism.id],
        vec![],
        true,
        None,
        None,
        szd.clone(),
        &txn,
    )
    .await
    .unwrap();

    let invite = secret_group_organism::Entity::find()
        .filter(secret_group_organism::Column::MasterKey.eq(master_key.clone()))
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(invite.organism_id, organism.id);

    let rows = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(master_key.clone()))
        .all(&txn)
        .await
        .unwrap();
    let mut direct_logins = rows
        .iter()
        .filter(|row| row.secret_group_organism_id.is_none())
        .map(|row| row.login_id)
        .collect::<Vec<_>>();
    direct_logins.sort();
    assert_eq!(direct_logins, vec![direct_login.id, overlap_login.id]);

    let mut derived_logins = rows
        .iter()
        .filter(|row| row.secret_group_organism_id == Some(invite.id))
        .map(|row| row.login_id)
        .collect::<Vec<_>>();
    derived_logins.sort();
    assert_eq!(derived_logins, vec![organism_login.id, overlap_login.id]);

    let list = bl_szd_groups_list(szd.sigint_zone_id, szd.datasource_id, &txn)
        .await
        .unwrap();
    let group = list
        .groups
        .into_iter()
        .find(|group| group.group_master_key == master_key)
        .unwrap();
    assert_eq!(
        group.allowed_users,
        direct_logins
            .into_iter()
            .map(|login_id| login_id.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(group.allowed_organism_ids, vec![organism.id]);

    txn.rollback().await.unwrap();
}

#[serial]
#[tokio::test]
async fn test_adding_existing_secret_group_preserves_access() {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("readded-secret-group-organism".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let login = mk_login(
        &txn,
        login::ActiveModel {
            login: Set("readded-secret-group-user".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let szd = mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();

    update_signal_group_access_and_admins(
        vec![login.login.clone()],
        vec![organism.id],
        vec![login.login],
        true,
        &szd.group_master_key,
        &txn,
    )
    .await
    .unwrap();
    let access = secret_group_access(&txn, &szd.group_master_key).await;

    let is_secret = bl_zones_datasources_group_add(
        vec![],
        vec![],
        vec![],
        false,
        None,
        None,
        &szd,
        &txn,
    )
    .await
    .unwrap();

    assert!(is_secret);
    assert_eq!(
        secret_group_access(&txn, &szd.group_master_key).await,
        access
    );

    txn.rollback().await.unwrap();
}

async fn secret_group_access(
    txn: &DatabaseTransaction,
    master_key: &str,
) -> (bool, Vec<String>, Vec<i64>, Vec<String>) {
    let group = signal_group::Entity::find_by_id(master_key.to_string())
        .one(txn)
        .await
        .unwrap()
        .unwrap();
    let users =
        collect_direct_secret_group_users(vec![master_key.to_string()], txn)
            .await
            .unwrap()
            .remove(master_key)
            .unwrap_or_default();
    let organisms =
        collect_secret_group_organism_ids(vec![master_key.to_string()], txn)
            .await
            .unwrap()
            .remove(master_key)
            .unwrap_or_default();
    let admins = collect_signal_group_admins(vec![master_key.to_string()], txn)
        .await
        .unwrap()
        .remove(master_key)
        .unwrap_or_default();
    (group.is_secret, users, organisms, admins)
}

#[serial]
#[tokio::test]
async fn test_refresh_secret_group_memberships_removes_moved_deleted_and_disabled(
) {
    let env = cleanup().await.unwrap();
    let txn = env.dbx.begin().await.unwrap();
    let organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("refresh-secret-group-organism".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let other_organism = mk_organism(
        &txn,
        organism::ActiveModel {
            name: Set("refresh-secret-group-other-organism".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let moved_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("refresh-moved-user".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let deleted_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("refresh-deleted-user".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let szd = mk_sigint_zone_datasource(
        &txn,
        sigint_zone_datasource::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let master_key = szd.group_master_key.clone();

    bl_zones_datasources_group_update_or_add(
        vec![],
        vec![organism.id],
        vec![],
        true,
        None,
        None,
        szd,
        &txn,
    )
    .await
    .unwrap();
    let invite = secret_group_organism::Entity::find()
        .filter(secret_group_organism::Column::MasterKey.eq(master_key.clone()))
        .one(&txn)
        .await
        .unwrap()
        .unwrap();
    let mut expected_login_ids = vec![deleted_login.id, moved_login.id];
    expected_login_ids.sort();
    assert_eq!(
        derived_secret_group_logins(&txn, &master_key, invite.id).await,
        expected_login_ids
    );

    let added_login = mk_login(
        &txn,
        login::ActiveModel {
            id: NotSet,
            login: Set("refresh-added-user".to_string()),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut moved_login = moved_login.into_active_model();
    moved_login.organism_id = Set(Some(other_organism.id));
    moved_login.update(&txn).await.unwrap();
    let mut deleted_login = deleted_login.into_active_model();
    deleted_login.deleted = Set(true);
    deleted_login.update(&txn).await.unwrap();
    refresh_secret_group_memberships(&txn).await.unwrap();
    assert_eq!(
        derived_secret_group_logins(&txn, &master_key, invite.id).await,
        vec![added_login.id]
    );

    let mut organism = organism.into_active_model();
    organism.enabled = Set(false);
    organism.update(&txn).await.unwrap();
    refresh_secret_group_memberships(&txn).await.unwrap();
    let invite_count = secret_group_organism::Entity::find()
        .filter(secret_group_organism::Column::MasterKey.eq(master_key.clone()))
        .count(&txn)
        .await
        .unwrap();
    let derived_count = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(master_key.clone()))
        .filter(secret_group_user::Column::SecretGroupOrganismId.is_not_null())
        .count(&txn)
        .await
        .unwrap();
    assert_eq!(invite_count, 0);
    assert_eq!(derived_count, 0);

    txn.rollback().await.unwrap();
}

async fn derived_secret_group_logins(
    txn: &DatabaseTransaction,
    master_key: &str,
    invite_id: i64,
) -> Vec<uuid::Uuid> {
    let mut logins = secret_group_user::Entity::find()
        .filter(secret_group_user::Column::MasterKey.eq(master_key))
        .filter(
            secret_group_user::Column::SecretGroupOrganismId
                .eq(Some(invite_id)),
        )
        .select_only()
        .column(secret_group_user::Column::LoginId)
        .into_tuple::<uuid::Uuid>()
        .all(txn)
        .await
        .unwrap();
    logins.sort();
    logins
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
