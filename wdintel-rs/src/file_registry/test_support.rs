use super::entities::{
    file_content, file_content_upload, file_device_source_state, file_entry,
    file_revision, file_sync_session,
    sea_orm_active_enums::{
        FileContentUploadStatus, FileEntryKind, FileSyncSessionMode,
        FileSyncSessionStatus,
    },
};
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, TransactionTrait,
};
use uuid::Uuid;

pub(crate) async fn insert_entry(
    db: &DatabaseConnection,
    mut entry: file_entry::ActiveModel,
) -> file_entry::Model {
    if entry.kind.as_ref() != &FileEntryKind::File {
        entry.revision = Set(None);
        entry.sync_id = Set(None);
        entry.source_file_state = Set(None);
        entry.source_file_state_settled_at = Set(None);
        entry.source_file_state_settled_by = Set(None);
        entry.analysis_input_revision = Set(None);
        entry.current_analysis_run_id = Set(None);
        return entry.insert(db).await.unwrap();
    }

    let transaction = db.begin().await.unwrap();
    let sync_id = Uuid::now_v7();
    let device_id = *entry.device_id.as_ref();
    let now = Utc::now().fixed_offset();
    file_sync_session::ActiveModel {
        id: Set(sync_id),
        device_id: Set(device_id),
        mode: Set(FileSyncSessionMode::Automatic),
        status: Set(FileSyncSessionStatus::Completed),
        next_batch_index: Set(1),
        received_count: Set(1),
        accepted_count: Set(1),
        created_count: Set(1),
        updated_count: Set(0),
        rejected_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        completed_at: Set(Some(now)),
        expires_at: Set(None),
    }
    .insert(&transaction)
    .await
    .unwrap();

    let source_sequence =
        match file_device_source_state::Entity::find_by_id(device_id)
            .one(&transaction)
            .await
            .unwrap()
        {
            Some(state) => {
                let next = state.last_source_sequence.checked_add(1).unwrap();
                let mut state = state.into_active_model();
                state.last_source_sequence = Set(next);
                state.update(&transaction).await.unwrap();
                next
            }
            None => {
                file_device_source_state::ActiveModel {
                    id: Set(device_id),
                    last_source_sequence: Set(1),
                }
                .insert(&transaction)
                .await
                .unwrap();
                1
            }
        };
    entry.revision = Set(Some(1));
    entry.sync_id = Set(Some(sync_id));
    entry.source_file_state = Set(None);
    entry.source_file_state_settled_at = Set(None);
    entry.source_file_state_settled_by = Set(None);
    entry.analysis_input_revision = Set(Some(1));
    entry.current_analysis_run_id = Set(None);
    let file = entry.insert(&transaction).await.unwrap();
    file_revision::ActiveModel {
        id: Set(file.id),
        revision: Set(1),
        device_id: Set(file.device_id),
        sync_id: Set(sync_id),
        source_sequence: Set(source_sequence),
        analysis_input_revision: Set(1),
        name: Set(file.name.clone()),
        absolute_path: Set(file.absolute_path.clone().unwrap()),
        mime_type: Set(file.mime_type.clone()),
        extension: Set(file.extension.clone()),
        file_metadata_created_at: Set(file
            .file_metadata_created_at
            .map(|value| value.and_utc().fixed_offset())),
        file_metadata_modified_at: Set(file
            .file_metadata_modified_at
            .map(|value| value.and_utc().fixed_offset())),
        source_file_state: Set(None),
        source_file_state_settled_at: Set(None),
        source_file_state_settled_by: Set(None),
        created_at: Set(file.updated_at.and_utc().fixed_offset()),
    }
    .insert(&transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    file
}

pub(crate) async fn publish_content<C>(
    db: &C,
    file: &file_entry::Model,
    created_by_login_id: Uuid,
) -> String
where
    C: ConnectionTrait,
{
    let revision = file.revision.unwrap();
    let upload_id = Uuid::now_v7();
    let object_key = format!(
        "device-file-content/{}/{}/{revision}/{upload_id}",
        file.device_id, file.id
    );
    let source_sha256 = vec![1_u8; 32];
    let now = Utc::now().fixed_offset();
    let expires_at = now + Duration::hours(1);
    let hard_expires_at = now + Duration::days(1);

    let upload = file_content_upload::ActiveModel {
        id: Set(upload_id),
        device_id: Set(file.device_id),
        file_id: Set(file.id),
        revision: Set(revision),
        created_by_login_id: Set(created_by_login_id),
        upload_length: Set(1),
        expected_sha256: Set(source_sha256.clone()),
        object_key: Set(object_key.clone()),
        status: Set(FileContentUploadStatus::Open),
        created_at: Set(now),
        last_activity_at: Set(now),
        expires_at: Set(expires_at),
        hard_expires_at: Set(hard_expires_at),
        spool_removed_at: Set(None),
        next_cleanup_at: Set(Some(expires_at)),
    }
    .insert(db)
    .await
    .unwrap();
    let mut upload = upload.into_active_model();
    upload.status = Set(FileContentUploadStatus::Completed);
    upload.next_cleanup_at = Set(Some(now));
    upload.update(db).await.unwrap();
    file_content::ActiveModel {
        file_id: Set(file.id),
        revision: Set(revision),
        upload_id: Set(upload_id),
        object_key: Set(object_key.clone()),
        source_size_bytes: Set(1),
        source_sha256: Set(source_sha256),
        is_encrypted: Set(true),
        created_at: Set(now),
    }
    .insert(db)
    .await
    .unwrap();
    let mut file = file.clone().into_active_model();
    file.content_path = Set(Some(object_key.clone()));
    file.update(db).await.unwrap();

    object_key
}
