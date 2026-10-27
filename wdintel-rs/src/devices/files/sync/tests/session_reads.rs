use super::*;
use crate::devices::files::{
    archive::{
        access as archive_access, hydrate, test_support as archive_fixture,
    },
    sessions::{listing, read, types::*},
    types::*,
};

async fn archive_member(
    db: &DatabaseConnection,
    archive: Uuid,
    name: &str,
) -> file_entry::Model {
    let revisions = sea_orm::sea_query::Query::select()
        .column(file_revision::Column::Id)
        .from(file_revision::Entity)
        .and_where(file_revision::Column::OriginArchiveId.eq(archive))
        .and_where(file_revision::Column::Name.eq(name))
        .to_owned();
    file_entry::Entity::find()
        .filter(file_entry::Column::Id.in_subquery(revisions))
        .one(db)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn archive_history_survives_next_sync_without_changing_source_facts_3778()
{
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "archive-history").await;
    let files = env.file_registry_db().unwrap();
    let db = files.connection();
    let mut item = raw_item(r"C:\bundle.zip");
    item.extension = Some("zip".into());
    item.mime_type = Some("application/zip".into());
    let first = automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        vec![item.clone(), raw_item(r"C:\Report.txt")],
    )
    .await
    .unwrap();
    let (id, _) = accepted_result(&first.results[0]);
    let file_id = Uuid::parse_str(id).unwrap();
    let source = file_entry::Entity::find_by_id(file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    crate::file_registry::test_support::publish_content(db, &source, actor.id)
        .await;
    let old_archive = archive_fixture::publish(
        db,
        device_id,
        file_id,
        1,
        ["nested.zip", "Report.txt"],
    )
    .await;
    let nested = archive_member(db, old_archive, "nested.zip").await;
    let old_nested = archive_fixture::publish(
        db,
        device_id,
        nested.id,
        1,
        ["old.txt", "report.txt"],
    )
    .await;
    let old_member = archive_member(db, old_nested, "old.txt").await;
    let old_bytes =
        archive_access::find_published_content(db, device_id, old_member.id, 1)
            .await
            .unwrap()
            .unwrap();
    item.file_metadata_modified_at = Some("2026-07-25T10:00:00+02:00".into());
    let second = automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        vec![item, raw_item(r"C:\Report.txt")],
    )
    .await
    .unwrap();
    assert_eq!(accepted_result(&second.results[0]), (id, 2));
    let source = file_entry::Entity::find_by_id(file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    crate::file_registry::test_support::publish_content(db, &source, actor.id)
        .await;
    let new_archive = archive_fixture::publish(
        db,
        device_id,
        file_id,
        2,
        ["nested.zip", "new.txt"],
    )
    .await;
    assert_ne!(old_archive, new_archive);
    let new_nested = archive_member(db, new_archive, "nested.zip").await;
    archive_fixture::publish(
        db,
        device_id,
        new_nested.id,
        2,
        ["new-inner.txt", "Report.txt"],
    )
    .await;
    assert_eq!(nested.id, new_nested.id);
    for (sync, revision, archive) in [
        (&first.sync.sync_id, 1, old_archive),
        (&second.sync.sync_id, 2, new_archive),
    ] {
        assert_archive_session(
            &env, &actor, device_id, sync, &source, revision, archive,
        )
        .await;
    }
    let summary =
        crate::devices::analytics::query::device_summary(db, device_id)
            .await
            .unwrap();
    assert_eq!(summary.total_file_count, 2);
    assert_eq!(summary.files_with_content_count, 1);
    let retained =
        archive_access::find_published_content(db, device_id, old_member.id, 1)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(retained.object_key, old_bytes.object_key);
    assert_eq!(retained.source_sha256, old_bytes.source_sha256);
    assert!(archive_access::find_published_content(
        db,
        device_id,
        old_member.id,
        2
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        file_entry::Entity::find()
            .filter(file_entry::Column::ArchiveFileId.is_null())
            .filter(file_entry::Column::ParentId.is_null())
            .count(db)
            .await
            .unwrap(),
        1
    );
    let mut item = raw_item(r"C:\bundle.zip");
    item.extension = Some("zip".into());
    item.mime_type = Some("application/zip".into());
    item.file_metadata_modified_at = Some("2026-07-26T10:00:00+02:00".into());
    let third = automatic(&env.dbx, files, &actor, device_id, vec![item])
        .await
        .unwrap();
    let source = file_entry::Entity::find_by_id(file_id)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    crate::file_registry::test_support::publish_content(db, &source, actor.id)
        .await;
    archive_fixture::publish(
        db,
        device_id,
        file_id,
        3,
        ["plain.txt", "other.txt"],
    )
    .await;
    for (sync, revision, expected) in [
        (None, None, 404),
        (Some(&first.sync.sync_id), None, 200),
        (Some(&third.sync.sync_id), None, 404),
        (None, Some(1), 200),
        (None, Some(0), 400),
        (None, Some(99), 404),
    ] {
        let body = serde_json::from_value(json!({
            "device_id": device_id, "parent_entry_id": nested.id,
            "sync_id": sync, "archive_revision": revision
        }))
        .unwrap();
        let response = crate::devices::files::archive::tree::browse(
            &env.dbx, files, &actor, &body,
        )
        .await;
        let details = response.as_ref().err().map(|error| format!("{error:?}"));
        let status = match response {
            Ok(Some(_)) => 200,
            Ok(None) => panic!("archive browse unexpectedly fell through"),
            Err(error) => actix_web::ResponseError::error_response(&error)
                .status()
                .as_u16(),
        };
        assert_eq!(
            status, expected,
            "sync={sync:?}, revision={revision:?}: {details:?}"
        );
    }
    assert_latest_session_archive(
        &env,
        &actor,
        device_id,
        file_id,
        &second.sync.sync_id,
    )
    .await;
}

async fn assert_latest_session_archive(
    env: &Env,
    actor: &login::Model,
    device: Uuid,
    file: Uuid,
    sync: &str,
) {
    let files = env.file_registry_db().unwrap();
    let db = files.connection();
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "insert into file_revision(id,revision,device_id,sync_id,name,absolute_path,mime_type,extension,file_metadata_created_at,file_metadata_modified_at,created_at,source_sequence,analysis_input_revision,is_archive)
         select id,4,device_id,$2,name,absolute_path,mime_type,extension,file_metadata_created_at,file_metadata_modified_at,now(),(select max(source_sequence)+1 from file_revision where device_id=r.device_id),analysis_input_revision,is_archive from file_revision r where id=$1 and revision=3",
        [file.into(), Uuid::parse_str(sync).unwrap().into()])).await.unwrap();
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "update file_entry set revision=4,sync_id=$2,content_path=null where id=$1",[file.into(), Uuid::parse_str(sync).unwrap().into()])).await.unwrap();
    let source = file_entry::Entity::find_by_id(file)
        .one(db)
        .await
        .unwrap()
        .unwrap();
    crate::file_registry::test_support::publish_content(db, &source, actor.id)
        .await;
    archive_fixture::publish(db, device, file, 4, ["final.txt", "last.txt"])
        .await;
    let search = read::search(
        &env.dbx,
        files,
        actor,
        request(
            device,
            sync,
            json!({"scope_entry_id":source.parent_id.unwrap()}),
        ),
    )
    .await
    .unwrap();
    assert!(search.entries.iter().any(|entry| entry.name == "final.txt"));
    assert!(!search.entries.iter().any(|entry| matches!(
        entry.name.as_str(),
        "nested.zip" | "new-inner.txt" | "new.txt"
    )));
    let body = request(device, sync, json!({"parent_entry_id":file}));
    let browse = crate::devices::files::archive::tree::browse(
        &env.dbx, files, actor, &body,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(browse.entries.iter().all(|entry| entry.revision == Some(4)));
}

async fn assert_archive_session(
    env: &Env,
    actor: &login::Model,
    device: Uuid,
    sync: &str,
    source: &file_entry::Model,
    revision: i64,
    archive: Uuid,
) {
    let files = env.file_registry_db().unwrap();
    let mut page = read::browse(
        &env.dbx,
        files,
        actor,
        request(
            device,
            sync,
            json!({"parent_entry_id": source.parent_id.unwrap()}),
        ),
    )
    .await
    .unwrap();
    hydrate::tree(files.connection(), device, &mut page.entries)
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 2);
    let selected = page
        .entries
        .iter()
        .find(|entry| entry.file_id.as_deref() == Some(&source.id.to_string()))
        .unwrap();
    assert_eq!(selected.revision, Some(revision));
    assert_eq!(selected.archive.as_ref().unwrap().archive_id, Some(archive));
    assert_eq!(page.breadcrumbs[0].name, "C:\\");
    let summary =
        read::summary(&env.dbx, files, actor, request(device, sync, json!({})))
            .await
            .unwrap();
    assert_eq!(summary.total_file_count, 2);
    assert_eq!(summary.files_with_content_count, 1);
    assert_eq!(summary.analyzed_file_count, 0);
}

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

async fn content_tree_names(
    env: &Env,
    actor: &login::Model,
    device_id: Uuid,
    sync_id: Option<&str>,
    parent_entry_id: &str,
    has_content: Option<bool>,
) -> Vec<String> {
    let files = env.file_registry_db().unwrap();
    let mut cursor = None;
    let mut names = Vec::new();
    loop {
        let page = if let Some(sync_id) = sync_id {
            read::browse(&env.dbx, files, actor, request(device_id, sync_id, json!({
                "parent_entry_id": parent_entry_id, "has_content": has_content,
                "limit": 1, "cursor": cursor
            }))).await.unwrap()
        } else {
            let result = crate::devices::files::bl::browse(
                &env.dbx,
                files,
                actor,
                BrowseFilesCommand {
                    device_id,
                    parent_entry_id: Uuid::parse_str(parent_entry_id).unwrap(),
                    include_breadcrumbs: false,
                    limit: Some(1),
                    cursor: cursor.clone(),
                    tag_ids: vec![],
                    tag_match: None,
                    untagged: false,
                    has_content,
                },
            )
            .await
            .unwrap();
            crate::devices::files::bl::map_browse(result).unwrap()
        };
        assert!(page.entries.len() <= 1);
        names.extend(page.entries.into_iter().map(|entry| entry.name));
        let Some(next) = page.next_cursor else {
            return names;
        };
        assert_ne!(cursor.as_ref(), Some(&next));
        cursor = Some(next);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn content_filter_preserves_ancestors_pagination_and_session_revisions() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "content-filter").await;
    let files = env.file_registry_db().unwrap();
    let available =
        [r"C:\available\nested\a.log", r"C:\available\nested\b.log"];
    let first = automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        available
            .iter()
            .copied()
            .chain([r"C:\missing\c.log"])
            .map(raw_item)
            .collect(),
    )
    .await
    .unwrap();
    let entries = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .all(files.connection())
        .await
        .unwrap();
    for entry in entries
        .iter()
        .filter(|entry| entry.name == "a.log" || entry.name == "b.log")
    {
        crate::file_registry::test_support::publish_content(
            files.connection(),
            entry,
            actor.id,
        )
        .await;
    }
    let root_id = entries
        .iter()
        .find(|entry| entry.parent_id.is_none())
        .unwrap()
        .id
        .to_string();
    let nested_id = entries
        .iter()
        .find(|entry| entry.name == "nested")
        .unwrap()
        .id
        .to_string();
    for sync_id in [None, Some(first.sync.sync_id.as_str())] {
        for (parent, content, expected) in [
            (&root_id, Some(true), vec!["available"]),
            (&root_id, Some(false), vec!["missing"]),
            (&root_id, None, vec!["available", "missing"]),
            (&nested_id, Some(true), vec!["a.log", "b.log"]),
            (&nested_id, Some(false), vec![]),
        ] {
            let names = content_tree_names(
                &env, &actor, device_id, sync_id, parent, content,
            )
            .await;
            assert_eq!(names, expected);
        }
    }
    automatic(
        &env.dbx,
        files,
        &actor,
        device_id,
        available.into_iter().map(raw_item).collect(),
    )
    .await
    .unwrap();
    let current =
        content_tree_names(&env, &actor, device_id, None, &root_id, Some(true))
            .await;
    assert!(current.is_empty());
    let historical = content_tree_names(
        &env,
        &actor,
        device_id,
        Some(&first.sync.sync_id),
        &root_id,
        Some(true),
    )
    .await;
    assert_eq!(historical, vec!["available"]);
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
    let uploaded = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::AbsolutePath.eq(r"C:\reports\a.log"))
        .one(files.connection())
        .await
        .unwrap()
        .unwrap();
    crate::file_registry::test_support::publish_content(
        files.connection(),
        &uploaded,
        actor.id,
    )
    .await;
    let progress = crate::devices::analytics::query::device_summary(
        files.connection(),
        device_id,
    )
    .await
    .unwrap();
    assert_eq!(progress.total_file_count, 2);
    assert_eq!(progress.files_with_content_count, 1);
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
    let progress = crate::devices::analytics::query::device_summary(
        files.connection(),
        device_id,
    )
    .await
    .unwrap();
    assert_eq!(progress.total_file_count, 3);
    assert_eq!(progress.files_with_content_count, 0);
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
            < crate::devices::config::DEVICE_FILE_SESSION_CURSOR_MAX_BYTES
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
    assert_eq!(summary.files_with_content_count, 1);
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
    for summary in &summaries.summaries {
        let expected = u64::from(summary.sync_id == *sync_id);
        assert_eq!(summary.analysis.files_with_content_count, expected);
    }
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
    let basic = access::login_with_roles(actor, &["Basic"]);
    assert!(matches!(
        read::roots(&env.dbx, files, &basic, body()).await,
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
