use super::*;
use crate::devices::files::{
    bl, query, sessions::read, sorting::FileListingSort, types::*,
};

async fn current_entries(
    env: &Env,
    actor: &login::Model,
    device: Uuid,
) -> BrowseDeviceFilesRsp {
    let files = env.file_registry_db().unwrap();
    let root = query::list_roots(files, device).await.unwrap().remove(0);
    let scope = crate::devices::files::DirectoryScope::Root(root);
    let mut entries = Vec::new();
    let mut after = None;
    loop {
        let page = query::list_children_sorted(
            files,
            &scope,
            crate::devices::files::KeysetPageRequest::try_new(Some(1), after)
                .unwrap(),
            FileListingSort::new(
                Some(DeviceFileSortBy::FileSortCreatedAt),
                None,
            ),
        )
        .await
        .unwrap();
        entries.extend(page.entries);
        after = page.next;
        if after.is_none() {
            break;
        }
        assert!(entries.len() < 10);
    }
    let len = entries.len();
    let mut response =
        bl::map_browse(crate::devices::files::BrowseFilesResult {
            breadcrumbs: vec![],
            entries,
            entry_path_components: vec![vec![]; len],
            next_cursor: None,
            tags_by_file: Default::default(),
        })
        .unwrap();
    crate::devices::files::markers::hydrate(
        env,
        actor.id,
        &mut response.entries,
    )
    .await
    .unwrap();
    response
}

#[tokio::test]
#[serial_test::serial]
async fn folder_dates_follow_all_descendants_and_keep_first_seen_and_session_history_3930(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = sync_fixture(&env, "folder-dates").await;
    let files = env.file_registry_db().unwrap();
    let mut direct = raw_item(r"C:\z-parent\direct.log");
    direct.file_metadata_created_at = Some("2026-07-20T12:00:00+03:00".into());
    direct.file_metadata_modified_at = Some("2026-07-22T12:00:00+03:00".into());
    let mut nested = raw_item(r"C:\z-parent\nested\child.log");
    nested.file_metadata_created_at = Some("2026-07-10T12:00:00+03:00".into());
    nested.file_metadata_modified_at = Some("2026-07-30T12:00:00+03:00".into());
    let mut unknown = raw_item(r"C:\0-unknown\no-dates.log");
    unknown.file_metadata_created_at = None;
    unknown.file_metadata_modified_at = None;
    let mut root_file = raw_item(r"C:\middle.log");
    root_file.file_metadata_created_at = Some("2026-07-15T09:00:00Z".into());
    let sibling = raw_item(r"C:\a-sibling\other.log");
    let first = automatic(
        &env.dbx,
        files,
        &actor,
        device,
        vec![
            direct.clone(),
            nested.clone(),
            unknown.clone(),
            sibling,
            root_file,
        ],
    )
    .await
    .unwrap();
    let mut published = Vec::new();
    for (result, size) in
        first
            .results
            .iter()
            .zip([Some(4), Some(6), None, Some(0), Some(5)])
    {
        if let (FileSyncResult::Accepted { file_id, .. }, Some(size)) =
            (result, size)
        {
            let entry = file_entry::Entity::find_by_id(
                Uuid::parse_str(file_id).unwrap(),
            )
            .one(files.connection())
            .await
            .unwrap()
            .unwrap();
            crate::file_registry::test_support::publish_content_at(
                files.connection(),
                &entry,
                actor.id,
                size,
                Utc::now().fixed_offset(),
            )
            .await;
            published.push(entry.id);
        }
    }
    let first_seen = current_entries(&env, &actor, device).await;
    assert_eq!(
        first_seen
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["z-parent", "middle.log", "a-sibling", "0-unknown"]
    );
    let parent = &first_seen.entries[0];
    assert_eq!(parent.size_bytes, Some(10));
    assert_eq!(first_seen.entries[2].size_bytes, Some(0));
    assert_eq!(first_seen.entries[3].size_bytes, Some(0));
    assert_eq!(
        parent.file_metadata_created_at.as_deref(),
        Some("2026-07-10T09:00:00Z")
    );
    assert_eq!(
        parent.file_metadata_modified_at.as_deref(),
        Some("2026-07-30T09:00:00Z")
    );
    assert_eq!(
        parent.content_uploaded_at.as_deref(),
        Some(parent.created_at.as_str())
    );
    assert!(first_seen.entries[3].file_metadata_created_at.is_none());
    assert!(first_seen.entries[3].file_metadata_modified_at.is_none());
    let root = query::list_roots(files, device).await.unwrap().remove(0);
    assert_eq!(
        root.file_metadata_created_at
            .unwrap()
            .and_utc()
            .to_rfc3339(),
        "2026-07-10T09:00:00+00:00"
    );
    let uploaded_at = parent.content_uploaded_at.clone();
    nested.file_metadata_created_at = Some("2026-07-25T12:00:00+03:00".into());
    nested.file_metadata_modified_at = Some("2026-07-21T12:00:00+03:00".into());
    automatic(
        &env.dbx,
        files,
        &actor,
        device,
        vec![direct, nested, unknown],
    )
    .await
    .unwrap();
    for (id, size) in [(published[0], 4), (published[1], 12)] {
        let revised = file_entry::Entity::find_by_id(id)
            .one(files.connection())
            .await
            .unwrap()
            .unwrap();
        crate::file_registry::test_support::publish_content_at(
            files.connection(),
            &revised,
            actor.id,
            size,
            Utc::now().fixed_offset(),
        )
        .await;
    }
    let current = current_entries(&env, &actor, device).await;
    assert_eq!(current.entries[0].name, "middle.log");
    let parent = &current.entries[1];
    assert_eq!(parent.size_bytes, Some(16));
    assert_eq!(
        parent.file_metadata_created_at.as_deref(),
        Some("2026-07-20T09:00:00Z")
    );
    assert_eq!(
        parent.file_metadata_modified_at.as_deref(),
        Some("2026-07-22T09:00:00Z")
    );
    assert_eq!(parent.content_uploaded_at, uploaded_at);
    let historical = read::browse(&env.dbx, files, &actor, serde_json::from_value(json!({
        "device_id":device,"parent_entry_id":root.entry_id,"sync_id":first.sync.sync_id,
        "sort_by":"created_at", "limit":1
    })).unwrap()).await.unwrap();
    assert_eq!(
        historical.entries[0].file_metadata_created_at.as_deref(),
        Some("2026-07-10T09:00:00Z")
    );
    assert_eq!(
        historical.entries[0].file_metadata_modified_at.as_deref(),
        Some("2026-07-30T09:00:00Z")
    );
    assert_eq!(historical.entries[0].content_uploaded_at, uploaded_at);
    assert_eq!(historical.entries[0].size_bytes, Some(10));
    assert!(historical.next_cursor.is_some());
    let mut cursor = historical.next_cursor;
    let mut names = vec![historical.entries[0].name.clone()];
    while let Some(next) = cursor {
        let page = read::browse(&env.dbx, files, &actor, serde_json::from_value(json!({
            "device_id":device,"parent_entry_id":root.entry_id,"sync_id":first.sync.sync_id,
            "sort_by":"created_at", "limit":1, "cursor":next
        })).unwrap()).await.unwrap();
        names.extend(page.entries.into_iter().map(|entry| entry.name));
        assert!(names.len() <= 4);
        cursor = page.next_cursor;
    }
    assert_eq!(names, ["z-parent", "middle.log", "a-sibling", "0-unknown"]);
    for (sync, size) in [(None, 16), (Some(first.sync.sync_id.as_str()), 10)] {
        for direction in ["ascending", "descending"] {
            let mut cursor = None;
            let mut entries = Vec::new();
            loop {
                let page = crate::devices::files::browse_marked(&env, &actor, serde_json::from_value(json!({
                    "device_id":device,"parent_entry_id":root.entry_id,"sync_id":sync,
                    "sort_by":"size","sort_direction":direction,"limit":1,"cursor":cursor
                })).unwrap()).await.unwrap();
                entries.extend(page.entries);
                assert!(entries.len() <= 4);
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            let expected = if direction == "ascending" {
                ["0-unknown", "a-sibling", "middle.log", "z-parent"]
            } else {
                ["z-parent", "middle.log", "0-unknown", "a-sibling"]
            };
            assert_eq!(
                entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
                expected
            );
            assert_eq!(
                entries
                    .iter()
                    .find(|e| e.name == "z-parent")
                    .unwrap()
                    .size_bytes,
                Some(size)
            );
        }
    }
}
