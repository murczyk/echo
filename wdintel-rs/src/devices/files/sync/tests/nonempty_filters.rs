use super::*;
use crate::devices::files::{listing_filters, markers, query, types::*};

fn filter_item(path: &str) -> RawSyncDeviceFileItem {
    let mut item = raw_item(path);
    item.extension = Some(path.rsplit('.').next().unwrap().to_owned());
    item.mime_type = Some(
        if path.ends_with(".png") {
            "image/png"
        } else {
            "text/plain"
        }
        .to_owned(),
    );
    item
}

async fn filtered_children(
    env: &Env,
    actor: &login::Model,
    device: Uuid,
    parent: Uuid,
    sync: Option<&str>,
    filters: serde_json::Value,
) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = None;
    loop {
        let response = crate::devices::files::browse_marked(
            env,
            actor,
            serde_json::from_value(json!({
                "device_id":device,"parent_entry_id":parent,
                "sync_id":sync,"filters":filters,"limit":1,"cursor":cursor
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        names.extend(response.entries.into_iter().map(|entry| entry.name));
        cursor = response.next_cursor;
        if cursor.is_none() {
            return names;
        }
        assert!(names.len() < 10);
    }
}

async fn filtered_search_names(
    env: &Env,
    actor: &login::Model,
    mut request: serde_json::Value,
) -> Vec<String> {
    let mut names = Vec::new();
    request["limit"] = json!(1);
    loop {
        let response = crate::devices::files::search_marked(
            env,
            actor,
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .unwrap();
        names.extend(response.entries.into_iter().map(|entry| entry.name));
        let Some(cursor) = response.next_cursor else {
            return names;
        };
        request["cursor"] = json!(cursor);
        assert!(names.len() < 10, "search repeated entries");
    }
}

#[tokio::test]
#[serial_test::serial]
async fn empty_filtered_folders_are_hidden_recursively_even_if_favorite_3930() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = sync_fixture(&env, "nonempty-filters").await;
    let files = env.file_registry_db().unwrap();
    let result = automatic(
        &env.dbx,
        files,
        &actor,
        device,
        vec![
            filter_item(r"C:\matches\deep\image.png"),
            filter_item(r"C:\removed\nested\note.txt"),
            filter_item(r"C:\empty-after-content\missing.png"),
        ],
    )
    .await
    .unwrap();
    let entries = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device))
        .all(files.connection())
        .await
        .unwrap();
    for entry in entries.iter().filter(|entry| {
        entry.kind == DomainFileEntryKind::File && entry.name != "missing.png"
    }) {
        crate::file_registry::test_support::publish_content_at(
            files.connection(),
            entry,
            actor.id,
            5,
            Utc::now().fixed_offset(),
        )
        .await;
    }
    let root = query::list_roots(files, device).await.unwrap().remove(0);
    let image = entries
        .iter()
        .find(|entry| entry.name == "image.png")
        .unwrap();
    let removed = entries
        .iter()
        .find(|entry| entry.name == "removed")
        .unwrap();
    for id in [image.id, removed.id] {
        markers::set_favorite(
            &env,
            &actor,
            &markers::SetDeviceFileFavoriteReq {
                device_id: device,
                entry_id: id,
                favorite: true,
            },
        )
        .await
        .unwrap();
    }
    for sync in [None, Some(result.sync.sync_id.as_str())] {
        assert_eq!(
            filtered_children(
                &env,
                &actor,
                device,
                root.entry_id,
                sync,
                json!({"has_content":true,"favorites_only":true})
            )
            .await,
            ["matches"]
        );
        assert_eq!(
            filtered_children(
                &env,
                &actor,
                device,
                root.entry_id,
                sync,
                json!({"has_content":true,"file_types":["folder"]})
            )
            .await,
            ["matches", "removed"]
        );
        assert_eq!(filtered_children(&env, &actor, device, root.entry_id, sync,
            json!({"has_content":true,"file_types":["folder"],"favorites_only":true})).await, ["matches"]);
        assert_eq!(
            filtered_children(
                &env,
                &actor,
                device,
                root.entry_id,
                sync,
                json!({"has_content":true,"extensions":["png"]})
            )
            .await,
            ["matches"]
        );
    }
    for sync in [None, Some(result.sync.sync_id.as_str())] {
        for global in [false, true] {
            for (name, filters, expected) in [
                (
                    Some("matches"),
                    json!({"has_content":true}),
                    vec!["matches"],
                ),
                (
                    Some("removed"),
                    json!({"has_content":true}),
                    vec!["removed"],
                ),
                (
                    Some("empty-after-content"),
                    json!({"has_content":true}),
                    vec![],
                ),
                (
                    Some("removed"),
                    json!({"has_content":true,"favorites_only":true}),
                    vec![],
                ),
                (
                    None,
                    json!({"has_content":true,"favorites_only":true}),
                    vec!["matches", "deep"],
                ),
                (
                    None,
                    json!({"has_content":true,"file_types":["folder"]}),
                    vec!["matches", "removed", "deep", "nested"],
                ),
            ] {
                let request = json!({"device_id":device,"scope_entry_id":root.entry_id,"sync_id":sync,"filters":filters,"name_query":name,"kinds":["directory"],"global_search":global,"rank_by_relevance":true});
                assert_eq!(
                    filtered_search_names(&env, &actor, request).await,
                    expected,
                    "name={name:?}, global={global}, sync={sync:?}"
                );
            }
        }
    }
    markers::set_favorite(
        &env,
        &actor,
        &markers::SetDeviceFileFavoriteReq {
            device_id: device,
            entry_id: image.id,
            favorite: false,
        },
    )
    .await
    .unwrap();
    let filters = serde_json::from_value(
        json!({"has_content":true,"favorites_only":true}),
    )
    .unwrap();
    for sync in [None, Some(Uuid::parse_str(&result.sync.sync_id).unwrap())] {
        let matched = listing_filters::matching_ids(
            &env,
            actor.id,
            listing_filters::ListingFilterScope {
                device,
                sync,
                archive: None,
            },
            vec![root.entry_id, removed.id],
            &filters,
            true,
        )
        .await
        .unwrap();
        assert!(matched.is_empty());
    }
}

#[tokio::test]
#[serial_test::serial]
async fn shared_browse_cursors_keep_pagination_and_reject_changed_scope_3930() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = sync_fixture(&env, "shared-browse-cursors").await;
    let files = env.file_registry_db().unwrap();
    let synced = automatic(
        &env.dbx,
        files,
        &actor,
        device,
        vec![
            filter_item(r"C:\documents\a.txt"),
            filter_item(r"C:\documents\b.txt"),
            filter_item(r"C:\documents\c.txt"),
            filter_item(r"C:\bundle.zip"),
        ],
    )
    .await
    .unwrap();
    let entries = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device))
        .all(files.connection())
        .await
        .unwrap();
    let directory = entries
        .iter()
        .find(|entry| entry.name == "documents")
        .unwrap();
    let archive = entries
        .iter()
        .find(|entry| entry.name == "bundle.zip")
        .unwrap();
    crate::file_registry::test_support::publish_content(
        files.connection(),
        archive,
        actor.id,
    )
    .await;
    crate::devices::files::archive::test_support::publish(
        files.connection(),
        device,
        archive.id,
        1,
        ["a.txt", "b.txt"],
    )
    .await;
    for (parent, sync, revision) in [
        (directory.id, None, None),
        (directory.id, Some(synced.sync.sync_id.as_str()), None),
        (archive.id, None, Some(1)),
        (archive.id, Some(synced.sync.sync_id.as_str()), Some(1)),
    ] {
        for explicit in [true, false] {
            let request = json!({"device_id":device,"parent_entry_id":parent,"sync_id":sync,"archive_revision":revision,"include_breadcrumbs":explicit,"sort_by":if explicit {Some("name")} else {None},"sort_direction":if explicit {Some("ascending")} else {None},"limit":1});
            assert_shared_browse_cursor_3930(&env, &actor, request).await;
        }
    }
}

async fn assert_shared_browse_cursor_3930(
    env: &Env,
    actor: &login::Model,
    mut request: serde_json::Value,
) {
    let first = crate::devices::files::browse_marked(
        env,
        actor,
        serde_json::from_value(request.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(first.entries[0].name, "a.txt");
    request["cursor"] = json!(first.next_cursor.expect("second page"));
    let explicit = !request["include_breadcrumbs"].as_bool().unwrap();
    request["include_breadcrumbs"] = json!(explicit);
    request["sort_by"] = json!(if explicit { Some("name") } else { None });
    request["sort_direction"] =
        json!(if explicit { Some("ascending") } else { None });
    let second = crate::devices::files::browse_marked(
        env,
        actor,
        serde_json::from_value(request.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(second.entries[0].name, "b.txt");
    assert_eq!(!second.breadcrumbs.is_empty(), explicit);
    for (field, value) in [
        ("sort_by", json!("size")),
        ("sort_direction", json!("descending")),
        ("filters", json!({"extensions":["log"]})),
    ] {
        if field == "filters"
            && request["sync_id"].is_null()
            && request["archive_revision"].is_null()
        {
            continue;
        }
        let mut incompatible = request.clone();
        incompatible[field] = value;
        assert!(
            crate::devices::files::browse_marked(
                env,
                actor,
                serde_json::from_value(incompatible).unwrap()
            )
            .await
            .is_err(),
            "accepted changed {field}: {request}"
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn docx_zip_mime_filters_keep_documents_and_ancestors_3930() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device) = sync_fixture(&env, "docx-zip-filter").await;
    let files = env.file_registry_db().unwrap();
    let mut items = Vec::new();
    for (index, mime) in ["application/zip", "application/x-zip", "application/x-zip-compressed; charset=binary", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].into_iter().enumerate() {
        let mut item = filter_item(&format!(r"C:\documents\case{index}.DOCX"));
        item.mime_type = Some(mime.to_owned());
        items.push(item);
    }
    let mut archive = filter_item(r"C:\archives\bundle.zip");
    archive.mime_type = Some("application/zip".to_owned());
    items.push(archive);
    let synced = automatic(&env.dbx, files, &actor, device, items)
        .await
        .unwrap();
    let entries = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device))
        .all(files.connection())
        .await
        .unwrap();
    for entry in entries
        .iter()
        .filter(|entry| entry.kind == DomainFileEntryKind::File)
    {
        crate::file_registry::test_support::publish_content(
            files.connection(),
            entry,
            actor.id,
        )
        .await;
    }
    let root = query::list_roots(files, device).await.unwrap().remove(0);
    let documents = entries
        .iter()
        .find(|entry| entry.name == "documents")
        .unwrap();
    for sync in [None, Some(synced.sync.sync_id.as_str())] {
        let filters = json!({"file_types":["document"],"has_content":true});
        assert_eq!(
            filtered_children(
                &env,
                &actor,
                device,
                root.entry_id,
                sync,
                filters.clone()
            )
            .await,
            ["documents"]
        );
        let names = filtered_children(
            &env,
            &actor,
            device,
            documents.id,
            sync,
            filters.clone(),
        )
        .await;
        assert_eq!(
            names,
            ["case0.DOCX", "case1.DOCX", "case2.DOCX", "case3.DOCX"]
        );
        let request = json!({"device_id":device,"scope_entry_id":root.entry_id,"sync_id":sync,"name_query":"case","filters":filters,"limit":1});
        assert_eq!(filtered_search_names(&env, &actor, request).await, names);
        assert_eq!(
            filtered_children(
                &env,
                &actor,
                device,
                root.entry_id,
                sync,
                json!({"file_types":["archive"],"has_content":true})
            )
            .await,
            ["archives"]
        );
    }
}
