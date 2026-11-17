use super::*;

#[tokio::test]
#[serial_test::serial]
async fn device_document_search_revisions_and_lease_fencing_3064() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let hidden = device(&env, &reader(&env).await).await;
    let file = file(&env, visible.id, "100%_report.txt", true, human.id).await;
    let hidden_file =
        self::file(&env, hidden.id, "100%_report.txt", true, human.id).await;
    let metadata =
        self::file(&env, visible.id, "metadata.txt", false, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    let first = queue::claim(&env, "extract").await.unwrap().unwrap();
    let second = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_ne!(first.id, second.id);
    assert!(queue::claim(&env, "extract").await.unwrap().is_none());
    let job = if first.file_id == file.id {
        first
    } else {
        second
    };
    extraction::publish(
        &env,
        &job,
        package("Циркон 9 36T XT 75734 68963 — унікальнийзміст"),
    )
    .await
    .unwrap();
    assert_eq!(
        extraction::extract(&env, &job).await.unwrap(),
        queue::JobOutcome::Complete
    );
    queue::finish(&env, &job, Ok(queue::JobOutcome::Complete))
        .await
        .unwrap();
    let mut pinned = request(&file);
    pinned.extraction_revision = Some(job.generation.to_string());
    let result = read::read(&env, &pinned).await.unwrap();
    assert_eq!(result.sections.len(), 1);
    assert!(!result.coordinates.is_empty());
    let lookup = DeviceDocumentSearchReq {
        query: Some("унікальнийзміст".into()),
        scope: Some("content".into()),
        ..Default::default()
    };
    assert_eq!(
        search::search(&env, &lookup, vec![visible.id])
            .await
            .unwrap()
            .documents[0]
            .file_id,
        file.id.to_string()
    );
    assert!(search::search(&env, &lookup, vec![hidden.id])
        .await
        .unwrap()
        .documents
        .is_empty());
    let literal = search::search(
        &env,
        &DeviceDocumentSearchReq {
            query: Some("100%_".into()),
            scope: Some("name".into()),
            ..Default::default()
        },
        vec![visible.id],
    )
    .await
    .unwrap();
    assert_eq!(literal.documents.len(), 1);
    assert_ne!(literal.documents[0].file_id, hidden_file.id.to_string());
    let first = search::search(
        &env,
        &DeviceDocumentSearchReq {
            limit: Some(1),
            ..Default::default()
        },
        vec![visible.id],
    )
    .await
    .unwrap();
    let second = search::search(
        &env,
        &DeviceDocumentSearchReq {
            limit: Some(1),
            cursor: first.next_cursor,
            ..Default::default()
        },
        vec![visible.id],
    )
    .await
    .unwrap();
    assert_eq!(second.documents.len(), 1);
    assert_ne!(first.documents[0].file_id, second.documents[0].file_id);
    assert!(second.next_cursor.is_none());
    assert!(
        !read::read(&env, &request(&metadata))
            .await
            .unwrap()
            .document
            .has_content
    );
    let mut forged = pinned.clone();
    forged.device_id = hidden.id.to_string();
    assert!(read::read(&env, &forged).await.is_err());
    let next = Uuid::now_v7();
    execute(db,"update file_document set generation=$2,state='queued' where file_id=$1",vec![file.id.into(),next.into()]).await.unwrap();
    assert!(extraction::publish(&env, &job, package("stale output"))
        .await
        .is_err());
    queue::enqueue(db, file.id, 1, next, "extract")
        .await
        .unwrap();
    let replacement = queue::claim(&env, "extract").await.unwrap().unwrap();
    extraction::publish(&env, &replacement, package("new output"))
        .await
        .unwrap();
    assert_eq!(
        read::read(&env, &pinned).await.unwrap().sections[0].text,
        result.sections[0].text
    );
    assert_eq!(
        read::read(&env, &request(&file)).await.unwrap().sections[0].text,
        "new output"
    );
    let mut revision = file_revision::Entity::find_by_id((file.id, 1))
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    revision.revision = Set(2);
    revision.source_sequence = Set(Some(100));
    revision.name = Set("changed.txt".into());
    revision.insert(db).await.unwrap();
    let mut current = file.clone().into_active_model();
    current.revision = Set(Some(2));
    current.name = Set("changed.txt".into());
    current.content_path = Set(None);
    current.update(db).await.unwrap();
    assert!(search::search(&env, &lookup, vec![visible.id])
        .await
        .unwrap()
        .documents
        .is_empty());
    let history = search::search(
        &env,
        &DeviceDocumentSearchReq {
            query: Some("new output".into()),
            history: Some(true),
            ..Default::default()
        },
        vec![visible.id],
    )
    .await
    .unwrap();
    assert_eq!(history.documents.len(), 1);
    assert!(!history.documents[0].current);
    assert_eq!(history.documents[0].revision, 1);
    assert!(read::read(&env, &pinned).await.is_ok());
}

#[tokio::test]
#[serial_test::serial]
async fn device_document_backfill_discovers_content_published_before_trigger_3064(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let file = file(&env, visible.id, "old.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    execute(
        db,
        "delete from file_document where file_id=$1",
        vec![file.id.into()],
    )
    .await
    .unwrap();
    execute(db,"update file_document_backfill set cursor_file=null,cursor_revision=null,complete=false,discovered=0",vec![]).await.unwrap();
    queue::discover(&env).await.unwrap();
    queue::discover(&env).await.unwrap();
    queue::discover(&env).await.unwrap();
    #[derive(FromQueryResult)]
    struct Count {
        count: i64,
    }
    assert_eq!(
        rows::<Count, _>(
            db,
            "select count(*) as count from file_document_job where file_id=$1",
            vec![file.id.into()]
        )
        .await
        .unwrap()[0]
            .count,
        1
    );
    let job = queue::claim(&env, "extract").await.unwrap().unwrap();
    execute(db,"update file_document_job set lease_until=now()-interval '1 second' where id=$1",vec![job.id.into()]).await.unwrap();
    let reclaimed = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_ne!(job.lease, reclaimed.lease);
    assert!(extraction::publish(&env, &job, package("stale"))
        .await
        .is_err());
    extraction::publish(&env, &reclaimed, package("current"))
        .await
        .unwrap();
    queue::finish(&env, &job, Ok(queue::JobOutcome::Complete))
        .await
        .unwrap();
    queue::renew(db, &reclaimed).await.unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn device_document_reuse_and_citations_survive_new_generations_3064() {
    use crate::file_registry::entities::file_content;
    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let file = file(&env, visible.id, "shared.txt", true, human.id).await;
    let db = env.file_registry_db().unwrap().connection();
    let job = queue::claim(&env, "extract").await.unwrap().unwrap();
    extraction::publish(&env, &job, package("Original evidence"))
        .await
        .unwrap();
    queue::finish(&env, &job, Ok(queue::JobOutcome::Complete))
        .await
        .unwrap();
    execute(db,"update file_document_generation set summary_state='completed',position_state='completed' where id=$1",vec![job.generation.into()]).await.unwrap();
    let mut revision = file_revision::Entity::find_by_id((file.id, 1))
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    revision.revision = Set(2);
    revision.source_sequence = Set(Some(100));
    revision.insert(db).await.unwrap();
    let mut content = file_content::Entity::find_by_id((file.id, 1))
        .one(db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    content.revision = Set(2);
    content.insert(db).await.unwrap();
    let reused = queue::claim(&env, "extract").await.unwrap().unwrap();
    assert_eq!(
        extraction::extract(&env, &reused).await.unwrap(),
        queue::JobOutcome::Complete
    );
    queue::finish(&env, &reused, Ok(queue::JobOutcome::Complete))
        .await
        .unwrap();
    let pinned = DeviceDocumentReadReq {
        revision: 2,
        extraction_revision: Some(job.generation.to_string()),
        ..request(&file)
    };
    assert_eq!(
        read::read(&env, &pinned).await.unwrap().sections[0].text,
        "Original evidence"
    );
    let source = AiAgentFileCitation {
        device_id: visible.id.to_string(),
        file_id: file.id.to_string(),
        revision: 2,
        extraction_revision: Some(job.generation.to_string()),
        section: Some(0),
    };
    assert!(crate::ai_agent::file_citations::readable(
        &env,
        human.id,
        std::slice::from_ref(&source)
    )
    .await
    .unwrap());
    let mut forged = source.clone();
    forged.section = Some(9);
    assert!(!crate::ai_agent::file_citations::readable(
        &env,
        human.id,
        &[forged]
    )
    .await
    .unwrap());
    let next = Uuid::now_v7();
    execute(db,"update file_document set generation=$2 where file_id=$1 and revision=2",vec![file.id.into(),next.into()]).await.unwrap();
    queue::enqueue(db, file.id, 2, next, "extract")
        .await
        .unwrap();
    let retry = queue::claim(&env, "extract").await.unwrap().unwrap();
    extraction::publish(&env, &retry, package("New extraction"))
        .await
        .unwrap();
    assert_eq!(
        read::read(&env, &pinned).await.unwrap().sections[0].text,
        "Original evidence"
    );
    let mut revoked = human.clone().into_active_model();
    revoked.roles = Set(json!(["Rer"]));
    revoked.update(&env.dbx).await.unwrap();
    assert!(!crate::ai_agent::file_citations::readable(
        &env,
        human.id,
        &[source]
    )
    .await
    .unwrap());
}
