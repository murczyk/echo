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
        "Expected no group AORs, found: {:?}",
        signal_group_aors
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
        short_note: None,
        long_note: None,
        area_of_responsibility_id: Some(aor.id),
    };
    let res = bl_szd_group_update(&req, &szd, &txn).await.unwrap();

    assert_eq!(res.aor.is_some(), true);
    let signal_group_aors = signal_group_aor::Entity::find()
        .filter(signal_group_aor::Column::MasterKey.eq(group_master_key))
        .all(&txn)
        .await
        .unwrap();
    assert_eq!(signal_group_aors.len(), 1);
    assert_eq!(signal_group_aors[0].aor_id, aor.id);

    txn.rollback().await.unwrap();
}
