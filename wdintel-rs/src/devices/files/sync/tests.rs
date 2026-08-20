use super::super::types::{
    FileSyncErrorCode, FileSyncOperation, FileSyncResult,
    FileSyncSessionItemResult, FileSyncSessionStatus, RawSourceFileState,
    RawSyncDeviceFileItem, RawSyncDeviceFilesReq, SourceFileStateKind,
};
use super::{automatic, complete, items, start_explicit, status};
use crate::config::ROLE_ADMIN;
use crate::devices::{access, ROLE_DEVICE_SOURCE};
use crate::entities::{device, login, organism};
use crate::error::AppError;
use crate::file_registry::entities::{
    file_analysis_run, file_device_source_state, file_entry, file_revision,
    file_sync_batch, file_sync_item, file_sync_session,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, EntityTrait, IntoActiveModel, PaginatorTrait,
    QueryFilter,
};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

async fn insert_owner(db: &DatabaseConnection, prefix: &str) -> login::Model {
    let organism = mk_organism(
        db,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    mk_login(
        db,
        login::ActiveModel {
            login: Set(format!("{prefix}-{}", Uuid::now_v7())),
            organism_id: Set(Some(organism.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn insert_device(db: &DatabaseConnection, owner: &login::Model) -> Uuid {
    let id = Uuid::now_v7();
    let now = Utc::now().naive_utc();
    device::ActiveModel {
        id: Set(id),
        name: Set(Some("File sync fixture device".to_string())),
        created_by: Set(owner.login.clone()),
        organism_id: Set(owner.organism_id.unwrap()),
        unit_id: Set(None),
        tags: Set(json!([])),
        external_url: Set(None),
        archived: Set(false),
        archived_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        custom_fields: Set(json!({})),
    }
    .insert(db)
    .await
    .unwrap();
    id
}

async fn sync_fixture(env: &Arc<Env>, prefix: &str) -> (login::Model, Uuid) {
    let owner = insert_owner(&env.dbx, prefix).await;
    let device_id = insert_device(&env.dbx, &owner).await;
    (
        access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]),
        device_id,
    )
}

fn raw_item(absolute_path: &str) -> RawSyncDeviceFileItem {
    RawSyncDeviceFileItem {
        absolute_path: absolute_path.to_string(),
        mime_type: Some(" text/plain ".to_string()),
        extension: Some(" LOG ".to_string()),
        file_metadata_created_at: Some("2026-07-24T09:00:00+02:00".to_string()),
        file_metadata_modified_at: Some(
            "2026-07-24T10:00:00+02:00".to_string(),
        ),
        source_file_state: None,
    }
}

fn assert_conflict_code(error: AppError, expected: &str) {
    match error {
        AppError::ConflictJson { body } => {
            assert_eq!(body["code"], expected);
            assert!(body["message"].is_string());
        }
        error => panic!("expected conflict {expected}, got {error:?}"),
    }
}

fn accepted_result(result: &FileSyncResult) -> (&str, i64) {
    match result {
        FileSyncResult::Accepted {
            file_id, revision, ..
        } => (file_id, *revision),
        result => panic!("expected accepted result, got {result:?}"),
    }
}

#[test]
fn request_item_rejects_client_supplied_file_identity() {
    let error = serde_json::from_value::<RawSyncDeviceFilesReq>(json!({
        "device_id": "018f0000-0000-7000-8000-000000000001",
        "files": [{
            "file_id": "018f0000-0000-7000-8000-000000000002",
            "absolute_path": "C:\\reports\\report.log",
            "mime_type": null,
            "extension": null,
            "file_metadata_created_at": null,
            "file_metadata_modified_at": null,
            "source_file_state": null
        }]
    }))
    .unwrap_err();

    assert!(error.to_string().contains("unknown field `file_id`"));
}

#[tokio::test]
#[serial_test::serial]
async fn source_file_state_accepts_missing_settlement_actor() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "optional-settled-by").await;
    let file_registry = env.file_registry_db().unwrap();
    let file_db = file_registry.connection();
    let mut item = raw_item("C:\\reports\\without-actor.log");
    item.source_file_state = Some(RawSourceFileState {
        state: Some("scanned".to_string()),
        settled_at: Some("2026-07-24T10:15:30Z".to_string()),
        settled_by: None,
    });

    let response =
        automatic(&env.dbx, file_registry, &actor, device_id, vec![item])
            .await
            .unwrap();
    assert_eq!(response.sync.status, FileSyncSessionStatus::Completed);
    let (file_id, revision) = accepted_result(&response.results[0]);
    assert_eq!(revision, 1);
    let file_id = Uuid::parse_str(file_id).unwrap();
    let source_file_state = match &response.results[0] {
        FileSyncResult::Accepted { file, .. } => {
            file.source_file_state.as_ref().unwrap()
        }
        result => panic!("expected accepted result, got {result:?}"),
    };
    assert_eq!(source_file_state.state, SourceFileStateKind::Scanned);
    assert_eq!(source_file_state.settled_by, None);

    let current = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    let revision = file_revision::Entity::find_by_id((file_id, 1))
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.source_file_state_settled_by, None);
    assert_eq!(revision.source_file_state_settled_by, None);
}

#[tokio::test]
#[serial_test::serial]
async fn automatic_sync_persists_revisions_and_full_replacement_projection() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "automatic-sync").await;
    let file_registry = env.file_registry_db().unwrap();
    let file_db = file_registry.connection();

    let mut first = raw_item(" C:\\reports\\report.log ");
    first.source_file_state = Some(RawSourceFileState {
        state: Some("downloaded".to_string()),
        settled_at: Some("2026-07-24T10:15:30+02:00".to_string()),
        settled_by: Some(" still-client ".to_string()),
    });
    let response = automatic(
        &env.dbx,
        file_registry,
        &actor,
        device_id,
        vec![first.clone(), raw_item("relative.log"), first],
    )
    .await
    .unwrap();
    let first_sync_id = Uuid::parse_str(&response.sync.sync_id).unwrap();
    let first_analysis_run_id =
        Uuid::parse_str(response.sync.analysis_run_id.as_deref().unwrap())
            .unwrap();

    assert_eq!(
        response.sync.status,
        FileSyncSessionStatus::CompletedWithErrors
    );
    assert_eq!(response.sync.counts.received, 3);
    assert_eq!(response.sync.counts.accepted, 1);
    assert_eq!(response.sync.counts.created, 1);
    assert_eq!(response.sync.counts.updated, 0);
    assert_eq!(response.sync.counts.rejected, 2);
    assert_eq!(response.results.len(), 3);
    let serialized_result = serde_json::to_value(&response.results[0]).unwrap();
    assert_eq!(serialized_result["index"], 0);
    assert!(serialized_result.get("batch_index").is_none());
    assert!(serialized_result.get("item_index").is_none());

    let (file_id, first_revision) = accepted_result(&response.results[0]);
    assert_eq!(first_revision, 1);
    assert_eq!(file_id.as_bytes()[14], b'7');
    let file_id = Uuid::parse_str(file_id).unwrap();
    let first_updated_at = match &response.results[0] {
        FileSyncResult::Accepted {
            operation,
            revision,
            file,
            ..
        } => {
            assert_eq!(*operation, FileSyncOperation::Created);
            assert_eq!(*revision, 1);
            assert_eq!(file.absolute_path, "C:\\reports\\report.log");
            assert_eq!(file.mime_type.as_deref(), Some("text/plain"));
            assert_eq!(file.extension.as_deref(), Some("LOG"));
            let source = file.source_file_state.as_ref().unwrap();
            assert_eq!(source.state, SourceFileStateKind::Downloaded);
            assert_eq!(source.settled_at, "2026-07-24T08:15:30Z");
            assert_eq!(source.settled_by.as_deref(), Some("still-client"));
            file.updated_at.clone()
        }
        _ => unreachable!(),
    };
    match &response.results[1] {
        FileSyncResult::Rejected {
            code, field_errors, ..
        } => {
            assert_eq!(*code, FileSyncErrorCode::Validation);
            assert!(field_errors
                .iter()
                .any(|error| error.path == "files[1].absolute_path"));
        }
        result => panic!("expected validation result, got {result:?}"),
    }
    match &response.results[2] {
        FileSyncResult::Rejected { code, .. } => {
            assert_eq!(*code, FileSyncErrorCode::DuplicatePathInSession);
        }
        result => panic!("expected duplicate result, got {result:?}"),
    }

    let current = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    let revision = file_revision::Entity::find_by_id((file_id, 1))
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.revision, Some(revision.revision));
    assert_eq!(current.sync_id, Some(revision.sync_id));
    assert_eq!(
        current.absolute_path.as_ref(),
        Some(&revision.absolute_path)
    );
    assert_eq!(current.mime_type, revision.mime_type);
    assert_eq!(current.extension, revision.extension);
    assert_eq!(current.source_file_state, revision.source_file_state);
    assert_eq!(
        current.source_file_state_settled_at,
        revision.source_file_state_settled_at
    );
    assert_eq!(
        current.source_file_state_settled_by,
        revision.source_file_state_settled_by
    );
    assert_eq!(current.analysis_input_revision, Some(1));
    assert_eq!(current.current_analysis_run_id, None);
    assert_eq!(revision.source_sequence, 1);
    assert_eq!(revision.analysis_input_revision, 1);
    let first_analysis_run =
        file_analysis_run::Entity::find_by_id(first_analysis_run_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(first_analysis_run.sync_id, Some(first_sync_id));
    assert_eq!(first_analysis_run.device_id, device_id);
    assert_eq!(first_analysis_run.target_source_sequence, None);
    assert_eq!(first_analysis_run.item_count, 0);

    let mut forbidden_revision_update = revision.clone().into_active_model();
    forbidden_revision_update.mime_type =
        Set(Some("application/json".to_string()));
    assert!(forbidden_revision_update.update(file_db).await.is_err());

    let response = automatic(
        &env.dbx,
        file_registry,
        &actor,
        device_id,
        vec![raw_item("C:\\reports\\report.log")],
    )
    .await
    .unwrap();
    assert_eq!(response.sync.analysis_run_id, None);
    let (updated_file_id, revision) = accepted_result(&response.results[0]);
    assert_eq!(Uuid::parse_str(updated_file_id).unwrap(), file_id);
    assert_eq!(revision, 2);
    match &response.results[0] {
        FileSyncResult::Accepted {
            operation, file, ..
        } => {
            assert_eq!(*operation, FileSyncOperation::Updated);
            assert!(file.source_file_state.is_none());
            assert_ne!(file.updated_at, first_updated_at);
        }
        _ => unreachable!(),
    }

    let metadata_only_revision =
        file_revision::Entity::find_by_id((file_id, 2))
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(metadata_only_revision.source_sequence, 2);
    assert_eq!(metadata_only_revision.analysis_input_revision, 1);

    let mut changed = raw_item("C:\\reports\\report.log");
    changed.extension = Some(" TXT ".to_string());
    let response = automatic(
        &env.dbx,
        file_registry,
        &actor,
        device_id,
        vec![changed, raw_item("C:\\archive\\report.log")],
    )
    .await
    .unwrap();
    let changed_analysis_run_id =
        Uuid::parse_str(response.sync.analysis_run_id.as_deref().unwrap())
            .unwrap();
    let (updated_file_id, revision) = accepted_result(&response.results[0]);
    assert_eq!(Uuid::parse_str(updated_file_id).unwrap(), file_id);
    assert_eq!(revision, 3);
    match &response.results[0] {
        FileSyncResult::Accepted {
            operation, file, ..
        } => {
            assert_eq!(*operation, FileSyncOperation::Updated);
            assert_eq!(file.extension.as_deref(), Some("TXT"));
        }
        _ => unreachable!(),
    }
    let (new_file_id, revision) = accepted_result(&response.results[1]);
    let new_file_id = Uuid::parse_str(new_file_id).unwrap();
    assert_ne!(new_file_id, file_id);
    assert_eq!(revision, 1);
    let updated_revision = file_revision::Entity::find_by_id((file_id, 3))
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated_revision.source_sequence, 3);
    assert_eq!(updated_revision.analysis_input_revision, 3);
    let new_revision = file_revision::Entity::find_by_id((new_file_id, 1))
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(new_revision.source_sequence, 4);
    assert_eq!(new_revision.analysis_input_revision, 1);
    let changed_analysis_run =
        file_analysis_run::Entity::find_by_id(changed_analysis_run_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        changed_analysis_run.sync_id,
        Some(Uuid::parse_str(&response.sync.sync_id).unwrap())
    );
    let source_state = file_device_source_state::Entity::find_by_id(device_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source_state.last_source_sequence, 4);

    assert_eq!(
        file_entry::Entity::find()
            .filter(file_entry::Column::DeviceId.eq(device_id))
            .filter(
                file_entry::Column::Kind
                    .eq(super::super::DomainFileEntryKind::File)
            )
            .count(file_db)
            .await
            .unwrap(),
        2
    );

    let historical = items(
        &env.dbx,
        file_registry,
        &actor,
        first_sync_id,
        None,
        Some(10),
        None,
    )
    .await
    .unwrap();
    match &historical.results[0] {
        FileSyncSessionItemResult::SessionItemAccepted {
            file_id: historical_file_id,
            revision,
            file,
            ..
        } => {
            assert_eq!(Uuid::parse_str(historical_file_id).unwrap(), file_id);
            assert_eq!(*revision, 1);
            assert_eq!(file.absolute_path, "C:\\reports\\report.log");
            assert_eq!(file.extension.as_deref(), Some("LOG"));
            let source = file.source_file_state.as_ref().unwrap();
            assert_eq!(source.state, SourceFileStateKind::Downloaded);
            assert_eq!(source.settled_by.as_deref(), Some("still-client"));
        }
        result => panic!("expected historical accepted result, got {result:?}"),
    }
}

#[tokio::test]
#[serial_test::serial]
async fn explicit_sync_recovers_persisted_batches_and_completes_idempotently() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "explicit-sync").await;
    let file_registry = env.file_registry_db().unwrap();
    let file_db = file_registry.connection();

    let started = start_explicit(&env.dbx, file_registry, &actor, device_id)
        .await
        .unwrap();
    assert!(started.created);
    let sync_id = Uuid::parse_str(&started.response.sync.sync_id).unwrap();
    let recovered = start_explicit(&env.dbx, file_registry, &actor, device_id)
        .await
        .unwrap();
    assert!(!recovered.created);
    assert_eq!(
        recovered.response.sync.sync_id,
        started.response.sync.sync_id
    );

    assert_conflict_code(
        automatic(
            &env.dbx,
            file_registry,
            &actor,
            device_id,
            vec![raw_item("C:\\blocked.log")],
        )
        .await
        .unwrap_err(),
        "active_session",
    );

    let mut invalid_state = raw_item("C:\\reports\\invalid-state.log");
    invalid_state.source_file_state = Some(RawSourceFileState {
        state: Some("scanned".to_string()),
        settled_at: Some("2026-07-24T10:15:30Z".to_string()),
        settled_by: Some("   ".to_string()),
    });
    let batch_zero = super::apply_batch(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        0,
        vec![raw_item("C:\\reports\\first.log"), invalid_state],
    )
    .await
    .unwrap();
    assert_eq!(batch_zero.sync.next_batch_index, 1);
    assert_eq!(batch_zero.batch.counts.received, 2);
    assert_eq!(batch_zero.batch.counts.accepted, 1);
    assert_eq!(batch_zero.batch.counts.rejected, 1);
    let (first_file_id, _) = accepted_result(&batch_zero.results[0]);
    let first_file_id = Uuid::parse_str(first_file_id).unwrap();

    let replay = super::apply_batch(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        0,
        vec![raw_item("C:\\different-body.log")],
    )
    .await
    .unwrap();
    assert_eq!(replay.results, batch_zero.results);
    assert!(file_entry::Entity::find()
        .filter(file_entry::Column::AbsolutePath.eq("C:\\different-body.log"))
        .one(file_db)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        file_revision::Entity::find()
            .filter(file_revision::Column::Id.eq(first_file_id))
            .count(file_db)
            .await
            .unwrap(),
        1
    );

    let oversized_replay = super::apply_batch(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        0,
        (0..=crate::config::DEVICE_FILE_SYNC_BATCH_MAX_COUNT)
            .map(|index| raw_item(&format!("C:\\ignored\\{index}.log")))
            .collect(),
    )
    .await
    .unwrap();
    assert_eq!(oversized_replay.results, batch_zero.results);

    assert_conflict_code(
        super::apply_batch(
            &env.dbx,
            file_registry,
            &actor,
            sync_id,
            2,
            vec![raw_item("C:\\future.log")],
        )
        .await
        .unwrap_err(),
        "wrong_next_batch",
    );

    let batch_one = super::apply_batch(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        1,
        vec![raw_item("C:\\reports\\first.log")],
    )
    .await
    .unwrap();
    match &batch_one.results[0] {
        FileSyncResult::Rejected { code, .. } => {
            assert_eq!(*code, FileSyncErrorCode::DuplicatePathInSession);
        }
        result => panic!("expected cross-batch duplicate, got {result:?}"),
    }
    assert_eq!(batch_one.sync.next_batch_index, 2);

    assert_conflict_code(
        complete(&env.dbx, file_registry, &actor, sync_id, 1)
            .await
            .unwrap_err(),
        "complete_mismatch",
    );
    let completed = complete(&env.dbx, file_registry, &actor, sync_id, 2)
        .await
        .unwrap();
    assert_eq!(
        completed.sync.status,
        FileSyncSessionStatus::CompletedWithErrors
    );
    assert_eq!(completed.sync.counts.received, 3);
    assert_eq!(completed.sync.counts.accepted, 1);
    assert_eq!(completed.sync.counts.rejected, 2);
    let repeated = complete(&env.dbx, file_registry, &actor, sync_id, 2)
        .await
        .unwrap();
    assert_eq!(repeated, completed);
    assert_conflict_code(
        complete(&env.dbx, file_registry, &actor, sync_id, 3)
            .await
            .unwrap_err(),
        "complete_mismatch",
    );

    let page_one = items(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        None,
        Some(1),
        None,
    )
    .await
    .unwrap();
    assert_eq!(page_one.results.len(), 1);
    match &page_one.results[0] {
        FileSyncSessionItemResult::SessionItemAccepted {
            batch_index,
            item_index,
            ..
        } => {
            assert_eq!((*batch_index, *item_index), (0, 0));
        }
        result => panic!("expected accepted recovery result, got {result:?}"),
    }
    let page_two = items(
        &env.dbx,
        file_registry,
        &actor,
        sync_id,
        None,
        Some(2),
        page_one.next_cursor.as_deref(),
    )
    .await
    .unwrap();
    assert_eq!(page_two.results.len(), 2);
    assert!(page_two.next_cursor.is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn explicit_sync_preserves_duplicate_detection_at_batch_limit() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) =
        sync_fixture(&env, "full-batch-explicit-sync").await;
    let file_registry = env.file_registry_db().unwrap();
    let started = start_explicit(&env.dbx, file_registry, &actor, device_id)
        .await
        .unwrap();
    let sync_id = Uuid::parse_str(&started.response.sync.sync_id).unwrap();
    let unique_count = crate::config::DEVICE_FILE_SYNC_BATCH_MAX_COUNT - 1;
    let mut files = (0..unique_count)
        .map(|index| {
            raw_item(&format!(
                "C:\\full-batch\\branch-{index}\\nested\\{index}.log"
            ))
        })
        .collect::<Vec<_>>();
    files.push(raw_item("C:\\full-batch\\branch-0\\nested\\0.log"));

    let applied =
        super::apply_batch(&env.dbx, file_registry, &actor, sync_id, 0, files)
            .await
            .unwrap();

    assert_eq!(
        applied.batch.counts.received,
        crate::config::DEVICE_FILE_SYNC_BATCH_MAX_COUNT as u64
    );
    assert_eq!(applied.batch.counts.accepted, unique_count as u64);
    assert_eq!(applied.batch.counts.rejected, 1);
    match applied.results.last().unwrap() {
        FileSyncResult::Rejected { code, .. } => {
            assert_eq!(*code, FileSyncErrorCode::DuplicatePathInSession);
        }
        result => panic!("expected full-batch duplicate, got {result:?}"),
    }

    let completed = complete(&env.dbx, file_registry, &actor, sync_id, 1)
        .await
        .unwrap();
    assert_eq!(
        completed.sync.status,
        FileSyncSessionStatus::CompletedWithErrors
    );
}

#[tokio::test]
#[serial_test::serial]
async fn expiry_is_terminal_idempotent_and_allows_a_new_session() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let (actor, device_id) = sync_fixture(&env, "expiry-sync").await;
    let file_registry = env.file_registry_db().unwrap();

    let started = start_explicit(&env.dbx, file_registry, &actor, device_id)
        .await
        .unwrap();
    let created_at =
        chrono::DateTime::parse_from_rfc3339(&started.response.sync.created_at)
            .unwrap();
    let expires_at = chrono::DateTime::parse_from_rfc3339(
        started.response.sync.expires_at.as_deref().unwrap(),
    )
    .unwrap();
    assert_eq!(expires_at - created_at, Duration::hours(3));
    let sync_id = Uuid::parse_str(&started.response.sync.sync_id).unwrap();
    let mut session = file_sync_session::Entity::find_by_id(sync_id)
        .one(file_registry.connection())
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    session.expires_at =
        Set(Some((Utc::now() - Duration::seconds(1)).fixed_offset()));
    session.update(file_registry.connection()).await.unwrap();

    assert!(super::worker::run_tick(env.as_ref()).await.unwrap());
    let expired = status(&env.dbx, file_registry, &actor, sync_id)
        .await
        .unwrap();
    assert_eq!(expired.sync.status, FileSyncSessionStatus::Expired);
    assert_conflict_code(
        super::apply_batch(
            &env.dbx,
            file_registry,
            &actor,
            sync_id,
            0,
            vec![raw_item("C:\\expired.log")],
        )
        .await
        .unwrap_err(),
        "terminal_session",
    );
    assert!(!super::worker::run_tick(env.as_ref()).await.unwrap());

    let replacement =
        start_explicit(&env.dbx, file_registry, &actor, device_id)
            .await
            .unwrap();
    assert!(replacement.created);
    assert_ne!(
        replacement.response.sync.sync_id,
        started.response.sync.sync_id
    );
}

#[tokio::test]
#[serial_test::serial]
async fn authorization_precedes_file_mutation_and_infrastructure_failure_rolls_back(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let owner = insert_owner(&env.dbx, "authorization-sync").await;
    let device_id = insert_device(&env.dbx, &owner).await;
    let file_registry = env.file_registry_db().unwrap();
    let file_db = file_registry.connection();

    let unauthorized = access::login_with_roles(&owner, &[]);
    assert!(matches!(
        automatic(
            &env.dbx,
            file_registry,
            &unauthorized,
            device_id,
            vec![raw_item("C:\\unauthorized.log")],
        )
        .await
        .unwrap_err(),
        AppError::Forbidden(_)
    ));
    assert_eq!(
        file_sync_session::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        0
    );

    let foreign_owner = insert_owner(&env.dbx, "foreign-sync").await;
    let foreign = access::login_with_roles(&foreign_owner, &[ROLE_ADMIN]);
    assert!(matches!(
        automatic(
            &env.dbx,
            file_registry,
            &foreign,
            device_id,
            vec![raw_item("C:\\foreign.log")],
        )
        .await
        .unwrap_err(),
        AppError::NotFound
    ));
    assert_eq!(
        file_sync_session::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        0
    );

    file_db
        .execute_unprepared(
            r#"
            create function public.test_fail_file_revision_insert()
            returns trigger
            language plpgsql
            as $function$
            begin
                raise exception 'injected file revision failure' using errcode = 'XX000';
            end
            $function$;
            create trigger test_fail_file_revision_insert_trg
                before insert on public.file_revision
                for each row execute function public.test_fail_file_revision_insert();
            "#,
        )
        .await
        .unwrap();

    let actor = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    assert!(matches!(
        automatic(
            &env.dbx,
            file_registry,
            &actor,
            device_id,
            vec![raw_item("C:\\rollback\\failure.log")],
        )
        .await
        .unwrap_err(),
        AppError::AnyhowError { .. }
    ));

    file_db
        .execute_unprepared(
            r#"
            drop trigger test_fail_file_revision_insert_trg
                on public.file_revision;
            drop function public.test_fail_file_revision_insert();
            "#,
        )
        .await
        .unwrap();

    assert_eq!(
        file_sync_session::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        file_sync_batch::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        file_sync_item::Entity::find().count(file_db).await.unwrap(),
        0
    );
    assert_eq!(
        file_revision::Entity::find().count(file_db).await.unwrap(),
        0
    );
    assert_eq!(file_entry::Entity::find().count(file_db).await.unwrap(), 0);
}
