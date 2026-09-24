use super::*;
use crate::devices::analytics::types::{
    DeviceAnalyticsFilesReq, DeviceAnalyticsSummaryReq,
};
use crate::devices::files::sessions::read;

#[tokio::test]
#[serial_test::serial]
async fn issue_3390_session_analysis_uses_the_latest_compatible_completed_result(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let files = env.file_registry_db().unwrap();
    let file_db = files.connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(file_db, "Session PDF #3390".to_owned())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    run_to_completion(env.as_ref(), run.id, 1).await;
    let initial = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    let device = device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let owner = login::Entity::find()
        .filter(login::Column::Login.eq(device.created_by))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let actor = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let reader =
        access::login_with_roles(&owner, &[crate::devices::ROLE_CYBER]);
    let metadata_only = crate::devices::files::sync::automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        vec![RawSyncDeviceFileItem {
            absolute_path: r"C:\report.pdf".to_owned(),
            extension: Some("pdf".to_owned()),
            mime_type: Some("application/pdf".to_owned()),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            source_file_state: None,
        }],
    )
    .await
    .unwrap();
    assert!(metadata_only.sync.analysis_run_id.is_none());
    let request = || DeviceAnalyticsSummaryReq {
        device_id: device_id.to_string(),
        sync_id: Some(metadata_only.sync.sync_id.clone()),
    };
    let summary = read::summary(&env.dbx, files, &reader, request())
        .await
        .unwrap();
    assert_eq!(summary.analyzed_file_count, 1);
    assert_eq!(
        summary
            .items
            .iter()
            .find(|item| item.tag.id == tag.id)
            .unwrap()
            .file_count,
        1
    );
    let tagged = read::analytics_files(
        &env.dbx,
        files,
        &reader,
        DeviceAnalyticsFilesReq {
            device_id: device_id.to_string(),
            sync_id: request().sync_id,
            tag_id: tag.id.clone(),
            limit: Some(1),
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(tagged.files[0].file_id, file_id.to_string());
    let extra_tag = bl::create_tag(file_db, "Manual result #3390".to_owned())
        .await
        .unwrap();
    save_extension_rule(
        env.as_ref(),
        Uuid::parse_str(&extra_tag.id).unwrap(),
        "pdf",
    )
    .await;
    let manual_run =
        queue::create_manual_run(file_db, device_id).await.unwrap();
    let pending = read::summary(&env.dbx, files, &reader, request())
        .await
        .unwrap();
    assert!(pending.items.iter().any(|item| item.tag.id == tag.id));
    assert!(pending.items.iter().all(|item| item.tag.id != extra_tag.id));
    run_to_completion(env.as_ref(), manual_run.id, 1).await;
    let reanalyzed = read::summary(&env.dbx, files, &reader, request())
        .await
        .unwrap();
    assert!(reanalyzed
        .items
        .iter()
        .any(|item| item.tag.id == extra_tag.id));
    let changed_run =
        sync_file_extension(env.as_ref(), device_id, r"C:\report.pdf", "txt")
            .await
            .unwrap();
    run_to_completion(env.as_ref(), changed_run, 1).await;
    assert!(file_links(env.as_ref(), file_id)
        .await
        .iter()
        .all(|link| link.tag_id != tag_id));
    let old = read::summary(&env.dbx, files, &reader, request())
        .await
        .unwrap();
    assert!(old.items.iter().any(|item| item.tag.id == tag.id));
    let first = read::summary(
        &env.dbx,
        files,
        &reader,
        DeviceAnalyticsSummaryReq {
            sync_id: initial.sync_id.map(|id| id.to_string()),
            ..request()
        },
    )
    .await
    .unwrap();
    assert!(first.items.iter().any(|item| item.tag.id == tag.id));
    let journal_request = |extra: serde_json::Value| {
        let mut body = serde_json::json!({ "device_id": device_id, "sync_id": request().sync_id });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(body).unwrap()
    };
    let tagged_journal = read::journal(&env.dbx, files, &reader,
        journal_request(serde_json::json!({"tag_ids": [tag.id, extra_tag.id], "tag_match": "all", "limit": 1}))).await.unwrap();
    assert_eq!(tagged_journal.total_count, 1);
    assert_eq!(tagged_journal.entries[0].revision, 2);
    let untagged = read::journal(
        &env.dbx,
        files,
        &reader,
        journal_request(serde_json::json!({"untagged": true, "limit": 1})),
    )
    .await
    .unwrap();
    assert_eq!(untagged.total_count, 0);
    assert!(untagged.entries.is_empty());
    bl::archive_tag(file_db, tag_id).await.unwrap();
    let archived = read::summary(&env.dbx, files, &reader, request())
        .await
        .unwrap();
    assert_eq!(archived.analyzed_file_count, 1);
    assert!(archived.items.iter().all(|item| item.tag.id != tag.id));
}
