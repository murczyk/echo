use super::*;
use crate::devices::files::{
    sessions::{listing, read, types::*},
    types::*,
};

fn request<T: serde::de::DeserializeOwned>(
    device_id: Uuid,
    sync_id: &str,
    extra: serde_json::Value,
) -> T {
    let mut body = json!({ "device_id": device_id, "sync_id": sync_id });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3390_session_reads_keep_revisions_after_later_sync() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "session-read-3390").await;
    let files = env.file_registry_db().unwrap();
    let reader =
        access::login_with_roles(&actor, &[crate::devices::ROLE_CYBER]);
    let first = automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        vec![
            raw_item(r"C:\reports\a.log"),
            raw_item(r"C:\reports\z.log"),
            raw_item("relative"),
        ],
    )
    .await
    .unwrap();
    let mut updated = raw_item(r"C:\reports\a.log");
    updated.mime_type = Some("application/pdf".to_owned());
    updated.extension = Some("pdf".to_owned());
    let second = automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        vec![updated, raw_item(r"D:\other\b.log")],
    )
    .await
    .unwrap();
    let sync_id = &first.sync.sync_id;
    let roots = read::roots(
        &env.dbx,
        files,
        &reader,
        request(device_id, sync_id, json!({})),
    )
    .await
    .unwrap();
    assert_eq!(roots.roots.len(), 1);
    let root_id = &roots.roots[0].entry_id;
    let counts = read::counts(
        &env.dbx,
        files,
        &reader,
        request(
            device_id,
            sync_id,
            json!({"directory_entry_ids": [root_id], "parent_entry_id": null}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(counts.counts[0].file_count, 2);
    let other_roots = read::roots(
        &env.dbx,
        files,
        &reader,
        request(device_id, &second.sync.sync_id, json!({})),
    )
    .await
    .unwrap();
    let outside = &other_roots
        .roots
        .iter()
        .find(|root| root.entry_id != *root_id)
        .unwrap()
        .entry_id;
    let ordered = read::counts(&env.dbx, files, &reader, request(device_id, sync_id,
        json!({"directory_entry_ids": [outside, root_id], "parent_entry_id": null}))).await.unwrap();
    assert_eq!(
        ordered
            .counts
            .iter()
            .map(|row| (row.entry_id.as_str(), row.file_count))
            .collect::<Vec<_>>(),
        vec![(outside.as_str(), 0), (root_id.as_str(), 2)]
    );
    let browse = read::browse(
        &env.dbx,
        files,
        &reader,
        request(device_id, sync_id, json!({"parent_entry_id": root_id})),
    )
    .await
    .unwrap();
    assert_eq!(browse.entries.len(), 1);
    assert_eq!(browse.entries[0].kind, FileEntryKind::Directory);
    let directory_id = &browse.entries[0].entry_id;
    let browse = read::browse(
        &env.dbx,
        files,
        &reader,
        request(
            device_id,
            sync_id,
            json!({"parent_entry_id": directory_id, "limit": 1}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(browse.entries[0].name, "a.log");
    assert_eq!(browse.entries[0].revision, Some(1));
    assert_eq!(browse.entries[0].mime_type.as_deref(), Some("text/plain"));
    assert_eq!(browse.entries[0].path_components, vec!["reports", "a.log"]);
    let next = read::browse(&env.dbx, files, &reader, request(device_id, sync_id, json!({"parent_entry_id": directory_id, "limit": 1, "cursor": browse.next_cursor}))).await.unwrap();
    assert_eq!(next.entries[0].name, "z.log");
    assert!(next.next_cursor.is_none());
    assert!(read::browse(&env.dbx, files, &reader, request(device_id, &second.sync.sync_id, json!({"parent_entry_id": directory_id, "limit": 1, "cursor": browse.next_cursor}))).await.is_err());
    let search = read::search(&env.dbx, files, &reader, request(device_id, sync_id, json!({"scope_entry_id": root_id, "mime_types": ["text/plain"], "name_query": "a.log"}))).await.unwrap();
    assert_eq!(search.entries.len(), 1);
    assert_eq!(search.entries[0].revision, Some(1));
    let mut mime_types = (0..49)
        .map(|index| format!("application/{}{:03}", "x".repeat(240), index))
        .collect::<Vec<_>>();
    mime_types.push("text/plain".to_owned());
    let mut paged_search: SearchDeviceFilesReq = request(
        device_id,
        sync_id,
        json!({"scope_entry_id": root_id, "mime_types": mime_types, "limit": 1}),
    );
    let first_page =
        read::search(&env.dbx, files, &reader, paged_search.clone())
            .await
            .unwrap();
    assert!(
        first_page.next_cursor.as_ref().unwrap().len()
            < crate::config::DEVICE_FILE_SESSION_CURSOR_MAX_BYTES
    );
    paged_search.cursor = first_page.next_cursor;
    let next_page = read::search(&env.dbx, files, &reader, paged_search)
        .await
        .unwrap();
    assert_eq!(next_page.entries[0].name, "z.log");
    let journal = read::journal(
        &env.dbx,
        files,
        &reader,
        request(device_id, sync_id, json!({"limit": 1})),
    )
    .await
    .unwrap();
    assert_eq!(journal.total_count, 2);
    assert!(journal.entries.iter().all(|entry| entry.revision == 1));
    let next = read::journal(
        &env.dbx,
        files,
        &reader,
        request(
            device_id,
            sync_id,
            json!({"limit": 1, "cursor": journal.next_cursor}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(next.total_count, 2);
    assert_ne!(journal.entries[0].file_id, next.entries[0].file_id);
    assert!(next.next_cursor.is_none());
    let summary = read::summary(
        &env.dbx,
        files,
        &reader,
        request(device_id, sync_id, json!({})),
    )
    .await
    .unwrap();
    assert_eq!(summary.total_file_count, 2);
    assert_eq!(summary.analyzed_file_count, 0);
    let summaries = listing::summaries(
        &env.dbx,
        files,
        &reader,
        DeviceSyncSessionSummariesReq {
            device_id: device_id.to_string(),
            sync_ids: vec![sync_id.clone(), second.sync.sync_id.clone()],
        },
    )
    .await
    .unwrap();
    assert_eq!(summaries.summaries.len(), 2);
    assert!(summaries
        .summaries
        .iter()
        .all(|summary| summary.analysis.total_file_count == 2));
    assert_session_access_and_listing(
        &env, &actor, &reader, device_id, sync_id,
    )
    .await;
}

async fn assert_session_access_and_listing(
    env: &Env,
    actor: &login::Model,
    reader: &login::Model,
    device_id: Uuid,
    sync_id: &str,
) {
    let files = env.file_registry_db().unwrap();
    let body =
        || request::<ListDeviceFileRootsReq>(device_id, sync_id, json!({}));
    assert!(matches!(
        read::roots(&env.dbx, files, actor, body()).await,
        Err(AppError::Forbidden(_))
    ));
    let other = insert_device(&env.dbx, actor).await;
    assert!(matches!(
        read::roots(
            &env.dbx,
            files,
            reader,
            request(other, sync_id, json!({}))
        )
        .await,
        Err(AppError::NotFound)
    ));
    let empty = start_explicit(&env.dbx, files, actor, device_id)
        .await
        .unwrap();
    let roots = read::roots(
        &env.dbx,
        files,
        reader,
        request(device_id, &empty.response.sync.sync_id, json!({})),
    )
    .await
    .unwrap();
    assert!(roots.roots.is_empty());
    let list_body = ListDeviceSyncSessionsReq {
        device_id: device_id.to_string(),
        created_from: None,
        created_to: None,
        limit: Some(1),
        cursor: None,
    };
    let list = listing::list(&env.dbx, files, reader, list_body.clone())
        .await
        .unwrap();
    assert_eq!(list.sessions[0].sync_id, empty.response.sync.sync_id);
    let second = listing::list(
        &env.dbx,
        files,
        reader,
        ListDeviceSyncSessionsReq {
            cursor: list.next_cursor,
            ..list_body.clone()
        },
    )
    .await
    .unwrap();
    assert_eq!(second.sessions.len(), 1);
    assert_ne!(list.sessions[0].sync_id, second.sessions[0].sync_id);
    let future = listing::list(
        &env.dbx,
        files,
        reader,
        ListDeviceSyncSessionsReq {
            created_from: Some("2100-01-01T00:00:00Z".to_owned()),
            ..list_body
        },
    )
    .await
    .unwrap();
    assert!(future.sessions.is_empty());
    let mut device = device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    device.archived = Set(true);
    device.archived_at = Set(Some(Utc::now().naive_utc()));
    device.update(&env.dbx).await.unwrap();
    assert!(!read::roots(&env.dbx, files, reader, body())
        .await
        .unwrap()
        .roots
        .is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn issue_3390_session_history_indexes_can_roll_back_and_reapply() {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    use sea_orm_migration::{MigratorTrait, SchemaManager};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let db = env.file_registry_db().unwrap().connection();
    let migration = wdfiles_migration::Migrator::migrations()
        .into_iter()
        .find(|migration| {
            migration.name() == "m20260921_122222_device_sync_session_history"
        })
        .unwrap();
    let manager = SchemaManager::new(db);
    migration.down(&manager).await.unwrap();
    migration.up(&manager).await.unwrap();
    let rows = db.query_all_raw(Statement::from_string(DbBackend::Postgres,
        "select indexname from pg_indexes where indexname in ('file_sync_session_history_idx', 'file_revision_session_journal_idx')".to_owned())).await.unwrap();
    assert_eq!(rows.len(), 2);
}
