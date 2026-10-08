use super::*;
use crate::functest::tests::{cleanup_locked, mk_login, mk_sigint_unit};
use sea_orm::{ActiveModelTrait, EntityTrait};
use serial_test::serial;

#[tokio::test]
#[serial]
async fn rer_report_eligibility_matches_exact_access_list() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let login = mk_login(&env.dbx, Default::default()).await.unwrap();
    assert!(!user_is_eligible(&env.dbx, &login.id).await.unwrap());

    rer_report_access_login::ActiveModel {
        login_id: Set(login.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();

    assert!(user_is_eligible(&env.dbx, &login.id).await.unwrap());
}

#[tokio::test]
#[serial]
async fn unit_merge_unions_rer_report_metadata() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let target = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    for (unit_id, locations, labels) in [
        (
            source.id,
            serde_json::json!(["B", "C"]),
            serde_json::json!(["S"]),
        ),
        (
            target.id,
            serde_json::json!(["A", "B"]),
            serde_json::json!(["T"]),
        ),
    ] {
        sigint_unit_rer_report_metadata::ActiveModel {
            sigint_unit_id: Set(unit_id),
            locations: Set(locations),
            labels: Set(labels),
            ..Default::default()
        }
        .insert(&env.dbx)
        .await
        .unwrap();
    }

    let login = crate::users::login_id_by_name(&env.dbx, "Tester")
        .await
        .unwrap();
    let transaction = crate::sigint::unit::begin_unit_merge_transaction(
        &env.dbx,
        &[source.id, target.id],
    )
    .await
    .unwrap();
    crate::sigint::unit::merge_units_in_transaction(
        login,
        &transaction,
        source.id,
        target.id,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let rows = sigint_unit_rer_report_metadata::Entity::find()
        .all(&env.dbx)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sigint_unit_id, target.id);
    assert_eq!(rows[0].locations, serde_json::json!(["A", "B", "C"]));
    assert_eq!(rows[0].labels, serde_json::json!(["T", "S"]));
    assert!(
        sigint_unit::Entity::find_by_id(source.id)
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap()
            .deleted
    );
}

#[tokio::test]
#[serial]
async fn access_replacement_is_serialized_and_invalid_ids_preserve_access() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let first = mk_login(&env.dbx, Default::default()).await.unwrap();
    let second = mk_login(&env.dbx, Default::default()).await.unwrap();
    let transaction = env.dbx.begin().await.unwrap();
    rer_report_access_login::ActiveModel {
        login_id: Set(first.id),
        ..Default::default()
    }
    .insert(&transaction)
    .await
    .unwrap();
    let ids = [second.id];
    let replacement = replace_access_list(&env.dbx, &ids);
    tokio::pin!(replacement);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(100),
        &mut replacement
    )
    .await
    .is_err());
    transaction.commit().await.unwrap();
    replacement.await.unwrap();
    assert!(!user_is_eligible(&env.dbx, &first.id).await.unwrap());
    assert!(user_is_eligible(&env.dbx, &second.id).await.unwrap());
    assert!(replace_access_list(&env.dbx, &[Uuid::new_v4()])
        .await
        .is_err());
    assert!(user_is_eligible(&env.dbx, &second.id).await.unwrap());
    replace_access_list(&env.dbx, &[]).await.unwrap();
    assert!(!user_is_eligible(&env.dbx, &second.id).await.unwrap());
}

#[tokio::test]
#[serial]
async fn metadata_crud_preserves_rows_when_reassignment_conflicts() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let first = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let second = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let first = create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: first.id,
            locations: vec![" A ".into(), "A".into()],
            labels: vec!["first".into()],
        },
    )
    .await
    .unwrap();
    let second = create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: second.id,
            locations: vec![],
            labels: vec!["second".into()],
        },
    )
    .await
    .unwrap();
    let mut update = UpdateRerReportMetadataReq {
        id: first.id,
        sigint_unit_id: second.sigint_unit_id,
        locations: vec!["changed".into()],
        labels: vec![],
    };
    assert!(update_metadata(&env.dbx, &update).await.is_err());
    assert_eq!(
        metadata_item_by_id(&env.dbx, first.id).await.unwrap(),
        first
    );
    assert_eq!(
        metadata_item_by_id(&env.dbx, second.id).await.unwrap(),
        second
    );
    update.sigint_unit_id = first.sigint_unit_id;
    let saved = update_metadata(&env.dbx, &update).await.unwrap();
    assert_eq!(saved.locations, vec!["changed".to_string()]);
    assert!(saved.labels.is_empty());
    delete_metadata(&env.dbx, first.id).await.unwrap();
    assert!(metadata_item_by_id(&env.dbx, first.id).await.is_err());
    assert_eq!(list_metadata(&env.dbx).await.unwrap(), vec![second]);
}

#[tokio::test]
#[serial]
async fn metadata_creation_waits_for_merge_and_rejects_deleted_source() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let target = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let transaction = crate::sigint::unit::begin_unit_merge_transaction(
        &env.dbx,
        &[source.id, target.id],
    )
    .await
    .unwrap();
    let req = CreateRerReportMetadataReq {
        sigint_unit_id: source.id,
        locations: vec!["location".into()],
        labels: vec![],
    };
    let creation = create_metadata(&env.dbx, &req);
    tokio::pin!(creation);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(100),
        &mut creation
    )
    .await
    .is_err());
    let login = crate::users::login_id_by_name(&env.dbx, "Tester")
        .await
        .unwrap();
    crate::sigint::unit::merge_units_in_transaction(
        login,
        &transaction,
        source.id,
        target.id,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    assert!(creation.await.is_err());
    assert!(list_metadata(&env.dbx).await.unwrap().is_empty());
}

#[tokio::test]
#[serial]
async fn metadata_deletion_rejects_a_row_moved_by_a_concurrent_merge() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let source = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let target = mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
    let metadata = create_metadata(
        &env.dbx,
        &CreateRerReportMetadataReq {
            sigint_unit_id: source.id,
            locations: vec!["location".into()],
            labels: vec![],
        },
    )
    .await
    .unwrap();
    let transaction = crate::sigint::unit::begin_unit_merge_transaction(
        &env.dbx,
        &[source.id, target.id],
    )
    .await
    .unwrap();
    let deletion = delete_metadata(&env.dbx, metadata.id);
    tokio::pin!(deletion);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(100),
        &mut deletion
    )
    .await
    .is_err());
    merge_unit_metadata(&transaction, source.id, target.id)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert!(deletion.await.is_err());
    let saved = metadata_item_by_id(&env.dbx, metadata.id).await.unwrap();
    assert_eq!(saved.sigint_unit_id, target.id);
    assert_eq!(saved.locations, metadata.locations);
}
