use super::*;
use crate::devices::files::locate::{load, LocateDeviceFileReq};

#[tokio::test]
#[serial_test::serial]
async fn file_links_3757_locate_pinned_revision_and_reject_foreign_devices() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let device = device(&env, &human).await;
    let file = file(&env, device.id, "Звіт.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    let original_revision = file.revision.unwrap();
    let root_id = file.parent_id.unwrap();
    let directory_id = Uuid::now_v7();
    let now = chrono::Utc::now().naive_utc();
    let hierarchy = format!("n{}.n{}", root_id.simple(), directory_id.simple());
    file_entry::ActiveModel {
        id: Set(directory_id),
        device_id: Set(device.id),
        parent_id: Set(Some(root_id)),
        kind: Set(FileEntryKind::Directory),
        name: Set("Документи".into()),
        hierarchy_path: Set(hierarchy.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await
    .unwrap();
    let mut revision =
        file_revision::Entity::find_by_id((file.id, original_revision))
            .one(db)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    revision.revision = Set(original_revision + 1);
    revision.source_sequence = Set(100);
    revision.name = Set("Новий звіт.txt".into());
    revision.insert(db).await.unwrap();
    let mut updated = file.clone().into_active_model();
    updated.parent_id = Set(Some(directory_id));
    updated.hierarchy_path = Set(format!("{hierarchy}.n{}", file.id.simple()));
    updated.revision = Set(Some(original_revision + 1));
    updated.name = Set("Новий звіт.txt".into());
    updated.content_path = Set(None);
    updated.update(db).await.unwrap();
    let request = LocateDeviceFileReq {
        device_id: device.id.to_string(),
        file_id: file.id.to_string(),
        revision: Some(original_revision),
    };
    let located = load(&env, &request).await.unwrap();
    assert_eq!(located.root_entry_id, root_id.to_string());
    assert_eq!(located.ancestors.len(), 1);
    assert_eq!(located.ancestors[0].entry_id, directory_id.to_string());
    assert_eq!(located.file.path_components, vec!["Документи", "Звіт.txt"]);
    assert_eq!(located.file.revision, Some(original_revision));
    assert!(located.file.has_content);
    assert_eq!(located.current_revision, original_revision + 1);
    assert!(load(
        &env,
        &LocateDeviceFileReq {
            device_id: Uuid::now_v7().to_string(),
            ..request.clone()
        }
    )
    .await
    .is_err());
    assert!(load(
        &env,
        &LocateDeviceFileReq {
            revision: Some(original_revision + 100),
            ..request
        }
    )
    .await
    .is_err());
}

async fn seed_common_file_names(env: &Env, template: &file_entry::Model) {
    use sea_orm::{ConnectionTrait, TransactionTrait};
    let db = env.file_registry_db().unwrap().connection();
    let tx = db.begin().await.unwrap();
    let count = crate::config::DEVICE_DOCUMENT_SEARCH_CANDIDATE_LIMIT + 1;
    tx.execute_unprepared(&format!(
        "create temporary table file_search_seed on commit drop as
         select gen_random_uuid() as id, n, 'common-doc-'||n||'.txt' as name
         from generate_series(1,{count}) n"
    ))
    .await
    .unwrap();
    tx.execute_unprepared(&format!(
        "insert into file_entry select (jsonb_populate_record(null::file_entry,
          to_jsonb(template)||jsonb_build_object('id',seed.id,'name',seed.name,
          'absolute_path','C:'||chr(92)||seed.name,
          'hierarchy_path',subpath(template.hierarchy_path,0,1)::text||'.n'||replace(seed.id::text,'-','')))).*
         from file_entry template cross join file_search_seed seed where template.id='{}'",
        template.id
    )).await.unwrap();
    tx.execute_unprepared(&format!(
        "insert into file_revision select (jsonb_populate_record(null::file_revision,
          to_jsonb(template)||jsonb_build_object('id',seed.id,'name',seed.name,
          'absolute_path','C:'||chr(92)||seed.name,'source_sequence',seed.n+2))).*
         from file_revision template cross join file_search_seed seed where template.id='{}' and template.revision=1",
        template.id
    )).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn file_search_3757_bounded_candidates_keep_broad_query_pagination_complete(
) {
    use sea_orm::{ColumnTrait, QueryFilter, QueryOrder, QuerySelect};
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let device = device(&env, &human).await;
    let common =
        file(&env, device.id, "common-doc-0.txt", false, human.id).await;
    let rare =
        file(&env, device.id, "Унікальний-звіт.txt", false, human.id).await;
    seed_common_file_names(&env, &common).await;
    let mut request = DeviceDocumentSearchReq {
        query: Some("doc".into()),
        scope: Some("name".into()),
        limit: Some(50),
        ..Default::default()
    };
    let first = search::search(&env, &request, vec![device.id])
        .await
        .unwrap();
    assert_eq!(first.documents.len(), 50);
    assert!(first.next_cursor.is_some());
    request.cursor = first.next_cursor;
    let second = search::search(&env, &request, vec![device.id])
        .await
        .unwrap();
    let expected = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device.id))
        .filter(file_entry::Column::Name.contains("common-doc"))
        .order_by_desc(file_entry::Column::Id)
        .limit(100)
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert_eq!(
        first
            .documents
            .iter()
            .chain(&second.documents)
            .map(|file| file.file_id.clone())
            .collect::<Vec<_>>(),
        expected
            .iter()
            .map(|file| file.id.to_string())
            .collect::<Vec<_>>()
    );
    request.query = Some("УНІКАЛЬНИЙ".into());
    request.cursor = None;
    let result = search::search(&env, &request, vec![device.id])
        .await
        .unwrap();
    assert_eq!(result.documents.len(), 1);
    assert_eq!(result.documents[0].file_id, rare.id.to_string());
}
